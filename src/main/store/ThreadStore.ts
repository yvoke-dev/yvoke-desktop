import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  assertValidThreadId,
  EMPTY_USAGE,
  isValidThreadId,
  type ChatMessage,
  type ImageAttachment,
  type SyncState,
  type ThreadMeta,
  type UsageTotals,
} from '../../shared/types';

/** Blob file extension per attachment media type; the name is otherwise opaque. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * On-disk form of an attachment. One screenshot's base64 dwarfs a whole conversation's prose, so
 * the payload goes to a sibling blob file and the JSONL line keeps only the reference — otherwise
 * every thread open and every search-index sweep would re-parse megabytes of base64 to reach the
 * few kilobytes of text around it. Reading a log restores `data` and hides `file` again, so the
 * split is invisible to callers; `data` still parses on logs written before this existed.
 */
export interface StoredImage extends Omit<ImageAttachment, 'data'> {
  data?: string;
  /** Blob file name inside the thread's image directory. */
  file?: string;
}

export interface StoredChatMessage extends Omit<ChatMessage, 'images'> {
  images?: StoredImage[];
}

/**
 * Local cache + SDK session map — the server is the system of record (Req. 7).
 * Index in index.json; one JSONL message log per thread. Usage totals accumulate
 * per turn and are recomputable from synced per-message usage.
 */
export class ThreadStore {
  private readonly indexFile: string;
  private readonly deletedFile: string;
  private index: Record<string, ThreadMeta>;
  private readonly deletedIds: Set<string>;
  private readonly remoteToLocalId = new Map<string, string>();
  private readonly lifecycleEpoch = new Map<string, number>();
  /** Per-thread promise chain serializing message-log mutations (see runExclusive). */
  private readonly opChain = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {
    this.indexFile = path.join(dir, 'index.json');
    this.deletedFile = path.join(dir, 'deleted.json');
    this.deletedIds = this.loadDeleted();
    this.index = this.loadIndex();
    for (const tombId of Array.from(this.deletedIds)) {
      const epoch = this.lifecycleEpoch.get(tombId) ?? 0;
      void this.scheduleTombstoneCleanup(tombId, epoch);
    }
  }

  private bumpEpoch(threadId: string): number {
    const next = (this.lifecycleEpoch.get(threadId) ?? 0) + 1;
    this.lifecycleEpoch.set(threadId, next);
    return next;
  }

  private isStaleOrDeleted(threadId: string, expectedEpoch: number): boolean {
    return this.deletedIds.has(threadId) || (this.lifecycleEpoch.get(threadId) ?? 0) !== expectedEpoch;
  }

  private async cleanupAbortedWriteIfReupserted(threadId: string): Promise<void> {
    if (!this.deletedIds.has(threadId)) {
      await fsp.rm(this.messagesFile(threadId), { force: true }).catch(() => undefined);
      await fsp.rm(this.imageDir(threadId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private loadDeleted(): Set<string> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.deletedFile, 'utf8');
    } catch {
      return new Set<string>();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      preserveCorrupt(this.deletedFile);
      return new Set<string>();
    }
    if (!Array.isArray(parsed)) {
      preserveCorrupt(this.deletedFile);
      return new Set<string>();
    }

    const valid = new Set<string>();
    let hadInvalid = false;
    for (const item of parsed) {
      if (isValidThreadId(item)) {
        valid.add(item);
      } else {
        hadInvalid = true;
      }
    }

    if (hadInvalid) {
      if (valid.size === 0) {
        preserveCorrupt(this.deletedFile);
        return valid;
      }
      preserveCorruptCopy(this.deletedFile);
      this.persistDeletedSet(valid);
      return valid;
    }

    if (valid.size === 0) {
      try {
        fs.rmSync(this.deletedFile, { force: true });
      } catch {
        // Ignore best-effort unlink of empty deleted.json.
      }
    }
    return valid;
  }

  private persistDeletedSet(ids: ReadonlySet<string>): void {
    if (ids.size === 0) {
      try {
        fs.rmSync(this.deletedFile, { force: true });
      } catch {
        // Best-effort unlink when no tombstones remain.
      }
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWriteFileSync(this.deletedFile, JSON.stringify(Array.from(ids), null, 2));
  }

  private persistDeletedSync(): void {
    this.persistDeletedSet(this.deletedIds);
  }

  private loadIndex(): Record<string, ThreadMeta> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch {
      // Missing file (first run) — start empty without touching disk.
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The file exists but is corrupt: preserve it as a backup rather than
      // silently returning {} (which persistIndex would then overwrite).
      preserveCorrupt(this.indexFile);
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      preserveCorrupt(this.indexFile);
      return {};
    }

    const valid: Record<string, ThreadMeta> = {};
    let hadInvalid = false;
    let skippedDeleted = false;
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        isValidThreadId(key) &&
        typeof val === 'object' &&
        val !== null &&
        !Array.isArray(val) &&
        (val as { id?: unknown }).id === key
      ) {
        if (this.deletedIds.has(key)) {
          skippedDeleted = true;
          continue;
        }
        const entry: ThreadMeta = { ...(val as ThreadMeta) };
        if ('remoteConversationId' in entry) {
          if (entry.remoteConversationId === undefined) {
            delete entry.remoteConversationId;
          } else if (!isValidThreadId(entry.remoteConversationId)) {
            delete entry.remoteConversationId;
            hadInvalid = true;
          } else if (entry.remoteConversationId === key) {
            delete entry.remoteConversationId;
          }
        }
        valid[key] = entry;
      } else {
        hadInvalid = true;
      }
    }

    // Deterministically resolve any duplicate effective remoteConversationId collisions:
    // prefer native `id === remoteId` over recreated `remoteConversationId`, else newer `updatedAt`.
    let resolvedCollision = true;
    while (resolvedCollision) {
      resolvedCollision = false;
      const byRemote = new Map<string, ThreadMeta>();
      for (const entry of Object.values(valid)) {
        const remote = entry.remoteConversationId ?? entry.id;
        const prev = byRemote.get(remote);
        if (!prev) {
          byRemote.set(remote, entry);
          continue;
        }
        hadInvalid = true;
        resolvedCollision = true;
        const entryWins =
          prev.id === remote
            ? false
            : entry.id === remote
              ? true
              : (entry.updatedAt ?? '').localeCompare(prev.updatedAt ?? '') > 0 ||
                ((entry.updatedAt ?? '') === (prev.updatedAt ?? '') && entry.id < prev.id);
        if (entryWins) {
          delete prev.remoteConversationId;
          byRemote.set(remote, entry);
        } else {
          delete entry.remoteConversationId;
        }
      }
    }

    if (hadInvalid) {
      if (Object.keys(valid).length === 0) {
        preserveCorrupt(this.indexFile);
        return {};
      }
      preserveCorruptCopy(this.indexFile);
    }

    if (skippedDeleted) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        atomicWriteFileSync(this.indexFile, JSON.stringify(valid, null, 2));
      } catch {
        // Best-effort cleanup of stale index entries superseded by deleted.json tombstones.
      }
    }

    this.remoteToLocalId.clear();
    for (const entry of Object.values(valid)) {
      this.remoteToLocalId.set(entry.remoteConversationId ?? entry.id, entry.id);
    }
    return valid;
  }

  private syncRemoteMapping(
    localId: string,
    prevMeta: ThreadMeta | undefined,
    nextMeta: ThreadMeta | undefined,
  ): void {
    if (prevMeta) {
      const prevRemote = prevMeta.remoteConversationId ?? prevMeta.id;
      if (this.remoteToLocalId.get(prevRemote) === localId) {
        this.remoteToLocalId.delete(prevRemote);
      }
    }
    if (nextMeta) {
      const nextRemote = nextMeta.remoteConversationId ?? nextMeta.id;
      const existingOwnerId = this.remoteToLocalId.get(nextRemote);
      if (existingOwnerId && existingOwnerId !== localId) {
        const existingOwner = this.index[existingOwnerId];
        if (existingOwner && existingOwner.remoteConversationId === nextRemote) {
          delete existingOwner.remoteConversationId;
          if (!this.remoteToLocalId.has(existingOwner.id)) {
            this.remoteToLocalId.set(existingOwner.id, existingOwner.id);
          }
        } else if (existingOwner && existingOwner.id === nextRemote) {
          // Native `id === nextRemote` always wins over a recreated `remoteConversationId` claim
          // (matching `loadIndex()` collision resolution).
          delete nextMeta.remoteConversationId;
          if (!this.remoteToLocalId.has(localId)) {
            this.remoteToLocalId.set(localId, localId);
          }
          return;
        }
      }
      this.remoteToLocalId.set(nextRemote, localId);
    }
  }

  private persistIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWriteFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  private validateThreadId(threadId: unknown): asserts threadId is string {
    assertValidThreadId(threadId);
  }

  private messagesFile(threadId: string): string {
    this.validateThreadId(threadId);
    return path.join(this.dir, `${threadId}.jsonl`);
  }

  isDeleted(threadId: string): boolean {
    return this.deletedIds.has(threadId);
  }

  findByRemoteId(remoteId: string): ThreadMeta | undefined {
    if (!isValidThreadId(remoteId)) return undefined;
    const localId = this.remoteToLocalId.get(remoteId);
    return localId ? this.index[localId] : undefined;
  }

  list(): ThreadMeta[] {
    return Object.values(this.index).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  get(threadId: string): ThreadMeta | undefined {
    this.validateThreadId(threadId);
    return this.index[threadId];
  }

  private cleanMeta(meta: ThreadMeta): ThreadMeta {
    const cleaned = { ...meta };
    if (cleaned.sessionId === undefined) delete cleaned.sessionId;
    if (cleaned.sessionProfile === undefined) delete cleaned.sessionProfile;
    if (!cleaned.orchestratorProfile) delete cleaned.orchestratorProfile;
    if (!cleaned.initialPlaybook || cleaned.orchestratorProfile) delete cleaned.initialPlaybook;
    if (cleaned.hasStarted === undefined) delete cleaned.hasStarted;
    if (cleaned.remoteSettings === undefined) delete cleaned.remoteSettings;
    if (cleaned.remoteConversationId === undefined || cleaned.remoteConversationId === cleaned.id) {
      delete cleaned.remoteConversationId;
    } else {
      assertValidThreadId(cleaned.remoteConversationId);
    }
    return cleaned;
  }

  upsert(meta: ThreadMeta): void {
    this.validateThreadId(meta.id);
    const wasDeleted = this.deletedIds.delete(meta.id);
    if (wasDeleted) {
      this.bumpEpoch(meta.id);
    }
    const prev = this.index[meta.id];
    const cleaned = this.cleanMeta(meta);
    this.index[meta.id] = cleaned;
    this.syncRemoteMapping(meta.id, prev, cleaned);
    this.persistIndex();
    if (wasDeleted) {
      this.persistDeletedSync();
    }
  }

  patch(threadId: string, update: Partial<ThreadMeta>): ThreadMeta | undefined {
    this.validateThreadId(threadId);
    const existing = this.index[threadId];
    if (!existing) {
      return undefined;
    }
    const updated = { ...existing, ...update, id: threadId };
    if ('sessionId' in update && update.sessionId === undefined) {
      delete updated.sessionId;
    }
    if ('sessionProfile' in update && update.sessionProfile === undefined) {
      delete updated.sessionProfile;
    }
    if ('orchestratorProfile' in update && !update.orchestratorProfile) {
      delete updated.orchestratorProfile;
    }
    if ('initialPlaybook' in update && !update.initialPlaybook) {
      delete updated.initialPlaybook;
    }
    if (updated.orchestratorProfile) {
      delete updated.initialPlaybook;
    }
    if ('hasStarted' in update && update.hasStarted === undefined) {
      delete updated.hasStarted;
    }
    if ('remoteSettings' in update && update.remoteSettings === undefined) {
      delete updated.remoteSettings;
    }
    if ('remoteConversationId' in update) {
      if (update.remoteConversationId === undefined || update.remoteConversationId === threadId) {
        delete updated.remoteConversationId;
      } else {
        assertValidThreadId(update.remoteConversationId);
      }
    }
    this.index[threadId] = updated;
    this.syncRemoteMapping(threadId, existing, updated);
    this.persistIndex();
    return this.index[threadId];
  }

  setSessionId(threadId: string, sessionId: string, profile?: string): void {
    this.patch(threadId, {
      sessionId: sessionId || undefined,
      sessionProfile: profile || undefined,
    });
  }

  setSyncState(threadId: string, syncState: SyncState): void {
    this.patch(threadId, { syncState });
  }

  delete(threadId: string): Promise<void> {
    this.validateThreadId(threadId);
    const epoch = this.bumpEpoch(threadId);
    const prev = this.index[threadId];
    delete this.index[threadId];
    this.syncRemoteMapping(threadId, prev, undefined);
    this.persistIndex();

    const msgFile = this.messagesFile(threadId);
    const imgDir = this.imageDir(threadId);
    if (!fs.existsSync(msgFile) && !fs.existsSync(imgDir) && !this.opChain.has(threadId)) {
      if (this.deletedIds.delete(threadId)) {
        this.persistDeletedSync();
      }
      return Promise.resolve();
    }

    this.deletedIds.add(threadId);
    this.persistDeletedSync();
    return this.scheduleTombstoneCleanup(threadId, epoch);
  }

  private scheduleTombstoneCleanup(threadId: string, expectedEpoch: number): Promise<void> {
    const isStillTargetTombstone = (): boolean =>
      this.deletedIds.has(threadId) && (this.lifecycleEpoch.get(threadId) ?? 0) === expectedEpoch;

    // Run through the per-thread chain AFTER any already-running op, swallowing fsp.rm and disk
    // errors internally so un-awaited delete() callers never emit unhandled rejections while
    // retaining the tombstone in deleted.json whenever removal could not complete.
    return this.runExclusive(threadId, async () => {
      if (!isStillTargetTombstone()) {
        return;
      }
      const msgFile = this.messagesFile(threadId);
      const imgDir = this.imageDir(threadId);
      try {
        await fsp.rm(msgFile, { force: true });
      } catch (err) {
        console.warn(
          `ThreadStore: failed to remove log for ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isStillTargetTombstone()) {
        return;
      }
      try {
        await fsp.rm(imgDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `ThreadStore: failed to remove images for ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!isStillTargetTombstone()) {
        return;
      }
      if (!fs.existsSync(msgFile) && !fs.existsSync(imgDir)) {
        this.deletedIds.delete(threadId);
        try {
          this.persistDeletedSync();
        } catch (err) {
          console.warn(
            `ThreadStore: failed to update tombstones for ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });
  }

  /**
   * Flushes queued background operations across all threads, or for a specific thread if threadId is provided.
   */
  async drain(threadId?: string): Promise<void> {
    if (threadId !== undefined) {
      this.validateThreadId(threadId);
      await (this.opChain.get(threadId) ?? Promise.resolve());
      return;
    }
    while (this.opChain.size > 0) {
      await Promise.all(Array.from(this.opChain.values()));
    }
  }

  // Per-thread message logs can grow with the conversation, so their I/O is async to avoid
  // blocking the Electron main (event-loop) thread. The small index.json stays sync.
  //
  // Every log mutation for a thread runs through a per-thread promise chain (runExclusive) so a
  // read-modify-write (applyServerIds / setFeedback) cannot interleave with an append/replace.
  // Without this, the await points added by the async conversion would let a concurrent write
  // land between an RMW's read and its overwrite — clobbering the file and dropping a turn.
  // (applyServerIds is driven by sync-ack timing, which is NOT gated by the agent's per-thread
  // turn serialization, so this interleaving is genuinely reachable.)
  private runExclusive<T>(threadId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.opChain.get(threadId) ?? Promise.resolve();
    const result = prev.then(op, op);
    // Store a normalized, never-rejecting tail so the chain survives an op's failure,
    // and prune settled entries so opChain does not hold stale promises indefinitely.
    const tail: Promise<undefined> = result
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.opChain.get(threadId) === tail) {
          this.opChain.delete(threadId);
        }
      });
    this.opChain.set(threadId, tail);
    return result;
  }

  private async readRaw(threadId: string): Promise<StoredChatMessage[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.messagesFile(threadId), 'utf8');
    } catch {
      return [];
    }
    // Parse line-by-line so a single malformed (or truncated trailing) line
    // never discards the whole thread — return every line that parses.
    const messages: StoredChatMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isValidStoredMessage(parsed)) {
          messages.push(parsed);
        } else {
          console.warn(`ThreadStore: skipping malformed message line in thread ${threadId}`);
        }
      } catch {
        console.warn(`ThreadStore: skipping unparseable message line in thread ${threadId}`);
      }
    }
    return messages;
  }

  private async writeRaw(threadId: string, messages: StoredChatMessage[]): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const contents = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
    await atomicWriteFile(this.messagesFile(threadId), contents);
  }

  private imageDir(threadId: string): string {
    this.validateThreadId(threadId);
    return path.join(this.dir, 'images', threadId);
  }

  /** Moves each attachment's base64 out to a blob file, leaving only a reference on the message. */
  private async dehydrateImages(threadId: string, messages: ChatMessage[]): Promise<StoredChatMessage[]> {
    const out: StoredChatMessage[] = [];
    for (const message of messages) {
      if (!message.images || message.images.length === 0) {
        out.push(message);
        continue;
      }
      const dir = this.imageDir(threadId);
      await fsp.mkdir(dir, { recursive: true });
      const images: StoredImage[] = [];
      for (const image of message.images) {
        const { data, ...rest } = image;
        const file = `${randomUUID()}.${IMAGE_EXTENSIONS[image.mediaType] ?? 'bin'}`;
        try {
          await fsp.writeFile(path.join(dir, file), Buffer.from(data, 'base64'));
          images.push({ ...rest, file });
        } catch (err) {
          // A blob that will not write must not cost us the attachment: keep the payload inline
          // rather than logging a reference to a file that is not there.
          console.warn(`ThreadStore: keeping image ${image.id} inline: ${err instanceof Error ? err.message : String(err)}`);
          images.push(image);
        }
      }
      out.push({ ...message, images });
    }
    return out;
  }

  /** Reads referenced blobs back onto their attachments, restoring the in-memory shape. */
  private async hydrateImages(threadId: string, messages: StoredChatMessage[]): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];
    for (const message of messages) {
      if (!message.images || message.images.length === 0) {
        out.push(message as ChatMessage);
        continue;
      }
      const images: ImageAttachment[] = [];
      for (const image of message.images) {
        const { file, data, ...rest } = image;
        // Logs written before the blob split (or by the inline fallback above) carry `data`.
        if (typeof data === 'string' && data.length > 0) {
          images.push({ ...rest, data });
          continue;
        }
        if (!file) continue;
        try {
          const buf = await fsp.readFile(path.join(this.imageDir(threadId), file));
          images.push({ ...rest, data: buf.toString('base64') });
        } catch (err) {
          // The turn's prose is worth more than the attachment — drop the one image whose blob
          // is gone rather than failing the whole log read.
          console.warn(`ThreadStore: dropping unreadable image ${image.id} in ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      out.push({ ...message, images: images.length > 0 ? images : undefined });
    }
    return out;
  }

  /** Deletes blobs no surviving message references — a server rehydrate replaces the whole log. */
  private async collectImageGarbage(threadId: string, messages: StoredChatMessage[]): Promise<void> {
    const dir = this.imageDir(threadId);
    let existing: string[];
    try {
      existing = await fsp.readdir(dir);
    } catch {
      return;
    }
    const referenced = new Set<string>();
    for (const message of messages) {
      for (const image of message.images ?? []) {
        if (image.file) referenced.add(image.file);
      }
    }
    await Promise.all(
      existing.filter((file) => !referenced.has(file)).map((file) => fsp.rm(path.join(dir, file), { force: true })),
    );
  }

  /**
   * Synchronously inspects `<threadId>.jsonl` files via `readdirSync` + `statSync` without
   * reading file contents or running `JSON.parse`, skipping tombstoned IDs.
   */
  inspectLogsSync(): { nonEmptyIds: Set<string>; allLogIds: string[] } {
    const nonEmptyIds = new Set<string>();
    const allLogIds: string[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return { nonEmptyIds, allLogIds };
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const threadId = file.slice(0, -'.jsonl'.length);
      if (!isValidThreadId(threadId) || this.deletedIds.has(threadId)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(this.dir, file));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      allLogIds.push(threadId);
      if (stat.size > 0) {
        nonEmptyIds.add(threadId);
      }
    }
    return { nonEmptyIds, allLogIds };
  }

  async listLogThreadIds(): Promise<string[]> {
    let files: string[];
    try {
      files = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const threadId = file.slice(0, -'.jsonl'.length);
      if (isValidThreadId(threadId) && !this.deletedIds.has(threadId)) {
        ids.push(threadId);
      }
    }
    return ids;
  }

  /** Reads stored JSONL messages under per-thread lock without hydrating base64 image blobs. */
  async readRawMessages(threadId: string): Promise<StoredChatMessage[]> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return [];
      const raw = await this.readRaw(threadId);
      if (this.isStaleOrDeleted(threadId, epoch)) return [];
      return raw;
    });
  }

  async readMessages(threadId: string): Promise<ChatMessage[]> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return [];
      const raw = await this.readRaw(threadId);
      if (this.isStaleOrDeleted(threadId, epoch)) return [];
      const hydrated = await this.hydrateImages(threadId, raw);
      if (this.isStaleOrDeleted(threadId, epoch)) return [];
      return hydrated;
    });
  }

  async appendMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return;
      await fsp.mkdir(this.dir, { recursive: true });
      if (this.isStaleOrDeleted(threadId, epoch)) return;
      const stored = await this.dehydrateImages(threadId, messages);
      if (this.isStaleOrDeleted(threadId, epoch)) {
        await this.cleanupAbortedWriteIfReupserted(threadId);
        return;
      }
      const lines = stored.map((m) => JSON.stringify(m)).join('\n') + '\n';
      await fsp.appendFile(this.messagesFile(threadId), lines);
      if (this.isStaleOrDeleted(threadId, epoch)) {
        await this.cleanupAbortedWriteIfReupserted(threadId);
        return;
      }

      const assistantUsage = messages.find((m) => m.role === 'assistant')?.usage;
      const meta = this.index[threadId];
      if (meta && !this.isStaleOrDeleted(threadId, epoch)) {
        const totals: UsageTotals = assistantUsage
          ? {
              inputTokens: meta.totals.inputTokens + assistantUsage.inputTokens,
              outputTokens: meta.totals.outputTokens + assistantUsage.outputTokens,
              cacheReadTokens: meta.totals.cacheReadTokens + assistantUsage.cacheReadTokens,
              cacheWriteTokens: meta.totals.cacheWriteTokens + assistantUsage.cacheWriteTokens,
            }
          : meta.totals;
        this.patch(threadId, { totals, updatedAt: new Date().toISOString() });
      }
    });
  }

  /** Replaces the whole log (rehydration from the server). */
  async replaceMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return;
      const stored = await this.dehydrateImages(threadId, messages);
      if (this.isStaleOrDeleted(threadId, epoch)) {
        await this.cleanupAbortedWriteIfReupserted(threadId);
        return;
      }
      await this.writeRaw(threadId, stored);
      if (this.isStaleOrDeleted(threadId, epoch)) {
        await this.cleanupAbortedWriteIfReupserted(threadId);
        return;
      }
      await this.collectImageGarbage(threadId, stored);
    });
  }

  /** Writes server ids back onto locally-logged messages after a sync ack (atomic read-modify-write). */
  async applyServerIds(threadId: string, mapping: Record<string, string>): Promise<{ hasUnsynced: boolean }> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return { hasUnsynced: false };
      const messages = await this.readRaw(threadId);
      if (this.isStaleOrDeleted(threadId, epoch)) return { hasUnsynced: false };
      let changed = false;
      for (const message of messages) {
        const serverId = Object.hasOwn(mapping, message.localId) ? mapping[message.localId] : undefined;
        if (serverId && message.serverId !== serverId) {
          message.serverId = serverId;
          changed = true;
        }
      }
      if (changed) {
        await this.writeRaw(threadId, messages);
        if (this.isStaleOrDeleted(threadId, epoch)) {
          await this.cleanupAbortedWriteIfReupserted(threadId);
          return { hasUnsynced: false };
        }
      }
      return { hasUnsynced: messages.some((m) => !m.serverId) };
    });
  }

  /**
   * Prepares a local conversation in place for 404 server recreation without moving `.jsonl` or
   * image directories: strips stale `serverId`s, merges deduplicated `extraMessages`, and updates
   * `ThreadMeta` (`remoteConversationId`, `remoteSettings`, `syncState`, `title`) atomically.
   */
  async prepareForRecreation(
    threadId: string,
    fallbackMeta: ThreadMeta,
    metaPatch: Partial<Omit<ThreadMeta, 'id'>>,
    extraMessages: StoredChatMessage[] = [],
  ): Promise<ThreadMeta> {
    this.validateThreadId(threadId);
    if (
      'remoteConversationId' in metaPatch &&
      metaPatch.remoteConversationId !== undefined &&
      metaPatch.remoteConversationId !== threadId
    ) {
      assertValidThreadId(metaPatch.remoteConversationId);
    }

    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) {
        return this.cleanMeta({ ...fallbackMeta, ...metaPatch, id: threadId });
      }

      const rawExisting = await this.readRaw(threadId);
      if (this.isStaleOrDeleted(threadId, epoch)) {
        return this.cleanMeta({ ...fallbackMeta, ...metaPatch, id: threadId });
      }

      const seenLocalIds = new Set(rawExisting.map((m) => m.localId));
      const merged: StoredChatMessage[] = [...rawExisting];
      for (const extra of extraMessages) {
        if (isValidStoredMessage(extra) && !seenLocalIds.has(extra.localId)) {
          seenLocalIds.add(extra.localId);
          merged.push(extra);
        }
      }

      const cleanedMessages: StoredChatMessage[] = merged.map((msg) => {
        const copy: StoredChatMessage = {
          ...msg,
          ...(msg.images ? { images: msg.images.map((img) => ({ ...img })) } : {}),
          ...(msg.feedback ? { feedback: { ...msg.feedback } } : {}),
        };
        delete copy.serverId;
        return copy;
      });

      if (cleanedMessages.length > 0 || fs.existsSync(this.messagesFile(threadId))) {
        await this.writeRaw(threadId, cleanedMessages);
        if (this.isStaleOrDeleted(threadId, epoch)) {
          await this.cleanupAbortedWriteIfReupserted(threadId);
          return this.cleanMeta({ ...fallbackMeta, ...metaPatch, id: threadId });
        }
      }

      if (this.isStaleOrDeleted(threadId, epoch)) {
        return this.cleanMeta({ ...fallbackMeta, ...metaPatch, id: threadId });
      }

      const prevMeta = this.index[threadId];
      const base = prevMeta ?? fallbackMeta;
      const mergedMeta = this.cleanMeta({
        ...base,
        ...metaPatch,
        id: threadId,
      });
      this.index[threadId] = mergedMeta;
      this.syncRemoteMapping(threadId, prevMeta, mergedMeta);
      this.persistIndex();
      return this.index[threadId];
    });
  }

  /**
   * Migrates a cached conversation from `oldId` to `newMeta.id` atomically when recreating a
   * missing server conversation. Writes `<newId>.jsonl` before swapping `index.json` or removing
   * `<oldId>.jsonl` so a failure mid-migration never loses local transcript data.
   */
  async migrateThread(
    oldId: string,
    newMeta: ThreadMeta,
    extraMessages?: StoredChatMessage[],
  ): Promise<void> {
    this.validateThreadId(oldId);
    this.validateThreadId(newMeta?.id);
    if (oldId === newMeta.id) {
      throw new Error(`Cannot migrate thread to the same threadId: ${oldId}`);
    }

    const [firstId, secondId] = oldId < newMeta.id ? [oldId, newMeta.id] : [newMeta.id, oldId];
    return this.runExclusive(firstId, () =>
      this.runExclusive(secondId, async () => {
        const rawOld = await this.readRaw(oldId);
        const seenLocalIds = new Set(rawOld.map((m) => m.localId));
        const merged: StoredChatMessage[] = [...rawOld];
        for (const extra of extraMessages ?? []) {
          if (isValidStoredMessage(extra) && !seenLocalIds.has(extra.localId)) {
            seenLocalIds.add(extra.localId);
            merged.push(extra);
          }
        }

        const cleanedMessages: StoredChatMessage[] = merged.map((msg) => {
          const copy: StoredChatMessage = {
            ...msg,
            ...(msg.images ? { images: msg.images.map((img) => ({ ...img })) } : {}),
            ...(msg.feedback ? { feedback: { ...msg.feedback } } : {}),
          };
          delete copy.serverId;
          return copy;
        });

        // 1. Write <newId>.jsonl atomically BEFORE moving images, swapping index, or deleting <oldId>.jsonl
        if (cleanedMessages.length > 0) {
          await this.writeRaw(newMeta.id, cleanedMessages);
        }

        // 2. Move threads/images/<oldId> -> threads/images/<newId> (with EXDEV cross-device fallback)
        await this.moveImageDir(oldId, newMeta.id);

        // 3. Swap index.json entry atomically
        this.bumpEpoch(oldId);
        const wasNewDeleted = this.deletedIds.delete(newMeta.id);
        if (wasNewDeleted) {
          this.bumpEpoch(newMeta.id);
        }
        const prevOld = this.index[oldId];
        const prevNew = this.index[newMeta.id];
        delete this.index[oldId];
        this.syncRemoteMapping(oldId, prevOld, undefined);
        const cleanedNew = this.cleanMeta(newMeta);
        this.index[newMeta.id] = cleanedNew;
        this.syncRemoteMapping(newMeta.id, prevNew, cleanedNew);
        this.persistIndex();
        if (wasNewDeleted) {
          this.persistDeletedSync();
        }

        // 4. Delete <oldId>.jsonl only after <newId>.jsonl and index.json are safely committed
        await fsp.rm(this.messagesFile(oldId), { force: true });
      }),
    );
  }

  private async moveImageDir(oldId: string, newId: string): Promise<void> {
    const oldImageDir = this.imageDir(oldId);
    try {
      const stat = await fsp.stat(oldImageDir);
      if (!stat.isDirectory()) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }

    const newImageDir = this.imageDir(newId);
    await fsp.mkdir(path.dirname(newImageDir), { recursive: true });
    await fsp.rm(newImageDir, { recursive: true, force: true });
    try {
      await fsp.rename(oldImageDir, newImageDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EXDEV') {
        await fsp.cp(oldImageDir, newImageDir, { recursive: true });
        await fsp.rm(oldImageDir, { recursive: true, force: true });
        return;
      }
      if (code === 'ENOENT') return;
      throw err;
    }
  }

  async setFeedback(threadId: string, messageLocalId: string, rating: 1 | -1, comment?: string): Promise<void> {
    this.validateThreadId(threadId);
    const epoch = this.lifecycleEpoch.get(threadId) ?? 0;
    return this.runExclusive(threadId, async () => {
      if (this.isStaleOrDeleted(threadId, epoch)) return;
      const messages = await this.readRaw(threadId);
      if (this.isStaleOrDeleted(threadId, epoch)) return;
      const message = messages.find((m) => m.localId === messageLocalId);
      if (message) {
        message.feedback = { rating, comment };
        await this.writeRaw(threadId, messages);
        if (this.isStaleOrDeleted(threadId, epoch)) {
          await this.cleanupAbortedWriteIfReupserted(threadId);
        }
      }
    });
  }

  static emptyTotals(): UsageTotals {
    return { ...EMPTY_USAGE };
  }
}

export function isValidStoredMessage(val: unknown): val is StoredChatMessage {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const rec = val as Record<string, unknown>;
  return (
    typeof rec.localId === 'string' &&
    rec.localId.length > 0 &&
    (rec.role === 'user' || rec.role === 'assistant') &&
    typeof rec.content === 'string'
  );
}

/** Crash-safe whole-file write (sync): write to a sibling temp file then rename over the target. */
function atomicWriteFileSync(target: string, contents: string): void {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

/** Crash-safe whole-file write (async): temp file then atomic rename over the target. */
async function atomicWriteFile(target: string, contents: string): Promise<void> {
  const tmp = target + '.tmp';
  await fsp.writeFile(tmp, contents);
  await fsp.rename(tmp, target);
}

/**
 * Rename a corrupt file to a stable '.corrupt' backup so a later write does not
 * destroy it. Uses a fixed suffix; if a backup already exists it is left intact.
 */
function preserveCorrupt(file: string): void {
  const backup = file + '.corrupt';
  try {
    if (!fs.existsSync(backup)) {
      fs.renameSync(file, backup);
    }
  } catch {
    // Best-effort preservation; never block startup on backup failure.
  }
}

function preserveCorruptCopy(file: string): void {
  const backup = file + '.corrupt';
  try {
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
    }
  } catch {
    // Best-effort preservation; never block startup on backup failure.
  }
}

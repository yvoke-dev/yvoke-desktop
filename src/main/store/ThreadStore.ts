import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  EMPTY_USAGE,
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
interface StoredImage extends Omit<ImageAttachment, 'data'> {
  data?: string;
  /** Blob file name inside the thread's image directory. */
  file?: string;
}

interface StoredChatMessage extends Omit<ChatMessage, 'images'> {
  images?: StoredImage[];
}

/**
 * Local cache + SDK session map — the server is the system of record (Req. 7).
 * Index in index.json; one JSONL message log per thread. Usage totals accumulate
 * per turn and are recomputable from synced per-message usage.
 */
export class ThreadStore {
  private readonly indexFile: string;
  private index: Record<string, ThreadMeta>;
  /** Per-thread promise chain serializing message-log mutations (see runExclusive). */
  private readonly opChain = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {
    this.indexFile = path.join(dir, 'index.json');
    this.index = this.loadIndex();
  }

  private loadIndex(): Record<string, ThreadMeta> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch {
      // Missing file (first run) — start empty without touching disk.
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      // The file exists but is corrupt: preserve it as a backup rather than
      // silently returning {} (which persistIndex would then overwrite).
      preserveCorrupt(this.indexFile);
      return {};
    }
  }

  private persistIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWriteFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  private validateThreadId(threadId: string): void {
    if (!/^[a-zA-Z0-9\-_]+$/.test(threadId)) {
      throw new Error(`Invalid threadId: ${threadId}`);
    }
  }

  private messagesFile(threadId: string): string {
    this.validateThreadId(threadId);
    return path.join(this.dir, `${threadId}.jsonl`);
  }

  list(): ThreadMeta[] {
    return Object.values(this.index).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(threadId: string): ThreadMeta | undefined {
    this.validateThreadId(threadId);
    return this.index[threadId];
  }

  upsert(meta: ThreadMeta): void {
    this.validateThreadId(meta.id);
    this.index[meta.id] = meta;
    this.persistIndex();
  }

  patch(threadId: string, update: Partial<ThreadMeta>): ThreadMeta | undefined {
    this.validateThreadId(threadId);
    const existing = this.index[threadId];
    if (!existing) {
      return undefined;
    }
    this.index[threadId] = { ...existing, ...update };
    this.persistIndex();
    return this.index[threadId];
  }

  setSessionId(threadId: string, sessionId: string): void {
    this.patch(threadId, { sessionId });
  }

  setSyncState(threadId: string, syncState: SyncState): void {
    this.patch(threadId, { syncState });
  }

  delete(threadId: string): void {
    this.validateThreadId(threadId);
    delete this.index[threadId];
    this.persistIndex();
    // Remove the log through the per-thread chain so it runs AFTER any in-flight append —
    // otherwise a fire-and-forget write could recreate the file post-delete and orphan it.
    void this.runExclusive(threadId, async () => {
      await fsp.rm(this.messagesFile(threadId), { force: true });
      await fsp.rm(this.imageDir(threadId), { recursive: true, force: true });
    }).catch(
      (err) => console.warn(`ThreadStore: failed to remove log for ${threadId}: ${err instanceof Error ? err.message : String(err)}`),
    );
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
    // Store a normalized, never-rejecting tail so the chain survives an op's failure.
    this.opChain.set(threadId, result.then(() => undefined, () => undefined));
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
        messages.push(JSON.parse(line) as StoredChatMessage);
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

  async readMessages(threadId: string): Promise<ChatMessage[]> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, async () => this.hydrateImages(threadId, await this.readRaw(threadId)));
  }

  async appendMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const stored = await this.dehydrateImages(threadId, messages);
      const lines = stored.map((m) => JSON.stringify(m)).join('\n') + '\n';
      await fsp.appendFile(this.messagesFile(threadId), lines);

      const assistantUsage = messages.find((m) => m.role === 'assistant')?.usage;
      const meta = this.index[threadId];
      if (meta) {
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
    return this.runExclusive(threadId, async () => {
      const stored = await this.dehydrateImages(threadId, messages);
      await this.writeRaw(threadId, stored);
      await this.collectImageGarbage(threadId, stored);
    });
  }

  /** Writes server ids back onto locally-logged messages after a sync ack (atomic read-modify-write). */
  async applyServerIds(threadId: string, mapping: Record<string, string>): Promise<void> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, async () => {
      const messages = await this.readRaw(threadId);
      let changed = false;
      for (const message of messages) {
        const serverId = mapping[message.localId];
        if (serverId && message.serverId !== serverId) {
          message.serverId = serverId;
          changed = true;
        }
      }
      if (changed) {
        await this.writeRaw(threadId, messages);
      }
    });
  }

  async setFeedback(threadId: string, messageLocalId: string, rating: 1 | -1, comment?: string): Promise<void> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, async () => {
      const messages = await this.readRaw(threadId);
      const message = messages.find((m) => m.localId === messageLocalId);
      if (message) {
        message.feedback = { rating, comment };
        await this.writeRaw(threadId, messages);
      }
    });
  }

  static emptyTotals(): UsageTotals {
    return { ...EMPTY_USAGE };
  }
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

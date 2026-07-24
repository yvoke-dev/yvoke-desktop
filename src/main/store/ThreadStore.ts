import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EMPTY_USAGE, type ChatMessage, type SyncState, type ThreadMeta, type UsageTotals } from '../../shared/types';

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
    void this.runExclusive(threadId, () => fsp.rm(this.messagesFile(threadId), { force: true })).catch(
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

  private async readRaw(threadId: string): Promise<ChatMessage[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.messagesFile(threadId), 'utf8');
    } catch {
      return [];
    }
    // Parse line-by-line so a single malformed (or truncated trailing) line
    // never discards the whole thread — return every line that parses.
    const messages: ChatMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        console.warn(`ThreadStore: skipping unparseable message line in thread ${threadId}`);
      }
    }
    return messages;
  }

  private async writeRaw(threadId: string, messages: ChatMessage[]): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const contents = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : '');
    await atomicWriteFile(this.messagesFile(threadId), contents);
  }

  async readMessages(threadId: string): Promise<ChatMessage[]> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, () => this.readRaw(threadId));
  }

  async appendMessages(threadId: string, messages: ChatMessage[]): Promise<void> {
    this.validateThreadId(threadId);
    return this.runExclusive(threadId, async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
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
    return this.runExclusive(threadId, () => this.writeRaw(threadId, messages));
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

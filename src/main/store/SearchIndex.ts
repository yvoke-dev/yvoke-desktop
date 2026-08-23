import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ChatMessage, ThreadSearchHit } from '../../shared/types';

/**
 * Local full-text index over the cached thread logs, so the sidebar can search what was
 * *said* and not just conversation titles. Everything here stays on this machine — the
 * index is derived from `threads/<id>.jsonl` and never leaves the app.
 *
 * Incremental by design (Req: "index only what changed since last time"):
 *   - startup  — `refresh()` stats every log and re-reads only those whose (size, mtime)
 *                differ from what the persisted index recorded.
 *   - running  — `addMessages` / `replaceMessages` fold new turns in as they are written,
 *                so a search made seconds after a reply already finds it.
 *
 * Only message prose is indexed (`content`, or the blocks' text when content is empty).
 * Thinking and tool results are deliberately skipped: they are the bulk of a log's bytes
 * and searching them would surface raw JSON payloads rather than conversation.
 */

/** One indexed message. Kept small — this is what the on-disk index costs. */
interface IndexedDoc {
  /** Message localId, so a hit can later be scrolled to. */
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text: string;
}

interface IndexEntry {
  /** Log stat as of the read that produced `docs` — the "already indexed" test. */
  size: number;
  mtimeMs: number;
  docs: IndexedDoc[];
}

interface PersistedIndex {
  version: number;
  entries: Record<string, IndexEntry>;
}

/** What one sweep touched — logged at startup so index cost is visible. */
export interface IndexSweep {
  indexed: number;
  skipped: number;
  removed: number;
}

const INDEX_VERSION = 1;
/** Per-message cap; prose messages never approach it, a pathological one is truncated not dropped. */
const MAX_DOC_CHARS = 20_000;
const SNIPPET_RADIUS = 48;
const PERSIST_DEBOUNCE_MS = 2_000;

export class SearchIndex {
  private entries = new Map<string, IndexEntry>();
  /** Lowercased doc text, mirroring `entries`. Derived, never persisted. */
  private lowered = new Map<string, string[]>();
  private loaded: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /** Serializes index-file writes so a debounced flush can't overlap a dispose flush. */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param threadsDir directory holding `<threadId>.jsonl` logs
   * @param indexFile  where the derived index is persisted
   */
  constructor(
    private readonly threadsDir: string,
    private readonly indexFile: string,
  ) {}

  /** Loads the persisted index, then sweeps the logs for anything stale. Safe to call once. */
  start(): Promise<IndexSweep> {
    return this.load().then(() => this.refresh());
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.readIndexFile();
    }
    return this.loaded;
  }

  private async readIndexFile(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexFile, 'utf8');
    } catch {
      return; // First run — nothing indexed yet.
    }
    try {
      const parsed = JSON.parse(raw) as PersistedIndex;
      // A version bump changes what/how we index; discarding is cheaper than migrating,
      // and `refresh()` rebuilds from the logs anyway.
      if (parsed.version !== INDEX_VERSION || !parsed.entries) return;
      for (const [threadId, entry] of Object.entries(parsed.entries)) {
        if (!Array.isArray(entry?.docs)) continue;
        this.setEntry(threadId, entry);
      }
    } catch {
      // Corrupt index: drop it. It is a cache, so the sweep below simply rebuilds it.
    }
  }

  private setEntry(threadId: string, entry: IndexEntry): void {
    this.entries.set(threadId, entry);
    this.lowered.set(
      threadId,
      entry.docs.map((d) => d.text.toLowerCase()),
    );
  }

  /**
   * Stats every thread log and re-indexes only the ones that changed since the last sweep.
   * Returns how many logs were read vs. skipped (used by the startup log line).
   */
  async refresh(): Promise<IndexSweep> {
    await this.load();
    let indexed = 0;
    let skipped = 0;
    let removed = 0;

    let files: string[];
    try {
      files = await fsp.readdir(this.threadsDir);
    } catch {
      return { indexed, skipped, removed }; // No logs yet.
    }

    const seen = new Set<string>();
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const threadId = file.slice(0, -'.jsonl'.length);
      if (!/^[a-zA-Z0-9\-_]+$/.test(threadId)) continue;
      seen.add(threadId);

      const full = path.join(this.threadsDir, file);
      let stat: { size: number; mtimeMs: number };
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      const existing = this.entries.get(threadId);
      if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
        skipped += 1;
        continue;
      }
      // Stat BEFORE the read, and store that stat: if an append lands mid-read we record a
      // size smaller than what we indexed, which costs one redundant re-read next sweep.
      // Storing a post-read stat could do the opposite — record bytes we never indexed.
      await this.indexFile_(threadId, full, stat);
      indexed += 1;
    }

    for (const threadId of [...this.entries.keys()]) {
      if (!seen.has(threadId)) {
        this.entries.delete(threadId);
        this.lowered.delete(threadId);
        removed += 1;
        this.markDirty();
      }
    }

    return { indexed, skipped, removed };
  }

  private async indexFile_(threadId: string, file: string, stat: { size: number; mtimeMs: number }): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      return;
    }
    const docs: IndexedDoc[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const doc = toDoc(JSON.parse(line) as ChatMessage);
        if (doc) docs.push(doc);
      } catch {
        // Same tolerance as ThreadStore: one bad (or half-written trailing) line
        // must not cost us the rest of the thread.
      }
    }
    this.setEntry(threadId, { size: stat.size, mtimeMs: stat.mtimeMs, docs });
    this.markDirty();
  }

  /**
   * Folds a just-written turn into the index without touching disk.
   *
   * The recorded stat is deliberately left stale, so the next `refresh()` re-reads this log
   * once and re-syncs the stat. That keeps the live path cheap while making it impossible for
   * a concurrent write to leave content permanently unindexed.
   */
  addMessages(threadId: string, messages: ChatMessage[]): void {
    const entry = this.entries.get(threadId) ?? { size: -1, mtimeMs: -1, docs: [] };
    const added = messages.map(toDoc).filter((d): d is IndexedDoc => d !== null);
    if (added.length === 0) return;
    const known = new Set(entry.docs.map((d) => d.id));
    const fresh = added.filter((d) => !known.has(d.id));
    if (fresh.length === 0) return;
    this.setEntry(threadId, { size: entry.size, mtimeMs: entry.mtimeMs, docs: [...entry.docs, ...fresh] });
    this.markDirty();
  }

  /** Replaces a thread's docs wholesale (server rehydration of a log we had no copy of). */
  replaceMessages(threadId: string, messages: ChatMessage[]): void {
    const docs = messages.map(toDoc).filter((d): d is IndexedDoc => d !== null);
    this.setEntry(threadId, { size: -1, mtimeMs: -1, docs });
    this.markDirty();
  }

  remove(threadId: string): void {
    if (this.entries.delete(threadId)) {
      this.lowered.delete(threadId);
      this.markDirty();
    }
  }

  /**
   * Every thread with a message matching `query`, best first. All whitespace-separated terms
   * must appear in the same message, so "queue validation" finds the message that discusses
   * both rather than any thread mentioning either.
   */
  async search(query: string, limit = 200): Promise<ThreadSearchHit[]> {
    // Await the persisted load only (not the sweep) so a search typed during startup still
    // answers from the previous session's index instead of coming back empty.
    await this.load();
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    const hits: ThreadSearchHit[] = [];
    for (const [threadId, entry] of this.entries) {
      const lowered = this.lowered.get(threadId) ?? [];
      let matches = 0;
      let first: IndexedDoc | null = null;
      for (let i = 0; i < entry.docs.length; i += 1) {
        const text = lowered[i] ?? '';
        if (!terms.every((t) => text.includes(t))) continue;
        matches += 1;
        if (!first) first = entry.docs[i];
      }
      if (matches > 0 && first) {
        hits.push({
          threadId,
          matches,
          messageLocalId: first.id,
          role: first.role,
          snippet: snippetFor(first.text, terms),
        });
      }
    }
    // More matching messages first; ties broken by the id so the order is stable between keystrokes.
    hits.sort((a, b) => b.matches - a.matches || a.threadId.localeCompare(b.threadId));
    return hits.slice(0, limit);
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the app open just to write a cache.
    this.persistTimer.unref?.();
  }

  /** Writes the index to disk if anything changed. Called on the debounce and at shutdown. */
  flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return this.writeChain;
    this.dirty = false;
    const payload: PersistedIndex = { version: INDEX_VERSION, entries: Object.fromEntries(this.entries) };
    const body = JSON.stringify(payload);
    this.writeChain = this.writeChain.then(
      () => this.writeIndexFile(body),
      () => this.writeIndexFile(body),
    );
    return this.writeChain;
  }

  private async writeIndexFile(body: string): Promise<void> {
    const tmp = this.indexFile + '.tmp';
    try {
      await fsp.mkdir(path.dirname(this.indexFile), { recursive: true });
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, this.indexFile);
    } catch {
      // The index is a cache; a failed write costs a rebuild, never data.
    }
  }

  /**
   * Shutdown flush. Synchronous because `before-quit` does not wait on promises — an async
   * write would routinely be cut off, costing a full re-index on the next launch. Writes via
   * its own temp file so it cannot collide with an async flush already in flight; whichever
   * rename lands last wins, and both are complete, valid snapshots.
   */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const payload: PersistedIndex = { version: INDEX_VERSION, entries: Object.fromEntries(this.entries) };
    const tmp = this.indexFile + '.tmp-exit';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.indexFile);
    } catch {
      // Cache only — a failed write costs a rebuild, never data.
    }
  }
}

/** Message → indexed doc, or null when it carries no prose worth indexing. */
function toDoc(message: ChatMessage): IndexedDoc | null {
  if (!message?.localId || (message.role !== 'user' && message.role !== 'assistant')) return null;
  let text = typeof message.content === 'string' ? message.content.trim() : '';
  if (!text && message.blocks?.length) {
    text = message.blocks
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
  }
  if (!text) return null;
  return {
    id: message.localId,
    role: message.role,
    at: message.createdAt,
    text: text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text,
  };
}

export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** A one-line excerpt centred on the earliest matching term, with ellipses where it was cut. */
function snippetFor(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + SNIPPET_RADIUS * 2);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

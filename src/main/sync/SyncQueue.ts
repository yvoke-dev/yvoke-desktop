import fs from 'node:fs';
import path from 'node:path';
import type { SyncEvent } from '../../shared/types';
import { isAttributedError, sanitizeLogContent, tagAttributedError } from '../../shared/error';
import { SyncApiError, type NewMessagePayload, type SyncClient } from './SyncClient';

export interface QueuedTurn {
  threadId: string;
  /** Local message ids in the same order as `messages` — mapped to server ids on ack. */
  localIds: string[];
  messages: NewMessagePayload[];
  enqueuedAt: string;
  attempts: number;
}

export type HeldThreadResolution = 'ready' | 'deferred';
export type MissingConversationResolution = 'recreated' | 'deferred' | 'retry' | 'drop';

export interface SyncQueueDeps {
  client: SyncClient;
  file: string;
  emit: (event: SyncEvent) => void;
  /** Persist localId → serverId mapping after a turn is acked. */
  onServerIds: (threadId: string, mapping: Record<string, string>) => void;
  /** Total waiting turns across all conversations (including unqueued startup turns). */
  totalPendingCount?: () => number;
  /** Lazily reconcile a startup-held thread before flushing its turns. */
  reconcileHeldThread?: (threadId: string) => Promise<HeldThreadResolution>;
  /** Handle a 404 Not Found on appendMessages (e.g. recreate conversation & migrate turns). */
  onMissingConversation?: (threadId: string) => Promise<MissingConversationResolution>;
  /** Notified when a turn is dropped for the current session (non-401/non-404 4xx or 500-turn cap). */
  onTurnDropped?: (turn: QueuedTurn, detail: string) => void;
  /** Backoff schedule in ms; index = attempts (capped at last entry). */
  backoffMs?: number[];
  setTimeoutFn?: typeof setTimeout;
}

const DEFAULT_BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Upper bound on queued (un-acked) turns. Retries themselves are intentionally unbounded
 * (a turn keeps trying so it is never silently lost while the server is merely down), but a
 * very long outage with continued chatting must not grow the queue without limit — past this
 * cap the oldest turn is dropped with a visible error rather than accumulating forever.
 */
export const MAX_QUEUE_LENGTH = 500;

const MAX_DETAIL_LENGTH = 300;

function sanitizeDetail(raw: string): string {
  const safe = sanitizeLogContent(raw).trim();
  return safe.length > MAX_DETAIL_LENGTH ? `${safe.slice(0, MAX_DETAIL_LENGTH)}…` : safe;
}

function isValidQueuedTurn(item: unknown): item is QueuedTurn {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const rec = item as Record<string, unknown>;
  if (typeof rec.threadId !== 'string' || rec.threadId.length === 0) return false;
  if (!Array.isArray(rec.localIds) || !rec.localIds.every((id) => typeof id === 'string')) return false;
  if (
    !Array.isArray(rec.messages) ||
    !rec.messages.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        !Array.isArray(m) &&
        ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') &&
        typeof (m as { content?: unknown }).content === 'string',
    )
  ) {
    return false;
  }
  return true;
}

function preserveCorruptQueue(file: string): void {
  const backup = file + '.corrupt';
  try {
    if (!fs.existsSync(backup)) {
      fs.renameSync(file, backup);
    }
  } catch {
    // Best-effort preservation; never block startup on backup failure.
  }
}

function preserveCorruptQueueCopy(file: string): void {
  const backup = file + '.corrupt';
  try {
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
    }
  } catch {
    // Best-effort preservation; never block startup on backup failure.
  }
}

/**
 * Durable write-through queue (Correctness Property 5): every completed turn is
 * appended to an on-disk queue file and flushed in order with retry/backoff —
 * a turn is either acked by the server or still sitting in the queue. Non-401/non-404
 * 4xx validation responses are dropped for the session with `dropped: true`.
 */
export class SyncQueue {
  private queue: QueuedTurn[] = [];
  private flushPromise: Promise<void> | null = null;
  private flushRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The turn currently mid-flush (network call in flight); never dropped by the length cap. */
  private flushing: QueuedTurn | null = null;
  /** Thread IDs held at startup until their server presence / transcript is reconciled. */
  private readonly heldThreads = new Set<string>();
  private disposed = false;

  /** Remove a specific turn by identity (not by position — the front can shift during an await). */
  private removeTurn(turn: QueuedTurn): void {
    const idx = this.queue.indexOf(turn);
    if (idx !== -1) this.queue.splice(idx, 1);
  }

  constructor(private readonly deps: SyncQueueDeps) {
    this.queue = this.loadQueue();
  }

  private loadQueue(): QueuedTurn[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.deps.file, 'utf8');
    } catch {
      // Missing file (first run) — start empty without touching disk.
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      preserveCorruptQueue(this.deps.file);
      return [];
    }
    if (!Array.isArray(parsed)) {
      preserveCorruptQueue(this.deps.file);
      return [];
    }
    const valid = parsed.filter(isValidQueuedTurn);
    if (valid.length !== parsed.length) {
      if (valid.length === 0) {
        preserveCorruptQueue(this.deps.file);
        return [];
      }
      preserveCorruptQueueCopy(this.deps.file);
    }
    return valid.map((item) => ({
      threadId: item.threadId,
      localIds: [...item.localIds],
      messages: [...item.messages],
      enqueuedAt: typeof item.enqueuedAt === 'string' ? item.enqueuedAt : new Date().toISOString(),
      attempts:
        typeof item.attempts === 'number' && Number.isFinite(item.attempts) && item.attempts >= 0
          ? item.attempts
          : 0,
    }));
  }

  private persist(): void {
    // Atomic write (temp + rename): a crash mid-write must not corrupt the durable
    // queue file — otherwise loadQueue would quarantine it as '.corrupt' on next
    // start and silently drop every not-yet-acked turn (Correctness Property 5).
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    const tmp = this.deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.queue, null, 2));
    fs.renameSync(tmp, this.deps.file);
  }

  private reportedPendingCount(): number {
    return this.deps.totalPendingCount ? this.deps.totalPendingCount() : this.pendingCount();
  }

  private formatErrorDetail(error: unknown): string {
    const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
    const attributed = isAttributedError(msg) ? msg : tagAttributedError('Yvoke Backend', error);
    return sanitizeDetail(attributed);
  }

  private enforceQueueCap(): void {
    while (this.queue.length > MAX_QUEUE_LENGTH) {
      // Drop the oldest turn that is NOT the one currently mid-flush — dropping the in-flight
      // turn would desync the doFlush loop and emit a spurious error for a delivered turn.
      const idx = this.queue.findIndex((t) => t !== this.flushing);
      if (idx === -1) break; // only the in-flight turn remains over the cap
      const [dropped] = this.queue.splice(idx, 1);
      const detail = sanitizeDetail(
        `Sync backlog exceeded ${MAX_QUEUE_LENGTH} turns; oldest unsent turn was dropped.`,
      );
      this.deps.onTurnDropped?.(dropped, detail);
      this.deps.emit({
        kind: 'sync-state',
        threadId: dropped.threadId,
        state: 'error',
        pendingCount: this.reportedPendingCount(),
        detail,
        dropped: true,
      });
    }
  }

  pendingCount(threadId?: string): number {
    return threadId ? this.queue.filter((t) => t.threadId === threadId).length : this.queue.length;
  }

  holdThreads(threadIds: Iterable<string>): void {
    for (const id of threadIds) {
      if (typeof id === 'string' && id.length > 0) {
        this.heldThreads.add(id);
      }
    }
  }

  unholdThread(threadId: string): boolean {
    const removed = this.heldThreads.delete(threadId);
    if (removed && this.flushPromise && this.pendingCount(threadId) > 0) {
      this.flushRequested = true;
    }
    return removed;
  }

  isHeld(threadId: string): boolean {
    return this.heldThreads.has(threadId);
  }

  queuedThreadIds(): string[] {
    return Array.from(new Set(this.queue.map((t) => t.threadId)));
  }

  getQueuedTurns(threadId: string): QueuedTurn[] {
    return this.queue
      .filter((t) => t.threadId === threadId)
      .map((t) => ({
        ...t,
        localIds: [...t.localIds],
        messages: [...t.messages],
      }));
  }

  /**
   * Reconciles queued turns for `threadId` safely against in-flight `this.flushing` and any
   * `postSnapshot` turns enqueued concurrently after `inspectedLocalIds` was snapshotted.
   */
  reconcileThreadTurns(
    threadId: string,
    turnsToQueue: readonly QueuedTurn[],
    inspectedLocalIds: ReadonlySet<string>,
    opts?: { resetAttempts?: boolean },
  ): void {
    const resetAttempts = Boolean(opts?.resetAttempts);
    const supersedeFlushing =
      resetAttempts &&
      this.flushing !== null &&
      this.flushing.threadId === threadId;

    if (supersedeFlushing) {
      this.flushing = null;
    }

    let firstIdx = this.queue.findIndex((t) => t.threadId === threadId && t !== this.flushing);

    const flushingIds =
      this.flushing && this.flushing.threadId === threadId ? new Set(this.flushing.localIds) : null;

    const filteredReplacementTurns: QueuedTurn[] = turnsToQueue
      .filter((t) => !flushingIds || !t.localIds.some((id) => flushingIds.has(id)))
      .map((t) => ({
        threadId,
        localIds: [...t.localIds],
        messages: [...t.messages],
        enqueuedAt: t.enqueuedAt || new Date().toISOString(),
        attempts: resetAttempts ? 0 : (t.attempts ?? 0),
      }));

    const replacementIds = new Set(filteredReplacementTurns.flatMap((t) => t.localIds));

    const postSnapshot: QueuedTurn[] = this.queue
      .filter(
        (t) =>
          t.threadId === threadId &&
          t !== this.flushing &&
          t.localIds.length > 0 &&
          !t.localIds.some((id) => inspectedLocalIds.has(id) || replacementIds.has(id)),
      )
      .map((t) => ({
        threadId,
        localIds: [...t.localIds],
        messages: [...t.messages],
        enqueuedAt: t.enqueuedAt || new Date().toISOString(),
        attempts: resetAttempts ? 0 : t.attempts,
      }));

    this.queue = this.queue.filter((t) => t.threadId !== threadId || t === this.flushing);

    const toInsert = [...filteredReplacementTurns, ...postSnapshot];
    if (toInsert.length > 0) {
      if (firstIdx < 0 || firstIdx > this.queue.length) {
        firstIdx = this.queue.length;
      }
      this.queue.splice(firstIdx, 0, ...toInsert);
      this.enforceQueueCap();
    }

    this.persist();
    if (this.flushPromise && this.pendingCount(threadId) > 0 && !this.heldThreads.has(threadId)) {
      this.flushRequested = true;
    }
  }

  removeThread(threadId: string): number {
    this.heldThreads.delete(threadId);
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => t.threadId !== threadId || t === this.flushing);
    const removed = before - this.queue.length;
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  enqueue(turn: Omit<QueuedTurn, 'enqueuedAt' | 'attempts'>): void {
    this.queue.push({ ...turn, enqueuedAt: new Date().toISOString(), attempts: 0 });
    this.enforceQueueCap();
    this.persist();
    this.deps.emit({
      kind: 'sync-state',
      threadId: turn.threadId,
      state: 'pending',
      pendingCount: this.reportedPendingCount(),
    });
    void this.flush();
  }

  /** Flushes queued turns in order; tail-loops if new work arrives mid-settlement. */
  flush(): Promise<void> {
    this.flushRequested = true;
    if (!this.flushPromise) {
      this.flushPromise = (async () => {
        try {
          let status: 'completed' | 'backoff' = 'completed';
          do {
            this.flushRequested = false;
            status = await this.doFlush();
          } while (this.flushRequested && status === 'completed' && !this.disposed);
        } finally {
          this.flushPromise = null;
        }
      })();
    }
    return this.flushPromise;
  }

  private async doFlush(): Promise<'completed' | 'backoff'> {
    const deferredThreads = new Set<string>();

    while (!this.disposed) {
      const turn = this.queue.find((t) => !deferredThreads.has(t.threadId));
      if (!turn) {
        return 'completed';
      }

      if (this.heldThreads.has(turn.threadId)) {
        if (!this.deps.reconcileHeldThread) {
          deferredThreads.add(turn.threadId);
          continue;
        }
        let resolution: HeldThreadResolution;
        try {
          resolution = await this.deps.reconcileHeldThread(turn.threadId);
        } catch {
          if (this.disposed) return 'completed';
          deferredThreads.add(turn.threadId);
          continue;
        }
        if (this.disposed) return 'completed';
        if (resolution === 'deferred') {
          deferredThreads.add(turn.threadId);
          continue;
        }
        this.heldThreads.delete(turn.threadId);
        // Re-evaluate from the queue front since reconcileHeldThread may have mutated turns.
        continue;
      }

      this.flushing = turn;
      try {
        const { ids } = await this.deps.client.appendMessages(turn.threadId, turn.messages);
        if (this.flushing === turn) {
          this.flushing = null;
        }
        if (!this.queue.includes(turn)) {
          continue;
        }
        const mapping: Record<string, string> = {};
        turn.localIds.forEach((localId, i) => {
          if (ids[i]) mapping[localId] = ids[i];
        });
        this.removeTurn(turn);
        this.persist();
        this.deps.onServerIds(turn.threadId, mapping);
        if (!this.disposed) {
          this.deps.emit({ kind: 'server-ids', threadId: turn.threadId, mapping });
          this.deps.emit({
            kind: 'sync-state',
            threadId: turn.threadId,
            state: this.pendingCount(turn.threadId) > 0 ? 'pending' : 'synced',
            pendingCount: this.reportedPendingCount(),
          });
        }
      } catch (error) {
        if (this.flushing === turn) {
          this.flushing = null;
        }
        if (this.disposed) {
          return 'completed';
        }
        if (!this.queue.includes(turn)) {
          continue;
        }

        if (error instanceof SyncApiError && error.status === 404 && this.deps.onMissingConversation) {
          let outcome: MissingConversationResolution;
          try {
            outcome = await this.deps.onMissingConversation(turn.threadId);
          } catch (hookErr) {
            if (this.disposed) {
              return 'completed';
            }
            outcome = 'retry';
            error = hookErr;
          }
          if (this.disposed) {
            return 'completed';
          }
          if (outcome === 'recreated') {
            continue;
          }
          if (outcome === 'deferred') {
            deferredThreads.add(turn.threadId);
            continue;
          }
          if (outcome === 'drop') {
            const detail = this.formatErrorDetail(error);
            this.removeTurn(turn);
            this.persist();
            this.deps.onTurnDropped?.(turn, detail);
            this.deps.emit({
              kind: 'sync-state',
              threadId: turn.threadId,
              state: 'error',
              pendingCount: this.reportedPendingCount(),
              detail,
              dropped: true,
            });
            continue;
          }
        }

        const detail = this.formatErrorDetail(error);

        if (
          error instanceof SyncApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 401 &&
          error.status !== 404
        ) {
          // Non-retriable validation/ownership rejection: drop for this session and surface banner.
          this.removeTurn(turn);
          this.persist();
          this.deps.onTurnDropped?.(turn, detail);
          this.deps.emit({
            kind: 'sync-state',
            threadId: turn.threadId,
            state: 'error',
            pendingCount: this.reportedPendingCount(),
            detail,
            dropped: true,
          });
          continue;
        }

        turn.attempts += 1;
        this.persist();
        this.deps.emit({
          kind: 'sync-state',
          threadId: turn.threadId,
          state: 'error',
          pendingCount: this.reportedPendingCount(),
          detail,
        });
        this.scheduleRetry(turn.attempts);
        return 'backoff';
      }
    }

    return 'completed';
  }

  private scheduleRetry(attempts: number): void {
    if (this.disposed) {
      return;
    }
    const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF;
    const delay = backoff[Math.min(attempts - 1, backoff.length - 1)];
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeoutFn(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

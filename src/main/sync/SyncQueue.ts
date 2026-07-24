import fs from 'node:fs';
import path from 'node:path';
import type { SyncEvent } from '../../shared/types';
import { SyncApiError, type NewMessagePayload, type SyncClient } from './SyncClient';

export interface QueuedTurn {
  threadId: string;
  /** Local message ids in the same order as `messages` — mapped to server ids on ack. */
  localIds: string[];
  messages: NewMessagePayload[];
  enqueuedAt: string;
  attempts: number;
}

export interface SyncQueueDeps {
  client: SyncClient;
  file: string;
  emit: (event: SyncEvent) => void;
  /** Persist localId → serverId mapping after a turn is acked. */
  onServerIds: (threadId: string, mapping: Record<string, string>) => void;
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
const MAX_QUEUE_LENGTH = 500;

/**
 * Durable write-through queue (Correctness Property 5): every completed turn is
 * appended to an on-disk queue file and flushed in order with retry/backoff —
 * a turn is either acked by the server or still sitting in the queue. 4xx
 * validation responses are not retriable and are dropped with an error event.
 */
export class SyncQueue {
  private queue: QueuedTurn[] = [];
  private flushPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The turn currently mid-flush (network call in flight); never dropped by the length cap. */
  private flushing: QueuedTurn | null = null;

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
    try {
      return JSON.parse(raw);
    } catch {
      // The file exists but is corrupt: preserve it as a stable '.corrupt' backup
      // rather than silently returning [] (which persist() would then overwrite),
      // so undelivered turns are not destroyed. Leave any existing backup intact.
      const backup = this.deps.file + '.corrupt';
      try {
        if (!fs.existsSync(backup)) {
          fs.renameSync(this.deps.file, backup);
        }
      } catch {
        // Best-effort preservation; never block startup on backup failure.
      }
      return [];
    }
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

  pendingCount(threadId?: string): number {
    return threadId ? this.queue.filter((t) => t.threadId === threadId).length : this.queue.length;
  }

  enqueue(turn: Omit<QueuedTurn, 'enqueuedAt' | 'attempts'>): void {
    this.queue.push({ ...turn, enqueuedAt: new Date().toISOString(), attempts: 0 });
    while (this.queue.length > MAX_QUEUE_LENGTH) {
      // Drop the oldest turn that is NOT the one currently mid-flush — dropping the in-flight
      // turn would desync the doFlush loop and emit a spurious error for a delivered turn.
      const idx = this.queue.findIndex((t) => t !== this.flushing);
      if (idx === -1) break; // only the in-flight turn remains over the cap
      const [dropped] = this.queue.splice(idx, 1);
      this.deps.emit({
        kind: 'sync-state',
        threadId: dropped.threadId,
        state: 'error',
        pendingCount: this.pendingCount(dropped.threadId),
        detail: `Sync backlog exceeded ${MAX_QUEUE_LENGTH} turns; oldest unsent turn was dropped.`,
      });
    }
    this.persist();
    this.deps.emit({
      kind: 'sync-state',
      threadId: turn.threadId,
      state: 'pending',
      pendingCount: this.pendingCount(turn.threadId),
    });
    void this.flush();
  }

  /** Flushes queued turns in order; stops on the first transient failure and reschedules. */
  flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.doFlush().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    {
      while (this.queue.length > 0) {
        const turn = this.queue[0];
        this.flushing = turn;
        try {
          const { ids } = await this.deps.client.appendMessages(turn.threadId, turn.messages);
          this.flushing = null;
          const mapping: Record<string, string> = {};
          turn.localIds.forEach((localId, i) => {
            if (ids[i]) mapping[localId] = ids[i];
          });
          this.removeTurn(turn);
          this.persist();
          this.deps.onServerIds(turn.threadId, mapping);
          this.deps.emit({ kind: 'server-ids', threadId: turn.threadId, mapping });
          this.deps.emit({
            kind: 'sync-state',
            threadId: turn.threadId,
            state: this.pendingCount(turn.threadId) > 0 ? 'pending' : 'synced',
            pendingCount: this.pendingCount(turn.threadId),
          });
        } catch (error) {
          this.flushing = null;
          if (error instanceof SyncApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
            // Non-retriable (validation/ownership): drop the turn, surface the error.
            this.removeTurn(turn);
            this.persist();
            this.deps.emit({
              kind: 'sync-state',
              threadId: turn.threadId,
              state: 'error',
              pendingCount: this.pendingCount(turn.threadId),
              detail: error.message,
            });
            continue;
          }
          turn.attempts += 1;
          this.persist();
          this.deps.emit({
            kind: 'sync-state',
            threadId: turn.threadId,
            state: 'error',
            pendingCount: this.pendingCount(turn.threadId),
            detail: error instanceof Error ? error.message : String(error),
          });
          this.scheduleRetry(turn.attempts);
          return;
        }
      }
    }
  }

  private scheduleRetry(attempts: number): void {
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

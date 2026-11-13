import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncEvent } from '../src/shared/types';
import { SyncApiError, type SyncClient } from '../src/main/sync/SyncClient';
import { SyncQueue, type QueuedTurn, type SyncQueueDeps } from '../src/main/sync/SyncQueue';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'syncq-')), 'queue.json');
}

function fakeClient(appendImpl: (threadId: string, messages: unknown[]) => Promise<{ ids: string[] }>): SyncClient {
  return { appendMessages: appendImpl } as unknown as SyncClient;
}

const turn = (threadId: string, n: number) => ({
  threadId,
  localIds: [`u${n}`, `a${n}`],
  messages: [
    { role: 'user' as const, content: `q${n}` },
    { role: 'assistant' as const, content: `a${n}` },
  ],
});

describe('SyncQueue durability (Correctness Property 5)', () => {
  let file: string;
  let events: SyncEvent[];
  let mappings: Array<{ threadId: string; mapping: Record<string, string> }>;

  beforeEach(() => {
    file = tmpFile();
    events = [];
    mappings = [];
  });

  afterEach(() => {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  const deps = (client: SyncClient) => ({
    client,
    file,
    emit: (e: SyncEvent) => events.push(e),
    onServerIds: (threadId: string, mapping: Record<string, string>) => mappings.push({ threadId, mapping }),
    backoffMs: [1],
    setTimeoutFn: ((fn: () => void) => setTimeout(fn, 0)) as typeof setTimeout,
  });

  it('flushes turns in order and maps local ids to server ids', async () => {
    const calls: unknown[][] = [];
    const queue = new SyncQueue(
      deps(
        fakeClient(async (_threadId, messages) => {
          calls.push(messages);
          return { ids: [`srv-${calls.length}-0`, `srv-${calls.length}-1`] };
        }),
      ),
    );
    queue.enqueue(turn('t1', 1));
    queue.enqueue(turn('t1', 2));
    await queue.flush();

    expect(calls).toHaveLength(2);
    expect(mappings[0].mapping).toEqual({ u1: 'srv-1-0', a1: 'srv-1-1' });
    expect(queue.pendingCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'sync-state', state: 'synced', pendingCount: 0 });
  });

  it('keeps turns queued across restarts when the server is down', async () => {
    const failing = fakeClient(async () => {
      throw new Error('ECONNREFUSED');
    });
    const queue = new SyncQueue(deps(failing));
    queue.enqueue(turn('t1', 1));
    await queue.flush();
    expect(queue.pendingCount()).toBe(1);
    queue.dispose();

    // Simulate restart: a new queue instance over the same file recovers, then a healthy server drains it.
    const recovered = new SyncQueue(
      deps(fakeClient(async () => ({ ids: ['s1', 's2'] }))),
    );
    expect(recovered.pendingCount()).toBe(1);
    await recovered.flush();
    expect(recovered.pendingCount()).toBe(0);
    recovered.dispose();
  });

  it('stops at the first transient failure and preserves order', async () => {
    let healthy = false;
    const flaky = fakeClient(async (_t, messages) => {
      if (!healthy) throw new Error('down');
      return { ids: (messages as unknown[]).map((_, i) => `s${i}`) };
    });
    const queue = new SyncQueue(deps(flaky));
    queue.enqueue(turn('t1', 1));
    queue.enqueue(turn('t1', 2));
    await queue.flush();
    expect(queue.pendingCount()).toBe(2);

    healthy = true;
    await queue.flush();
    expect(queue.pendingCount()).toBe(0);
    queue.dispose();
  });

  it('drops non-retriable 4xx turns with an error event instead of blocking the queue', async () => {
    let first = true;
    const queue = new SyncQueue(
      deps(
        fakeClient(async () => {
          if (first) {
            first = false;
            throw new SyncApiError(400, 'validation failed');
          }
          return { ids: ['s1', 's2'] };
        }),
      ),
    );
    queue.enqueue(turn('t1', 1));
    queue.enqueue(turn('t1', 2));
    await queue.flush();

    expect(queue.pendingCount()).toBe(0);
    expect(events.some((e) => e.kind === 'sync-state' && e.state === 'error' && e.detail?.includes('validation'))).toBe(true);
    expect(mappings).toHaveLength(1); // only the second turn acked
    queue.dispose();
  });

  it('caps queue length, dropping the oldest turn with a visible error', () => {
    // A client whose request never settles keeps every turn queued, so the length cap fires.
    const queue = new SyncQueue(deps(fakeClient(() => new Promise<{ ids: string[] }>(() => {}))));
    for (let n = 0; n <= 500; n++) {
      queue.enqueue(turn('t1', n)); // 501 enqueues → exactly one must be dropped
    }
    expect(queue.pendingCount()).toBe(500);
    expect(
      events.some(
        (e) => e.kind === 'sync-state' && e.state === 'error' && /backlog exceeded/.test(e.detail ?? ''),
      ),
    ).toBe(true);
    queue.dispose();
  });

  it('preserves Entra error prefix without double-tagging as Yvoke Backend: Entra:', async () => {
    const queue = new SyncQueue(
      deps(
        fakeClient(async () => {
          throw new Error('Entra: Authentication session expired or invalid. Please sign in again.');
        }),
      ),
    );
    queue.enqueue(turn('t1', 1));
    await queue.flush();

    const errEvent = events.find(
      (e): e is Extract<SyncEvent, { kind: 'sync-state' }> => e.kind === 'sync-state' && e.state === 'error',
    );
    expect(errEvent).toBeDefined();
    expect(errEvent?.detail).toBe('Entra: Authentication session expired or invalid. Please sign in again.');
    expect(errEvent?.detail?.startsWith('Yvoke Backend:')).toBe(false);
    queue.dispose();
  });

  it('tags SyncApiError(500) with Yvoke Backend prefix', async () => {
    const queue = new SyncQueue(
      deps(
        fakeClient(async () => {
          throw new SyncApiError(500, 'POST /messages failed (500): Internal Server Error');
        }),
      ),
    );
    queue.enqueue(turn('t1', 1));
    await queue.flush();

    const errEvent = events.find(
      (e): e is Extract<SyncEvent, { kind: 'sync-state' }> => e.kind === 'sync-state' && e.state === 'error',
    );
    expect(errEvent).toBeDefined();
    expect(errEvent?.detail?.startsWith('Yvoke Backend: ')).toBe(true);
    queue.dispose();
  });

  describe('Wave 1: tail-loop flush, per-thread hold, 404/4xx/500 matrix, corrupt-queue recovery & redaction', () => {
    let subSeq = 0;
    const noopTimeout = (() => 0) as unknown as typeof setTimeout;
    const customDeps = (client: SyncClient, extra: Partial<SyncQueueDeps> = {}): SyncQueueDeps => ({
      ...deps(client),
      file: path.join(path.dirname(file), `queue-sub-${++subSeq}.json`),
      ...extra,
    });

    it('tail-loop flush() drains turns enqueued during callback/settlement before resolving', async () => {
      const appendedThreads: string[] = [];
      let queue!: SyncQueue;
      let enqueuedDuringAck = false;

      queue = new SyncQueue(
        customDeps(
          fakeClient(async (threadId, messages) => {
            appendedThreads.push(threadId);
            return { ids: (messages as unknown[]).map((_, i) => `srv-${threadId}-${i}`) };
          }),
          {
            onServerIds: (threadId, mapping) => {
              mappings.push({ threadId, mapping });
              if (!enqueuedDuringAck) {
                enqueuedDuringAck = true;
                // Enqueue while doFlush has just removed the last queued item!
                queue.enqueue(turn('t2', 99));
              }
            },
          },
        ),
      );

      queue.enqueue(turn('t1', 1));
      await queue.flush();

      expect(appendedThreads).toEqual(['t1', 't2']);
      expect(queue.pendingCount()).toBe(0);
      queue.dispose();
    });

    it('flushes unheld threads past held/deferred threads without head-of-line blocking and supports lazy reconcileHeldThread', async () => {
      const flushedOrder: string[] = [];
      let allowT1Ready = false;

      const queue = new SyncQueue(
        customDeps(
          fakeClient(async (threadId) => {
            flushedOrder.push(threadId);
            return { ids: [`srv-${threadId}-u`, `srv-${threadId}-a`] };
          }),
          {
            reconcileHeldThread: async (threadId) => {
              if (threadId === 't1' && !allowT1Ready) return 'deferred';
              return 'ready';
            },
          },
        ),
      );

      queue.holdThreads(['t1', 't3']);
      expect(queue.isHeld('t1')).toBe(true);
      expect(queue.isHeld('t2')).toBe(false);

      queue.enqueue(turn('t1', 1));
      queue.enqueue(turn('t2', 2));
      queue.enqueue(turn('t3', 3));

      await queue.flush();

      // t1 returned 'deferred', so t2 (unheld) and t3 (reconcileHeldThread -> 'ready') flushed cleanly!
      expect(flushedOrder).toContain('t2');
      expect(flushedOrder).toContain('t3');
      expect(flushedOrder).not.toContain('t1');
      expect(queue.isHeld('t1')).toBe(true);
      expect(queue.isHeld('t3')).toBe(false);
      expect(queue.queuedThreadIds()).toEqual(['t1']);

      // Now unhold/allow t1 and flush
      allowT1Ready = true;
      await queue.flush();
      expect(flushedOrder).toEqual(['t2', 't3', 't1']);
      expect(queue.pendingCount()).toBe(0);
      queue.dispose();
    });

    it('emits totalPendingCount across all threads while keeping per-thread state, and supports getQueuedTurns / replaceThreadTurns / migrateThread / removeThread', async () => {
      const queue: SyncQueue = new SyncQueue(
        customDeps(
          fakeClient(async (threadId) => ({ ids: [`${threadId}-s1`, `${threadId}-s2`] })),
          {
            totalPendingCount: (): number => queue.pendingCount() + 3, // +3 unqueued startup turns
          },
        ),
      );

      queue.holdThreads(['t1', 't2']);
      queue.enqueue(turn('t1', 1));
      queue.enqueue(turn('t2', 2));

      expect(queue.getQueuedTurns('t1')).toHaveLength(1);

      // Replace t1 turns and migrate t1 -> t1-new
      const replacement: QueuedTurn = {
        threadId: 't1',
        localIds: ['u-rep', 'a-rep'],
        messages: [
          { role: 'user', content: 'replaced Q' },
          { role: 'assistant', content: 'replaced A' },
        ],
        enqueuedAt: '2026-06-10T10:00:00Z',
        attempts: 0,
      };
      queue.replaceThreadTurns('t1', [replacement]);
      queue.migrateThread('t1', 't1-new');
      expect(queue.isHeld('t1')).toBe(false);
      expect(queue.getQueuedTurns('t1-new')[0].localIds).toEqual(['u-rep', 'a-rep']);

      events.length = 0;
      await queue.flush(); // t1-new flushes; t2 stays held!

      const syncedT1Event = events.find(
        (e): e is Extract<SyncEvent, { kind: 'sync-state' }> =>
          e.kind === 'sync-state' && e.threadId === 't1-new',
      );
      expect(syncedT1Event).toMatchObject({
        kind: 'sync-state',
        threadId: 't1-new',
        state: 'synced',
        pendingCount: 4, // 1 remaining in queue (t2) + 3 unqueued startup turns
      });

      expect(queue.removeThread('t2')).toBe(1);
      expect(queue.pendingCount()).toBe(0);
      queue.dispose();
    });

    it('routes appendMessages SyncApiError(404) through all 4 onMissingConversation outcomes (migrated, deferred, retry, drop)', async () => {
      // 1. 'migrated': migrates old -> new and flushes under newId immediately
      let migratedQueue!: SyncQueue;
      const calls1: string[] = [];
      migratedQueue = new SyncQueue(
        customDeps(
          fakeClient(async (threadId) => {
            calls1.push(threadId);
            if (threadId === 'old-404') throw new SyncApiError(404, 'Not found');
            return { ids: ['s-u', 's-a'] };
          }),
          {
            onMissingConversation: async (threadId) => {
              migratedQueue.migrateThread(threadId, 'new-200');
              return 'migrated';
            },
          },
        ),
      );
      migratedQueue.enqueue(turn('old-404', 1));
      await migratedQueue.flush();
      expect(calls1).toEqual(['old-404', 'new-200']);
      expect(migratedQueue.pendingCount()).toBe(0);
      migratedQueue.dispose();

      // 2. 'deferred': skips busy thread without incrementing attempts or head-of-line blocking sibling t2
      const calls2: string[] = [];
      const deferredQueue = new SyncQueue(
        customDeps(
          fakeClient(async (threadId) => {
            calls2.push(threadId);
            if (threadId === 'busy-404') throw new SyncApiError(404, 'Not found');
            return { ids: ['s2-u', 's2-a'] };
          }),
          {
            onMissingConversation: async () => 'deferred',
          },
        ),
      );
      deferredQueue.enqueue(turn('busy-404', 1));
      deferredQueue.enqueue(turn('healthy-2', 2));
      await deferredQueue.flush();
      expect(calls2).toContain('healthy-2');
      expect(deferredQueue.pendingCount('healthy-2')).toBe(0);
      expect(deferredQueue.getQueuedTurns('busy-404')[0].attempts).toBe(0);
      deferredQueue.dispose();

      // 3. 'retry': increments attempts, emits error WITHOUT dropped: true, keeps turn queued
      events = [];
      const retryQueue = new SyncQueue(
        customDeps(
          fakeClient(async () => {
            throw new SyncApiError(404, 'Not found');
          }),
          {
            onMissingConversation: async () => 'retry',
            setTimeoutFn: noopTimeout,
          },
        ),
      );
      retryQueue.enqueue(turn('retry-404', 1));
      await retryQueue.flush();
      expect(retryQueue.getQueuedTurns('retry-404')[0].attempts).toBe(1);
      const retryErr = events.find(
        (e): e is Extract<SyncEvent, { kind: 'sync-state' }> => e.kind === 'sync-state' && e.state === 'error',
      );
      expect(retryErr?.dropped).toBeUndefined();
      retryQueue.dispose();

      // 4. 'drop': drops turn, invokes onTurnDropped, emits dropped: true
      events = [];
      const droppedCalls: string[][] = [];
      const dropQueue = new SyncQueue(
        customDeps(
          fakeClient(async () => {
            throw new SyncApiError(404, 'Not found');
          }),
          {
            onMissingConversation: async () => 'drop',
            onTurnDropped: (t) => droppedCalls.push(t.localIds),
          },
        ),
      );
      dropQueue.enqueue(turn('empty-404', 1));
      await dropQueue.flush();
      expect(dropQueue.pendingCount()).toBe(0);
      expect(droppedCalls).toEqual([['u1', 'a1']]);
      expect(
        events.some((e) => e.kind === 'sync-state' && e.state === 'error' && e.dropped === true),
      ).toBe(true);
      dropQueue.dispose();
    });

    it('enforces error neighbor matrix: 401 & 502("404") backoff without dropping; 400/413/422 & 500-cap emit dropped: true and call onTurnDropped', async () => {
      // 1. 401 -> auth backoff, NOT dropped
      events = [];
      let missingCalled = false;
      const droppedIds: string[][] = [];
      const authQueue = new SyncQueue(
        customDeps(
          fakeClient(async () => {
            throw new SyncApiError(401, 'Yvoke Backend: Unauthorized');
          }),
          {
            onMissingConversation: async () => {
              missingCalled = true;
              return 'migrated';
            },
            onTurnDropped: (t) => droppedIds.push(t.localIds),
            setTimeoutFn: noopTimeout,
          },
        ),
      );
      authQueue.enqueue(turn('t-401', 1));
      await authQueue.flush();
      expect(authQueue.pendingCount()).toBe(1);
      expect(missingCalled).toBe(false);
      expect(droppedIds).toHaveLength(0);
      expect(events.some((e) => e.kind === 'sync-state' && e.dropped === true)).toBe(false);
      authQueue.dispose();

      // 2. 502 with "404" in prose -> transient 5xx backoff, NEVER calls onMissingConversation or drops
      events = [];
      const proxyQueue = new SyncQueue(
        customDeps(
          fakeClient(async () => {
            throw new SyncApiError(502, 'Yvoke Backend: upstream 404 not found');
          }),
          {
            onMissingConversation: async () => {
              missingCalled = true;
              return 'migrated';
            },
            onTurnDropped: (t) => droppedIds.push(t.localIds),
            setTimeoutFn: noopTimeout,
          },
        ),
      );
      proxyQueue.enqueue(turn('t-502', 1));
      await proxyQueue.flush();
      expect(proxyQueue.pendingCount()).toBe(1);
      expect(missingCalled).toBe(false);
      expect(droppedIds).toHaveLength(0);
      expect(events.some((e) => e.kind === 'sync-state' && e.dropped === true)).toBe(false);
      proxyQueue.dispose();

      // 3. 400 / 413 / 422 -> dropped: true + onTurnDropped
      for (const status of [400, 413, 422]) {
        events = [];
        const localDropped: string[][] = [];
        const q = new SyncQueue(
          customDeps(
            fakeClient(async () => {
              throw new SyncApiError(status, `Yvoke Backend: rejected (${status})`);
            }),
            { onTurnDropped: (t) => localDropped.push(t.localIds) },
          ),
        );
        q.enqueue(turn(`t-${status}`, 1));
        await q.flush();
        expect(q.pendingCount()).toBe(0);
        expect(localDropped).toEqual([['u1', 'a1']]);
        expect(events.some((e) => e.kind === 'sync-state' && e.state === 'error' && e.dropped === true)).toBe(true);
        q.dispose();
      }

      // 4. MAX_QUEUE_LENGTH (500) overflow -> dropped: true + onTurnDropped
      events = [];
      const capDropped: string[][] = [];
      const capQueue = new SyncQueue(
        customDeps(fakeClient(() => new Promise<{ ids: string[] }>(() => {})), {
          onTurnDropped: (t) => capDropped.push(t.localIds),
        }),
      );
      for (let n = 0; n <= 500; n++) {
        capQueue.enqueue(turn('t-cap', n));
      }
      expect(capQueue.pendingCount()).toBe(500);
      expect(capDropped).toHaveLength(1);
      expect(
        events.some(
          (e) => e.kind === 'sync-state' && e.state === 'error' && e.dropped === true && /backlog exceeded/.test(e.detail ?? ''),
        ),
      ).toBe(true);
      capQueue.dispose();
    });

    it('quarantines corrupt or wrong-shape sync-queue.json files to .corrupt without throwing and accepts [] cleanly', () => {
      const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncq-corrupt-'));
      try {
        const qFile = path.join(qDir, 'sync-queue.json');

        // Valid empty array [] must NOT create .corrupt
        fs.writeFileSync(qFile, '[]');
        const cleanQ = new SyncQueue({ ...deps(fakeClient(async () => ({ ids: [] }))), file: qFile });
        expect(cleanQ.queuedThreadIds()).toEqual([]);
        expect(fs.existsSync(qFile + '.corrupt')).toBe(false);
        cleanQ.dispose();

        // Corrupt and non-array / all-malformed-item payloads must quarantine to .corrupt and start empty
        for (const badPayload of ['null', '{}', '"str"', '123', '[null, {"bad": true}]', '{corrupt']) {
          fs.rmSync(qFile + '.corrupt', { force: true });
          fs.writeFileSync(qFile, badPayload);
          const recoveredQ = new SyncQueue({ ...deps(fakeClient(async () => ({ ids: [] }))), file: qFile });
          expect(recoveredQ.queuedThreadIds()).toEqual([]);
          expect(recoveredQ.pendingCount()).toBe(0);
          expect(fs.existsSync(qFile + '.corrupt')).toBe(true);
          recoveredQ.dispose();
        }

        // Mixed array containing valid QueuedTurns alongside malformed entries salvages valid turns AND writes .corrupt backup copy
        fs.rmSync(qFile + '.corrupt', { force: true });
        const mixedPayload = JSON.stringify([
          {
            threadId: 'salvaged-1',
            localIds: ['u1', 'a1'],
            messages: [
              { role: 'user', content: 'q1' },
              { role: 'assistant', content: 'a1' },
            ],
            enqueuedAt: '2026-06-10T10:00:00Z',
            attempts: 0,
          },
          null,
          { bad: true },
          {
            threadId: 'salvaged-2',
            localIds: ['u2'],
            messages: [{ role: 'user', content: 'q2' }],
            enqueuedAt: '2026-06-10T10:01:00Z',
            attempts: 1,
          },
        ]);
        fs.writeFileSync(qFile, mixedPayload);
        const salvagedQ = new SyncQueue({ ...deps(fakeClient(async () => ({ ids: [] }))), file: qFile });
        expect(salvagedQ.queuedThreadIds()).toEqual(['salvaged-1', 'salvaged-2']);
        expect(salvagedQ.pendingCount()).toBe(2);
        expect(fs.existsSync(qFile + '.corrupt')).toBe(true);
        salvagedQ.dispose();
      } finally {
        fs.rmSync(qDir, { recursive: true, force: true });
      }
    });

    it('guards doFlush and scheduleRetry after dispose() so in-flight 404/500 rejections never call hooks, emit events, or arm timers', async () => {
      for (const status of [404, 500]) {
        events = [];
        let rejectAppend!: (err: Error) => void;
        let missingHookCalls = 0;
        let scheduledTimers = 0;

        const q = new SyncQueue(
          customDeps(
            fakeClient(
              () =>
                new Promise<{ ids: string[] }>((_resolve, reject) => {
                  rejectAppend = reject;
                }),
            ),
            {
              onMissingConversation: async () => {
                missingHookCalls += 1;
                return 'migrated';
              },
              setTimeoutFn: (() => {
                scheduledTimers += 1;
                return 0;
              }) as unknown as typeof setTimeout,
            },
          ),
        );

        q.enqueue(turn(`t-dispose-${status}`, 1));
        // Clear initial 'pending' event emitted synchronously by enqueue()
        events = [];

        // Dispose while appendMessages is in flight, then reject with 404 or 500
        q.dispose();
        rejectAppend(new SyncApiError(status, `Yvoke Backend: failed (${status})`));
        await q.flush();

        expect(missingHookCalls).toBe(0);
        expect(scheduledTimers).toBe(0);
        expect(events).toEqual([]);
      }
    });

    it('unholdThread returns boolean status and drains newly unheld thread in the active flush tail loop', async () => {
      const flushed: string[] = [];
      let resolveT2!: (res: { ids: string[] }) => void;

      const q = new SyncQueue(
        customDeps(
          fakeClient((threadId) => {
            flushed.push(threadId);
            if (threadId === 't2') {
              return new Promise<{ ids: string[] }>((resolve) => {
                resolveT2 = resolve;
              });
            }
            return Promise.resolve({ ids: [`${threadId}-u`, `${threadId}-a`] });
          }),
        ),
      );

      expect(q.unholdThread('not-held')).toBe(false);
      q.holdThreads(['t1']);
      expect(q.isHeld('t1')).toBe(true);

      q.enqueue(turn('t1', 1));
      q.enqueue(turn('t2', 2));
      // Capture the already-running flushPromise BEFORE unholdThread (calling q.flush() later
      // would set flushRequested = true itself and mask a broken unholdThread!)
      const activeFlush = q.flush();

      // Wait until t2 is mid-flight inside the second doFlush iteration (where flushRequested was reset to false)
      await Promise.resolve();
      await Promise.resolve();
      expect(flushed).toEqual(['t2']);

      // Unholding t1 WITHOUT calling q.flush() again must set flushRequested = true so activeFlush drains t1!
      expect(q.unholdThread('t1')).toBe(true);
      expect(q.isHeld('t1')).toBe(false);
      expect(q.unholdThread('t1')).toBe(false);
      resolveT2({ ids: ['t2-u', 't2-a'] });

      await activeFlush;
      expect(flushed).toEqual(['t2', 't1']);
      expect(q.pendingCount()).toBe(0);
      q.dispose();
    });

    it('redacts echoed Bearer JWTs & Anthropic keys and caps 10 KB error bodies in emitted SyncEvent.detail', async () => {
      const secretJwt = 'eyJhbGciOiJIUzI1NiJ9.payload123.sig456';
      const secretKey = 'sk-ant-api03-secretKey999';
      const giantError = `POST failed: Authorization: Bearer ${secretJwt} key=${secretKey} ${'Z'.repeat(10_000)}`;

      const q = new SyncQueue(
        customDeps(
          fakeClient(async () => {
            throw new SyncApiError(500, giantError);
          }),
          { setTimeoutFn: noopTimeout },
        ),
      );

      q.enqueue(turn('t-sec', 1));
      await q.flush();

      const errEvt = events.find(
        (e): e is Extract<SyncEvent, { kind: 'sync-state' }> => e.kind === 'sync-state' && e.state === 'error',
      );
      expect(errEvt).toBeDefined();
      expect(errEvt?.detail).not.toContain(secretJwt);
      expect(errEvt?.detail).not.toContain('secretKey999');
      expect(errEvt?.detail).toContain('Bearer [REDACTED]');
      expect(errEvt?.detail).toContain('sk-ant-[REDACTED]');
      expect((errEvt?.detail ?? '').length).toBeLessThanOrEqual(305);
      q.dispose();
    });

    it('reconcileThreadTurns deduplicates turns overlapping this.flushing on 200 OK so an in-flight turn is uploaded once', async () => {
      const uploadedBatches: string[][] = [];
      let resolveInFlight!: (res: { ids: string[] }) => void;

      const q = new SyncQueue(
        customDeps(
          fakeClient((_threadId, messages) => {
            const batch = (messages as Array<{ content: string }>).map((m) => m.content);
            uploadedBatches.push(batch);
            if (uploadedBatches.length === 1) {
              return new Promise<{ ids: string[] }>((res) => {
                resolveInFlight = res;
              });
            }
            return Promise.resolve({ ids: ['s-u2', 's-a2'] });
          }),
        ),
      );

      // Enqueue turn 1; it immediately starts flushing
      q.enqueue(turn('t1', 1));
      await Promise.resolve();
      expect(uploadedBatches).toEqual([['q1', 'a1']]);

      // Reconcile on 200 OK while turn 1 is mid-flight, passing [turn 1, turn 2] in turnsToQueue
      const replacement1: QueuedTurn = {
        ...turn('t1', 1),
        enqueuedAt: '2026-06-10T10:00:00Z',
        attempts: 0,
      };
      const replacement2: QueuedTurn = {
        ...turn('t1', 2),
        enqueuedAt: '2026-06-10T10:01:00Z',
        attempts: 0,
      };
      q.reconcileThreadTurns('t1', [replacement1, replacement2], new Set(['u1', 'a1', 'u2', 'a2']));

      resolveInFlight({ ids: ['s-u1', 's-a1'] });
      await q.flush();

      // Turn 1 uploaded ONCE (not duplicated), followed by Turn 2!
      expect(uploadedBatches).toEqual([
        ['q1', 'a1'],
        ['q2', 'a2'],
      ]);
      expect(q.pendingCount()).toBe(0);
      q.dispose();
    });

    it('reconcileThreadTurns with resetAttempts: true (404 recreation) supersedes in-flight this.flushing (turn3) so flush uploads [turn1, turn2, turn3] in strict chronological order', async () => {
      const uploadedCalls: Array<{ remoteId: string; contents: string[] }> = [];
      let currentRemoteId = 'r0-dead';
      let rejectStaleTurn3!: (err: Error) => void;

      const q = new SyncQueue(
        customDeps(
          fakeClient((_threadId, messages) => {
            const contents = (messages as Array<{ content: string }>).map((m) => m.content);
            const targetRemote = currentRemoteId;
            uploadedCalls.push({ remoteId: targetRemote, contents });
            if (targetRemote === 'r0-dead') {
              return new Promise<{ ids: string[] }>((_res, rej) => {
                rejectStaleTurn3 = rej;
              });
            }
            return Promise.resolve({ ids: [`${targetRemote}-u`, `${targetRemote}-a`] });
          }),
          {
            onMissingConversation: async () => {
              throw new Error('onMissingConversation must NOT fire for superseded stale turn3');
            },
          },
        ),
      );

      // Live turn3 starts flushing against dead r0 while startup recovery is recreating r0 -> r1
      q.enqueue(turn('t1', 3));
      await Promise.resolve();
      expect(uploadedCalls).toEqual([{ remoteId: 'r0-dead', contents: ['q3', 'a3'] }]);

      // Startup 404 recreation creates r1 and calls reconcileThreadTurns with full [turn1, turn2, turn3] + resetAttempts: true
      currentRemoteId = 'r1-recreated';
      const recreatedTurns: QueuedTurn[] = [1, 2, 3].map((n) => ({
        ...turn('t1', n),
        enqueuedAt: `2026-06-10T10:0${n}:00Z`,
        attempts: 2,
      }));
      q.reconcileThreadTurns(
        't1',
        recreatedTurns,
        new Set(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']),
        { resetAttempts: true },
      );

      // Now stale turn3 against r0-dead rejects with 404; doFlush must ignore the superseded turn and upload [turn1, turn2, turn3] to r1!
      rejectStaleTurn3(new SyncApiError(404, 'Conversation r0-dead not found'));
      await q.flush();

      expect(uploadedCalls).toEqual([
        { remoteId: 'r0-dead', contents: ['q3', 'a3'] },
        { remoteId: 'r1-recreated', contents: ['q1', 'a1'] },
        { remoteId: 'r1-recreated', contents: ['q2', 'a2'] },
        { remoteId: 'r1-recreated', contents: ['q3', 'a3'] },
      ]);
      expect(q.pendingCount()).toBe(0);
      q.dispose();
    });

    it('reconcileThreadTurns preserves postSnapshot turns enqueued mid-reconciliation AFTER historical turnsToQueue even when snapshot queue was empty, and resets postSnapshot attempts on resetAttempts: true', async () => {
      const uploadedBatches: string[][] = [];
      const q = new SyncQueue(
        customDeps(
          fakeClient(async (_threadId, messages) => {
            uploadedBatches.push((messages as Array<{ content: string }>).map((m) => m.content));
            return { ids: ['s-u', 's-a'] };
          }),
        ),
      );

      // Hold t1 as at startup; at snapshot time t1 has 0 queued turns, only historical turn1 in .jsonl
      q.holdThreads(['t1']);
      const inspectedLocalIds = new Set(['u1', 'a1']);

      // Mid-reconciliation (while awaiting getAllMessages / createConversation), user finishes live turn2!
      q.enqueue(turn('t1', 2));
      // Simulate non-zero attempts on postSnapshot turn before resetAttempts: true
      (q as unknown as { queue: QueuedTurn[] }).queue[0].attempts = 3;

      const historicalTurn1: QueuedTurn = {
        ...turn('t1', 1),
        enqueuedAt: '2026-06-10T10:00:00Z',
        attempts: 1,
      };

      // 1. Without resetAttempts (200 OK): historicalTurn1 is placed BEFORE postSnapshot turn2, preserving attempts
      q.reconcileThreadTurns('t1', [historicalTurn1], inspectedLocalIds);
      expect(q.getQueuedTurns('t1').map((t) => t.localIds)).toEqual([
        ['u1', 'a1'],
        ['u2', 'a2'],
      ]);
      expect(q.getQueuedTurns('t1')[1].attempts).toBe(3);

      // 2. With resetAttempts: true (404 recreation): resets attempts = 0 on BOTH replacement and postSnapshot turns
      q.reconcileThreadTurns('t1', [historicalTurn1], inspectedLocalIds, { resetAttempts: true });
      expect(q.getQueuedTurns('t1').map((t) => ({ ids: t.localIds, attempts: t.attempts }))).toEqual([
        { ids: ['u1', 'a1'], attempts: 0 },
        { ids: ['u2', 'a2'], attempts: 0 },
      ]);

      q.unholdThread('t1');
      await q.flush();
      expect(uploadedBatches).toEqual([
        ['q1', 'a1'],
        ['q2', 'a2'],
      ]);
      q.dispose();
    });

    it('routes SyncApiError(404) through onMissingConversation outcome === recreated without dropping or incrementing attempts', async () => {
      let currentRemote = 'r0';
      const calls: Array<{ remote: string; localThreadId: string }> = [];
      let q!: SyncQueue;

      q = new SyncQueue(
        customDeps(
          fakeClient(async (threadId) => {
            calls.push({ remote: currentRemote, localThreadId: threadId });
            if (currentRemote === 'r0') {
              throw new SyncApiError(404, 'Not found');
            }
            return { ids: ['s-u1', 's-a1'] };
          }),
          {
            onMissingConversation: async (threadId) => {
              currentRemote = 'r1';
              q.reconcileThreadTurns(
                threadId,
                [{ ...turn(threadId, 1), enqueuedAt: '2026-06-10T10:00:00Z', attempts: 0 }],
                new Set(['u1', 'a1']),
                { resetAttempts: true },
              );
              return 'recreated';
            },
          },
        ),
      );

      q.enqueue(turn('local-fixed-id', 1));
      await q.flush();

      expect(calls).toEqual([
        { remote: 'r0', localThreadId: 'local-fixed-id' },
        { remote: 'r1', localThreadId: 'local-fixed-id' },
      ]);
      expect(q.pendingCount()).toBe(0);
      q.dispose();
    });

    it('Gate 3 High #2: reconcileThreadTurns with resetAttempts: true supersedes postSnapshot this.flushing (turn3 absent from inspectedLocalIds) so r1 receives [turn1, turn2, turn3] in chronological order', async () => {
      for (const staleOutcome of ['reject', 'resolve'] as const) {
        const uploadedCalls: Array<{ remoteId: string; contents: string[] }> = [];
        let currentRemoteId = 'r0-dead';
        let settleStaleTurn3!: () => void;

        const q = new SyncQueue(
          customDeps(
            fakeClient((_threadId, messages) => {
              const contents = (messages as Array<{ content: string }>).map((m) => m.content);
              const targetRemote = currentRemoteId;
              uploadedCalls.push({ remoteId: targetRemote, contents });
              if (targetRemote === 'r0-dead') {
                return new Promise<{ ids: string[] }>((res, rej) => {
                  settleStaleTurn3 = () => {
                    if (staleOutcome === 'reject') {
                      rej(new SyncApiError(404, 'Conversation r0-dead not found'));
                    } else {
                      res({ ids: ['stale-u3', 'stale-a3'] });
                    }
                  };
                });
              }
              return Promise.resolve({ ids: [`${targetRemote}-u`, `${targetRemote}-a`] });
            }),
            {
              onMissingConversation: async () => {
                throw new Error('onMissingConversation must NOT fire for superseded postSnapshot turn3');
              },
            },
          ),
        );

        // Enqueue post-snapshot turn3 (['u3', 'a3'], NOT in inspectedLocalIds!) which immediately enters this.flushing against r0-dead
        q.enqueue(turn('t1', 3));
        await Promise.resolve();
        expect(uploadedCalls).toEqual([{ remoteId: 'r0-dead', contents: ['q3', 'a3'] }]);

        // Reconcile on 404 recreation with historical [turn1, turn2] and inspectedLocalIds = {u1, a1, u2, a2} (turn3 absent!)
        currentRemoteId = 'r1-recreated';
        const historicalTurns: QueuedTurn[] = [1, 2].map((n) => ({
          ...turn('t1', n),
          enqueuedAt: `2026-06-10T10:0${n}:00Z`,
          attempts: 2,
        }));
        q.reconcileThreadTurns(
          't1',
          historicalTurns,
          new Set(['u1', 'a1', 'u2', 'a2']),
          { resetAttempts: true },
        );

        settleStaleTurn3();
        await q.flush();

        // r1-recreated MUST receive [turn1, turn2, turn3] in chronological order — never [turn3, turn1, turn2] or dropping turn3!
        expect(uploadedCalls).toEqual([
          { remoteId: 'r0-dead', contents: ['q3', 'a3'] },
          { remoteId: 'r1-recreated', contents: ['q1', 'a1'] },
          { remoteId: 'r1-recreated', contents: ['q2', 'a2'] },
          { remoteId: 'r1-recreated', contents: ['q3', 'a3'] },
        ]);
        expect(q.pendingCount()).toBe(0);
        q.dispose();
      }
    });
  });
});

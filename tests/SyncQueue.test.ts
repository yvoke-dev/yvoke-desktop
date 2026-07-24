import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyncEvent } from '../src/shared/types';
import { SyncApiError, type SyncClient } from '../src/main/sync/SyncClient';
import { SyncQueue } from '../src/main/sync/SyncQueue';

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
});

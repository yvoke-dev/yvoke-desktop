import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThreadStore } from '../src/main/store/ThreadStore';
import type { ChatMessage, ThreadMeta } from '../src/shared/types';

function meta(id: string): ThreadMeta {
  return {
    id,
    title: 'New Conversation',
    model: 'sonnet',
    thinkingLevel: 'medium',
    createdAt: '2026-06-10T10:00:00Z',
    updatedAt: '2026-06-10T10:00:00Z',
    totals: ThreadStore.emptyTotals(),
    syncState: 'synced',
  };
}

function message(localId: string, role: 'user' | 'assistant', usage?: ChatMessage['usage']): ChatMessage {
  return { localId, role, content: `${role}-${localId}`, createdAt: new Date().toISOString(), usage };
}

describe('ThreadStore', () => {
  let dir: string;
  let store: ThreadStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-'));
    store = new ThreadStore(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists the index across instances', () => {
    store.upsert(meta('t1'));
    store.setSessionId('t1', 'session-abc');
    const reopened = new ThreadStore(dir);
    expect(reopened.get('t1')?.sessionId).toBe('session-abc');
  });

  it('appends messages and accumulates usage totals', async () => {
    store.upsert(meta('t1'));
    await store.appendMessages('t1', [
      message('u1', 'user'),
      message('a1', 'assistant', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 }),
    ]);
    await store.appendMessages('t1', [
      message('u2', 'user'),
      message('a2', 'assistant', { inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]);
    expect(await store.readMessages('t1')).toHaveLength(4);
    expect(store.get('t1')?.totals).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  it('applies server ids onto logged messages', async () => {
    store.upsert(meta('t1'));
    await store.appendMessages('t1', [message('u1', 'user'), message('a1', 'assistant')]);
    await store.applyServerIds('t1', { u1: 'srv-u', a1: 'srv-a' });
    const messages = await store.readMessages('t1');
    expect(messages[0].serverId).toBe('srv-u');
    expect(messages[1].serverId).toBe('srv-a');
  });

  it('serializes a concurrent read-modify-write and append so no turn is lost', async () => {
    store.upsert(meta('t1'));
    await store.appendMessages('t1', [message('u1', 'user'), message('a1', 'assistant')]);
    // applyServerIds does read→(await)→overwrite; fire it concurrently with a second-turn append
    // WITHOUT awaiting between them. Without per-thread serialization the append would be clobbered
    // by applyServerIds' stale snapshot and turn 2 would vanish.
    const rmw = store.applyServerIds('t1', { u1: 'srv-u1', a1: 'srv-a1' });
    const append = store.appendMessages('t1', [message('u2', 'user'), message('a2', 'assistant')]);
    await Promise.all([rmw, append]);
    const messages = await store.readMessages('t1');
    expect(messages.map((m) => m.localId)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(messages[0].serverId).toBe('srv-u1');
  });

  it('stores feedback on a message', async () => {
    store.upsert(meta('t1'));
    await store.appendMessages('t1', [message('a1', 'assistant')]);
    await store.setFeedback('t1', 'a1', -1, 'wrong table');
    expect((await store.readMessages('t1'))[0].feedback).toEqual({ rating: -1, comment: 'wrong table' });
  });

  it('delete removes index entry and message log', async () => {
    store.upsert(meta('t1'));
    await store.appendMessages('t1', [message('u1', 'user')]);
    store.delete('t1');
    expect(store.get('t1')).toBeUndefined();
    expect(await store.readMessages('t1')).toEqual([]);
  });

  it('lists threads by updatedAt descending', () => {
    store.upsert({ ...meta('old'), updatedAt: '2026-06-01T00:00:00Z' });
    store.upsert({ ...meta('new'), updatedAt: '2026-06-10T00:00:00Z' });
    expect(store.list().map((t) => t.id)).toEqual(['new', 'old']);
  });

  it('readMessages skips a single malformed line and returns the rest', async () => {
    store.upsert(meta('t1'));
    const good1 = message('u1', 'user');
    const good2 = message('a1', 'assistant');
    // Hand-craft a log with a corrupt middle line and a truncated trailing line.
    const jsonl =
      JSON.stringify(good1) + '\n' + '{ this is not valid json' + '\n' + JSON.stringify(good2) + '\n' + '{"localId":"partial';
    fs.writeFileSync(path.join(dir, 't1.jsonl'), jsonl);
    const messages = await store.readMessages('t1');
    expect(messages.map((m) => m.localId)).toEqual(['u1', 'a1']);
  });

  it('replaceMessages writes atomically and round-trips without leaving a temp file', async () => {
    store.upsert(meta('t1'));
    const msgs = [message('u1', 'user'), message('a1', 'assistant')];
    await store.replaceMessages('t1', msgs);
    expect((await store.readMessages('t1')).map((m) => m.localId)).toEqual(['u1', 'a1']);
    // No leftover temp file from the write-then-rename.
    expect(fs.existsSync(path.join(dir, 't1.jsonl.tmp'))).toBe(false);
  });

  it('preserves a corrupt index as a .corrupt backup instead of destroying it', () => {
    const indexFile = path.join(dir, 'index.json');
    fs.writeFileSync(indexFile, '{ not valid json');
    // Re-open: the corrupt index should be backed up, not silently overwritten.
    const reopened = new ThreadStore(dir);
    expect(fs.existsSync(indexFile + '.corrupt')).toBe(true);
    expect(fs.readFileSync(indexFile + '.corrupt', 'utf8')).toBe('{ not valid json');
    // The store still works from an empty index and can persist fresh data.
    reopened.upsert(meta('t1'));
    expect(new ThreadStore(dir).get('t1')?.id).toBe('t1');
  });

  it('rejects path traversal and invalid characters in threadId', async () => {
    const invalidIds = [
      '../malicious',
      'sub/folder',
      '..\\backslash',
      'test.jsonl',
      'with space',
      'special$chars'
    ];
    for (const invalidId of invalidIds) {
      expect(() => store.get(invalidId)).toThrow(/Invalid threadId/);
      expect(() => store.delete(invalidId)).toThrow(/Invalid threadId/);
      await expect(store.appendMessages(invalidId, [message('u1', 'user')])).rejects.toThrow(/Invalid threadId/);
    }
  });
});

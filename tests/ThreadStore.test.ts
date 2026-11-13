import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidStoredMessage, ThreadStore, type StoredChatMessage } from '../src/main/store/ThreadStore';
import { isThreadStarted, type ChatMessage, type ImageAttachment, type ThreadMeta } from '../src/shared/types';

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

  afterEach(async () => {
    await store.drain();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists the index across instances', () => {
    store.upsert(meta('t1'));
    store.setSessionId('t1', 'session-abc');
    const reopened = new ThreadStore(dir);
    expect(reopened.get('t1')?.sessionId).toBe('session-abc');
  });

  it('Test 1.7 & 1.7b: tracks sessionProfile and asserts sessionId and sessionProfile keys are completely omitted when cleared via patch (in-memory and reloaded from disk)', () => {
    store.upsert(meta('t1'));
    store.setSessionId('t1', 'session-abc', 'OIM');
    expect(store.get('t1')?.sessionId).toBe('session-abc');
    expect(store.get('t1')?.sessionProfile).toBe('OIM');

    store.patch('t1', { sessionId: undefined, sessionProfile: undefined });
    const inMemory = store.get('t1')!;
    expect(inMemory.sessionId).toBeUndefined();
    expect(inMemory.sessionProfile).toBeUndefined();
    expect('sessionId' in inMemory).toBe(false);
    expect('sessionProfile' in inMemory).toBe(false);

    const reloaded = new ThreadStore(dir).get('t1')!;
    expect(reloaded.sessionId).toBeUndefined();
    expect(reloaded.sessionProfile).toBeUndefined();
    expect('sessionId' in reloaded).toBe(false);
    expect('sessionProfile' in reloaded).toBe(false);
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

  describe('drain', () => {
    // Note: These tests use `(store as any).runExclusive` to inject controllable pending/deferred
    // promises directly into the private opChain, isolating drainage timing from disk I/O latency.
    it('waits for in-flight operations across all threads to settle before resolving', async () => {
      store.upsert(meta('t1'));
      store.upsert(meta('t2'));

      let t1Done = false;
      let t2Done = false;
      let resolveT1!: () => void;
      let resolveT2!: () => void;
      const p1 = new Promise<void>((res) => {
        resolveT1 = res;
      });
      const p2 = new Promise<void>((res) => {
        resolveT2 = res;
      });

      void (store as any).runExclusive('t1', async () => {
        await p1;
        t1Done = true;
      });
      void (store as any).runExclusive('t2', async () => {
        await p2;
        t2Done = true;
      });

      let drained = false;
      const drainPromise = store.drain().then(() => {
        drained = true;
      });

      await Promise.resolve();
      expect(drained).toBe(false);
      expect(t1Done).toBe(false);
      expect(t2Done).toBe(false);

      resolveT1();
      await Promise.resolve();
      expect(drained).toBe(false);

      resolveT2();
      await drainPromise;
      expect(drained).toBe(true);
      expect(t1Done).toBe(true);
      expect(t2Done).toBe(true);
    });

    it('waits only for the targeted thread when threadId is specified', async () => {
      store.upsert(meta('t1'));
      store.upsert(meta('t2'));

      let t1Done = false;
      let t2Done = false;
      let resolveT1!: () => void;
      let resolveT2!: () => void;
      const p1 = new Promise<void>((res) => {
        resolveT1 = res;
      });
      const p2 = new Promise<void>((res) => {
        resolveT2 = res;
      });

      void (store as any).runExclusive('t1', async () => {
        await p1;
        t1Done = true;
      });
      void (store as any).runExclusive('t2', async () => {
        await p2;
        t2Done = true;
      });

      let t1Drained = false;
      const drainT1 = store.drain('t1').then(() => {
        t1Drained = true;
      });

      await Promise.resolve();
      expect(t1Drained).toBe(false);

      resolveT1();
      await drainT1;
      expect(t1Drained).toBe(true);
      expect(t1Done).toBe(true);
      expect(t2Done).toBe(false);

      resolveT2();
      await store.drain('t2');
      expect(t2Done).toBe(true);
    });

    it('validates threadId and rejects on invalid or path traversal input', async () => {
      await expect(store.drain('../bad/path')).rejects.toThrow(/Invalid threadId/);
      await expect(store.drain('')).rejects.toThrow(/Invalid threadId/);
      await expect(store.drain('bad/slash')).rejects.toThrow(/Invalid threadId/);
    });

    it('settles safely without hanging or rejecting if an in-flight operation throws', async () => {
      store.upsert(meta('t1'));
      let threw = false;
      const failingOp = (store as any).runExclusive('t1', async () => {
        threw = true;
        throw new Error('boom');
      });
      await failingOp.catch(() => {});
      expect(threw).toBe(true);

      await expect(store.drain('t1')).resolves.toBeUndefined();
      await expect(store.drain()).resolves.toBeUndefined();
    });
  });

  describe('initialPlaybook persistence hardening', () => {
    it('persists initialPlaybook in index across instances (happy path)', () => {
      store.upsert(meta('t1'));
      store.patch('t1', { initialPlaybook: 'oim-getting-started' });
      expect(store.get('t1')?.initialPlaybook).toBe('oim-getting-started');

      const reopened = new ThreadStore(dir);
      expect(reopened.get('t1')?.initialPlaybook).toBe('oim-getting-started');
    });

    it('Negative 1.1.1: disk key omission when initialPlaybook is undefined or cleared', () => {
      store.upsert(meta('t1'));
      const inMemoryInit = store.get('t1')!;
      expect('initialPlaybook' in inMemoryInit).toBe(false);

      const rawInitial = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      expect('initialPlaybook' in rawInitial.t1).toBe(false);

      store.patch('t1', { initialPlaybook: 'oim-schema' });
      expect(store.get('t1')?.initialPlaybook).toBe('oim-schema');

      store.patch('t1', { initialPlaybook: undefined });
      const inMemoryCleared = store.get('t1')!;
      expect(inMemoryCleared.initialPlaybook).toBeUndefined();
      expect('initialPlaybook' in inMemoryCleared).toBe(false);

      const reopened = new ThreadStore(dir).get('t1')!;
      expect(reopened.initialPlaybook).toBeUndefined();
      expect('initialPlaybook' in reopened).toBe(false);

      const rawCleared = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      expect('initialPlaybook' in rawCleared.t1).toBe(false);
    });

    it('Negative 1.1.2: index corruption resilience preserves corrupt index and recovers with initialPlaybook', () => {
      const indexFile = path.join(dir, 'index.json');
      fs.writeFileSync(indexFile, '{"t1": {"id": "t1", "initialPlaybook": "partially corrupted json');

      const reopened = new ThreadStore(dir);
      expect(fs.existsSync(indexFile + '.corrupt')).toBe(true);
      expect(reopened.list()).toEqual([]);

      reopened.upsert({ ...meta('t2'), initialPlaybook: 'oim-getting-started' });
      expect(reopened.get('t2')?.initialPlaybook).toBe('oim-getting-started');
      const diskReloaded = new ThreadStore(dir).get('t2')!;
      expect(diskReloaded.initialPlaybook).toBe('oim-getting-started');
    });

    it('Negative 1.1.3: enforces orchestrator mutual exclusivity (initialPlaybook omitted when orchestratorProfile set)', () => {
      // Case 1: upsert with both orchestratorProfile and initialPlaybook omits initialPlaybook
      store.upsert({
        ...meta('t1'),
        orchestratorProfile: 'OIM',
        initialPlaybook: 'oim-schema',
      });
      const t1 = store.get('t1')!;
      expect(t1.orchestratorProfile).toBe('OIM');
      expect('initialPlaybook' in t1).toBe(false);
      expect(t1.initialPlaybook).toBeUndefined();

      const diskT1 = new ThreadStore(dir).get('t1')!;
      expect('initialPlaybook' in diskT1).toBe(false);

      // Case 2: patch setting orchestratorProfile on a thread with initialPlaybook clears initialPlaybook
      store.upsert(meta('t2'));
      store.patch('t2', { initialPlaybook: 'oim-getting-started' });
      expect(store.get('t2')?.initialPlaybook).toBe('oim-getting-started');

      store.patch('t2', { orchestratorProfile: 'OIM' });
      const t2 = store.get('t2')!;
      expect(t2.orchestratorProfile).toBe('OIM');
      expect('initialPlaybook' in t2).toBe(false);
      expect(t2.initialPlaybook).toBeUndefined();

      const diskT2 = new ThreadStore(dir).get('t2')!;
      expect('initialPlaybook' in diskT2).toBe(false);

      // Case 3: patch attempting to set initialPlaybook on orchestrator thread is ignored/omitted
      store.patch('t2', { initialPlaybook: 'oim-schema' });
      const t2StillOrch = store.get('t2')!;
      expect(t2StillOrch.orchestratorProfile).toBe('OIM');
      expect('initialPlaybook' in t2StillOrch).toBe(false);
      expect(t2StillOrch.initialPlaybook).toBeUndefined();
    });
  });

  describe('isThreadStarted helper', () => {
    it('returns false for clean unstarted thread', () => {
      const cleanMeta: ThreadMeta = {
        id: 't1',
        title: 'New',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: '2026-06-10T10:00:00Z',
        updatedAt: '2026-06-10T10:00:00Z',
        totals: undefined as any,
        syncState: 'synced',
      };
      expect(isThreadStarted(cleanMeta)).toBe(false);
    });

    it('returns false when totals are all 0', () => {
      const t = {
        ...meta('t1'),
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheCreationTokens: 0 },
      };
      expect(isThreadStarted(t)).toBe(false);
    });

    it('Negative boundary: returns false when initialPlaybook or sessionId are empty strings', () => {
      const t = {
        ...meta('t1'),
        initialPlaybook: '',
        sessionId: '',
      };
      expect(isThreadStarted(t)).toBe(false);
    });

    it('returns true when hasStarted === true', () => {
      expect(isThreadStarted({ ...meta('t1'), hasStarted: true })).toBe(true);
    });

    it('returns true when initialPlaybook is a non-empty string', () => {
      expect(isThreadStarted({ ...meta('t1'), initialPlaybook: 'oim-query' })).toBe(true);
    });

    it('returns true when sessionId is a non-empty string', () => {
      expect(isThreadStarted({ ...meta('t1'), sessionId: 'session-123' })).toBe(true);
    });

    it('returns true when tokens are non-zero', () => {
      expect(isThreadStarted({ ...meta('t1'), totals: { ...ThreadStore.emptyTotals(), inputTokens: 1 } })).toBe(true);
      expect(isThreadStarted({ ...meta('t1'), totals: { ...ThreadStore.emptyTotals(), outputTokens: 1 } })).toBe(true);
      expect(isThreadStarted({ ...meta('t1'), totals: { ...ThreadStore.emptyTotals(), cacheReadTokens: 1 } })).toBe(true);
      expect(isThreadStarted({ ...meta('t1'), totals: { ...ThreadStore.emptyTotals(), cacheCreationTokens: 1 } })).toBe(true);
    });
  });

  describe('hasStarted persistence hardening', () => {
    it('persists hasStarted: true across patch and reload from disk', () => {
      store.upsert(meta('t1'));
      store.patch('t1', { hasStarted: true });
      expect(store.get('t1')?.hasStarted).toBe(true);

      const reopened = new ThreadStore(dir);
      expect(reopened.get('t1')?.hasStarted).toBe(true);
    });

    it('upsert preserves hasStarted: true across disk round-trips', () => {
      store.upsert({ ...meta('t1'), hasStarted: true });
      expect(store.get('t1')?.hasStarted).toBe(true);

      const reopened = new ThreadStore(dir);
      expect(reopened.get('t1')?.hasStarted).toBe(true);
    });

    it('Negative test: setting orchestratorProfile deletes initialPlaybook but preserves hasStarted: true', () => {
      store.upsert({ ...meta('t1'), initialPlaybook: 'oim-query', hasStarted: true });
      expect(store.get('t1')?.initialPlaybook).toBe('oim-query');
      expect(store.get('t1')?.hasStarted).toBe(true);

      store.patch('t1', { orchestratorProfile: 'OIM' });
      const patched = store.get('t1')!;
      expect(patched.orchestratorProfile).toBe('OIM');
      expect('initialPlaybook' in patched).toBe(false);
      expect(patched.initialPlaybook).toBeUndefined();
      expect(patched.hasStarted).toBe(true);

      const reloaded = new ThreadStore(dir).get('t1')!;
      expect(reloaded.orchestratorProfile).toBe('OIM');
      expect('initialPlaybook' in reloaded).toBe(false);
      expect(reloaded.hasStarted).toBe(true);
    });

    it('Disk hygiene negative test: patch with { hasStarted: undefined } completely deletes hasStarted key from store and serialized disk index', () => {
      store.upsert({ ...meta('t1'), hasStarted: true });
      expect(store.get('t1')?.hasStarted).toBe(true);

      store.patch('t1', { hasStarted: undefined });
      const inMemory = store.get('t1')!;
      expect(inMemory.hasStarted).toBeUndefined();
      expect('hasStarted' in inMemory).toBe(false);

      const reloaded = new ThreadStore(dir).get('t1')!;
      expect(reloaded.hasStarted).toBeUndefined();
      expect('hasStarted' in reloaded).toBe(false);

      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      expect('hasStarted' in raw.t1).toBe(false);
    });
  });

  describe('Wave 1: startup scan, migration, validation & corrupt-index hardening', () => {
    const sampleImage = (id = 'img-1'): ImageAttachment => ({
      id,
      mediaType: 'image/png',
      data: Buffer.from('fake-png-bytes').toString('base64'),
      name: 'diagram.png',
      size: 14,
      description: 'Architecture diagram',
    });

    it('listLogThreadIds enumerates valid <id>.jsonl files and returns [] when directory is missing', async () => {
      const missingStore = new ThreadStore(path.join(dir, 'does-not-exist-yet'));
      expect(await missingStore.listLogThreadIds()).toEqual([]);

      store.upsert(meta('t-alpha'));
      store.upsert(meta('t-beta'));
      await store.appendMessages('t-alpha', [message('u1', 'user')]);
      await store.appendMessages('t-beta', [message('u2', 'user')]);
      // Noise files/dirs that must be ignored
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');
      fs.writeFileSync(path.join(dir, 'bad name.jsonl'), '{}');
      fs.mkdirSync(path.join(dir, 'images', 't-alpha'), { recursive: true });

      const ids = await store.listLogThreadIds();
      expect(ids.sort()).toEqual(['t-alpha', 't-beta']);
    });

    it('readRawMessages skips image blob disk reads (zero-blob proof) and skips corrupt JSONL lines', async () => {
      store.upsert(meta('t1'));
      await store.appendMessages('t1', [
        { ...message('u1', 'user'), images: [sampleImage('img-1')] },
        message('a1', 'assistant'),
      ]);
      // Append corrupt, non-object, and incomplete-shape JSON lines
      fs.appendFileSync(
        path.join(dir, 't1.jsonl'),
        '{corrupt-line\nnull\n123\n{"bad":true}\n{"localId":"x","role":"system","content":"nope"}\n{"localId":"y","role":"user"}\n',
      );

      // Delete the underlying .png blob on disk to prove non-tautologically that readRawMessages
      // never touches threads/images/<id>/* whereas readMessages drops the missing image.
      const imgDir = path.join(dir, 'images', 't1');
      const files = fs.readdirSync(imgDir);
      expect(files).toHaveLength(1);
      fs.rmSync(path.join(imgDir, files[0]));

      const readFileSpy = vi.spyOn(fsp, 'readFile');
      try {
        const rawMsgs: StoredChatMessage[] = await store.readRawMessages('t1');
        expect(rawMsgs).toHaveLength(2);
        expect(rawMsgs[0].images).toHaveLength(1);
        expect(rawMsgs[0].images?.[0].file).toBe(files[0]);
        expect(rawMsgs[0].images?.[0].data).toBeUndefined();
        expect(rawMsgs[0].images?.[0].description).toBe('Architecture diagram');

        const imageReads = readFileSpy.mock.calls.filter(([p]) => String(p).includes(`${path.sep}images${path.sep}`));
        expect(imageReads).toHaveLength(0);
      } finally {
        readFileSpy.mockRestore();
      }

      // Contrast: readMessages attempts blob hydration and drops the missing blob
      const hydrated = await store.readMessages('t1');
      expect(hydrated).toHaveLength(2);
      expect(hydrated[0].images).toBeUndefined();
    });

    it('applyServerIds returns { hasUnsynced: true } when unsynced messages remain and { hasUnsynced: false } when all have serverId', async () => {
      store.upsert(meta('t1'));
      expect(await store.applyServerIds('t1', {})).toEqual({ hasUnsynced: false });

      await store.appendMessages('t1', [
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
      ]);

      const partial = await store.applyServerIds('t1', { u1: 'srv-u1', a1: 'srv-a1' });
      expect(partial).toEqual({ hasUnsynced: true });

      const complete = await store.applyServerIds('t1', { u2: 'srv-u2' });
      expect(complete).toEqual({ hasUnsynced: false });
    });

    it('migrateThread moves .jsonl and images/<oldId> -> <newId>, strips stale serverIds, preserves feedback + extraMessages, and updates index.json', async () => {
      store.upsert({ ...meta('old-id'), sessionId: 'sess-1', hasStarted: true });
      await store.appendMessages('old-id', [
        { ...message('u1', 'user'), images: [sampleImage('img-1')] },
        message('a1', 'assistant', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      ]);
      await store.applyServerIds('old-id', { u1: 'stale-srv-u1', a1: 'stale-srv-a1' });
      await store.setFeedback('old-id', 'a1', 1, 'helpful');

      const newThreadMeta: ThreadMeta = {
        ...meta('new-id'),
        sessionId: 'sess-1',
        hasStarted: true,
        syncState: 'pending',
      };
      const extra: StoredChatMessage[] = [
        { localId: 'a1', role: 'assistant', content: 'duplicate-ignored', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'u2', role: 'user', content: 'queue-only-question', createdAt: '2026-06-10T10:02:00Z', serverId: 'stale-u2' },
      ];

      await store.migrateThread('old-id', newThreadMeta, extra);

      expect(store.get('old-id')).toBeUndefined();
      expect(store.get('new-id')?.sessionId).toBe('sess-1');
      expect(fs.existsSync(path.join(dir, 'old-id.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'images', 'old-id'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'new-id.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'images', 'new-id'))).toBe(true);

      const rawMigrated = await store.readRawMessages('new-id');
      expect(rawMigrated.map((m) => m.localId)).toEqual(['u1', 'a1', 'u2']);
      expect(rawMigrated.every((m) => m.serverId === undefined)).toBe(true);
      expect(rawMigrated[0].images?.[0].file).toBeTruthy();
      expect(rawMigrated[1].feedback).toEqual({ rating: 1, comment: 'helpful' });

      const hydratedMigrated = await store.readMessages('new-id');
      expect(hydratedMigrated[0].images?.[0].data).toBe(Buffer.from('fake-png-bytes').toString('base64'));

      const reopened = new ThreadStore(dir);
      expect(reopened.get('old-id')).toBeUndefined();
      expect(reopened.get('new-id')?.id).toBe('new-id');
    });

    it('migrateThread succeeds when threads/images/<oldId> does not exist', async () => {
      store.upsert(meta('no-img-old'));
      await store.appendMessages('no-img-old', [message('u1', 'user')]);
      await store.migrateThread('no-img-old', meta('no-img-new'));

      expect(store.get('no-img-old')).toBeUndefined();
      expect((await store.readMessages('no-img-new')).map((m) => m.localId)).toEqual(['u1']);
    });

    it('migrateThread falls back to recursive copy + rm when rename throws EXDEV', async () => {
      store.upsert(meta('exdev-old'));
      await store.appendMessages('exdev-old', [{ ...message('u1', 'user'), images: [sampleImage('img-exdev')] }]);

      const origRename = fsp.rename.bind(fsp);
      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (String(oldPath).includes(`${path.sep}images${path.sep}`)) {
          throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        }
        return origRename(oldPath, newPath);
      });

      try {
        await store.migrateThread('exdev-old', meta('exdev-new'));
      } finally {
        renameSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(dir, 'images', 'exdev-old'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'images', 'exdev-new'))).toBe(true);
      const msgs = await store.readMessages('exdev-new');
      expect(msgs[0].images?.[0].data).toBe(Buffer.from('fake-png-bytes').toString('base64'));
    });

    it('migrateThread preserves <oldId>.jsonl, images/<oldId>, and index.json if <newId>.jsonl write fails', async () => {
      store.upsert(meta('atomic-old'));
      await store.appendMessages('atomic-old', [{ ...message('u1', 'user'), images: [sampleImage('img-atomic')] }]);

      const origWriteFile = fsp.writeFile.bind(fsp);
      const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (target, data, opts) => {
        if (String(target).includes('atomic-new.jsonl')) {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        return origWriteFile(target, data, opts as BufferEncoding);
      });

      try {
        await expect(store.migrateThread('atomic-old', meta('atomic-new'))).rejects.toThrow(/ENOSPC/);
      } finally {
        writeSpy.mockRestore();
      }

      expect(fs.existsSync(path.join(dir, 'atomic-old.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'images', 'atomic-old'))).toBe(true);
      expect(store.get('atomic-old')?.id).toBe('atomic-old');
      expect(store.get('atomic-new')).toBeUndefined();
      expect((await store.readMessages('atomic-old')).map((m) => m.localId)).toEqual(['u1']);
    });

    it('rejects self-migration (oldId === newMeta.id) without deleting <sameId>.jsonl or images', async () => {
      store.upsert(meta('same-id'));
      await store.appendMessages('same-id', [{ ...message('u1', 'user'), images: [sampleImage('img-same')] }]);

      await expect(store.migrateThread('same-id', meta('same-id'))).rejects.toThrow(/same/i);
      expect(fs.existsSync(path.join(dir, 'same-id.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'images', 'same-id'))).toBe(true);
      expect(store.get('same-id')?.id).toBe('same-id');
    });

    it('rejects tainted non-string / empty / traversal threadIds (including null & undefined without coercion)', async () => {
      // Seed literal "null" and "undefined" threads to prove null/undefined never coerce to strings!
      store.upsert(meta('null'));
      store.upsert(meta('undefined'));
      const taintedIds: unknown[] = [null, undefined, 123, {}, '', '   ', '../escape', 'a/b'];
      for (const bad of taintedIds) {
        expect(() => store.get(bad as string)).toThrow(/Invalid threadId/);
        expect(() => store.delete(bad as string)).toThrow(/Invalid threadId/);
        await expect(store.readRawMessages(bad as string)).rejects.toThrow(/Invalid threadId/);
        await expect(store.applyServerIds(bad as string, {})).rejects.toThrow(/Invalid threadId/);
        await expect(store.migrateThread(bad as string, meta('valid-target'))).rejects.toThrow(/Invalid threadId/);
        await expect(store.migrateThread('null', { ...meta('valid-target'), id: bad as string })).rejects.toThrow(
          /Invalid threadId/,
        );
      }
      // Neither 'null' nor 'undefined' thread was deleted or touched by passing null/undefined
      expect(store.get('null')?.id).toBe('null');
      expect(store.get('undefined')?.id).toBe('undefined');
    });

    it('loadIndex accepts {} cleanly without .corrupt, round-trips valid entries, and quarantines non-object / malformed JSON', () => {
      const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-idx-'));
      try {
        const indexFile = path.join(indexDir, 'index.json');

        // 1. Valid empty object {} must NOT create .corrupt
        fs.writeFileSync(indexFile, '{}');
        const emptyStore = new ThreadStore(indexDir);
        expect(emptyStore.list()).toEqual([]);
        expect(fs.existsSync(indexFile + '.corrupt')).toBe(false);

        // 2. Valid { [id]: ThreadMeta } round-trips cleanly without .corrupt
        emptyStore.upsert(meta('valid-1'));
        const reloadedValid = new ThreadStore(indexDir);
        expect(reloadedValid.list().map((t) => t.id)).toEqual(['valid-1']);
        expect(fs.existsSync(indexFile + '.corrupt')).toBe(false);

        // 3. Non-objects and malformed payloads are quarantined/filtered safely without throwing
        for (const payload of ['null', '"str"', '123', '[]', '{"bad": null}', '{corrupt']) {
          fs.rmSync(indexFile + '.corrupt', { force: true });
          fs.writeFileSync(indexFile, payload);
          const recovered = new ThreadStore(indexDir);
          expect(recovered.list()).toEqual([]);
          expect(fs.existsSync(indexFile + '.corrupt')).toBe(true);
        }
      } finally {
        fs.rmSync(indexDir, { recursive: true, force: true });
      }
    });
  });

  describe('Wave 1 Remediation: durable tombstones, inspectLogsSync, findByRemoteId & prepareForRecreation', () => {
    const sampleImage = (id = 'img-rem-1'): ImageAttachment => ({
      id,
      mediaType: 'image/png',
      data: Buffer.from('fake-png-bytes').toString('base64'),
      name: 'diagram.png',
      size: 14,
      description: 'Architecture diagram',
    });

    it('exports canonical isValidStoredMessage validator', () => {
      expect(isValidStoredMessage({ localId: 'u1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' })).toBe(true);
      expect(isValidStoredMessage({ localId: 'a1', role: 'assistant', content: '', createdAt: '2026-01-01T00:00:00Z' })).toBe(true);
      expect(isValidStoredMessage(null)).toBe(false);
      expect(isValidStoredMessage(undefined)).toBe(false);
      expect(isValidStoredMessage([])).toBe(false);
      expect(isValidStoredMessage({ localId: '', role: 'user', content: 'hi' })).toBe(false);
      expect(isValidStoredMessage({ localId: 'x', role: 'system', content: 'hi' })).toBe(false);
      expect(isValidStoredMessage({ localId: 'x', role: 'user', content: 123 })).toBe(false);
    });

    it('retains tombstone in deleted.json when fsp.rm fails (EBUSY/EPERM), hides tombstoned log across restart, and unlinks deleted.json once background cleanup succeeds', async () => {
      store.upsert(meta('locked-1'));
      await store.appendMessages('locked-1', [message('u1', 'user'), message('a1', 'assistant')]);

      const origRm = fsp.rm.bind(fsp);
      const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, opts) => {
        if (String(target).includes('locked-1')) {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        return origRm(target, opts);
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await store.delete('locked-1');
        expect(store.get('locked-1')).toBeUndefined();
        expect(store.isDeleted('locked-1')).toBe(true);
        expect(fs.existsSync(path.join(dir, 'locked-1.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'deleted.json'), 'utf8'))).toEqual(['locked-1']);

        // Excluded from all enumeration and reads while tombstoned
        expect(await store.listLogThreadIds()).not.toContain('locked-1');
        expect(store.inspectLogsSync().allLogIds).not.toContain('locked-1');
        expect(store.inspectLogsSync().nonEmptyIds.has('locked-1')).toBe(false);
        expect(await store.readRawMessages('locked-1')).toEqual([]);
        expect(await store.readMessages('locked-1')).toEqual([]);

        // Restart while STILL locked: remains tombstoned, never resurrected as orphan
        const reopenedLocked = new ThreadStore(dir);
        expect(reopenedLocked.isDeleted('locked-1')).toBe(true);
        expect(reopenedLocked.inspectLogsSync().allLogIds).not.toContain('locked-1');
        expect(await reopenedLocked.listLogThreadIds()).not.toContain('locked-1');
        await reopenedLocked.drain();
        expect(reopenedLocked.isDeleted('locked-1')).toBe(true);
        expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(true);
      } finally {
        rmSpy.mockRestore();
        warnSpy.mockRestore();
      }

      // Restart once file lock is released: synchronous inspection still skips it, and background cleanup unlinks both files
      const reopenedClean = new ThreadStore(dir);
      expect(reopenedClean.isDeleted('locked-1')).toBe(true);
      expect(reopenedClean.inspectLogsSync().allLogIds).not.toContain('locked-1');
      await reopenedClean.drain();
      expect(reopenedClean.isDeleted('locked-1')).toBe(false);
      expect(fs.existsSync(path.join(dir, 'locked-1.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);
    });

    it('prevents queued appendMessages, replaceMessages, applyServerIds, setFeedback, and prepareForRecreation from resurrecting <id>.jsonl or index[id] after delete(id)', async () => {
      store.upsert(meta('race-del'));
      await store.appendMessages('race-del', [message('u0', 'user')]);

      let releaseGate!: () => void;
      const gate = new Promise<void>((res) => {
        releaseGate = res;
      });

      // Hold the per-thread opChain while queueing every write operation behind it
      const blocker = (store as unknown as { runExclusive: (id: string, fn: () => Promise<void>) => Promise<void> }).runExclusive(
        'race-del',
        () => gate,
      );

      const appendSpy = vi.spyOn(fsp, 'appendFile');
      try {
        const qAppend = store.appendMessages('race-del', [
          { ...message('u1', 'user'), images: [sampleImage('img-race')] },
          message('a1', 'assistant'),
        ]);
        const qReplace = store.replaceMessages('race-del', [message('u2', 'user')]);
        const qServerIds = store.applyServerIds('race-del', { u0: 'srv-0' });
        const qFeedback = store.setFeedback('race-del', 'u0', 1, 'great');
        const qRecreate = store.prepareForRecreation(
          'race-del',
          meta('race-del'),
          { remoteConversationId: 'r-after-del', syncState: 'pending' },
          [{ localId: 'u3', role: 'user', content: 'extra', createdAt: '2026-06-10T10:05:00Z' }],
        );

        // Delete synchronously BEFORE releasing the gate
        const delPromise = store.delete('race-del');
        expect(store.isDeleted('race-del')).toBe(true);
        expect(store.get('race-del')).toBeUndefined();

        releaseGate();
        await Promise.all([blocker, qAppend, qReplace, qServerIds, qFeedback, qRecreate, delPromise]);
        expect(appendSpy).not.toHaveBeenCalled();
      } finally {
        appendSpy.mockRestore();
        releaseGate();
      }
      await store.drain('race-del');

      expect(store.get('race-del')).toBeUndefined();
      expect(store.findByRemoteId('r-after-del')).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'race-del.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'images', 'race-del'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);
      expect(store.isDeleted('race-del')).toBe(false);
    });

    it('takes zero-write fast path on header-only delete(id) and clears tombstone + aborts stale fsp.rm on re-upsert', async () => {
      store.upsert(meta('header-only'));
      const writeSyncSpy = vi.spyOn(fs, 'writeFileSync');
      try {
        await store.delete('header-only');
        const deletedWrites = writeSyncSpy.mock.calls.filter(([target]) =>
          String(target).includes('deleted.json'),
        );
        expect(deletedWrites).toHaveLength(0);
      } finally {
        writeSyncSpy.mockRestore();
      }
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);
      expect(store.isDeleted('header-only')).toBe(false);

      // Re-upsert after delete(id) clears tombstone and aborts queued background fsp.rm
      store.upsert(meta('re-admitted'));
      await store.appendMessages('re-admitted', [message('u1', 'user')]);

      let releaseGate!: () => void;
      const gate = new Promise<void>((res) => {
        releaseGate = res;
      });
      const blocker = (store as unknown as { runExclusive: (id: string, fn: () => Promise<void>) => Promise<void> }).runExclusive(
        're-admitted',
        () => gate,
      );

      try {
        const delPromise = store.delete('re-admitted');
        expect(store.isDeleted('re-admitted')).toBe(true);
        expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(true);

        // Re-upsert before background cleanup runs
        store.upsert({ ...meta('re-admitted'), title: 'Back in top 200' });
        expect(store.isDeleted('re-admitted')).toBe(false);
        expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);

        releaseGate();
        await Promise.all([blocker, delPromise]);
      } finally {
        releaseGate();
      }
      await store.drain('re-admitted');

      expect(store.get('re-admitted')?.title).toBe('Back in top 200');
      expect(fs.existsSync(path.join(dir, 're-admitted.jsonl'))).toBe(true);
      expect((await store.readMessages('re-admitted')).map((m) => m.localId)).toEqual(['u1']);
    });

    it('quarantines corrupt/non-array deleted.json to .corrupt and salvages mixed-validity deleted.json without throwing', async () => {
      const tombDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-tomb-'));
      try {
        const deletedFile = path.join(tombDir, 'deleted.json');

        // 1. Corrupt / non-array payloads quarantined to .corrupt
        for (const bad of ['{corrupt', 'null', '{}', '"str"', '123']) {
          fs.rmSync(deletedFile + '.corrupt', { force: true });
          fs.writeFileSync(deletedFile, bad);
          const s = new ThreadStore(tombDir);
          await s.drain();
          expect(fs.existsSync(deletedFile + '.corrupt')).toBe(true);
        }

        // 2. Mixed-validity array ["tombstoned-1", "../escape", "", 42, null]
        fs.rmSync(deletedFile + '.corrupt', { force: true });
        fs.writeFileSync(
          path.join(tombDir, 'tombstoned-1.jsonl'),
          JSON.stringify(message('u1', 'user')) + '\n',
        );
        fs.writeFileSync(
          path.join(tombDir, 'healthy-1.jsonl'),
          JSON.stringify(message('u2', 'user')) + '\n',
        );
        const mixedRaw = JSON.stringify(['tombstoned-1', '../escape', '', 42, null]);
        fs.writeFileSync(deletedFile, mixedRaw);

        const salvaged = new ThreadStore(tombDir);
        // Synchronously retains valid tombstone, preserves .corrupt backup, and skips tombstone in inspectLogsSync
        expect(salvaged.isDeleted('tombstoned-1')).toBe(true);
        expect(salvaged.isDeleted('../escape')).toBe(false);
        expect(fs.existsSync(deletedFile + '.corrupt')).toBe(true);
        expect(fs.readFileSync(deletedFile + '.corrupt', 'utf8')).toBe(mixedRaw);
        expect(salvaged.inspectLogsSync().allLogIds).toEqual(['healthy-1']);

        // Background cleanup completes cleanly without throwing on invalid entries and removes tombstoned-1 + deleted.json
        await salvaged.drain();
        expect(fs.existsSync(path.join(tombDir, 'tombstoned-1.jsonl'))).toBe(false);
        expect(fs.existsSync(path.join(tombDir, 'healthy-1.jsonl'))).toBe(true);
        expect(fs.existsSync(deletedFile)).toBe(false);
        expect(salvaged.isDeleted('tombstoned-1')).toBe(false);
      } finally {
        fs.rmSync(tombDir, { recursive: true, force: true });
      }
    });

    it('inspectLogsSync distinguishes nonEmptyIds vs 0-byte logs, skips tombstones and invalid filenames, and performs 0 file reads', async () => {
      const missingDirStore = new ThreadStore(path.join(dir, 'nonexistent-subdir'));
      expect(missingDirStore.inspectLogsSync()).toEqual({ nonEmptyIds: new Set(), allLogIds: [] });

      store.upsert(meta('non-empty'));
      await store.appendMessages('non-empty', [message('u1', 'user')]);
      fs.writeFileSync(path.join(dir, 'zero-byte.jsonl'), '');
      fs.writeFileSync(path.join(dir, 'bad name.jsonl'), '{"localId":"x"}');
      fs.writeFileSync(path.join(dir, 'tomb-log.jsonl'), JSON.stringify(message('u2', 'user')) + '\n');

      // Tombstone tomb-log while blocking fsp.rm temporarily so tomb-log.jsonl is still on disk during inspectLogsSync
      const origRm = fsp.rm.bind(fsp);
      const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, opts) => {
        if (String(target).includes('tomb-log')) {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
        return origRm(target, opts);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await store.delete('tomb-log');
      } finally {
        rmSpy.mockRestore();
        warnSpy.mockRestore();
      }

      const readSyncSpy = vi.spyOn(fs, 'readFileSync');
      const readAsyncSpy = vi.spyOn(fsp, 'readFile');
      try {
        const inspected = store.inspectLogsSync();
        expect([...inspected.nonEmptyIds].sort()).toEqual(['non-empty']);
        expect([...inspected.allLogIds].sort()).toEqual(['non-empty', 'zero-byte']);
        expect(readSyncSpy).not.toHaveBeenCalled();
        expect(readAsyncSpy).not.toHaveBeenCalled();
      } finally {
        readSyncSpy.mockRestore();
        readAsyncSpy.mockRestore();
      }
    });

    it('findByRemoteId & prepareForRecreation maintain O(1) remote mapping across initial and chained recreations, preserve concurrent patches, and keep local files in place', async () => {
      store.upsert({ ...meta('local-1'), sessionId: 'sess-warm', hasStarted: true });
      await store.appendMessages('local-1', [
        { ...message('u1', 'user'), images: [sampleImage('img-keep')] },
        message('a1', 'assistant', { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      ]);
      await store.applyServerIds('local-1', { u1: 'old-srv-u1', a1: 'old-srv-a1' });
      await store.setFeedback('local-1', 'a1', 1, 'spot on');

      // Initially maps local-1 -> local-1
      expect(store.findByRemoteId('local-1')?.id).toBe('local-1');

      // Simulate concurrent patch while prepareForRecreation is queued behind an op
      let releaseGate!: () => void;
      const gate = new Promise<void>((res) => {
        releaseGate = res;
      });
      const blocker = (store as unknown as { runExclusive: (id: string, fn: () => Promise<void>) => Promise<void> }).runExclusive(
        'local-1',
        () => gate,
      );

      let updatedMeta!: ThreadMeta;
      try {
        const staleSnapshot = store.get('local-1')!;
        const recreatePromise = store.prepareForRecreation(
          'local-1',
          staleSnapshot,
          {
            remoteConversationId: 'remote-r1',
            syncState: 'pending',
            remoteSettings: { client: 'desktop', model: 'sonnet' },
          },
          [
            { localId: 'a1', role: 'assistant', content: 'dup-ignored', createdAt: '2026-06-10T10:01:00Z' },
            {
              localId: 'u2',
              serverId: 'stale-u2',
              role: 'user',
              content: 'queue-only follow-up',
              createdAt: '2026-06-10T10:02:00Z',
            },
          ],
        );

        // Concurrent patch lands BEFORE blocker releases
        store.patch('local-1', { title: 'User Renamed During Create' });
        releaseGate();

        updatedMeta = await Promise.all([blocker, recreatePromise]).then(([, m]) => m);
      } finally {
        releaseGate();
      }
      expect(updatedMeta.id).toBe('local-1');
      expect(updatedMeta.remoteConversationId).toBe('remote-r1');
      expect(updatedMeta.title).toBe('User Renamed During Create');
      expect(updatedMeta.sessionId).toBe('sess-warm');

      // Initial id -> r1: findByRemoteId('remote-r1') resolves local-1, AND findByRemoteId('local-1') is evicted!
      expect(store.findByRemoteId('remote-r1')?.id).toBe('local-1');
      expect(store.findByRemoteId('local-1')).toBeUndefined();

      // Zero file/image renames: local-1.jsonl and images/local-1 stay in place, serverIds stripped
      expect(fs.existsSync(path.join(dir, 'local-1.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'images', 'local-1'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'remote-r1.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'images', 'remote-r1'))).toBe(false);

      const rawAfterR1 = await store.readRawMessages('local-1');
      expect(rawAfterR1.map((m) => m.localId)).toEqual(['u1', 'a1', 'u2']);
      expect(rawAfterR1.every((m) => m.serverId === undefined)).toBe(true);
      expect(rawAfterR1[1].feedback).toEqual({ rating: 1, comment: 'spot on' });
      const hydrated = await store.readMessages('local-1');
      expect(hydrated[0].images?.[0].data).toBe(Buffer.from('fake-png-bytes').toString('base64'));

      // Chained recreation r1 -> r2 evicts r1
      await store.prepareForRecreation('local-1', updatedMeta, { remoteConversationId: 'remote-r2' }, []);
      expect(store.findByRemoteId('remote-r2')?.id).toBe('local-1');
      expect(store.findByRemoteId('remote-r1')).toBeUndefined();
      expect(store.findByRemoteId('local-1')).toBeUndefined();

      // Reload from disk preserves remoteConversationId & findByRemoteId
      const reopened = new ThreadStore(dir);
      expect(reopened.findByRemoteId('remote-r2')?.id).toBe('local-1');
      expect(reopened.findByRemoteId('remote-r1')).toBeUndefined();
      expect(reopened.findByRemoteId('local-1')).toBeUndefined();

      // Deleting local-1 evicts remote-r2 from findByRemoteId
      await store.delete('local-1');
      expect(store.findByRemoteId('remote-r2')).toBeUndefined();
    });

    it('loadIndex enforces key === val.id, validates remoteConversationId, omits self remoteConversationId cleanly, and deterministically resolves duplicate remoteConversationId collisions', () => {
      const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-remote-idx-'));
      try {
        const indexFile = path.join(idxDir, 'index.json');

        // 1. Self remoteConversationId === id is omitted silently WITHOUT creating .corrupt
        fs.writeFileSync(
          indexFile,
          JSON.stringify({
            'self-id': { ...meta('self-id'), remoteConversationId: 'self-id' },
          }),
        );
        const cleanSelf = new ThreadStore(idxDir);
        expect(fs.existsSync(indexFile + '.corrupt')).toBe(false);
        expect('remoteConversationId' in cleanSelf.get('self-id')!).toBe(false);
        expect(cleanSelf.findByRemoteId('self-id')?.id).toBe('self-id');

        // 2. Rejects key !== val.id, strips invalid remoteConversationId: '../evil', resolves recreated vs recreated to newer updatedAt, and prefers native id === remoteId over recreated even when recreated has newer updatedAt
        fs.writeFileSync(
          indexFile,
          JSON.stringify({
            mismatched_key: { ...meta('different-id') },
            'bad-remote': { ...meta('bad-remote'), remoteConversationId: '../evil' },
            'rec-older': {
              ...meta('rec-older'),
              remoteConversationId: 'shared-r1',
              updatedAt: '2026-06-10T10:00:00Z',
            },
            'rec-newer': {
              ...meta('rec-newer'),
              remoteConversationId: 'shared-r1',
              updatedAt: '2026-06-10T12:00:00Z',
            },
            'native-r2': {
              ...meta('native-r2'),
              updatedAt: '2026-06-10T09:00:00Z',
            },
            'rec-claims-native': {
              ...meta('rec-claims-native'),
              remoteConversationId: 'native-r2',
              updatedAt: '2026-06-10T15:00:00Z',
            },
          }),
        );

        const loaded = new ThreadStore(idxDir);
        expect(fs.existsSync(indexFile + '.corrupt')).toBe(true);

        // key !== val.id rejected
        expect(loaded.get('mismatched_key')).toBeUndefined();
        expect(loaded.get('different-id')).toBeUndefined();

        // invalid remoteConversationId stripped
        expect(loaded.get('bad-remote')?.remoteConversationId).toBeUndefined();
        expect(loaded.findByRemoteId('bad-remote')?.id).toBe('bad-remote');

        // recreated vs recreated -> newer updatedAt wins 'shared-r1', older stripped
        expect(loaded.findByRemoteId('shared-r1')?.id).toBe('rec-newer');
        expect(loaded.get('rec-newer')?.remoteConversationId).toBe('shared-r1');
        expect(loaded.get('rec-older')?.remoteConversationId).toBeUndefined();
        expect(loaded.findByRemoteId('rec-older')?.id).toBe('rec-older');

        // native vs recreated -> native 'native-r2' wins even though rec-claims-native has newer updatedAt
        expect(loaded.findByRemoteId('native-r2')?.id).toBe('native-r2');
        expect(loaded.get('rec-claims-native')?.remoteConversationId).toBeUndefined();
        expect(loaded.findByRemoteId('rec-claims-native')?.id).toBe('rec-claims-native');
      } finally {
        fs.rmSync(idxDir, { recursive: true, force: true });
      }
    });

    it('Gate 3 High #1: aborts prepareForRecreation and applyServerIds when delete(id) fires mid-writeRaw without resurrecting index[id] or remoteToLocalId', async () => {
      store.upsert(meta('mid-write-del'));
      await store.appendMessages('mid-write-del', [message('u1', 'user'), message('a1', 'assistant')]);

      const origRename = fsp.rename.bind(fsp);
      let releaseWriteRaw!: () => void;
      let notifyWriteEntered!: () => void;
      const writeEntered = new Promise<void>((res) => {
        notifyWriteEntered = res;
      });
      const writeGate = new Promise<void>((res) => {
        releaseWriteRaw = res;
      });

      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (String(newPath).endsWith('mid-write-del.jsonl')) {
          notifyWriteEntered();
          await writeGate;
        }
        return origRename(oldPath, newPath);
      });

      try {
        const snapshot = store.get('mid-write-del')!;
        const recreatePromise = store.prepareForRecreation(
          'mid-write-del',
          snapshot,
          { remoteConversationId: 'r1-ghost', syncState: 'pending' },
          [{ localId: 'u2', role: 'user', content: 'extra', createdAt: '2026-06-10T10:02:00Z' }],
        );

        await writeEntered;
        // Delete while writeRaw is suspended mid-flight inside prepareForRecreation
        const delPromise = store.delete('mid-write-del');
        expect(store.get('mid-write-del')).toBeUndefined();

        releaseWriteRaw();
        await Promise.all([recreatePromise, delPromise]);
      } finally {
        renameSpy.mockRestore();
        releaseWriteRaw();
      }
      await store.drain('mid-write-del');

      expect(store.get('mid-write-del')).toBeUndefined();
      expect(store.findByRemoteId('r1-ghost')).toBeUndefined();
      expect(store.findByRemoteId('mid-write-del')).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'mid-write-del.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);

      const reloaded = new ThreadStore(dir);
      await reloaded.drain();
      expect(reloaded.get('mid-write-del')).toBeUndefined();
      expect(reloaded.findByRemoteId('r1-ghost')).toBeUndefined();

      // Also verify applyServerIds returns { hasUnsynced: false } when delete(id) fires mid-writeRaw
      store.upsert(meta('mid-ack-del'));
      await store.appendMessages('mid-ack-del', [message('u1', 'user'), message('a1', 'assistant')]);

      let releaseAckWrite!: () => void;
      let notifyAckEntered!: () => void;
      const ackEntered = new Promise<void>((res) => {
        notifyAckEntered = res;
      });
      const ackGate = new Promise<void>((res) => {
        releaseAckWrite = res;
      });
      const ackRenameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (String(newPath).endsWith('mid-ack-del.jsonl')) {
          notifyAckEntered();
          await ackGate;
        }
        return origRename(oldPath, newPath);
      });

      try {
        const ackPromise = store.applyServerIds('mid-ack-del', { u1: 'srv-u1' });
        await ackEntered;
        const delAckPromise = store.delete('mid-ack-del');
        releaseAckWrite();
        const [ackResult] = await Promise.all([ackPromise, delAckPromise]);
        expect(ackResult).toEqual({ hasUnsynced: false });
      } finally {
        ackRenameSpy.mockRestore();
        releaseAckWrite();
      }
      await store.drain('mid-ack-del');
      expect(fs.existsSync(path.join(dir, 'mid-ack-del.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);
    });

    it('Gate 3 Medium #3: enforces monotonic lifecycleEpoch across delete -> upsert -> appendMessages -> delete, swallows persistDeletedSync errors in background cleanup, and excludes tombstones in loadIndex()', async () => {
      // 1. Generation race: delete #1 (suspended fsp.rm) -> upsert -> appendMessages -> delete #2 (with EPERM on #2)
      store.upsert(meta('gen-race'));
      await store.appendMessages('gen-race', [message('u0', 'user')]);

      const origRm = fsp.rm.bind(fsp);
      let releaseFirstRm!: () => void;
      let notifyFirstRm!: () => void;
      const firstRmEntered = new Promise<void>((res) => {
        notifyFirstRm = res;
      });
      const firstRmGate = new Promise<void>((res) => {
        releaseFirstRm = res;
      });
      let rmCallCount = 0;

      const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, opts) => {
        if (String(target).endsWith('gen-race.jsonl')) {
          rmCallCount += 1;
          if (rmCallCount === 1) {
            await origRm(target, opts);
            notifyFirstRm();
            await firstRmGate;
            return;
          }
          // Simulate EPERM on delete #2 so we verify cleanup #1 NEVER cleared delete #2's tombstone!
          throw Object.assign(new Error('EPERM on gen 2'), { code: 'EPERM' });
        }
        return origRm(target, opts);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const appendSpy = vi.spyOn(fsp, 'appendFile');

      try {
        const del1 = store.delete('gen-race');
        await firstRmEntered;

        // Re-admit generation 2, queue a write in generation 2, then delete #2 BEFORE cleanup #1 finishes!
        store.upsert({ ...meta('gen-race'), title: 'Gen 2' });
        const gen2Append = store.appendMessages('gen-race', [message('u-gen2', 'user')]);
        const del2 = store.delete('gen-race');

        // Put a dummy file back if needed to simulate EPERM retention on delete #2
        fs.writeFileSync(path.join(dir, 'gen-race.jsonl'), '{"localId":"leftover","role":"user","content":"x","createdAt":"2026-06-10T10:00:00Z"}\n');

        releaseFirstRm();
        await Promise.all([del1, gen2Append, del2]);
        expect(appendSpy).not.toHaveBeenCalled();

        // cleanup #1 must NOT have wiped delete #2's tombstone while gen-race.jsonl failed EPERM on delete #2!
        expect(store.get('gen-race')).toBeUndefined();
        expect(store.isDeleted('gen-race')).toBe(true);
        expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(true);
      } finally {
        rmSpy.mockRestore();
        appendSpy.mockRestore();
        warnSpy.mockRestore();
        releaseFirstRm();
      }

      // Now let delete #3 clean up cleanly
      await store.delete('gen-race');
      await store.drain('gen-race');
      expect(store.isDeleted('gen-race')).toBe(false);
      expect(fs.existsSync(path.join(dir, 'gen-race.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'deleted.json'))).toBe(false);

      // 2. Background scheduleTombstoneCleanup catches persistDeletedSync disk errors without unhandled rejection
      store.upsert(meta('t-persist-err'));
      await store.appendMessages('t-persist-err', [message('u1', 'user')]);
      store.upsert(meta('other-tomb'));
      await store.appendMessages('other-tomb', [message('u2', 'user')]);

      // Keep 'other-tomb' in deletedIds so persistDeletedSync attempts writeFileSync('deleted.json.tmp')
      const blockOtherSpy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, opts) => {
        if (String(target).includes('other-tomb')) {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        return origRm(target, opts);
      });
      const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await store.delete('other-tomb');
        const origWriteSync = fs.writeFileSync.bind(fs);
        let enteredCleanup = false;
        const writeErrSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
          if (enteredCleanup && String(target).includes('deleted.json')) {
            throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
          }
          return origWriteSync(target, data, options as fs.WriteFileOptions);
        });
        try {
          const delPromise = store.delete('t-persist-err');
          enteredCleanup = true;
          await expect(delPromise).resolves.toBeUndefined();
        } finally {
          writeErrSpy.mockRestore();
        }
      } finally {
        blockOtherSpy.mockRestore();
        warnSpy2.mockRestore();
      }

      // 3. loadIndex() + deleted.json crash window: tombstones win over stale index.json without .corrupt
      const crashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-crash-idx-'));
      try {
        fs.writeFileSync(
          path.join(crashDir, 'index.json'),
          JSON.stringify({
            'tomb-1': { ...meta('tomb-1'), remoteConversationId: 'r-tomb-1' },
            'healthy-1': meta('healthy-1'),
          }),
        );
        fs.writeFileSync(path.join(crashDir, 'deleted.json'), JSON.stringify(['tomb-1']));

        const recovered = new ThreadStore(crashDir);
        expect(recovered.get('tomb-1')).toBeUndefined();
        expect(recovered.findByRemoteId('r-tomb-1')).toBeUndefined();
        expect(recovered.findByRemoteId('tomb-1')).toBeUndefined();
        expect(recovered.list().map((t) => t.id)).toEqual(['healthy-1']);
        expect(fs.existsSync(path.join(crashDir, 'index.json.corrupt'))).toBe(false);
        await recovered.drain();
      } finally {
        fs.rmSync(crashDir, { recursive: true, force: true });
      }
    });

    it('Gate 3 Low #4: syncRemoteMapping preserves native id === nextRemote precedence over recreated remoteConversationId on upsert and patch', () => {
      store.upsert(meta('native-A'));
      store.upsert({ ...meta('rec-B'), remoteConversationId: 'native-A' });

      expect(store.findByRemoteId('native-A')?.id).toBe('native-A');
      expect(store.get('rec-B')?.remoteConversationId).toBeUndefined();
      expect(store.findByRemoteId('rec-B')?.id).toBe('rec-B');

      // Same precedence on patch()
      store.patch('rec-B', { remoteConversationId: 'native-A' });
      expect(store.findByRemoteId('native-A')?.id).toBe('native-A');
      expect(store.get('rec-B')?.remoteConversationId).toBeUndefined();
      expect(store.findByRemoteId('rec-B')?.id).toBe('rec-B');
    });
  });
});


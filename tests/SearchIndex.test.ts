import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SearchIndex } from '../src/main/store/SearchIndex';
import type { ChatMessage } from '../src/shared/types';

function message(localId: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { localId, role, content, createdAt: '2026-08-01T10:00:00.000Z' };
}

describe('SearchIndex', () => {
  let dir: string;
  let threadsDir: string;
  let indexFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    threadsDir = path.join(dir, 'threads');
    indexFile = path.join(dir, 'search-index.json');
    fs.mkdirSync(threadsDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeLog(threadId: string, messages: ChatMessage[]): void {
    fs.writeFileSync(
      path.join(threadsDir, `${threadId}.jsonl`),
      messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    );
  }

  function appendLog(threadId: string, messages: ChatMessage[]): void {
    fs.appendFileSync(
      path.join(threadsDir, `${threadId}.jsonl`),
      messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    );
  }

  function newIndex(): SearchIndex {
    return new SearchIndex(threadsDir, indexFile);
  }

  it('indexes existing logs at startup and finds message content', async () => {
    writeLog('t1', [
      message('m1', 'user', 'what versions of Microsoft SQL Server are supported?'),
      message('m2', 'assistant', 'Only SQL Server 2019 is listed in the manuals.'),
    ]);
    writeLog('t2', [message('m3', 'user', 'unrelated conversation about invoices')]);

    const index = newIndex();
    const sweep = await index.start();
    expect(sweep).toEqual({ indexed: 2, skipped: 0, removed: 0 });

    const hits = await index.search('sql server');
    expect(hits.map((h) => h.threadId)).toEqual(['t1']);
    expect(hits[0].matches).toBe(2);
    expect(hits[0].messageLocalId).toBe('m1');
    expect(hits[0].snippet.toLowerCase()).toContain('sql server');
  });

  it('matches case-insensitively and requires every term in the same message', async () => {
    writeLog('t1', [
      message('m1', 'user', 'the QueueName validation rejects empty values'),
      message('m2', 'assistant', 'validation runs first'),
      message('m3', 'assistant', 'QueueName is a string'),
    ]);
    const index = newIndex();
    await index.start();

    expect((await index.search('queuename VALIDATION'))[0].matches).toBe(1);
    expect((await index.search('queuename'))[0].matches).toBe(2);
    expect(await index.search('queuename postgres')).toEqual([]);
  });

  it('re-reads only the logs that changed since the last sweep', async () => {
    writeLog('t1', [message('m1', 'user', 'first thread')]);
    writeLog('t2', [message('m2', 'user', 'second thread')]);

    const index = newIndex();
    expect(await index.start()).toEqual({ indexed: 2, skipped: 0, removed: 0 });
    // Nothing touched the logs, so a second sweep must read nothing.
    expect(await index.refresh()).toEqual({ indexed: 0, skipped: 2, removed: 0 });

    appendLog('t2', [message('m3', 'assistant', 'a brand new answer about latency')]);
    expect(await index.refresh()).toEqual({ indexed: 1, skipped: 1, removed: 0 });
    expect((await index.search('latency')).map((h) => h.threadId)).toEqual(['t2']);
  });

  it('reuses the persisted index across restarts instead of re-reading every log', async () => {
    writeLog('t1', [message('m1', 'user', 'persisted content about throughput')]);
    const first = newIndex();
    await first.start();
    // dispose() is the shutdown path: it must land the index synchronously, since
    // `before-quit` gives an async write no chance to finish.
    first.dispose();
    expect(fs.existsSync(indexFile)).toBe(true);

    const second = newIndex();
    expect(await second.start()).toEqual({ indexed: 0, skipped: 1, removed: 0 });
    expect((await second.search('throughput')).map((h) => h.threadId)).toEqual(['t1']);
  });

  it('rebuilds from the logs when the persisted index is corrupt', async () => {
    writeLog('t1', [message('m1', 'user', 'recoverable content')]);
    fs.writeFileSync(indexFile, '{not json');

    const index = newIndex();
    expect(await index.start()).toEqual({ indexed: 1, skipped: 0, removed: 0 });
    expect((await index.search('recoverable')).map((h) => h.threadId)).toEqual(['t1']);
  });

  it('indexes a turn written while the app runs, without waiting for a sweep', async () => {
    writeLog('t1', [message('m1', 'user', 'opening question')]);
    const index = newIndex();
    await index.start();

    index.addMessages('t1', [
      message('m2', 'user', 'what about the retention policy?'),
      message('m3', 'assistant', 'Retention is ninety days.'),
    ]);
    expect((await index.search('retention')).map((h) => h.threadId)).toEqual(['t1']);

    // A thread with no local log yet (rehydrated from the server) becomes searchable too.
    index.replaceMessages('t9', [message('m9', 'assistant', 'rehydrated answer about clustering')]);
    expect((await index.search('clustering')).map((h) => h.threadId)).toEqual(['t9']);
  });

  it('does not index the same message twice', async () => {
    const index = newIndex();
    await index.start();
    const msg = message('m1', 'user', 'duplicate check');
    index.addMessages('t1', [msg]);
    index.addMessages('t1', [msg]);
    expect((await index.search('duplicate'))[0].matches).toBe(1);
  });

  it('re-reads a log appended to while running, without duplicating the live-indexed turn', async () => {
    writeLog('t1', [message('m1', 'user', 'opening question')]);
    const index = newIndex();
    await index.start();

    const turn = [message('m2', 'user', 'follow-up about backups'), message('m3', 'assistant', 'Backups run nightly.')];
    appendLog('t1', turn);
    index.addMessages('t1', turn);

    // The live path leaves the recorded stat stale on purpose, so the next sweep re-reads
    // the log — the rebuilt entry must not double-count the messages already folded in.
    expect(await index.refresh()).toEqual({ indexed: 1, skipped: 0, removed: 0 });
    expect((await index.search('backups'))[0].matches).toBe(2);
  });

  it('drops threads whose log is gone, and threads removed explicitly', async () => {
    writeLog('t1', [message('m1', 'user', 'shared keyword here')]);
    writeLog('t2', [message('m2', 'user', 'shared keyword there')]);
    const index = newIndex();
    await index.start();
    expect((await index.search('shared keyword')).length).toBe(2);

    // What deleting a conversation does: drop the entry, and the log goes with it.
    index.remove('t1');
    fs.rmSync(path.join(threadsDir, 't1.jsonl'));
    expect((await index.search('shared keyword')).map((h) => h.threadId)).toEqual(['t2']);
    expect(await index.refresh()).toEqual({ indexed: 0, skipped: 1, removed: 0 });

    // A log that disappears behind the app's back (deleted elsewhere) is dropped by the sweep.
    fs.rmSync(path.join(threadsDir, 't2.jsonl'));
    expect(await index.refresh()).toEqual({ indexed: 0, skipped: 0, removed: 1 });
    expect(await index.search('shared keyword')).toEqual([]);
  });

  it('keeps the rest of a thread when one log line is unparseable', async () => {
    fs.writeFileSync(
      path.join(threadsDir, 't1.jsonl'),
      `${JSON.stringify(message('m1', 'user', 'good line about migrations'))}\n{"broken\n`,
    );
    const index = newIndex();
    await index.start();
    expect((await index.search('migrations')).map((h) => h.threadId)).toEqual(['t1']);
  });

  it('ranks threads by how many messages matched', async () => {
    writeLog('t1', [message('m1', 'user', 'one mention of audit')]);
    writeLog('t2', [
      message('m2', 'user', 'audit trail question'),
      message('m3', 'assistant', 'the audit trail is append-only'),
    ]);
    const index = newIndex();
    await index.start();
    expect((await index.search('audit')).map((h) => h.threadId)).toEqual(['t2', 't1']);
  });

  it('elides a long message down to a snippet around the match', async () => {
    const filler = 'lorem ipsum '.repeat(60);
    writeLog('t1', [message('m1', 'assistant', `${filler}the checksum is verified${filler}`)]);
    const index = newIndex();
    await index.start();

    const [hit] = await index.search('checksum');
    expect(hit.snippet).toContain('checksum');
    expect(hit.snippet.startsWith('…')).toBe(true);
    expect(hit.snippet.endsWith('…')).toBe(true);
    expect(hit.snippet.length).toBeLessThan(200);
  });

  it('ignores an empty query and messages with no prose', async () => {
    writeLog('t1', [message('m1', 'user', '')]);
    const index = newIndex();
    await index.start();
    expect(await index.search('   ')).toEqual([]);
    expect(await index.search('anything')).toEqual([]);
  });
});

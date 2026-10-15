import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import { ThreadStore } from '../src/main/store/ThreadStore';
import {
  findArgsCloseParen,
  parseStoredContent,
  serializeAssistantContent,
} from '../src/main/store/messageCodec';
import { qualifyTool, REHYDRATED_TOOL_RESULT_PLACEHOLDER } from '../src/shared/types';
import type { ChatMessage } from '../src/shared/types';

describe('findArgsCloseParen', () => {
  const closeOf = (m: string): number => findArgsCloseParen(m, m.indexOf('(') + 1);

  it('finds the terminator after a simple object', () => {
    const m = 'name({"query":"hello"})';
    expect(m.slice(m.indexOf('(') + 1, closeOf(m))).toBe('{"query":"hello"}');
  });
  it('ignores ) inside strings, nested arrays/objects, and escaped quotes', () => {
    const m = 'f({"a":[1,2,")"],"b":"x\\")y","c":"if (x) {}"})';
    const start = m.indexOf('(') + 1;
    const idx = findArgsCloseParen(m, start);
    expect(idx).toBe(m.length - 1);
    expect(JSON.parse(m.slice(start, idx))).toEqual({ a: [1, 2, ')'], b: 'x")y', c: 'if (x) {}' });
  });
  it('returns -1 when unbalanced', () => {
    const m = 'f({"a":1}';
    expect(findArgsCloseParen(m, m.indexOf('(') + 1)).toBe(-1);
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips text + thinking + tool calls whose input contains )', () => {
    const assistant: Partial<ChatMessage> = {
      content: 'The answer is 42.',
      blocks: [
        { thinking: 'let me search' },
        { toolCalls: [{ id: 'x', name: qualifyTool('search_corpus'), input: { query: 'foo) bar', code: 'if (x) {}' } }] },
        { text: 'The answer is 42.' },
      ],
    };
    const serialized = serializeAssistantContent(assistant as ChatMessage, false);
    const parsed = parseStoredContent(serialized);
    expect(parsed.content).toBe('The answer is 42.');
    expect(parsed.thinking).toBe('let me search');
    expect(parsed.toolCalls?.[0].name).toBe(qualifyTool('search_corpus'));
    // The ')' inside the JSON input survives the round-trip (no truncation).
    expect(parsed.toolCalls?.[0].input).toEqual({ query: 'foo) bar', code: 'if (x) {}' });
  });

  it('serializes an orchestrator turn as the clean composed answer with thinking prefix', () => {
    const assistant: Partial<ChatMessage> = { content: 'Composed answer.', thinking: 'reasoning' };
    const serialized = serializeAssistantContent(assistant as ChatMessage, true);
    expect(serialized).toBe('<think>\nreasoning\n</think>\n\nComposed answer.');
    const parsed = parseStoredContent(serialized);
    expect(parsed.content).toBe('Composed answer.');
    expect(parsed.thinking).toBe('reasoning');
  });

  it('handles a plain content-only message', () => {
    const parsed = parseStoredContent('Just text, no markers.');
    expect(parsed.content).toBe('Just text, no markers.');
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.toolCalls).toBeUndefined();
  });

  it('assigns REHYDRATED_TOOL_RESULT_PLACEHOLDER to parsed tool calls', () => {
    const raw = '🔧 *Calling tool:* AskUserQuestion({"question":"Which env?"})\n\nConfigured.';
    const parsed = parseStoredContent(raw);
    expect(parsed.toolCalls?.[0].result).toBe(REHYDRATED_TOOL_RESULT_PLACEHOLDER);
  });

  it('preserves playbook and playbookVersion across disk persistence and server rehydration round-trip', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-codec-ver-'));
    const appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
    try {
      const threadId = 't-codec-ver';
      appCore.threads.upsert({
        id: threadId,
        title: 'Codec Version Thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: '2026-10-15T10:00:00Z',
        updatedAt: '2026-10-15T10:00:00Z',
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });

      vi.spyOn(appCore.syncClient, 'getMessages').mockResolvedValueOnce([
        {
          id: 'm-user-1',
          role: 'user',
          content: 'Question under v2 playbook',
          playbook: 'oim-full',
          playbookVersion: 2,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cachedTokens: null,
          thoughtTokens: null,
          createdAt: '2026-10-15T10:00:00Z',
          feedbackRating: null,
          feedbackComment: null,
        },
        {
          id: 'm-asst-1',
          role: 'assistant',
          content: serializeAssistantContent({ content: 'Answer', thinking: 'thought' }, false),
          playbook: null,
          playbookVersion: null,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          cachedTokens: 0,
          thoughtTokens: 0,
          createdAt: '2026-10-15T10:00:05Z',
          feedbackRating: null,
          feedbackComment: null,
        },
      ]);

      // 1st call rehydrates via fromDto + parseStoredContent and persists to ThreadStore on disk
      const rehydrated = await appCore.getMessages(threadId);
      expect(rehydrated[0].playbook).toBe('oim-full');
      expect(rehydrated[0].playbookVersion).toBe(2);

      // Reopen a fresh ThreadStore from disk to prove JSONL persistence preserved playbookVersion
      const reopenedStore = new ThreadStore(path.join(tmpDir, 'threads'));
      const fromDisk = await reopenedStore.readMessages(threadId);
      expect(fromDisk[0].playbook).toBe('oim-full');
      expect(fromDisk[0].playbookVersion).toBe(2);
      expect(fromDisk[1].playbook).toBeUndefined();
      expect(fromDisk[1].playbookVersion).toBeUndefined();
    } finally {
      await appCore.drain();
      appCore.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


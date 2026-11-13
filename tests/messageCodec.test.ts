import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import { ThreadStore } from '../src/main/store/ThreadStore';
import {
  decodeQueuedMessagePayload,
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

describe('decodeQueuedMessagePayload (Wave 1)', () => {
  it('decodes assistant <think>, tool-call wire markers, playbook, playbookVersion, and usage', () => {
    const wire = serializeAssistantContent(
      {
        content: 'Here is the verified answer.',
        blocks: [
          { thinking: 'Checking schema metadata' },
          {
            toolCalls: [
              {
                id: 'orig-id',
                name: qualifyTool('search_corpus'),
                input: { query: 'ADSAccount (active)' },
              },
            ],
          },
          { text: 'Here is the verified answer.' },
        ],
      },
      false,
    );

    const decoded = decodeQueuedMessagePayload(
      {
        role: 'assistant',
        content: wire,
        playbook: '  oim-schema  ',
        playbookVersion: 4,
        promptTokens: 250,
        completionTokens: 90,
        totalTokens: 340,
        cachedTokens: 40,
        thoughtTokens: 15,
      },
      'local-asst-1',
      '2026-06-10T10:02:00.000Z',
    );

    expect(decoded.localId).toBe('local-asst-1');
    expect(decoded.role).toBe('assistant');
    expect(decoded.content).toBe('Here is the verified answer.');
    expect(decoded.thinking).toBe('Checking schema metadata');
    expect(decoded.toolCalls).toHaveLength(1);
    expect(decoded.toolCalls?.[0]).toMatchObject({
      name: qualifyTool('search_corpus'),
      input: { query: 'ADSAccount (active)' },
      result: REHYDRATED_TOOL_RESULT_PLACEHOLDER,
    });
    expect(decoded.blocks).toHaveLength(3);
    expect(decoded.playbook).toBe('oim-schema');
    expect(decoded.playbookVersion).toBe(4);
    expect(decoded.usage).toEqual({
      inputTokens: 250,
      outputTokens: 90,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      thoughtTokens: 15,
    });
    expect(decoded.createdAt).toBe('2026-06-10T10:02:00.000Z');
  });

  it('strips multi-line trailing [Attached Image 1 (...)] suffix when user text precedes it, preserves image-only user messages, and leaves [Attached Image 2 ( prose intact', () => {
    const withPrecedingProse = decodeQueuedMessagePayload(
      {
        role: 'user',
        content:
          'Please inspect these screenshots\n\n[Attached Image 1 (diagram (final).png): line 1\nline 2 (foo) [bar]]\n[Attached Image 2 (second.png)]',
        playbook: 'oim-schema',
        playbookVersion: 2,
      },
      'u-with-prose',
      '2026-06-10T10:00:00Z',
    );
    expect(withPrecedingProse).toEqual({
      localId: 'u-with-prose',
      role: 'user',
      content: 'Please inspect these screenshots',
      playbook: 'oim-schema',
      playbookVersion: 2,
      createdAt: '2026-06-10T10:00:00Z',
    });

    // Image-only user prompt (no preceding text) must NOT become blank
    const imageOnly = decodeQueuedMessagePayload(
      {
        role: 'user',
        content: '[Attached Image 1 (screenshot.png): Login error dialog]',
      },
      'u-img-only',
      '2026-06-10T10:01:00Z',
    );
    expect(imageOnly.content).toBe('[Attached Image 1 (screenshot.png): Login error dialog]');

    // User prose mentioning [Attached Image 2 (...)] without a trailing block starting at 1 is untouched
    const proseMentioningImage2 =
      'Why did the log say:\n\n[Attached Image 2 (missing-one.png): something]';
    const preserved = decodeQueuedMessagePayload(
      {
        role: 'user',
        content: proseMentioningImage2,
      },
      'u-img2-prose',
      '2026-06-10T10:01:30Z',
    );
    expect(preserved.content).toBe(proseMentioningImage2);

    // Unclosed bracket tail is not stripped
    const unclosed = 'Hello\n\n[Attached Image 1 (broken.png): missing closing bracket';
    expect(
      decodeQueuedMessagePayload({ role: 'user', content: unclosed }, 'u-unclosed', '2026-06-10T10:01:45Z')
        .content,
    ).toBe(unclosed);
  });

  it('never parses <think> or tool-call markers on user messages and strips/clamps invalid playbook, playbookVersion, and negative/NaN token counts', () => {
    const literalUserMarkup =
      '<think>secret user text</think>\n\n🔧 *Calling tool:* bash({"cmd":"ls"})\n\nWhy does this appear?';
    const userDecoded = decodeQueuedMessagePayload(
      {
        role: 'user',
        content: literalUserMarkup,
        playbook: '   ',
        playbookVersion: 3,
      },
      'u-literal',
      '2026-06-10T10:03:00Z',
    );
    expect(userDecoded.content).toBe(literalUserMarkup);
    expect(userDecoded.thinking).toBeUndefined();
    expect(userDecoded.toolCalls).toBeUndefined();
    expect(userDecoded.blocks).toBeUndefined();
    expect(userDecoded.playbook).toBeUndefined();
    expect(userDecoded.playbookVersion).toBeUndefined();
    expect('playbook' in userDecoded).toBe(false);
    expect('playbookVersion' in userDecoded).toBe(false);

    // Orphaned playbookVersion (no playbook) and non-integer/non-positive versions (0, -1, 1.5)
    for (const badVersion of [0, -1, 1.5, Number.NaN]) {
      const msg = decodeQueuedMessagePayload(
        {
          role: 'assistant',
          content: 'Plain reply',
          playbook: 'oim-schema',
          playbookVersion: badVersion,
          promptTokens: -10,
          completionTokens: Number.NaN,
          cachedTokens: -1,
          thoughtTokens: Number.POSITIVE_INFINITY,
        },
        `a-bad-${String(badVersion)}`,
        '2026-06-10T10:04:00Z',
      );
      expect(msg.playbook).toBe('oim-schema');
      expect(msg.playbookVersion).toBeUndefined();
      expect('playbookVersion' in msg).toBe(false);
      // All token counts were negative / NaN / non-finite -> usage omitted cleanly
      expect(msg.usage).toBeUndefined();
      expect('usage' in msg).toBe(false);
    }

    // Partial valid + negative/NaN token counts clamp missing/invalid required fields to 0 and strip invalid thoughtTokens
    const partialUsage = decodeQueuedMessagePayload(
      {
        role: 'assistant',
        content: 'Partial usage reply',
        playbookVersion: 2, // orphaned without playbook
        promptTokens: 120,
        completionTokens: -5,
        cachedTokens: Number.NaN,
        thoughtTokens: -3,
      },
      'a-partial-usage',
      '2026-06-10T10:05:00Z',
    );
    expect(partialUsage.playbook).toBeUndefined();
    expect(partialUsage.playbookVersion).toBeUndefined();
    expect(partialUsage.usage).toEqual({
      inputTokens: 120,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});


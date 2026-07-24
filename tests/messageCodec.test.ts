import { describe, expect, it } from 'vitest';
import {
  findArgsCloseParen,
  parseStoredContent,
  serializeAssistantContent,
} from '../src/main/store/messageCodec';
import { qualifyTool } from '../src/shared/types';
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
});

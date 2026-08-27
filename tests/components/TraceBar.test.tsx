// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TraceBar, type TraceEntry } from '../../src/renderer/src/components/TraceBar';
import { describeArgs, describeResult, shortName } from '../../src/renderer/src/components/toolNames';
import type { ToolCallInfo } from '../../src/shared/types';

function tool(over: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return { id: 't1', name: 'mcp__yvoke__search_corpus', input: { query: 'sql server versions' }, ...over };
}

const entries: TraceEntry[] = [
  { kind: 'thinking', text: 'The manuals list one supported version.' },
  { kind: 'tool', call: tool({ id: 'a', result: JSON.stringify([1, 2, 3, 4, 5, 6]) }) },
  {
    kind: 'tool',
    call: tool({
      id: 'b',
      name: 'mcp__yvoke__get_section',
      input: { heading_path: ['Installation prerequisites', 'SQL Server requirements'] },
      result: '# Requirements',
    }),
  },
];

afterEach(() => cleanup());

describe('TraceBar', () => {
  it('renders nothing when a turn called no tools and did no reasoning', () => {
    const { container } = render(<TraceBar entries={[]} />);
    expect(container.innerHTML).toBe('');
  });

  // The whole point of the redesign: process is one line above the fold, not 500px of it.
  it('collapses the run to a single summary line by default', () => {
    render(<TraceBar entries={entries} />);
    expect(screen.getByText('3 steps · 2 tools · 1 corpus search')).toBeTruthy();
    expect(screen.queryByText(/Installation prerequisites/)).toBeNull();
  });

  it('starts open when the caller asks for it', () => {
    render(<TraceBar entries={entries} defaultOpen />);
    expect(screen.getByText(/Installation prerequisites/)).toBeTruthy();
  });

  // "View Thinking Process" five times is a spinner; each row has to say what it did.
  it('numbers the steps and labels each with its argument and result', () => {
    render(<TraceBar entries={entries} />);
    fireEvent.click(screen.getByRole('button', { name: /Trace/ }));
    expect(screen.getByText('search_corpus')).toBeTruthy();
    expect(screen.getByText(/sql server versions/)).toBeTruthy();
    expect(screen.getByText(/6 results/)).toBeTruthy();
    expect(screen.getByText('reasoning')).toBeTruthy();
  });

  it('counts failures in the summary', () => {
    render(
      <TraceBar
        entries={[{ kind: 'tool', call: tool({ result: 'boom', isError: true }) }]}
      />,
    );
    expect(screen.getByText('1 step · 1 tool · 1 corpus search · 1 failed')).toBeTruthy();
  });

  it('carries the token counts that used to sit in the window header', () => {
    render(
      <TraceBar
        entries={entries}
        usage={{ inputTokens: 12, outputTokens: 1296, cacheReadTokens: 112_700, cacheWriteTokens: 10_500 }}
      />,
    );
    expect(screen.getByText('12 in · 1,296 out · 112.7k cache read · 10.5k cache write')).toBeTruthy();
  });
});

describe('tool labelling', () => {
  it('strips the mcp server prefix whatever the alias is', () => {
    expect(shortName('mcp__oim__search_corpus')).toBe('search_corpus');
    expect(shortName('mcp__yvoke__get_section')).toBe('get_section');
    expect(shortName('Agent')).toBe('Agent');
  });

  it('picks the argument that names what the call was for', () => {
    expect(describeArgs(tool())).toBe('sql server versions');
    expect(
      describeArgs(tool({ name: 'mcp__yvoke__get_section', input: { heading_path: ['A', 'B'] } })),
    ).toBe('A › B');
  });

  // A tool this list has never heard of should still say something, not go blank.
  it('falls back to the first string argument for an unknown tool', () => {
    expect(describeArgs(tool({ name: 'mcp__yvoke__brand_new_tool', input: { whatever: 'a value' } }))).toBe(
      'a value',
    );
  });

  it('reports a verified-citations verdict as a good result', () => {
    const result = describeResult(
      tool({ name: 'mcp__yvoke__verify_citations', result: '1 of 1 citations verified' }),
    );
    expect(result).toEqual({ text: '1 of 1 verified', good: true });
  });

  it('says nothing rather than guessing when a result has no shape it understands', () => {
    expect(describeResult(tool({ result: 'ok' }))).toBeUndefined();
    expect(describeResult(tool())).toBeUndefined();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolCallCard } from '../../src/renderer/src/components/ToolCallCard';
import type { ToolCallInfo } from '../../src/shared/types';

afterEach(() => cleanup());

describe('ToolCallCard', () => {
  it('shows the short tool name and reveals the input when expanded', () => {
    const call: ToolCallInfo = {
      id: '1',
      name: 'mcp__oim__search_corpus',
      input: { query: 'roles' },
      result: 'done',
    };
    render(<ToolCallCard call={call} />);
    // The mcp__<server>__ prefix is stripped for display. The fixture deliberately uses a
    // PREVIOUS alias (`oim`) rather than the current one: the renderer strips with
    // /^mcp__[^_]+__/, and this is what proves that regex is not pinned to today's server name.
    expect(screen.getByText('search_corpus')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/"query": "roles"/)).toBeTruthy();
  });

  it('renders a clarifying-question card distinctly', () => {
    const call: ToolCallInfo = {
      id: '2',
      name: 'mcp__oim__ask_clarifying_question',
      input: { question: 'Which environment?', options: ['dev', 'prod'] },
    };
    render(<ToolCallCard call={call} />);
    expect(screen.getByText('Which environment?')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToolCallCard } from '../../src/renderer/src/components/ToolCallCard';
import type { ToolCallInfo } from '../../src/shared/types';

afterEach(() => cleanup());

describe('ToolCallCard', () => {
  // Ordinary tool calls are evidence and belong in the collapsed trace, not stacked above the
  // answer. ChatView routes them there; this component must not render a second copy inline.
  it('renders nothing for an ordinary tool call', () => {
    const call: ToolCallInfo = {
      id: '1',
      name: 'mcp__oim__search_corpus',
      input: { query: 'roles' },
      result: 'done',
    };
    const { container } = render(<ToolCallCard call={call} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a clarifying-question card distinctly', () => {
    const call: ToolCallInfo = {
      id: '2',
      // The fixture deliberately uses a PREVIOUS server alias (`oim`) rather than the current
      // one: the renderer strips with /^mcp__[^_]+__/, and this is what proves that regex is not
      // pinned to today's server name.
      name: 'mcp__oim__ask_clarifying_question',
      input: { question: 'Which environment?', options: ['dev', 'prod'] },
    };
    render(<ToolCallCard call={call} />);
    expect(screen.getByText('Which environment?')).toBeTruthy();
    expect(screen.getByText('Clarification required')).toBeTruthy();
  });

  it('shows the answer once a clarification has been provided', () => {
    const call: ToolCallInfo = {
      id: '3',
      name: 'mcp__yvoke__ask_clarifying_question',
      input: { question: 'Which environment?' },
      result: 'User answered: prod',
    };
    render(<ToolCallCard call={call} />);
    expect(screen.getByText('Clarification provided')).toBeTruthy();
    expect(screen.getByText(/prod/)).toBeTruthy();
  });

  it('renders a delegation as a sub-agent card', () => {
    const call: ToolCallInfo = {
      id: '4',
      name: 'Agent',
      subagentType: 'reviewer',
      input: { prompt: 'Check the draft' },
      result: 'APPROVED',
      verdict: { approved: true },
    };
    render(<ToolCallCard call={call} />);
    expect(screen.getByText('Reviewer')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });
});

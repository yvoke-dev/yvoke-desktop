// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('renders AskUserQuestion with structured options (label and description)', () => {
    const call: ToolCallInfo = {
      id: '5',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which database version?',
            options: [
              { label: '9.3.1', description: 'Legacy major version' },
              { label: '10.0', description: 'Current stable release' },
            ],
          },
        ],
      },
    };
    const { container } = render(
      <ToolCallCard call={call} activeClarificationId="5" onClarificationSubmit={() => {}} />,
    );
    expect(screen.getByText('Which database version?')).toBeTruthy();
    expect(screen.getByText('9.3.1')).toBeTruthy();
    expect(screen.getByText('Legacy major version')).toBeTruthy();
    expect(screen.getByText('10.0')).toBeTruthy();
    expect(screen.getByText('Current stable release')).toBeTruthy();

    const labels = container.querySelectorAll('.option-button-label');
    const descs = container.querySelectorAll('.option-button-desc');
    expect(labels.length).toBe(2);
    expect(descs.length).toBe(2);
  });

  it('clicking an option button submits option.label and prevents double-clicks', () => {
    let submitted = '';
    let callCount = 0;
    const onSubmit = (answer: string) => {
      submitted = answer;
      callCount++;
    };
    const call: ToolCallInfo = {
      id: '6',
      name: 'AskUserQuestion',
      input: {
        question: 'Select environment',
        options: [
          { label: 'prod', description: 'Production server' },
          { label: 'staging', description: 'Staging server' },
        ],
      },
    };
    const { container } = render(
      <ToolCallCard call={call} activeClarificationId="6" onClarificationSubmit={onSubmit} />,
    );

    const buttons = container.querySelectorAll<HTMLButtonElement>('.option-button');
    expect(buttons.length).toBe(2);

    // First click
    fireEvent.click(buttons[0]);
    expect(submitted).toBe('prod');
    expect(callCount).toBe(1);

    // Controls must now be disabled to prevent double clicks
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(true);
    const sendButton = container.querySelector<HTMLButtonElement>('button.primary')!;
    expect(sendButton.disabled).toBe(true);

    // Second click should be ignored
    fireEvent.click(buttons[0]);
    expect(callCount).toBe(1);
  });

  it('rejects whitespace-only custom input', () => {
    let callCount = 0;
    const onSubmit = () => {
      callCount++;
    };
    const call: ToolCallInfo = {
      id: '7',
      name: 'AskUserQuestion',
      input: {
        question: 'Any extra notes?',
      },
    };
    const { container } = render(
      <ToolCallCard call={call} activeClarificationId="7" onClarificationSubmit={onSubmit} />,
    );

    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    const sendButton = container.querySelector<HTMLButtonElement>('button.primary')!;

    fireEvent.change(input, { target: { value: '   ' } });
    // Send button disabled when whitespace only
    expect(sendButton.disabled).toBe(true);
    fireEvent.click(sendButton);
    expect(callCount).toBe(0);
  });
});

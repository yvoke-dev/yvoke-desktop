// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentCard } from '../../src/renderer/src/components/SubagentCard';
import type { ToolCallInfo } from '../../src/shared/types';

describe('SubagentCard', () => {
  afterEach(() => {
    cleanup();
  });

  describe('Specialist cards', () => {
    it('shows pending ellipsis when in progress', () => {
      const call: ToolCallInfo = {
        id: 'call-spec-1',
        name: 'Agent',
        subagentType: 'oim-manuals',
        input: { prompt: 'Find connector docs' },
      };
      render(<SubagentCard call={call} />);
      expect(screen.getByText('Specialist · oim-manuals')).toBeTruthy();
      expect(screen.getByText('…')).toBeTruthy();
      expect(screen.queryByText(/Approved/i)).toBeNull();
      expect(screen.queryByText(/Rejected/i)).toBeNull();
    });

    it('shows green ok status checkmark when finished', () => {
      const call: ToolCallInfo = {
        id: 'call-spec-1',
        name: 'Agent',
        subagentType: 'oim-manuals',
        input: { prompt: 'Find connector docs' },
        result: 'Here are the connector docs...',
      };
      const { container } = render(<SubagentCard call={call} />);
      const status = container.querySelector('.tool-status.ok');
      expect(status).not.toBeNull();
      expect(screen.queryByText(/Approved/i)).toBeNull();
    });
  });

  describe('Reviewer cards', () => {
    it('shows pending ellipsis while reviewer is in progress', () => {
      const call: ToolCallInfo = {
        id: 'call-rev-1',
        name: 'Agent',
        subagentType: 'reviewer',
        input: { prompt: 'Review candidate answer' },
      };
      render(<SubagentCard call={call} />);
      expect(screen.getByText('Reviewer')).toBeTruthy();
      expect(screen.getByText('…')).toBeTruthy();
      expect(screen.queryByText(/Approved/i)).toBeNull();
      expect(screen.queryByText(/Rejected/i)).toBeNull();
    });

    it('shows Rejected badge and error status when verdict is approved: false', () => {
      const call: ToolCallInfo = {
        id: 'call-rev-1',
        name: 'Agent',
        subagentType: 'reviewer',
        input: { prompt: 'Review candidate answer' },
        result: 'REJECTED\nMissing source citations.',
        verdict: { approved: false, feedback: 'Missing source citations.' },
      };
      const { container } = render(<SubagentCard call={call} />);
      expect(screen.getByText('Rejected')).toBeTruthy();
      const status = container.querySelector('.tool-status.error');
      expect(status).not.toBeNull();
      expect(container.querySelector('.tool-status.ok')).toBeNull();
    });

    it('shows Approved badge and ok status when verdict is approved: true', () => {
      const call: ToolCallInfo = {
        id: 'call-rev-2',
        name: 'Agent',
        subagentType: 'reviewer',
        input: { prompt: 'Review revised candidate answer' },
        result: 'APPROVED\nAll claims verified.',
        verdict: { approved: true },
      };
      const { container } = render(<SubagentCard call={call} />);
      expect(screen.getByText('Approved')).toBeTruthy();
      const status = container.querySelector('.tool-status.ok');
      expect(status).not.toBeNull();
      expect(container.querySelector('.tool-status.error')).toBeNull();
    });

    it('falls back to parsing verdict from result if call.verdict is undefined on a rejected turn', () => {
      const call: ToolCallInfo = {
        id: 'call-rev-1',
        name: 'Agent',
        subagentType: 'reviewer',
        input: { prompt: 'Review candidate answer' },
        result: 'REJECTED\nUnsupported claims found.',
        // verdict property deliberately not yet populated
      };
      const { container } = render(<SubagentCard call={call} />);
      // MUST NOT show ok checkmark!
      expect(container.querySelector('.tool-status.ok')).toBeNull();
      expect(screen.getByText('Rejected')).toBeTruthy();
      expect(container.querySelector('.tool-status.error')).not.toBeNull();
    });

    it('shows error status and no approved badge if reviewer returned unparseable text without verdict', () => {
      const call: ToolCallInfo = {
        id: 'call-rev-1',
        name: 'Agent',
        subagentType: 'reviewer',
        input: { prompt: 'Review candidate answer' },
        result: 'I am thinking about this but forgot to state a verdict.',
      };
      const { container } = render(<SubagentCard call={call} />);
      expect(container.querySelector('.tool-status.ok')).toBeNull();
      expect(screen.queryByText('Approved')).toBeNull();
      expect(container.querySelector('.tool-status.error')).not.toBeNull();
    });
  });
});

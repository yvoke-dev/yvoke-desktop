import React, { useState } from 'react';
import type { CitationRef, ToolCallInfo } from '../../../shared/types';
import { Markdown } from './Markdown';

function shortName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

function label(subagentType?: string): { icon: string; title: string } {
  if (subagentType === 'reviewer') return { icon: '🧑‍⚖️', title: 'Reviewer' };
  if (subagentType === 'orchestrator') return { icon: '🧭', title: 'Orchestrator' };
  return { icon: '🔬', title: `Specialist · ${subagentType ?? '?'}` };
}

/**
 * Activity card for a delegation (the Agent tool). Shows which specialist/reviewer was consulted, the
 * sub-question, an optional nested trace of the sub-agent's own tool calls, and the returned answer /
 * reviewer verdict. Used in orchestrator mode in place of a raw tool card.
 */
export function SubagentCard(props: {
  call: ToolCallInfo;
  onCitation?: (ref: CitationRef) => void;
}): React.JSX.Element {
  const { call, onCitation } = props;
  const [open, setOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  const done = call.result !== undefined;
  const { icon, title } = label(call.subagentType);
  const input = (call.input ?? {}) as { prompt?: string; description?: string };
  const question = input.prompt ?? input.description ?? '';
  const verdict = call.verdict;
  const isReviewer = call.subagentType === 'reviewer';

  const statusIcon = call.isError
    ? '⚠'
    : done
      ? verdict
        ? verdict.approved
          ? '✅'
          : '⛔'
        : '✓'
      : '⏳';

  const innerCalls = (call.subagentBlocks ?? []).flatMap((b) => b.toolCalls ?? []);

  return (
    <div className={`subagent-card ${call.isError ? 'error' : ''}`}>
      <button className="subagent-card-header" onClick={() => setOpen((o) => !o)}>
        <span className="subagent-icon">{icon}</span>
        <span className="subagent-title">{title}</span>
        {verdict && (
          <span className={`verdict-badge ${verdict.approved ? 'approved' : 'rejected'}`}>
            {verdict.approved ? 'Approved' : 'Rejected'}
          </span>
        )}
        <span className="tool-status">{statusIcon}</span>
        <span className="tool-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="subagent-card-body">
          {question && (
            <div className="tool-section">
              <div className="tool-section-label">Question</div>
              <div className="subagent-question">{question}</div>
            </div>
          )}

          {innerCalls.length > 0 && (
            <div className="tool-section">
              <button className="subagent-trace-toggle" onClick={() => setTraceOpen((o) => !o)}>
                {traceOpen ? '▾' : '▸'} Work — {innerCalls.length} tool call{innerCalls.length === 1 ? '' : 's'}
              </button>
              {traceOpen && (
                <ul className="subagent-trace">
                  {innerCalls.map((c) => (
                    <li key={c.id} className={c.isError ? 'error' : ''}>
                      <span className="tool-status">{c.isError ? '⚠' : c.result !== undefined ? '✓' : '⏳'}</span>
                      {shortName(c.name)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {done && (
            <div className="tool-section">
              <div className="tool-section-label">{isReviewer ? 'Verdict' : 'Answer'}</div>
              <Markdown content={call.result ?? ''} onCitation={onCitation} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

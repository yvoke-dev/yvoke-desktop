import React, { useState } from 'react';
import type { CitationRef, ToolCallInfo } from '../../../shared/types';
import { Markdown } from './Markdown';
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CompassIcon,
  ReviewerIcon,
  SpecialistIcon,
} from './icons';
import { shortName } from './toolNames';

function roleLabel(subagentType?: string): { icon: React.JSX.Element; title: string } {
  if (subagentType === 'reviewer') return { icon: <ReviewerIcon size={14} />, title: 'Reviewer' };
  if (subagentType === 'orchestrator') return { icon: <CompassIcon size={14} />, title: 'Orchestrator' };
  return { icon: <SpecialistIcon size={14} />, title: `Specialist · ${subagentType ?? '?'}` };
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
  const { icon, title } = roleLabel(call.subagentType);
  const input = (call.input ?? {}) as { prompt?: string; description?: string };
  const question = input.prompt ?? input.description ?? '';
  const verdict = call.verdict;
  const isReviewer = call.subagentType === 'reviewer';

  const status = call.isError ? (
    <span className="tool-status error">
      <AlertIcon size={13} />
    </span>
  ) : done ? (
    <span className={`tool-status ${verdict && !verdict.approved ? 'error' : 'ok'}`}>
      {verdict && !verdict.approved ? <CloseIcon size={13} /> : <CheckIcon size={12} />}
    </span>
  ) : (
    <span className="tool-status">…</span>
  );

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
        {status}
        <span className="tool-toggle">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {open && (
        <div className="subagent-card-body">
          {question && (
            <div>
              <div className="tool-section-label">Question</div>
              <div className="subagent-question">{question}</div>
            </div>
          )}

          {innerCalls.length > 0 && (
            <div>
              <button className="subagent-trace-toggle" onClick={() => setTraceOpen((o) => !o)}>
                {traceOpen ? <ChevronDownIcon size={11} /> : <ChevronRightIcon size={11} />}
                Work — {innerCalls.length} tool call{innerCalls.length === 1 ? '' : 's'}
              </button>
              {traceOpen && (
                <ul className="subagent-trace">
                  {innerCalls.map((c) => (
                    <li key={c.id} className={c.isError ? 'error' : ''}>
                      <span className={`tool-status ${c.isError ? 'error' : c.result !== undefined ? 'ok' : ''}`}>
                        {c.isError ? <AlertIcon size={11} /> : c.result !== undefined ? <CheckIcon size={10} /> : '…'}
                      </span>
                      {shortName(c.name)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {done && (
            <div>
              <div className="tool-section-label">{isReviewer ? 'Verdict' : 'Answer'}</div>
              <Markdown content={call.result ?? ''} onCitation={onCitation} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

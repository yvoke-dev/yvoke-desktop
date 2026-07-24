import React, { useState } from 'react';
import type { CitationRef, ToolCallInfo } from '../../../shared/types';
import { SubagentCard } from './SubagentCard';

function shortName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

/** Collapsible activity card for one tool invocation within a turn. */
export function ToolCallCard(props: {
  call: ToolCallInfo;
  onClarificationSubmit?: (answer: string) => void;
  activeClarificationId?: string;
  onCitation?: (ref: CitationRef) => void;
}): React.JSX.Element {
  const { call, onClarificationSubmit, activeClarificationId, onCitation } = props;
  const [open, setOpen] = useState(false);
  const [customAnswer, setCustomAnswer] = useState('');

  // Orchestrator mode: a delegation (the Agent tool) renders as a specialist/reviewer card.
  if (call.name === 'Agent') {
    return <SubagentCard call={call} onCitation={onCitation} />;
  }

  const isClarifying = shortName(call.name) === 'ask_clarifying_question';
  const done = call.result !== undefined;

  const getAnswerText = (result: string | undefined): string => {
    if (!result) return '';
    const prefix = 'User answered: ';
    if (result.startsWith(prefix)) {
      return result.substring(prefix.length);
    }
    if (result === "Clarifying question asked successfully. Waiting for user's response.") {
      return 'Answered (response saved in history)';
    }
    return result;
  };

  if (isClarifying) {
    const inputObj = (call.input ?? {}) as { question?: unknown; options?: unknown };
    const question = typeof inputObj.question === 'string' ? inputObj.question : '';
    const options = Array.isArray(inputObj.options) ? inputObj.options.map(String) : [];
    const isActive = !done && activeClarificationId === call.id;

    if (done) {
      const answerText = getAnswerText(call.result);
      return (
        <div className="clarifying-question-card answered">
          <div className="card-header">
            <span className="card-icon">❓</span>
            <span className="card-title">Clarification Provided</span>
          </div>
          <div className="card-question">{question}</div>
          <div className="clarified-badge">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ marginRight: 2 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Clarified: "{answerText}"
          </div>
        </div>
      );
    }

    return (
      <div className="clarifying-question-card">
        <div className="card-header">
          <span className="card-icon">❓</span>
          <span className="card-title">Clarification Required</span>
        </div>
        <div className="card-question">{question}</div>
        {isActive && onClarificationSubmit ? (
          <>
            {options.length > 0 && (
              <div className="card-options">
                {options.map((option, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="option-button"
                    onClick={() => onClarificationSubmit(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <div className="card-custom-input">
              <input
                type="text"
                placeholder={options.length > 0 ? 'Or type a custom answer...' : 'Type your answer...'}
                value={customAnswer}
                onChange={(e) => setCustomAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customAnswer.trim()) {
                    onClarificationSubmit(customAnswer);
                    setCustomAnswer('');
                  }
                }}
              />
              <button
                type="button"
                className="custom-send-button"
                disabled={!customAnswer.trim()}
                onClick={() => {
                  onClarificationSubmit(customAnswer);
                  setCustomAnswer('');
                }}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: 13, fontStyle: 'italic' }}>
            Awaiting clarification...
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`tool-card ${call.isError ? 'error' : ''}`}>
      <button className="tool-card-header" onClick={() => setOpen((o) => !o)}>
        <span className="tool-status">{call.isError ? '⚠' : done ? '✓' : '⏳'}</span>
        <span className="tool-name">{shortName(call.name)}</span>
        <span className="tool-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-card-body">
          <div className="tool-section">
            <div className="tool-section-label">Input</div>
            <pre>{JSON.stringify(call.input, null, 2)}</pre>
          </div>
          {done && (
            <div className="tool-section">
              <div className="tool-section-label">Result</div>
              <pre>{(call.result ?? '').slice(0, 4000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

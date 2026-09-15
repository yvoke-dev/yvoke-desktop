import React, { useState } from 'react';
import type { CitationRef, ToolCallInfo } from '../../../shared/types';
import { isClarificationTool, normalizeClarifyingInput } from '../../../shared/types';
import { SubagentCard } from './SubagentCard';
import { Markdown } from './Markdown';
import { CheckIcon, HelpIcon, SendIcon } from './icons';

/**
 * The two tool calls that stay inline in the transcript rather than folding into the trace.
 *
 * Everything else a turn calls is evidence and belongs in TraceBar — but a clarifying question is
 * a control the user has to answer before the turn can continue, and a delegation is the substance
 * of an orchestrated turn, not its working-out. Both would be lost inside a collapsed bar.
 */
export function ToolCallCard(props: {
  call: ToolCallInfo;
  onClarificationSubmit?: (answer: string) => void;
  activeClarificationId?: string;
  onCitation?: (ref: CitationRef) => void;
}): React.JSX.Element | null {
  const { call, onClarificationSubmit, activeClarificationId, onCitation } = props;
  const [customAnswer, setCustomAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Orchestrator mode: a delegation (the Agent tool) renders as a specialist/reviewer card.
  if (call.name === 'Agent') {
    return <SubagentCard call={call} onCitation={onCitation} />;
  }

  if (!isClarificationTool(call.name)) {
    // Not an inline call — ChatView routes these into the trace instead.
    return null;
  }

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

  const { question, options } = normalizeClarifyingInput(call.input);
  const isActive = !done && activeClarificationId === call.id;

  const handleSubmit = (answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed || submitting || !onClarificationSubmit) return;
    setSubmitting(true);
    onClarificationSubmit(trimmed);
  };

  if (done) {
    const answerText = getAnswerText(call.result);
    return (
      <div className="clarifying-question-card answered">
        <div className="card-header">
          <HelpIcon size={13} />
          <span className="card-title">Clarification provided</span>
        </div>
        <div className="card-question">
          <Markdown content={question} />
        </div>
        <div className="clarified-badge">
          <CheckIcon size={12} />“{answerText}”
        </div>
      </div>
    );
  }

  return (
    <div className="clarifying-question-card">
      <div className="card-header">
        <HelpIcon size={13} />
        <span className="card-title">Clarification required</span>
      </div>
      <div className="card-question">
        <Markdown content={question} />
      </div>
      {isActive && onClarificationSubmit ? (
        <>
          {options.length > 0 && (
            <div className="card-options">
              {options.map((option, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="option-button"
                  disabled={submitting}
                  onClick={() => handleSubmit(option.label)}
                >
                  <span className="option-button-label">{option.label}</span>
                  {option.description && (
                    <span className="option-button-desc">{option.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="card-custom-input">
            <input
              type="text"
              placeholder={options.length > 0 ? 'Or type a custom answer…' : 'Type your answer…'}
              value={customAnswer}
              disabled={submitting}
              onChange={(e) => setCustomAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customAnswer.trim()) {
                  handleSubmit(customAnswer);
                  setCustomAnswer('');
                }
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={submitting || !customAnswer.trim()}
              onClick={() => {
                handleSubmit(customAnswer);
                setCustomAnswer('');
              }}
            >
              Send
              <SendIcon size={12} />
            </button>
          </div>
        </>
      ) : (
        <div className="awaiting-note">Awaiting clarification…</div>
      )}
    </div>
  );
}

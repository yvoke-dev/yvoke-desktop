import React, { useState } from 'react';
import type { CitationRef, ToolCallInfo } from '../../../shared/types';
import { SubagentCard } from './SubagentCard';
import { CheckIcon, HelpIcon, SendIcon } from './icons';
import { shortName } from './toolNames';

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

  // Orchestrator mode: a delegation (the Agent tool) renders as a specialist/reviewer card.
  if (call.name === 'Agent') {
    return <SubagentCard call={call} onCitation={onCitation} />;
  }

  if (shortName(call.name) !== 'ask_clarifying_question') {
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

  const inputObj = (call.input ?? {}) as { question?: unknown; options?: unknown };
  const question = typeof inputObj.question === 'string' ? inputObj.question : '';
  const options = Array.isArray(inputObj.options) ? inputObj.options.map(String) : [];
  const isActive = !done && activeClarificationId === call.id;

  if (done) {
    const answerText = getAnswerText(call.result);
    return (
      <div className="clarifying-question-card answered">
        <div className="card-header">
          <HelpIcon size={13} />
          <span className="card-title">Clarification provided</span>
        </div>
        <div className="card-question">{question}</div>
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
              placeholder={options.length > 0 ? 'Or type a custom answer…' : 'Type your answer…'}
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
              className="primary"
              disabled={!customAnswer.trim()}
              onClick={() => {
                onClarificationSubmit(customAnswer);
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

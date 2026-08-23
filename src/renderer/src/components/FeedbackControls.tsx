import React, { useState } from 'react';
import type { ChatMessage } from '../../../shared/types';
import { ThumbsDownIcon, ThumbsUpIcon } from './icons';

/**
 * Thumbs up/down per assistant message (Req. 8). Negative feedback requires a
 * non-empty comment before submit; positive feedback offers an optional one.
 */
export function FeedbackControls(props: {
  message: ChatMessage;
  onFeedback: (messageLocalId: string, rating: 1 | -1, comment?: string) => Promise<void>;
}): React.JSX.Element {
  const { message, onFeedback } = props;
  const [dialogRating, setDialogRating] = useState<1 | -1 | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = message.feedback;

  const openDialog = (rating: 1 | -1): void => {
    setDialogRating(rating);
    setComment(current?.comment ?? '');
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (dialogRating == null) return;
    if (dialogRating === -1 && comment.trim().length === 0) {
      setError('Please describe what was wrong — a comment is required for negative feedback.');
      return;
    }
    setBusy(true);
    try {
      await onFeedback(message.localId, dialogRating, comment.trim() || undefined);
      setDialogRating(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="feedback">
      <button
        className={`icon-button ${current?.rating === 1 ? 'active-positive' : ''}`}
        data-tip="Good answer"
        onClick={() => openDialog(1)}
      >
        <ThumbsUpIcon size={14} />
      </button>
      <button
        className={`icon-button ${current?.rating === -1 ? 'active-negative' : ''}`}
        data-tip="Bad answer (comment required)"
        onClick={() => openDialog(-1)}
      >
        <ThumbsDownIcon size={14} />
      </button>

      {dialogRating != null && (
        <div className="feedback-dialog-backdrop" onClick={() => !busy && setDialogRating(null)}>
          <div className="feedback-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{dialogRating === 1 ? 'Good answer' : 'What was wrong?'}</h3>
            <textarea
              autoFocus
              rows={4}
              value={comment}
              placeholder={
                dialogRating === 1 ? 'Optional comment…' : 'Required: describe what was wrong with this answer'
              }
              onChange={(e) => {
                setComment(e.target.value);
                setError(null);
              }}
            />
            {error && <div className="dialog-error">{error}</div>}
            <div className="dialog-actions">
              <button onClick={() => setDialogRating(null)} disabled={busy}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => void submit()}
                disabled={busy || (dialogRating === -1 && comment.trim().length === 0)}
              >
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

import React, { useCallback, useId, useRef, useState } from 'react';
import {
  formatSignInError,
  useBrowserSignInFlow,
  type BrowserSignInResetReason,
} from './useBrowserSignInFlow';

export interface ClaudeSignInController {
  signingIn: boolean;
  cancelling: boolean;
  copyingUrl: boolean;
  copiedUrl: boolean;
  altBrowserOpen: boolean;
  codeDraft: string;
  submittingCode: boolean;
  error: string | null;
  successCount: number;
  startSignIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  toggleAltBrowser: () => void;
  copySignInUrl: () => Promise<void>;
  setCodeDraft: (value: string) => void;
  submitAuthCode: () => Promise<void>;
  clearError?: () => void;
}

export interface UseClaudeSignInOptions {
  onSignedIn?: (account?: string) => void | Promise<void>;
}

const COPY_FEEDBACK_MS = 1_500;
const UNAVAILABLE_URL_MESSAGE = 'Sign-in link is not available. Cancel sign-in and try again.';

export function useClaudeSignIn(options?: UseClaudeSignInOptions): ClaudeSignInController {
  const [copyingUrl, setCopyingUrl] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [altBrowserOpen, setAltBrowserOpen] = useState(false);
  const [codeDraft, setCodeDraftState] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);

  const copyingUrlRef = useRef(false);
  const submittingCodeRef = useRef(false);
  const codeDraftRef = useRef('');
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopiedTimer = useCallback(() => {
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  }, []);

  const flow = useBrowserSignInFlow({
    start: () => window.api.claudeSignIn(),
    cancel: () => window.api.cancelClaudeSignIn(),
    onSignedIn: options?.onSignedIn,
    onBeforeStart: () => {
      clearCopiedTimer();
      submittingCodeRef.current = false;
      codeDraftRef.current = '';
      setSubmittingCode(false);
      setAltBrowserOpen(false);
      setCodeDraftState('');
      setCopiedUrl(false);
    },
    onReset: (reason: BrowserSignInResetReason) => {
      if (reason === 'unmounted') {
        submittingCodeRef.current = false;
        return;
      }
      submittingCodeRef.current = false;
      clearCopiedTimer();
      setSubmittingCode(false);
      setAltBrowserOpen(false);
      setCopiedUrl(false);
      if (reason === 'signed_in' || reason === 'cancelled') {
        codeDraftRef.current = '';
        setCodeDraftState('');
      }
    },
    onUnmount: clearCopiedTimer,
  });

  const { attemptIdRef, mountedRef, signingInRef, cancellingRef, setError } = flow;

  const setCodeDraft = useCallback((value: string) => {
    codeDraftRef.current = value;
    setCodeDraftState(value);
  }, []);

  const toggleAltBrowser = useCallback(() => {
    if (!signingInRef.current || cancellingRef.current) return;
    setAltBrowserOpen((open) => !open);
  }, [signingInRef, cancellingRef]);

  const copySignInUrl = useCallback(async () => {
    if (!signingInRef.current || copyingUrlRef.current || cancellingRef.current) return;
    const copyAttemptId = attemptIdRef.current;
    copyingUrlRef.current = true;
    setCopyingUrl(true);

    try {
      const copied = await window.api.copyClaudeSignInUrl();
      if (!mountedRef.current) {
        copyingUrlRef.current = false;
        return;
      }
      copyingUrlRef.current = false;
      if (attemptIdRef.current !== copyAttemptId || !signingInRef.current) {
        setCopyingUrl(false);
        return;
      }

      clearCopiedTimer();
      if (copied) {
        setCopyingUrl(false);
        setError(null);
        setCopiedUrl(true);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null;
          if (mountedRef.current) setCopiedUrl(false);
        }, COPY_FEEDBACK_MS);
      } else {
        setCopyingUrl(false);
        setCopiedUrl(false);
        setError(UNAVAILABLE_URL_MESSAGE);
      }
    } catch (err) {
      if (!mountedRef.current) {
        copyingUrlRef.current = false;
        return;
      }
      copyingUrlRef.current = false;
      if (attemptIdRef.current !== copyAttemptId || !signingInRef.current) {
        setCopyingUrl(false);
        return;
      }
      clearCopiedTimer();
      setCopyingUrl(false);
      setCopiedUrl(false);
      setError(formatSignInError(err));
    }
  }, [attemptIdRef, cancellingRef, clearCopiedTimer, mountedRef, setError, signingInRef]);

  const submitAuthCode = useCallback(async () => {
    const currentDraft = codeDraftRef.current;
    if (
      currentDraft.trim().length === 0 ||
      !signingInRef.current ||
      submittingCodeRef.current ||
      cancellingRef.current
    ) {
      return;
    }
    const submitAttemptId = attemptIdRef.current;
    submittingCodeRef.current = true;
    setSubmittingCode(true);

    try {
      const res = await window.api.submitClaudeAuthCode(currentDraft);
      if (!mountedRef.current) {
        submittingCodeRef.current = false;
        return;
      }
      submittingCodeRef.current = false;
      if (attemptIdRef.current !== submitAttemptId || !signingInRef.current) {
        setSubmittingCode(false);
        return;
      }

      if (res.accepted) {
        codeDraftRef.current = '';
        setSubmittingCode(false);
        setCodeDraftState('');
        setError(null);
      } else {
        setSubmittingCode(false);
        setError(res.message);
      }
    } catch (err) {
      if (!mountedRef.current) {
        submittingCodeRef.current = false;
        return;
      }
      submittingCodeRef.current = false;
      if (attemptIdRef.current !== submitAttemptId || !signingInRef.current) {
        setSubmittingCode(false);
        return;
      }
      setSubmittingCode(false);
      setError(formatSignInError(err));
    }
  }, [attemptIdRef, cancellingRef, mountedRef, setError, signingInRef]);

  return {
    signingIn: flow.signingIn,
    cancelling: flow.cancelling,
    copyingUrl,
    copiedUrl,
    altBrowserOpen,
    codeDraft,
    submittingCode,
    error: flow.error,
    successCount: flow.successCount,
    startSignIn: flow.startSignIn,
    cancelSignIn: flow.cancelSignIn,
    toggleAltBrowser,
    copySignInUrl,
    setCodeDraft,
    submitAuthCode,
    clearError: flow.clearError,
  };
}

export interface ClaudeSignInControlsProps {
  controller: ClaudeSignInController;
  variant?: 'banner' | 'inline';
  disabled?: boolean;
}

export function ClaudeSignInControls(props: ClaudeSignInControlsProps): React.JSX.Element {
  const { controller: ctrl, variant = 'inline', disabled = false } = props;

  const baseId = useId();
  const panelId = `${baseId}-alt-panel`;
  const hintId = `${baseId}-alt-hint`;
  const errorId = `${baseId}-error`;

  const idleButtonClass =
    variant === 'banner'
      ? 'primary small banner-action'
      : 'button secondary cred-inline-btn';
  const cancelButtonClass =
    variant === 'banner' ? 'small' : 'button secondary cred-inline-btn';

  return (
    <div
      className={`claude-signin-controls is-${variant}${ctrl.signingIn ? ' is-waiting' : ''}${
        ctrl.altBrowserOpen ? ' is-open' : ''
      }`}
    >
      {!ctrl.signingIn ? (
        <button
          type="button"
          className={idleButtonClass}
          disabled={disabled || ctrl.signingIn}
          onClick={() => void ctrl.startSignIn()}
        >
          Sign in to Claude
        </button>
      ) : (
        <div className="claude-signin-waiting">
          <span className="claude-signin-status">Finish signing in in your browser…</span>
          <button
            type="button"
            className="claude-alt-toggle"
            aria-expanded={ctrl.altBrowserOpen}
            aria-controls={panelId}
            disabled={ctrl.cancelling}
            onClick={ctrl.toggleAltBrowser}
          >
            Use another browser
          </button>
          <button
            type="button"
            className={cancelButtonClass}
            disabled={ctrl.cancelling}
            onClick={() => void ctrl.cancelSignIn()}
          >
            Cancel sign-in
          </button>
        </div>
      )}

      {ctrl.signingIn && ctrl.altBrowserOpen && (
        <div id={panelId} className="claude-alt-panel">
          <p id={hintId} className="claude-alt-hint">
            Copy the sign-in link into the browser where you use Claude, then paste the
            authorization code shown at the end.
          </p>
          <div className="claude-alt-actions">
            <button
              type="button"
              className="button secondary claude-copy-btn"
              disabled={ctrl.copyingUrl || ctrl.cancelling}
              onClick={() => void ctrl.copySignInUrl()}
            >
              Copy sign-in link
            </button>
            {ctrl.copiedUrl && (
              <span className="cred-badge verified claude-copied-badge" role="status">
                Copied
              </span>
            )}
            <div className="claude-code-row">
              <input
                type="text"
                className="claude-code-input"
                aria-label="Authorization code"
                aria-invalid={ctrl.error ? true : undefined}
                aria-describedby={ctrl.error ? `${hintId} ${errorId}` : hintId}
                placeholder="Paste code (code#state)…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={ctrl.codeDraft}
                disabled={ctrl.submittingCode || ctrl.cancelling}
                onChange={(e) => ctrl.setCodeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (
                      ctrl.codeDraft.trim().length > 0 &&
                      !ctrl.submittingCode &&
                      !ctrl.cancelling
                    ) {
                      void ctrl.submitAuthCode();
                    }
                  }
                }}
              />
              <button
                type="button"
                className="primary small claude-submit-btn"
                disabled={
                  ctrl.codeDraft.trim().length === 0 || ctrl.submittingCode || ctrl.cancelling
                }
                onClick={() => void ctrl.submitAuthCode()}
              >
                Submit code
              </button>
            </div>
          </div>
        </div>
      )}

      {ctrl.error && (
        <div id={errorId} className="claude-signin-error" role="alert">
          {ctrl.error}
        </div>
      )}
    </div>
  );
}

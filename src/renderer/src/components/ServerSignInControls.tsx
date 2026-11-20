import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface ServerSignInController {
  signingIn: boolean;
  cancelling: boolean;
  error: string | null;
  successCount: number;
  startSignIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  clearError: () => void;
}

export interface UseServerSignInOptions {
  onSignedIn?: (account?: string) => void | Promise<void>;
}

function formatSignInError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : 'Sign-in failed. Please try again.';
}

export function useServerSignIn(options?: UseServerSignInOptions): ServerSignInController {
  const [signingIn, setSigningIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState(0);

  const mountedRef = useRef(true);
  const onSignedInRef = useRef(options?.onSignedIn);
  onSignedInRef.current = options?.onSignedIn;

  const attemptIdRef = useRef(0);
  const signingInRef = useRef(false);
  const cancellingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const startSignIn = useCallback(async () => {
    if (signingInRef.current) return;
    const attemptId = ++attemptIdRef.current;
    signingInRef.current = true;
    cancellingRef.current = false;

    setSigningIn(true);
    setCancelling(false);
    setError(null);

    try {
      const result = await window.api.serverSignIn();
      if (!mountedRef.current) {
        signingInRef.current = false;
        cancellingRef.current = false;
        return;
      }
      if (attemptIdRef.current !== attemptId) return;

      attemptIdRef.current += 1;
      signingInRef.current = false;
      cancellingRef.current = false;

      if (result.status === 'signed_in') {
        setSigningIn(false);
        setCancelling(false);
        setError(null);
        setSuccessCount((c) => c + 1);
        try {
          const maybePromise = onSignedInRef.current?.(result.account);
          if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
            void (maybePromise as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          // Keep sign-in state clean if callback throws synchronously.
        }
      } else if (result.status === 'cancelled') {
        setSigningIn(false);
        setCancelling(false);
        setError(null);
      } else {
        setSigningIn(false);
        setCancelling(false);
        setError(result.message);
      }
    } catch (err) {
      if (!mountedRef.current) {
        signingInRef.current = false;
        cancellingRef.current = false;
        return;
      }
      if (attemptIdRef.current !== attemptId) return;

      attemptIdRef.current += 1;
      signingInRef.current = false;
      cancellingRef.current = false;
      setSigningIn(false);
      setCancelling(false);
      setError(formatSignInError(err));
    }
  }, []);

  const cancelSignIn = useCallback(async () => {
    if (!signingInRef.current || cancellingRef.current) return;
    const cancelAttemptId = attemptIdRef.current;
    cancellingRef.current = true;
    setCancelling(true);

    try {
      const cancelled = await window.api.cancelServerSignIn();
      if (!mountedRef.current) {
        cancellingRef.current = false;
        return;
      }
      cancellingRef.current = false;
      if (attemptIdRef.current !== cancelAttemptId) {
        setCancelling(false);
        return;
      }

      signingInRef.current = false;

      if (cancelled) {
        attemptIdRef.current += 1;
        setCancelling(false);
        setSigningIn(false);
        setError(null);
      } else {
        // Session already settled in main — reconcile busy flags without invalidating an
        // about-to-land startSignIn resolution or wiping an error it sets.
        setCancelling(false);
        setSigningIn(false);
      }
    } catch (err) {
      if (!mountedRef.current) {
        cancellingRef.current = false;
        return;
      }
      cancellingRef.current = false;
      if (attemptIdRef.current !== cancelAttemptId) {
        setCancelling(false);
        return;
      }
      setCancelling(false);
      setError(formatSignInError(err));
    }
  }, []);

  return {
    signingIn,
    cancelling,
    error,
    successCount,
    startSignIn,
    cancelSignIn,
    clearError,
  };
}

export interface ServerSignInControlsProps {
  controller?: ServerSignInController;
  variant?: 'banner' | 'settings' | 'inline';
  disabled?: boolean;
}

export function ServerSignInControls(props: ServerSignInControlsProps): React.JSX.Element {
  const { variant = 'inline', disabled = false } = props;
  const fallbackController = useServerSignIn();
  const ctrl = props.controller ?? fallbackController;

  const idleButtonClass =
    variant === 'banner'
      ? 'primary small banner-action'
      : 'button secondary cred-inline-btn';
  const cancelButtonClass =
    variant === 'banner' ? 'small' : 'button secondary cred-inline-btn';

  return (
    <div
      className={`server-signin-controls is-${variant}${ctrl.signingIn ? ' is-waiting' : ''}`}
    >
      {!ctrl.signingIn ? (
        <button
          type="button"
          className={idleButtonClass}
          disabled={disabled || ctrl.signingIn}
          onClick={() => void ctrl.startSignIn()}
        >
          Sign in to Yvoke
        </button>
      ) : (
        <div className="server-signin-waiting">
          <span className="server-signin-status">Finish signing in in your browser…</span>
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

      {ctrl.error && (
        <div className="server-signin-error" role="alert">
          {ctrl.error}
        </div>
      )}
    </div>
  );
}

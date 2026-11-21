import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserSignInResult } from '../../../shared/types';

export type BrowserSignInResetReason =
  | 'signed_in'
  | 'cancelled'
  | 'error'
  | 'stale_cancel'
  | 'unmounted';

export interface UseBrowserSignInFlowOptions {
  start: () => Promise<BrowserSignInResult>;
  cancel: () => Promise<boolean>;
  onSignedIn?: (account?: string) => void | Promise<void>;
  onBeforeStart?: () => void;
  onReset?: (reason: BrowserSignInResetReason) => void;
  onUnmount?: () => void;
}

export interface BrowserSignInFlow {
  signingIn: boolean;
  cancelling: boolean;
  error: string | null;
  successCount: number;
  attemptIdRef: React.RefObject<number>;
  mountedRef: React.RefObject<boolean>;
  signingInRef: React.RefObject<boolean>;
  cancellingRef: React.RefObject<boolean>;
  startSignIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  clearError: () => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function formatSignInError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : 'Sign-in failed. Please try again.';
}

export function useBrowserSignInFlow(options: UseBrowserSignInFlowOptions): BrowserSignInFlow {
  const [signingIn, setSigningIn] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState(0);

  const mountedRef = useRef(true);
  const attemptIdRef = useRef(0);
  const signingInRef = useRef(false);
  const cancellingRef = useRef(false);

  const startRef = useRef(options.start);
  startRef.current = options.start;
  const cancelRef = useRef(options.cancel);
  cancelRef.current = options.cancel;
  const onSignedInRef = useRef(options.onSignedIn);
  onSignedInRef.current = options.onSignedIn;
  const onBeforeStartRef = useRef(options.onBeforeStart);
  onBeforeStartRef.current = options.onBeforeStart;
  const onResetRef = useRef(options.onReset);
  onResetRef.current = options.onReset;
  const onUnmountRef = useRef(options.onUnmount);
  onUnmountRef.current = options.onUnmount;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onUnmountRef.current?.();
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
    onBeforeStartRef.current?.();

    setSigningIn(true);
    setCancelling(false);
    setError(null);

    try {
      const result = await startRef.current();
      if (!mountedRef.current) {
        signingInRef.current = false;
        cancellingRef.current = false;
        onResetRef.current?.('unmounted');
        return;
      }
      if (attemptIdRef.current !== attemptId) return;

      attemptIdRef.current += 1;
      signingInRef.current = false;
      cancellingRef.current = false;

      if (result.status === 'signed_in') {
        onResetRef.current?.('signed_in');
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
        onResetRef.current?.('cancelled');
        setSigningIn(false);
        setCancelling(false);
        setError(null);
      } else {
        onResetRef.current?.('error');
        setSigningIn(false);
        setCancelling(false);
        setError(result.message);
      }
    } catch (err) {
      if (!mountedRef.current) {
        signingInRef.current = false;
        cancellingRef.current = false;
        onResetRef.current?.('unmounted');
        return;
      }
      if (attemptIdRef.current !== attemptId) return;

      attemptIdRef.current += 1;
      signingInRef.current = false;
      cancellingRef.current = false;
      onResetRef.current?.('error');
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
      const cancelled = await cancelRef.current();
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
        onResetRef.current?.('cancelled');
        setCancelling(false);
        setSigningIn(false);
        setError(null);
      } else {
        // Session already settled in main — reconcile busy flags without invalidating an
        // about-to-land startSignIn resolution or wiping an error it sets.
        onResetRef.current?.('stale_cancel');
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
    attemptIdRef,
    mountedRef,
    signingInRef,
    cancellingRef,
    startSignIn,
    cancelSignIn,
    clearError,
    setError,
  };
}

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  ClaudeSignInControls,
  useClaudeSignIn,
  type ClaudeSignInController,
} from '../../src/renderer/src/components/ClaudeSignInControls';
import type { ClaudeCodeSubmitResult, ClaudeSignInResult } from '../../src/shared/types';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let claudeSignInMock: Mock<() => Promise<ClaudeSignInResult>>;
let cancelClaudeSignInMock: Mock<() => Promise<boolean>>;
let copyClaudeSignInUrlMock: Mock<() => Promise<boolean>>;
let submitClaudeAuthCodeMock: Mock<(code: string) => Promise<ClaudeCodeSubmitResult>>;
let originalApi: unknown;

function Harness(props: {
  variant?: 'banner' | 'inline';
  disabled?: boolean;
  onSignedIn?: (account?: string) => void;
  onController?: (ctrl: ClaudeSignInController) => void;
}): React.JSX.Element {
  const controller = useClaudeSignIn({ onSignedIn: props.onSignedIn });
  props.onController?.(controller);
  return (
    <ClaudeSignInControls
      controller={controller}
      variant={props.variant}
      disabled={props.disabled}
    />
  );
}

beforeEach(() => {
  originalApi = (window as unknown as { api?: unknown }).api;
  claudeSignInMock = vi.fn(async () => ({ status: 'signed_in', account: 'alice@example.com' }));
  cancelClaudeSignInMock = vi.fn(async () => true);
  copyClaudeSignInUrlMock = vi.fn(async () => true);
  submitClaudeAuthCodeMock = vi.fn(async () => ({ accepted: true }));
  (window as unknown as { api: unknown }).api = {
    claudeSignIn: claudeSignInMock,
    cancelClaudeSignIn: cancelClaudeSignInMock,
    copyClaudeSignInUrl: copyClaudeSignInUrlMock,
    submitClaudeAuthCode: submitClaudeAuthCodeMock,
  };
});

afterEach(() => {
  (window as unknown as { api?: unknown }).api = originalApi;
  vi.useRealTimers();
  cleanup();
});

describe('ClaudeSignInControls & useClaudeSignIn', () => {
  it('makes zero IPC calls on mount and renders variant-specific idle button classes with zero inline styles', () => {
    const { container, rerender } = render(<Harness variant="banner" />);

    expect(claudeSignInMock).not.toHaveBeenCalled();
    expect(cancelClaudeSignInMock).not.toHaveBeenCalled();
    expect(copyClaudeSignInUrlMock).not.toHaveBeenCalled();
    expect(submitClaudeAuthCodeMock).not.toHaveBeenCalled();

    const bannerBtn = screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement;
    expect(bannerBtn.classList.contains('primary')).toBe(true);
    expect(bannerBtn.classList.contains('small')).toBe(true);
    expect(bannerBtn.classList.contains('banner-action')).toBe(true);
    expect(bannerBtn.disabled).toBe(false);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    rerender(<Harness variant="inline" disabled={true} />);
    const inlineBtn = screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement;
    expect(inlineBtn.classList.contains('button')).toBe(true);
    expect(inlineBtn.classList.contains('secondary')).toBe(true);
    expect(inlineBtn.classList.contains('cred-inline-btn')).toBe(true);
    expect(inlineBtn.disabled).toBe(true);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('completes happy-path browser sign-in, alternate-browser disclosure, URL copy timer, and code#state submission', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const loginGate = deferred<ClaudeSignInResult>();
    claudeSignInMock.mockReturnValueOnce(loginGate.promise);
    const onSignedIn = vi.fn();
    const captured: { current: ClaudeSignInController | null } = { current: null };

    const { container } = render(
      <Harness
        variant="banner"
        onSignedIn={onSignedIn}
        onController={(c) => {
          captured.current = c;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
    expect(claudeSignInMock).toHaveBeenCalledTimes(1);

    // Waiting state shows browser prompt, Cancel sign-in, and collapsed Use another browser toggle
    expect(screen.getByText('Finish signing in in your browser…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
    const toggleBtn = screen.getByRole('button', { name: 'Use another browser' });
    expect(toggleBtn.getAttribute('type')).toBe('button');
    expect(toggleBtn.classList.contains('claude-alt-toggle')).toBe(true);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    const panelId = toggleBtn.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(screen.queryByLabelText('Authorization code')).toBeNull();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    // Expand alternate-browser panel
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(panelId!)).not.toBeNull();

    // Copy sign-in link shows Copied feedback for 1.5s then clears
    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }));
    await waitFor(() => expect(copyClaudeSignInUrlMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.queryByText('Copied')).toBeNull();

    // Submit code disabled when empty or whitespace
    const input = screen.getByLabelText('Authorization code') as HTMLInputElement;
    expect(input.placeholder).toBe('Paste code (code#state)…');
    const submitBtn = screen.getByRole('button', { name: 'Submit code' }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '   ' } });
    expect(submitBtn.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submitClaudeAuthCodeMock).not.toHaveBeenCalled();

    // Enter code#state -> IME composing Enter does not submit; regular Enter submits
    fireEvent.change(input, { target: { value: 'authcode123#state456' } });
    expect(submitBtn.disabled).toBe(false);

    const composingEnter = createEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent(input, composingEnter);
    expect(submitClaudeAuthCodeMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(submitClaudeAuthCodeMock).toHaveBeenCalledWith('authcode123#state456'),
    );
    await waitFor(() => expect(input.value).toBe(''));

    // Main signIn resolves signed_in -> resets flags, increments successCount, invokes onSignedIn
    await act(async () => {
      loginGate.resolve({ status: 'signed_in', account: 'consultant@yvoke.dev' });
      await loginGate.promise;
    });

    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(onSignedIn).toHaveBeenCalledWith('consultant@yvoke.dev');
    expect(captured.current?.successCount).toBe(1);
    expect(captured.current?.signingIn).toBe(false);
    expect(captured.current?.altBrowserOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  describe('3-way async recovery matrix', () => {
    it('startSignIn: retains inline error and restores interactive button on { status: "error" } and rejected promise, and clears cleanly on { status: "cancelled" } or unmount', async () => {
      // (2a) { status: 'error', message }
      claudeSignInMock.mockResolvedValueOnce({
        status: 'error',
        message: 'Sign-in timed out after 5 minutes.',
      });
      const onSignedIn = vi.fn();
      const { container, unmount } = render(<Harness onSignedIn={onSignedIn} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Sign-in timed out after 5 minutes.'),
      );
      expect((screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(onSignedIn).not.toHaveBeenCalled();
      expect(container.querySelectorAll('[style]')).toHaveLength(0);

      // (2b) Rejected promise on retry
      claudeSignInMock.mockRejectedValueOnce(new Error('Claude binary missing'));
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Claude binary missing'),
      );
      expect((screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(
        false,
      );

      // (3a) { status: 'cancelled' } clears prior error and resets state cleanly
      claudeSignInMock.mockResolvedValueOnce({ status: 'cancelled' });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();
      expect(onSignedIn).not.toHaveBeenCalled();

      // (3b) Unmount mid-flight never calls onSignedIn
      const unmountGate = deferred<ClaudeSignInResult>();
      claudeSignInMock.mockReturnValueOnce(unmountGate.promise);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      unmount();
      await act(async () => {
        unmountGate.resolve({ status: 'signed_in', account: 'late@example.com' });
        await unmountGate.promise;
      });
      expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('cancelSignIn: handles (1) true reset, (2) rejected promise keeping controls interactive, and (3) stale false reconciling wedged UI', async () => {
      // (1) cancelSignIn resolves true
      const login1 = deferred<ClaudeSignInResult>();
      claudeSignInMock.mockReturnValueOnce(login1.promise);
      cancelClaudeSignInMock.mockResolvedValueOnce(true);

      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Use another browser' }));
      expect(screen.getByLabelText('Authorization code')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy());
      expect(screen.queryByRole('alert')).toBeNull();

      // Late resolution from cancelled login attempt is safely ignored
      await act(async () => {
        login1.resolve({ status: 'cancelled' });
        await login1.promise;
      });

      // (2) cancelSignIn rejects -> surfaces error and re-enables Cancel sign-in
      const login2 = deferred<ClaudeSignInResult>();
      claudeSignInMock.mockReturnValueOnce(login2.promise);
      cancelClaudeSignInMock.mockRejectedValueOnce(new Error('IPC cancel failed'));

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('IPC cancel failed'),
      );
      const cancelBtnAfterErr = screen.getByRole('button', { name: 'Cancel sign-in' }) as HTMLButtonElement;
      expect(cancelBtnAfterErr.disabled).toBe(false);

      // (3) cancelSignIn returns false (session already settled before cancel arrived) -> reconciles signingIn = false
      cancelClaudeSignInMock.mockResolvedValueOnce(false);
      fireEvent.click(cancelBtnAfterErr);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy(),
      );
    });

    it('cancelSignIn / startSignIn races on cancelled === false: preserves signed_in when false arrives first, and preserves startSignIn error when error arrives first', async () => {
      const onSignedIn = vi.fn();
      const captured: { current: ClaudeSignInController | null } = { current: null };

      render(
        <Harness
          onSignedIn={onSignedIn}
          onController={(c) => {
            captured.current = c;
          }}
        />,
      );

      // Race (a): cancelClaudeSignIn -> false resolves BEFORE claudeSignIn -> signed_in
      const loginA = deferred<ClaudeSignInResult>();
      const cancelA = deferred<boolean>();
      claudeSignInMock.mockReturnValueOnce(loginA.promise);
      cancelClaudeSignInMock.mockReturnValueOnce(cancelA.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        cancelA.resolve(false);
        await cancelA.promise;
      });
      await act(async () => {
        loginA.resolve({ status: 'signed_in', account: 'race-winner@yvoke.dev' });
        await loginA.promise;
      });

      expect(onSignedIn).toHaveBeenCalledTimes(1);
      expect(onSignedIn).toHaveBeenCalledWith('race-winner@yvoke.dev');
      expect(captured.current?.successCount).toBe(1);

      // Race (b): claudeSignIn -> error resolves BEFORE cancelClaudeSignIn -> false
      const loginB = deferred<ClaudeSignInResult>();
      const cancelB = deferred<boolean>();
      claudeSignInMock.mockReturnValueOnce(loginB.promise);
      cancelClaudeSignInMock.mockReturnValueOnce(cancelB.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        loginB.resolve({ status: 'error', message: 'Code exchange failed in browser.' });
        await loginB.promise;
      });
      expect(screen.getByRole('alert').textContent).toBe('Code exchange failed in browser.');

      await act(async () => {
        cancelB.resolve(false);
        await cancelB.promise;
      });
      // Late false cancel MUST NOT wipe the error set by startSignIn!
      expect(screen.getByRole('alert').textContent).toBe('Code exchange failed in browser.');

      // clearError() clears standing error explicitly
      expect(typeof captured.current?.clearError).toBe('function');
      act(() => {
        captured.current?.clearError?.();
      });
      expect(screen.queryByRole('alert')).toBeNull();

      // Race (c): claudeSignIn -> signed_in settles BEFORE in-flight cancelClaudeSignIn rejects -> late cancel error ignored
      const loginC = deferred<ClaudeSignInResult>();
      const cancelC = deferred<boolean>();
      claudeSignInMock.mockReturnValueOnce(loginC.promise);
      cancelClaudeSignInMock.mockReturnValueOnce(cancelC.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        loginC.resolve({ status: 'signed_in', account: 'settled-first@yvoke.dev' });
        await loginC.promise;
      });
      await act(async () => {
        cancelC.reject(new Error('Late cancel IPC failure'));
        await cancelC.promise.catch(() => undefined);
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('copySignInUrl: handles (1) true copied feedback + unmount timer cleanup, (2) rejected promise, and (3) false explicit unavailable error without false Copied', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const login = deferred<ClaudeSignInResult>();
      claudeSignInMock.mockReturnValue(login.promise);

      const { unmount } = render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Use another browser' }));

      // (3) returns false -> explicit unavailable error, NO Copied badge
      copyClaudeSignInUrlMock.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          'Sign-in link is not available. Cancel sign-in and try again.',
        ),
      );
      expect(screen.queryByText('Copied')).toBeNull();

      // (2) rejected promise -> surfaces error, NO Copied badge
      copyClaudeSignInUrlMock.mockRejectedValueOnce(new Error('Clipboard unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Clipboard unavailable'),
      );
      expect(screen.queryByText('Copied')).toBeNull();

      // (1) returns true -> clears error, shows Copied, cleans up timer cleanly on unmount
      copyClaudeSignInUrlMock.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }));
      await waitFor(() => expect(screen.getByText('Copied')).toBeTruthy());
      expect(screen.queryByRole('alert')).toBeNull();

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    });

    it('submitAuthCode: preserves codeDraft on { accepted: false } and rejected promise so user can edit typos, and ignores stale completion after cancel', async () => {
      const login = deferred<ClaudeSignInResult>();
      claudeSignInMock.mockReturnValueOnce(login.promise);

      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      fireEvent.click(screen.getByRole('button', { name: 'Use another browser' }));

      const input = screen.getByLabelText('Authorization code') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'missing-hash-code' } });

      // (2a) { accepted: false, message } preserves codeDraft and marks input aria-invalid
      submitClaudeAuthCodeMock.mockResolvedValueOnce({
        accepted: false,
        message: 'Paste the full authorization code in code#state format.',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          'Paste the full authorization code in code#state format.',
        ),
      );
      expect(input.value).toBe('missing-hash-code');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect((screen.getByRole('button', { name: 'Submit code' }) as HTMLButtonElement).disabled).toBe(
        false,
      );

      // (2b) Rejected promise also preserves edited codeDraft
      fireEvent.change(input, { target: { value: 'fixed#state123' } });
      submitClaudeAuthCodeMock.mockRejectedValueOnce(new Error('IPC submit error'));
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('IPC submit error'),
      );
      expect(input.value).toBe('fixed#state123');
      expect((screen.getByRole('button', { name: 'Submit code' }) as HTMLButtonElement).disabled).toBe(
        false,
      );

      // (3) Cancelled mid-flight while submitAuthCode is pending ignores stale result
      const pendingSubmit = deferred<ClaudeCodeSubmitResult>();
      submitClaudeAuthCodeMock.mockReturnValueOnce(pendingSubmit.promise);
      fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));
      expect((screen.getByRole('button', { name: 'Submit code' }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      cancelClaudeSignInMock.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy(),
      );

      await act(async () => {
        pendingSubmit.resolve({ accepted: false, message: 'Stale error after cancel' });
        await pendingSubmit.promise;
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

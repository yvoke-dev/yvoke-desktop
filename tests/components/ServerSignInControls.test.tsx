// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import {
  ServerSignInControls,
  useServerSignIn,
  type ServerSignInController,
} from '../../src/renderer/src/components/ServerSignInControls';
import { makeServerSignInStub } from './signInStubs';
import type { ServerSignInResult } from '../../src/shared/types';

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

let serverSignInMock: Mock<() => Promise<ServerSignInResult>>;
let cancelServerSignInMock: Mock<() => Promise<boolean>>;
let originalApi: unknown;

function Harness(props: {
  variant?: 'banner' | 'settings' | 'inline';
  disabled?: boolean;
  onSignedIn?: (account?: string) => void | Promise<void>;
  onController?: (ctrl: ServerSignInController) => void;
}): React.JSX.Element {
  const controller = useServerSignIn({ onSignedIn: props.onSignedIn });
  props.onController?.(controller);
  return (
    <ServerSignInControls
      controller={controller}
      variant={props.variant}
      disabled={props.disabled}
    />
  );
}

beforeEach(() => {
  originalApi = (window as unknown as { api?: unknown }).api;
  serverSignInMock = vi.fn(async () => ({ status: 'signed_in', account: 'alice@corp.com' }));
  cancelServerSignInMock = vi.fn(async () => true);
  (window as unknown as { api: unknown }).api = {
    serverSignIn: serverSignInMock,
    cancelServerSignIn: cancelServerSignInMock,
  };
});

afterEach(() => {
  (window as unknown as { api?: unknown }).api = originalApi;
  cleanup();
});

describe('ServerSignInControls & useServerSignIn', () => {
  it('makes zero IPC calls on mount and renders variant-specific idle button classes with zero inline styles', () => {
    const { container, rerender } = render(<Harness variant="banner" />);

    expect(serverSignInMock).not.toHaveBeenCalled();
    expect(cancelServerSignInMock).not.toHaveBeenCalled();

    const bannerBtn = screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement;
    expect(bannerBtn.type).toBe('button');
    expect(bannerBtn.classList.contains('primary')).toBe(true);
    expect(bannerBtn.classList.contains('small')).toBe(true);
    expect(bannerBtn.classList.contains('banner-action')).toBe(true);
    expect(bannerBtn.disabled).toBe(false);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    rerender(<Harness variant="settings" disabled={true} />);
    const settingsBtn = screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement;
    expect(settingsBtn.classList.contains('button')).toBe(true);
    expect(settingsBtn.classList.contains('secondary')).toBe(true);
    expect(settingsBtn.classList.contains('cred-inline-btn')).toBe(true);
    expect(settingsBtn.disabled).toBe(true);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    rerender(<Harness variant="inline" disabled={false} />);
    const inlineBtn = screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement;
    expect(inlineBtn.classList.contains('button')).toBe(true);
    expect(inlineBtn.classList.contains('secondary')).toBe(true);
    expect(inlineBtn.disabled).toBe(false);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('completes happy-path browser sign-in, guards duplicate concurrent clicks, catches async onSignedIn rejection, and renders zero inline styles', async () => {
    const loginGate = deferred<ServerSignInResult>();
    serverSignInMock.mockReturnValueOnce(loginGate.promise);
    const onSignedIn = vi.fn(async () => {
      throw new Error('Refresh failed after sign-in');
    });
    const captured: { current: ServerSignInController | null } = { current: null };

    const { container } = render(
      <Harness
        variant="banner"
        onSignedIn={onSignedIn}
        onController={(c) => {
          captured.current = c;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
    expect(serverSignInMock).toHaveBeenCalledTimes(1);

    // Waiting state shows browser prompt and Cancel sign-in with zero inline styles
    expect(screen.getByText('Finish signing in in your browser…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    // Direct duplicate startSignIn call while active is ignored
    await act(async () => {
      await captured.current?.startSignIn();
    });
    expect(serverSignInMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      loginGate.resolve({ status: 'signed_in', account: 'consultant@yvoke.dev' });
      await loginGate.promise;
    });

    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(onSignedIn).toHaveBeenCalledWith('consultant@yvoke.dev');
    expect(captured.current?.successCount).toBe(1);
    expect(captured.current?.signingIn).toBe(false);
    expect(captured.current?.cancelling).toBe(false);
    expect(captured.current?.error).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  describe('3-way async recovery matrix', () => {
    it('startSignIn: handles { status: "error" }, rejected promise, { status: "cancelled" }, and unmount cleanly', async () => {
      // (1) { status: 'error', message }
      serverSignInMock.mockResolvedValueOnce({
        status: 'error',
        message: 'Entra sign-in timed out.',
      });
      const onSignedIn = vi.fn();
      const { container, unmount } = render(<Harness onSignedIn={onSignedIn} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Entra sign-in timed out.'),
      );
      expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(onSignedIn).not.toHaveBeenCalled();
      expect(container.querySelectorAll('[style]')).toHaveLength(0);

      // (2) Rejected IPC promise
      serverSignInMock.mockRejectedValueOnce(new Error('MSAL loopback port unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('MSAL loopback port unavailable'),
      );
      expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(
        false,
      );

      // (3a) { status: 'cancelled' } clears prior error and resets cleanly
      serverSignInMock.mockResolvedValueOnce({ status: 'cancelled' });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect(onSignedIn).not.toHaveBeenCalled();

      // (3b) Unmount mid-flight never calls onSignedIn
      const unmountGate = deferred<ServerSignInResult>();
      serverSignInMock.mockReturnValueOnce(unmountGate.promise);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      unmount();
      await act(async () => {
        unmountGate.resolve({ status: 'signed_in', account: 'late@corp.com' });
        await unmountGate.promise;
      });
      expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('cancelSignIn: handles (1) true reset, (2) rejected promise keeping controls interactive, and (3) stale false reconciling wedged UI', async () => {
      // (1) cancelServerSignIn resolves true
      const login1 = deferred<ServerSignInResult>();
      serverSignInMock.mockReturnValueOnce(login1.promise);
      cancelServerSignInMock.mockResolvedValueOnce(true);

      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy());
      expect(screen.queryByRole('alert')).toBeNull();

      // Late resolution from cancelled attempt is ignored
      await act(async () => {
        login1.resolve({ status: 'cancelled' });
        await login1.promise;
      });

      // (2) cancelServerSignIn rejects -> surfaces error and re-enables Cancel sign-in
      const login2 = deferred<ServerSignInResult>();
      serverSignInMock.mockReturnValueOnce(login2.promise);
      cancelServerSignInMock.mockRejectedValueOnce(new Error('IPC cancel failed'));

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('IPC cancel failed'),
      );
      const cancelBtnAfterErr = screen.getByRole('button', { name: 'Cancel sign-in' }) as HTMLButtonElement;
      expect(cancelBtnAfterErr.disabled).toBe(false);

      // (3) cancelServerSignIn returns false -> reconciles signingIn = false
      cancelServerSignInMock.mockResolvedValueOnce(false);
      fireEvent.click(cancelBtnAfterErr);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy(),
      );
    });

    it('handles all 3 cancelServerSignIn() race orderings cleanly and supports clearError()', async () => {
      const onSignedIn = vi.fn();
      const captured: { current: ServerSignInController | null } = { current: null };

      render(
        <Harness
          onSignedIn={onSignedIn}
          onController={(c) => {
            captured.current = c;
          }}
        />,
      );

      // Race (1): cancelServerSignIn -> false resolves BEFORE serverSignIn -> signed_in
      const loginA = deferred<ServerSignInResult>();
      const cancelA = deferred<boolean>();
      serverSignInMock.mockReturnValueOnce(loginA.promise);
      cancelServerSignInMock.mockReturnValueOnce(cancelA.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        cancelA.resolve(false);
        await cancelA.promise;
      });
      // Immediately reconciled to non-wedged state
      expect(captured.current?.signingIn).toBe(false);
      expect(captured.current?.cancelling).toBe(false);

      await act(async () => {
        loginA.resolve({ status: 'signed_in', account: 'race-winner@corp.com' });
        await loginA.promise;
      });
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      expect(onSignedIn).toHaveBeenCalledWith('race-winner@corp.com');
      expect(captured.current?.successCount).toBe(1);

      // Race (2): serverSignIn -> error resolves BEFORE cancelServerSignIn -> false
      const loginB = deferred<ServerSignInResult>();
      const cancelB = deferred<boolean>();
      serverSignInMock.mockReturnValueOnce(loginB.promise);
      cancelServerSignInMock.mockReturnValueOnce(cancelB.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        loginB.resolve({ status: 'error', message: 'Entra login failed.' });
        await loginB.promise;
      });
      expect(screen.getByRole('alert').textContent).toBe('Entra login failed.');

      await act(async () => {
        cancelB.resolve(false);
        await cancelB.promise;
      });
      expect(screen.getByRole('alert').textContent).toBe('Entra login failed.');
      expect(captured.current?.cancelling).toBe(false);

      act(() => {
        captured.current?.clearError();
      });
      expect(screen.queryByRole('alert')).toBeNull();

      // Race (3): serverSignIn -> signed_in resolves BEFORE cancelServerSignIn rejects -> late cancel error ignored
      const loginC = deferred<ServerSignInResult>();
      const cancelC = deferred<boolean>();
      serverSignInMock.mockReturnValueOnce(loginC.promise);
      cancelServerSignInMock.mockReturnValueOnce(cancelC.promise);

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

      await act(async () => {
        loginC.resolve({ status: 'signed_in', account: 'settled-first@corp.com' });
        await loginC.promise;
      });
      await act(async () => {
        cancelC.reject(new Error('Late cancel IPC failure'));
        await cancelC.promise.catch(() => undefined);
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(captured.current?.cancelling).toBe(false);
    });
  });

  describe('Wave 22 (#11 & #13-hook): required controller & useBrowserSignInFlow edge cases', () => {
    it('#11: renders directly with required controller even when window.api is undefined (zero hidden fallback hook)', () => {
      // Compile-time pin: omitting required `controller` must be a TypeScript error.
      const _omitControllerTypePin = (): React.JSX.Element => (
        // @ts-expect-error controller prop is required on ServerSignInControls
        <ServerSignInControls variant="inline" />
      );
      expect(typeof _omitControllerTypePin).toBe('function');

      (window as unknown as { api?: unknown }).api = undefined;
      const stub = makeServerSignInStub();
      const { container } = render(<ServerSignInControls controller={stub} variant="inline" />);

      const btn = screen.getByRole('button', { name: 'Sign in to Yvoke' });
      expect(btn).toBeTruthy();
      expect(container.querySelectorAll('[style]')).toHaveLength(0);
      fireEvent.click(btn);
      expect(stub.startSignIn).toHaveBeenCalledTimes(1);
    });

    it('#13-hook: normalizes whitespace/non-Error rejections, recovers from synchronous onSignedIn throw, and keeps stable callback identities', async () => {
      const captured: ServerSignInController[] = [];

      function IdentityHarness(props: {
        tick: number;
        onSignedIn?: (account?: string) => void | Promise<void>;
      }): React.JSX.Element {
        const ctrl = useServerSignIn({ onSignedIn: props.onSignedIn });
        captured.push(ctrl);
        return <ServerSignInControls controller={ctrl} variant="inline" />;
      }

      const { rerender } = render(<IdentityHarness tick={0} onSignedIn={() => undefined} />);
      rerender(<IdentityHarness tick={1} onSignedIn={() => undefined} />);

      expect(captured.length).toBeGreaterThanOrEqual(2);
      expect(captured[0].startSignIn).toBe(captured[1].startSignIn);
      expect(captured[0].cancelSignIn).toBe(captured[1].cancelSignIn);
      expect(captured[0].clearError).toBe(captured[1].clearError);

      // 1. Whitespace-only Error rejection falls back to default message
      serverSignInMock.mockRejectedValueOnce(new Error('   '));
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Sign-in failed. Please try again.'),
      );

      // 2. Non-Error string rejection surfaces verbatim
      serverSignInMock.mockRejectedValueOnce('boom');
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'));

      // 3. Synchronous throw inside onSignedIn does NOT wedge signingIn
      const syncThrow = vi.fn(() => {
        throw new Error('Sync server callback failure');
      });
      rerender(<IdentityHarness tick={2} onSignedIn={syncThrow} />);
      serverSignInMock.mockResolvedValueOnce({ status: 'signed_in', account: 'alice@corp.com' });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() => expect(syncThrow).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect(captured[captured.length - 1].signingIn).toBe(false);
      expect(captured[captured.length - 1].successCount).toBe(1);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

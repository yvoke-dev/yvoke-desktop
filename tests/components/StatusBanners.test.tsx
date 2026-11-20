// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusBanners } from '../../src/renderer/src/components/StatusBanners';
import type { ClaudeSignInController } from '../../src/renderer/src/components/ClaudeSignInControls';
import type { ServerSignInController } from '../../src/renderer/src/components/ServerSignInControls';
import type { AuthStatus } from '../../src/shared/types';

let originalApi: unknown;

beforeEach(() => {
  originalApi = (window as unknown as { api?: unknown }).api;
  (window as unknown as { api: unknown }).api = {
    claudeSignIn: vi.fn(async () => ({ status: 'signed_in' as const })),
    cancelClaudeSignIn: vi.fn(async () => true),
    copyClaudeSignInUrl: vi.fn(async () => true),
    submitClaudeAuthCode: vi.fn(async () => ({ accepted: true as const })),
    serverSignIn: vi.fn(async () => ({ status: 'signed_in' as const })),
    cancelServerSignIn: vi.fn(async () => true),
  };
});

afterEach(() => {
  (window as unknown as { api?: unknown }).api = originalApi;
  cleanup();
});

const mockAuth: AuthStatus = {
  claude: 'ok',
  server: { mode: 'dev', signedIn: true },
};

function makeClaudeController(
  overrides: Partial<ClaudeSignInController> = {},
): ClaudeSignInController {
  return {
    signingIn: false,
    cancelling: false,
    copyingUrl: false,
    copiedUrl: false,
    altBrowserOpen: false,
    codeDraft: '',
    submittingCode: false,
    error: null,
    successCount: 0,
    startSignIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    toggleAltBrowser: vi.fn(),
    copySignInUrl: vi.fn(async () => undefined),
    setCodeDraft: vi.fn(),
    submitAuthCode: vi.fn(async () => undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

function makeServerController(
  overrides: Partial<ServerSignInController> = {},
): ServerSignInController {
  return {
    signingIn: false,
    cancelling: false,
    error: null,
    successCount: 0,
    startSignIn: vi.fn(async () => undefined),
    cancelSignIn: vi.fn(async () => undefined),
    clearError: vi.fn(),
    ...overrides,
  };
}

describe('StatusBanners', () => {
  it('renders nothing problematic when server is reachable and auth is good', () => {
    const { container } = render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );
    expect(container.querySelectorAll('.banner')).toHaveLength(0);
  });

  it('renders Server unreachable banner with Retry button in dev mode and when signed in under Entra', () => {
    const onRetryServer = vi.fn();
    const { rerender } = render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={false}
        pendingSync={0}
        syncError={null}
        onRetryServer={onRetryServer}
      />,
    );

    expect(screen.getByText(/Server unreachable:/i)).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'Retry connection' });
    fireEvent.click(retryBtn);
    expect(onRetryServer).toHaveBeenCalledTimes(1);

    // Signed-in Entra with no serverAuthRequired also shows Server unreachable
    rerender(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true, account: 'a@corp.com' } }}
        serverReachable={false}
        serverAuthRequired={false}
        pendingSync={0}
        syncError={null}
        onRetryServer={onRetryServer}
      />,
    );
    expect(screen.getByText(/Server unreachable:/i)).toBeTruthy();
  });

  it('suppresses red Server unreachable banner whenever showServerSignInBanner is true (signed out Entra or serverAuthRequired)', () => {
    const { rerender } = render(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
        serverSignIn={makeServerController()}
        serverReachable={false}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
    expect(screen.queryByText(/Server unreachable:/i)).toBeNull();

    // Also suppressed when auth.server.signedIn is stale-true but serverAuthRequired is true
    rerender(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true } }}
        serverSignIn={makeServerController()}
        serverAuthRequired={true}
        serverReachable={false}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
    expect(screen.queryByText(/Server unreachable:/i)).toBeNull();
  });

  it('renders terminal-free Connect Claude banner with Sign in to Claude button and triggers startSignIn', () => {
    const startSignIn = vi.fn(async () => undefined);
    const ctrl = makeClaudeController({ startSignIn });
    const { container } = render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
        claudeSignIn={ctrl}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/claude \/login|terminal|npm install/i);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);

    const signInBtn = screen.getByRole('button', { name: 'Sign in to Claude' });
    expect(signInBtn.classList.contains('primary')).toBe(true);
    expect(signInBtn.classList.contains('small')).toBe(true);
    expect(signInBtn.classList.contains('banner-action')).toBe(true);
    fireEvent.click(signInBtn);
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it('keeps Connect Claude banner mounted while signingIn is active, disambiguates Sign in to Yvoke vs Sign in to Claude, and mutually disables controls', () => {
    const serverStart = vi.fn(async () => undefined);
    const claudeStart = vi.fn(async () => undefined);
    const claudeCancel = vi.fn(async () => undefined);
    const { rerender } = render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeClaudeController({ startSignIn: claudeStart })}
        serverSignIn={makeServerController({ startSignIn: serverStart })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
    expect(serverStart).toHaveBeenCalledTimes(1);
    expect(claudeStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
    expect(claudeStart).toHaveBeenCalledTimes(1);

    // While serverSignIn.signingIn is true, Sign in to Claude is disabled
    rerender(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeClaudeController({ startSignIn: claudeStart })}
        serverSignIn={makeServerController({ signingIn: true })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );
    expect((screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(true);

    // While claudeSignIn.signingIn is true, Sign in to Yvoke is disabled and Connect Claude stays mounted
    rerender(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeClaudeController({ signingIn: true, cancelSignIn: claudeCancel })}
        serverSignIn={makeServerController({ startSignIn: serverStart })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );
    expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(claudeCancel).toHaveBeenCalledTimes(1);
  });

  it('renders Sign in to Yvoke banner and triggers serverSignIn.startSignIn', () => {
    const startSignIn = vi.fn(async () => undefined);
    render(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
        serverSignIn={makeServerController({ startSignIn })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByText(/Server sign-in required:/i)).toBeTruthy();
    const signInBtn = screen.getByRole('button', { name: 'Sign in to Yvoke' });
    fireEvent.click(signInBtn);
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });

  it('disables both Sign in to Claude and Sign in to Yvoke banner buttons while signingOut is true', () => {
    render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeClaudeController()}
        serverSignIn={makeServerController()}
        signingOut={true}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    expect((screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('disables both Sign in to Claude and Sign in to Yvoke banner buttons while claudeSigningOut is true', () => {
    render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeClaudeController()}
        serverSignIn={makeServerController()}
        claudeSigningOut={true}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onRetryServer={() => undefined}
      />,
    );

    expect((screen.getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Sign in to Yvoke' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('renders pending sync turns info', () => {
    render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={3}
        syncError="Connection timeout"
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByText(/3 turns waiting to sync to the server — Connection timeout/i)).toBeTruthy();
  });

  it('renders droppedSyncError in an error banner with Dismiss button and invokes onDismissDroppedSyncError on click', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        droppedSyncError="A queued conversation turn was rejected by the server (HTTP 422)."
        onDismissDroppedSyncError={onDismiss}
        onRetryServer={() => undefined}
      />,
    );

    const errorBanner = container.querySelector('.banner.error');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain(
      'A queued conversation turn was rejected by the server (HTTP 422).',
    );
    expect(errorBanner?.querySelector('.banner-icon svg')).not.toBeNull();

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissBtn.classList.contains('small')).toBe(true);
    expect(dismissBtn.classList.contains('banner-action')).toBe(true);
    expect(dismissBtn.getAttribute('style')).toBeNull();

    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('coexists cleanly alongside pendingSync > 0 info banner without conflating syncError and droppedSyncError', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={2}
        syncError="Temporary timeout"
        droppedSyncError="Turn rejected by server (HTTP 400)."
        onDismissDroppedSyncError={onDismiss}
        onRetryServer={() => undefined}
      />,
    );

    const errorBanner = container.querySelector('.banner.error');
    const infoBanner = container.querySelector('.banner.info');
    expect(errorBanner).not.toBeNull();
    expect(infoBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain('Turn rejected by server (HTTP 400).');
    expect(infoBanner?.textContent).toContain('2 turns waiting to sync to the server — Temporary timeout');
  });
});

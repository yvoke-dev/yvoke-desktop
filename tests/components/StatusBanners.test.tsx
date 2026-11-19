// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusBanners } from '../../src/renderer/src/components/StatusBanners';
import type { ClaudeSignInController } from '../../src/renderer/src/components/ClaudeSignInControls';
import type { AuthStatus } from '../../src/shared/types';

let originalApi: unknown;

beforeEach(() => {
  originalApi = (window as unknown as { api?: unknown }).api;
  (window as unknown as { api: unknown }).api = {
    claudeSignIn: vi.fn(async () => ({ status: 'signed_in' as const })),
    cancelClaudeSignIn: vi.fn(async () => true),
    copyClaudeSignInUrl: vi.fn(async () => true),
    submitClaudeAuthCode: vi.fn(async () => ({ accepted: true as const })),
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

function makeController(overrides: Partial<ClaudeSignInController> = {}): ClaudeSignInController {
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
        onServerSignIn={() => undefined}
        onRetryServer={() => undefined}
      />,
    );
    expect(container.querySelectorAll('.banner')).toHaveLength(0);
  });

  it('renders Server unreachable banner with Retry button and triggers onRetryServer', () => {
    const onRetryServer = vi.fn();
    render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={false}
        pendingSync={0}
        syncError={null}
        onServerSignIn={() => undefined}
        onRetryServer={onRetryServer}
      />,
    );

    expect(screen.getByText(/Server unreachable:/i)).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'Retry connection' });
    expect(retryBtn).toBeTruthy();

    fireEvent.click(retryBtn);
    expect(onRetryServer).toHaveBeenCalledTimes(1);
  });

  it('renders terminal-free Connect Claude banner with Sign in to Claude button and triggers startSignIn', () => {
    const startSignIn = vi.fn(async () => undefined);
    const ctrl = makeController({ startSignIn });
    const { container } = render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
        claudeSignIn={ctrl}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={() => undefined}
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

  it('keeps Connect Claude banner mounted while signingIn is active and disambiguates Sign in vs Sign in to Claude', () => {
    const onServerSignIn = vi.fn();
    const startSignIn = vi.fn(async () => undefined);
    const cancelSignIn = vi.fn(async () => undefined);
    const { rerender } = render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'entra', signedIn: false } }}
        claudeSignIn={makeController({ startSignIn })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={onServerSignIn}
        onRetryServer={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onServerSignIn).toHaveBeenCalledTimes(1);
    expect(startSignIn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
    expect(startSignIn).toHaveBeenCalledTimes(1);

    // Remains visible with Cancel sign-in while signingIn is true even if auth.claude updated
    rerender(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: true } }}
        claudeSignIn={makeController({ signingIn: true, cancelSignIn })}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={onServerSignIn}
        onRetryServer={() => undefined}
      />,
    );
    expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
  });

  it('renders Sign in banner and triggers onServerSignIn', () => {
    const onServerSignIn = vi.fn();
    render(
      <StatusBanners
        auth={{ claude: 'ok', server: { mode: 'entra', signedIn: false } }}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={onServerSignIn}
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByText(/Server sign-in required:/i)).toBeTruthy();
    const signInBtn = screen.getByRole('button', { name: 'Sign in' });
    fireEvent.click(signInBtn);
    expect(onServerSignIn).toHaveBeenCalledTimes(1);
  });

  it('renders pending sync turns info', () => {
    render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={3}
        syncError="Connection timeout"
        onServerSignIn={() => undefined}
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
        onServerSignIn={() => undefined}
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
        onServerSignIn={() => undefined}
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

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusBanners } from '../../src/renderer/src/components/StatusBanners';
import type { AuthStatus } from '../../src/shared/types';

afterEach(() => cleanup());

const mockAuth: AuthStatus = {
  claude: 'ok',
  server: { mode: 'dev', signedIn: true },
};

describe('StatusBanners', () => {
  it('renders nothing problematic when server is reachable and auth is good', () => {
    const { container } = render(
      <StatusBanners
        auth={mockAuth}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={() => undefined}
        onRetryAuth={() => undefined}
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
        onRetryAuth={() => undefined}
        onRetryServer={onRetryServer}
      />,
    );

    expect(screen.getByText(/Server unreachable:/i)).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'Retry connection' });
    expect(retryBtn).toBeTruthy();

    fireEvent.click(retryBtn);
    expect(onRetryServer).toHaveBeenCalledTimes(1);
  });

  it('renders Claude missing banner with Retry button and triggers onRetryAuth', () => {
    const onRetryAuth = vi.fn();
    render(
      <StatusBanners
        auth={{ claude: 'missing', server: { mode: 'dev', signedIn: true } }}
        serverReachable={true}
        pendingSync={0}
        syncError={null}
        onServerSignIn={() => undefined}
        onRetryAuth={onRetryAuth}
        onRetryServer={() => undefined}
      />,
    );

    expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: 'Retry sign-in' });
    fireEvent.click(retryBtn);
    expect(onRetryAuth).toHaveBeenCalledTimes(1);
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
        onRetryAuth={() => undefined}
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
        onRetryAuth={() => undefined}
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
        onRetryAuth={() => undefined}
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
        onRetryAuth={() => undefined}
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

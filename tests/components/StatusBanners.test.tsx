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
});

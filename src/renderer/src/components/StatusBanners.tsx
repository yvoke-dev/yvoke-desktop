import React from 'react';
import type { AuthStatus } from '../../../shared/types';

export function StatusBanners(props: {
  auth: AuthStatus | null;
  serverReachable: boolean;
  pendingSync: number;
  syncError: string | null;
  onServerSignIn: () => void;
  onRetryAuth: () => void;
}): React.JSX.Element | null {
  const { auth, serverReachable, pendingSync, syncError, onServerSignIn, onRetryAuth } = props;
  return (
    <div className="banners">
      {auth?.claude === 'missing' && (
        <div className="banner warn">
          <strong>Connect Claude:</strong> no Claude Code credentials found. Run <code>claude /login</code> in a
          terminal (your Claude Pro/Max account — the same login as Claude Desktop), then retry.
          <button className="small" onClick={onRetryAuth}>
            Retry
          </button>
        </div>
      )}
      {auth?.server.mode === 'entra' && !auth.server.signedIn && (
        <div className="banner warn">
          <strong>Server sign-in required:</strong> sign in with your corporate account to load and save
          conversations.
          <button className="small primary" onClick={onServerSignIn}>
            Sign in
          </button>
        </div>
      )}
      {!serverReachable && (
        <div className="banner error">
          <strong>Server unreachable:</strong> showing cached conversations. Chat needs the Yvoke server for its
          knowledge-base tools.
        </div>
      )}
      {pendingSync > 0 && (
        <div className="banner info">
          {pendingSync} turn{pendingSync > 1 ? 's' : ''} waiting to sync to the server
          {syncError ? ` — ${syncError}` : '…'}
        </div>
      )}
    </div>
  );
}

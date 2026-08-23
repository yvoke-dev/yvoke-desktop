import React from 'react';
import type { AuthStatus } from '../../../shared/types';
import { AlertIcon, InfoIcon } from './icons';

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
          <span className="banner-icon">
            <AlertIcon size={14} />
          </span>
          <span>
            <strong>Connect Claude:</strong> no Claude Code credentials found. Run <code>claude /login</code> in a
            terminal (your Claude Pro/Max account — the same login as Claude Desktop), then retry.
          </span>
          <button className="small banner-action" onClick={onRetryAuth}>
            Retry
          </button>
        </div>
      )}
      {auth?.server.mode === 'entra' && !auth.server.signedIn && (
        <div className="banner warn">
          <span className="banner-icon">
            <AlertIcon size={14} />
          </span>
          <span>
            <strong>Server sign-in required:</strong> sign in with your corporate account to load and save
            conversations.
          </span>
          <button className="primary small banner-action" onClick={onServerSignIn}>
            Sign in
          </button>
        </div>
      )}
      {!serverReachable && (
        <div className="banner error">
          <span className="banner-icon">
            <AlertIcon size={14} />
          </span>
          <span>
            <strong>Server unreachable:</strong> showing cached conversations. Chat needs the Yvoke server for its
            knowledge-base tools.
          </span>
        </div>
      )}
      {pendingSync > 0 && (
        <div className="banner info">
          <span className="banner-icon">
            <InfoIcon size={14} />
          </span>
          <span>
            {pendingSync} turn{pendingSync > 1 ? 's' : ''} waiting to sync to the server
            {syncError ? ` — ${syncError}` : '…'}
          </span>
        </div>
      )}
    </div>
  );
}

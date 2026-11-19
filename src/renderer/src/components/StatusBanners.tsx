import React from 'react';
import type { AuthStatus } from '../../../shared/types';
import {
  ClaudeSignInControls,
  useClaudeSignIn,
  type ClaudeSignInController,
} from './ClaudeSignInControls';
import { AlertIcon, InfoIcon } from './icons';

export function StatusBanners(props: {
  auth: AuthStatus | null;
  claudeSignIn?: ClaudeSignInController;
  serverReachable: boolean;
  pendingSync: number;
  syncError: string | null;
  droppedSyncError?: string | null;
  onDismissDroppedSyncError?: () => void;
  onServerSignIn: () => void;
  onRetryServer: () => void;
}): React.JSX.Element | null {
  const {
    auth,
    claudeSignIn,
    serverReachable,
    pendingSync,
    syncError,
    droppedSyncError,
    onDismissDroppedSyncError,
    onServerSignIn,
    onRetryServer,
  } = props;
  const fallbackClaudeSignIn = useClaudeSignIn();
  const effectiveClaudeSignIn = claudeSignIn ?? fallbackClaudeSignIn;
  const showClaudeBanner =
    auth?.claude === 'missing' || Boolean(effectiveClaudeSignIn.signingIn);

  return (
    <div className="banners">
      {showClaudeBanner && (
        <div className="banner warn">
          <span className="banner-icon">
            <AlertIcon size={14} />
          </span>
          <span className="banner-text">
            <strong>Connect Claude:</strong> sign in with your Claude Pro or Max account in your
            browser to ask questions.
          </span>
          <ClaudeSignInControls controller={effectiveClaudeSignIn} variant="banner" />
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
          <button className="small banner-action" onClick={onRetryServer}>
            Retry connection
          </button>
        </div>
      )}
      {droppedSyncError && (
        <div className="banner error">
          <span className="banner-icon">
            <AlertIcon size={14} />
          </span>
          <span>{droppedSyncError}</span>
          <button type="button" className="small banner-action" onClick={onDismissDroppedSyncError}>
            Dismiss
          </button>
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

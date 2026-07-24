import React from 'react';
import type { AuthStatus, ThreadMeta } from '../../../shared/types';

export function ThreadList(props: {
  threads: ThreadMeta[];
  appVersion: string;
  activeThreadId: string | null;
  auth: AuthStatus | null;
  onOpen: (threadId: string) => void;
  onCreate: () => void;
  onDelete: (threadId: string) => void;
  onOpenSettings: () => void;
  onSignOut?: () => void;
}): React.JSX.Element {
  const { threads, appVersion, activeThreadId, auth, onOpen, onCreate, onDelete, onOpenSettings, onSignOut } = props;
  return (
    <aside className="thread-list">
      <div className="thread-list-header">
        <span className="app-title">Yvoke - Desktop</span>
        <button className="primary small" onClick={onCreate} title="New conversation">
          + New
        </button>
      </div>
      <nav className="threads">
        {threads.map((thread) => (
          <div
            key={thread.id}
            className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`}
            onClick={() => onOpen(thread.id)}
          >
            <div className="thread-content">
              <div className="thread-title" title={thread.title}>
                {thread.title}
              </div>
              <div className="thread-meta">
                <span>{thread.model}</span>
                {thread.syncState !== 'synced' && <span className={`sync-dot ${thread.syncState}`}>●</span>}
              </div>
            </div>
            <button
              className="icon-button thread-delete"
              title="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${thread.title}"? This removes it from the server too.`)) {
                  onDelete(thread.id);
                }
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
        ))}
        {threads.length === 0 && <div className="thread-empty">No conversations yet.</div>}
      </nav>
      <div className="thread-list-footer">
        <div className="footer-info">
          <div
            className="account-chip"
            title={auth?.claudeAccount ?? auth?.server.account ?? ''}
          >
            {auth?.claudeAccount
              ? `👤 ${auth.claudeAccount}`
              : auth?.server.signedIn
                ? `👤 ${auth.server.account}`
                : 'Not signed in'}
          </div>
          <div className="footer-sub-meta">
            {auth && (
              <span
                className="account-mode"
                title={
                  auth.server.mode === 'dev'
                    ? 'Server running with mock security (APP_SECURITY_MOCK)'
                    : 'Authenticated via Microsoft Entra'
                }
              >
                {auth.server.mode === 'dev' ? '🧪 dev' : '🔐 entra'}
              </span>
            )}
            {appVersion && <span className="app-version">v{appVersion}</span>}
          </div>
        </div>
        {auth?.server.signedIn && auth.server.mode === 'entra' && onSignOut && (
          <button
            className="icon-button footer-settings"
            data-tooltip="Logout from Entra"
            onClick={onSignOut}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        )}
        <button
          className="icon-button footer-settings"
          data-tooltip="Settings"
          onClick={onOpenSettings}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

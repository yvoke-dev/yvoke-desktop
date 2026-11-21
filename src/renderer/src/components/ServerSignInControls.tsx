import React from 'react';
import { useBrowserSignInFlow } from './useBrowserSignInFlow';

export interface ServerSignInController {
  signingIn: boolean;
  cancelling: boolean;
  error: string | null;
  successCount: number;
  startSignIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  clearError: () => void;
}

export interface UseServerSignInOptions {
  onSignedIn?: (account?: string) => void | Promise<void>;
}

export function useServerSignIn(options?: UseServerSignInOptions): ServerSignInController {
  const flow = useBrowserSignInFlow({
    start: () => window.api.serverSignIn(),
    cancel: () => window.api.cancelServerSignIn(),
    onSignedIn: options?.onSignedIn,
  });

  return {
    signingIn: flow.signingIn,
    cancelling: flow.cancelling,
    error: flow.error,
    successCount: flow.successCount,
    startSignIn: flow.startSignIn,
    cancelSignIn: flow.cancelSignIn,
    clearError: flow.clearError,
  };
}

export interface ServerSignInControlsProps {
  controller: ServerSignInController;
  variant?: 'banner' | 'settings' | 'inline';
  disabled?: boolean;
}

export function ServerSignInControls(props: ServerSignInControlsProps): React.JSX.Element {
  const { controller: ctrl, variant = 'inline', disabled = false } = props;

  const idleButtonClass =
    variant === 'banner'
      ? 'primary small banner-action'
      : 'button secondary cred-inline-btn';
  const cancelButtonClass =
    variant === 'banner' ? 'small' : 'button secondary cred-inline-btn';

  return (
    <div
      className={`server-signin-controls is-${variant}${ctrl.signingIn ? ' is-waiting' : ''}`}
    >
      {!ctrl.signingIn ? (
        <button
          type="button"
          className={idleButtonClass}
          disabled={disabled || ctrl.signingIn}
          onClick={() => void ctrl.startSignIn()}
        >
          Sign in to Yvoke
        </button>
      ) : (
        <div className="server-signin-waiting">
          <span className="server-signin-status">Finish signing in in your browser…</span>
          <button
            type="button"
            className={cancelButtonClass}
            disabled={ctrl.cancelling}
            onClick={() => void ctrl.cancelSignIn()}
          >
            Cancel sign-in
          </button>
        </div>
      )}

      {ctrl.error && (
        <div className="server-signin-error" role="alert">
          {ctrl.error}
        </div>
      )}
    </div>
  );
}

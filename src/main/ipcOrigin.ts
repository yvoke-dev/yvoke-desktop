import { IpcChannels } from '../shared/ipc';
import type {
  AuthStatus,
  ClaudeCodeSubmitResult,
  ClaudeSignInResult,
  ClaudeSignOutResult,
  ServerSignInResult,
} from '../shared/types';

export interface IpcEventLike {
  senderFrame?: { url?: string } | null;
}

export interface IpcHandleRegistrar<TEvent extends IpcEventLike = IpcEventLike> {
  handle(channel: string, listener: (event: TEvent, ...args: unknown[]) => unknown): void;
}

export type OriginGuardedHandle<TEvent extends IpcEventLike = IpcEventLike> = <
  TArgs extends unknown[] = unknown[],
>(
  channel: string,
  fn: (event: TEvent, ...args: TArgs) => unknown,
) => void;

/**
 * Wraps `ipcMain.handle` so every channel first verifies the invoking frame's origin matches
 * `trustedOrigin` (and fails closed when `trustedOrigin` itself is empty).
 *
 * Note: packaged `file://` apps have `new URL('file:///...').origin === 'null'`, which is truthy
 * and matches `trustedOrigin === 'null'`, while missing/empty/malformed `senderFrame.url` yields
 * `''` and is rejected.
 */
export function createOriginGuardedHandle<TEvent extends IpcEventLike = IpcEventLike>(
  ipcMain: IpcHandleRegistrar<TEvent>,
  trustedOrigin: string,
): OriginGuardedHandle<TEvent> {
  return <TArgs extends unknown[]>(
    channel: string,
    fn: (event: TEvent, ...args: TArgs) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      let senderOrigin = '';
      try {
        senderOrigin = new URL(event?.senderFrame?.url ?? '').origin;
      } catch {
        senderOrigin = '';
      }
      if (!trustedOrigin || senderOrigin !== trustedOrigin) {
        throw new Error(`IPC ${channel} rejected: untrusted sender origin`);
      }
      return fn(event, ...(args as TArgs));
    });
  };
}

export interface AuthIpcTarget {
  authStatus(opts?: { forceRefresh?: boolean }): Promise<AuthStatus>;
  serverSignIn(): Promise<ServerSignInResult>;
  cancelServerSignIn(): Promise<boolean> | boolean;
  serverSignOut(): Promise<void>;
  claudeSignIn(): Promise<ClaudeSignInResult>;
  cancelClaudeSignIn(): Promise<boolean> | boolean;
  getActiveClaudeSignInUrl(): Promise<string | null> | string | null;
  submitClaudeAuthCode(code: unknown): Promise<ClaudeCodeSubmitResult>;
  claudeSignOut(): Promise<ClaudeSignOutResult>;
}

/**
 * Registers all 9 authentication IPC channels (status, Entra corporate auth, and Claude auth)
 * through a single shared origin-guarded handle.
 */
export function registerAuthIpc<TEvent extends IpcEventLike = IpcEventLike>(deps: {
  handle: OriginGuardedHandle<TEvent>;
  appCore: AuthIpcTarget;
  writeClipboardText: (text: string) => void;
}): void {
  deps.handle(IpcChannels.authStatus, (_event, opts?: unknown) => {
    const forceRefresh =
      opts !== null &&
      typeof opts === 'object' &&
      (opts as { forceRefresh?: unknown }).forceRefresh === true;
    return deps.appCore.authStatus({ forceRefresh });
  });
  deps.handle(IpcChannels.authSignin, () => deps.appCore.serverSignIn());
  deps.handle(IpcChannels.authCancelSignin, async () =>
    Boolean(await deps.appCore.cancelServerSignIn()),
  );
  deps.handle(IpcChannels.authSignout, () => deps.appCore.serverSignOut());
  deps.handle(IpcChannels.authClaudeSignin, () => deps.appCore.claudeSignIn());
  deps.handle(IpcChannels.authClaudeCancel, async () =>
    Boolean(await deps.appCore.cancelClaudeSignIn()),
  );
  deps.handle(IpcChannels.authClaudeCopyUrl, async () => {
    const url = await deps.appCore.getActiveClaudeSignInUrl();
    if (!url) {
      return false;
    }
    deps.writeClipboardText(url);
    return true;
  });
  deps.handle(IpcChannels.authClaudeSubmitCode, (_event, code: unknown) =>
    deps.appCore.submitClaudeAuthCode(code),
  );
  deps.handle(IpcChannels.authClaudeSignout, () => deps.appCore.claudeSignOut());
}

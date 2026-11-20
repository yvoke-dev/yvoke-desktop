import { describe, expect, it, vi } from 'vitest';
import { IpcChannels } from '../src/shared/ipc';
import { createOriginGuardedHandle, registerAuthIpc } from '../src/main/ipcOrigin';
import type { DesktopApi } from '../src/preload/index';

describe('createOriginGuardedHandle & registerAuthIpc boundary validation', () => {
  const TRUSTED_ORIGIN = 'http://localhost:5173';

  function setup(trustedOrigin = TRUSTED_ORIGIN) {
    const handlers = new Map<
      string,
      (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown
    >();

    const appCore = {
      authStatus: vi.fn().mockResolvedValue({
        claude: 'ok' as const,
        claudeAccount: 'dev@yvoke.ai',
        server: { mode: 'entra' as const, signedIn: true, account: 'corp@yvoke.ai' },
      }),
      serverSignIn: vi.fn().mockResolvedValue({ status: 'signed_in' as const, account: 'corp@yvoke.ai' }),
      cancelServerSignIn: vi.fn().mockReturnValue(true),
      serverSignOut: vi.fn().mockResolvedValue(undefined),
      claudeSignIn: vi.fn().mockResolvedValue({ status: 'signed_in' as const, account: 'dev@yvoke.ai' }),
      cancelClaudeSignIn: vi.fn().mockReturnValue(true),
      getActiveClaudeSignInUrl: vi.fn<() => Promise<string | null>>().mockResolvedValue(
        'https://claude.ai/oauth/authorize?client_id=1&state=nonce',
      ),
      submitClaudeAuthCode: vi.fn().mockImplementation(async (code: unknown) =>
        typeof code === 'string' && /^[^\s#]+#[^\s#]+$/.test(code.trim())
          ? { accepted: true as const }
          : { accepted: false as const, message: 'Invalid authorization code' },
      ),
      claudeSignOut: vi.fn().mockResolvedValue({ status: 'signed_out' as const }),
    };
    const writeClipboardText = vi.fn();

    const handle = createOriginGuardedHandle(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      trustedOrigin,
    );

    registerAuthIpc({
      handle,
      appCore,
      writeClipboardText,
    });

    const invoke = async (
      channel: string,
      senderFrame: { url?: string } | null | undefined,
      ...args: unknown[]
    ) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`Missing handler for ${channel}`);
      }
      return handler({ senderFrame }, ...args);
    };

    return { handlers, appCore, writeClipboardText, invoke };
  }

  const ALL_AUTH_CHANNELS = [
    IpcChannels.authStatus,
    IpcChannels.authSignin,
    IpcChannels.authCancelSignin,
    IpcChannels.authSignout,
    IpcChannels.authClaudeSignin,
    IpcChannels.authClaudeCancel,
    IpcChannels.authClaudeCopyUrl,
    IpcChannels.authClaudeSubmitCode,
    IpcChannels.authClaudeSignout,
  ] as const;

  it('registers all 9 auth channels through one shared origin guard and serves trusted invocations', async () => {
    const { handlers, appCore, writeClipboardText, invoke } = setup();
    expect(handlers.size).toBe(9);
    const trustedFrame = { url: 'http://localhost:5173/index.html' };

    expect(await invoke(IpcChannels.authStatus, trustedFrame)).toEqual({
      claude: 'ok',
      claudeAccount: 'dev@yvoke.ai',
      server: { mode: 'entra', signedIn: true, account: 'corp@yvoke.ai' },
    });
    expect(appCore.authStatus).toHaveBeenLastCalledWith({ forceRefresh: false });

    expect(await invoke(IpcChannels.authStatus, trustedFrame, { forceRefresh: true })).toEqual({
      claude: 'ok',
      claudeAccount: 'dev@yvoke.ai',
      server: { mode: 'entra', signedIn: true, account: 'corp@yvoke.ai' },
    });
    expect(appCore.authStatus).toHaveBeenLastCalledWith({ forceRefresh: true });

    expect(await invoke(IpcChannels.authSignin, trustedFrame)).toEqual({
      status: 'signed_in',
      account: 'corp@yvoke.ai',
    });
    expect(appCore.serverSignIn).toHaveBeenCalledTimes(1);

    expect(await invoke(IpcChannels.authCancelSignin, trustedFrame)).toBe(true);
    expect(appCore.cancelServerSignIn).toHaveBeenCalledTimes(1);

    await expect(invoke(IpcChannels.authSignout, trustedFrame)).resolves.toBeUndefined();
    expect(appCore.serverSignOut).toHaveBeenCalledTimes(1);

    expect(await invoke(IpcChannels.authClaudeSignin, trustedFrame)).toEqual({
      status: 'signed_in',
      account: 'dev@yvoke.ai',
    });
    expect(appCore.claudeSignIn).toHaveBeenCalledTimes(1);

    expect(await invoke(IpcChannels.authClaudeCancel, trustedFrame)).toBe(true);
    expect(appCore.cancelClaudeSignIn).toHaveBeenCalledTimes(1);

    expect(await invoke(IpcChannels.authClaudeCopyUrl, trustedFrame)).toBe(true);
    expect(writeClipboardText).toHaveBeenCalledTimes(1);
    expect(writeClipboardText).toHaveBeenCalledWith(
      'https://claude.ai/oauth/authorize?client_id=1&state=nonce',
    );

    expect(await invoke(IpcChannels.authClaudeSubmitCode, trustedFrame, 'code1#state1')).toEqual({
      accepted: true,
    });
    expect(appCore.submitClaudeAuthCode).toHaveBeenCalledWith('code1#state1');

    expect(await invoke(IpcChannels.authClaudeSignout, trustedFrame)).toEqual({
      status: 'signed_out',
    });
    expect(appCore.claudeSignOut).toHaveBeenCalledTimes(1);
  });

  it('validates authStatus opts strictly so only { forceRefresh: true } enables forceRefresh', async () => {
    const { appCore, invoke } = setup();
    const trustedFrame = { url: 'http://localhost:5173/index.html' };

    for (const nonTrueOpt of [
      undefined,
      null,
      false,
      true,
      'true',
      1,
      {},
      { forceRefresh: false },
      { forceRefresh: 1 },
      { forceRefresh: 'true' },
      { forceRefresh: {} },
    ]) {
      appCore.authStatus.mockClear();
      await invoke(IpcChannels.authStatus, trustedFrame, nonTrueOpt);
      expect(appCore.authStatus).toHaveBeenCalledWith({ forceRefresh: false });
    }

    appCore.authStatus.mockClear();
    await invoke(IpcChannels.authStatus, trustedFrame, { forceRefresh: true });
    expect(appCore.authStatus).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('allows packaged file:// apps (origin === "null") while still rejecting missing/empty/foreign origins', async () => {
    const { appCore, invoke } = setup(new URL('file:///Applications/Yvoke.app/index.html').origin);

    expect(
      await invoke(IpcChannels.authStatus, { url: 'file:///Applications/Yvoke.app/index.html' }),
    ).toBeDefined();
    expect(appCore.authStatus).toHaveBeenCalledTimes(1);

    for (const badFrame of [
      { url: 'https://attacker.example/phish.html' },
      { url: '' },
      { url: undefined },
      undefined,
      null,
    ]) {
      await expect(invoke(IpcChannels.authStatus, badFrame)).rejects.toThrow(
        `IPC ${IpcChannels.authStatus} rejected: untrusted sender origin`,
      );
    }
    expect(appCore.authStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign, empty, undefined, and malformed senderFrame.url across all 9 channels before touching appCore or clipboard', async () => {
    const { appCore, writeClipboardText, invoke } = setup();
    const untrustedFrames: Array<{ url?: string } | null | undefined> = [
      { url: 'https://attacker.example/phish.html' },
      { url: '' },
      { url: undefined },
      { url: ':::not-a-valid-url:::' },
      undefined,
      null,
    ];

    for (const channel of ALL_AUTH_CHANNELS) {
      for (const frame of untrustedFrames) {
        await expect(invoke(channel, frame, 'code#state')).rejects.toThrow(
          `IPC ${channel} rejected: untrusted sender origin`,
        );
      }
    }

    expect(appCore.authStatus).not.toHaveBeenCalled();
    expect(appCore.serverSignIn).not.toHaveBeenCalled();
    expect(appCore.cancelServerSignIn).not.toHaveBeenCalled();
    expect(appCore.serverSignOut).not.toHaveBeenCalled();
    expect(appCore.claudeSignIn).not.toHaveBeenCalled();
    expect(appCore.cancelClaudeSignIn).not.toHaveBeenCalled();
    expect(appCore.getActiveClaudeSignInUrl).not.toHaveBeenCalled();
    expect(appCore.submitClaudeAuthCode).not.toHaveBeenCalled();
    expect(appCore.claudeSignOut).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('fails closed when trustedOrigin itself is empty even if senderFrame.url is also empty', async () => {
    const { appCore, writeClipboardText, invoke } = setup('');

    for (const channel of ALL_AUTH_CHANNELS) {
      await expect(invoke(channel, { url: '' })).rejects.toThrow(
        `IPC ${channel} rejected: untrusted sender origin`,
      );
    }
    expect(appCore.authStatus).not.toHaveBeenCalled();
    expect(appCore.serverSignIn).not.toHaveBeenCalled();
    expect(appCore.cancelServerSignIn).not.toHaveBeenCalled();
    expect(appCore.serverSignOut).not.toHaveBeenCalled();
    expect(appCore.claudeSignIn).not.toHaveBeenCalled();
    expect(appCore.cancelClaudeSignIn).not.toHaveBeenCalled();
    expect(appCore.getActiveClaudeSignInUrl).not.toHaveBeenCalled();
    expect(appCore.submitClaudeAuthCode).not.toHaveBeenCalled();
    expect(appCore.claudeSignOut).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('calls writeClipboardText 0 times and returns false when getActiveClaudeSignInUrl() resolves null', async () => {
    const { appCore, writeClipboardText, invoke } = setup();
    appCore.getActiveClaudeSignInUrl.mockResolvedValueOnce(null);

    const copied = await invoke(IpcChannels.authClaudeCopyUrl, {
      url: 'http://localhost:5173/index.html',
    });

    expect(copied).toBe(false);
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('rejects non-string payloads on auth:claude-submit-code cleanly', async () => {
    const { invoke } = setup();
    const trustedFrame = { url: 'http://localhost:5173/index.html' };

    for (const nonString of [123, null, undefined, { code: 'a#b' }, ['a#b']]) {
      expect(await invoke(IpcChannels.authClaudeSubmitCode, trustedFrame, nonString)).toEqual({
        accepted: false,
        message: 'Invalid authorization code',
      });
    }
  });
});

describe('preload DesktopApi auth methods', () => {
  it('exposes authStatus (with optional forceRefresh), Claude auth, and server auth methods wired to IpcChannels', async () => {
    vi.resetModules();
    let exposedApi: DesktopApi | undefined;
    const invokeMock = vi.fn();

    vi.doMock('electron', () => ({
      contextBridge: {
        exposeInMainWorld: (_key: string, api: DesktopApi) => {
          exposedApi = api;
        },
      },
      ipcRenderer: {
        invoke: (...args: unknown[]) => invokeMock(...args),
        on: vi.fn(),
        removeListener: vi.fn(),
      },
    }));

    try {
      await import('../src/preload/index');
      expect(exposedApi).toBeDefined();

      invokeMock.mockResolvedValueOnce({ claude: 'ok', server: { mode: 'dev', signedIn: true } });
      await expect(exposedApi!.authStatus()).resolves.toEqual({
        claude: 'ok',
        server: { mode: 'dev', signedIn: true },
      });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authStatus);

      invokeMock.mockResolvedValueOnce({ claude: 'ok', server: { mode: 'dev', signedIn: true } });
      await expect(exposedApi!.authStatus({ forceRefresh: true })).resolves.toEqual({
        claude: 'ok',
        server: { mode: 'dev', signedIn: true },
      });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authStatus, { forceRefresh: true });

      invokeMock.mockResolvedValueOnce({ status: 'signed_in', account: 'u@yvoke.ai' });
      await expect(exposedApi!.claudeSignIn()).resolves.toEqual({
        status: 'signed_in',
        account: 'u@yvoke.ai',
      });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authClaudeSignin);

      invokeMock.mockResolvedValueOnce(true);
      await expect(exposedApi!.cancelClaudeSignIn()).resolves.toBe(true);
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authClaudeCancel);

      invokeMock.mockResolvedValueOnce(false);
      await expect(exposedApi!.copyClaudeSignInUrl()).resolves.toBe(false);
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authClaudeCopyUrl);

      invokeMock.mockResolvedValueOnce({ accepted: true });
      await expect(exposedApi!.submitClaudeAuthCode('abc#xyz')).resolves.toEqual({ accepted: true });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authClaudeSubmitCode, 'abc#xyz');

      invokeMock.mockResolvedValueOnce({ status: 'signed_out' });
      await expect(exposedApi!.claudeSignOut()).resolves.toEqual({ status: 'signed_out' });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authClaudeSignout);

      invokeMock.mockResolvedValueOnce({ status: 'signed_in', account: 'corp@yvoke.ai' });
      await expect(exposedApi!.serverSignIn()).resolves.toEqual({
        status: 'signed_in',
        account: 'corp@yvoke.ai',
      });
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authSignin);

      invokeMock.mockResolvedValueOnce(true);
      await expect(exposedApi!.cancelServerSignIn()).resolves.toBe(true);
      expect(invokeMock).toHaveBeenLastCalledWith(IpcChannels.authCancelSignin);
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});

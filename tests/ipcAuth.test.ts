import { describe, expect, it, vi } from 'vitest';
import { IpcChannels } from '../src/shared/ipc';
import { registerClaudeAuthIpc } from '../src/main/agent/ClaudeAuth';
import type { DesktopApi } from '../src/preload/index';

describe('registerClaudeAuthIpc boundary validation', () => {
  const TRUSTED_ORIGIN = 'http://localhost:5173';

  function setup(trustedOrigin = TRUSTED_ORIGIN) {
    const handlers = new Map<
      string,
      (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => Promise<unknown>
    >();

    const appCore = {
      claudeSignIn: vi.fn().mockResolvedValue({ status: 'signed_in', account: 'dev@yvoke.ai' }),
      cancelClaudeSignIn: vi.fn().mockReturnValue(true),
      getActiveClaudeSignInUrl: vi.fn<() => Promise<string | null>>().mockResolvedValue(
        'https://claude.ai/oauth/authorize?client_id=1&state=nonce',
      ),
      submitClaudeAuthCode: vi.fn().mockImplementation(async (code: unknown) =>
        typeof code === 'string' && /^[^\s#]+#[^\s#]+$/.test(code.trim())
          ? { accepted: true as const }
          : { accepted: false as const, message: 'Invalid authorization code' },
      ),
    };
    const writeClipboardText = vi.fn();

    registerClaudeAuthIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, async (event, ...args) => listener(event, ...args));
        },
      },
      trustedOrigin,
      appCore,
      writeClipboardText,
    });

    const invoke = (
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

  it('registers all 4 auth:claude-* channels and serves trusted sender invocations', async () => {
    const { appCore, writeClipboardText, invoke } = setup();
    const trustedFrame = { url: 'http://localhost:5173/index.html' };

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
  });

  it('rejects foreign, empty, undefined, and malformed senderFrame.url across all 4 channels before touching appCore or clipboard', async () => {
    const { appCore, writeClipboardText, invoke } = setup();
    const channels = [
      IpcChannels.authClaudeSignin,
      IpcChannels.authClaudeCancel,
      IpcChannels.authClaudeCopyUrl,
      IpcChannels.authClaudeSubmitCode,
    ];
    const untrustedFrames: Array<{ url?: string } | null | undefined> = [
      { url: 'https://attacker.example/phish.html' },
      { url: '' },
      { url: undefined },
      { url: ':::not-a-valid-url:::' },
      undefined,
      null,
    ];

    for (const channel of channels) {
      for (const frame of untrustedFrames) {
        await expect(invoke(channel, frame, 'code#state')).rejects.toThrow(
          `IPC ${channel} rejected: untrusted sender origin`,
        );
      }
    }

    expect(appCore.claudeSignIn).not.toHaveBeenCalled();
    expect(appCore.cancelClaudeSignIn).not.toHaveBeenCalled();
    expect(appCore.getActiveClaudeSignInUrl).not.toHaveBeenCalled();
    expect(appCore.submitClaudeAuthCode).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it('fails closed when trustedOrigin itself is empty even if senderFrame.url is also empty', async () => {
    const { appCore, writeClipboardText, invoke } = setup('');

    await expect(invoke(IpcChannels.authClaudeSignin, { url: '' })).rejects.toThrow(
      `IPC ${IpcChannels.authClaudeSignin} rejected: untrusted sender origin`,
    );
    expect(appCore.claudeSignIn).not.toHaveBeenCalled();
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

describe('preload DesktopApi Claude auth methods', () => {
  it('exposes claudeSignIn, cancelClaudeSignIn, copyClaudeSignInUrl, and submitClaudeAuthCode wired to IpcChannels', async () => {
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
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});

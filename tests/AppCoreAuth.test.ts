import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCore as AppCoreInstance } from '../src/main/AppCore';
import type { LoginVerificationResult } from '../src/shared/types';
import type { ServerTokenVerification } from '../src/main/auth/ServerAuth';

const mockSdkQuery = vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'result', subtype: 'success', is_error: false, result: 'pong' };
  },
  close: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (...args: unknown[]) => (mockSdkQuery as (...a: unknown[]) => unknown)(...args),
  };
});

const { AppCore } = await import('../src/main/AppCore');

describe('AppCore.verifyAuth', () => {
  let tmpDir: string;
  let appCore: AppCoreInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-auth-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Test 2.5: Concurrent appCore.verifyAuth() calls are coalesced into a single probe', async () => {
    let tokenResolve!: (res: ServerTokenVerification) => void;
    const tokenPromise = new Promise<ServerTokenVerification>((r) => {
      tokenResolve = r;
    });
    const verifyTokenSpy = vi
      .spyOn(appCore.serverAuth, 'verifyToken')
      .mockImplementation(() => tokenPromise);

    const verifyConnSpy = vi
      .spyOn(appCore.syncClient, 'verifyConnection')
      .mockResolvedValue({ status: 'ok' });

    const claudeResult: LoginVerificationResult = { status: 'ok', account: 'test@claude.ai' };
    const verifyClaudeSpy = vi
      .spyOn(appCore.agent, 'verifyClaudeCredentials')
      .mockResolvedValue(claudeResult);

    // Call verifyAuth concurrently twice
    const p1 = appCore.verifyAuth();
    const p2 = appCore.verifyAuth();

    expect(p1).toBe(p2);

    tokenResolve({ status: 'ok', token: 'mock-token', account: 'user@example.com' });

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toEqual({
      server: { status: 'ok', account: 'user@example.com' },
      claude: claudeResult,
    });
    expect(res2).toEqual(res1);

    expect(verifyTokenSpy).toHaveBeenCalledTimes(1);
    expect(verifyConnSpy).toHaveBeenCalledTimes(1);
    expect(verifyConnSpy).toHaveBeenCalledWith('mock-token');
    expect(verifyClaudeSpy).toHaveBeenCalledTimes(1);

    // Subsequent call after finish triggers a new probe
    const p3 = appCore.verifyAuth();
    expect(p3).not.toBe(p1);
    await p3;
    expect(verifyTokenSpy).toHaveBeenCalledTimes(2);
  });

  it('server check returns unreachable if serverBaseUrl is not configured', async () => {
    appCore.settings.set({ serverBaseUrl: '' });

    const verifyTokenSpy = vi.spyOn(appCore.serverAuth, 'verifyToken');
    vi.spyOn(appCore.agent, 'verifyClaudeCredentials').mockResolvedValue({
      status: 'ok',
      account: 'claude@test',
    });

    const res = await appCore.verifyAuth();

    expect(res.server).toEqual({
      status: 'unreachable',
      message: 'Server URL not configured',
    });
    expect(verifyTokenSpy).not.toHaveBeenCalled();
    expect(res.claude).toEqual({ status: 'ok', account: 'claude@test' });
  });

  it('returns serverAuth failure without calling syncClient.verifyConnection if verifyToken fails', async () => {
    appCore.settings.set({ serverBaseUrl: 'https://api.yvoke.example' });

    vi.spyOn(appCore.serverAuth, 'verifyToken').mockResolvedValue({
      status: 'expired',
      message: 'Session expired',
    });
    const verifyConnSpy = vi.spyOn(appCore.syncClient, 'verifyConnection');
    vi.spyOn(appCore.agent, 'verifyClaudeCredentials').mockResolvedValue({
      status: 'ok',
      account: 'claude@test',
    });

    const res = await appCore.verifyAuth();

    expect(res.server).toEqual({
      status: 'expired',
      message: 'Session expired',
    });
    expect(verifyConnSpy).not.toHaveBeenCalled();
  });
});

describe('AppCore.verifyAuth secrets', () => {
  let tmpDir: string;
  let appCore: AppCoreInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-auth-secret-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The response crosses IPC into the renderer. A bearer token must never ride along, on any
  // branch — including the one where the server leg succeeds and carries the account across.
  it('never puts the bearer token in the IPC response', async () => {
    appCore.settings.set({ serverBaseUrl: 'https://api.yvoke.example' });

    vi.spyOn(appCore.serverAuth, 'verifyToken').mockResolvedValue({
      status: 'ok',
      account: 'user@example.com',
      token: 'super-secret-bearer',
    });
    vi.spyOn(appCore.syncClient, 'verifyConnection').mockResolvedValue({ status: 'ok' });
    vi.spyOn(appCore.agent, 'verifyClaudeCredentials').mockResolvedValue({ status: 'ok' });

    const res = await appCore.verifyAuth();

    expect(JSON.stringify(res)).not.toContain('super-secret-bearer');
    expect(res.server).not.toHaveProperty('token');
    expect(res.claude).not.toHaveProperty('token');
  });
});

describe('AppCore integration with ClaudeAuthManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-claude-auth-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFakeClaudeAuth() {
    return {
      getStatus: vi.fn().mockResolvedValue({ claude: 'ok' as const, claudeAccount: 'claude@yvoke.ai' }),
      invalidateStatusCache: vi.fn(),
      signIn: vi.fn().mockResolvedValue({ status: 'signed_in' as const, account: 'claude@yvoke.ai' }),
      cancelSignIn: vi.fn().mockReturnValue(true),
      getActiveSignInUrl: vi.fn().mockResolvedValue('https://claude.ai/oauth/authorize?state=x'),
      submitAuthCode: vi.fn().mockResolvedValue({ accepted: true as const }),
      dispose: vi.fn(),
    };
  }

  it('delegates authStatus() to claudeAuth, invalidates status cache synchronously BEFORE emitting authRequired events, closes idle sessions on signed_in, and disposes claudeAuth', async () => {
    const claudeAuth = makeFakeClaudeAuth();
    const callOrder: string[] = [];
    claudeAuth.invalidateStatusCache.mockImplementation(() => {
      callOrder.push('invalidateStatusCache');
    });

    const core = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: (event) => {
        callOrder.push(`emit:${event.kind}:${String((event as { authRequired?: boolean }).authRequired)}`);
      },
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
      claudeAuth: claudeAuth as any,
    });

    try {
      // 1. authStatus uses claudeAuth.getStatus()
      const status = await core.authStatus();
      expect(status.claude).toBe('ok');
      expect(status.claudeAccount).toBe('claude@yvoke.ai');
      expect(claudeAuth.getStatus).toHaveBeenCalledTimes(1);

      // 2. Synchronous cache invalidation BEFORE emitAgentEvent on authRequired: true (both error and turn-complete)
      (core.agent as any).deps.emit({
        kind: 'error',
        threadId: 't-1',
        message: 'Claude: Sign in to Claude',
        authRequired: true,
      });
      (core.agent as any).deps.emit({
        kind: 'turn-complete',
        threadId: 't-1',
        message: { localId: 'a-1', role: 'assistant', content: '', createdAt: '' },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 10,
        isError: true,
        errorMessage: 'Claude: Sign in to Claude',
        authRequired: true,
      });
      // Non-auth error does NOT invalidate cache
      (core.agent as any).deps.emit({
        kind: 'error',
        threadId: 't-1',
        message: 'Claude: Rate limited',
        authRequired: false,
      });

      expect(callOrder).toEqual([
        'invalidateStatusCache',
        'emit:error:true',
        'invalidateStatusCache',
        'emit:turn-complete:true',
        'emit:error:false',
      ]);

      // 3. claudeSignIn() closes idle sessions ONLY on signed_in
      const closeIdleSpy = vi.spyOn(core.agent, 'closeIdleSessions');
      expect(await core.claudeSignIn()).toEqual({ status: 'signed_in', account: 'claude@yvoke.ai' });
      expect(closeIdleSpy).toHaveBeenCalledTimes(1);

      claudeAuth.signIn.mockResolvedValueOnce({ status: 'cancelled' });
      expect(await core.claudeSignIn()).toEqual({ status: 'cancelled' });
      expect(closeIdleSpy).toHaveBeenCalledTimes(1);

      // 4. cancel / url / submit code delegation
      expect(core.cancelClaudeSignIn()).toBe(true);
      expect(await core.getActiveClaudeSignInUrl()).toBe('https://claude.ai/oauth/authorize?state=x');
      expect(await core.submitClaudeAuthCode('c#s')).toEqual({ accepted: true });
    } finally {
      core.dispose();
    }

    expect(claudeAuth.dispose).toHaveBeenCalledTimes(1);
  });

  it('wires claudeAuth isClaudeMissing into verifyAuth() so Keychain signed-out profiles report missing without probing', async () => {
    mockSdkQuery.mockClear();
    const claudeAuth = makeFakeClaudeAuth();
    claudeAuth.getStatus.mockResolvedValue({ claude: 'missing', claudeAccount: undefined });

    const core = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
      claudeAuth: claudeAuth as any,
    });

    try {
      core.settings.set({ serverBaseUrl: '' });
      const res = await core.verifyAuth();
      expect(res.claude.status).toBe('missing');
      if (res.claude.status !== 'ok') {
        expect(res.claude.message).toMatch(/Sign in to Claude/i);
      }
      expect(mockSdkQuery).not.toHaveBeenCalled();
    } finally {
      core.dispose();
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import type { LoginVerificationResult } from '../src/shared/types';
import type { ServerTokenVerification } from '../src/main/auth/ServerAuth';

describe('AppCore.verifyAuth', () => {
  let tmpDir: string;
  let appCore: AppCore;

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
  let appCore: AppCore;

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

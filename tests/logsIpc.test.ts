import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IpcChannels } from '../src/shared/ipc';

describe('logsOpenFolder IPC handler', () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-test-ipc-'));
    logsDir = path.join(tmpDir, 'logs');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper that mirrors registerIpc's origin-guarded handle wrapper
   */
  function createMockIpcContext(trustedOrigin: string, userDataDir: string, openPathFn: (p: string) => Promise<string>) {
    const handlers = new Map<string, (event: { senderFrame?: { url: string } }, ...args: unknown[]) => Promise<unknown>>();

    const handle = (
      channel: string,
      fn: (event: { senderFrame?: { url: string } }, ...args: unknown[]) => unknown,
    ): void => {
      handlers.set(channel, async (event, ...args) => {
        let senderOrigin = '';
        try {
          senderOrigin = new URL(event.senderFrame?.url ?? '').origin;
        } catch {
          senderOrigin = '';
        }
        if (senderOrigin !== trustedOrigin) {
          throw new Error(`IPC ${channel} rejected: untrusted sender origin`);
        }
        return fn(event, ...args);
      });
    };

    // Handler under test:
    handle(IpcChannels.logsOpenFolder, async () => {
      const dir = path.join(userDataDir, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      try {
        const err = await openPathFn(dir);
        if (err) {
          console.error(`Failed to open logs folder: ${err}`);
        }
      } catch (err) {
        console.error(`Failed to open logs folder: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    return {
      invoke: (channel: string, senderUrl: string, ...args: unknown[]) => {
        const h = handlers.get(channel);
        if (!h) throw new Error(`No handler registered for ${channel}`);
        return h({ senderFrame: { url: senderUrl } }, ...args);
      },
    };
  }

  it('ensures logs directory is created recursively and invokes openPath', async () => {
    let openedPath = '';
    const openPathFn = vi.fn(async (target: string) => {
      openedPath = target;
      return '';
    });

    const trustedOrigin = 'http://localhost:5173';
    const ipc = createMockIpcContext(trustedOrigin, tmpDir, openPathFn);

    expect(fs.existsSync(logsDir)).toBe(false);

    await ipc.invoke(IpcChannels.logsOpenFolder, 'http://localhost:5173/index.html');

    expect(fs.existsSync(logsDir)).toBe(true);
    expect(openPathFn).toHaveBeenCalledWith(logsDir);
    expect(openedPath).toBe(logsDir);
  });

  it('rejects invocation from untrusted sender origin', async () => {
    const openPathFn = vi.fn(async () => '');
    const trustedOrigin = 'http://localhost:5173';
    const ipc = createMockIpcContext(trustedOrigin, tmpDir, openPathFn);

    await expect(
      ipc.invoke(IpcChannels.logsOpenFolder, 'https://evil.com/index.html'),
    ).rejects.toThrow(/untrusted sender origin/);

    expect(openPathFn).not.toHaveBeenCalled();
    expect(fs.existsSync(logsDir)).toBe(false);
  });

  it('does not crash or throw when openPath returns an error or rejects', async () => {
    const failingOpenPath = vi.fn(async () => 'Failed to open directory (OS error)');
    const trustedOrigin = 'http://localhost:5173';
    const ipc = createMockIpcContext(trustedOrigin, tmpDir, failingOpenPath);

    await expect(
      ipc.invoke(IpcChannels.logsOpenFolder, 'http://localhost:5173/index.html'),
    ).resolves.toBeUndefined();

    expect(failingOpenPath).toHaveBeenCalled();
  });
});

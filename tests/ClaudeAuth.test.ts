import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_WRITE_TIMEOUT_MS,
  CLAUDE_LOGIN_CODE_EXCHANGE_TIMEOUT_MS,
  CLAUDE_LOGIN_TIMEOUT_MS,
  CLAUDE_LOGIN_URL_TIMEOUT_MS,
  CLAUDE_LOGOUT_TIMEOUT_MS,
  CLAUDE_MISSING_CACHE_TTL_MS,
  CLAUDE_STATUS_CACHE_TTL_MS,
  CLAUDE_STATUS_TIMEOUT_MS,
  CLAUDE_URL_CONTINUATION_SETTLE_MS,
  ClaudeAuthManager,
  LOGIN_INSTRUCTIONS,
  classifyClaudeFailure,
  claudeCliEnv,
  resolveClaudeBinaryPath,
  type SpawnedCliProcess,
} from '../src/main/agent/ClaudeAuth';
import { ResultError } from '../src/main/agent/singleTurn';

class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  throwOnWrite: Error | null = null;
  callbackError: Error | null = null;
  deferCallback = false;
  pendingCallback: ((err?: Error | null) => void) | null = null;
  destroyed = false;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(chunk);
    if (callback) {
      if (this.deferCallback) {
        this.pendingCallback = callback;
      } else if (this.callbackError) {
        const err = this.callbackError;
        queueMicrotask(() => callback(err));
      } else {
        callback(null);
      }
    }
    return true;
  }

  end(): void {
    this.destroyed = true;
  }
}

class FakeChildProcess extends EventEmitter implements SpawnedCliProcess {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  autoCloseOnKill = false;

  kill = vi.fn((signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.autoCloseOnKill && this.exitCode === null) {
      this.finish(null);
    }
    return true;
  });

  emitStdout(data: string): void {
    this.stdout.emit('data', Buffer.from(data, 'utf8'));
  }

  emitStderr(data: string): void {
    this.stderr.emit('data', Buffer.from(data, 'utf8'));
  }

  finish(code: number | null): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

describe('ClaudeAuth copy & terminal instruction removal', () => {
  it('removes all claude /login and npm install instructions from LOGIN_INSTRUCTIONS and classifyClaudeFailure', () => {
    const samples = [
      LOGIN_INSTRUCTIONS,
      classifyClaudeFailure(new ResultError('Unauthorized', 'success', 401))?.message ?? '',
      classifyClaudeFailure(new ResultError('Forbidden', 'success', 403))?.message ?? '',
      classifyClaudeFailure(new Error('Not logged in · Please run /login'))?.message ?? '',
    ];

    for (const msg of samples) {
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/claude\s+\/login/i);
      expect(msg).not.toMatch(/npm\s+install/i);
      expect(msg).not.toMatch(/@anthropic-ai\/claude-code/i);
      expect(msg).toMatch(/Sign in to Claude/i);
    }
  });
});

describe('claudeCliEnv', () => {
  it('strips ANTHROPIC_API_KEY and NODE_OPTIONS and disables terminal colors/hyperlinks', () => {
    const env = claudeCliEnv({
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      NODE_OPTIONS: '--inspect=9229 --require /evil/preload.js',
      FORCE_COLOR: '3',
      FORCE_HYPERLINK: '1',
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NO_COLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.FORCE_HYPERLINK).toBe('0');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('resolveClaudeBinaryPath', () => {
  it('prefers staged binary under resourcesPath on darwin/linux and win32', () => {
    const resolveSdkEntry = vi.fn();
    const macResult = resolveClaudeBinaryPath({
      resourcesPath: '/Applications/Yvoke.app/Contents/Resources',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: (p) => p === path.join('/Applications/Yvoke.app/Contents/Resources', 'claude'),
      resolveSdkEntry,
    });
    expect(macResult).toBe(path.join('/Applications/Yvoke.app/Contents/Resources', 'claude'));
    expect(resolveSdkEntry).not.toHaveBeenCalled();

    const winResult = resolveClaudeBinaryPath({
      resourcesPath: 'C:\\Program Files\\Yvoke\\resources',
      platform: 'win32',
      arch: 'x64',
      existsSync: (p) => p === path.join('C:\\Program Files\\Yvoke\\resources', 'claude.exe'),
      resolveSdkEntry,
    });
    expect(winResult).toBe(path.join('C:\\Program Files\\Yvoke\\resources', 'claude.exe'));
  });

  it('resolves SDK platform binary via sdkEntry when staged binary is absent', () => {
    const sdkEntry = '/repo/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
    const sdkBin = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';

    const resolved = resolveClaudeBinaryPath({
      resourcesPath: '/repo/node_modules/electron/dist',
      platform: 'darwin',
      arch: 'arm64',
      existsSync: (p) => p === sdkBin,
      resolveSdkEntry: () => sdkEntry,
      resolveFromSdk: (from, spec) => {
        expect(from).toBe(sdkEntry);
        expect(spec).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
        return sdkBin;
      },
    });

    expect(resolved).toBe(sdkBin);
  });

  it('handles Linux musl preference and fallback between -musl and glibc packages', () => {
    const sdkEntry = '/repo/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
    const muslBin = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude';
    const glibcBin = '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

    const triedMuslFirst: string[] = [];
    const resMusl = resolveClaudeBinaryPath({
      resourcesPath: '',
      platform: 'linux',
      arch: 'x64',
      preferMusl: true,
      existsSync: (p) => p === muslBin,
      resolveSdkEntry: () => sdkEntry,
      resolveFromSdk: (_from, spec) => {
        triedMuslFirst.push(spec);
        return spec.includes('-musl') ? muslBin : glibcBin;
      },
    });
    expect(resMusl).toBe(muslBin);
    expect(triedMuslFirst).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude']);

    const triedGlibcThenMusl: string[] = [];
    const resFallback = resolveClaudeBinaryPath({
      resourcesPath: '',
      platform: 'linux',
      arch: 'arm64',
      preferMusl: false,
      existsSync: (p) => p === '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude',
      resolveSdkEntry: () => sdkEntry,
      resolveFromSdk: (_from, spec) => {
        triedGlibcThenMusl.push(spec);
        if (!spec.includes('-musl')) {
          throw new Error('MODULE_NOT_FOUND');
        }
        return '/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude';
      },
    });
    expect(resFallback).toBe('/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude');
    expect(triedGlibcThenMusl).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude',
    ]);
  });

  it('rewrites /app.asar/ segment to /app.asar.unpacked/ when unpacked sibling exists without mangling /my-app.asar-test/', () => {
    const asarBin =
      '/Applications/Yvoke.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
    const unpackedBin =
      '/Applications/Yvoke.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';

    expect(
      resolveClaudeBinaryPath({
        resourcesPath: '/Applications/Yvoke.app/Contents/Resources',
        platform: 'darwin',
        arch: 'arm64',
        existsSync: (p) => p === asarBin || p === unpackedBin,
        resolveSdkEntry: () => '/Applications/Yvoke.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
        resolveFromSdk: () => asarBin,
      }),
    ).toBe(unpackedBin);

    // Windows backslash segment
    const winAsar =
      'C:\\App\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
    const winUnpacked =
      'C:\\App\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
    expect(
      resolveClaudeBinaryPath({
        resourcesPath: 'C:\\App\\resources',
        platform: 'win32',
        arch: 'x64',
        existsSync: (p) => p === winUnpacked,
        resolveSdkEntry: () => 'C:\\App\\resources\\app.asar\\sdk.mjs',
        resolveFromSdk: () => winAsar,
      }),
    ).toBe(winUnpacked);

    // Must NEVER mangle /my-app.asar-test/
    const lookalikeDirBin =
      '/Users/dev/my-app.asar-test/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
    const checkedPaths: string[] = [];
    expect(
      resolveClaudeBinaryPath({
        resourcesPath: '',
        platform: 'darwin',
        arch: 'arm64',
        existsSync: (p) => {
          checkedPaths.push(p);
          return p === lookalikeDirBin;
        },
        resolveSdkEntry: () => '/Users/dev/my-app.asar-test/sdk.mjs',
        resolveFromSdk: () => lookalikeDirBin,
      }),
    ).toBe(lookalikeDirBin);
    expect(checkedPaths).not.toContain(
      '/Users/dev/my-app.asar.unpacked-test/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    );
  });

  it('returns null when bundled binaries are absent and never falls back to process.env.PATH', () => {
    const fakePathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-path-claude-'));
    const fakeGlobalClaude = path.join(fakePathDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    fs.writeFileSync(fakeGlobalClaude, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    const origPath = process.env.PATH;
    process.env.PATH = `${fakePathDir}${path.delimiter}${origPath ?? ''}`;

    try {
      const checked: string[] = [];
      const result = resolveClaudeBinaryPath({
        resourcesPath: '/nonexistent/resources',
        platform: 'darwin',
        arch: 'arm64',
        existsSync: (p) => {
          checked.push(p);
          return p === fakeGlobalClaude;
        },
        resolveSdkEntry: () => {
          throw new Error('Cannot find module @anthropic-ai/claude-agent-sdk');
        },
      });
      expect(result).toBeNull();
      expect(checked).not.toContain(fakeGlobalClaude);
    } finally {
      process.env.PATH = origPath;
      fs.rmSync(fakePathDir, { recursive: true, force: true });
    }
  });
});

describe('ClaudeAuthManager', () => {
  let tmpRoot: string;
  let sandboxDir: string;
  let homeDir: string;
  let nowMs: number;
  let spawned: Array<{ cmd: string; args: readonly string[]; opts: Record<string, unknown>; child: FakeChildProcess }>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-mgr-'));
    // Deliberately nested & uncreated to test first-launch mkdirSync before spawn
    sandboxDir = path.join(tmpRoot, 'uncreated-profile', 'agent-sandbox');
    homeDir = path.join(tmpRoot, 'home');
    fs.mkdirSync(homeDir, { recursive: true });
    nowMs = 1_000_000;
    spawned = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createManager(overrides: Partial<ConstructorParameters<typeof ClaudeAuthManager>[0]> = {}) {
    return new ClaudeAuthManager({
      sandboxDir,
      resolveBinary: () => '/bundled/claude',
      homedir: () => homeDir,
      now: () => nowMs,
      spawn: (cmd, args, opts) => {
        const child = new FakeChildProcess();
        spawned.push({ cmd, args, opts: opts as unknown as Record<string, unknown>, child });
        return child;
      },
      ...overrides,
    });
  }

  describe('getStatus & status caching', () => {
    it('pre-creates sandboxDir, passes windowsHide & sanitized env, caches ok for 30s, and strips org/tier metadata', async () => {
      const origApiKey = process.env.ANTHROPIC_API_KEY;
      const origNodeOpts = process.env.NODE_OPTIONS;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient';
      process.env.NODE_OPTIONS = '--require /bad.js';

      try {
        expect(fs.existsSync(sandboxDir)).toBe(false);
        const mgr = createManager();

        const p1 = mgr.getStatus();
        const p2 = mgr.getStatus(); // single-flight coalesced
        expect(spawned).toHaveLength(1);
        expect(fs.existsSync(sandboxDir)).toBe(true);
        expect(spawned[0].cmd).toBe('/bundled/claude');
        expect(spawned[0].args).toEqual(['auth', 'status', '--json']);
        expect(spawned[0].opts.cwd).toBe(sandboxDir);
        expect(spawned[0].opts.windowsHide).toBe(true);
        const spawnEnv = spawned[0].opts.env as Record<string, string | undefined>;
        expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnEnv.NODE_OPTIONS).toBeUndefined();
        expect(spawnEnv.NO_COLOR).toBe('1');
        expect(spawnEnv.FORCE_COLOR).toBe('0');
        expect(spawnEnv.FORCE_HYPERLINK).toBe('0');

        spawned[0].child.emitStdout(
          JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            email: 'consultant@yvoke.ai',
            orgId: 'org-secret-999',
            orgName: 'Secret Corp',
            subscriptionType: 'max',
          }),
        );
        spawned[0].child.finish(0);

        const [s1, s2] = await Promise.all([p1, p2]);
        expect(s1).toEqual({ claude: 'ok', claudeAccount: 'consultant@yvoke.ai' });
        expect(s2).toEqual(s1);
        expect(JSON.stringify(s1)).not.toContain('org-secret-999');
        expect(JSON.stringify(s1)).not.toContain('Secret Corp');
        expect(JSON.stringify(s1)).not.toContain('max');

        // Within 30s TTL -> cached, no second spawn
        nowMs += CLAUDE_STATUS_CACHE_TTL_MS - 1;
        const cached = await mgr.getStatus();
        expect(cached).toEqual({ claude: 'ok', claudeAccount: 'consultant@yvoke.ai' });
        expect(spawned).toHaveLength(1);

        // Past 30s TTL -> re-probes
        nowMs += 2;
        const p3 = mgr.getStatus();
        expect(spawned).toHaveLength(2);
        spawned[1].child.emitStdout(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', email: '' }));
        fs.writeFileSync(
          path.join(homeDir, '.claude.json'),
          JSON.stringify({ oauthAccount: { emailAddress: 'fallback@yvoke.ai' } }),
        );
        spawned[1].child.finish(0);
        expect(await p3).toEqual({ claude: 'ok', claudeAccount: 'fallback@yvoke.ai' });
      } finally {
        if (origApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = origApiKey;
        if (origNodeOpts === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = origNodeOpts;
      }
    });

    it('accepts claude.ai, oauth_token, api_key, third_party and rejects api_key_helper and none as missing', async () => {
      const mgr = createManager();
      for (const method of ['claude.ai', 'oauth_token', 'api_key', 'third_party']) {
        const p = mgr.getStatus({ forceRefresh: true });
        const last = spawned[spawned.length - 1];
        last.child.emitStdout(JSON.stringify({ loggedIn: true, authMethod: method, email: 'u@example.com' }));
        last.child.finish(0);
        expect(await p).toEqual({ claude: 'ok', claudeAccount: 'u@example.com' });
      }

      for (const rejectedMethod of ['api_key_helper', 'none']) {
        const p = mgr.getStatus({ forceRefresh: true });
        const last = spawned[spawned.length - 1];
        last.child.emitStdout(
          JSON.stringify({ loggedIn: true, authMethod: rejectedMethod, email: 'helper@example.com' }),
        );
        last.child.finish(0);
        expect(await p).toEqual({ claude: 'missing' });
      }
    });

    it('caches genuine missing status for 15s TTL, re-probes after 15s or on forceRefresh/signIn, and never caches fallback/error probes', async () => {
      // Simulate macOS ~/.claude directory existing without credentials (where detectClaudeCredentials was inconclusive)
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      const mgr = createManager();

      const p1 = mgr.getStatus();
      spawned[0].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[0].child.finish(0);
      expect(await p1).toEqual({ claude: 'missing' });

      // Within 15s TTL -> served from cache without spawning a second subprocess
      nowMs += CLAUDE_MISSING_CACHE_TTL_MS - 1;
      expect(await mgr.getStatus()).toEqual({ claude: 'missing' });
      expect(spawned).toHaveLength(1);

      // forceRefresh: true bypasses the 15s missing cache immediately
      const pForced = mgr.getStatus({ forceRefresh: true });
      expect(spawned).toHaveLength(2);
      spawned[1].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[1].child.finish(0);
      expect(await pForced).toEqual({ claude: 'missing' });

      // Past 15s TTL -> re-spawns and detects external sign-in
      nowMs += CLAUDE_MISSING_CACHE_TTL_MS + 1;
      const p2 = mgr.getStatus();
      expect(spawned).toHaveLength(3);
      spawned[2].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'now-signed-in@yvoke.ai' }),
      );
      spawned[2].child.finish(0);
      expect(await p2).toEqual({ claude: 'ok', claudeAccount: 'now-signed-in@yvoke.ai' });

      // signIn() entry invalidates cached status immediately
      const signInP = mgr.signIn();
      expect(spawned).toHaveLength(4);
      mgr.cancelSignIn();
      await signInP;
      const pAfterCancel = mgr.getStatus();
      expect(spawned).toHaveLength(5);
      spawned[4].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[4].child.finish(0);
      expect(await pAfterCancel).toEqual({ claude: 'missing' });

      // Fallback/corrupt-JSON probe is NEVER cached
      const pCorrupt = mgr.getStatus({ forceRefresh: true });
      spawned[5].child.emitStdout('{{{corrupt');
      spawned[5].child.finish(0);
      await pCorrupt;
      const pAfterCorrupt = mgr.getStatus();
      expect(spawned).toHaveLength(7);
      spawned[6].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[6].child.finish(0);
      expect(await pAfterCorrupt).toEqual({ claude: 'missing' });
    });

    it('falls back to detectClaudeCredentials + detectClaudeAccount on corrupt JSON, non-boolean loggedIn, ENOENT, null binary, and 4s timeout', async () => {
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), '{}');
      fs.writeFileSync(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'disk@yvoke.ai' } }),
      );

      // 1. Corrupt JSON
      const mgr = createManager();
      const pCorrupt = mgr.getStatus();
      spawned[0].child.emitStdout('not valid json {{{');
      spawned[0].child.finish(0);
      expect(await pCorrupt).toEqual({ claude: 'ok', claudeAccount: 'disk@yvoke.ai' });

      // 2. Non-boolean loggedIn
      const pBadSchema = mgr.getStatus({ forceRefresh: true });
      spawned[1].child.emitStdout(JSON.stringify({ loggedIn: 'yes', authMethod: 'claude.ai' }));
      spawned[1].child.finish(0);
      expect(await pBadSchema).toEqual({ claude: 'ok', claudeAccount: 'disk@yvoke.ai' });

      // 3. ENOENT spawn error when disk has no credentials
      fs.rmSync(path.join(homeDir, '.claude'), { recursive: true, force: true });
      fs.rmSync(path.join(homeDir, '.claude.json'), { force: true });
      const pEnoent = mgr.getStatus({ forceRefresh: true });
      spawned[2].child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      expect(await pEnoent).toEqual({ claude: 'missing', claudeAccount: undefined });

      // 4. Null binary
      const nullBinMgr = createManager({ resolveBinary: () => null });
      expect(await nullBinMgr.getStatus()).toEqual({ claude: 'missing', claudeAccount: undefined });
      expect(spawned).toHaveLength(3);

      // 5. 4s timeout kills hung child and falls back cleanly
      vi.useFakeTimers();
      const pTimeout = mgr.getStatus({ forceRefresh: true });
      expect(spawned).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await pTimeout).toEqual({ claude: 'missing', claudeAccount: undefined });
      expect(spawned[3].child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('signIn, URL extraction, submitAuthCode, cancelSignIn & dispose', () => {
    it('completes browser sign-in, coalesces concurrent signIn() calls, and verifies persisted status after exit 0', async () => {
      const mgr = createManager();

      const s1 = mgr.signIn();
      const s2 = mgr.signIn();
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(['auth', 'login', '--claudeai']);
      expect(spawned[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(spawned[0].opts.windowsHide).toBe(true);

      const loginChild = spawned[0].child;
      loginChild.emitStdout(
        'Opening browser...\nhttps://claude.ai/oauth/authorize?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=SECRET_NONCE&code_challenge=SECRET_CHALLENGE\n',
      );
      loginChild.emitStdout('Waiting for browser sign-in...\n');
      expect(await mgr.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=SECRET_NONCE&code_challenge=SECRET_CHALLENGE',
      );

      loginChild.finish(0);

      // Wait a microtask for post-exit getStatus({ forceRefresh: true }) to spawn
      await Promise.resolve();
      expect(spawned).toHaveLength(2);
      expect(spawned[1].args).toEqual(['auth', 'status', '--json']);
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'signedin@yvoke.ai' }),
      );
      spawned[1].child.finish(0);

      const [r1, r2] = await Promise.all([s1, s2]);
      expect(r1).toEqual({ status: 'signed_in', account: 'signedin@yvoke.ai' });
      expect(r2).toEqual(r1);
      expect(await mgr.getActiveSignInUrl()).toBeNull();
    });

    it('guards against false-positive exit 0 when post-exit getStatus is still missing', async () => {
      const mgr = createManager();
      const signInPromise = mgr.signIn();
      spawned[0].child.finish(0);

      await Promise.resolve();
      expect(spawned).toHaveLength(2);
      spawned[1].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[1].child.finish(0);

      const result = await signInPromise;
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.message).toMatch(/credentials/i);
      }
    });

    it('buffers partial chunks until newline and unwraps BEL and ST OSC-8 hyperlinks + ANSI CSI codes', async () => {
      const mgr = createManager();

      // 1. Chunked URL across stdout data events + BEL OSC-8
      const p1 = mgr.signIn();
      const urlWaiter = mgr.getActiveSignInUrl();
      spawned[0].child.emitStdout('\x1b[36mOpen \x1b]8;;https://claude.com/cai/oauth/auth');
      // Not yet newline-terminated -> still waiting, not truncated
      spawned[0].child.emitStdout(
        'orize?client_id=cid1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=NONCE1&code_challenge=CHAL1\x07Click here\x1b]8;;\x07\x1b[0m\r\n',
      );
      expect(await urlWaiter).toBe(
        'https://claude.com/cai/oauth/authorize?client_id=cid1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=NONCE1&code_challenge=CHAL1',
      );
      expect(mgr.cancelSignIn()).toBe(true);
      expect(await p1).toEqual({ status: 'cancelled' });

      // 2. ST (\x1b\\) OSC-8 hyperlink on console.anthropic.com
      const p2 = mgr.signIn();
      spawned[1].child.emitStdout(
        '\x1b]8;id=link1;https://console.anthropic.com/oauth/authorize?client_id=cid2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&code_challenge=CHAL2&state=NONCE2\x1b\\Sign in\x1b]8;;\x1b\\\n',
      );
      expect(await mgr.getActiveSignInUrl()).toBe(
        'https://console.anthropic.com/oauth/authorize?client_id=cid2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&code_challenge=CHAL2&state=NONCE2',
      );
      mgr.cancelSignIn();
      await p2;
    });

    it('rejects disallowed schemes, lookalike hosts, credentials, ports, and non-/oauth/authorize paths', async () => {
      vi.useFakeTimers();
      const mgr = createManager();
      const p = mgr.signIn();
      const badUrls = [
        'http://claude.ai/oauth/authorize?state=1',
        'javascript:alert(1)//https://claude.ai/oauth/authorize',
        'file:///etc/passwd',
        'https://evilclaude.ai/oauth/authorize?state=1',
        'https://claude.ai.evil.com/oauth/authorize?state=1',
        'https://user:pass@claude.ai/oauth/authorize?state=1',
        'https://user@claude.ai/oauth/authorize?state=1',
        'https://claude.ai:8443/oauth/authorize?state=1',
        'https://claude.ai/oauth/token?state=1',
        'https://claude.ai/login?state=1',
      ];
      for (const bad of badUrls) {
        spawned[0].child.emitStdout(`${bad}\n`);
      }

      const urlPromise = mgr.getActiveSignInUrl();
      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS);
      expect(await urlPromise).toBeNull();

      mgr.cancelSignIn();
      await p;
    });

    it('validates code#state strictly, enforces single-flight submission, never logs user code#state, and handles stdin EPIPE safely', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mgr = createManager();

      // Rejects when idle
      expect(await mgr.submitAuthCode('abc#def')).toEqual({
        accepted: false,
        message: expect.stringMatching(/no claude sign-in/i),
      });

      const signInPromise = mgr.signIn();
      const child = spawned[0].child;

      // Async EPIPE emitted on child.stdin must not throw unhandled error
      expect(() => {
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      }).not.toThrow();

      const invalidInputs: unknown[] = [
        null,
        undefined,
        12345,
        { code: 'abc#def' },
        '',
        '    ',
        'missing-hash-delimiter',
        '#missing-code',
        'missing-state#',
        'two#hashes#here',
        'has space#state',
        'code#has space',
        'code#state\ninjected-second-line',
        'code\r#state',
        'code\x00#state',
        'code#state\x07',
        'code#state\x7f',
        `${'a'.repeat(4090)}#${'b'.repeat(10)}`, // > 4096 after trim
      ];

      for (const bad of invalidInputs) {
        const res = await mgr.submitAuthCode(bad);
        expect(res.accepted).toBe(false);
      }
      expect(child.stdin.writes).toHaveLength(0);

      // Valid code#state with outer whitespace is trimmed and written once with trailing \n
      const secretCode = 'MY_AUTH_CODE_SECRET_777#MY_PKCE_STATE_SECRET_888';
      const accepted = await mgr.submitAuthCode(`  ${secretCode}  \n`);
      expect(accepted).toEqual({ accepted: true });
      expect(child.stdin.writes).toEqual([`${secretCode}\n`]);

      // Second submission while in-flight is rejected without writing again
      const duplicate = await mgr.submitAuthCode('SECOND_CODE#SECOND_STATE');
      expect(duplicate.accepted).toBe(false);
      expect(child.stdin.writes).toHaveLength(1);

      // Zero log output contains secretCode
      const allLogs = [
        ...logSpy.mock.calls.flat().map(String),
        ...errSpy.mock.calls.flat().map(String),
      ].join('\n');
      expect(allLogs).not.toContain('MY_AUTH_CODE_SECRET_777');
      expect(allLogs).not.toContain('MY_PKCE_STATE_SECRET_888');

      mgr.cancelSignIn();
      await signInPromise;
    });

    it('returns { accepted: false } cleanly when stdin.write throws synchronously', async () => {
      const mgr = createManager();
      const signInPromise = mgr.signIn();
      spawned[0].child.stdin.throwOnWrite = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

      const res = await mgr.submitAuthCode('validCode#validState');
      expect(res.accepted).toBe(false);

      mgr.cancelSignIn();
      await signInPromise;
    });

    it('awaits stdin.write callback, handles async EPIPE/close/5s timeout, blocks concurrent codeSubmitting, and skips exchange timer if login ends mid-write', async () => {
      // 1. Async callback error -> accepted: false and latch clears
      const mgr1 = createManager();
      const p1 = mgr1.signIn();
      spawned[0].child.stdin.callbackError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const errRes = await mgr1.submitAuthCode('codeA#stateA');
      expect(errRes).toEqual({
        accepted: false,
        message: 'Claude sign-in could not receive the code. Click Sign in to Claude again.',
      });
      // Latch cleared so a retry succeeds once stdin recovers
      spawned[0].child.stdin.callbackError = null;
      expect(await mgr1.submitAuthCode('codeB#stateB')).toEqual({ accepted: true });
      mgr1.cancelSignIn();
      await p1;

      // 2. Concurrent submitAuthCode while first write is pending -> blocked by codeSubmitting latch without writing twice
      const mgr2 = createManager();
      const p2 = mgr2.signIn();
      spawned[1].child.stdin.deferCallback = true;
      const firstSubmit = mgr2.submitAuthCode('firstCode#firstState');
      const concurrentSubmit = await mgr2.submitAuthCode('secondCode#secondState');
      expect(concurrentSubmit).toEqual({
        accepted: false,
        message: 'Authorization code has already been submitted. Waiting for Claude to finish…',
      });
      expect(spawned[1].child.stdin.writes).toEqual(['firstCode#firstState\n']);
      spawned[1].child.stdin.pendingCallback?.(null);
      expect(await firstSubmit).toEqual({ accepted: true });
      mgr2.cancelSignIn();
      await p2;

      // 3. stdin 'close' event mid-write -> accepted: false
      const mgr3 = createManager();
      const p3 = mgr3.signIn();
      spawned[2].child.stdin.deferCallback = true;
      const closeSubmit = mgr3.submitAuthCode('closeCode#closeState');
      spawned[2].child.stdin.emit('close');
      expect(await closeSubmit).toEqual({
        accepted: false,
        message: 'Claude sign-in could not receive the code. Click Sign in to Claude again.',
      });
      mgr3.cancelSignIn();
      await p3;

      // 4. Child exits mid-write before callback succeeds -> accepted: false and NO codeExchangeTimer armed
      vi.useFakeTimers();
      const mgr4 = createManager();
      const p4 = mgr4.signIn();
      spawned[3].child.stdin.deferCallback = true;
      const raceSubmit = mgr4.submitAuthCode('raceCode#raceState');
      spawned[3].child.finish(1);
      spawned[3].child.stdin.pendingCallback?.(null);
      expect(await raceSubmit).toEqual({
        accepted: false,
        message: 'No Claude sign-in is currently waiting for a code. Click Sign in to Claude again.',
      });
      await p4;

      // 5. Hung stdin.write times out after CLAUDE_CODE_WRITE_TIMEOUT_MS (5s)
      const mgr5 = createManager();
      const p5 = mgr5.signIn();
      spawned[4].child.stdin.deferCallback = true;
      const hungSubmit = mgr5.submitAuthCode('hungCode#hungState');
      await vi.advanceTimersByTimeAsync(CLAUDE_CODE_WRITE_TIMEOUT_MS);
      expect(await hungSubmit).toEqual({
        accepted: false,
        message: 'Claude sign-in could not receive the code. Click Sign in to Claude again.',
      });
      mgr5.cancelSignIn();
      await p5;
    });

    it('falls back to sanitized non-URL stdout diagnostics on non-zero exit when stderr is empty, while keeping stderr primary', async () => {
      // 1. Empty stderr -> uses sanitized non-URL stdout (including trailing line without newline), never leaking OAuth URL lines
      const mgr1 = createManager();
      const p1 = mgr1.signIn();
      spawned[0].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=FIRST_SECRET&code_challenge=CHAL1\n',
      );
      spawned[0].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=SECOND_SECRET&code_challenge=CHAL2\n',
      );
      spawned[0].child.emitStdout(
        '\x1b[31mCallback server failed to bind port 54545 with Bearer SECRET_STDOUT_JWT\x1b[0m',
      );
      spawned[0].child.finish(1);

      const res1 = await p1;
      expect(res1.status).toBe('error');
      if (res1.status === 'error') {
        expect(res1.message).toContain('Callback server failed to bind port 54545');
        expect(res1.message).toContain('Bearer [REDACTED]');
        expect(res1.message).not.toContain('FIRST_SECRET');
        expect(res1.message).not.toContain('SECOND_SECRET');
        expect(res1.message).not.toContain('SECRET_STDOUT_JWT');
        expect(res1.message).not.toContain('/oauth/authorize');
        expect(res1.message).not.toMatch(/\x1b/);
      }

      // 2. Non-empty stderr takes precedence over stdout
      const mgr2 = createManager();
      const p2 = mgr2.signIn();
      spawned[1].child.emitStdout('stdout fallback detail\n');
      spawned[1].child.emitStderr('stderr primary detail\n');
      spawned[1].child.finish(1);

      const res2 = await p2;
      expect(res2.status).toBe('error');
      if (res2.status === 'error') {
        expect(res2.message).toContain('stderr primary detail');
        expect(res2.message).not.toContain('stdout fallback detail');
      }
    });

    it('enforces 15s code-exchange timeout and 5m overall login ceiling', async () => {
      vi.useFakeTimers();
      const mgr = createManager();

      // 1. 15s code-exchange timeout after submitAuthCode
      const pCodeTimeout = mgr.signIn();
      expect(await mgr.submitAuthCode('validCode#validState')).toEqual({ accepted: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_CODE_EXCHANGE_TIMEOUT_MS);
      const rCode = await pCodeTimeout;
      expect(rCode.status).toBe('error');
      expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGTERM');

      // 2. 5m overall login timeout when user never completes browser flow
      const pLoginTimeout = mgr.signIn();
      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_TIMEOUT_MS);
      const rLogin = await pLoginTimeout;
      expect(rLogin.status).toBe('error');
      expect(spawned[1].child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('sanitizes OAuth query params and sk-ant keys from non-zero exit error messages', async () => {
      const mgr = createManager();
      const p = mgr.signIn();
      spawned[0].child.emitStderr(
        'OAuth failed at https://claude.ai/oauth/authorize?code=RAW_CODE&state=SECRET_NONCE&code_challenge=SECRET_CHALLENGE with key sk-ant-api03-TOPSECRET\n',
      );
      spawned[0].child.finish(1);

      const res = await p;
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.message).not.toContain('RAW_CODE');
        expect(res.message).not.toContain('SECRET_NONCE');
        expect(res.message).not.toContain('SECRET_CHALLENGE');
        expect(res.message).not.toContain('TOPSECRET');
      }
    });

    it('cancelSignIn() returns false when idle, and dispose() kills both status and login child processes with SIGKILL escalation', async () => {
      vi.useFakeTimers();
      const mgr = createManager();
      expect(mgr.cancelSignIn()).toBe(false);

      const statusPromise = mgr.getStatus({ forceRefresh: true });
      const loginPromise = mgr.signIn();
      expect(spawned).toHaveLength(2);
      const statusChild = spawned[0].child;
      const loginChild = spawned[1].child;

      mgr.dispose();

      expect(statusChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(loginChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(await loginPromise).toEqual({ status: 'cancelled' });
      await statusPromise;

      // Neither child exited -> 1s escalation sends SIGKILL
      await vi.advanceTimersByTimeAsync(1_500);
      expect(statusChild.kill).toHaveBeenCalledWith('SIGKILL');
      expect(loginChild.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('keeps activeLogin latched across post-exit getStatus verification window for coalescing, cancelSignIn(), and dispose()', async () => {
      // 1. Concurrent signIn() coalesces & cancelSignIn() cancels during post-exit getStatus window
      const mgr1 = createManager();
      const login1 = mgr1.signIn();
      expect(spawned).toHaveLength(1);
      spawned[0].child.finish(0);

      // Post-exit getStatus({ forceRefresh: true }) is now in-flight at spawned[1]
      await Promise.resolve();
      expect(spawned).toHaveLength(2);
      expect(spawned[1].args).toEqual(['auth', 'status', '--json']);

      // Concurrent signIn() during post-exit verification must coalesce without spawning a 3rd process
      const coalesced = mgr1.signIn();
      expect(spawned).toHaveLength(2);

      // Cancelling during post-exit verification must return true and settle both promises as cancelled
      expect(mgr1.cancelSignIn()).toBe(true);
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'late@yvoke.ai' }),
      );
      spawned[1].child.finish(0);

      expect(await login1).toEqual({ status: 'cancelled' });
      expect(await coalesced).toEqual({ status: 'cancelled' });

      // 2. dispose() during post-exit verification settles as cancelled, never signed_in
      const mgr2 = createManager();
      const login2 = mgr2.signIn();
      spawned[2].child.finish(0);
      await Promise.resolve();
      expect(spawned).toHaveLength(4);

      mgr2.dispose();
      spawned[3].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'disposed@yvoke.ai' }),
      );
      spawned[3].child.finish(0);

      expect(await login2).toEqual({ status: 'cancelled' });
    });

    it('drains large stderr in getStatus() without pipe backpressure and bounds newline-free stdout/stderr buffers to 65_536 chars in signIn()', async () => {
      // 1. Real PassThrough stderr with tiny 64-byte highWaterMark in getStatus()
      const pipeStderr = new PassThrough({ highWaterMark: 64 });
      const mgrStatus = createManager({
        spawn: (cmd, args, opts) => {
          const child = new FakeChildProcess();
          (child as unknown as { stderr: PassThrough }).stderr = pipeStderr;
          spawned.push({ cmd, args, opts: opts as unknown as Record<string, unknown>, child });
          return child;
        },
      });

      const statusPromise = mgrStatus.getStatus();
      // Write 128KB of CLAUDE_DEBUG stderr; if probeStatus drains stderr, readableLength stays 0
      pipeStderr.write('D'.repeat(128 * 1024));
      expect(pipeStderr.readableLength).toBe(0);
      spawned[0].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'drain@yvoke.ai' }),
      );
      spawned[0].child.finish(0);
      expect(await statusPromise).toEqual({ claude: 'ok', claudeAccount: 'drain@yvoke.ai' });

      // 2. Newline-free >64KB chunk in signIn() evicts head beyond 65_536 chars and still parses subsequent valid line
      const mgrLogin = createManager();
      const signInPromise = mgrLogin.signIn();
      const loginChild = spawned[1].child;

      // Head URL followed by 70,000 chars WITHOUT newline -> exceeds 65_536 cap, so head must be dropped
      loginChild.emitStdout(
        `https://claude.ai/oauth/authorize?client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=CHAL&state=DROPPED_HEAD ${'X'.repeat(70_000)}`,
      );
      loginChild.emitStdout('tail-end\n');
      loginChild.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=CHAL&state=BOUNDED_FRESH\n',
      );
      loginChild.emitStdout('\n');

      // Also emit >70,000 newline-free chars on stderr without OOM or crash
      loginChild.emitStderr('E'.repeat(70_000));

      expect(await mgrLogin.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=CHAL&state=BOUNDED_FRESH',
      );
      mgrLogin.cancelSignIn();
      await signInPromise;
    });

    it('rejects OAuth URLs missing or blanking required PKCE params (client_id, code_challenge, state, redirect_uri) and locks authoritative OSC-8 against plain-text overwrite', async () => {
      vi.useFakeTimers();

      // 1. Missing/blank/whitespace required PKCE params (plain text and OSC-8) -> rejected
      const mgr1 = createManager();
      const p1 = mgr1.signIn();
      const incompleteUrls = [
        // Missing each required parameter individually
        'https://claude.ai/oauth/authorize?code_challenge=CHAL&state=ST&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&state=ST&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&state=ST',
        // Empty parameter values
        'https://claude.ai/oauth/authorize?client_id=&code_challenge=CHAL&state=ST&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=&state=ST&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&state=&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&state=ST&redirect_uri=',
        // Whitespace-only parameter values
        'https://claude.ai/oauth/authorize?client_id=%20&code_challenge=CHAL&state=ST&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&state=%20%09&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb',
        // OSC-8 missing redirect_uri
        '\x1b]8;;https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&state=ST\x07Click\x1b]8;;\x07',
      ];
      for (const bad of incompleteUrls) {
        spawned[0].child.emitStdout(`${bad}\n\n`);
      }
      const urlWaiter1 = mgr1.getActiveSignInUrl();
      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS);
      expect(await urlWaiter1).toBeNull();
      mgr1.cancelSignIn();
      await p1;

      // 2. Valid OSC-8 commits immediately and locks out later plain-text continuation/overwrites
      const mgr2 = createManager();
      const p2 = mgr2.signIn();
      const oscUrl =
        'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL_OSC&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=OSC_STATE';
      spawned[1].child.emitStdout(`\x1b]8;;${oscUrl}\x07Open link\x1b]8;;\x07\n`);
      // Follow-up token-like stdout line must NOT be appended or swallowed as continuation
      spawned[1].child.emitStdout('CONTINUATION_SHOULD_NOT_APPEND\n');
      expect(await mgr2.getActiveSignInUrl()).toBe(oscUrl);
      spawned[1].child.finish(1);
      const res2 = await p2;
      expect(res2.status).toBe('error');
      if (res2.status === 'error') {
        expect(res2.message).toContain('CONTINUATION_SHOULD_NOT_APPEND');
      }
    });

    it('reassembles multiline wrapped OAuth URLs across single chunk, multi-chunk settle window, incomplete line 1, and EOF flush without corrupting state', async () => {
      vi.useFakeTimers();

      // (a) Single data chunk with 3-line wrapped URL (including split state=ABC\nDEF_TAIL\n)
      const mgrA = createManager();
      const pA = mgrA.signIn();
      spawned[0].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid1&code_challenge=CHAL\n' +
          '_PART2&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=ABC\n' +
          'DEF_TAIL\n' +
          '\n',
      );
      expect(await mgrA.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?client_id=cid1&code_challenge=CHAL_PART2&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=ABCDEF_TAIL',
      );
      mgrA.cancelSignIn();
      await pA;

      // (b) Split across 2 separate data chunks within CLAUDE_URL_CONTINUATION_SETTLE_MS
      const mgrB = createManager();
      const pB = mgrB.signIn();
      const urlWaiterB = mgrB.getActiveSignInUrl();
      let resolvedEarlyB = false;
      void urlWaiterB.then(() => {
        resolvedEarlyB = true;
      });
      spawned[1].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid2&code_challenge=CHAL2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=ABC\n',
      );
      // Advance half the settle window — must still be waiting for continuation chunk
      await vi.advanceTimersByTimeAsync(Math.floor(CLAUDE_URL_CONTINUATION_SETTLE_MS / 2));
      expect(resolvedEarlyB).toBe(false);

      spawned[1].child.emitStdout('DEF_TAIL\n');
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
      expect(await urlWaiterB).toBe(
        'https://claude.ai/oauth/authorize?client_id=cid2&code_challenge=CHAL2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=ABCDEF_TAIL',
      );
      mgrB.cancelSignIn();
      await pB;

      // (c) Incomplete line 1 (missing state) in chunk 1 + &state=XYZ in chunk 2 stays pending across settle window
      const mgrC = createManager();
      const pC = mgrC.signIn();
      const urlWaiterC = mgrC.getActiveSignInUrl();
      let resolvedEarlyC = false;
      void urlWaiterC.then(() => {
        resolvedEarlyC = true;
      });
      spawned[2].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid3&code_challenge=CHAL3&redirect_uri=http%3A%2F%2Flocalhost%3A3%2Fcb\n',
      );
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS * 3);
      expect(resolvedEarlyC).toBe(false);

      spawned[2].child.emitStdout('&state=XYZ\n\n');
      expect(await urlWaiterC).toBe(
        'https://claude.ai/oauth/authorize?client_id=cid3&code_challenge=CHAL3&redirect_uri=http%3A%2F%2Flocalhost%3A3%2Fcb&state=XYZ',
      );
      mgrC.cancelSignIn();
      await pC;

      // (d) Trailing fragment without \n flushed on close
      const mgrD = createManager();
      const pD = mgrD.signIn();
      const urlWaiterD = mgrD.getActiveSignInUrl();
      spawned[3].child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid4&code_challenge=CHAL4&redirect_uri=http%3A%2F%2Flocalhost%3A4%2Fcb\n',
      );
      spawned[3].child.emitStdout('&state=EOF_TAIL');
      spawned[3].child.finish(1);
      expect(await urlWaiterD).toBe(
        'https://claude.ai/oauth/authorize?client_id=cid4&code_challenge=CHAL4&redirect_uri=http%3A%2F%2Flocalhost%3A4%2Fcb&state=EOF_TAIL',
      );
      await pD;
    });

    it('closes pendingUrl on sentence-punctuated status lines, prose, hostile URLs, isolates streams, and caps length at 4096 chars', async () => {
      vi.useFakeTimers();

      // 1. Sentence-punctuated single-word status lines, prose, and hostile URLs never corrupt state
      const nonContinuations = [
        'Waiting...',
        'Done!',
        'Error:',
        'Cancelled.',
        'Paste code here >',
        'https://evil.example/steal',
      ];
      for (const terminator of nonContinuations) {
        const mgr = createManager();
        const p = mgr.signIn();
        const child = spawned[spawned.length - 1].child;
        const base =
          'https://claude.ai/oauth/authorize?client_id=cid&code_challenge=CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=CLEAN_STATE';
        child.emitStdout(`${base}\n${terminator}\n`);
        expect(await mgr.getActiveSignInUrl()).toBe(base);
        mgr.cancelSignIn();
        await p;
      }

      // 2. Interleaved stderr warning between stdout line 1 and line 2 does NOT break stdout reassembly
      const mgrIso = createManager();
      const pIso = mgrIso.signIn();
      const isoChild = spawned[spawned.length - 1].child;
      isoChild.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=iso&code_challenge=CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=ISO_\n',
      );
      isoChild.emitStderr('Warning: opening default browser...\n');
      isoChild.emitStdout('TAIL\n\n');
      expect(await mgrIso.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?client_id=iso&code_challenge=CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=ISO_TAIL',
      );
      mgrIso.cancelSignIn();
      await pIso;

      // 3. Length cap > 4096 stops appending cleanly
      const mgrCap = createManager();
      const pCap = mgrCap.signIn();
      const capChild = spawned[spawned.length - 1].child;
      const validBase =
        'https://claude.ai/oauth/authorize?client_id=cap&code_challenge=CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=CAP_OK';
      capChild.emitStdout(`${validBase}\n${'A'.repeat(4_100)}\n`);
      expect(await mgrCap.getActiveSignInUrl()).toBe(validBase);
      mgrCap.cancelSignIn();
      await pCap;
    });

    it('suppresses wrapped OAuth URL continuation fragments from both stdout and stderr diagnostics and logs on failure', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      for (const stream of ['stdout', 'stderr'] as const) {
        const mgr = createManager();
        const p = mgr.signIn();
        const child = spawned[spawned.length - 1].child;
        const emit = (s: string) => (stream === 'stdout' ? child.emitStdout(s) : child.emitStderr(s));

        emit('https://claude.ai/oauth/authorize?client_id=cid&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=\n');
        emit('SECRET_CHAL_FRAGMENT_NO_KEY\n');
        emit('&state=SECRET_STATE_LINE3\n');
        emit('SECRET_UNFLUSHED_TAIL');
        child.finish(1);

        const res = await p;
        expect(res.status).toBe('error');
        if (res.status === 'error') {
          expect(res.message).not.toContain('SECRET_CHAL_FRAGMENT_NO_KEY');
          expect(res.message).not.toContain('SECRET_STATE_LINE3');
          expect(res.message).not.toContain('SECRET_UNFLUSHED_TAIL');
          expect(res.message).not.toContain('/oauth/authorize');
        }
      }

      const allLogs = [
        ...logSpy.mock.calls.flat().map(String),
        ...errSpy.mock.calls.flat().map(String),
      ].join('\n');
      expect(allLogs).not.toContain('SECRET_CHAL_FRAGMENT_NO_KEY');
      expect(allLogs).not.toContain('SECRET_STATE_LINE3');
      expect(allLogs).not.toContain('SECRET_UNFLUSHED_TAIL');
      expect(allLogs).not.toContain('/oauth/authorize');
    });

    it('captures a late single-line plain-text OAuth URL after the 10s wait window, logs once, and locks against duplicate plain-text and OSC-8 overwrites', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.useFakeTimers();

      const mgr = createManager();
      const signInP = mgr.signIn();
      const child = spawned[0].child;

      const initialUrlP = mgr.getActiveSignInUrl();
      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      expect(await initialUrlP).toBeNull();

      const lateUrl =
        'https://claude.ai/oauth/authorize?client_id=cid_late&code_challenge=CHAL_LATE&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_SINGLE';
      child.emitStdout(`${lateUrl}\n`);

      // Calling getActiveSignInUrl() during the 40ms settle window awaits and resolves with the exact URL
      const duringSettleP = mgr.getActiveSignInUrl();
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
      expect(await duringSettleP).toBe(lateUrl);

      const urlReadyLogs = () =>
        logSpy.mock.calls
          .flat()
          .map(String)
          .filter((msg) => msg.includes('Claude browser sign-in started (fallback OAuth URL ready)'));
      expect(urlReadyLogs()).toHaveLength(1);

      // Subsequent duplicate plain-text URL and valid OSC-8 URL must not overwrite or log again
      const dupPlain =
        'https://claude.ai/oauth/authorize?client_id=cid_dup&code_challenge=CHAL_DUP&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=DUP_PLAIN';
      const dupOsc =
        'https://claude.ai/oauth/authorize?client_id=cid_osc&code_challenge=CHAL_OSC&redirect_uri=http%3A%2F%2Flocalhost%3A3%2Fcb&state=DUP_OSC';
      child.emitStdout(`${dupPlain}\n\n`);
      child.emitStdout(`\x1b]8;;${dupOsc}\x07Sign in\x1b]8;;\x07\n`);

      expect(await mgr.getActiveSignInUrl()).toBe(lateUrl);
      expect(urlReadyLogs()).toHaveLength(1);

      mgr.cancelSignIn();
      await signInP;
    });

    it('reassembles a late wrapped multiline plain-text OAuth URL after 10s across chunks and locks via settle timer without a prompt line', async () => {
      vi.useFakeTimers();

      const mgr = createManager();
      const signInP = mgr.signIn();
      const child = spawned[0].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      expect(await mgr.getActiveSignInUrl()).toBeNull();

      child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_wrap&code_challenge=CHAL_W&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_A\n',
      );
      const midSettleP = mgr.getActiveSignInUrl();
      let resolvedEarly = false;
      void midSettleP.then(() => {
        resolvedEarly = true;
      });

      await vi.advanceTimersByTimeAsync(Math.floor(CLAUDE_URL_CONTINUATION_SETTLE_MS / 2));
      expect(resolvedEarly).toBe(false);

      child.emitStdout('LATE_B\n');
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);

      const expectedUrl =
        'https://claude.ai/oauth/authorize?client_id=cid_wrap&code_challenge=CHAL_W&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_ALATE_B';
      expect(await midSettleP).toBe(expectedUrl);

      // After settle timer locks urlLocked and clears pendingUrl, a stray single-token line must neither append nor be swallowed
      child.emitStdout('STRAY_TOKEN_AFTER_SETTLE\n');
      expect(await mgr.getActiveSignInUrl()).toBe(expectedUrl);

      child.finish(1);
      const res = await signInP;
      expect(res.status).toBe('error');
      if (res.status === 'error') {
        expect(res.message).toContain('STRAY_TOKEN_AFTER_SETTLE');
      }
    });

    it('captures a late multi-chunk OAuth URL whose first line is missing state without locking prematurely', async () => {
      vi.useFakeTimers();

      const mgr = createManager();
      const signInP = mgr.signIn();
      const child = spawned[0].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);

      child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_inc&code_challenge=CHAL_INC&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb\n',
      );
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS * 2);
      expect(await mgr.getActiveSignInUrl()).toBeNull();

      child.emitStdout('&state=LATE_COMP\n');
      const completeP = mgr.getActiveSignInUrl();
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
      const expectedUrl =
        'https://claude.ai/oauth/authorize?client_id=cid_inc&code_challenge=CHAL_INC&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_COMP';
      expect(await completeP).toBe(expectedUrl);

      // Locked against subsequent duplicate URL
      child.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_other&code_challenge=CHAL_O&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=OTHER\n\n',
      );
      expect(await mgr.getActiveSignInUrl()).toBe(expectedUrl);

      mgr.cancelSignIn();
      await signInP;
    });

    it('handles wrapped OAuth URLs straddling the 10s boundary for both valid line 1 and incomplete line 1 without leaking truncated URLs', async () => {
      vi.useFakeTimers();

      // (a) Valid line 1 at 9_990ms -> 10_000ms resolves initial waiter to null -> continuation at 10_010ms settles complete URL and locks
      const mgr1 = createManager();
      const signInP1 = mgr1.signIn();
      const child1 = spawned[0].child;
      const initialP1 = mgr1.getActiveSignInUrl();

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS - 10);
      child1.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_s1&code_challenge=CHAL_S1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=STRAD_A\n',
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(await initialP1).toBeNull();

      await vi.advanceTimersByTimeAsync(5);
      const straddleP1 = mgr1.getActiveSignInUrl();

      await vi.advanceTimersByTimeAsync(5);
      child1.emitStdout('STRAD_B\n');
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);

      const expected1 =
        'https://claude.ai/oauth/authorize?client_id=cid_s1&code_challenge=CHAL_S1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=STRAD_ASTRAD_B';
      expect(await straddleP1).toBe(expected1);

      // Locked against duplicate URL and stray token
      child1.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_dup&code_challenge=CHAL_D&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=DUP\n\n',
      );
      child1.emitStdout('STRAY_AFTER_STRADDLE\n');
      expect(await mgr1.getActiveSignInUrl()).toBe(expected1);
      child1.finish(1);
      const res1 = await signInP1;
      expect(res1.status).toBe('error');
      if (res1.status === 'error') {
        expect(res1.message).toContain('STRAY_AFTER_STRADDLE');
      }

      // (b) Incomplete line 1 (missing state) at 9_990ms -> 10_000ms resolves initial waiter to null -> &state=STRAD_LATE at 10_010ms settles & locks
      const mgr2 = createManager();
      const signInP2 = mgr2.signIn();
      const child2 = spawned[1].child;
      const initialP2 = mgr2.getActiveSignInUrl();

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS - 10);
      child2.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_s2&code_challenge=CHAL_S2&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb\n',
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(await initialP2).toBeNull();

      await vi.advanceTimersByTimeAsync(10);
      child2.emitStdout('&state=STRAD_LATE\n');
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);

      const expected2 =
        'https://claude.ai/oauth/authorize?client_id=cid_s2&code_challenge=CHAL_S2&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=STRAD_LATE';
      expect(await mgr2.getActiveSignInUrl()).toBe(expected2);

      child2.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=cid_dup2&code_challenge=CHAL_D2&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=DUP2\n\n',
      );
      expect(await mgr2.getActiveSignInUrl()).toBe(expected2);

      mgr2.cancelSignIn();
      await signInP2;
    });

    it('rejects disallowed/incomplete late URLs without latching urlLocked, and allows late valid OSC-8 to lock out later plain-text URLs', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.useFakeTimers();

      // (a) Disallowed and incomplete late URLs do not lock out a subsequent valid late URL
      const mgr1 = createManager();
      const p1 = mgr1.signIn();
      const child1 = spawned[0].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      child1.emitStdout(
        'http://claude.ai/oauth/authorize?client_id=c&code_challenge=CH&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=HTTP_BAD\n',
      );
      child1.emitStdout(
        'https://evil.example/oauth/authorize?client_id=c&code_challenge=CH&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=EVIL_BAD\n',
      );
      child1.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c&code_challenge=CH&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb\n\n',
      );
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS * 2);
      expect(await mgr1.getActiveSignInUrl()).toBeNull();

      const validLateUrl =
        'https://claude.ai/oauth/authorize?client_id=c_ok&code_challenge=CH_OK&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_OK';
      child1.emitStdout(`${validLateUrl}\n`);
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
      expect(await mgr1.getActiveSignInUrl()).toBe(validLateUrl);

      mgr1.cancelSignIn();
      await p1;

      // (b) Late valid OSC-8 URL after 10s captures immediately, logs once, and locks out a later plain-text URL
      logSpy.mockClear();
      const mgr2 = createManager();
      const p2 = mgr2.signIn();
      const child2 = spawned[1].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      const lateOscUrl =
        'https://claude.ai/oauth/authorize?client_id=c_osc&code_challenge=CH_OSC&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=LATE_OSC';
      child2.emitStdout(`\x1b]8;;${lateOscUrl}\x07Sign in\x1b]8;;\x07\n`);
      expect(await mgr2.getActiveSignInUrl()).toBe(lateOscUrl);

      child2.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c_plain&code_challenge=CH_P&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=LATE_PLAIN\n\n',
      );
      expect(await mgr2.getActiveSignInUrl()).toBe(lateOscUrl);

      const urlReadyLogs = logSpy.mock.calls
        .flat()
        .map(String)
        .filter((msg) => msg.includes('Claude browser sign-in started (fallback OAuth URL ready)'));
      expect(urlReadyLogs).toHaveLength(1);

      mgr2.cancelSignIn();
      await p2;
    });

    it('suppresses late wrapped duplicate OAuth URL secrets across stdout and stderr and clears pendingUrl on post-lock non-newline prompts', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();

      // (a) Separate stdout and stderr runs with wrapped duplicate URLs after a late URL locks
      for (const stream of ['stdout', 'stderr'] as const) {
        const mgr = createManager();
        const p = mgr.signIn();
        const child = spawned[spawned.length - 1].child;
        const emit = (s: string) => (stream === 'stdout' ? child.emitStdout(s) : child.emitStderr(s));

        await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
        const origUrl =
          'https://claude.ai/oauth/authorize?client_id=orig&code_challenge=ORIG_SECRET_CHAL&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=ORIG_SECRET_STATE';
        emit(`${origUrl}\n`);
        await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
        expect(await mgr.getActiveSignInUrl()).toBe(origUrl);

        emit('Browser launch failed\n');
        emit(
          'https://claude.ai/oauth/authorize?client_id=dup&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=\n',
        );
        emit('DUP_SECRET_CHAL_NO_KEY\n');
        emit('&state=DUP_SECRET_STATE\n');
        emit('DUP_UNFLUSHED_TAIL');
        child.finish(1);

        const res = await p;
        expect(res.status).toBe('error');
        if (res.status === 'error') {
          expect(res.message).toContain('Browser launch failed');
          for (const secret of [
            'ORIG_SECRET_CHAL',
            'ORIG_SECRET_STATE',
            'DUP_SECRET_CHAL_NO_KEY',
            'DUP_SECRET_STATE',
            'DUP_UNFLUSHED_TAIL',
            '/oauth/authorize',
          ]) {
            expect(res.message).not.toContain(secret);
          }
        }
      }

      const allLogs = [
        ...logSpy.mock.calls.flat().map(String),
        ...errSpy.mock.calls.flat().map(String),
      ].join('\n');
      for (const secret of [
        'ORIG_SECRET_CHAL',
        'ORIG_SECRET_STATE',
        'DUP_SECRET_CHAL_NO_KEY',
        'DUP_SECRET_STATE',
        'DUP_UNFLUSHED_TAIL',
        '/oauth/authorize',
      ]) {
        expect(allLogs).not.toContain(secret);
      }

      // (b) Separate run: post-lock duplicate URL + non-newline prompt clears pendingUrl before urlLocked return;
      //     evicting the prompt from the 65_536-char buffer ensures a later single-token error is only retained
      //     if scheduleOrCommitPendingUrl cleared pendingUrl on the prompt chunk.
      const mgrPrompt = createManager();
      const pPrompt = mgrPrompt.signIn();
      const childPrompt = spawned[spawned.length - 1].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      const origPromptUrl =
        'https://claude.ai/oauth/authorize?client_id=orig&code_challenge=C1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=S1';
      childPrompt.emitStdout(`${origPromptUrl}\n`);
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS);
      expect(await mgrPrompt.getActiveSignInUrl()).toBe(origPromptUrl);

      childPrompt.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=dup&code_challenge=DUP_PROMPT_C&redirect_uri=http%3A%2F%2Flocalhost%3A2%2Fcb&state=DUP_PROMPT_S\nPaste code > ',
      );
      childPrompt.emitStdout(' '.repeat(70_000));
      childPrompt.emitStdout('ECONNREFUSED\n');
      childPrompt.finish(1);

      const resPrompt = await pPrompt;
      expect(resPrompt.status).toBe('error');
      if (resPrompt.status === 'error') {
        expect(resPrompt.message).toContain('ECONNREFUSED');
        expect(resPrompt.message).not.toContain('DUP_PROMPT_C');
        expect(resPrompt.message).not.toContain('DUP_PROMPT_S');
        expect(resPrompt.message).not.toContain('/oauth/authorize');
      }
    });

    it('resolves pending late getActiveSignInUrl() immediately on cancelSignIn(), dispose(), and finish(1) without hanging or phantom logs', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();

      const countUrlReadyLogs = () =>
        logSpy.mock.calls
          .flat()
          .map(String)
          .filter((msg) => msg.includes('Claude browser sign-in started (fallback OAuth URL ready)'))
          .length;

      // (a) cancelSignIn() while late settle timer is active
      const mgr1 = createManager();
      const p1 = mgr1.signIn();
      const child1 = spawned[0].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      child1.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c1&code_challenge=CH1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=CANCEL_PEND\n',
      );
      const pendingUrl1 = mgr1.getActiveSignInUrl();
      expect(mgr1.cancelSignIn()).toBe(true);
      expect(await pendingUrl1).toBeNull();
      expect(await p1).toEqual({ status: 'cancelled' });

      // Post-cancel chunk must not re-arm urlSettleTimer or emit phantom ready log
      child1.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c1b&code_challenge=CH1B&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=POST_CANCEL\n\n',
      );
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS * 2);
      expect(countUrlReadyLogs()).toBe(0);
      expect(await mgr1.getActiveSignInUrl()).toBeNull();

      // (b) dispose() while late settle timer is active
      logSpy.mockClear();
      const mgr2 = createManager();
      const p2 = mgr2.signIn();
      const child2 = spawned[1].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      child2.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c2&code_challenge=CH2&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=DISPOSE_PEND\n',
      );
      const pendingUrl2 = mgr2.getActiveSignInUrl();
      mgr2.dispose();
      expect(await pendingUrl2).toBeNull();
      expect(await p2).toEqual({ status: 'cancelled' });

      child2.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c2b&code_challenge=CH2B&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=POST_DISPOSE\n\n',
      );
      await vi.advanceTimersByTimeAsync(CLAUDE_URL_CONTINUATION_SETTLE_MS * 2);
      expect(countUrlReadyLogs()).toBe(0);
      expect(await mgr2.getActiveSignInUrl()).toBeNull();

      // (c) finish(1) while late settle timer is active flushes trailing candidateOAuthUrl without phantom "sign-in started" log
      logSpy.mockClear();
      const mgr3 = createManager();
      const p3 = mgr3.signIn();
      const child3 = spawned[2].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      child3.emitStdout(
        'https://claude.ai/oauth/authorize?client_id=c3&code_challenge=CH3&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=EOF_PART1\n',
      );
      const pendingUrl3 = mgr3.getActiveSignInUrl();
      child3.emitStdout('EOF_PART2');
      child3.finish(1);

      expect(await pendingUrl3).toBe(
        'https://claude.ai/oauth/authorize?client_id=c3&code_challenge=CH3&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=EOF_PART1EOF_PART2',
      );
      expect((await p3).status).toBe('error');
      expect(countUrlReadyLogs()).toBe(0);
      expect(await mgr3.getActiveSignInUrl()).toBeNull();

      // (d) finish(1) with trailing non-continuation diagnostic ('Error:', no '\n') after pending URL emits zero phantom "sign-in started" logs
      logSpy.mockClear();
      const mgr4 = createManager();
      const p4 = mgr4.signIn();
      const child4 = spawned[3].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGIN_URL_TIMEOUT_MS + 200);
      const eofErrUrl =
        'https://claude.ai/oauth/authorize?client_id=c4&code_challenge=CH4&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=EOF_ERR';
      child4.emitStdout(`${eofErrUrl}\n`);
      const pendingUrl4 = mgr4.getActiveSignInUrl();
      child4.emitStdout('Error:');
      child4.finish(1);

      expect(await pendingUrl4).toBe(eofErrUrl);
      const res4 = await p4;
      expect(res4.status).toBe('error');
      if (res4.status === 'error') {
        expect(res4.message).toContain('Error:');
      }
      expect(countUrlReadyLogs()).toBe(0);
      expect(await mgr4.getActiveSignInUrl()).toBeNull();

      // (e) finish(1) with newline-free OSC-8 OAuth URL preserves URL capture without emitting a phantom "sign-in started" log
      logSpy.mockClear();
      const mgr5 = createManager();
      const p5 = mgr5.signIn();
      const child5 = spawned[4].child;

      const waiter5 = mgr5.getActiveSignInUrl();
      const oscEofUrl =
        'https://claude.ai/oauth/authorize?client_id=c5&code_challenge=CH5&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=OSC_EOF';
      child5.emitStdout(`\x1b]8;;${oscEofUrl}\x07Sign in\x1b]8;;\x07`);
      child5.finish(1);

      expect(await waiter5).toBe(oscEofUrl);
      expect((await p5).status).toBe('error');
      expect(countUrlReadyLogs()).toBe(0);
      expect(await mgr5.getActiveSignInUrl()).toBeNull();
    });

    it('preserves fresh statusCache after successful signIn() for CLAUDE_STATUS_CACHE_TTL_MS while still invalidating on failed, false-positive, or cancelled signIn()', async () => {
      // 1. Successful signIn() preserves the fresh statusCache from post-exit getStatus({ forceRefresh: true })
      const mgrOk = createManager();
      const loginOk = mgrOk.signIn();
      expect(spawned).toHaveLength(1);
      spawned[0].child.finish(0);

      await Promise.resolve();
      expect(spawned).toHaveLength(2);
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'fresh@yvoke.ai' }),
      );
      spawned[1].child.finish(0);
      expect(await loginOk).toEqual({ status: 'signed_in', account: 'fresh@yvoke.ai' });

      // Within CLAUDE_STATUS_CACHE_TTL_MS -> 0 extra spawns
      nowMs += CLAUDE_STATUS_CACHE_TTL_MS - 1;
      expect(await mgrOk.getStatus()).toEqual({ claude: 'ok', claudeAccount: 'fresh@yvoke.ai' });
      expect(spawned).toHaveLength(2);

      // Past CLAUDE_STATUS_CACHE_TTL_MS -> re-spawns
      nowMs += 2;
      const afterTtl = mgrOk.getStatus();
      expect(spawned).toHaveLength(3);
      spawned[2].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'fresh@yvoke.ai' }),
      );
      spawned[2].child.finish(0);
      expect(await afterTtl).toEqual({ claude: 'ok', claudeAccount: 'fresh@yvoke.ai' });

      // 2. Failed signIn (exit 1), false-positive exit 0 (loggedIn: false), and cancelled signIn invalidate cache
      for (const outcome of ['exit1', 'falsePositive', 'cancelled'] as const) {
        const mgr = createManager();
        // Prime cache first
        const prime = mgr.getStatus();
        const primeChild = spawned[spawned.length - 1].child;
        primeChild.emitStdout(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c' }));
        primeChild.finish(0);
        await prime;

        const beforeCount = spawned.length;
        const p = mgr.signIn();
        const loginChild = spawned[spawned.length - 1].child;
        if (outcome === 'exit1') {
          loginChild.finish(1);
          expect((await p).status).toBe('error');
        } else if (outcome === 'falsePositive') {
          loginChild.finish(0);
          await Promise.resolve();
          const verifyChild = spawned[spawned.length - 1].child;
          verifyChild.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
          verifyChild.finish(0);
          expect((await p).status).toBe('error');
        } else {
          mgr.cancelSignIn();
          expect((await p).status).toBe('cancelled');
        }

        // Next getStatus() MUST spawn a fresh probe
        const countBeforeProbe = spawned.length;
        expect(countBeforeProbe).toBeGreaterThan(beforeCount);
        const probe = mgr.getStatus();
        expect(spawned.length).toBe(countBeforeProbe + 1);
        spawned[spawned.length - 1].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
        spawned[spawned.length - 1].child.finish(0);
        await probe;
      }
    });

    it('exposes getCachedStatus() with defensive copy, TTL survival, explicit invalidation/dispose clearing, and fallback sign-in sync', async () => {
      const mgr = createManager();

      // 1. Before any confirmed probe -> null
      expect(mgr.getCachedStatus()).toBeNull();

      // 2. After fallback/corrupt probe -> still null
      const corruptP = mgr.getStatus();
      spawned[0].child.emitStdout('{{{not-json');
      spawned[0].child.finish(0);
      await corruptP;
      expect(mgr.getCachedStatus()).toBeNull();

      // 3. After confirmed probe -> returns defensive copy and survives TTL expiry (> 30s) without spawning
      const okP = mgr.getStatus();
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'cached@yvoke.ai' }),
      );
      spawned[1].child.finish(0);
      await okP;

      const snap1 = mgr.getCachedStatus();
      expect(snap1).toEqual({ claude: 'ok', claudeAccount: 'cached@yvoke.ai' });
      snap1!.claude = 'missing';
      snap1!.claudeAccount = 'mutated@evil.example';
      expect(mgr.getCachedStatus()).toEqual({ claude: 'ok', claudeAccount: 'cached@yvoke.ai' });

      // Past 30s TTL -> still returns lastConfirmedState with 0 spawns
      nowMs += CLAUDE_STATUS_CACHE_TTL_MS + 60_000;
      const countBefore = spawned.length;
      expect(mgr.getCachedStatus()).toEqual({ claude: 'ok', claudeAccount: 'cached@yvoke.ai' });
      expect(spawned).toHaveLength(countBefore);

      // 4. invalidateStatusCache() -> returns null so explicit invalidations trigger one fresh probe
      mgr.invalidateStatusCache();
      expect(mgr.getCachedStatus()).toBeNull();

      // 5. Fallback-resolved signIn() (post-exit getStatus falls back to disk credentials with allowCache: false)
      //    still updates lastConfirmedState so getCachedStatus() returns { claude: 'ok', ... }
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), '{}');
      fs.writeFileSync(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'disk-login@yvoke.ai' } }),
      );
      const fbLogin = mgr.signIn();
      spawned[spawned.length - 1].child.finish(0);
      await Promise.resolve();
      // Post-exit status probe outputs corrupt JSON -> falls back to disk credentials -> claude: 'ok'
      spawned[spawned.length - 1].child.emitStdout('corrupt');
      spawned[spawned.length - 1].child.finish(0);
      expect(await fbLogin).toEqual({ status: 'signed_in', account: 'disk-login@yvoke.ai' });
      expect(mgr.getCachedStatus()).toEqual({ claude: 'ok', claudeAccount: 'disk-login@yvoke.ai' });

      // 6. dispose() -> returns null
      mgr.dispose();
      expect(mgr.getCachedStatus()).toBeNull();
    });
  });

  describe('signOut', () => {
    it('spawns claude auth logout with sanitized env, coalesces concurrent calls, cancels activeLogin, and blocks signIn() while in flight', async () => {
      const origApiKey = process.env.ANTHROPIC_API_KEY;
      const origNodeOpts = process.env.NODE_OPTIONS;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-logout';
      process.env.NODE_OPTIONS = '--require /evil.js';

      try {
        const mgr = createManager();

        // Start an active sign-in that must be synchronously cancelled when signOut() begins
        const loginPromise = mgr.signIn();
        expect(spawned).toHaveLength(1);
        const loginChild = spawned[0].child;

        // Concurrent signOut() calls must coalesce onto a single spawned child
        const out1 = mgr.signOut();
        const out2 = mgr.signOut();

        expect(loginChild.kill).toHaveBeenCalledWith('SIGTERM');
        expect(await loginPromise).toEqual({ status: 'cancelled' });

        expect(spawned).toHaveLength(2);
        const logoutCall = spawned[1];
        expect(logoutCall.cmd).toBe('/bundled/claude');
        expect(logoutCall.args).toEqual(['auth', 'logout']);
        expect(logoutCall.opts.cwd).toBe(sandboxDir);
        expect(logoutCall.opts.windowsHide).toBe(true);
        expect(logoutCall.opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        const spawnEnv = logoutCall.opts.env as Record<string, string | undefined>;
        expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
        expect(spawnEnv.NODE_OPTIONS).toBeUndefined();
        expect(spawnEnv.NO_COLOR).toBe('1');
        expect(spawnEnv.FORCE_COLOR).toBe('0');
        expect(spawnEnv.FORCE_HYPERLINK).toBe('0');
        expect(spawnEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');

        // Concurrent signIn() during activeSignOut must fail immediately without spawning
        const blockedSignIn = await mgr.signIn();
        expect(blockedSignIn).toEqual({
          status: 'error',
          message: 'Claude sign-out is in progress. Please wait a moment and try again.',
        });
        expect(spawned).toHaveLength(2);

        logoutCall.child.finish(0);

        const [r1, r2] = await Promise.all([out1, out2]);
        expect(r1).toEqual({ status: 'signed_out' });
        expect(r2).toEqual({ status: 'signed_out' });

        // After signOut settles, signIn() is permitted again
        const followUpLogin = mgr.signIn();
        expect(spawned).toHaveLength(3);
        expect(spawned[2].args).toEqual(['auth', 'login', '--claudeai']);
        mgr.cancelSignIn();
        await followUpLogin;
      } finally {
        if (origApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = origApiKey;
        if (origNodeOpts === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = origNodeOpts;
      }
    });

    it('prevents mid-flight getStatus() from populating statusCache while signOut() is running', async () => {
      const mgr = createManager();

      const signOutPromise = mgr.signOut();
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(['auth', 'logout']);

      // Mid-flight getStatus() #1 returns loggedIn: true while signOut() is still running
      const status1Promise = mgr.getStatus();
      expect(spawned).toHaveLength(2);
      expect(spawned[1].args).toEqual(['auth', 'status', '--json']);
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'stale@yvoke.ai' }),
      );
      spawned[1].child.finish(0);
      expect(await status1Promise).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });

      // Invoke getStatus() #2 BEFORE signOut() settles -> must NOT hit cache; must spawn a new status probe
      const status2Promise = mgr.getStatus();
      expect(spawned).toHaveLength(3);
      expect(spawned[2].args).toEqual(['auth', 'status', '--json']);

      // Settling signOut() cancels active status probes and invalidates cache again
      spawned[0].child.finish(0);
      expect(await signOutPromise).toEqual({ status: 'signed_out' });
      expect(spawned[2].child.kill).toHaveBeenCalledWith('SIGTERM');
      await status2Promise;
    });

    it('cancels pre-existing in-flight getStatus() probes and prevents them from caching', async () => {
      const mgr = createManager();

      const statusBefore = mgr.getStatus();
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(['auth', 'status', '--json']);
      const statusChild = spawned[0].child;

      const signOutPromise = mgr.signOut();
      expect(statusChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawned).toHaveLength(2);
      expect(spawned[1].args).toEqual(['auth', 'logout']);

      // Even if the killed status child emits loggedIn: true late, it must not poison cache
      statusChild.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'late-stale@yvoke.ai' }),
      );
      statusChild.finish(0);
      await statusBefore;

      spawned[1].child.finish(0);
      expect(await signOutPromise).toEqual({ status: 'signed_out' });

      // Immediate getStatus() after signOut() returns seeded { claude: 'missing' } with 0 extra spawns
      expect(await mgr.getStatus()).toEqual({ claude: 'missing' });
      expect(spawned).toHaveLength(2);

      // forceRefresh: true (or advancing past CLAUDE_MISSING_CACHE_TTL_MS) spawns fresh probe #3
      const statusAfter = mgr.getStatus({ forceRefresh: true });
      expect(spawned).toHaveLength(3);
      expect(spawned[2].args).toEqual(['auth', 'status', '--json']);
      spawned[2].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[2].child.finish(0);
      expect(await statusAfter).toEqual({ claude: 'missing' });
    });

    it('keeps post-signout status as missing when a subsequent probe times out on ~/.claude (cred === unknown), and recovers cleanly on external re-login or signIn()', async () => {
      vi.useFakeTimers();
      // ~/.claude exists without .credentials.json -> detectClaudeCredentials() === 'unknown' (e.g. macOS Keychain)
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'stale@yvoke.ai' } }),
      );

      // (c) Never-confirmed cold start with cred === 'unknown' + probe timeout still falls back to { claude: 'ok' }
      const coldMgr = createManager();
      const coldP = coldMgr.getStatus();
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await coldP).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });

      // After signOut() exits 0, subsequent probe timeout MUST stay { claude: 'missing' } (never flip back to 'ok')
      const mgr = createManager();
      const outP = mgr.signOut();
      spawned[spawned.length - 1].child.finish(0);
      expect(await outP).toEqual({ status: 'signed_out' });

      // Post-TTL probe timeout stays 'missing'
      nowMs += CLAUDE_MISSING_CACHE_TTL_MS + 1;
      const postTtlTimeout = mgr.getStatus();
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await postTtlTimeout).toEqual({ claude: 'missing' });

      // forceRefresh probe timeout also stays 'missing'
      const forcedTimeout = mgr.getStatus({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await forcedTimeout).toEqual({ claude: 'missing' });

      // (a) External re-login (.credentials.json created -> cred === 'ok') + probe timeout recovers to 'ok'
      fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), '{}');
      const extTimeout = mgr.getStatus({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await extTimeout).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });
      fs.rmSync(path.join(homeDir, '.claude', '.credentials.json'));

      // (b) Fresh signIn() (confirmed loggedIn: true) resets lastConfirmedState to 'ok' so subsequent timeout returns 'ok'
      const login1 = mgr.signIn();
      spawned[spawned.length - 1].child.finish(0);
      await Promise.resolve();
      spawned[spawned.length - 1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'relogged@yvoke.ai' }),
      );
      spawned[spawned.length - 1].child.finish(0);
      expect(await login1).toEqual({ status: 'signed_in', account: 'relogged@yvoke.ai' });

      const timeoutAfterLogin1 = mgr.getStatus({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await timeoutAfterLogin1).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });

      // (b2) Fallback-resolved signIn() (allowCache === false) after signOut() also resets lastConfirmedState to 'ok'
      const out2 = mgr.signOut();
      spawned[spawned.length - 1].child.finish(0);
      expect(await out2).toEqual({ status: 'signed_out' });

      fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), '{}');
      const login2 = mgr.signIn();
      spawned[spawned.length - 1].child.finish(0);
      await Promise.resolve();
      // Post-exit probe fails with corrupt JSON -> fallbackStatus sees .credentials.json -> signed_in
      spawned[spawned.length - 1].child.emitStdout('not-json');
      spawned[spawned.length - 1].child.finish(0);
      expect(await login2).toEqual({ status: 'signed_in', account: 'stale@yvoke.ai' });
      fs.rmSync(path.join(homeDir, '.claude', '.credentials.json'));

      const timeoutAfterFallbackLogin = mgr.getStatus({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await timeoutAfterFallbackLogin).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });

      // (d) Failed signOut(), dispose() during signOut(), and late pre-signout probeStatus never poison state
      const mgrFail = createManager();
      const primeFail = mgrFail.getStatus();
      spawned[spawned.length - 1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'still-in@yvoke.ai' }),
      );
      spawned[spawned.length - 1].child.finish(0);
      await primeFail;

      const failedOut = mgrFail.signOut();
      spawned[spawned.length - 1].child.finish(1);
      expect((await failedOut).status).toBe('error');
      // Still not poisoned to 'missing' -> timeout on cred === 'unknown' returns 'ok'
      const timeoutAfterFailedOut = mgrFail.getStatus({ forceRefresh: true });
      await vi.advanceTimersByTimeAsync(CLAUDE_STATUS_TIMEOUT_MS);
      expect(await timeoutAfterFailedOut).toEqual({ claude: 'ok', claudeAccount: 'stale@yvoke.ai' });

      const mgrDisp = createManager();
      const dispOut = mgrDisp.signOut();
      mgrDisp.dispose();
      expect((await dispOut).status).toBe('error');
      expect(mgrDisp.getCachedStatus()).toBeNull();
    });

    it('handles entry failures (disposed, null binary, mkdirSync throw, sync spawn throw) cleanly and recovers latch', async () => {
      // (a) Already disposed -> cancelled error, 0 spawns
      const disposedMgr = createManager();
      disposedMgr.dispose();
      expect(await disposedMgr.signOut()).toEqual({
        status: 'error',
        message: 'Claude sign-out was cancelled.',
      });
      expect(spawned).toHaveLength(0);

      // (b) resolveBinary() === null -> error + latch clears so retry succeeds
      let binaryPath: string | null = null;
      const binMgr = createManager({ resolveBinary: () => binaryPath });
      expect(await binMgr.signOut()).toEqual({
        status: 'error',
        message: 'Bundled Claude binary not found.',
      });
      expect(spawned).toHaveLength(0);

      binaryPath = '/bundled/claude';
      const retryBin = binMgr.signOut();
      expect(spawned).toHaveLength(1);
      spawned[0].child.finish(0);
      expect(await retryBin).toEqual({ status: 'signed_out' });

      // (c) fs.mkdirSync throws -> sanitized error + latch clears for follow-up signOut/signIn
      const mkdirSpy = vi
        .spyOn(fs, 'mkdirSync')
        .mockImplementationOnce(() => {
          throw new Error('EACCES Bearer SECRET_MKDIR_JWT');
        });
      const mkdirMgr = createManager();
      const mkdirRes = await mkdirMgr.signOut();
      expect(mkdirRes.status).toBe('error');
      if (mkdirRes.status === 'error') {
        expect(mkdirRes.message).not.toContain('SECRET_MKDIR_JWT');
        expect(mkdirRes.message).toContain('Bearer [REDACTED]');
      }
      expect(spawned).toHaveLength(1);
      mkdirSpy.mockRestore();

      const afterMkdirLogin = mkdirMgr.signIn();
      expect(spawned).toHaveLength(2);
      mkdirMgr.cancelSignIn();
      await afterMkdirLogin;

      // (d) spawnFn throws synchronously -> sanitized error + latch clears for follow-up signOut/signIn
      let shouldThrowSpawn = true;
      const spawnErrMgr = createManager({
        spawn: (cmd, args, opts) => {
          if (shouldThrowSpawn) {
            throw new Error('spawn EACCES sk-ant-api03-SECRET_SPAWN_KEY');
          }
          const child = new FakeChildProcess();
          spawned.push({ cmd, args, opts: opts as unknown as Record<string, unknown>, child });
          return child;
        },
      });
      const spawnRes = await spawnErrMgr.signOut();
      expect(spawnRes.status).toBe('error');
      if (spawnRes.status === 'error') {
        expect(spawnRes.message).not.toContain('SECRET_SPAWN_KEY');
        expect(spawnRes.message).toContain('sk-ant-[REDACTED]');
      }

      shouldThrowSpawn = false;
      const afterSpawnOut = spawnErrMgr.signOut();
      expect(spawned).toHaveLength(3);
      spawned[2].child.finish(0);
      expect(await afterSpawnOut).toEqual({ status: 'signed_out' });
    });

    it('enforces 10s timeout and dispose() SIGKILL escalation, drains >64KB dual streams, and strips ANSI/OSC-8 + redacts secrets', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // (a) 10s timeout -> SIGTERM + 1s SIGKILL escalation + latch recovery
      vi.useFakeTimers();
      const timeoutMgr = createManager();
      const timeoutPromise = timeoutMgr.signOut();
      expect(spawned).toHaveLength(1);
      const hungChild = spawned[0].child;

      await vi.advanceTimersByTimeAsync(CLAUDE_LOGOUT_TIMEOUT_MS);
      expect(await timeoutPromise).toEqual({
        status: 'error',
        message: 'Claude sign-out timed out.',
      });
      expect(hungChild.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(1_500);
      expect(hungChild.kill).toHaveBeenCalledWith('SIGKILL');

      // Latch cleared -> retry works
      const retryPromise = timeoutMgr.signOut();
      expect(spawned).toHaveLength(2);
      spawned[1].child.finish(0);
      expect(await retryPromise).toEqual({ status: 'signed_out' });

      // (b) dispose() during activeSignOut -> SIGTERM + 1s SIGKILL escalation + cancelled error
      const disposeMgr = createManager();
      const disposeOutPromise = disposeMgr.signOut();
      expect(spawned).toHaveLength(3);
      const disposeChild = spawned[2].child;

      disposeMgr.dispose();
      expect(disposeChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(await disposeOutPromise).toEqual({
        status: 'error',
        message: 'Claude sign-out was cancelled.',
      });

      await vi.advanceTimersByTimeAsync(1_500);
      expect(disposeChild.kill).toHaveBeenCalledWith('SIGKILL');
      vi.useRealTimers();

      // (c) Dual-stream >64KB drain + ANSI/OSC-8 stripping + secret redaction + <= 300 char bound
      const pipeStdout = new PassThrough({ highWaterMark: 64 });
      const pipeStderr = new PassThrough({ highWaterMark: 64 });
      const drainMgr = createManager({
        spawn: (cmd, args, opts) => {
          const child = new FakeChildProcess();
          (child as unknown as { stdout: PassThrough }).stdout = pipeStdout;
          (child as unknown as { stderr: PassThrough }).stderr = pipeStderr;
          spawned.push({ cmd, args, opts: opts as unknown as Record<string, unknown>, child });
          return child;
        },
      });

      const drainOutPromise = drainMgr.signOut();
      expect(spawned).toHaveLength(4);

      pipeStdout.write(
        `${'O'.repeat(70_000)}\n\x1b[33m\x1b]8;;https://claude.ai/oauth/authorize?code=OUT_CODE_SECRET&state=OUT_STATE_SECRET\x07stdout-fail\x1b]8;;\x07\x1b[0m sk-ant-api03-STDOUT_SECRET Bearer STDOUT_JWT_SECRET\n`,
      );
      pipeStderr.write(
        `${'E'.repeat(70_000)}\n\x1b[31m\x1b]8;;https://claude.ai/oauth/authorize?code=ERR_CODE_SECRET&state=ERR_STATE_SECRET\x07stderr-fail\x1b]8;;\x07\x1b[0m sk-ant-api03-STDERR_SECRET Bearer STDERR_JWT_SECRET\n`,
      );

      // Both PassThrough streams must be drained immediately with 0 unread backpressure
      expect(pipeStdout.readableLength).toBe(0);
      expect(pipeStderr.readableLength).toBe(0);

      spawned[3].child.finish(1);
      const failRes = await drainOutPromise;
      expect(failRes.status).toBe('error');
      if (failRes.status === 'error') {
        expect(failRes.message.length).toBeLessThanOrEqual(300);
        expect(failRes.message).toContain('stderr-fail');
        expect(failRes.message).toContain('stdout-fail');
        expect(failRes.message).toContain('[REDACTED]');
        expect(failRes.message).not.toMatch(/\x1b/);
        for (const leaked of [
          'OUT_CODE_SECRET',
          'OUT_STATE_SECRET',
          'STDOUT_SECRET',
          'STDOUT_JWT_SECRET',
          'ERR_CODE_SECRET',
          'ERR_STATE_SECRET',
          'STDERR_SECRET',
          'STDERR_JWT_SECRET',
        ]) {
          expect(failRes.message).not.toContain(leaked);
        }
      }

      // Check logged output via console.error also contains no leaked secrets or ANSI escapes
      expect(errSpy).toHaveBeenCalled();
      const allLogs = [
        ...logSpy.mock.calls.flat().map(String),
        ...errSpy.mock.calls.flat().map(String),
      ].join('\n');
      for (const leaked of [
        'OUT_CODE_SECRET',
        'OUT_STATE_SECRET',
        'STDOUT_SECRET',
        'STDOUT_JWT_SECRET',
        'ERR_CODE_SECRET',
        'ERR_STATE_SECRET',
        'STDERR_SECRET',
        'STDERR_JWT_SECRET',
      ]) {
        expect(allLogs).not.toContain(leaked);
      }

      // (d) Subprocess error event -> sanitized error & latch recovery
      const errEventMgr = createManager();
      const errEventPromise = errEventMgr.signOut();
      expect(spawned).toHaveLength(5);
      spawned[4].child.emit('error', new Error('spawn ENOENT Bearer EVENT_ERR_SECRET'));
      const errEventRes = await errEventPromise;
      expect(errEventRes.status).toBe('error');
      if (errEventRes.status === 'error') {
        expect(errEventRes.message).not.toContain('EVENT_ERR_SECRET');
        expect(errEventRes.message).toContain('Bearer [REDACTED]');
        expect(errEventRes.message.length).toBeLessThanOrEqual(300);
      }
      const afterErrEvent = errEventMgr.signOut();
      expect(spawned).toHaveLength(6);
      spawned[5].child.finish(0);
      expect(await afterErrEvent).toEqual({ status: 'signed_out' });
    });
  });
});

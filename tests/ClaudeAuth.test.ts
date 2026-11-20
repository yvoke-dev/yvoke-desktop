import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_LOGIN_CODE_EXCHANGE_TIMEOUT_MS,
  CLAUDE_LOGIN_TIMEOUT_MS,
  CLAUDE_LOGIN_URL_TIMEOUT_MS,
  CLAUDE_LOGOUT_TIMEOUT_MS,
  CLAUDE_STATUS_CACHE_TTL_MS,
  CLAUDE_STATUS_TIMEOUT_MS,
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
  destroyed = false;

  write(chunk: string): boolean {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(chunk);
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

    it('never caches missing across sequential calls so window focus rechecks immediately detect external sign-in', async () => {
      // Simulate macOS ~/.claude directory existing without credentials (where detectClaudeCredentials was inconclusive)
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      const mgr = createManager();

      const p1 = mgr.getStatus();
      spawned[0].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[0].child.finish(0);
      expect(await p1).toEqual({ claude: 'missing' });

      // Immediate second call without advancing clock must re-spawn rather than serving cached missing
      const p2 = mgr.getStatus();
      expect(spawned).toHaveLength(2);
      spawned[1].child.emitStdout(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'now-signed-in@yvoke.ai' }),
      );
      spawned[1].child.finish(0);
      expect(await p2).toEqual({ claude: 'ok', claudeAccount: 'now-signed-in@yvoke.ai' });
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
        'Opening browser...\nhttps://claude.ai/oauth/authorize?client_id=abc&response_type=code&state=SECRET_NONCE&code_challenge=SECRET_CHALLENGE\n',
      );
      expect(await mgr.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?client_id=abc&response_type=code&state=SECRET_NONCE&code_challenge=SECRET_CHALLENGE',
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
      spawned[0].child.emitStdout('orize?state=NONCE1&code_challenge=CHAL1\x07Click here\x1b]8;;\x07\x1b[0m\r\n');
      expect(await urlWaiter).toBe(
        'https://claude.com/cai/oauth/authorize?state=NONCE1&code_challenge=CHAL1',
      );
      expect(mgr.cancelSignIn()).toBe(true);
      expect(await p1).toEqual({ status: 'cancelled' });

      // 2. ST (\x1b\\) OSC-8 hyperlink on console.anthropic.com
      const p2 = mgr.signIn();
      spawned[1].child.emitStdout(
        '\x1b]8;id=link1;https://console.anthropic.com/oauth/authorize?state=NONCE2\x1b\\Sign in\x1b]8;;\x1b\\\n',
      );
      expect(await mgr.getActiveSignInUrl()).toBe(
        'https://console.anthropic.com/oauth/authorize?state=NONCE2',
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
        `https://claude.ai/oauth/authorize?state=DROPPED_HEAD ${'X'.repeat(70_000)}`,
      );
      loginChild.emitStdout('tail-end\n');
      loginChild.emitStdout('https://claude.ai/oauth/authorize?state=BOUNDED_FRESH\n');

      // Also emit >70,000 newline-free chars on stderr without OOM or crash
      loginChild.emitStderr('E'.repeat(70_000));

      expect(await mgrLogin.getActiveSignInUrl()).toBe(
        'https://claude.ai/oauth/authorize?state=BOUNDED_FRESH',
      );
      mgrLogin.cancelSignIn();
      await signInPromise;
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

      // Next getStatus() must spawn a fresh probe (0 cache hit)
      const statusAfter = mgr.getStatus();
      expect(spawned).toHaveLength(3);
      expect(spawned[2].args).toEqual(['auth', 'status', '--json']);
      spawned[2].child.emitStdout(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
      spawned[2].child.finish(0);
      expect(await statusAfter).toEqual({ claude: 'missing' });
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

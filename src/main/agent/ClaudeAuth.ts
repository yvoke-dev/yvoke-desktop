import * as childProcess from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { sanitizeLogContent } from '../../shared/error';
import { IpcChannels } from '../../shared/ipc';
import type { ClaudeCodeSubmitResult, ClaudeSignInResult } from '../../shared/types';
import { log, logError } from '../log';
import { NoReplyError, ResultError } from './singleTurn';

/**
 * Claude (model) authentication helpers and subprocess-backed sign-in manager.
 *
 * Raw Claude OAuth access/refresh tokens never enter Yvoke Desktop — the bundled Claude Code
 * binary performs the OAuth PKCE exchange (`claude auth login --claudeai`) and persists
 * credentials in the OS Keychain / `~/.claude/.credentials.json`, while `claude auth status --json`
 * checks passive login presence without leaking secrets.
 */

export type ClaudeCredentialStatus = 'ok' | 'missing' | 'unknown';

export const CLAUDE_STATUS_TIMEOUT_MS = 4_000;
export const CLAUDE_STATUS_CACHE_TTL_MS = 30_000;
export const CLAUDE_LOGIN_URL_TIMEOUT_MS = 10_000;
export const CLAUDE_LOGIN_CODE_EXCHANGE_TIMEOUT_MS = 15_000;
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

const KILL_ESCALATION_MS = 1_000;
const MAX_AUTH_CODE_LENGTH = 4_096;
const MAX_CLI_DIAGNOSTIC_CHARS = 2_048;
export const MAX_CLI_LINE_BUFFER_CHARS = 65_536;
const ALLOWED_OAUTH_DOMAINS = ['claude.com', 'claude.ai', 'anthropic.com'] as const;

export function detectClaudeCredentials(home: string = os.homedir()): ClaudeCredentialStatus {
  try {
    // Linux/Windows store credentials on disk; macOS may use the keychain, in which
    // case absence of the file is inconclusive — report 'unknown' rather than 'missing'.
    const credentialsFile = path.join(home, '.claude', '.credentials.json');
    if (fs.existsSync(credentialsFile)) {
      return 'ok';
    }
    const claudeDir = path.join(home, '.claude');
    if (process.platform === 'darwin' && fs.existsSync(claudeDir)) {
      return 'unknown';
    }
    return fs.existsSync(claudeDir) ? 'unknown' : 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * The signed-in Claude account's email, if Claude Code has recorded one. Claude Code
 * stores the OAuth identity in ~/.claude.json under `oauthAccount.emailAddress`. Returns
 * undefined when absent or unreadable — this is display-only, never an auth gate.
 */
export function detectClaudeAccount(home: string = os.homedir()): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } })?.oauthAccount
      ?.emailAddress;
    return typeof email === 'string' && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

export function isAuthError(message: string): boolean {
  return /invalid api key|not logged in|please run \/login|authentication|credential|oauth token|api key/i.test(
    message,
  );
}

/**
 * Classifies a Claude failure into a rate limit or auth expiration status, or returns undefined.
 * Checks typed NoReplyError and ResultError status first:
 * - NoReplyError -> undefined (subprocess ended without a result, not an auth failure)
 * - 429 -> rate_limited
 * - 401 -> expired (session expired / not signed in)
 * - 403 -> expired (account or organization permission denied)
 * When an explicit HTTP status is present on ResultError, it never falls through to prose regex
 * matching (e.g. a 500 error whose body mentions "API key" is a server error, not expired auth).
 * Falls back to prose regex only when no HTTP status is present (rate-limit before auth).
 */
export function classifyClaudeFailure(
  err: unknown,
): { status: 'rate_limited' | 'expired'; message: string } | undefined {
  if (err instanceof NoReplyError) {
    return undefined;
  }
  if (err instanceof ResultError && err.status != null) {
    if (err.status === 429) {
      return {
        status: 'rate_limited',
        message: 'Claude subscription allowance or rate limit reached.',
      };
    }
    if (err.status === 401) {
      return {
        status: 'expired',
        message: 'Claude session expired or not signed in. Sign in to Claude to continue.',
      };
    }
    if (err.status === 403) {
      return {
        status: 'expired',
        message: 'Claude denied access for this account. Sign in to Claude again, or check your subscription.',
      };
    }
    return undefined;
  }
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  // Allowance first: a genuine 429 body names the API key, which isAuthError also matches.
  if (/rate limit|allowance|usage limit|\b429\b/i.test(text)) {
    return {
      status: 'rate_limited',
      message: 'Claude subscription allowance or rate limit reached.',
    };
  }
  if (isAuthError(text)) {
    return {
      status: 'expired',
      message: 'Claude session expired or not signed in. Sign in to Claude to continue.',
    };
  }
  return undefined;
}

/**
 * Environment for the SDK subprocess: inherit everything except ANTHROPIC_API_KEY,
 * which would silently switch billing from the subscription to pay-per-token.
 *
 * Background tasks are switched off, always. Delegation (specialists, the reviewer) has to be
 * synchronous — the caller needs the answer in hand — yet the CLI backgrounds a subagent by default,
 * answering with "Async agent launched successfully" instead.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (!env.MAX_MCP_OUTPUT_TOKENS) {
    env.MAX_MCP_OUTPUT_TOKENS = '100000';
  }
  return env;
}

/**
 * Hardened environment for direct `claude auth` CLI invocations: removes `ANTHROPIC_API_KEY`
 * and `NODE_OPTIONS`, and suppresses ANSI colors and terminal hyperlink escapes where supported.
 */
export function claudeCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sanitizedEnv(base) };
  delete env.ANTHROPIC_API_KEY;
  delete env.NODE_OPTIONS;
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.FORCE_HYPERLINK = '0';
  return env;
}

export const LOGIN_INSTRUCTIONS =
  'No Claude credentials found. Sign in to Claude with your Pro or Max account to continue. ' +
  'Desktop-app usage draws from the Agent SDK credit of your subscription.';

export interface ResolveClaudeBinaryDeps {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  preferMusl?: boolean;
  existsSync?: (filePath: string) => boolean;
  resolveSdkEntry?: () => string;
  resolveFromSdk?: (sdkEntry: string, specifier: string) => string;
}

function detectMuslRuntime(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  try {
    const report =
      typeof process.report?.getReport === 'function'
        ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } } | null)
        : null;
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/**
 * Resolves the bundled Claude Code native binary without touching `process.env.PATH`
 * or importing unexported `@anthropic-ai/claude-agent-sdk/manifest.json`.
 */
export function resolveClaudeBinaryPath(deps?: ResolveClaudeBinaryDeps): string | null {
  const platform = deps?.platform ?? process.platform;
  const arch = deps?.arch ?? process.arch;
  const existsSync = deps?.existsSync ?? fs.existsSync;
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
  const resourcesPath = deps && 'resourcesPath' in deps ? deps.resourcesPath : process.resourcesPath;

  if (resourcesPath) {
    const staged = path.join(resourcesPath, binaryName);
    if (existsSync(staged)) {
      return staged;
    }
  }

  let sdkEntry: string;
  try {
    sdkEntry = deps?.resolveSdkEntry
      ? deps.resolveSdkEntry()
      : createRequire(__filename).resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null;
  }

  const preferMusl = deps?.preferMusl ?? detectMuslRuntime(platform);
  const suffixes =
    platform === 'linux'
      ? preferMusl
        ? [`linux-${arch}-musl`, `linux-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`]
      : [`${platform}-${arch}`];

  const sdkRequire = deps?.resolveFromSdk ? null : createRequire(sdkEntry);
  for (const suffix of suffixes) {
    const specifier = `@anthropic-ai/claude-agent-sdk-${suffix}/${binaryName}`;
    try {
      const resolved = deps?.resolveFromSdk
        ? deps.resolveFromSdk(sdkEntry, specifier)
        : sdkRequire!.resolve(specifier);
      const unpacked = resolved.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      if (unpacked !== resolved && existsSync(unpacked)) {
        return unpacked;
      }
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Try next candidate suffix (e.g. glibc <-> musl on Linux).
    }
  }

  return null;
}

export interface SpawnedCliProcess extends EventEmitter {
  stdin: {
    write(chunk: string, callback?: (error?: Error | null) => void): boolean;
    end?: () => void;
    destroyed?: boolean;
    writableEnded?: boolean;
    on(event: 'error', listener: (err: Error) => void): unknown;
  } | null;
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  exitCode: number | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type ClaudeCliSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedCliProcess;

export interface ClaudeAuthState {
  claude: 'ok' | 'missing';
  claudeAccount?: string;
}

export interface ClaudeAuthManagerDeps {
  sandboxDir: string;
  spawn?: ClaudeCliSpawn;
  resolveBinary?: () => string | null;
  homedir?: () => string;
  now?: () => number;
}

function terminateChild(child: SpawnedCliProcess): void {
  if (child.exitCode !== null) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  if (child.exitCode !== null) {
    return;
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore already-reaped subprocesses.
      }
    }
  }, KILL_ESCALATION_MS);
  killTimer.unref?.();
  const clearEscalation = () => clearTimeout(killTimer);
  child.once('close', clearEscalation);
  child.once('exit', clearEscalation);
}

function stripAnsiAndOsc8(line: string): string {
  return line
    .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, ' $1 ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function validateClaudeOAuthUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.port !== '') return null;

  const host = parsed.hostname.toLowerCase();
  const hostAllowed = ALLOWED_OAUTH_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (!hostAllowed) return null;
  if (!parsed.pathname.endsWith('/oauth/authorize')) return null;

  return parsed.toString();
}

function extractOAuthUrlFromCompleteLine(rawLine: string): string | null {
  const candidates: string[] = [];

  const osc8Pattern = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  let oscMatch: RegExpExecArray | null;
  while ((oscMatch = osc8Pattern.exec(rawLine)) !== null) {
    if (oscMatch[1]) {
      candidates.push(oscMatch[1].trim());
    }
  }

  const stripped = stripAnsiAndOsc8(rawLine);
  const urlPattern = /(?:^|\s)(https:\/\/[^\s"'<>]+)/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlPattern.exec(stripped)) !== null) {
    candidates.push(urlMatch[1]);
  }

  for (const candidate of candidates) {
    const validated = validateClaudeOAuthUrl(candidate);
    if (validated) {
      return validated;
    }
  }
  return null;
}

interface ActiveLoginState {
  child: SpawnedCliProcess;
  promise: Promise<ClaudeSignInResult>;
  oauthUrl: string | null;
  urlWindowClosed: boolean;
  urlReadyPromise: Promise<string | null>;
  resolveUrlReady: (url: string | null) => void;
  codeSubmitted: boolean;
  codeExchangeTimer?: ReturnType<typeof setTimeout>;
  startCodeExchangeTimer: (ms: number) => void;
  cancel: () => void;
}

export class ClaudeAuthManager {
  private readonly sandboxDir: string;
  private readonly spawnFn: ClaudeCliSpawn;
  private readonly resolveBinary: () => string | null;
  private readonly homedir: () => string;
  private readonly now: () => number;

  private disposed = false;
  private statusGeneration = 0;
  private statusCache: { value: ClaudeAuthState; at: number } | null = null;
  private statusInFlight: Promise<ClaudeAuthState> | null = null;
  private activeStatusCancels = new Set<() => void>();
  private activeLogin: ActiveLoginState | null = null;

  constructor(deps: ClaudeAuthManagerDeps) {
    this.sandboxDir = deps.sandboxDir;
    this.spawnFn =
      deps.spawn ?? ((cmd, args, opts) => childProcess.spawn(cmd, args, opts) as SpawnedCliProcess);
    this.resolveBinary = deps.resolveBinary ?? (() => resolveClaudeBinaryPath());
    this.homedir = deps.homedir ?? os.homedir;
    this.now = deps.now ?? Date.now;
  }

  invalidateStatusCache(): void {
    this.statusGeneration += 1;
    this.statusCache = null;
    this.statusInFlight = null;
  }

  async getStatus(opts?: { forceRefresh?: boolean }): Promise<ClaudeAuthState> {
    if (this.disposed) {
      return this.fallbackStatus();
    }

    if (opts?.forceRefresh) {
      this.invalidateStatusCache();
    } else if (
      this.statusCache &&
      this.now() - this.statusCache.at < CLAUDE_STATUS_CACHE_TTL_MS
    ) {
      return { ...this.statusCache.value };
    }

    if (this.statusInFlight) {
      return this.statusInFlight;
    }

    const gen = this.statusGeneration;
    const run = this.probeStatus(gen);
    this.statusInFlight = run;
    run
      .finally(() => {
        if (this.statusInFlight === run) {
          this.statusInFlight = null;
        }
      })
      .catch(() => undefined);

    return run;
  }

  private fallbackStatus(): ClaudeAuthState {
    const home = this.homedir();
    const cred = detectClaudeCredentials(home);
    const account = detectClaudeAccount(home);
    return {
      claude: cred === 'missing' ? 'missing' : 'ok',
      claudeAccount: account,
    };
  }

  private probeStatus(gen: number): Promise<ClaudeAuthState> {
    const binary = this.resolveBinary();
    if (!binary) {
      return Promise.resolve(this.fallbackStatus());
    }

    try {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    } catch {
      return Promise.resolve(this.fallbackStatus());
    }

    return new Promise<ClaudeAuthState>((resolve) => {
      let child: SpawnedCliProcess;
      try {
        child = this.spawnFn(binary, ['auth', 'status', '--json'], {
          cwd: this.sandboxDir,
          env: claudeCliEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        resolve(this.fallbackStatus());
        return;
      }

      let stdout = '';
      let settled = false;

      const cancelProbe = (): void => {
        terminateChild(child);
        finish(this.fallbackStatus(), false);
      };

      const finish = (state: ClaudeAuthState, allowCache: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeStatusCancels.delete(cancelProbe);
        if (
          allowCache &&
          state.claude === 'ok' &&
          !this.disposed &&
          gen === this.statusGeneration
        ) {
          this.statusCache = { value: state, at: this.now() };
        }
        resolve({ ...state });
      };

      this.activeStatusCancels.add(cancelProbe);

      const timer = setTimeout(() => {
        cancelProbe();
      }, CLAUDE_STATUS_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdout.length < MAX_CLI_LINE_BUFFER_CHARS) {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        }
      });
      // Drain stderr so verbose CLAUDE_DEBUG output never fills the OS pipe buffer and deadlocks the CLI.
      child.stderr?.on('data', () => {});

      child.once('error', () => {
        finish(this.fallbackStatus(), false);
      });

      child.once('close', () => {
        if (settled) return;
        if (this.disposed) {
          finish(this.fallbackStatus(), false);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
          if (!parsed || typeof parsed !== 'object' || typeof parsed.loggedIn !== 'boolean') {
            finish(this.fallbackStatus(), false);
            return;
          }
          const authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
          const validLogin =
            parsed.loggedIn === true &&
            authMethod !== 'none' &&
            authMethod !== 'api_key_helper';

          if (!validLogin) {
            // Never cache 'missing', and never expose an account when not signed in.
            finish({ claude: 'missing' }, false);
            return;
          }

          const email =
            typeof parsed.email === 'string' && parsed.email.trim().length > 0
              ? parsed.email.trim()
              : detectClaudeAccount(this.homedir());
          finish(
            {
              claude: 'ok',
              ...(email ? { claudeAccount: email } : {}),
            },
            true,
          );
        } catch {
          finish(this.fallbackStatus(), false);
        }
      });
    });
  }

  signIn(): Promise<ClaudeSignInResult> {
    if (this.disposed) {
      return Promise.resolve({ status: 'cancelled' });
    }
    if (this.activeLogin) {
      return this.activeLogin.promise;
    }

    const binary = this.resolveBinary();
    if (!binary) {
      return Promise.resolve({
        status: 'error',
        message: 'Bundled Claude binary could not be found. Reinstall Yvoke Desktop and try again.',
      });
    }

    try {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    } catch (err) {
      const msg = sanitizeLogContent(err instanceof Error ? err.message : String(err));
      return Promise.resolve({
        status: 'error',
        message: `Failed to prepare Claude sign-in sandbox: ${msg}`,
      });
    }

    let child: SpawnedCliProcess;
    try {
      child = this.spawnFn(binary, ['auth', 'login', '--claudeai'], {
        cwd: this.sandboxDir,
        env: claudeCliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      const msg = sanitizeLogContent(err instanceof Error ? err.message : String(err));
      return Promise.resolve({
        status: 'error',
        message: `Failed to start Claude sign-in: ${msg}`,
      });
    }

    // Prevent unhandled EPIPE if the CLI closes stdin before or during manual code entry.
    child.stdin?.on('error', () => {});

    let resolveUrlReady!: (url: string | null) => void;
    const urlReadyPromise = new Promise<string | null>((res) => {
      resolveUrlReady = res;
    });

    let settled = false;
    let cancelled = false;
    let resolveLogin!: (result: ClaudeSignInResult) => void;
    const promise = new Promise<ClaudeSignInResult>((res) => {
      resolveLogin = res;
    });

    const loginState: ActiveLoginState = {
      child,
      promise,
      oauthUrl: null,
      urlWindowClosed: false,
      urlReadyPromise,
      resolveUrlReady,
      codeSubmitted: false,
      startCodeExchangeTimer: (ms: number) => {
        loginState.codeExchangeTimer = setTimeout(() => {
          terminateChild(child);
          settle({
            status: 'error',
            message: 'Timed out verifying authorization code with Claude. Please try again.',
          });
        }, ms);
        loginState.codeExchangeTimer.unref?.();
      },
      cancel: () => {
        cancelled = true;
        terminateChild(child);
        settle({ status: 'cancelled' });
      },
    };
    this.activeLogin = loginState;

    const urlTimer = setTimeout(() => {
      if (!loginState.urlWindowClosed) {
        loginState.urlWindowClosed = true;
        loginState.resolveUrlReady(loginState.oauthUrl);
      }
    }, CLAUDE_LOGIN_URL_TIMEOUT_MS);
    urlTimer.unref?.();

    const loginTimer = setTimeout(() => {
      terminateChild(child);
      settle({
        status: 'error',
        message: 'Claude sign-in timed out after 5 minutes. Please try again.',
      });
    }, CLAUDE_LOGIN_TIMEOUT_MS);
    loginTimer.unref?.();

    const clearLoginTimers = (): void => {
      clearTimeout(urlTimer);
      clearTimeout(loginTimer);
      if (loginState.codeExchangeTimer) {
        clearTimeout(loginState.codeExchangeTimer);
        loginState.codeExchangeTimer = undefined;
      }
      if (!loginState.urlWindowClosed) {
        loginState.urlWindowClosed = true;
        loginState.resolveUrlReady(loginState.oauthUrl);
      }
    };

    const settle = (result: ClaudeSignInResult): void => {
      if (settled) return;
      settled = true;
      clearLoginTimers();
      if (this.activeLogin === loginState) {
        this.activeLogin = null;
      }
      if (result.status === 'error') {
        resolveLogin({ status: 'error', message: sanitizeLogContent(result.message) });
      } else {
        resolveLogin(result);
      }
    };

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let diagnosticTail = '';

    const appendDiagnostic = (cleanLine: string): void => {
      const trimmed = cleanLine.trim();
      if (!trimmed) return;
      const redacted = sanitizeLogContent(trimmed);
      diagnosticTail = diagnosticTail ? `${diagnosticTail}\n${redacted}` : redacted;
      if (diagnosticTail.length > MAX_CLI_DIAGNOSTIC_CHARS) {
        diagnosticTail = diagnosticTail.slice(-MAX_CLI_DIAGNOSTIC_CHARS);
      }
    };

    const handleCompleteLine = (rawLine: string, recordDiagnostic: boolean): void => {
      if (recordDiagnostic) {
        appendDiagnostic(stripAnsiAndOsc8(rawLine));
      }
      if (!loginState.oauthUrl) {
        const extracted = extractOAuthUrlFromCompleteLine(rawLine);
        if (extracted) {
          loginState.oauthUrl = extracted;
          if (!loginState.urlWindowClosed) {
            loginState.urlWindowClosed = true;
            clearTimeout(urlTimer);
            loginState.resolveUrlReady(extracted);
          }
          log('auth', 'Claude browser sign-in started (fallback OAuth URL ready)');
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = stdoutBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        handleCompleteLine(line, false);
        nl = stdoutBuffer.indexOf('\n');
      }
      if (stdoutBuffer.length > MAX_CLI_LINE_BUFFER_CHARS) {
        stdoutBuffer = stdoutBuffer.slice(-MAX_CLI_LINE_BUFFER_CHARS);
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        handleCompleteLine(line, true);
        nl = stderrBuffer.indexOf('\n');
      }
      if (stderrBuffer.length > MAX_CLI_LINE_BUFFER_CHARS) {
        stderrBuffer = stderrBuffer.slice(-MAX_CLI_LINE_BUFFER_CHARS);
      }
    });

    child.once('error', (err: Error) => {
      const msg = sanitizeLogContent(err.message || 'Unknown subprocess error');
      logError('auth', `Claude sign-in subprocess error: ${msg}`);
      settle({ status: 'error', message: `Failed to start Claude sign-in: ${msg}` });
    });

    child.once('close', (code: number | null) => {
      if (settled) return;
      if (stderrBuffer.trim().length > 0) {
        appendDiagnostic(stripAnsiAndOsc8(stderrBuffer));
        stderrBuffer = '';
      }
      if (this.disposed || cancelled) {
        settle({ status: 'cancelled' });
        return;
      }
      if (code === 0) {
        // Clear child timers and URL waiter, but keep `this.activeLogin = loginState` and
        // `settled = false` across post-exit status verification so concurrent signIn(),
        // cancelSignIn(), and dispose() are honoured throughout the verification window.
        clearLoginTimers();
        void this.getStatus({ forceRefresh: true })
          .then((status) => {
            if (settled) return;
            if (this.disposed || cancelled) {
              settle({ status: 'cancelled' });
              return;
            }
            if (status.claude !== 'ok') {
              settle({
                status: 'error',
                message:
                  'Claude sign-in finished, but no active Claude subscription credentials were found. Please try again.',
              });
              return;
            }
            log('auth', 'Claude browser sign-in completed');
            settle({
              status: 'signed_in',
              ...(status.claudeAccount ? { account: status.claudeAccount } : {}),
            });
          })
          .catch((err) => {
            if (settled) return;
            if (this.disposed || cancelled) {
              settle({ status: 'cancelled' });
              return;
            }
            const msg = sanitizeLogContent(err instanceof Error ? err.message : String(err));
            settle({
              status: 'error',
              message: `Claude sign-in verification failed: ${msg}`,
            });
          });
        return;
      }

      const detail = diagnosticTail.trim();
      const message = detail
        ? `Claude sign-in failed: ${detail.slice(0, 300)}`
        : `Claude sign-in failed (exit code ${code ?? 'unknown'}).`;
      logError('auth', message);
      settle({ status: 'error', message });
    });

    return promise;
  }

  cancelSignIn(): boolean {
    if (!this.activeLogin) {
      return false;
    }
    this.activeLogin.cancel();
    return true;
  }

  async getActiveSignInUrl(): Promise<string | null> {
    const login = this.activeLogin;
    if (!login || login.child.exitCode !== null) {
      return null;
    }
    if (login.oauthUrl) {
      return login.oauthUrl;
    }
    if (login.urlWindowClosed) {
      return null;
    }
    return login.urlReadyPromise;
  }

  async submitAuthCode(code: unknown): Promise<ClaudeCodeSubmitResult> {
    if (typeof code !== 'string') {
      return { accepted: false, message: 'Enter the authorization code from your browser.' };
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      return { accepted: false, message: 'Enter the authorization code from your browser.' };
    }
    if (trimmed.length > MAX_AUTH_CODE_LENGTH) {
      return { accepted: false, message: 'Authorization code is too long.' };
    }
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      return { accepted: false, message: 'Authorization code contains invalid characters.' };
    }
    if (!/^[^\s#]+#[^\s#]+$/.test(trimmed)) {
      return {
        accepted: false,
        message: 'Paste the full code#state authorization code shown by Claude.',
      };
    }

    const login = this.activeLogin;
    if (
      !login ||
      login.child.exitCode !== null ||
      !login.child.stdin ||
      login.child.stdin.destroyed ||
      login.child.stdin.writableEnded
    ) {
      return {
        accepted: false,
        message: 'No Claude sign-in is currently waiting for a code. Click Sign in to Claude again.',
      };
    }

    if (login.codeSubmitted) {
      return {
        accepted: false,
        message: 'Authorization code has already been submitted. Waiting for Claude to finish…',
      };
    }

    try {
      login.child.stdin.write(`${trimmed}\n`);
    } catch {
      return {
        accepted: false,
        message: 'Claude sign-in could not receive the code. Click Sign in to Claude again.',
      };
    }

    login.codeSubmitted = true;
    login.startCodeExchangeTimer(CLAUDE_LOGIN_CODE_EXCHANGE_TIMEOUT_MS);
    return { accepted: true };
  }

  dispose(): void {
    this.disposed = true;
    this.invalidateStatusCache();
    for (const cancelStatus of [...this.activeStatusCancels]) {
      cancelStatus();
    }
    this.activeStatusCancels.clear();
    if (this.activeLogin) {
      this.activeLogin.cancel();
    }
  }
}

export interface ClaudeAuthIpcTarget {
  claudeSignIn(): Promise<ClaudeSignInResult>;
  cancelClaudeSignIn(): Promise<boolean> | boolean;
  getActiveClaudeSignInUrl(): Promise<string | null> | string | null;
  submitClaudeAuthCode(code: unknown): Promise<ClaudeCodeSubmitResult>;
}

export interface ClaudeAuthIpcRegistrar {
  handle(
    channel: string,
    listener: (event: { senderFrame?: { url?: string } | null }, ...args: unknown[]) => unknown,
  ): void;
}

/**
 * Registers origin-guarded IPC handlers for in-app Claude authentication.
 * Validates `senderOrigin === trustedOrigin` before invoking `appCore` or writing to the OS clipboard.
 */
export function registerClaudeAuthIpc(deps: {
  ipcMain: ClaudeAuthIpcRegistrar;
  trustedOrigin: string;
  appCore: ClaudeAuthIpcTarget;
  writeClipboardText: (text: string) => void;
}): void {
  const handleGuarded = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    deps.ipcMain.handle(channel, async (event, ...args) => {
      let senderOrigin = '';
      try {
        senderOrigin = new URL(event?.senderFrame?.url ?? '').origin;
      } catch {
        senderOrigin = '';
      }
      if (!deps.trustedOrigin || senderOrigin !== deps.trustedOrigin) {
        throw new Error(`IPC ${channel} rejected: untrusted sender origin`);
      }
      return fn(...args);
    });
  };

  handleGuarded(IpcChannels.authClaudeSignin, () => deps.appCore.claudeSignIn());
  handleGuarded(IpcChannels.authClaudeCancel, async () => Boolean(await deps.appCore.cancelClaudeSignIn()));
  handleGuarded(IpcChannels.authClaudeCopyUrl, async () => {
    const url = await deps.appCore.getActiveClaudeSignInUrl();
    if (!url) {
      return false;
    }
    deps.writeClipboardText(url);
    return true;
  });
  handleGuarded(IpcChannels.authClaudeSubmitCode, (code: unknown) =>
    deps.appCore.submitClaudeAuthCode(code),
  );
}

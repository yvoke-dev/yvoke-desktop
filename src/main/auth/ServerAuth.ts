import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  AuthError,
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthorizeResponse,
  type Configuration,
  type ILoopbackClient,
} from '@azure/msal-node';
import type {
  AppSettings,
  AuthVerificationFailureReason,
  ServerSignInResult,
} from '../../shared/types';
import {
  hasErrorSourcePrefix,
  isNetworkError,
  sanitizeLogContent,
  tagAttributedError,
} from '../../shared/error';
import { log } from '../log';
import type { McpAuthProvider } from '../agent/McpConnection';

/** Token used while the server runs with APP_SECURITY_MOCK=true (any token accepted). */
export const DEV_TOKEN = 'dev-local-token';

/** Proactive token refresh threshold (5 minutes). */
export const EXPIRATION_BUFFER_MS = 5 * 60 * 1000;

/** Maximum time to wait for the browser loopback callback during interactive Entra sign-in. */
export const SERVER_SIGNIN_TIMEOUT_MS = 5 * 60 * 1_000;

const DEFAULT_SUCCESS_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Yvoke - Desktop</title></head>' +
  '<body><p>Signed in. You can close this window and return to Yvoke - Desktop.</p></body></html>';

const DEFAULT_ERROR_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Yvoke - Desktop</title></head>' +
  '<body><p>Sign-in did not complete. You can close this window and try again in Yvoke - Desktop.</p></body></html>';

/** Typed error raised when Entra silent acquisition requires explicit user sign-in. */
export class ServerAuthRequiredError extends Error {
  constructor(message = 'Authentication session expired or invalid. Please sign in again.') {
    super(tagAttributedError('Entra', message));
    this.name = 'ServerAuthRequiredError';
    Object.setPrototypeOf(this, ServerAuthRequiredError.prototype);
  }
}

/**
 * Typed error raised when Entra silent acquisition fails transiently (network outage, MSAL
 * timeout, Entra 5xx / 429) without invalidating the user's cached corporate account.
 */
export class ServerAuthTransientError extends Error {
  constructor(cause: unknown, message?: string) {
    super(tagAttributedError('Entra', message ?? cause), { cause });
    this.name = 'ServerAuthTransientError';
    Object.setPrototypeOf(this, ServerAuthTransientError.prototype);
  }
}

const INTERACTION_OR_GRANT_ERROR_CODES = new Set([
  'interaction_required',
  'login_required',
  'consent_required',
  'invalid_grant',
  'no_tokens_found',
  'no_account_in_silent_request',
  'no_account_found',
  'token_refresh_required',
  'refresh_token_expired',
  'bad_token',
  'interrupted_user',
  'native_account_unavailable',
  'ui_not_allowed',
]);

const NON_GRANT_ERROR_CODES = new Set([
  'invalid_request',
  'temporarily_unavailable',
  'service_unavailable',
  'server_error',
  'request_timeout',
]);

function readHttpStatus(obj: unknown): number | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const rec = obj as { status?: unknown; statusCode?: unknown };
  if (typeof rec.status === 'number' && Number.isFinite(rec.status)) return rec.status;
  if (typeof rec.statusCode === 'number' && Number.isFinite(rec.statusCode)) return rec.statusCode;
  return undefined;
}

function isInteractionOrGrantFailure(err: unknown): boolean {
  if (!err || isNetworkError(err)) {
    return false;
  }

  // First pass: if any node in the cause chain reports a 5xx or 429 HTTP status, it is transient.
  const seenStatus = new Set<unknown>();
  let statusCursor: unknown = err;
  while (statusCursor && !seenStatus.has(statusCursor)) {
    seenStatus.add(statusCursor);
    const status = readHttpStatus(statusCursor);
    if (status !== undefined && (status >= 500 || status === 429)) {
      return false;
    }
    statusCursor =
      typeof statusCursor === 'object' ? (statusCursor as { cause?: unknown }).cause : undefined;
  }

  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof InteractionRequiredAuthError || cursor instanceof ServerAuthRequiredError) {
      return true;
    }
    if (typeof cursor === 'object') {
      const rec = cursor as { errorCode?: unknown; name?: unknown; message?: unknown };
      const errorCode = typeof rec.errorCode === 'string' ? rec.errorCode.toLowerCase() : undefined;
      if (errorCode && INTERACTION_OR_GRANT_ERROR_CODES.has(errorCode)) {
        return true;
      }
      if (rec.name === 'InteractionRequiredAuthError') {
        return true;
      }
      const status = readHttpStatus(cursor);
      if (
        (status === 400 || status === 401) &&
        (!errorCode || !NON_GRANT_ERROR_CODES.has(errorCode))
      ) {
        return true;
      }
    }
    const msg =
      cursor instanceof Error
        ? cursor.message
        : typeof cursor === 'string'
          ? cursor
          : typeof cursor === 'object' && typeof (cursor as { message?: unknown }).message === 'string'
            ? (cursor as { message: string }).message
            : '';
    if (
      /InteractionRequiredAuthError|invalid_grant|interaction_required|login_required|consent_required|no_tokens_found|refresh_token_expired|interaction required/i.test(
        msg,
      )
    ) {
      return true;
    }
    cursor = typeof cursor === 'object' ? (cursor as { cause?: unknown }).cause : undefined;
  }

  return false;
}

/**
 * Single shared predicate classifying whether an error represents an actionable corporate Entra
 * sign-in failure (401 / expired grant) rather than a network outage, transient 5xx/429, or dev mode.
 *
 * Uses structural HTTP status inspection so `ServerAuth` never imports `SyncClient`.
 */
export function isServerAuthFailure(error: unknown, isEntraMode: boolean): boolean {
  if (
    !isEntraMode ||
    !error ||
    error instanceof ServerAuthTransientError ||
    isNetworkError(error)
  ) {
    return false;
  }
  if (error instanceof ServerAuthRequiredError) {
    return true;
  }
  // Claude ResultError carries its own `status` (e.g. 401 from Anthropic) — never a server auth failure.
  if (error instanceof Error && error.name === 'ResultError') {
    return false;
  }

  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const status = readHttpStatus(cursor);
    if (status === 401) {
      return true;
    }
    if (
      status !== undefined &&
      (status >= 500 || status === 429 || status === 403 || status === 404)
    ) {
      return false;
    }
    cursor = typeof cursor === 'object' ? (cursor as { cause?: unknown }).cause : undefined;
  }

  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  if (hasErrorSourcePrefix(msg, 'Entra')) {
    if (
      /\b(5\d{2}|429)\b|temporarily_unavailable|service_unavailable|server_error|timed?\s*out/i.test(
        msg,
      )
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/** Typed error raised when an in-flight interactive Entra sign-in is cancelled. */
export class SignInCancelledError extends Error {
  constructor(message = 'Sign-in cancelled.') {
    super(message);
    this.name = 'SignInCancelledError';
  }
}

class SignInTimeoutError extends Error {
  constructor() {
    super('Sign-in timed out. Please try again.');
    this.name = 'SignInTimeoutError';
  }
}

/**
 * Custom MSAL loopback HTTP server bound to 127.0.0.1:0 with cancellation, timeout,
 * non-settling stray/favicon/bare-root handling, and static non-reflecting HTML templates.
 */
export class CancellableLoopbackClient implements ILoopbackClient {
  private server: http.Server | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  private closed = false;
  private settled = false;
  private terminalError: Error | undefined;
  private resolveAuth: ((response: AuthorizeResponse) => void) | undefined;
  private rejectAuth: ((err: Error) => void) | undefined;

  constructor(private readonly timeoutMs: number = SERVER_SIGNIN_TIMEOUT_MS) {}

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private settleResolve(response: AuthorizeResponse): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimer();
    const resolve = this.resolveAuth;
    this.resolveAuth = undefined;
    this.rejectAuth = undefined;
    resolve?.(response);
  }

  private settleReject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (!this.terminalError) {
      this.terminalError = err;
    }
    this.clearTimer();
    const reject = this.rejectAuth;
    this.resolveAuth = undefined;
    this.rejectAuth = undefined;
    reject?.(err);
  }

  async listenForAuthCode(
    successTemplate?: string,
    errorTemplate?: string,
  ): Promise<AuthorizeResponse> {
    if (this.cancelled || this.closed) {
      throw new SignInCancelledError();
    }
    if (this.server) {
      throw new AuthError('loopback_server_already_exists', 'Loopback server already exists.');
    }

    const successHtml = successTemplate || DEFAULT_SUCCESS_HTML;
    const errorHtml = errorTemplate || DEFAULT_ERROR_HTML;

    return new Promise<AuthorizeResponse>((resolve, reject) => {
      this.resolveAuth = resolve;
      this.rejectAuth = reject;

      const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        const rawUrl = req.url ?? '';
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl, 'http://localhost');
        } catch {
          res.writeHead(400, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end('Bad Request');
          return;
        }

        if (parsedUrl.pathname === '/favicon.ico') {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }

        if (parsedUrl.pathname !== '/') {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end('Not Found');
          return;
        }

        const hasCode = parsedUrl.searchParams.has('code');
        const hasError = parsedUrl.searchParams.has('error');

        if (!hasCode && !hasError) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(successHtml);
          return;
        }

        const authCodeResponse = Object.fromEntries(
          parsedUrl.searchParams.entries(),
        ) as AuthorizeResponse;

        if (hasCode) {
          res.writeHead(302, {
            Location: '/',
            'Cache-Control': 'no-store',
          });
          res.end();
        } else {
          // Never interpolate query parameters into HTML (static template only).
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(errorHtml);
        }

        this.settleResolve(authCodeResponse);
      });

      this.server = server;

      server.on('error', (err: Error) => {
        this.settleReject(err);
        this.closeServer();
      });

      if (this.timeoutMs > 0) {
        this.timer = setTimeout(() => {
          this.settleReject(new SignInTimeoutError());
          this.closeServer();
        }, this.timeoutMs);
        this.timer.unref?.();
      }

      server.listen(0, '127.0.0.1');
    });
  }

  getRedirectUri(): string {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (this.cancelled || this.closed) {
      throw new SignInCancelledError();
    }
    if (!this.server || !this.server.listening) {
      throw new AuthError('no_loopback_server_exists', 'No loopback server exists yet.');
    }
    const address = this.server.address();
    if (!address || typeof address === 'string' || !address.port) {
      this.closeServer();
      throw new AuthError('invalid_loopback_address_type', 'Invalid loopback server address.');
    }
    return `http://localhost:${address.port}`;
  }

  cancel(): void {
    this.cancelled = true;
    this.settleReject(new SignInCancelledError());
    this.closeServer();
  }

  closeServer(): void {
    this.closed = true;
    this.clearTimer();
    this.settleReject(new SignInCancelledError());
    if (this.server) {
      const srv = this.server;
      this.server = undefined;
      try {
        srv.close();
      } catch {
        // ignore
      }
      try {
        srv.closeAllConnections?.();
      } catch {
        // ignore
      }
      try {
        srv.unref();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * `verifyToken`'s result, carrying the live bearer. It is deliberately NOT the shared
 * `LoginVerificationResult` the renderer sees: that type has no `token` field, so a bearer cannot
 * reach the renderer by a stray spread or an `ok`-branch shortcut. `token` is required here, which
 * also means the connection probe can take a plain `string` rather than an optional one.
 */
export type ServerTokenVerification =
  | { status: 'ok'; account?: string; token: string }
  | { status: AuthVerificationFailureReason; message: string; account?: string };

/** Why a silent acquisition gave up — a discriminant, not a sentence to re-parse. */
type SilentFailure = 'corrupt' | 'no-account' | 'expired';

class SilentTokenError extends Error {
  constructor(readonly reason: SilentFailure) {
    super(
      reason === 'corrupt'
        ? 'Token cache unreadable or corrupt.'
        : reason === 'no-account'
          ? 'No cached corporate account found.'
          : 'Authentication session expired or invalid. Please sign in again.',
    );
    this.name = 'SilentTokenError';
  }
}

/**
 * A cache that is absent and a cache that cannot be decrypted are different diagnoses — the first
 * asks the user to sign in, the second tells them their keystore entry is unusable. Collapsing
 * both to `null` made the second unrepresentable, so the state is named instead.
 */
export type CacheReadResult =
  | { state: 'empty' }
  | { state: 'unreadable' }
  | { state: 'ok'; data: string };

export interface TokenCachePersistence {
  read(): CacheReadResult;
  write(contents: string): void;
}

/** Encrypts the MSAL token cache at rest; `encrypt`/`decrypt` injected (Electron safeStorage). */
export function fileTokenCache(
  file: string,
  encrypt: (plain: string) => Buffer,
  decrypt: (cipher: Buffer) => string,
): TokenCachePersistence {
  return {
    read(): CacheReadResult {
      let cipher: Buffer;
      try {
        cipher = fs.readFileSync(file);
      } catch {
        // No file yet (first run, or after a sign-out) — nothing is wrong.
        return { state: 'empty' };
      }
      try {
        return { state: 'ok', data: decrypt(cipher) };
      } catch {
        // The file exists but will not decrypt: a rotated keystore key, a profile copied from
        // another machine, or a truncated write. Saying "no account" here sends the user to a
        // sign-in that cannot repair it.
        return { state: 'unreadable' };
      }
    },
    write(contents: string): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, encrypt(contents));
    },
  };
}

/**
 * Entra sign-in for the app (Req. 9): one corporate identity whose JWT authenticates
 * the Sync API and (post-M19 flip) the MCP connection. In 'dev' mode a static token is
 * sent instead — the server's mock decoder accepts any bearer.
 */
export class ServerAuth implements McpAuthProvider {
  private pca: PublicClientApplication | null = null;
  /** clientId+tenantId the cached pca was built with; rebuild when settings change. */
  private pcaKey: string | null = null;
  private account: AccountInfo | null = null;
  private cacheCorrupted = false;
  /** pcaKey the account was last hydrated for; `null` means "not hydrated yet". */
  private hydratedKey: string | null = null;
  /** In-memory cached token to avoid blocking synchronous disk I/O and decryption on every warm turn. */
  private cachedToken: {
    token: string;
    expiresAt: number;
    pcaKey: string;
    scope: string;
  } | null = null;
  /** Set by invalidate() so the next silent acquisition passes forceRefresh: true to MSAL. */
  private forceNextRefresh = false;
  private activeHydration: { key: string; promise: Promise<void> } | null = null;
  private activeSignIn: Promise<ServerSignInResult> | null = null;
  private activeLoopback: CancellableLoopbackClient | null = null;
  private cancelActiveAttempt: (() => void) | null = null;
  private signInGeneration = 0;
  private latestSignedInGen = 0;
  private signOutGeneration = 0;

  /** Invalidate in-memory token cache and force next MSAL acquisition to refresh from Entra. */
  invalidate(): void {
    this.cachedToken = null;
    this.forceNextRefresh = true;
  }

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly cache: TokenCachePersistence | null,
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly signInTimeoutMs: number = SERVER_SIGNIN_TIMEOUT_MS,
  ) {}

  /**
   * Populate `this.account` from the cache, at most once per Entra registration.
   *
   * Coalesced per `pcaKey` and generation-guarded against concurrent `signOut()` / settings
   * changes so concurrent `status()` + expired `getAccessToken()` or `signOut()` races can
   * never resurrect a cleared or signed-out account.
   */
  private hydrateAccount(): Promise<void> {
    if (this.isDevMode()) {
      return Promise.resolve();
    }
    const key = this.pcaKeyFor(this.getSettings());
    if (this.hydratedKey === key) {
      return Promise.resolve();
    }
    if (this.activeHydration && this.activeHydration.key === key) {
      return this.activeHydration.promise;
    }

    const startSignOutGen = this.signOutGeneration;
    const run = (async (): Promise<void> => {
      try {
        const pca = this.getPca();
        const accounts = await pca.getTokenCache().getAllAccounts();
        if (
          this.signOutGeneration !== startSignOutGen ||
          this.pcaKey !== key ||
          this.hydratedKey === key
        ) {
          return;
        }
        if (!this.cacheCorrupted) {
          this.hydratedKey = key;
        }
        if (accounts.length > 0) {
          this.account = accounts[0];
        }
      } catch {
        // Leave `hydratedKey` unset so a later call retries rather than caching the failure.
      }
    })();

    this.activeHydration = { key, promise: run };
    run
      .finally(() => {
        if (this.activeHydration?.promise === run) {
          this.activeHydration = null;
        }
      })
      .catch(() => {
        // Latch cleanup guard only.
      });

    return run;
  }

  private pcaKeyFor(settings: AppSettings): string {
    return `${settings.entra.clientId}|${settings.entra.tenantId}`;
  }

  private getPca(): PublicClientApplication {
    const settings = this.getSettings();
    const key = this.pcaKeyFor(settings);
    if (this.pca && this.pcaKey === key) {
      return this.pca;
    }
    this.hydratedKey = null;
    // Entra settings changed since the last build (or first build): rebuild the MSAL
    // app so it targets the current clientId/tenantId, and drop the stale account.
    this.account = null;
    this.cachedToken = null;
    {
      const config: Configuration = {
        auth: {
          clientId: settings.entra.clientId,
          authority: `https://login.microsoftonline.com/${settings.entra.tenantId || 'common'}`,
        },
        cache: this.cache
          ? {
              cachePlugin: {
                beforeCacheAccess: async (ctx) => {
                  const result = this.cache!.read();
                  if (result.state === 'unreadable') {
                    this.cacheCorrupted = true;
                    return;
                  }
                  try {
                    if (result.state === 'ok') ctx.tokenCache.deserialize(result.data);
                    this.cacheCorrupted = false;
                  } catch {
                    // Decrypted, but not MSAL's shape — corrupt in the same user-visible way.
                    this.cacheCorrupted = true;
                  }
                },
                afterCacheAccess: async (ctx) => {
                  if (ctx.cacheHasChanged) this.cache!.write(ctx.tokenCache.serialize());
                },
              },
            }
          : undefined,
      };
      this.pca = new PublicClientApplication(config);
      this.pcaKey = key;
    }
    return this.pca;
  }

  isDevMode(): boolean {
    return this.getSettings().serverAuthMode === 'dev';
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const startSignOutGen = this.signOutGeneration;
    try {
      if (this.isDevMode()) {
        return DEV_TOKEN;
      }

      const settings = this.getSettings();
      const currentKey = this.pcaKeyFor(settings);
      const currentScope = settings.entra.scope;
      const effectiveForceRefresh = forceRefresh || this.forceNextRefresh;
      this.forceNextRefresh = false;

      if (
        !effectiveForceRefresh &&
        this.cachedToken &&
        this.cachedToken.pcaKey === currentKey &&
        this.cachedToken.scope === currentScope
      ) {
        const remaining = this.cachedToken.expiresAt - Date.now();
        if (remaining > EXPIRATION_BUFFER_MS) {
          return this.cachedToken.token;
        }
      }

      await this.hydrateAccount();
      if (this.signOutGeneration !== startSignOutGen) {
        throw new ServerAuthRequiredError();
      }
      const scopes = [currentScope];
      const pca = this.getPca();
      const account = this.account;

      if (!account) {
        this.account = null;
        this.cachedToken = null;
        throw new ServerAuthRequiredError();
      }

      try {
        const silent = await pca.acquireTokenSilent({
          account,
          scopes,
          ...(effectiveForceRefresh ? { forceRefresh: true } : {}),
        });
        if (this.signOutGeneration !== startSignOutGen) {
          throw new ServerAuthRequiredError();
        }
        if (silent?.accessToken) {
          const expiresAt = silent.expiresOn ? silent.expiresOn.getTime() : 0;
          this.account = silent.account ?? account;
          this.cachedToken = {
            token: silent.accessToken,
            expiresAt,
            pcaKey: currentKey,
            scope: currentScope,
          };
          return silent.accessToken;
        }
      } catch (err) {
        if (err instanceof ServerAuthRequiredError || this.signOutGeneration !== startSignOutGen) {
          throw new ServerAuthRequiredError();
        }
        // If the silent refresh failed (e.g. transient network or Entra 5xx error), and refresh
        // was not forced, continue using a still-unexpired cached token instead of surfacing an error.
        if (
          !effectiveForceRefresh &&
          this.cachedToken &&
          this.cachedToken.pcaKey === currentKey &&
          this.cachedToken.scope === currentScope &&
          this.cachedToken.expiresAt > Date.now()
        ) {
          log(
            'auth',
            `Silent token refresh failed, falling back to valid cached token until ${new Date(
              this.cachedToken.expiresAt,
            ).toISOString()}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return this.cachedToken.token;
        }

        this.cachedToken = null;
        if (isInteractionOrGrantFailure(err)) {
          // Genuine expired/revoked grant: clear stale account and require explicit user sign-in.
          this.account = null;
          throw new ServerAuthRequiredError();
        }

        // Transient failure (network outage, MSAL timeout, Entra 5xx/429): preserve `this.account`
        // so temporary outages never claim signed-out.
        throw new ServerAuthTransientError(err);
      }

      this.account = null;
      this.cachedToken = null;
      throw new ServerAuthRequiredError();
    } catch (err) {
      if (err instanceof ServerAuthRequiredError || err instanceof ServerAuthTransientError) {
        throw err;
      }
      if (this.signOutGeneration === startSignOutGen) {
        this.cachedToken = null;
      }
      throw new Error(tagAttributedError('Entra', err), { cause: err });
    }
  }

  signIn(): Promise<ServerSignInResult> {
    if (this.isDevMode()) {
      return Promise.resolve({ status: 'signed_in', account: 'dev-mode (mock security)' });
    }
    if (this.activeSignIn) {
      return this.activeSignIn;
    }

    const myGen = ++this.signInGeneration;
    const startSignOutGen = this.signOutGeneration;
    let attemptCancelled = false;
    const loopback = new CancellableLoopbackClient(this.signInTimeoutMs);
    const markCancelled = (): void => {
      attemptCancelled = true;
      loopback.cancel();
    };
    this.activeLoopback = loopback;
    this.cancelActiveAttempt = markCancelled;

    const run = (async (): Promise<ServerSignInResult> => {
      const settings = this.getSettings();
      const currentKey = this.pcaKeyFor(settings);
      const currentScope = settings.entra.scope;
      const scopes = [currentScope];
      const pca = this.getPca();

      try {
        const interactive = await pca.acquireTokenInteractive({
          scopes,
          openBrowser: this.openBrowser,
          loopbackClient: loopback,
          successTemplate: DEFAULT_SUCCESS_HTML,
          errorTemplate: DEFAULT_ERROR_HTML,
        });

        const signOutWon = this.signOutGeneration !== startSignOutGen;
        const cancelled = attemptCancelled || this.signInGeneration !== myGen;
        if (signOutWon || cancelled) {
          const newerSignInWon = this.latestSignedInGen > myGen;
          if (interactive?.account) {
            const sameAsNewerActiveAccount =
              newerSignInWon &&
              this.account?.homeAccountId !== undefined &&
              this.account.homeAccountId === interactive.account.homeAccountId;
            if (!sameAsNewerActiveAccount) {
              try {
                await pca.getTokenCache().removeAccount(interactive.account);
              } catch {
                // Best-effort cleanup of raced account
              }
            }
          }
          if (!newerSignInWon) {
            this.account = null;
            this.cachedToken = null;
          }
          return { status: 'cancelled' };
        }

        const expiresAt = interactive.expiresOn ? interactive.expiresOn.getTime() : 0;
        this.latestSignedInGen = myGen;
        this.hydratedKey = currentKey;
        this.account = interactive.account;
        this.cachedToken = {
          token: interactive.accessToken,
          expiresAt,
          pcaKey: currentKey,
          scope: currentScope,
        };
        return {
          status: 'signed_in',
          ...(interactive.account?.username ? { account: interactive.account.username } : {}),
        };
      } catch (err) {
        const signOutWon = this.signOutGeneration !== startSignOutGen;
        const cancelled =
          attemptCancelled ||
          this.signInGeneration !== myGen ||
          err instanceof SignInCancelledError;
        if (signOutWon || cancelled) {
          return { status: 'cancelled' };
        }
        if (err instanceof SignInTimeoutError) {
          return { status: 'error', message: 'Sign-in timed out. Please try again.' };
        }
        const raw = err instanceof Error ? err.message : String(err);
        const safe = sanitizeLogContent(raw).trim();
        return {
          status: 'error',
          message: safe || 'Sign-in failed. Please try again.',
        };
      } finally {
        loopback.closeServer();
      }
    })();

    this.activeSignIn = run;
    run
      .finally(() => {
        if (this.activeSignIn === run) {
          this.activeSignIn = null;
        }
        if (this.activeLoopback === loopback) {
          this.activeLoopback = null;
        }
        if (this.cancelActiveAttempt === markCancelled) {
          this.cancelActiveAttempt = null;
        }
      })
      .catch(() => {
        // Latch cleanup guard only.
      });

    return run;
  }

  cancelSignIn(): boolean {
    if (!this.activeSignIn) {
      return false;
    }
    const cancelFn = this.cancelActiveAttempt;
    this.activeSignIn = null;
    this.activeLoopback = null;
    this.cancelActiveAttempt = null;
    this.signInGeneration += 1;
    cancelFn?.();
    return true;
  }

  async signOut(): Promise<void> {
    this.signOutGeneration += 1;
    this.cancelSignIn();
    this.account = null;
    this.cachedToken = null;
    if (this.isDevMode()) {
      return;
    }
    try {
      const pca = this.getPca();
      const cache = pca.getTokenCache();
      let accounts: AccountInfo[] = [];
      try {
        accounts = await cache.getAllAccounts();
      } catch {
        // Ignore unreadable/corrupt cache during sign-out
      }
      for (const acct of accounts) {
        await cache.removeAccount(acct);
      }
      this.account = null;
      this.cachedToken = null;
    } catch (err) {
      throw new Error(tagAttributedError('Entra', err));
    }
  }

  async status(): Promise<{ mode: 'dev' | 'entra'; signedIn: boolean; account?: string }> {
    if (this.isDevMode()) {
      return { mode: 'dev', signedIn: true, account: 'dev-mode (mock security)' };
    }
    await this.hydrateAccount();
    return { mode: 'entra', signedIn: this.account != null, account: this.account?.username };
  }

  async acquireTokenSilentOnly(): Promise<string> {
    if (this.isDevMode()) {
      return DEV_TOKEN;
    }
    const startSignOutGen = this.signOutGeneration;
    await this.hydrateAccount();
    if (this.signOutGeneration !== startSignOutGen) {
      throw new SilentTokenError('no-account');
    }
    const pca = this.getPca();
    const account = this.account ?? (await pca.getTokenCache().getAllAccounts())[0] ?? null;
    if (this.signOutGeneration !== startSignOutGen) {
      throw new SilentTokenError('no-account');
    }
    if (this.cacheCorrupted) {
      throw new SilentTokenError('corrupt');
    }
    if (!account) {
      throw new SilentTokenError('no-account');
    }
    const scopes = [this.getSettings().entra.scope];
    const silent = await pca.acquireTokenSilent({ account, scopes });
    if (this.signOutGeneration !== startSignOutGen) {
      throw new SilentTokenError('no-account');
    }
    if (!silent?.accessToken) {
      throw new SilentTokenError('expired');
    }
    this.account = silent.account ?? account;
    return silent.accessToken;
  }

  /**
   * Test the corporate token without ever opening a browser (spec chapter 5). The token rides on
   * the result so the caller can reuse it for the connection probe rather than acquiring a second
   * one — which is why this type is main-process-only and never crosses IPC.
   */
  async verifyToken(): Promise<ServerTokenVerification> {
    if (this.isDevMode()) {
      return { status: 'ok', account: 'dev-mode (mock security)', token: DEV_TOKEN };
    }

    try {
      const token = await this.acquireTokenSilentOnly();
      return { status: 'ok', account: this.account?.username, token };
    } catch (err) {
      if (this.cacheCorrupted) {
        return { status: 'missing', message: 'Token cache unreadable or corrupt.' };
      }
      // Being offline is not being signed out: 'expired' offers a Sign in button that cannot
      // work, and names the wrong cause. `getAccessToken` has always drawn this line; so must this.
      if (isNetworkError(err)) {
        return { status: 'unreachable', message: 'Server unreachable' };
      }
      if (err instanceof SilentTokenError && err.reason === 'no-account') {
        return { status: 'missing', message: 'No cached corporate account found.' };
      }
      if (
        (err instanceof SilentTokenError && err.reason === 'expired') ||
        isInteractionOrGrantFailure(err)
      ) {
        return {
          status: 'expired',
          message: 'Authentication session expired or invalid. Please sign in again.',
        };
      }
      const raw = err instanceof Error ? err.message : String(err);
      const safe = sanitizeLogContent(raw).trim();
      return {
        status: 'error',
        message: safe || 'Failed to verify corporate authentication.',
      };
    }
  }

  /** MCP header seam: pre-M19-flip the MCP endpoint is open and gets no header. */
  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }
}

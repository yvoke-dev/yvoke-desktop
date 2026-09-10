import fs from 'node:fs';
import path from 'node:path';
import { PublicClientApplication, type AccountInfo, type Configuration } from '@azure/msal-node';
import type { AuthVerificationFailureReason } from '../../shared/types';
import type { AppSettings } from '../../shared/types';
import { isNetworkError, tagAttributedError } from '../../shared/error';
import type { McpAuthProvider } from '../agent/McpConnection';

/** Token used while the server runs with APP_SECURITY_MOCK=true (any token accepted). */
export const DEV_TOKEN = 'dev-local-token';

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

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly cache: TokenCachePersistence | null,
    private readonly openBrowser: (url: string) => Promise<void>,
  ) {}

  /**
   * Populate `this.account` from the cache, at most once per Entra registration.
   *
   * This used to be a single promise built in the constructor, which made a *mutable* setting
   * (`serverAuthMode`, and the clientId/tenantId behind `pcaKey`) permanent at construction time:
   * a dev → entra switch left the account null for the life of the process, so the app reported
   * nobody signed in and `signOut()` silently did nothing. Hydrating lazily, keyed on the same
   * `pcaKey` that `getPca()` rebuilds on, keeps it correct across every runtime change.
   */
  private async hydrateAccount(): Promise<void> {
    if (this.isDevMode()) {
      return;
    }
    const key = this.pcaKeyFor(this.getSettings());
    if (this.hydratedKey === key && this.account) {
      return;
    }
    try {
      const pca = this.getPca();
      const accounts = await pca.getTokenCache().getAllAccounts();
      this.hydratedKey = key;
      if (accounts.length > 0) {
        this.account = accounts[0];
      }
    } catch {
      // Leave `hydratedKey` unset so a later call retries rather than caching the failure.
    }
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

  async getAccessToken(forceInteractive = false): Promise<string> {
    try {
      if (this.isDevMode()) {
        return DEV_TOKEN;
      }
      await this.hydrateAccount();
      const scopes = [this.getSettings().entra.scope];
      const pca = this.getPca();

      if (!forceInteractive) {
        let account: AccountInfo | null = null;
        try {
          account = this.account ?? (await pca.getTokenCache().getAllAccounts())[0] ?? null;
        } catch {
          // ignore
        }

        if (account) {
          try {
            const silent = await pca.acquireTokenSilent({ account, scopes });
            if (silent?.accessToken) {
              this.account = silent.account ?? account;
              return silent.accessToken;
            }
          } catch (err) {
            // The network being down is not a reason to prompt for a sign-in.
            if (isNetworkError(err)) {
              throw err;
            }

            // Silent token acquisition failed due to expired/invalid session.
            // Clear account status to display sign-in required in the UI, and automatically try interactive sign-in.
            this.account = null;
            try {
              const interactive = await pca.acquireTokenInteractive({
                scopes,
                openBrowser: this.openBrowser,
                successTemplate:
                  '<html><body>Signed in. You can close this window and return to Yvoke - Desktop.</body></html>',
              });
              this.account = interactive.account;
              return interactive.accessToken;
            } catch (interactiveErr) {
              throw new Error('Authentication session expired or invalid. Please sign in again.');
            }
          }
        }

        this.account = null;
        throw new Error('Authentication session expired or invalid. Please sign in again.');
      }

      const interactive = await pca.acquireTokenInteractive({
        scopes,
        openBrowser: this.openBrowser,
        successTemplate: '<html><body>Signed in. You can close this window and return to Yvoke - Desktop.</body></html>',
      });
      this.account = interactive.account;
      return interactive.accessToken;
    } catch (err) {
      throw new Error(tagAttributedError('Entra', err));
    }
  }

  async signIn(): Promise<string | undefined> {
    try {
      if (this.isDevMode()) {
        return 'dev-mode';
      }
      await this.getAccessToken(true);
      return this.account?.username;
    } catch (err) {
      throw new Error(tagAttributedError('Entra', err));
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.hydrateAccount();
      if (this.pca && this.account) {
        await this.pca.getTokenCache().removeAccount(this.account);
      }
      this.account = null;
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
    await this.hydrateAccount();
    const pca = this.getPca();
    const account = this.account ?? (await pca.getTokenCache().getAllAccounts())[0] ?? null;
    if (this.cacheCorrupted) {
      throw new SilentTokenError('corrupt');
    }
    if (!account) {
      throw new SilentTokenError('no-account');
    }
    const scopes = [this.getSettings().entra.scope];
    const silent = await pca.acquireTokenSilent({ account, scopes });
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
      return {
        status: 'expired',
        message: 'Authentication session expired or invalid. Please sign in again.',
      };
    }
  }

  /** MCP header seam: pre-M19-flip the MCP endpoint is open and gets no header. */
  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }
}

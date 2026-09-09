import fs from 'node:fs';
import path from 'node:path';
import { PublicClientApplication, type AccountInfo, type Configuration } from '@azure/msal-node';
import type { AppSettings, LoginVerificationResult } from '../../shared/types';
import { tagAttributedError } from '../../shared/error';
import type { McpAuthProvider } from '../agent/McpConnection';

/** Token used while the server runs with APP_SECURITY_MOCK=true (any token accepted). */
export const DEV_TOKEN = 'dev-local-token';

export interface TokenCachePersistence {
  read(): string | null;
  write(contents: string): void;
}

/** Encrypts the MSAL token cache at rest; `encrypt`/`decrypt` injected (Electron safeStorage). */
export function fileTokenCache(
  file: string,
  encrypt: (plain: string) => Buffer,
  decrypt: (cipher: Buffer) => string,
): TokenCachePersistence {
  return {
    read(): string | null {
      try {
        return decrypt(fs.readFileSync(file));
      } catch {
        return null;
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
  private readonly initializePromise: Promise<void>;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly cache: TokenCachePersistence | null,
    private readonly openBrowser: (url: string) => Promise<void>,
  ) {
    this.initializePromise = this.initializeAccount();
  }

  private async initializeAccount(): Promise<void> {
    if (this.isDevMode()) {
      return;
    }
    try {
      const pca = this.getPca();
      const accounts = await pca.getTokenCache().getAllAccounts();
      if (accounts.length > 0) {
        this.account = accounts[0];
      }
    } catch {
      // ignore
    }
  }

  private getPca(): PublicClientApplication {
    const settings = this.getSettings();
    const key = `${settings.entra.clientId}|${settings.entra.tenantId}`;
    if (this.pca && this.pcaKey === key) {
      return this.pca;
    }
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
                  try {
                    const data = this.cache!.read();
                    if (data) ctx.tokenCache.deserialize(data);
                    this.cacheCorrupted = false;
                  } catch (err) {
                    this.cacheCorrupted = true;
                    throw err;
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
      await this.initializePromise;
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
            const errorString = String(err);
            const isNetworkError =
              errorString.includes('ENOTFOUND') ||
              errorString.includes('ETIMEDOUT') ||
              errorString.includes('ECONNREFUSED') ||
              errorString.includes('EAI_AGAIN') ||
              errorString.includes('fetch failed');

            if (isNetworkError) {
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
      await this.initializePromise;
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
    await this.initializePromise;
    return { mode: 'entra', signedIn: this.account != null, account: this.account?.username };
  }

  async acquireTokenSilentOnly(): Promise<string> {
    if (this.isDevMode()) {
      return DEV_TOKEN;
    }
    await this.initializePromise;
    const pca = this.getPca();
    let account: AccountInfo | null = null;
    try {
      account = this.account ?? (await pca.getTokenCache().getAllAccounts())[0] ?? null;
    } catch (err) {
      if (this.cacheCorrupted) {
        throw new Error('Token cache unreadable or corrupt.');
      }
      throw err;
    }
    if (this.cacheCorrupted) {
      throw new Error('Token cache unreadable or corrupt.');
    }
    if (!account) {
      throw new Error('No cached corporate account found.');
    }
    const scopes = [this.getSettings().entra.scope];
    const silent = await pca.acquireTokenSilent({ account, scopes });
    if (!silent?.accessToken) {
      throw new Error('Authentication session expired or invalid. Please sign in again.');
    }
    this.account = silent.account ?? account;
    return silent.accessToken;
  }

  async verifyToken(forceInteractive = false): Promise<LoginVerificationResult> {
    if (this.isDevMode()) {
      return { status: 'ok', account: 'dev-mode (mock security)', token: DEV_TOKEN };
    }
    await this.initializePromise;

    try {
      const token = await this.acquireTokenSilentOnly();
      return {
        status: 'ok',
        account: this.account?.username,
        token,
      };
    } catch (err) {
      if (this.cacheCorrupted) {
        return { status: 'missing', message: 'Token cache unreadable or corrupt.' };
      }
      if (forceInteractive) {
        const scopes = [this.getSettings().entra.scope];
        try {
          const pca = this.getPca();
          const interactive = await pca.acquireTokenInteractive({
            scopes,
            openBrowser: this.openBrowser,
            successTemplate:
              '<html><body>Signed in. You can close this window and return to Yvoke - Desktop.</body></html>',
          });
          this.account = interactive.account;
          return {
            status: 'ok',
            account: interactive.account?.username,
            token: interactive.accessToken,
          };
        } catch {
          return {
            status: 'expired',
            message: 'Authentication session expired or invalid. Please sign in again.',
          };
        }
      }

      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No cached corporate account')) {
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

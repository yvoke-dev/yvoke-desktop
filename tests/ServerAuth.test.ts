import http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, type Configuration } from '@azure/msal-node';
import type { AppSettings } from '../src/shared/types';
import {
  CancellableLoopbackClient,
  EXPIRATION_BUFFER_MS,
  SERVER_SIGNIN_TIMEOUT_MS,
  ServerAuth,
  ServerAuthRequiredError,
  SignInCancelledError,
  type TokenCachePersistence,
} from '../src/main/auth/ServerAuth';

const mockGetAllAccounts = vi.fn();
const mockAcquireTokenSilent = vi.fn();
const mockAcquireTokenInteractive = vi.fn();
const mockRemoveAccount = vi.fn();

vi.mock('@azure/msal-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azure/msal-node')>();
  return {
    ...actual,
    PublicClientApplication: class {
      config: Configuration;
      constructor(config: Configuration) {
        this.config = config;
      }
      getTokenCache() {
        return {
          getAllAccounts: async () => {
            if (this.config.cache?.cachePlugin?.beforeCacheAccess) {
              await this.config.cache.cachePlugin.beforeCacheAccess({
                tokenCache: {
                  deserialize: vi.fn((data: string) => {
                    if (data === 'corrupted-data') {
                      throw new SyntaxError('Unexpected token in JSON');
                    }
                  }),
                  serialize: vi.fn(),
                },
              } as any);
            }
            return mockGetAllAccounts();
          },
          removeAccount: mockRemoveAccount,
        };
      }
      acquireTokenSilent(...args: any[]) {
        return mockAcquireTokenSilent(...args);
      }
      acquireTokenInteractive(...args: any[]) {
        return mockAcquireTokenInteractive(...args);
      }
    },
  };
});

function testSettings(mode: 'dev' | 'entra' = 'entra'): AppSettings {
  return {
    serverBaseUrl: 'https://server.example',
    mcpTransport: 'http',
    serverAuthMode: mode,
    entra: {
      tenantId: 'test-tenant-id',
      clientId: 'test-client-id',
      scope: 'api://test/.default',
    },
    models: ['sonnet'],
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'low',
    webSearch: { enabled: false, allowedDomains: [] },
    maxTurns: 10,
  };
}

describe('ServerAuth.verifyToken', () => {
  let openBrowserMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    openBrowserMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    mockGetAllAccounts.mockResolvedValue([]);
    mockAcquireTokenSilent.mockReset();
    mockAcquireTokenInteractive.mockReset();
    mockRemoveAccount.mockReset();
  });

  // Test 1.5: dev mode mock bypass
  it('Test 1.5: dev mode mock bypass returns ok without calling Entra or browser', async () => {
    const auth = new ServerAuth(() => testSettings('dev'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'ok',
      account: 'dev-mode (mock security)',
      token: 'dev-local-token',
    });
    expect(mockGetAllAccounts).not.toHaveBeenCalled();
    expect(mockAcquireTokenSilent).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  // Test 1.2: Entra 401 silent refresh failure - assert openBrowser NOT called
  it('Test 1.2: Entra 401 silent refresh failure returns expired and does NOT call openBrowser', async () => {
    const cachedAccount = {
      homeAccountId: 'home-1',
      environment: 'login.microsoftonline.com',
      tenantId: 'test-tenant-id',
      username: 'corp-user@corp.example',
      localAccountId: 'local-1',
    };
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockRejectedValue(new Error('InteractionRequiredAuthError: 401 session expired'));

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'expired',
      message: 'Authentication session expired or invalid. Please sign in again.',
    });
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  // Test 1.4: corrupt token cache recovery
  it('Test 1.4: corrupt token cache recovery returns missing with unreadable/corrupt message', async () => {
    const corruptCache: TokenCachePersistence = {
      read: () => ({ state: 'unreadable' }),
      write: () => {},
    };

    const auth = new ServerAuth(() => testSettings('entra'), corruptCache, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'missing',
      message: 'Token cache unreadable or corrupt.',
    });
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('Test 1.4b: corrupt token cache with invalid serialized data returns missing with corrupt message', async () => {
    const corruptCache: TokenCachePersistence = {
      read: () => ({ state: 'ok', data: 'corrupted-data' }),
      write: () => {},
    };

    const auth = new ServerAuth(() => testSettings('entra'), corruptCache, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'missing',
      message: 'Token cache unreadable or corrupt.',
    });
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('returns missing when no cached corporate account is found', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'missing',
      message: 'No cached corporate account found.',
    });
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('returns ok with username when silent token acquisition succeeds', async () => {
    const cachedAccount = {
      homeAccountId: 'home-1',
      environment: 'login.microsoftonline.com',
      tenantId: 'test-tenant-id',
      username: 'corp-user@corp.example',
      localAccountId: 'local-1',
    };
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockResolvedValue({
      accessToken: 'valid-token-123',
      account: cachedAccount,
    });

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'ok',
      account: 'corp-user@corp.example',
      token: 'valid-token-123',
    });
    expect(mockAcquireTokenSilent).toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  // verifyToken is silent by contract (spec chapter 5). Interactive recovery is the inline
  // Sign in button's job, which goes through signIn() -> getAccessToken(true).
  it('never opens a browser, even when silent acquisition fails', async () => {
    const cachedAccount = {
      homeAccountId: 'home-1',
      environment: 'login.microsoftonline.com',
      tenantId: 'test-tenant-id',
      username: 'corp-user@corp.example',
      localAccountId: 'local-1',
    };
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockRejectedValue(new Error('Interaction required'));

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({
      status: 'expired',
      message: 'Authentication session expired or invalid. Please sign in again.',
    });
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('still reaches Entra interactively through signIn()', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    mockAcquireTokenInteractive.mockResolvedValue({
      accessToken: 'fresh-interactive-token',
      account: { username: 'corp-user@corp.example' },
    });

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    await expect(auth.signIn()).resolves.toEqual({
      status: 'signed_in',
      account: 'corp-user@corp.example',
    });
    expect(mockAcquireTokenInteractive).toHaveBeenCalled();
  });

  it('self-heals cacheCorrupted flag when subsequent cache read succeeds', async () => {
    let fail = true;
    const healingCache: TokenCachePersistence = {
      read: () => (fail ? { state: 'unreadable' } : { state: 'empty' }),
      write: () => {},
    };
    const auth = new ServerAuth(() => testSettings('entra'), healingCache, openBrowserMock);
    const firstResult = await auth.verifyToken();
    expect(firstResult).toEqual({
      status: 'missing',
      message: 'Token cache unreadable or corrupt.',
    });

    fail = false;
    mockGetAllAccounts.mockResolvedValue([]);
    const secondResult = await auth.verifyToken();
    expect(secondResult).toEqual({
      status: 'missing',
      message: 'No cached corporate account found.',
    });
  });
});

describe('ServerAuth.acquireTokenSilentOnly', () => {
  let openBrowserMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    openBrowserMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    mockGetAllAccounts.mockResolvedValue([]);
    mockAcquireTokenSilent.mockReset();
    mockAcquireTokenInteractive.mockReset();
    mockRemoveAccount.mockReset();
  });

  it('throws without calling openBrowser on expired session', async () => {
    const cachedAccount = {
      homeAccountId: 'home-1',
      environment: 'login.microsoftonline.com',
      tenantId: 'test-tenant-id',
      username: 'corp-user@corp.example',
      localAccountId: 'local-1',
    };
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockRejectedValue(new Error('InteractionRequiredAuthError: session expired'));

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    await expect(auth.acquireTokenSilentOnly()).rejects.toThrow();
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });
});

describe('ServerAuth review regressions', () => {
  let openBrowserMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  const cachedAccount = {
    homeAccountId: 'home-1',
    environment: 'login.microsoftonline.com',
    tenantId: 'test-tenant-id',
    username: 'corp-user@corp.example',
    localAccountId: 'local-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openBrowserMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    mockGetAllAccounts.mockResolvedValue([]);
    mockAcquireTokenSilent.mockReset();
    mockAcquireTokenInteractive.mockReset();
    mockRemoveAccount.mockReset();
  });

  // Being offline is not the same as being signed out. Reporting it as 'expired' offers a
  // Sign in button that cannot work — the exact mis-diagnosis spec/05 lists as a Limit.
  it.each([
    ['fetch failed'],
    ['getaddrinfo ENOTFOUND login.microsoftonline.com'],
    ['connect ECONNREFUSED 10.0.0.1:443'],
    ['connect ETIMEDOUT'],
    ['getaddrinfo EAI_AGAIN login.microsoftonline.com'],
  ])('reports a network failure (%s) as unreachable, not expired', async (msg) => {
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockRejectedValue(new Error(msg));

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result.status).toBe('unreachable');
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  // serverAuthMode is a runtime setting but the account used to be hydrated once, in the
  // constructor. Switching dev -> entra must not leave the app claiming nobody is signed in.
  it('hydrates the cached account after a runtime dev -> entra switch', async () => {
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    let mode: 'dev' | 'entra' = 'dev';
    const auth = new ServerAuth(() => testSettings(mode), null, openBrowserMock);

    expect(await auth.status()).toEqual({
      mode: 'dev',
      signedIn: true,
      account: 'dev-mode (mock security)',
    });

    mode = 'entra';
    expect(await auth.status()).toEqual({
      mode: 'entra',
      signedIn: true,
      account: 'corp-user@corp.example',
    });
  });

  it('signs out the cached account after a runtime dev -> entra switch', async () => {
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    let mode: 'dev' | 'entra' = 'dev';
    const auth = new ServerAuth(() => testSettings(mode), null, openBrowserMock);

    mode = 'entra';
    await auth.signOut();

    expect(mockRemoveAccount).toHaveBeenCalledWith(cachedAccount);
  });

  // The shipped fileTokenCache swallowed every read error and returned null, so the corrupt
  // -cache diagnosis could never reach a real user: a re-keyed keystore read as "no account".
  it('reports an unreadable cache as corrupt, not as an empty one', async () => {
    const unreadable: TokenCachePersistence = {
      read: () => ({ state: 'unreadable' }),
      write: () => {},
    };
    const auth = new ServerAuth(() => testSettings('entra'), unreadable, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({ status: 'missing', message: 'Token cache unreadable or corrupt.' });
  });

  it('reports a genuinely empty cache as a missing account', async () => {
    const empty: TokenCachePersistence = { read: () => ({ state: 'empty' }), write: () => {} };
    const auth = new ServerAuth(() => testSettings('entra'), empty, openBrowserMock);
    const result = await auth.verifyToken();

    expect(result).toEqual({ status: 'missing', message: 'No cached corporate account found.' });
  });
});

describe('ServerAuth proactive token refresh buffer & resilient offline fallback', () => {
  let openBrowserMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  const cachedAccount = {
    homeAccountId: 'home-1',
    environment: 'login.microsoftonline.com',
    tenantId: 'test-tenant-id',
    username: 'corp-user@corp.example',
    localAccountId: 'local-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openBrowserMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockReset();
    mockAcquireTokenInteractive.mockReset();
    mockRemoveAccount.mockReset();
  });

  it('exports EXPIRATION_BUFFER_MS equal to 5 minutes', () => {
    expect(EXPIRATION_BUFFER_MS).toBe(5 * 60 * 1000);
  });

  it('1. Clock boundary: token expiring at now + 301s reuses in-memory cache without MSAL call, at now + 299s calls acquireTokenSilent', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // Acquire token with 301s remaining (> 5m buffer)
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-301',
      expiresOn: new Date(Date.now() + 301 * 1000),
      account: cachedAccount,
    });
    const token1 = await auth.getAccessToken();
    expect(token1).toBe('token-301');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    // Second call within buffer: returns cached token directly without calling MSAL
    const token2 = await auth.getAccessToken();
    expect(token2).toBe('token-301');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    // When token has <= 300s remaining (299s): in-memory cache is bypassed and MSAL is called
    (auth as any).cachedToken.expiresAt = Date.now() + 299 * 1000;
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-299-refreshed',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    const token3 = await auth.getAccessToken();
    expect(token3).toBe('token-299-refreshed');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
  });

  it('2. Settings changes bypass cached token even if unexpired', async () => {
    let settings = testSettings('entra');
    const auth = new ServerAuth(() => settings, null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-tenant-1',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-tenant-1');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    // Change scope
    settings = {
      ...settings,
      entra: { ...settings.entra, scope: 'api://different-scope/.default' },
    };
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-scope-2',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-scope-2');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(mockAcquireTokenSilent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scopes: ['api://different-scope/.default'],
      }),
    );

    // Change clientId
    settings = {
      ...settings,
      entra: { ...settings.entra, clientId: 'new-client-id' },
    };
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-client-3',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-client-3');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(3);
  });

  it('3. invalidate() clears cached token and forces acquireTokenSilent with forceRefresh: true', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'initial-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('initial-token');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    auth.invalidate();

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'refreshed-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    expect(await auth.getAccessToken()).toBe('refreshed-token');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(mockAcquireTokenSilent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        forceRefresh: true,
      }),
    );
  });

  it('4a. Silent refresh failure falls back to valid unexpired cached token without interactive sign-in', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // Initially obtain a token valid for 4 minutes (< 5m buffer, so next call attempts refresh)
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'cached-token-4m',
      expiresOn: new Date(Date.now() + 240 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('cached-token-4m');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    // On second call (inside 5m buffer), MSAL attempts silent refresh and fails with network error
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('fetch failed'));

    // It should catch the error and return the still-valid cached token
    const token = await auth.getAccessToken();
    expect(token).toBe('cached-token-4m');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('4b. Silent refresh failure with non-network error falls back to valid unexpired cached token without interactive popup', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'cached-token-unexpired',
      expiresOn: new Date(Date.now() + 200 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('cached-token-unexpired');

    // Non-network error during silent refresh (e.g. transient 500 from Entra)
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: transient error'));

    const token = await auth.getAccessToken();
    expect(token).toBe('cached-token-unexpired');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('4c. Silent refresh failure when cached token is already expired rethrows network error', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // Mock already expired token
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'expired-token',
      expiresOn: new Date(Date.now() - 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('expired-token');

    // Next call tries silent refresh and hits network error
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(auth.getAccessToken()).rejects.toThrow(/fetch failed/);
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('4d. Silent refresh failure when cached token is already expired throws ServerAuthRequiredError without opening browser', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'expired-token',
      expiresOn: new Date(Date.now() - 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('expired-token');

    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: Session expired'));

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('4e. Invalidation prevents fallback to rejected token on subsequent failure and throws ServerAuthRequiredError without interactive popup', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'rejected-token',
      expiresOn: new Date(Date.now() + 240 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('rejected-token');

    // Explicitly invalidated (e.g. after MCP 401)
    auth.invalidate();

    // Next silent call fails -> must NOT fall back to rejected-token and must NOT pop browser
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: Revoked'));

    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
  });

  it('5. Malformed/NaN expiresOn: null, undefined, and invalid Date handled safely without crash', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // null
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-null-expiry',
      expiresOn: null,
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-null-expiry');

    auth.invalidate();
    mockAcquireTokenSilent.mockReset();

    // undefined
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-undef-expiry',
      expiresOn: undefined,
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-undef-expiry');

    auth.invalidate();
    mockAcquireTokenSilent.mockReset();

    // Invalid Date
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-nan-expiry',
      expiresOn: new Date('invalid'),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-nan-expiry');
  });
});

function httpRequest(
  url: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body,
        });
      });
    });
    req.on('error', reject);
  });
}

async function waitForRedirectUri(client: CancellableLoopbackClient): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      return client.getRedirectUri();
    } catch (err) {
      if (err instanceof AuthError && err.errorCode === 'no_loopback_server_exists') {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Timed out waiting for loopback server to listen');
}

describe('CancellableLoopbackClient real ephemeral HTTP loopback', () => {
  it('exports SERVER_SIGNIN_TIMEOUT_MS equal to 5 minutes', () => {
    expect(SERVER_SIGNIN_TIMEOUT_MS).toBe(5 * 60 * 1_000);
  });

  it('throws AuthError("no_loopback_server_exists") before listening and SignInCancelledError after cancel()', async () => {
    const client = new CancellableLoopbackClient(10_000);
    try {
      client.getRedirectUri();
      expect.fail('Expected getRedirectUri() to throw before listen');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).errorCode).toBe('no_loopback_server_exists');
    }

    const listenPromise = client.listenForAuthCode();
    client.cancel();

    await expect(listenPromise).rejects.toBeInstanceOf(SignInCancelledError);
    expect(() => client.getRedirectUri()).toThrow(SignInCancelledError);
    // closeServer() is idempotent
    expect(() => client.closeServer()).not.toThrow();
    expect(() => client.closeServer()).not.toThrow();
  });

  it('binds 127.0.0.1:0, returns http://localhost:<port>, ignores /favicon.ico (204), stray paths (404), and bare GET / (200), and resolves full query params on callback with 302 redirect', async () => {
    const client = new CancellableLoopbackClient(10_000);
    const listenPromise = client.listenForAuthCode(
      '<html><body>Custom OK</body></html>',
      '<html><body>Custom ERR</body></html>',
    );
    let settled = false;
    void listenPromise.then(() => {
      settled = true;
    });

    try {
      const redirectUri = await waitForRedirectUri(client);
      expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
      const port = Number(new URL(redirectUri).port);
      const base = `http://127.0.0.1:${port}`;

      // 1. /favicon.ico -> 204, non-settling
      const fav = await httpRequest(`${base}/favicon.ico`);
      expect(fav.statusCode).toBe(204);
      expect(settled).toBe(false);

      // 2. Stray path -> 404, non-settling
      const stray = await httpRequest(`${base}/random-probe`);
      expect(stray.statusCode).toBe(404);
      expect(settled).toBe(false);

      // 3. Bare GET / -> 200 static successTemplate, non-settling
      const bare = await httpRequest(`${base}/`);
      expect(bare.statusCode).toBe(200);
      expect(bare.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(bare.headers['cache-control']).toBe('no-store');
      expect(bare.body).toBe('<html><body>Custom OK</body></html>');
      expect(settled).toBe(false);

      // 4. Auth callback with code + client_info + state -> 302 Location: / and settles with all params
      const cb = await httpRequest(
        `${base}/?code=AUTH_CODE_123&state=STATE_XYZ&client_info=eyJ1aWQiOiIxIn0`,
      );
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('/');
      expect(cb.headers['cache-control']).toBe('no-store');

      const response = await listenPromise;
      expect(response).toEqual({
        code: 'AUTH_CODE_123',
        state: 'STATE_XYZ',
        client_info: 'eyJ1aWQiOiIxIn0',
      });

      // Server remains open until MSAL calls closeServer() so browser can follow 302 -> GET /
      const afterRedirect = await httpRequest(`${base}/`);
      expect(afterRedirect.statusCode).toBe(200);
      expect(afterRedirect.body).toBe('<html><body>Custom OK</body></html>');
    } finally {
      client.closeServer();
    }
  });

  it('resolves error query params (error, error_description, suberror) and NEVER reflects XSS query params into HTML', async () => {
    const client = new CancellableLoopbackClient(10_000);
    const listenPromise = client.listenForAuthCode();

    try {
      const redirectUri = await waitForRedirectUri(client);
      const port = Number(new URL(redirectUri).port);
      const xssPayload = '<script>alert("xss")</script>';
      const cb = await httpRequest(
        `http://127.0.0.1:${port}/?error=access_denied&error_description=${encodeURIComponent(xssPayload)}&suberror=consent_required`,
      );

      expect(cb.statusCode).toBe(200);
      expect(cb.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(cb.headers['cache-control']).toBe('no-store');
      expect(cb.body).not.toContain('<script>');
      expect(cb.body).not.toContain('alert("xss")');
      expect(cb.body).not.toContain('access_denied');
      expect(cb.body).not.toContain('consent_required');

      const response = await listenPromise;
      expect(response).toEqual({
        error: 'access_denied',
        error_description: xssPayload,
        suberror: 'consent_required',
      });
    } finally {
      client.closeServer();
    }
  });

  it('rejects cleanly on bind/server error without crashing process and preserves underlying error/timeout in getRedirectUri()', async () => {
    // 1. Timeout rejection: getRedirectUri() must throw the timeout error (NOT SignInCancelledError)
    const timeoutClient = new CancellableLoopbackClient(40);
    await expect(timeoutClient.listenForAuthCode()).rejects.toThrow(/timed out/i);
    try {
      timeoutClient.getRedirectUri();
      expect.fail('Expected getRedirectUri() to throw timeout error');
    } catch (err) {
      expect(err).not.toBeInstanceOf(SignInCancelledError);
      expect((err as Error).message).toMatch(/timed out/i);
    }

    // 2. Pre-listen bind/server error event: rejects promise AND getRedirectUri() throws bind error (NOT SignInCancelledError)
    const errClient = new CancellableLoopbackClient(10_000);
    const listenPromise = errClient.listenForAuthCode();
    const internalServer = (errClient as unknown as { server?: http.Server }).server;
    expect(internalServer).toBeDefined();
    internalServer!.emit('error', Object.assign(new Error('bind EADDRINUSE'), { code: 'EADDRINUSE' }));

    await expect(listenPromise).rejects.toThrow(/EADDRINUSE/);
    try {
      errClient.getRedirectUri();
      expect.fail('Expected getRedirectUri() to throw bind error');
    } catch (err) {
      expect(err).not.toBeInstanceOf(SignInCancelledError);
      expect((err as Error).message).toMatch(/EADDRINUSE/);
    }
    errClient.closeServer();
  });
});

describe('ServerAuth zero auto-popups, hydrateAccount non-resurrection, single-flight signIn & race safety', () => {
  let openBrowserMock: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;

  const cachedAccount = {
    homeAccountId: 'home-1',
    environment: 'login.microsoftonline.com',
    tenantId: 'test-tenant-id',
    username: 'corp-user@corp.example',
    localAccountId: 'local-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openBrowserMock = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockReset();
    mockAcquireTokenInteractive.mockReset();
    mockRemoveAccount.mockReset();
  });

  it('ServerAuthRequiredError applies single Entra: prefix without double-prefixing', () => {
    const errDefault = new ServerAuthRequiredError();
    expect(errDefault).toBeInstanceOf(ServerAuthRequiredError);
    expect(errDefault.message).toMatch(/^Entra: /);
    expect(errDefault.message).not.toMatch(/^Entra: Entra:/);

    const errAlready = new ServerAuthRequiredError('Entra: Already prefixed');
    expect(errAlready.message).toBe('Entra: Already prefixed');
  });

  it('getAccessToken() never calls acquireTokenInteractive when account is missing or silent fails, preserves ServerAuthRequiredError prototype, and does NOT resurrect cleared account', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: refresh token expired'));
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // First call: hydrates cachedAccount, silent refresh fails -> clears account & throws ServerAuthRequiredError
    await expect(auth.getAccessToken()).rejects.toSatisfy((err: unknown) => {
      return err instanceof ServerAuthRequiredError && err.message.startsWith('Entra: ');
    });
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();

    // Even though token cache still has [cachedAccount] on disk, status() & next getAccessToken() must NOT resurrect it!
    expect(await auth.status()).toEqual({ mode: 'entra', signedIn: false, account: undefined });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(ServerAuthRequiredError);
    // getAllAccounts was called only ONCE (not re-queried after hydration for the same key)
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
  });

  it('getAccessToken(true) blocks stale unexpired cache fallback and passes forceRefresh: true to MSAL', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'unexpired-token',
      expiresOn: new Date(Date.now() + 200 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('unexpired-token');

    // Forced silent refresh (e.g., after SyncClient 401): even though cached token is unexpired, failure must NOT return it
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: 401 revoked'));
    await expect(auth.getAccessToken(true)).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(mockAcquireTokenSilent).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('offline network failure in getAccessToken() clears cachedToken, preserves account, and throws Entra-attributed network error (not ServerAuthRequiredError)', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const netErr = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    mockAcquireTokenSilent.mockRejectedValueOnce(netErr);

    await expect(auth.getAccessToken()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof Error &&
        !(err instanceof ServerAuthRequiredError) &&
        err.message.startsWith('Entra: ') &&
        err.message.includes('ECONNREFUSED')
      );
    });

    // Account MUST remain preserved while offline so UI does not claim signed-out
    expect(await auth.status()).toEqual({
      mode: 'entra',
      signedIn: true,
      account: 'corp-user@corp.example',
    });
  });

  it('dev mode signIn() resolves immediately with dev-mode account without MSAL', async () => {
    const auth = new ServerAuth(() => testSettings('dev'), null, openBrowserMock);
    await expect(auth.signIn()).resolves.toEqual({
      status: 'signed_in',
      account: 'dev-mode (mock security)',
    });
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('coalesces concurrent signIn() calls into a single interactive attempt and passes CancellableLoopbackClient', async () => {
    let resolveInteractive!: (val: unknown) => void;
    mockAcquireTokenInteractive.mockImplementationOnce(
      (req: { loopbackClient?: unknown }) =>
        new Promise((resolve) => {
          expect(req.loopbackClient).toBeInstanceOf(CancellableLoopbackClient);
          resolveInteractive = resolve;
        }),
    );

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const p1 = auth.signIn();
    const p2 = auth.signIn();
    expect(p1).toBe(p2);
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);

    resolveInteractive({
      accessToken: 'tok-fresh',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ status: 'signed_in', account: 'corp-user@corp.example' });
    expect(r2).toEqual(r1);
    expect(await auth.status()).toEqual({
      mode: 'entra',
      signedIn: true,
      account: 'corp-user@corp.example',
    });
  });

  it('cancelSignIn() returns false when idle, true then false when active, removes raced cached account from MSAL cache, and allows immediate follow-up signIn() without late clobber', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    expect(auth.cancelSignIn()).toBe(false);

    // Part 1: cancelSignIn() while acquireTokenByCode() is in flight removes raced account from cache
    let resolveLate1!: (val: unknown) => void;
    mockAcquireTokenInteractive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLate1 = resolve;
        }),
    );

    const signIn1 = auth.signIn();
    expect(auth.cancelSignIn()).toBe(true);
    // Second cancelSignIn() must immediately return false (detached)
    expect(auth.cancelSignIn()).toBe(false);

    resolveLate1({
      accessToken: 'late-token-1',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    await expect(signIn1).resolves.toEqual({ status: 'cancelled' });
    expect(mockRemoveAccount).toHaveBeenCalledWith(cachedAccount);
    expect((auth as unknown as { account: unknown }).account).toBeNull();
    expect((auth as unknown as { cachedToken: unknown }).cachedToken).toBeNull();

    // Part 2: immediate follow-up signIn() after cancelSignIn() starts a fresh attempt and is NOT clobbered when cancelled attempt settles late
    mockRemoveAccount.mockClear();
    const secondAccount = {
      ...cachedAccount,
      homeAccountId: 'home-2',
      username: 'second-user@corp.example',
    };
    let resolveCancelledAttempt!: (val: unknown) => void;
    let resolveFreshAttempt!: (val: unknown) => void;
    mockAcquireTokenInteractive
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCancelledAttempt = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFreshAttempt = resolve;
          }),
      );

    const cancelledRun = auth.signIn();
    expect(auth.cancelSignIn()).toBe(true);
    expect(auth.cancelSignIn()).toBe(false);

    // Immediately start fresh sign-in while cancelled attempt is still unresolved
    const freshRun = auth.signIn();
    expect(freshRun).not.toBe(cancelledRun);
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(3);

    // Fresh attempt succeeds first
    resolveFreshAttempt({
      accessToken: 'fresh-token-2',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: secondAccount,
    });
    await expect(freshRun).resolves.toEqual({
      status: 'signed_in',
      account: 'second-user@corp.example',
    });

    // Now the earlier cancelled attempt settles late — MUST NOT clobber secondAccount or fresh-token-2!
    resolveCancelledAttempt({
      accessToken: 'stale-cancelled-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    await expect(cancelledRun).resolves.toEqual({ status: 'cancelled' });
    // Stale different account removed, while fresh account & token remain intact
    expect(mockRemoveAccount).toHaveBeenCalledWith(cachedAccount);
    expect(await auth.status()).toEqual({
      mode: 'entra',
      signedIn: true,
      account: 'second-user@corp.example',
    });
    expect(await auth.getAccessToken()).toBe('fresh-token-2');

    // Part 3: if a cancelled attempt resolves late with the SAME homeAccountId as a newer active sign-in, do NOT remove the newer account from cache
    mockRemoveAccount.mockClear();
    let resolveCancelledSame!: (val: unknown) => void;
    let resolveFreshSame!: (val: unknown) => void;
    mockAcquireTokenInteractive
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCancelledSame = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFreshSame = resolve;
          }),
      );

    const authSame = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const cancelledSame = authSame.signIn();
    expect(authSame.cancelSignIn()).toBe(true);
    const freshSame = authSame.signIn();
    resolveFreshSame({
      accessToken: 'fresh-same-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    await expect(freshSame).resolves.toEqual({
      status: 'signed_in',
      account: 'corp-user@corp.example',
    });
    resolveCancelledSame({
      accessToken: 'stale-same-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });
    await expect(cancelledSame).resolves.toEqual({ status: 'cancelled' });
    expect(mockRemoveAccount).not.toHaveBeenCalled();
    expect(await authSame.getAccessToken()).toBe('fresh-same-token');
  });

  it('guards concurrent hydrateAccount() / getAccessToken() / acquireTokenSilentOnly() / signOut() races and purges expired cached accounts on signOut()', async () => {
    // (a) Concurrent status() + expired getAccessToken() does NOT resurrect the expired account
    let resolveAccounts!: (accounts: unknown[]) => void;
    mockGetAllAccounts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAccounts = resolve;
        }),
    );
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: expired'));

    const authA = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const tokenPromise = authA.getAccessToken();
    const statusPromise = authA.status();

    // Only one coalesced getAllAccounts() call should have fired
    expect(mockGetAllAccounts).toHaveBeenCalledTimes(1);
    resolveAccounts([cachedAccount]);

    await expect(tokenPromise).rejects.toBeInstanceOf(ServerAuthRequiredError);
    await statusPromise;
    expect(await authA.status()).toEqual({ mode: 'entra', signedIn: false, account: undefined });

    // (c) signOut() after expiry still calls removeAccount on cached accounts even though this.account was cleared to null
    mockGetAllAccounts.mockResolvedValueOnce([cachedAccount]);
    await authA.signOut();
    expect(mockRemoveAccount).toHaveBeenCalledWith(cachedAccount);

    // (b) signOut() racing an in-flight acquireTokenSilent does NOT repopulate this.account or this.cachedToken
    mockRemoveAccount.mockClear();
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    let resolveSilent!: (val: unknown) => void;
    let enteredSilent!: () => void;
    const silentEntered = new Promise<void>((r) => {
      enteredSilent = r;
    });
    mockAcquireTokenSilent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSilent = resolve;
          enteredSilent();
        }),
    );

    const authB = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const inflightToken = authB.getAccessToken();
    await silentEntered;

    await authB.signOut();

    // In-flight acquireTokenSilent now resolves after signOut()
    resolveSilent({
      accessToken: 'stale-post-signout-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    await expect(inflightToken).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect((authB as unknown as { account: unknown }).account).toBeNull();
    expect((authB as unknown as { cachedToken: unknown }).cachedToken).toBeNull();
    expect(await authB.status()).toEqual({ mode: 'entra', signedIn: false, account: undefined });

    // (d) signOut() racing an in-flight acquireTokenSilentOnly() throws no-account and does NOT repopulate this.account
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    let resolveSilentOnly!: (val: unknown) => void;
    let enteredSilentOnly!: () => void;
    const silentOnlyEntered = new Promise<void>((r) => {
      enteredSilentOnly = r;
    });
    mockAcquireTokenSilent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSilentOnly = resolve;
          enteredSilentOnly();
        }),
    );

    const authC = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const inflightSilentOnly = authC.acquireTokenSilentOnly();
    await silentOnlyEntered;

    await authC.signOut();
    resolveSilentOnly({
      accessToken: 'stale-verify-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    await expect(inflightSilentOnly).rejects.toThrow(/No cached corporate account/i);
    expect((authC as unknown as { account: unknown }).account).toBeNull();
  });

  it('signOut() mid-signIn() cancels active signIn, removes late cached account if acquireTokenByCode() resolves, and stays signed out', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    let resolveLate!: (val: unknown) => void;
    mockAcquireTokenInteractive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const signInPromise = auth.signIn();

    // User clicks sign out while interactive sign-in is in flight
    await auth.signOut();

    // Late token exchange completes after signOut()
    resolveLate({
      accessToken: 'raced-token',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    await expect(signInPromise).resolves.toEqual({ status: 'cancelled' });
    expect(mockRemoveAccount).toHaveBeenCalledWith(cachedAccount);
    expect(await auth.status()).toEqual({ mode: 'entra', signedIn: false, account: undefined });
  });

  it('sanitizes OAuth/Bearer secrets from signIn() error messages and returns friendly timeout message', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenInteractive.mockRejectedValueOnce(
      new Error(
        'AADSTS5000: failed with Authorization: Bearer secret.jwt.payload at https://login.microsoftonline.com/cb?code=SECRET_CODE&state=SECRET_STATE&access_token=TOK123&refresh_token=REF456',
      ),
    );
    const errRes = await auth.signIn();
    expect(errRes.status).toBe('error');
    if (errRes.status === 'error') {
      expect(errRes.message).not.toContain('secret.jwt.payload');
      expect(errRes.message).not.toContain('SECRET_CODE');
      expect(errRes.message).not.toContain('SECRET_STATE');
      expect(errRes.message).not.toContain('TOK123');
      expect(errRes.message).not.toContain('REF456');
      expect(errRes.message).toContain('[REDACTED]');
    }

    // Timeout via loopback client rejection
    mockAcquireTokenInteractive.mockImplementationOnce(
      async (req: { loopbackClient: CancellableLoopbackClient }) => {
        await req.loopbackClient.listenForAuthCode();
        return { accessToken: 'never', account: cachedAccount };
      },
    );
    const fastTimeoutAuth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock, 30);
    await expect(fastTimeoutAuth.signIn()).resolves.toEqual({
      status: 'error',
      message: 'Sign-in timed out. Please try again.',
    });
  });
});


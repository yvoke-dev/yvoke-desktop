import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '@azure/msal-node';
import type { AppSettings } from '../src/shared/types';
import { ServerAuth, EXPIRATION_BUFFER_MS, type TokenCachePersistence } from '../src/main/auth/ServerAuth';

const mockGetAllAccounts = vi.fn();
const mockAcquireTokenSilent = vi.fn();
const mockAcquireTokenInteractive = vi.fn();
const mockRemoveAccount = vi.fn();

vi.mock('@azure/msal-node', () => {
  return {
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
    await expect(auth.signIn()).resolves.toBe('corp-user@corp.example');
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

  it('4d. Silent refresh failure when cached token is already expired triggers interactive sign-in for auth error', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'expired-token',
      expiresOn: new Date(Date.now() - 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('expired-token');

    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: Session expired'));
    mockAcquireTokenInteractive.mockResolvedValueOnce({
      accessToken: 'fresh-interactive-token',
      account: { username: 're-authed-user@corp.example' },
    });

    const token = await auth.getAccessToken();
    expect(token).toBe('fresh-interactive-token');
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
  });

  it('4e. Invalidation prevents fallback to rejected token on subsequent failure', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'rejected-token',
      expiresOn: new Date(Date.now() + 240 * 1000),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('rejected-token');

    // Explicitly invalidated (e.g. after MCP 401)
    auth.invalidate();

    // Next silent call fails
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: Revoked'));
    mockAcquireTokenInteractive.mockResolvedValueOnce({
      accessToken: 'new-after-invalidation',
      account: { username: 're-authed@corp.example' },
    });

    const token = await auth.getAccessToken();
    expect(token).toBe('new-after-invalidation');
    expect(token).not.toBe('rejected-token');
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
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


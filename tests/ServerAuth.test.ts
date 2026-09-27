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

  it('exports EXPIRATION_BUFFER_MS equal to 10 minutes', () => {
    expect(EXPIRATION_BUFFER_MS).toBe(10 * 60 * 1000);
  });

  it('1. Clock boundary: token expiring at now + 601s triggers 1 call, now + 599s triggers 2 calls with forceRefresh: true', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // Boundary 1: now + 601s -> no proactive refresh
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-601',
      expiresOn: new Date(Date.now() + 601 * 1000),
      account: cachedAccount,
    });
    const token601 = await auth.getAccessToken();
    expect(token601).toBe('token-601');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(mockAcquireTokenSilent).toHaveBeenLastCalledWith({
      account: cachedAccount,
      scopes: ['api://test/.default'],
    });

    mockAcquireTokenSilent.mockReset();

    // Boundary 2: now + 599s -> proactive refresh with forceRefresh: true
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-599',
      expiresOn: new Date(Date.now() + 599 * 1000),
      account: cachedAccount,
    });
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-refreshed',
      expiresOn: new Date(Date.now() + 3600 * 1000),
      account: cachedAccount,
    });

    const tokenRefreshed = await auth.getAccessToken();
    expect(tokenRefreshed).toBe('token-refreshed');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(mockAcquireTokenSilent).toHaveBeenNthCalledWith(1, {
      account: cachedAccount,
      scopes: ['api://test/.default'],
    });
    expect(mockAcquireTokenSilent).toHaveBeenNthCalledWith(2, {
      account: cachedAccount,
      scopes: ['api://test/.default'],
      forceRefresh: true,
    });
  });

  it('2. Malformed/NaN expiresOn: null, undefined, and invalid Date handled safely without crash or infinite loops', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    // null
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-null-expiry',
      expiresOn: null,
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-null-expiry');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    mockAcquireTokenSilent.mockReset();

    // undefined
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-undef-expiry',
      expiresOn: undefined,
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-undef-expiry');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);

    mockAcquireTokenSilent.mockReset();

    // Invalid Date (NaN)
    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-nan-expiry',
      expiresOn: new Date('invalid'),
      account: cachedAccount,
    });
    expect(await auth.getAccessToken()).toBe('token-nan-expiry');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
  });

  it('3. Double refresh suppression: calling getAccessToken(false, true) executes only 1 call with forceRefresh: true', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'token-forced',
      expiresOn: new Date(Date.now() + 300 * 1000), // <10m
      account: cachedAccount,
    });

    const token = await auth.getAccessToken(false, true);
    expect(token).toBe('token-forced');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(mockAcquireTokenSilent).toHaveBeenCalledWith({
      account: cachedAccount,
      scopes: ['api://test/.default'],
      forceRefresh: true,
    });
  });

  it('4a. Offline resilience: unexpired token + network error on proactive refresh returns cached token and logs warning', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'cached-token-5m',
      expiresOn: new Date(Date.now() + 300 * 1000),
      account: cachedAccount,
    });
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('fetch failed'));

    const token = await auth.getAccessToken();
    expect(token).toBe('cached-token-5m');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('4b. Offline resilience: already expired token + network error on proactive refresh rethrows network error', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'cached-token-expired',
      expiresOn: new Date(Date.now() - 1000),
      account: cachedAccount,
    });
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(auth.getAccessToken()).rejects.toThrow(/fetch failed/);
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(openBrowserMock).not.toHaveBeenCalled();
    expect(mockAcquireTokenInteractive).not.toHaveBeenCalled();
  });

  it('5. Proactive revocation: non-network error on proactive refresh clears account and triggers interactive fallback', async () => {
    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);

    mockAcquireTokenSilent.mockResolvedValueOnce({
      accessToken: 'cached-token-5m',
      expiresOn: new Date(Date.now() + 300 * 1000),
      account: cachedAccount,
    });
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('InteractionRequiredAuthError: Token revoked'));
    mockAcquireTokenInteractive.mockResolvedValueOnce({
      accessToken: 'interactive-token-revoked-fallback',
      account: { username: 're-authed-user@corp.example' },
    });

    const token = await auth.getAccessToken();
    expect(token).toBe('interactive-token-revoked-fallback');
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(2);
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
    expect((await auth.status()).account).toBe('re-authed-user@corp.example');
  });
});


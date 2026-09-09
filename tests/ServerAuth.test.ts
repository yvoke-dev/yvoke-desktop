import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Configuration } from '@azure/msal-node';
import type { AppSettings } from '../src/shared/types';
import { ServerAuth, type TokenCachePersistence } from '../src/main/auth/ServerAuth';

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
    const result = await auth.verifyToken(false);

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
      read: () => {
        throw new Error('EACCES: permission denied or file corrupt');
      },
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
      read: () => 'corrupted-data',
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

  it('calls acquireTokenInteractive when forceInteractive is true and silent acquisition fails', async () => {
    const cachedAccount = {
      homeAccountId: 'home-1',
      environment: 'login.microsoftonline.com',
      tenantId: 'test-tenant-id',
      username: 'corp-user@corp.example',
      localAccountId: 'local-1',
    };
    mockGetAllAccounts.mockResolvedValue([cachedAccount]);
    mockAcquireTokenSilent.mockRejectedValue(new Error('Interaction required'));
    mockAcquireTokenInteractive.mockResolvedValue({
      accessToken: 'fresh-interactive-token',
      account: cachedAccount,
    });

    const auth = new ServerAuth(() => testSettings('entra'), null, openBrowserMock);
    const result = await auth.verifyToken(true);

    expect(result).toEqual({
      status: 'ok',
      account: 'corp-user@corp.example',
      token: 'fresh-interactive-token',
    });
    expect(mockAcquireTokenInteractive).toHaveBeenCalled();
  });

  it('self-heals cacheCorrupted flag when subsequent cache read succeeds', async () => {
    let fail = true;
    const healingCache: TokenCachePersistence = {
      read: () => {
        if (fail) {
          throw new Error('temporary disk error');
        }
        return null;
      },
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

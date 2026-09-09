import { describe, expect, it, vi } from 'vitest';
import { SyncClient } from '../src/main/sync/SyncClient';

/**
 * The PATCH body is the one place a settings change can destroy something the user cares about:
 * the server derives a conversation's name from its first question, and a title sent alongside a
 * model or thinking-level change would overwrite that name with whatever the app happened to send.
 * The app never invents a title (spec chapter 2), so a settings-only patch must carry none at all.
 */
function clientRecording(bodies: unknown[]): SyncClient {
  return new SyncClient({
    getBaseUrl: () => 'https://server.example',
    getToken: async () => 'token',
    fetchFn: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });
}

describe('SyncClient.updateConversation', () => {
  it('omits the title entirely when a patch is about settings only', async () => {
    const bodies: unknown[] = [];
    await clientRecording(bodies).updateConversation('c1', undefined, { model: 'sonnet' });
    expect(bodies[0]).toEqual({ settings: { model: 'sonnet' } });
    expect(Object.keys(bodies[0] as object)).not.toContain('title');
  });

  it('sends the title when the patch is a rename', async () => {
    const bodies: unknown[] = [];
    await clientRecording(bodies).updateConversation('c1', 'Renamed', {});
    expect(bodies[0]).toEqual({ title: 'Renamed', settings: {} });
  });

  it('sends an explicit null when the title is being cleared', async () => {
    const bodies: unknown[] = [];
    await clientRecording(bodies).updateConversation('c1', null, {});
    expect(bodies[0]).toEqual({ title: null, settings: {} });
  });
});

describe('SyncClient.verifyConnection', () => {
  // Test 1.1: unconfigured serverBaseUrl
  it('Test 1.1: unconfigured serverBaseUrl returns unreachable without fetching', async () => {
    const fetchMock = vi.fn();
    const client = new SyncClient({
      getBaseUrl: () => '',
      getToken: async () => 'token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({
      status: 'unreachable',
      message: 'Server URL not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Also whitespace
    const clientSpaces = new SyncClient({
      getBaseUrl: () => '   ',
      getToken: async () => 'token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    const resultSpaces = await clientSpaces.verifyConnection();
    expect(resultSpaces).toEqual({
      status: 'unreachable',
      message: 'Server URL not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Test 1.3: network error vs 401 distinction
  it('Test 1.3: network error returns unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({
      status: 'unreachable',
      message: 'Server unreachable',
    });
  });

  it('Test 1.3b: ECONNREFUSED network error returns unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({
      status: 'unreachable',
      message: 'Server unreachable',
    });
  });

  it('Test 1.3c: 401 unauthorized returns expired without interactive retry', async () => {
    const getTokenMock = vi.fn().mockResolvedValue('test-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: getTokenMock,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({
      status: 'expired',
      message: 'Server refused credentials (401 Unauthorized)',
    });
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(getTokenMock).toHaveBeenCalledWith(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the passed token directly without calling getToken', async () => {
    const getTokenMock = vi.fn().mockResolvedValue('unused-token');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: getTokenMock,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection('passed-token-xyz');
    expect(result).toEqual({ status: 'ok' });
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://server.example/api/chat/v1/prompts/system/default-chat',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer passed-token-xyz',
        }),
      }),
    );
  });

  it('returns rate_limited on 429 status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Too Many Requests', { status: 429 }));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'test-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({
      status: 'rate_limited',
      message: 'Rate limit exceeded',
    });
  });

  it('returns error on other non-ok HTTP status (e.g. 500)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'test-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.message).toContain('500');
    }
  });

  it('returns ok on 200 probe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ systemPrompt: 'hi' }), { status: 200 }));
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'test-token',
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const result = await client.verifyConnection();
    expect(result).toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://server.example/api/chat/v1/prompts/system/default-chat',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});

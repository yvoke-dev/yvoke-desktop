import { describe, expect, it, vi } from 'vitest';
import { SyncApiError, SyncClient } from '../src/main/sync/SyncClient';
import type { OrchestratorRunPayload, ValidSystemPromptName } from '../src/shared/types';

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

    const result = await client.verifyConnection('test-token');
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
    const resultSpaces = await clientSpaces.verifyConnection('test-token');
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

    const result = await client.verifyConnection('test-token');
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

    const result = await client.verifyConnection('test-token');
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

    const result = await client.verifyConnection('test-token');
    expect(result).toEqual({
      status: 'expired',
      message: 'Server refused credentials (401 Unauthorized)',
    });
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the passed token directly without calling getToken', async () => {
    const getTokenMock = vi.fn().mockResolvedValue('unused-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ systemPrompt: 'hi' }), { status: 200 }));
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

    const result = await client.verifyConnection('test-token');
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

    const result = await client.verifyConnection('test-token');
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

    const result = await client.verifyConnection('test-token');
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

describe('SyncClient.verifyConnection review regressions', () => {
  // A server that accepts the connection and never answers used to hang the probe for undici's
  // 300s default, wedging the whole check behind AppCore's coalescing latch.
  it('gives up on a server that never answers', async () => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        })) as unknown as typeof fetch,
    });

    const result = await client.verifyConnection('token', 20);
    expect(result).toEqual({ status: 'unreachable', message: 'Server unreachable' });
  });

  // An SSO reverse proxy answers an unauthenticated API GET with 200 and an HTML sign-in page.
  // Trusting the status code alone reported that as a working credential.
  it('does not accept a 200 that is not the expected payload', async () => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: (async () =>
        new Response('<html><body>Sign in with your organization account</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof fetch,
    });

    const result = await client.verifyConnection('token');
    expect(result.status).toBe('expired');
  });

  it('accepts a 200 carrying the expected payload', async () => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: (async () =>
        new Response(JSON.stringify({ systemPrompt: 'You are Yvoke.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    expect(await client.verifyConnection('token')).toEqual({ status: 'ok' });
  });

  // The message is rendered verbatim in the About pane; an error page must not arrive whole,
  // and a proxy that echoes the request must not carry the bearer back into the renderer.
  it('caps and redacts the server body it quotes back', async () => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: (async () =>
        new Response(`Bearer secret-jwt-value ${'x'.repeat(5000)}`, { status: 500 })) as unknown as typeof fetch,
    });

    const result = await client.verifyConnection('token');
    expect(result.status).toBe('error');
    const message = 'message' in result ? result.message : '';
    expect(message.length).toBeLessThan(400);
    expect(message).not.toContain('secret-jwt-value');
  });
});

describe('SyncClient.getSystemPrompt', () => {
  it('URL-encodes prompt name to prevent path traversal and truncation', async () => {
    let requestedUrl = '';
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'token',
      fetchFn: (async (url: string) => {
        requestedUrl = url;
        return new Response(JSON.stringify({ systemPrompt: 'PROMPT BODY' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    // @ts-expect-error Raw unvalidated strings must not compile as ValidSystemPromptName argument
    const _typeOnly = () => client.getSystemPrompt('../../evil?test=1#frag');

    const res = await client.getSystemPrompt('../../evil?test=1#frag' as unknown as ValidSystemPromptName);
    expect(res).toBe('PROMPT BODY');
    expect(requestedUrl).toBe('https://server.example/api/chat/v1/prompts/system/..%2F..%2Fevil%3Ftest%3D1%23frag');
  });
});

describe('SyncClient full 10-endpoint contract & error handling', () => {
  it('calls all 10 endpoints with expected HTTP method, path, headers, and JSON body', async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example///',
      getToken: async () => 'tok-123',
      fetchFn: (async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET';
        const headers = (init.headers ?? {}) as Record<string, string>;
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, headers, body });

        if (method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        if (method === 'PATCH') {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/conversations?limit=200&offset=0')) {
          return new Response(
            JSON.stringify([{ id: 'c-1', title: 'Conv 1', settings: { model: 'sonnet' }, createdAt: 't0', updatedAt: 't1' }]),
            { status: 200 },
          );
        }
        if (url.endsWith('/conversations') && method === 'POST') {
          return new Response(
            JSON.stringify({ id: 'c-new', title: 'New', settings: body as Record<string, unknown>, createdAt: 't0', updatedAt: 't0' }),
            { status: 200 },
          );
        }
        if (url.endsWith('/conversations/c-1/messages?limit=500&offset=0')) {
          return new Response(
            JSON.stringify([
              {
                id: 'm-1',
                role: 'user',
                content: 'Hello',
                playbook: 'oim-schema',
                playbookVersion: 2,
                promptTokens: null,
                completionTokens: null,
                totalTokens: null,
                cachedTokens: null,
                thoughtTokens: null,
                createdAt: 't0',
                feedbackRating: null,
                feedbackComment: null,
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith('/conversations/c-1/messages') && method === 'POST') {
          return new Response(JSON.stringify({ ids: ['srv-u-1', 'srv-a-1'] }), { status: 200 });
        }
        if (url.endsWith('/messages/srv-a-1/feedback') && method === 'PUT') {
          return new Response(JSON.stringify({ messageId: 'srv-a-1', rating: 1, comment: 'Great' }), { status: 200 });
        }
        if (url.endsWith('/prompts/system/default-chat')) {
          return new Response(JSON.stringify({ systemPrompt: 'Default system prompt' }), { status: 200 });
        }
        if (url.endsWith('/orchestrator/profiles')) {
          return new Response(
            JSON.stringify([
              {
                name: 'OIM',
                orchestratorPlaybook: 'oim-orch',
                reviewerPlaybook: 'oim-rev',
                specialistPlaybooks: ['oim-spec'],
              },
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith('/orchestrator/runs') && method === 'POST') {
          return new Response(JSON.stringify({ id: 'run-srv-1' }), { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch,
    });

    const convs = await client.listConversations();
    expect(convs).toHaveLength(1);

    const created = await client.createConversation('My Title', { model: 'sonnet', client: 'desktop' });
    expect(created.id).toBe('c-new');

    await client.updateConversation('c-1', 'Updated Title', { model: 'opus' });
    await client.deleteConversation('c-1');

    const msgs = await client.getMessages('c-1');
    expect(msgs[0].playbook).toBe('oim-schema');
    expect(msgs[0].playbookVersion).toBe(2);

    const appended = await client.appendMessages('c-1', [
      { role: 'user', content: 'Q', playbook: 'oim-schema', playbookVersion: 2 },
      { role: 'assistant', content: 'A', playbook: 'oim-schema', playbookVersion: 2, promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    ]);
    expect(appended.ids).toEqual(['srv-u-1', 'srv-a-1']);

    const fb = await client.submitFeedback('srv-a-1', 1, 'Great');
    expect(fb).toEqual({ messageId: 'srv-a-1', rating: 1, comment: 'Great' });

    const sysPrompt = await client.getSystemPrompt('default-chat' as ValidSystemPromptName);
    expect(sysPrompt).toBe('Default system prompt');

    const profiles = await client.getOrchestratorProfiles();
    expect(profiles[0].name).toBe('OIM');

    const runPayload: OrchestratorRunPayload = {
      conversationId: 'c-1',
      messageId: 'srv-a-1',
      profileName: 'OIM',
      status: 'completed',
      reviewRounds: 0,
      steps: [{ seq: 1, role: 'orchestrator', round: 0, playbookName: 'oim-orch', playbookVersion: 2 }],
    };
    const recorded = await client.recordOrchestratorRun(runPayload);
    expect(recorded.id).toBe('run-srv-1');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://server.example/api/chat/v1/conversations?limit=200&offset=0',
      'POST https://server.example/api/chat/v1/conversations',
      'PATCH https://server.example/api/chat/v1/conversations/c-1',
      'DELETE https://server.example/api/chat/v1/conversations/c-1',
      'GET https://server.example/api/chat/v1/conversations/c-1/messages?limit=500&offset=0',
      'POST https://server.example/api/chat/v1/conversations/c-1/messages',
      'PUT https://server.example/api/chat/v1/messages/srv-a-1/feedback',
      'GET https://server.example/api/chat/v1/prompts/system/default-chat',
      'GET https://server.example/api/chat/v1/orchestrator/profiles',
      'POST https://server.example/api/chat/v1/orchestrator/runs',
    ]);
    for (const c of calls) {
      expect(c.headers.Authorization).toBe('Bearer tok-123');
    }
  });

  it('retries once with getToken(true) on first 401 and throws SyncApiError(401) if second attempt also returns 401', async () => {
    const getToken = vi.fn().mockResolvedValueOnce('stale-tok').mockResolvedValueOnce('fresh-tok');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Expired token', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'c-1', title: 'OK', settings: {}, createdAt: 't0', updatedAt: 't0' }]), { status: 200 }));

    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    const convs = await client.listConversations();
    expect(convs).toHaveLength(1);
    expect(getToken).toHaveBeenNthCalledWith(1, false);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Now test double-401 throwing SyncApiError(401)
    const getTokenFail = vi.fn().mockResolvedValue('still-bad-tok');
    const fetchFail = vi.fn().mockImplementation(async () => new Response('Still unauthorized', { status: 401 }));
    const failingClient = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: getTokenFail,
      fetchFn: fetchFail as unknown as typeof fetch,
    });

    await expect(failingClient.listConversations()).rejects.toSatisfy((err: unknown) => {
      return err instanceof SyncApiError && err.status === 401 && err.message.includes('Yvoke Backend:');
    });
    expect(getTokenFail).toHaveBeenCalledTimes(2);
    expect(fetchFail).toHaveBeenCalledTimes(2);
  });

  it.each([400, 404, 500])('throws SyncApiError with status %i and Yvoke Backend attribution on non-OK response', async (status) => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'tok',
      fetchFn: (async () => new Response(`failure-${status}`, { status })) as unknown as typeof fetch,
    });

    await expect(client.listConversations()).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SyncApiError &&
        err.status === status &&
        err.message.startsWith('Yvoke Backend:') &&
        err.message.includes(`failure-${status}`)
      );
    });
  });

  it('throws attributed Yvoke Backend error when 200 OK returns malformed JSON', async () => {
    const client = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => 'tok',
      fetchFn: (async () => new Response('<<<not-json>>>', { status: 200 })) as unknown as typeof fetch,
    });

    await expect(client.listConversations()).rejects.toThrow(/^Yvoke Backend:/);
  });

  it('passes through Entra-prefixed token errors without calling fetch and attributes non-Entra token errors', async () => {
    const fetchMock = vi.fn();
    const entraClient = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => {
        throw new Error('Entra: interactive login cancelled');
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await expect(entraClient.listConversations()).rejects.toThrow('Entra: interactive login cancelled');
    expect(fetchMock).not.toHaveBeenCalled();

    const genericTokenErrClient = new SyncClient({
      getBaseUrl: () => 'https://server.example',
      getToken: async () => {
        throw new Error('keychain locked');
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await expect(genericTokenErrClient.listConversations()).rejects.toThrow('Yvoke Backend: keychain locked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});



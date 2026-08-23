import { describe, expect, it } from 'vitest';
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

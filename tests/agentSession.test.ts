import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, McpPromptInfo, ThreadMeta } from '../src/shared/types';

/**
 * Session lifecycle, against a stand-in for the Agent SDK.
 *
 * The behaviour under test is which text actually reaches the model: a playbook's instructions are
 * prepended to the first question asked under it, and must NOT be prepended again to follow-ups in
 * the same session. Getting that wrong in the other direction is the interesting failure — a session
 * that is rebuilt for a NEW playbook while resuming the old transcript runs the new playbook's tools
 * against the old playbook's instructions, and nothing on screen says so.
 *
 * The fake `query` records every user message the service queues and completes each one as a trivial
 * successful turn, which is all the service needs to advance its own state machine.
 */
const h = vi.hoisted(() => ({
  sessions: [] as { options: Record<string, unknown>; pushed: string[]; closed: boolean }[],
}));

// Partial mock: only `query` is replaced. The rest is real, because the in-process compute server
// is built with the SDK's own `createSdkMcpServer` on the way to every session.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const query = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options: Record<string, unknown>;
  }) => {
    const session = { options, pushed: [] as string[], closed: false };
    h.sessions.push(session);
    const id = h.sessions.length;

    const outbox: unknown[] = [];
    let waiting: ((r: IteratorResult<unknown>) => void) | null = null;
    const emit = (m: unknown): void => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: m, done: false });
      } else {
        outbox.push(m);
      }
    };

    void (async () => {
      for await (const msg of prompt) {
        session.pushed.push(String(msg.message.content));
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `sdk-session-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'answer', usage: {} });
      }
    })();

    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> =>
          outbox.length > 0
            ? Promise.resolve({ value: outbox.shift(), done: false })
            : session.closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise<IteratorResult<unknown>>((resolve) => {
                  waiting = resolve;
                }),
      }),
      setModel: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      interrupt: async () => undefined,
      close: () => {
        session.closed = true;
        if (waiting) {
          const w = waiting;
          waiting = null;
          w({ value: undefined, done: true });
        }
      },
    };
  };
  return { ...actual, query };
});

const { AgentService } = await import('../src/main/agent/AgentService');

const PLAYBOOKS: McpPromptInfo[] = [
  { name: 'oim-schema', title: 'Schema', description: 'Tables.', arguments: [], tools: ['get_section'] },
  { name: 'oim-customers', title: 'Customers', description: 'Accounts.', arguments: [], tools: ['search_corpus'] },
];
const TEXT: Record<string, string> = {
  'oim-schema': 'SCHEMA PLAYBOOK INSTRUCTIONS',
  'oim-customers': 'CUSTOMERS PLAYBOOK INSTRUCTIONS',
};

function settings(): AppSettings {
  return {
    serverBaseUrl: 'https://example.invalid',
    mcpTransport: 'http',
    serverAuthMode: 'dev',
    entra: { tenantId: '', clientId: '', scope: '' },
    models: ['sonnet'],
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'medium',
    webSearch: { enabled: false, allowedDomains: [] },
    maxTurns: 25,
  } as AppSettings;
}

function thread(): ThreadMeta {
  return {
    id: 'thread-1',
    title: 'T',
    model: 'sonnet',
    thinkingLevel: 'medium',
    createdAt: '',
    updatedAt: '',
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    syncState: 'synced',
  };
}

let sandboxDir: string;
let events: AgentEvent[];

/** A service wired to a thread, mirroring how AppCore persists the session id back onto the meta. */
function makeService(meta: ThreadMeta) {
  return new AgentService({
    getSettings: settings,
    mcpAuthProvider: { headers: async () => ({}) } as never,
    emit: (e) => events.push(e),
    onSessionId: (_threadId, sessionId) => {
      meta.sessionId = sessionId;
    },
    onTurnPersist: () => undefined,
    sandboxDir,
    syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
    mcpPrompts: { list: async () => PLAYBOOKS } as never,
    getOrchestratorProfile: async () => undefined,
  });
}

/** Ask one question under `playbookName` and wait for the turn to come back. */
async function ask(
  svc: InstanceType<typeof AgentService>,
  meta: ThreadMeta,
  text: string,
  playbookName: string,
): Promise<void> {
  const before = events.filter((e) => e.kind === 'turn-complete').length;
  await svc.sendMessage(meta, text, {
    injectBefore: TEXT[playbookName],
    playbook: playbookName,
    playbookName,
  });
  for (let i = 0; i < 200; i++) {
    if (events.filter((e) => e.kind === 'turn-complete').length > before) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`turn for "${text}" never completed`);
}

beforeEach(() => {
  h.sessions.length = 0;
  events = [];
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-agent-'));
});

afterEach(() => {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

describe('playbook injection across a session', () => {
  it('prepends the playbook to the first question and to no follow-up under the same one', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    await ask(svc, meta, 'Follow-up question', 'oim-schema');

    expect(h.sessions).toHaveLength(1); // stayed warm — no restart for an unchanged playbook
    expect(h.sessions[0].pushed).toEqual([
      'SCHEMA PLAYBOOK INSTRUCTIONS\n\n---\n\nFirst question',
      'Follow-up question',
    ]);
    svc.closeAll();
  });

  /**
   * Regression: `playbookInjected` was a boolean seeded from `thread.sessionId`, which is set as soon
   * as the first turn's session initialises. The switch below therefore rebuilt the session with the
   * new playbook's tools and suppressed its instructions entirely.
   */
  it('prepends the new playbook when the user switches mid-conversation', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    expect(meta.sessionId).toBe('sdk-session-1'); // the id that made the old guard fire
    await ask(svc, meta, 'Different area question', 'oim-customers');

    expect(h.sessions).toHaveLength(2); // the switch restarts the session
    expect(h.sessions[1].options.resume).toBe('sdk-session-1'); // resuming the old transcript…
    expect(h.sessions[1].pushed).toEqual([
      // …so the new playbook's instructions are the only thing telling the model what it is now doing
      'CUSTOMERS PLAYBOOK INSTRUCTIONS\n\n---\n\nDifferent area question',
    ]);
    svc.closeAll();
  });

  /**
   * The same bug by a second route, which resetting a flag on the restart path would not have caught:
   * after a restart there is no warm session to compare against, so `ensureSession` builds the new
   * playbook's session directly and the restart branch never runs.
   */
  it('prepends the new playbook when the conversation is resumed cold under a different one', async () => {
    const meta = thread();
    const first = makeService(meta);
    await ask(first, meta, 'First question', 'oim-schema');
    first.closeAll();

    // App restart: a fresh service, no warm sessions, but the thread remembers its transcript.
    h.sessions.length = 0;
    const second = makeService(meta);
    await ask(second, meta, 'Different area question', 'oim-customers');

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.resume).toBe('sdk-session-1');
    expect(h.sessions[0].pushed).toEqual([
      'CUSTOMERS PLAYBOOK INSTRUCTIONS\n\n---\n\nDifferent area question',
    ]);
    second.closeAll();
  });

  it('prepends nothing when the question carries no playbook', async () => {
    const meta = thread();
    const svc = makeService(meta);
    await svc.sendMessage(meta, 'Bare question', {});
    for (let i = 0; i < 200 && events.every((e) => e.kind !== 'turn-complete'); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.sessions[0].pushed).toEqual(['Bare question']);
    svc.closeAll();
  });
});

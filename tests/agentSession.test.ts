import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_SERVER_NAME,
  type AgentEvent,
  type AppSettings,
  type McpPromptInfo,
  type OrchestratorProfile,
  type ThreadMeta,
} from '../src/shared/types';
import { buildMcpServers } from '../src/main/agent/McpConnection';

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
  sessions: [] as {
    options: Record<string, unknown>;
    pushed: string[];
    closed: boolean;
    closeSpy: ReturnType<typeof vi.fn>;
    setMcpServersSpy: ReturnType<typeof vi.fn>;
  }[],
  nextQueryError: null as Error | null,
  nextQueryResult: null as Record<string, unknown> | null,
  setMcpServersImpl: null as ((session: any, servers: any) => Promise<any>) | null,
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
    const closeSpy = vi.fn(() => {
      session.closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: undefined, done: true });
      }
    });
    const setMcpServersSpy = vi.fn(async (servers: Record<string, any>) => {
      if (h.setMcpServersImpl) {
        return h.setMcpServersImpl(session, servers);
      }
      return { added: [], removed: [], errors: {} };
    });
    const session = {
      options,
      pushed: [] as string[],
      closed: false,
      closeSpy,
      setMcpServersSpy,
    };
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
        if (h.nextQueryResult) {
          const res = h.nextQueryResult;
          h.nextQueryResult = null;
          emit({ type: 'result', ...res });
        } else {
          emit({ type: 'result', subtype: 'success', is_error: false, result: 'answer', usage: {} });
        }
      }
    })();

    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (h.nextQueryError) {
            const err = h.nextQueryError;
            h.nextQueryError = null;
            return Promise.reject(err);
          }
          return outbox.length > 0
            ? Promise.resolve({ value: outbox.shift(), done: false })
            : session.closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise<IteratorResult<unknown>>((resolve) => {
                  waiting = resolve;
                });
        },
      }),
      setModel: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      interrupt: async () => undefined,
      close: closeSpy,
      setMcpServers: setMcpServersSpy,
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

const OIM_PROFILE: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-schema',
  reviewerPlaybook: 'oim-customers',
  specialistPlaybooks: ['oim-schema'],
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
    orchestrator: {
      orchestrator: { model: 'sonnet', thinkingLevel: 'medium' },
      specialist: { model: 'sonnet', thinkingLevel: 'low' },
      reviewer: { model: 'sonnet', thinkingLevel: 'low' },
      maxReviewRounds: 2,
      maxSpecialistCalls: 5,
      orchestratorMaxTurns: 20,
      specialistMaxTurns: 10,
      requireReview: false,
    },
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
    onSessionId: (_threadId, sessionId, profile) => {
      meta.sessionId = sessionId;
      meta.sessionProfile = profile;
    },
    onTurnPersist: () => undefined,
    sandboxDir,
    syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
    mcpPrompts: {
      list: async () => PLAYBOOKS,
      getText: async (name: string) => TEXT[name] ?? 'INSTRUCTIONS',
    } as never,
    getOrchestratorProfile: async (name: string) => (name === 'OIM' ? OIM_PROFILE : undefined),
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
  h.nextQueryError = null;
  h.nextQueryResult = null;
  h.setMcpServersImpl = null;
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

  it('starts a fresh session (omits resume) when switching from single-agent to orchestrator mode', async () => {
    const meta = thread();
    const svc = makeService(meta);

    // Turn 1: Single agent turn
    await ask(svc, meta, 'First question', 'oim-schema');
    expect(meta.sessionId).toBe('sdk-session-1');
    expect(h.sessions[0].options.resume).toBeUndefined();

    // Switch thread to multi-agent
    meta.orchestratorProfile = 'OIM';

    // Turn 2: Multi-agent turn
    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Multi-agent question', {});
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(h.sessions).toHaveLength(2);
    // Invariant: Turn 2 MUST NOT resume the single-agent session!
    expect(h.sessions[1].options.resume).toBeUndefined();
    expect(meta.sessionId).toBe('sdk-session-2');
    expect(meta.sessionProfile).toBe('OIM');
    svc.closeAll();
  });

  it('starts a fresh session (omits resume) when cold resuming a thread whose sessionId was single-agent but profile is orchestrator', async () => {
    const meta = thread();
    meta.sessionId = 'old-single-session';
    meta.sessionProfile = undefined; // established under single agent
    meta.orchestratorProfile = 'OIM'; // now in orchestrator mode

    const svc = makeService(meta);

    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Cold start multi-agent question', {});
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.resume).toBeUndefined();
    expect(meta.sessionId).toBe('sdk-session-1');
    expect(meta.sessionProfile).toBe('OIM');
    svc.closeAll();
  });
});

describe('error attribution across session events', () => {
  it('emits an error message prefixed with "Claude: " for unauthenticated Claude Code', async () => {
    const meta = thread();
    const svc = makeService(meta);
    h.nextQueryError = new Error('Please run /login to authenticate with Claude Code');

    await svc.sendMessage(meta, 'Question');
    for (let i = 0; i < 50 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.authRequired).toBe(true);
    expect(errEvent?.message.startsWith('Claude: ')).toBe(true);
    svc.closeAll();
  });

  it('emits an error message prefixed with "Claude: " for turn ceiling or execution error', async () => {
    const meta = thread();
    const svc = makeService(meta);
    h.nextQueryResult = {
      subtype: 'error_max_turns',
      is_error: true,
      result: 'Maximum turns reached',
      usage: {},
    };

    await svc.sendMessage(meta, 'Question');
    for (let i = 0; i < 50 && events.every((e) => e.kind !== 'turn-complete'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const completeEvent = events.find((e) => e.kind === 'turn-complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.isError).toBe(true);
    expect(completeEvent?.errorMessage?.startsWith('Claude: ')).toBe(true);
    svc.closeAll();
  });

  it('emits an error message prefixed with "Yvoke Backend: " for prompt fetch failure before turn starts', async () => {
    const meta = thread();
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId) => {
        meta.sessionId = sessionId;
      },
      onTurnPersist: () => undefined,
      sandboxDir,
      syncClient: {
        getSystemPrompt: async () => {
          throw new Error('Connection refused to backend prompt service');
        },
      } as never,
      mcpPrompts: { list: async () => PLAYBOOKS } as never,
      getOrchestratorProfile: async () => undefined,
    });

    await expect(svc.sendMessage(meta, 'Question')).rejects.toThrow();

    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.message.startsWith('Yvoke Backend: ')).toBe(true);
    expect(errEvent?.message.startsWith('Claude: ')).toBe(false);
    svc.closeAll();
  });

  it('preserves "Entra: " error when prompt fetch fails and does not wrap in "Yvoke Backend:"', async () => {
    const meta = thread();
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId) => {
        meta.sessionId = sessionId;
      },
      onTurnPersist: () => undefined,
      sandboxDir,
      syncClient: {
        getSystemPrompt: async () => {
          throw new Error('Entra: Authentication token expired');
        },
      } as never,
      mcpPrompts: { list: async () => PLAYBOOKS } as never,
      getOrchestratorProfile: async () => undefined,
    });

    await expect(svc.sendMessage(meta, 'Question')).rejects.toThrow('Entra: Authentication token expired');

    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.message.startsWith('Entra: ')).toBe(true);
    expect(errEvent?.message.startsWith('Yvoke Backend:')).toBe(false);
    expect(errEvent?.message).toBe('Entra: Authentication token expired');
    svc.closeAll();
  });

  it('preserves "Entra: " error when auth provider fails and does not wrap in "Yvoke Backend:"', async () => {
    const meta = thread();
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: {
        headers: async () => {
          throw new Error('Entra: User is not authenticated');
        },
      } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId) => {
        meta.sessionId = sessionId;
      },
      onTurnPersist: () => undefined,
      sandboxDir,
      syncClient: {
        getSystemPrompt: async () => 'BASE SYSTEM PROMPT',
      } as never,
      mcpPrompts: { list: async () => PLAYBOOKS } as never,
      getOrchestratorProfile: async () => undefined,
    });

    await expect(svc.sendMessage(meta, 'Question')).rejects.toThrow('Entra: User is not authenticated');

    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent?.message.startsWith('Entra: ')).toBe(true);
    expect(errEvent?.message.startsWith('Yvoke Backend:')).toBe(false);
    expect(errEvent?.message).toBe('Entra: User is not authenticated');
    svc.closeAll();
  });

  it('Test 1.8: Early busy check in sendMessage throws immediately when isBusy is true, without closing active session', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    expect(svc.isBusy(meta.id)).toBe(false);

    const session = (svc as any).sessions.get(meta.id);
    expect(session).toBeDefined();
    session.busy = true;

    expect(svc.isBusy(meta.id)).toBe(true);

    const closeSpy = vi.spyOn(svc, 'closeThread');

    await expect(
      svc.sendMessage(meta, 'Second question while busy', { playbookName: 'oim-customers' }),
    ).rejects.toThrow('A turn is already running for this conversation.');

    expect(closeSpy).not.toHaveBeenCalled();
    expect(svc.isBusy(meta.id)).toBe(true);
    svc.closeAll();
  });

  it('Test 1.9: Session config change handling in ensureSession handles playbook changes when idle', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    const initialSession = (svc as any).sessions.get(meta.id);
    expect(initialSession.playbookName).toBe('oim-schema');

    await ask(svc, meta, 'Second question with new playbook', 'oim-customers');
    const updatedSession = (svc as any).sessions.get(meta.id);
    expect(updatedSession.playbookName).toBe('oim-customers');
    svc.closeAll();
  });

  it('validates toolUseId and coerces answer in resolveClarification', () => {
    const meta = thread();
    const svc = makeService(meta);

    let resolvedValue: string | null = null;
    svc.pendingClarifications.set('tool-1', (ans) => {
      resolvedValue = ans;
    });

    // Invalid toolUseId: empty string or non-string should be a no-op
    svc.resolveClarification('', 'valid answer');
    expect(resolvedValue).toBeNull();
    expect(svc.pendingClarifications.has('tool-1')).toBe(true);

    svc.resolveClarification(null as any, 'valid answer');
    expect(resolvedValue).toBeNull();
    expect(svc.pendingClarifications.has('tool-1')).toBe(true);

    // Wire clarification to thread
    const threadClarifications = (svc as any).threadClarifications as Map<string, Set<string>>;
    threadClarifications.set('thread-1', new Set(['tool-1']));

    // Whitespace trimming
    svc.resolveClarification('tool-1', '   trimmed answer   ');
    expect(resolvedValue).toBe('trimmed answer');
    expect(svc.pendingClarifications.has('tool-1')).toBe(false);
    expect(threadClarifications.has('thread-1')).toBe(false);

    // Non-string answer coercion
    let resolvedValue2: string | null = null;
    svc.pendingClarifications.set('tool-2', (ans) => {
      resolvedValue2 = ans;
    });
    svc.resolveClarification('tool-2', null as any);
    expect(resolvedValue2).toBe('');

    let resolvedValue3: string | null = null;
    svc.pendingClarifications.set('tool-3', (ans) => {
      resolvedValue3 = ans;
    });
    svc.resolveClarification('tool-3', 123 as any);
    expect(resolvedValue3).toBe('123');

    svc.closeAll();
  });

  it('returns false when toolUseId is not pending, and true when resolved', () => {
    const meta = thread();
    const svc = makeService(meta);

    expect(svc.resolveClarification('', 'answer')).toBe(false);
    expect(svc.resolveClarification(null as any, 'answer')).toBe(false);
    expect(svc.resolveClarification('non-existent-tool-id', 'answer')).toBe(false);

    svc.pendingClarifications.set('tool-pending-1', vi.fn());
    expect(svc.resolveClarification('tool-pending-1', 'answer')).toBe(true);
    expect(svc.pendingClarifications.has('tool-pending-1')).toBe(false);
    // Resolving again should return false (already resolved / no longer pending)
    expect(svc.resolveClarification('tool-pending-1', 'answer')).toBe(false);

    svc.closeAll();
  });

  it('cancels pending clarifications when a turn crashes in consume()', async () => {
    const meta = thread();
    const svc = makeService(meta);

    let resolvedAnswer: string | null = null;
    svc.pendingClarifications.set('tool-crash', (ans) => {
      resolvedAnswer = ans;
    });
    // Wire clarification to thread
    const threadClarifications = (svc as any).threadClarifications as Map<string, Set<string>>;
    threadClarifications.set(meta.id, new Set(['tool-crash']));

    h.nextQueryError = new Error('Turn exploded');

    await svc.sendMessage(meta, 'Question that fails', {
      injectBefore: TEXT['oim-schema'],
      playbook: 'oim-schema',
      playbookName: 'oim-schema',
    });

    // Wait for consume to hit error block
    for (let i = 0; i < 50; i++) {
      if (events.some((e) => e.kind === 'error')) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(events.some((e) => e.kind === 'error')).toBe(true);
    // The clarification should have been cancelled with empty string
    expect(resolvedAnswer).toBe('');
    expect(svc.pendingClarifications.has('tool-crash')).toBe(false);
    expect(threadClarifications.has(meta.id)).toBe(false);

    svc.closeAll();
  });
});

describe('McpConnection pre-resolved headers & AgentService dynamic header synchronization', () => {
  function makeAuthService(
    meta: ThreadMeta,
    getHeaders: () => Promise<Record<string, string>>,
    invalidate?: () => void,
  ) {
    return new AgentService({
      getSettings: () => ({ ...settings(), serverAuthMode: 'entra' }),
      mcpAuthProvider: { headers: getHeaders, ...(invalidate ? { invalidate } : {}) },
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId, profile) => {
        meta.sessionId = sessionId;
        meta.sessionProfile = profile;
      },
      onTurnPersist: () => undefined,
      sandboxDir,
      syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => TEXT[name] ?? 'INSTRUCTIONS',
      } as never,
      getOrchestratorProfile: async (name: string) => (name === 'OIM' ? OIM_PROFILE : undefined),
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. Dev-mode & unauthenticated zero-churn: Follow-up turns make 0 calls to setMcpServers', async () => {
    const meta = thread();
    const svc = makeService(meta); // dev-mode, serverAuthMode: 'dev'

    await ask(svc, meta, 'First turn', 'oim-schema');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].setMcpServersSpy).not.toHaveBeenCalled();

    await ask(svc, meta, 'Second turn', 'oim-schema');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].setMcpServersSpy).not.toHaveBeenCalled();

    svc.closeAll();
  });

  it('2. Timer cleanup: Assert timeout timer is cancelled via clearTimeout on success and error paths', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // Turn 1: initial session created
    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect(h.sessions).toHaveLength(1);

    // Success path: auth changes
    clearTimeoutSpy.mockClear();
    currentAuth = 'Bearer token-2';
    await ask(svc, meta, 'Turn 2', 'oim-schema');
    expect(h.sessions[0].setMcpServersSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Error path: auth changes, setMcpServers throws
    clearTimeoutSpy.mockClear();
    currentAuth = 'Bearer token-3';
    h.setMcpServersImpl = async () => {
      throw new Error('RPC error');
    };
    await ask(svc, meta, 'Turn 3', 'oim-schema');
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    svc.closeAll();
  });

  it('3. Targeted server error disambiguation: errors for MCP_SERVER_NAME evicts and recreates; non-yvoke error does not evict; selective invalidate', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const invalidateMock = vi.fn();
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }), invalidateMock);

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    const initialSession = h.sessions[0];

    // Non-yvoke error: does NOT evict
    currentAuth = 'Bearer token-2';
    h.setMcpServersImpl = async () => ({
      added: [],
      removed: [],
      errors: { other_compute: 'compute failed' },
    });
    await ask(svc, meta, 'Turn 2', 'oim-schema');
    expect(h.sessions).toHaveLength(1);
    expect(initialSession.closed).toBe(false);
    expect(invalidateMock).not.toHaveBeenCalled();

    // MCP_SERVER_NAME 401 error: evicts and recreates AND calls invalidate()
    const priorSessionId3 = meta.sessionId;
    currentAuth = 'Bearer token-3';
    h.setMcpServersImpl = async () => ({
      added: [],
      removed: [],
      errors: { [MCP_SERVER_NAME]: '401 Unauthorized' },
    });
    await ask(svc, meta, 'Turn 3', 'oim-schema');
    expect(h.sessions).toHaveLength(2);
    expect(initialSession.closeSpy).toHaveBeenCalled();
    expect(h.sessions[1].options.resume).toBe(priorSessionId3);
    expect(invalidateMock).toHaveBeenCalledTimes(1);

    // MCP_SERVER_NAME non-auth error (e.g. 500 error): evicts and recreates, but does NOT call invalidate()
    const priorSessionId4 = meta.sessionId;
    currentAuth = 'Bearer token-4';
    h.setMcpServersImpl = async () => ({
      added: [],
      removed: [],
      errors: { [MCP_SERVER_NAME]: '500 Internal Server Error' },
    });
    await ask(svc, meta, 'Turn 4', 'oim-schema');
    expect(h.sessions).toHaveLength(3);
    expect(h.sessions[2].options.resume).toBe(priorSessionId4);
    expect(invalidateMock).toHaveBeenCalledTimes(1); // not called again for 500

    // Non-auth error with 401 in a port number (e.g. port 4010): word-anchor ensures no invalidate()
    const priorSessionId5 = meta.sessionId;
    currentAuth = 'Bearer token-5';
    h.setMcpServersImpl = async () => ({
      added: [],
      removed: [],
      errors: { [MCP_SERVER_NAME]: 'connect ECONNREFUSED 127.0.0.1:4010' },
    });
    await ask(svc, meta, 'Turn 5', 'oim-schema');
    expect(h.sessions).toHaveLength(4);
    expect(h.sessions[3].options.resume).toBe(priorSessionId5);
    expect(invalidateMock).toHaveBeenCalledTimes(1); // not called for 4010

    svc.closeAll();
  });

  it('4. Dynamic update timeout: setMcpServers hanging > 10s times out, timer cleaned up, session evicted and recreated without invalidating auth', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const invalidateMock = vi.fn();
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }), invalidateMock);

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    const initialSession = h.sessions[0];
    const priorSessionId4 = meta.sessionId;

    currentAuth = 'Bearer token-hang';
    h.setMcpServersImpl = () => new Promise(() => {}); // never resolves

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    clearTimeoutSpy.mockClear();

    const ensurePromise = (svc as any).ensureSession(meta, 'oim-schema');
    await vi.advanceTimersByTimeAsync(10_005);
    const newSession = await ensurePromise;
    vi.useRealTimers();

    expect(initialSession.closeSpy).toHaveBeenCalled();
    expect(h.sessions).toHaveLength(2);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(newSession.lastMcpHeadersJson).toBe(JSON.stringify({ Authorization: 'Bearer token-hang' }));
    expect(h.sessions[1].options.resume).toBe(priorSessionId4);
    expect(invalidateMock).not.toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
    svc.closeAll();
  });

  it('5. Subprocess crash: setMcpServers rejects with process crash error -> session evicted and recreated without invalidating auth', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const invalidateMock = vi.fn();
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }), invalidateMock);

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    const initialSession = h.sessions[0];
    const priorSessionId5 = meta.sessionId;

    currentAuth = 'Bearer token-crash';
    h.setMcpServersImpl = async () => {
      throw new Error('Claude Code subprocess terminated unexpectedly (exit code 1)');
    };

    await ask(svc, meta, 'Turn 2', 'oim-schema');
    expect(h.sessions).toHaveLength(2);
    expect(initialSession.closeSpy).toHaveBeenCalled();
    expect(h.sessions[1].options.resume).toBe(priorSessionId5);
    expect(invalidateMock).not.toHaveBeenCalled();

    svc.closeAll();
  });

  it('6. Thread eviction race: closeThread(thread.id) called while setMcpServers is awaiting creates fresh session cleanly without throwing', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect((svc as any).sessions.has(meta.id)).toBe(true);

    currentAuth = 'Bearer token-race';
    h.setMcpServersImpl = async () => {
      svc.closeThread(meta.id);
      return { added: [], removed: [], errors: {} };
    };

    const session = await (svc as any).ensureSession(meta, 'oim-schema');
    expect(session).toBeDefined();
    expect((svc as any).sessions.has(meta.id)).toBe(true);

    svc.closeAll();
  });

  it('6b. Unchanged-auth eviction race: when thread is evicted during headers(), fresh session is created', async () => {
    const meta = thread();
    const svc = makeAuthService(meta, async () => {
      return { Authorization: 'Bearer same-token' };
    });

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    const session1 = (svc as any).sessions.get(meta.id);
    expect(session1).toBeDefined();

    // Hook into next headers() call to close the session while headers() is in flight
    (svc as any).deps.mcpAuthProvider.headers = async () => {
      svc.closeThread(meta.id);
      return { Authorization: 'Bearer same-token' };
    };

    const session2 = await (svc as any).ensureSession(meta, 'oim-schema');
    expect(session2).not.toBe(session1);
    expect(h.sessions[0].closeSpy).toHaveBeenCalled();
    expect((svc as any).sessions.get(meta.id)).toBe(session2);

    svc.closeAll();
  });

  it('7. Pre-resolved headers: buildMcpServers attaches passed headers directly', () => {
    const preResolved = { Authorization: 'Bearer pre-resolved' };
    const servers = buildMcpServers(settings(), preResolved);
    expect(servers[MCP_SERVER_NAME]).toBeDefined();
    expect((servers[MCP_SERVER_NAME] as any).headers).toEqual(preResolved);
  });

  it('8. Bearer token non-leakage: Emitted logs do not contain the bearer token string', async () => {
    const meta = thread();
    const secretToken = 'secret-token-xyz-987654321';
    let currentAuth = `Bearer ${secretToken}`;
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    const consoleLogSpy = vi.spyOn(console, 'log');
    const consoleErrorSpy = vi.spyOn(console, 'error');

    await ask(svc, meta, 'Turn 1', 'oim-schema');

    currentAuth = `Bearer ${secretToken}-updated`;
    h.setMcpServersImpl = async () => {
      throw new Error('Dynamic update failed with error');
    };

    await ask(svc, meta, 'Turn 2', 'oim-schema');

    const allEmittedLogs = [...consoleLogSpy.mock.calls, ...consoleErrorSpy.mock.calls].flat().join(' ');
    expect(allEmittedLogs).not.toContain(secretToken);

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    svc.closeAll();
  });

  it('9. Anti-tautological eviction assertion: Assert oldSession !== newSession, oldSession.query.close was called, and newSession.options.resume === thread.sessionId', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    const oldSession = h.sessions[0];
    const initialSessionId = meta.sessionId;

    currentAuth = 'Bearer token-2';
    h.setMcpServersImpl = async () => {
      throw new Error('Subprocess killed');
    };

    await ask(svc, meta, 'Turn 2', 'oim-schema');
    const newSession = h.sessions[1];

    expect(oldSession).not.toBe(newSession);
    expect(oldSession.closeSpy).toHaveBeenCalled();
    expect(newSession.options.resume).toBe(initialSessionId);

    svc.closeAll();
  });

  it('10. Full header change detection: change in custom headers triggers setMcpServers', async () => {
    const meta = thread();
    let currentHeaders: Record<string, string> = { Authorization: 'Bearer token-1', 'x-tenant': 'tenant-a' };
    const svc = makeAuthService(meta, async () => currentHeaders);

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect(h.sessions[0].setMcpServersSpy).not.toHaveBeenCalled();

    // Change x-tenant header, keeping Authorization identical
    currentHeaders = { Authorization: 'Bearer token-1', 'x-tenant': 'tenant-b' };
    await ask(svc, meta, 'Turn 2', 'oim-schema');
    expect(h.sessions[0].setMcpServersSpy).toHaveBeenCalledTimes(1);

    svc.closeAll();
  });

  it('11a. Session replacement mid-wait with busy config-mismatched session rejects without emitting error event', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect(h.sessions).toHaveLength(1);

    currentAuth = 'Bearer token-race-busy';
    h.setMcpServersImpl = async () => {
      const replacingSession: any = {
        query: { close: vi.fn() },
        queue: { close: vi.fn() },
        orchestratorProfile: undefined,
        playbookName: 'different-playbook',
        busy: true,
        lastMcpHeadersJson: '{}',
      };
      (svc as any).sessions.set(meta.id, replacingSession);
      return { added: [], removed: [], errors: {} };
    };

    const prevErrorEvents = events.filter((e) => e.kind === 'error');
    await expect(svc.sendMessage(meta, 'Turn 2', { playbookName: 'oim-schema' })).rejects.toThrow(
      'A turn is already running for this conversation.',
    );
    // Crucial: ensure no error event was emitted to avoid wiping the active turn view in the UI
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(prevErrorEvents.length);

    svc.closeAll();
  });

  it('11b. Session replacement mid-wait with idle config-mismatched session closes replaced session before recreating', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect(h.sessions).toHaveLength(1);

    currentAuth = 'Bearer token-race-idle';
    const replacingQueryCloseSpy = vi.fn();
    const replacingQueueCloseSpy = vi.fn();
    h.setMcpServersImpl = async () => {
      const replacingSession: any = {
        query: { close: replacingQueryCloseSpy },
        queue: { close: replacingQueueCloseSpy },
        orchestratorProfile: undefined,
        playbookName: 'different-playbook',
        busy: false,
        lastMcpHeadersJson: '{}',
      };
      (svc as any).sessions.set(meta.id, replacingSession);
      return { added: [], removed: [], errors: {} };
    };

    const newSession = await (svc as any).ensureSession(meta, 'oim-schema');
    expect(replacingQueryCloseSpy).toHaveBeenCalledTimes(1);
    expect(replacingQueueCloseSpy).toHaveBeenCalledTimes(1);
    expect(newSession).toBeDefined();
    expect(newSession.playbookName).toBe('oim-schema');

    svc.closeAll();
  });
});


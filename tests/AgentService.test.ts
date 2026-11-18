import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  McpPromptInfo,
  OrchestratorProfile,
  ThreadMeta,
} from '../src/shared/types';

const h = vi.hoisted(() => ({
  sessions: [] as {
    options: Record<string, unknown>;
    pushed: string[];
    closed: boolean;
    closeSpy: ReturnType<typeof vi.fn>;
  }[],
  turnHandler: null as
    | ((
        session: {
          options: Record<string, unknown>;
          pushed: string[];
          closed: boolean;
        },
        promptText: string,
        emit: (m: unknown) => void,
        failNext: (err: Error) => void,
        id: number,
      ) => Promise<void> | void)
    | null,
  setModelImpl: null as ((model: string) => Promise<void>) | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const query = ({
    prompt,
    options,
  }: {
    prompt: string | AsyncIterable<{ message: { content: unknown } }>;
    options: Record<string, unknown>;
  }) => {
    const closeSpy = vi.fn(() => {
      session.closed = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.resolve({ value: undefined, done: true });
      }
    });
    const session = {
      options,
      pushed: [] as string[],
      closed: false,
      closeSpy,
    };
    h.sessions.push(session);
    const id = h.sessions.length;

    const outbox: Array<{ ok: true; value: unknown } | { ok: false; err: Error }> = [];
    let waiting: {
      resolve: (r: IteratorResult<unknown>) => void;
      reject: (err: Error) => void;
    } | null = null;
    const emit = (m: unknown): void => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.resolve({ value: m, done: false });
      } else {
        outbox.push({ ok: true, value: m });
      }
    };
    const failNext = (err: Error): void => {
      if (waiting) {
        const w = waiting;
        waiting = null;
        w.reject(err);
      } else {
        outbox.push({ ok: false, err });
      }
    };

    void (async () => {
      if (typeof prompt === 'string') {
        session.pushed.push(prompt);
        if (h.turnHandler) {
          await h.turnHandler(session, prompt, emit, failNext, id);
        } else {
          emit({ type: 'result', subtype: 'success', is_error: false, result: 'APPROVED', usage: {} });
        }
        return;
      }
      for await (const msg of prompt) {
        const text =
          typeof msg.message.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message.content);
        session.pushed.push(text);
        if (h.turnHandler) {
          await h.turnHandler(session, text, emit, failNext, id);
        } else {
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
      }
    })();

    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (outbox.length > 0) {
            const item = outbox.shift()!;
            return item.ok
              ? Promise.resolve({ value: item.value, done: false })
              : Promise.reject(item.err);
          }
          if (session.closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiting = { resolve, reject };
          });
        },
      }),
      setModel: async (m: string) => {
        if (h.setModelImpl) {
          await h.setModelImpl(m);
        }
      },
      setMaxThinkingTokens: async () => undefined,
      interrupt: async () => undefined,
      close: closeSpy,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    };
  };
  return { ...actual, query };
});

const { AgentService } = await import('../src/main/agent/AgentService');

const PLAYBOOKS: McpPromptInfo[] = [
  {
    name: 'oim-full',
    title: 'OIM Full',
    description: 'Full search.',
    arguments: [],
    tools: ['search_corpus'],
    version: 2,
  },
  {
    name: 'oim-unversioned',
    title: 'OIM Unversioned',
    description: 'Legacy playbook without version.',
    arguments: [],
    tools: ['search_corpus'],
  },
];

const OIM_PROFILE: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-full',
  reviewerPlaybook: 'oim-unversioned',
  specialistPlaybooks: ['oim-full'],
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
    },
  } as AppSettings;
}

function makeThread(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id: 'thread-ver-1',
    title: 'Version Test Thread',
    model: 'sonnet',
    thinkingLevel: 'medium',
    createdAt: '2026-10-15T10:00:00Z',
    updatedAt: '2026-10-15T10:00:00Z',
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    syncState: 'synced',
    ...overrides,
  };
}

describe('AgentService playbookVersion stamping', () => {
  let sandboxDir: string;
  let events: AgentEvent[];
  let persistedTurns: { threadId: string; userMessage: ChatMessage; assistantMessage: ChatMessage }[];

  beforeEach(() => {
    h.sessions.length = 0;
    h.turnHandler = null;
    h.setModelImpl = null;
    events = [];
    persistedTurns = [];
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ver-test-'));
  });

  afterEach(() => {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  function createService(meta: ThreadMeta) {
    return new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId, profile) => {
        meta.sessionId = sessionId;
        meta.sessionProfile = profile;
      },
      onTurnPersist: (threadId, userMessage, assistantMessage) => {
        persistedTurns.push({ threadId, userMessage, assistantMessage });
      },
      sandboxDir,
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => `INSTRUCTIONS FOR ${name}`,
      } as never,
      getOrchestratorProfile: async (name: string) => (name === 'OIM' ? OIM_PROFILE : undefined),
    });
  }

  async function runTurn(
    svc: InstanceType<typeof AgentService>,
    meta: ThreadMeta,
    text: string,
    playbook?: string,
  ): Promise<void> {
    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, text, { playbook });
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`turn for "${text}" never completed`);
  }

  it('stamps playbook and playbookVersion onto both userMessage and assistantMessage on cold turn 1 and warm session reuse turn 2', async () => {
    const meta = makeThread({ initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    await runTurn(svc, meta, 'First question', 'oim-full');
    expect(persistedTurns).toHaveLength(1);
    expect(persistedTurns[0].userMessage.playbook).toBe('oim-full');
    expect(persistedTurns[0].userMessage.playbookVersion).toBe(2);
    expect(persistedTurns[0].assistantMessage.playbook).toBe('oim-full');
    expect(persistedTurns[0].assistantMessage.playbookVersion).toBe(2);

    // Turn 2 reuses the warm session without creating a second SDK session
    await runTurn(svc, meta, 'Follow-up question', 'oim-full');
    expect(h.sessions).toHaveLength(1);
    expect(persistedTurns).toHaveLength(2);
    expect(persistedTurns[1].userMessage.playbook).toBe('oim-full');
    expect(persistedTurns[1].userMessage.playbookVersion).toBe(2);
    expect(persistedTurns[1].assistantMessage.playbook).toBe('oim-full');
    expect(persistedTurns[1].assistantMessage.playbookVersion).toBe(2);

    svc.closeAll();
  });

  it('leaves playbookVersion undefined on both userMessage and assistantMessage when the matched MCP prompt omits version', async () => {
    const meta = makeThread({ id: 'thread-unver', initialPlaybook: 'oim-unversioned' });
    const svc = createService(meta);

    await runTurn(svc, meta, 'Unversioned question', 'oim-unversioned');
    expect(persistedTurns).toHaveLength(1);
    expect(persistedTurns[0].userMessage.playbook).toBe('oim-unversioned');
    expect(persistedTurns[0].userMessage.playbookVersion).toBeUndefined();
    expect(persistedTurns[0].assistantMessage.playbook).toBe('oim-unversioned');
    expect(persistedTurns[0].assistantMessage.playbookVersion).toBeUndefined();

    svc.closeAll();
  });

  it('leaves playbook and playbookVersion undefined on both userMessage and assistantMessage for orchestrator-mode turns', async () => {
    const meta = makeThread({ id: 'thread-orch', orchestratorProfile: 'OIM' });
    const svc = createService(meta);

    await runTurn(svc, meta, 'Orchestrated question', undefined);
    expect(persistedTurns).toHaveLength(1);
    expect(persistedTurns[0].userMessage.playbook).toBeUndefined();
    expect(persistedTurns[0].userMessage.playbookVersion).toBeUndefined();
    expect(persistedTurns[0].assistantMessage.playbook).toBeUndefined();
    expect(persistedTurns[0].assistantMessage.playbookVersion).toBeUndefined();

    svc.closeAll();
  });

  it('rejects sending turn without playbook in single-agent mode', async () => {
    const meta = makeThread({ id: 'thread-late-pb' });
    const svc = createService(meta);

    await expect(runTurn(svc, meta, 'Turn 1 without playbook', undefined)).rejects.toThrow(
      /A playbook must be selected for single-agent chat/,
    );
    expect(h.sessions).toHaveLength(0);
    svc.closeAll();
  });

  it('throws when attempting to switch or clear an already-assigned playbook on a warm session', async () => {
    const meta = makeThread({ id: 'thread-immut-session', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    await runTurn(svc, meta, 'First question', 'oim-full');
    expect(h.sessions).toHaveLength(1);

    await expect(svc.sendMessage(meta, 'Switch to another', { playbook: 'oim-unversioned' })).rejects.toThrow(
      'Cannot switch playbook on an existing conversation session (locked to "oim-full", requested "oim-unversioned")',
    );
    await expect(svc.sendMessage(meta, 'Clear playbook', { playbook: undefined })).rejects.toThrow(
      'Cannot switch playbook on an existing conversation session (locked to "oim-full", requested "none")',
    );

    svc.closeAll();
  });
});

describe('AgentService turn auth propagation, consume() teardown & closeIdleSessions', () => {
  let sandboxDir: string;
  let events: AgentEvent[];

  beforeEach(() => {
    h.sessions.length = 0;
    h.turnHandler = null;
    h.setModelImpl = null;
    events = [];
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-auth-turn-'));
  });

  afterEach(() => {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });

  function createService(meta: ThreadMeta, overrides: Partial<ConstructorParameters<typeof AgentService>[0]> = {}) {
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
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => `INSTRUCTIONS FOR ${name}`,
      } as never,
      getOrchestratorProfile: async (name: string) => (name === 'OIM' ? OIM_PROFILE : undefined),
      ...overrides,
    });
  }

  async function waitForEvent(kind: AgentEvent['kind'], minCount = 1): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === kind).length >= minCount) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`Timed out waiting for ${kind}`);
  }

  it('propagates authRequired: true on 401/403/unauthenticated result, evicts warm session while keeping ThreadMeta.sessionId, and suppresses post-result duplicate error', async () => {
    const meta = makeThread({ id: 'thread-auth-evict', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    // Turn 1: establishes sdk-session-1
    await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    expect(meta.sessionId).toBe('sdk-session-1');
    expect(h.sessions).toHaveLength(1);

    // Turn 2 on warm session: yields 401 result AND then throws exception on subsequent next() (mirroring SDK generator behavior)
    events = [];
    h.turnHandler = (_session, _text, emit, failNext) => {
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 401,
        errors: ['Unauthorized session'],
        usage: {},
      });
      failNext(new Error('Process exited with code 1 after result'));
    };

    await svc.sendMessage(meta, 'Turn 2 expired', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    await new Promise((r) => setTimeout(r, 10));

    const completes = events.filter((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >[];
    const errors = events.filter((e) => e.kind === 'error');

    expect(completes).toHaveLength(1);
    expect(completes[0].isError).toBe(true);
    expect(completes[0].authRequired).toBe(true);
    expect(completes[0].errorMessage).toMatch(/^Claude: .*Sign in to Claude/i);
    expect(completes[0].errorMessage).not.toMatch(/claude\s+\/login/i);
    // Must NOT emit a second error event from consume() catch block!
    expect(errors).toHaveLength(0);

    // Warm session was closed & evicted, while ThreadMeta.sessionId is preserved for resume after re-signin
    expect(h.sessions[0].closed).toBe(true);
    expect(meta.sessionId).toBe('sdk-session-1');

    // Turn 3 after user signs in: spawns a fresh CLI subprocess resuming sdk-session-1
    h.turnHandler = null;
    events = [];
    await svc.sendMessage(meta, 'Turn 3 resumed', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1].options.resume).toBe('sdk-session-1');

    svc.closeAll();
  });

  it('sets authRequired: false for 429 rate limit mentioning API key, 500 mentioning invalid api key, req_4290, and pre-attributed Entra/Yvoke Backend errors', async () => {
    const meta = makeThread({ id: 'thread-non-auth', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    // 1. 429 mentioning API key -> rate_limited, authRequired: false
    h.turnHandler = (_s, _t, emit) => {
      emit({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: '429 rate limit for API key exceeded',
        usage: {},
      });
    };
    await svc.sendMessage(meta, 'Q1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const c1 = events.find((e) => e.kind === 'turn-complete') as Extract<AgentEvent, { kind: 'turn-complete' }>;
    expect(c1.authRequired).toBe(false);
    expect(c1.errorMessage).toBe('Claude: Claude subscription allowance or rate limit reached.');

    // 2. api_error_status: 500 mentioning invalid api key -> non-fallthrough, authRequired: false
    events = [];
    h.turnHandler = (_s, _t, emit) => {
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 500,
        errors: ['Upstream 500: invalid api key cache lookup'],
        usage: {},
      });
    };
    await svc.sendMessage(meta, 'Q2', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const c2 = events.find((e) => e.kind === 'turn-complete') as Extract<AgentEvent, { kind: 'turn-complete' }>;
    expect(c2.authRequired).toBe(false);
    expect(c2.errorMessage).toBe('Claude: Upstream 500: invalid api key cache lookup');

    // 3. Incidental req_4290 -> neither rate_limited nor authRequired
    events = [];
    h.turnHandler = (_s, _t, emit) => {
      emit({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Upstream failure on request req_4290',
        usage: {},
      });
    };
    await svc.sendMessage(meta, 'Q3', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const c3 = events.find((e) => e.kind === 'turn-complete') as Extract<AgentEvent, { kind: 'turn-complete' }>;
    expect(c3.authRequired).toBe(false);
    expect(c3.errorMessage).toBe('Claude: Upstream failure on request req_4290');

    // 4. Pre-attributed Entra & Yvoke Backend errors mentioning authentication/credential -> authRequired: false & original prefix preserved
    events = [];
    const entraSvc = createService(makeThread({ id: 't-entra' }), {
      mcpAuthProvider: {
        headers: async () => {
          throw new Error('Entra: Invalid credential or expired OAuth token');
        },
      } as never,
    });
    await expect(entraSvc.sendMessage(makeThread({ id: 't-entra' }), 'Q4', { playbook: 'oim-full' })).rejects.toThrow();
    const entraErr = events.find((e) => e.kind === 'error') as Extract<AgentEvent, { kind: 'error' }>;
    expect(entraErr).toEqual({
      kind: 'error',
      threadId: 't-entra',
      message: 'Entra: Invalid credential or expired OAuth token',
      authRequired: false,
    });

    svc.closeAll();
    entraSvc.closeAll();
  });

  it('propagates authRequired: true when code-driven Reviewer fails with 401 on a blank draft', async () => {
    const meta = makeThread({ id: 'thread-rev-auth', orchestratorProfile: 'OIM' });
    const svc = createService(meta);

    h.turnHandler = (session, _text, emit) => {
      if (session.options.agent) {
        // Orchestrator delegates to specialist, then ends with blank draft
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'spec-call-1',
                name: 'Agent',
                input: { subagent_type: 'oim-full', prompt: 'search' },
              },
            ],
          },
        });
        emit({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'spec-call-1',
                content: '[11111111-1111-1111-1111-111111111111] Evidence chunk',
              },
            ],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '   ', usage: {} });
      } else {
        // Reviewer fails with 401
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          api_error_status: 401,
          errors: ['Not logged in · Please run /login'],
          usage: {},
        });
      }
    };

    await svc.sendMessage(meta, 'Orchestrated question', {});
    await waitForEvent('turn-complete', 1);

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.isError).toBe(true);
    expect(complete.authRequired).toBe(true);
    expect(complete.errorMessage).toMatch(/^Claude: .*Sign in to Claude/i);

    svc.closeAll();
  });

  it('closes only stale session handles when replaced by a newer session on the same threadId without cancelling replacement clarifications', async () => {
    const meta = makeThread({ id: 'thread-stale-guard', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    let failFirstSession!: (err: Error) => void;
    let firstSessionReady!: () => void;
    const readyPromise = new Promise<void>((r) => {
      firstSessionReady = r;
    });

    let callNum = 0;
    h.turnHandler = (_session, _text, emit, failNext, id) => {
      callNum++;
      if (callNum === 1) {
        failFirstSession = failNext;
        firstSessionReady();
      } else {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `sdk-session-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'second ok', usage: {} });
      }
    };

    await svc.sendMessage(meta, 'Stalled turn 1', { playbook: 'oim-full' });
    await readyPromise;

    const staleSession = (svc as any).sessions.get(meta.id);
    const staleReviewerClose = vi.fn();
    staleSession.activeReviewerQuery = { close: staleReviewerClose };

    // Simulate session replacement (e.g. closeThread / profile reset followed by fresh session)
    (svc as any).sessions.delete(meta.id);
    staleSession.busy = true; // Even if stale session still thought it was busy before crashing

    await svc.sendMessage(meta, 'Replacement turn 2', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const replacementSession = (svc as any).sessions.get(meta.id);
    expect(replacementSession).toBeDefined();
    expect(replacementSession).not.toBe(staleSession);

    // Register an active clarification on the replacement session's threadId
    let clarificationCancelled = false;
    svc.pendingClarifications.set('replacement-q1', (ans) => {
      if (ans === '') clarificationCancelled = true;
    });
    (svc as any).threadClarifications.set(meta.id, new Set(['replacement-q1']));

    // Now the stale first session's stream rejects!
    failFirstSession(new Error('Stale subprocess crashed'));
    await new Promise((r) => setTimeout(r, 20));

    // Stale session's own handles were closed:
    expect(h.sessions[0].closeSpy).toHaveBeenCalled();
    expect(staleReviewerClose).toHaveBeenCalled();

    // Replacement session and its clarification MUST remain intact:
    expect((svc as any).sessions.get(meta.id)).toBe(replacementSession);
    expect(h.sessions[1].closed).toBe(false);
    expect(clarificationCancelled).toBe(false);
    expect(svc.pendingClarifications.has('replacement-q1')).toBe(true);

    svc.closeAll();
  });

  it('closeIdleSessions() closes idle warm sessions while leaving busy sessions running and preserving ThreadMeta.sessionId', async () => {
    const idleMeta = makeThread({ id: 'thread-idle', initialPlaybook: 'oim-full' });
    const busyMeta = makeThread({ id: 'thread-busy', initialPlaybook: 'oim-full' });
    const onSessionId = vi.fn((tid: string, sid: string) => {
      if (tid === idleMeta.id) idleMeta.sessionId = sid;
      if (tid === busyMeta.id) busyMeta.sessionId = sid;
    });
    const svc = createService(idleMeta, { onSessionId });

    // Turn finishes on idleMeta -> warm idle session
    await svc.sendMessage(idleMeta, 'Finish me', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    expect(idleMeta.sessionId).toBe('sdk-session-1');

    // Busy turn stays in-flight on busyMeta
    let finishBusyTurn!: () => void;
    h.turnHandler = (_session, _text, emit, _failNext, id) => {
      finishBusyTurn = () => {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `sdk-session-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'busy done', usage: {} });
      };
    };
    await svc.sendMessage(busyMeta, 'Keep me busy', { playbook: 'oim-full' });

    svc.closeIdleSessions();

    expect(h.sessions[0].closed).toBe(true);
    expect(h.sessions[1].closed).toBe(false);
    expect(idleMeta.sessionId).toBe('sdk-session-1');

    finishBusyTurn();
    await waitForEvent('turn-complete', 2);
    svc.closeAll();
  });

  it('protects reused warm session across await setModel() from closeIdleSessions(), concurrent sendMessage(), and warm-session eviction', async () => {
    const meta = makeThread({ id: 'thread-warm-starting', model: 'sonnet', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    // Turn 1 finishes -> session is warm and idle
    await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    expect(svc.isBusy(meta.id)).toBe(false);

    // Turn 2 switches model to opus and suspends inside setModel
    meta.model = 'opus';
    let releaseSetModel!: () => void;
    let enteredSetModel!: () => void;
    const inSetModel = new Promise<void>((r) => {
      enteredSetModel = r;
    });
    h.setModelImpl = () =>
      new Promise<void>((resolve) => {
        releaseSetModel = resolve;
        enteredSetModel();
      });

    const turn2Promise = svc.sendMessage(meta, 'Turn 2 with model switch', { playbook: 'oim-full' });
    await inSetModel;

    // While suspended in setModel, session must report busy and block concurrent sendMessage & closeIdleSessions
    expect(svc.isBusy(meta.id)).toBe(true);
    await expect(svc.sendMessage(meta, 'Concurrent turn', { playbook: 'oim-full' })).rejects.toThrow(
      'A turn is already running for this conversation.',
    );

    svc.closeIdleSessions();
    expect(h.sessions[0].closed).toBe(false);

    releaseSetModel();
    await turn2Promise;
    await waitForEvent('turn-complete', 2);
    expect(h.sessions).toHaveLength(1);

    svc.closeAll();
  });

  it('emits error event, calls onAuthFailure synchronously before emit, closes session, and rejects sendMessage when setModel throws', async () => {
    const meta = makeThread({ id: 'thread-setmodel-err', model: 'sonnet', initialPlaybook: 'oim-full' });
    const order: string[] = [];
    const svc = createService(meta, {
      onAuthFailure: () => {
        order.push('onAuthFailure');
      },
      emit: (e) => {
        order.push(`emit:${e.kind}:${String((e as { authRequired?: boolean }).authRequired)}`);
        events.push(e);
      },
    });

    await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);

    events = [];
    order.length = 0;
    meta.model = 'opus';
    h.setModelImpl = async () => {
      throw new Error('Not logged in · Please run /login');
    };

    await expect(svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-full' })).rejects.toThrow(
      'Not logged in · Please run /login',
    );

    expect(svc.isBusy(meta.id)).toBe(false);
    expect(h.sessions[0].closed).toBe(true);
    expect(order).toEqual(['onAuthFailure', 'emit:error:true']);
    expect(events).toEqual([
      {
        kind: 'error',
        threadId: meta.id,
        message: 'Claude: Claude session expired or not signed in. Sign in to Claude to continue.',
        authRequired: true,
      },
    ]);

    svc.closeAll();
  });

  it('rejects sendMessage rather than silently resolving undefined when closeThread() closes the session during setModel()', async () => {
    const meta = makeThread({ id: 'thread-closed-mid-start', model: 'sonnet', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);

    events = [];
    meta.model = 'opus';
    let releaseSetModel!: () => void;
    let enteredSetModel!: () => void;
    const inSetModel = new Promise<void>((r) => {
      enteredSetModel = r;
    });
    h.setModelImpl = () =>
      new Promise<void>((resolve) => {
        releaseSetModel = resolve;
        enteredSetModel();
      });

    const sendPromise = svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-full' });
    await inSetModel;

    // External caller closes thread while setModel is still awaiting
    svc.closeThread(meta.id);
    releaseSetModel();

    await expect(sendPromise).rejects.toThrow('Conversation session closed before turn could start.');
    expect(svc.isBusy(meta.id)).toBe(false);
    expect(events).toContainEqual({
      kind: 'error',
      threadId: meta.id,
      message: 'Claude: Conversation session closed before turn could start.',
      authRequired: false,
    });

    svc.closeAll();
  });
});

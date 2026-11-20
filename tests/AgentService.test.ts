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
    closeSpy: ReturnType<typeof vi.fn<() => void>>;
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
  onQueryCreate: null as (() => void) | null,
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
    h.onQueryCreate?.();

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

const { AgentService, claudeBinaryPath } = await import('../src/main/agent/AgentService');
const { resolveClaudeBinaryPath } = await import('../src/main/agent/ClaudeAuth');
const { ServerAuthRequiredError, ServerAuthTransientError } = await import('../src/main/auth/ServerAuth');
const { SyncApiError } = await import('../src/main/sync/SyncClient');

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
    h.onQueryCreate = null;
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
    h.onQueryCreate = null;
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
    expect(c1.errorMessage).toBe('Claude: 429 rate limit for API key exceeded');

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

  it('emits error event with authRequired: true, closes session, and rejects sendMessage when setModel throws', async () => {
    const meta = makeThread({ id: 'thread-setmodel-err', model: 'sonnet', initialPlaybook: 'oim-full' });
    const svc = createService(meta);

    await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);

    events = [];
    meta.model = 'opus';
    h.setModelImpl = async () => {
      throw new Error('Not logged in · Please run /login');
    };

    await expect(svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-full' })).rejects.toThrow(
      'Not logged in · Please run /login',
    );

    expect(svc.isBusy(meta.id)).toBe(false);
    expect(h.sessions[0].closed).toBe(true);
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
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.isBusy(meta.id)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events).toContainEqual({
      kind: 'error',
      threadId: meta.id,
      message: 'Claude: Conversation session closed before turn could start.',
      authRequired: false,
    });

    svc.closeAll();
  });

  it('sets serverAuthRequired: true strictly in entra mode for ServerAuthRequiredError / non-network Entra errors, omitting it in dev mode, for Entra network errors, and for Yvoke Backend errors', async () => {
    const entraSettings = (): AppSettings => ({ ...settings(), serverAuthMode: 'entra' });
    const devSettings = (): AppSettings => ({ ...settings(), serverAuthMode: 'dev' });

    // 1. Entra mode + ServerAuthRequiredError -> serverAuthRequired: true, authRequired: false
    events = [];
    const svcEntra = createService(makeThread({ id: 't-sa-entra' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthRequiredError();
        },
      } as never,
    });
    await expect(
      svcEntra.sendMessage(makeThread({ id: 't-sa-entra' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(events).toEqual([
      {
        kind: 'error',
        threadId: 't-sa-entra',
        message: 'Entra: Authentication session expired or invalid. Please sign in again.',
        authRequired: false,
        serverAuthRequired: true,
      },
    ]);
    svcEntra.closeAll();

    // 2. Dev mode + ServerAuthRequiredError -> serverAuthRequired MUST be omitted
    events = [];
    const svcDev = createService(makeThread({ id: 't-sa-dev' }), {
      getSettings: devSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthRequiredError();
        },
      } as never,
    });
    await expect(
      svcDev.sendMessage(makeThread({ id: 't-sa-dev' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(events).toEqual([
      {
        kind: 'error',
        threadId: 't-sa-dev',
        message: 'Entra: Authentication session expired or invalid. Please sign in again.',
        authRequired: false,
      },
    ]);
    expect('serverAuthRequired' in events[0]).toBe(false);
    svcDev.closeAll();

    // 3. Entra mode + Entra network error -> serverAuthRequired MUST be omitted
    events = [];
    const svcNet = createService(makeThread({ id: 't-sa-net' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new Error('Entra: fetch failed');
        },
      } as never,
    });
    await expect(
      svcNet.sendMessage(makeThread({ id: 't-sa-net' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toThrow('Entra: fetch failed');
    expect(events).toEqual([
      {
        kind: 'error',
        threadId: 't-sa-net',
        message: 'Entra: fetch failed',
        authRequired: false,
      },
    ]);
    expect('serverAuthRequired' in events[0]).toBe(false);
    svcNet.closeAll();

    // 4. Entra mode + Yvoke Backend error -> serverAuthRequired MUST be omitted
    events = [];
    const svcBackend = createService(makeThread({ id: 't-sa-be' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new Error('Yvoke Backend: 503 Service Unavailable');
        },
      } as never,
    });
    await expect(
      svcBackend.sendMessage(makeThread({ id: 't-sa-be' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toThrow('Yvoke Backend: 503 Service Unavailable');
    expect('serverAuthRequired' in events[0]).toBe(false);
    svcBackend.closeAll();
  });

  it('fetches mcpAuthProvider.headers() AFTER missing/locked playbook guards and BEFORE single-agent mcpPrompts loading and orchestrator profile lookup', async () => {
    const entraSettings = (): AppSettings => ({ ...settings(), serverAuthMode: 'entra' });

    // 1. Missing playbook guard runs BEFORE headers()
    const headersSpy1 = vi.fn().mockRejectedValue(new ServerAuthRequiredError());
    const svcMissing = createService(makeThread({ id: 't-guard-missing' }), {
      getSettings: entraSettings,
      mcpAuthProvider: { headers: headersSpy1 } as never,
    });
    await expect(
      svcMissing.sendMessage(makeThread({ id: 't-guard-missing' }), 'Q', { playbook: undefined }),
    ).rejects.toThrow(/A playbook must be selected/);
    expect(headersSpy1).not.toHaveBeenCalled();
    svcMissing.closeAll();

    // 2. Locked playbook guard runs BEFORE headers()
    const headersSpy2 = vi.fn().mockRejectedValue(new ServerAuthRequiredError());
    const svcLocked = createService(makeThread({ id: 't-guard-locked', initialPlaybook: 'oim-full' }), {
      getSettings: entraSettings,
      mcpAuthProvider: { headers: headersSpy2 } as never,
    });
    await expect(
      svcLocked.sendMessage(makeThread({ id: 't-guard-locked', initialPlaybook: 'oim-full' }), 'Q', {
        playbook: 'oim-unversioned',
      }),
    ).rejects.toThrow(/Cannot switch playbook/);
    expect(headersSpy2).not.toHaveBeenCalled();
    svcLocked.closeAll();

    // 3. Single-agent: headers() runs BEFORE mcpPrompts.list()
    events = [];
    const mcpListSpy = vi.fn().mockResolvedValue(PLAYBOOKS);
    const svcSingleOrder = createService(makeThread({ id: 't-order-single' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthRequiredError();
        },
      } as never,
      mcpPrompts: {
        list: mcpListSpy,
        getText: vi.fn(),
      } as never,
    });
    await expect(
      svcSingleOrder.sendMessage(makeThread({ id: 't-order-single' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(mcpListSpy).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ kind: 'error', serverAuthRequired: true });
    svcSingleOrder.closeAll();

    // 4. Orchestrator: headers() runs BEFORE getOrchestratorProfile() so auth failure is never masked as "profile unavailable"
    events = [];
    const getProfileSpy = vi.fn().mockResolvedValue(undefined);
    const svcOrchOrder = createService(makeThread({ id: 't-order-orch', orchestratorProfile: 'OIM' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthRequiredError();
        },
      } as never,
      getOrchestratorProfile: getProfileSpy,
    });
    await expect(
      svcOrchOrder.sendMessage(makeThread({ id: 't-order-orch', orchestratorProfile: 'OIM' }), 'Q', {}),
    ).rejects.toBeInstanceOf(ServerAuthRequiredError);
    expect(getProfileSpy).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ kind: 'error', serverAuthRequired: true });
    svcOrchOrder.closeAll();
  });

  it('propagates serverAuthRequired: true when code-driven Reviewer fails with ServerAuthRequiredError on a blank draft in entra mode', async () => {
    const meta = makeThread({ id: 'thread-rev-server-auth', orchestratorProfile: 'OIM' });
    let headerCalls = 0;
    const svc = createService(meta, {
      getSettings: () => ({ ...settings(), serverAuthMode: 'entra' }),
      mcpAuthProvider: {
        headers: async () => {
          headerCalls += 1;
          if (headerCalls === 1) {
            return { Authorization: 'Bearer ok-for-orchestrator' };
          }
          throw new ServerAuthRequiredError();
        },
      } as never,
    });

    h.turnHandler = (session, _text, emit) => {
      if (session.options.agent) {
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'spec-call-sa-1',
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
                tool_use_id: 'spec-call-sa-1',
                content: '[11111111-1111-1111-1111-111111111111] Evidence chunk',
              },
            ],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '   ', usage: {} });
      }
    };

    await svc.sendMessage(meta, 'Orchestrated question', {});
    await waitForEvent('turn-complete', 1);

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.isError).toBe(true);
    expect(complete.authRequired).toBe(false);
    expect(complete.serverAuthRequired).toBe(true);
    expect(complete.errorMessage).toMatch(/^Entra: /);

    svc.closeAll();
  });

  it('emits aborted turn-complete without persisting when an interrupted turn fails in consume() or exits its stream early', async () => {
    // 1. Interrupted turn whose stream throws an error
    const meta1 = makeThread({ id: 'thread-stop-throw', initialPlaybook: 'oim-full' });
    const onTurnPersist1 = vi.fn();
    const svc1 = createService(meta1, { onTurnPersist: onTurnPersist1 });
    let failTurn1!: (err: Error) => void;
    let ready1!: () => void;
    const readyPromise1 = new Promise<void>((r) => {
      ready1 = r;
    });

    h.turnHandler = (_s, _t, emit, failNext) => {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Partial answer before stop' }] },
      });
      failTurn1 = failNext;
      ready1();
    };

    await svc1.sendMessage(meta1, 'Q1', { playbook: 'oim-full' });
    await readyPromise1;
    await waitForEvent('assistant-block', 1);

    await svc1.interrupt(meta1.id);
    failTurn1(new Error('CLI process exited with code 143'));
    await waitForEvent('turn-complete', 1);

    const completes1 = events.filter((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >[];
    expect(completes1).toHaveLength(1);
    expect(completes1[0].isError).toBe(true);
    expect(completes1[0].aborted).toBe(true);
    expect(completes1[0].message.content).toBe('Partial answer before stop');
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(onTurnPersist1).not.toHaveBeenCalled();
    expect(svc1.isBusy(meta1.id)).toBe(false);
    svc1.closeAll();

    // 2. Interrupted turn whose stream exits cleanly without yielding a result message
    events = [];
    const meta2 = makeThread({ id: 'thread-stop-clean-eof', initialPlaybook: 'oim-full' });
    const onTurnPersist2 = vi.fn();
    const svc2 = createService(meta2, { onTurnPersist: onTurnPersist2 });
    let ready2!: () => void;
    const readyPromise2 = new Promise<void>((r) => {
      ready2 = r;
    });

    h.turnHandler = (_s, _t, emit) => {
      emit({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Partial answer before clean EOF' }] },
      });
      ready2();
    };

    await svc2.sendMessage(meta2, 'Q2', { playbook: 'oim-full' });
    await readyPromise2;
    await waitForEvent('assistant-block', 1);

    await svc2.interrupt(meta2.id);
    // Simulate CLI exiting cleanly (iterator returns done: true) without emitting a result message
    h.sessions[h.sessions.length - 1].closeSpy();
    await waitForEvent('turn-complete', 1);

    const completes2 = events.filter((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >[];
    expect(completes2).toHaveLength(1);
    expect(completes2[0].isError).toBe(true);
    expect(completes2[0].aborted).toBe(true);
    expect(completes2[0].message.content).toBe('Partial answer before clean EOF');
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
    expect(onTurnPersist2).not.toHaveBeenCalled();
    expect(svc2.isBusy(meta2.id)).toBe(false);
    svc2.closeAll();

    // 3. Uninterrupted turn whose stream exits cleanly without a result emits attributed error
    events = [];
    const meta3 = makeThread({ id: 'thread-unexpected-eof', initialPlaybook: 'oim-full' });
    const svc3 = createService(meta3);
    let ready3!: () => void;
    const readyPromise3 = new Promise<void>((r) => {
      ready3 = r;
    });
    h.turnHandler = () => {
      ready3();
    };
    await svc3.sendMessage(meta3, 'Q3', { playbook: 'oim-full' });
    await readyPromise3;
    h.sessions[h.sessions.length - 1].closeSpy();
    await waitForEvent('error', 1);
    expect(events.find((e) => e.kind === 'error')).toMatchObject({
      kind: 'error',
      threadId: meta3.id,
      message: 'Claude: Conversation session ended unexpectedly.',
      authRequired: false,
    });
    svc3.closeAll();
  });

  it('does not emit error or turn-complete from a replaced dead session when it crashes or exits early', async () => {
    const meta = makeThread({ id: 'thread-replaced-quiet', initialPlaybook: 'oim-full' });
    const svc = createService(meta);
    let failOld!: (err: Error) => void;
    let oldReady!: () => void;
    const oldReadyPromise = new Promise<void>((r) => {
      oldReady = r;
    });

    let calls = 0;
    h.turnHandler = (_s, _t, emit, failNext, id) => {
      calls += 1;
      if (calls === 1) {
        failOld = failNext;
        oldReady();
      } else {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `sdk-session-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'replacement ok', usage: {} });
      }
    };

    await svc.sendMessage(meta, 'Old turn', { playbook: 'oim-full' });
    await oldReadyPromise;
    const oldSession = (svc as any).sessions.get(meta.id);
    oldSession.interrupted = true;
    (svc as any).sessions.delete(meta.id);

    await svc.sendMessage(meta, 'New turn', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);

    // Clear events from the completed replacement turn, then crash the displaced old session
    events = [];
    failOld(new Error('Displaced CLI crashed'));
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual([]);
    svc.closeAll();
  });

  it('guards cold-start concurrency with startingThreads, aborts cold-start if closed mid-setup, and closes displaced session handles', async () => {
    // 1. Concurrent cold-start sendMessage() calls serialize cleanly with 1 subprocess
    const meta1 = makeThread({ id: 'thread-cold-race', initialPlaybook: 'oim-full' });
    let releaseHeaders!: () => void;
    let enteredHeaders!: () => void;
    const headersEntered = new Promise<void>((r) => {
      enteredHeaders = r;
    });
    const svc1 = createService(meta1, {
      mcpAuthProvider: {
        headers: () =>
          new Promise<Record<string, string>>((resolve) => {
            enteredHeaders();
            releaseHeaders = () => resolve({});
          }),
      } as never,
    });

    const p1 = svc1.sendMessage(meta1, 'First', { playbook: 'oim-full' });
    await headersEntered;
    expect(svc1.isBusy(meta1.id)).toBe(true);
    await expect(svc1.sendMessage(meta1, 'Second concurrent', { playbook: 'oim-full' })).rejects.toThrow(
      'A turn is already running for this conversation.',
    );

    releaseHeaders();
    await p1;
    await waitForEvent('turn-complete', 1);
    expect(h.sessions).toHaveLength(1);
    svc1.closeAll();

    // 2. Cold-start failure clears startingThreads so subsequent retry succeeds
    events = [];
    let shouldFailHeaders = true;
    const meta2 = makeThread({ id: 'thread-cold-retry', initialPlaybook: 'oim-full' });
    const svc2 = createService(meta2, {
      mcpAuthProvider: {
        headers: async () => {
          if (shouldFailHeaders) {
            shouldFailHeaders = false;
            throw new Error('Yvoke Backend: temporary error');
          }
          return {};
        },
      } as never,
    });
    await expect(svc2.sendMessage(meta2, 'Fail first', { playbook: 'oim-full' })).rejects.toThrow();
    expect(svc2.isBusy(meta2.id)).toBe(false);
    await svc2.sendMessage(meta2, 'Retry succeeds', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    svc2.closeAll();

    // 3. closeThread() during cold-start ensureSession() prevents storing a zombie session
    events = [];
    const meta3 = makeThread({ id: 'thread-cold-close', initialPlaybook: 'oim-full' });
    let releaseColdHeaders!: () => void;
    let enteredColdHeaders!: () => void;
    const coldHeadersEntered = new Promise<void>((r) => {
      enteredColdHeaders = r;
    });
    const svc3 = createService(meta3, {
      mcpAuthProvider: {
        headers: () =>
          new Promise<Record<string, string>>((resolve) => {
            enteredColdHeaders();
            releaseColdHeaders = () => resolve({});
          }),
      } as never,
    });
    const beforeCount = h.sessions.length;
    const coldPromise = svc3.sendMessage(meta3, 'Closed mid-cold-start', { playbook: 'oim-full' });
    await coldHeadersEntered;
    svc3.closeThread(meta3.id);
    releaseColdHeaders();

    await expect(coldPromise).rejects.toThrow('Conversation session closed before turn could start.');
    expect(svc3.isBusy(meta3.id)).toBe(false);
    expect((svc3 as any).sessions.has(meta3.id)).toBe(false);
    expect(h.sessions.length).toBe(beforeCount);
    svc3.closeAll();

    // 4. Displaced session during setModel() has its own query/queue/reviewer handles closed
    events = [];
    const meta4 = makeThread({ id: 'thread-displaced-setmodel', model: 'sonnet', initialPlaybook: 'oim-full' });
    const svc4 = createService(meta4);
    await svc4.sendMessage(meta4, 'Turn 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const originalQuerySession = h.sessions[h.sessions.length - 1];
    const originalThreadSession = (svc4 as any).sessions.get(meta4.id);
    const displacedReviewerClose = vi.fn();
    originalThreadSession.activeReviewerQuery = { close: displacedReviewerClose };

    meta4.model = 'opus';
    let releaseDisplacedSetModel!: () => void;
    let enteredDisplacedSetModel!: () => void;
    const displacedEntered = new Promise<void>((r) => {
      enteredDisplacedSetModel = r;
    });
    h.setModelImpl = () =>
      new Promise<void>((resolve) => {
        enteredDisplacedSetModel();
        releaseDisplacedSetModel = resolve;
      });
    const displacedPromise = svc4.sendMessage(meta4, 'Turn 2', { playbook: 'oim-full' });
    await displacedEntered;
    // Overwrite map entry WITHOUT calling closeThread() to verify line-410 teardown itself closes handles
    const dummyReplacement = { query: { close: vi.fn() }, queue: { close: vi.fn() }, busy: false, starting: false };
    (svc4 as any).sessions.set(meta4.id, dummyReplacement);
    releaseDisplacedSetModel();

    await expect(displacedPromise).rejects.toThrow('Conversation session closed before turn could start.');
    expect(originalQuerySession.closeSpy).toHaveBeenCalled();
    expect(displacedReviewerClose).toHaveBeenCalled();
    svc4.closeAll();
  });

  it('routes SyncApiError(401) as serverAuthRequired in entra mode, ignores ServerAuthTransientError, and never mislabels Yvoke Backend errors as Claude rate limits or auth errors', async () => {
    const entraSettings = (): AppSettings => ({ ...settings(), serverAuthMode: 'entra' });

    // 1. SyncApiError(401) in Entra mode -> serverAuthRequired: true, authRequired: false
    events = [];
    const svc401 = createService(makeThread({ id: 't-401-entra' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new SyncApiError(401, 'Yvoke Backend: Unauthorized');
        },
      } as never,
    });
    await expect(
      svc401.sendMessage(makeThread({ id: 't-401-entra' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toThrow();
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: 't-401-entra',
      message: 'Yvoke Backend: Unauthorized',
      authRequired: false,
      serverAuthRequired: true,
    });
    svc401.closeAll();

    // 2. ServerAuthTransientError in Entra mode -> serverAuthRequired omitted
    events = [];
    const svcTransient = createService(makeThread({ id: 't-trans-entra' }), {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthTransientError(new Error('503 Service Unavailable'));
        },
      } as never,
    });
    await expect(
      svcTransient.sendMessage(makeThread({ id: 't-trans-entra' }), 'Q', { playbook: 'oim-full' }),
    ).rejects.toBeInstanceOf(ServerAuthTransientError);
    expect('serverAuthRequired' in events[0]).toBe(false);
    svcTransient.closeAll();

    // 3. Unprefixed backend error in ensureSession() mentioning "rate limit" and "API key" stays Yvoke Backend with authRequired: false
    events = [];
    const svcBackendProse = createService(makeThread({ id: 't-be-prose', orchestratorProfile: 'OIM' }), {
      getSettings: entraSettings,
      getOrchestratorProfile: async () => {
        throw new Error('Upstream gateway rate limit exceeded for API key');
      },
    });
    await expect(
      svcBackendProse.sendMessage(makeThread({ id: 't-be-prose', orchestratorProfile: 'OIM' }), 'Q', {}),
    ).rejects.toThrow();
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: 't-be-prose',
      message: 'Yvoke Backend: Upstream gateway rate limit exceeded for API key',
      authRequired: false,
    });
    svcBackendProse.closeAll();
  });

  it('unifies claudeBinaryPath() with resolveClaudeBinaryPath()', () => {
    expect(claudeBinaryPath()).toBe(resolveClaudeBinaryPath());
  });

  it('emits 0 error or turn-complete events when closeThread() closes an active busy turn, and clears pendingUser and reviewState on exit', async () => {
    const meta1 = makeThread({ id: 'thread-close-active-eof', initialPlaybook: 'oim-full' });
    const svc = createService(meta1);
    let ready1!: () => void;
    const readyPromise1 = new Promise<void>((r) => {
      ready1 = r;
    });
    h.turnHandler = () => {
      ready1();
    };

    await svc.sendMessage(meta1, 'Active turn closed via closeThread', { playbook: 'oim-full' });
    await readyPromise1;
    const activeSession1 = (svc as any).sessions.get(meta1.id);
    activeSession1.reviewState = { originalQuestion: 'q' };
    expect(activeSession1.pendingUser).toBeDefined();

    // Clear turn-start event, then closeThread() mid-turn (clean EOF path)
    events = [];
    svc.closeThread(meta1.id);
    await new Promise((r) => setTimeout(r, 15));

    expect(events).toEqual([]);
    expect(activeSession1.pendingUser).toBeUndefined();
    expect(activeSession1.reviewState).toBeUndefined();

    // Also verify closeThread() mid-turn when the SDK stream rejects (catch path in consume)
    const meta1b = makeThread({ id: 'thread-close-active-reject', initialPlaybook: 'oim-full' });
    let failActive!: (err: Error) => void;
    let ready1b!: () => void;
    const readyPromise1b = new Promise<void>((r) => {
      ready1b = r;
    });
    h.turnHandler = (_s, _t, _emit, failNext) => {
      failActive = failNext;
      ready1b();
    };
    await svc.sendMessage(meta1b, 'Active turn closed then rejects', { playbook: 'oim-full' });
    await readyPromise1b;
    const activeSession1b = (svc as any).sessions.get(meta1b.id);
    events = [];
    // Simulate closeThread() removing session before query rejects with transport error
    (svc as any).sessions.delete(meta1b.id);
    failActive(new Error('Process terminated by closeThread'));
    await new Promise((r) => setTimeout(r, 15));
    expect(events).toEqual([]);
    expect(activeSession1b.pendingUser).toBeUndefined();
    expect(activeSession1b.reviewState).toBeUndefined();

    // Also verify completeTurn() clears pendingUser after a completed turn
    events = [];
    h.turnHandler = null;
    const meta2 = makeThread({ id: 'thread-clear-pending', initialPlaybook: 'oim-full' });
    await svc.sendMessage(meta2, 'Completed turn', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    const completedSession = (svc as any).sessions.get(meta2.id);
    expect(completedSession.pendingUser).toBeUndefined();
    expect(completedSession.reviewState).toBeUndefined();

    svc.closeAll();
  });

  it('tracks per-turn turnStartedAt on warm sessions so Turn 2 durationMs reflects Turn 2 rather than Turn 1', async () => {
    let fakeNow = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      const meta = makeThread({ id: 'thread-per-turn-duration', initialPlaybook: 'oim-full' });
      const svc = createService(meta);

      let emitTurn!: (m: unknown) => void;
      let turnReady!: () => void;
      let readyPromise = new Promise<void>((r) => {
        turnReady = r;
      });
      h.turnHandler = (_s, _t, emit) => {
        emitTurn = emit;
        turnReady();
      };

      // Turn 1: starts at 1_000, finishes at 1_150 -> durationMs === 150
      await svc.sendMessage(meta, 'Turn 1', { playbook: 'oim-full' });
      await readyPromise;
      fakeNow = 1_150;
      emitTurn({ type: 'result', subtype: 'success', is_error: false, result: 'ok 1', usage: {} });
      await waitForEvent('turn-complete', 1);
      const c1 = events.find((e) => e.kind === 'turn-complete') as Extract<
        AgentEvent,
        { kind: 'turn-complete' }
      >;
      expect(c1.durationMs).toBe(150);

      // Advance clock by 60 seconds while session stays warm & idle, then run Turn 2 (200ms)
      events = [];
      fakeNow = 61_000;
      readyPromise = new Promise<void>((r) => {
        turnReady = r;
      });
      await svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-full' });
      await readyPromise;
      fakeNow = 61_200;
      emitTurn({ type: 'result', subtype: 'success', is_error: false, result: 'ok 2', usage: {} });
      await waitForEvent('turn-complete', 1);
      const c2 = events.find((e) => e.kind === 'turn-complete') as Extract<
        AgentEvent,
        { kind: 'turn-complete' }
      >;
      expect(c2.durationMs).toBe(200);

      svc.closeAll();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('protects a warm session in startingThreads from MAX_WARM_SESSIONS eviction during a concurrent cold-start sendMessage()', async () => {
    const t1 = makeThread({ id: 'thread-evict-1', initialPlaybook: 'oim-full' });
    const t2 = makeThread({ id: 'thread-evict-2', initialPlaybook: 'oim-full' });
    const t3 = makeThread({ id: 'thread-evict-3', initialPlaybook: 'oim-full' });
    const t4 = makeThread({ id: 'thread-evict-4', initialPlaybook: 'oim-full' });

    let blockT1Headers = false;
    let releaseT1Headers!: () => void;
    let enteredT1Headers!: () => void;
    const t1HeadersEntered = new Promise<void>((r) => {
      enteredT1Headers = r;
    });

    let headerCallCount = 0;
    const svc = createService(t1, {
      mcpAuthProvider: {
        headers: () => {
          headerCallCount += 1;
          if (blockT1Headers && headerCallCount === 4) {
            return new Promise<Record<string, string>>((resolve) => {
              enteredT1Headers();
              releaseT1Headers = () => resolve({});
            });
          }
          return Promise.resolve({});
        },
      } as never,
    });

    // Warm up 3 sessions: t1 (oldest), t2, t3
    await svc.sendMessage(t1, 'Warm 1', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 1);
    (svc as any).sessions.get(t1.id).lastActiveAt = 100;

    await svc.sendMessage(t2, 'Warm 2', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 2);
    (svc as any).sessions.get(t2.id).lastActiveAt = 200;

    await svc.sendMessage(t3, 'Warm 3', { playbook: 'oim-full' });
    await waitForEvent('turn-complete', 3);
    (svc as any).sessions.get(t3.id).lastActiveAt = 300;

    // Now start Turn 2 on oldest thread t1: it enters startingThreads and suspends inside headers() (BEFORE session.starting = true!)
    blockT1Headers = true;
    const t1Turn2 = svc.sendMessage(t1, 'Turn 2 on t1', { playbook: 'oim-full' });
    await t1HeadersEntered;
    expect(svc.isBusy(t1.id)).toBe(true);
    expect((svc as any).sessions.get(t1.id).starting).toBe(false);

    // Concurrently cold-start t4 -> triggers MAX_WARM_SESSIONS eviction; must evict t2, NOT t1!
    const t4Turn = svc.sendMessage(t4, 'Cold start t4', { playbook: 'oim-full' });
    await t4Turn;
    await waitForEvent('turn-complete', 4);

    expect(h.sessions[0].closed).toBe(false); // t1 protected!
    expect(h.sessions[1].closed).toBe(true); // t2 evicted!

    releaseT1Headers();
    await t1Turn2;
    await waitForEvent('turn-complete', 5);
    svc.closeAll();
  });

  it('attributes pre-start closeThread() errors (post-await and post-query) to Claude without serverAuthRequired while preserving Yvoke Backend attribution for real ensureSession() failures', async () => {
    const entraSettings = (): AppSettings => ({ ...settings(), serverAuthMode: 'entra' });

    // 1. L921 path: closeThread() during async ensureSession() in entra mode
    events = [];
    const meta1 = makeThread({ id: 'thread-close-post-await', initialPlaybook: 'oim-full' });
    let releaseHeaders!: () => void;
    let enteredHeaders!: () => void;
    const headersEntered = new Promise<void>((r) => {
      enteredHeaders = r;
    });
    const svc1 = createService(meta1, {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: () =>
          new Promise<Record<string, string>>((resolve) => {
            enteredHeaders();
            releaseHeaders = () => resolve({});
          }),
      } as never,
    });
    const sessionsBefore1 = h.sessions.length;
    const p1 = svc1.sendMessage(meta1, 'Close mid-await', { playbook: 'oim-full' });
    await headersEntered;
    svc1.closeThread(meta1.id);
    releaseHeaders();

    await expect(p1).rejects.toThrow('Conversation session closed before turn could start.');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: meta1.id,
      message: 'Claude: Conversation session closed before turn could start.',
      authRequired: false,
    });
    expect('serverAuthRequired' in events[0]).toBe(false);
    expect(svc1.isBusy(meta1.id)).toBe(false);
    expect((svc1 as any).sessions.has(meta1.id)).toBe(false);
    expect(h.sessions.length).toBe(sessionsBefore1);
    svc1.closeAll();

    // 2. L955 path: closeThread() synchronously during query() creation in entra mode
    events = [];
    const meta2 = makeThread({ id: 'thread-close-post-query', initialPlaybook: 'oim-full' });
    const svc2 = createService(meta2, { getSettings: entraSettings });
    h.onQueryCreate = () => {
      h.onQueryCreate = null;
      svc2.closeThread(meta2.id);
    };

    await expect(svc2.sendMessage(meta2, 'Close during query()', { playbook: 'oim-full' })).rejects.toThrow(
      'Conversation session closed before turn could start.',
    );
    const createdQuery = h.sessions[h.sessions.length - 1];
    expect(createdQuery.closeSpy).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: meta2.id,
      message: 'Claude: Conversation session closed before turn could start.',
      authRequired: false,
    });
    expect('serverAuthRequired' in events[0]).toBe(false);
    expect(svc2.isBusy(meta2.id)).toBe(false);
    expect((svc2 as any).sessions.has(meta2.id)).toBe(false);
    svc2.closeAll();

    // 3. Negative non-shadowing: genuine ensureSession() ServerAuthRequiredError & Yvoke Backend errors in entra mode
    events = [];
    const meta3 = makeThread({ id: 'thread-genuine-server-auth', initialPlaybook: 'oim-full' });
    const svc3 = createService(meta3, {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new ServerAuthRequiredError();
        },
      } as never,
    });
    await expect(svc3.sendMessage(meta3, 'Needs Entra sign-in', { playbook: 'oim-full' })).rejects.toBeInstanceOf(
      ServerAuthRequiredError,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: meta3.id,
      message: 'Entra: Authentication session expired or invalid. Please sign in again.',
      authRequired: false,
      serverAuthRequired: true,
    });
    svc3.closeAll();

    events = [];
    const meta4 = makeThread({ id: 'thread-genuine-backend-err', initialPlaybook: 'oim-full' });
    const svc4 = createService(meta4, {
      getSettings: entraSettings,
      mcpAuthProvider: {
        headers: async () => {
          throw new Error('Gateway 502 Bad Gateway');
        },
      } as never,
    });
    await expect(svc4.sendMessage(meta4, 'Backend 502', { playbook: 'oim-full' })).rejects.toThrow(
      'Gateway 502 Bad Gateway',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'error',
      threadId: meta4.id,
      message: 'Yvoke Backend: Gateway 502 Bad Gateway',
      authRequired: false,
    });
    expect('serverAuthRequired' in events[0]).toBe(false);
    svc4.closeAll();
  });
});

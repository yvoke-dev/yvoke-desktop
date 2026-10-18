import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_SYSTEM_PROMPT_NAME,
  MCP_SERVER_NAME,
  type AgentEvent,
  type AppSettings,
  type McpPromptInfo,
  type OrchestratorProfile,
  type ThreadMeta,
} from '../src/shared/types';
import { buildMcpServers } from '../src/main/agent/McpConnection';
import {
  MAX_REVISION_PROMPT_CHARS,
  ORCHESTRATOR_AGENT,
  REVIEW_FEEDBACK_HEADING,
  unreviewedNote,
} from '../src/main/agent/orchestration';

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
    rawPushed: unknown[];
    closed: boolean;
    closeSpy: ReturnType<typeof vi.fn>;
    interruptSpy: ReturnType<typeof vi.fn>;
    setMcpServersSpy: ReturnType<typeof vi.fn>;
    setModelSpy: ReturnType<typeof vi.fn>;
  }[],
  nextQueryError: null as Error | null,
  nextQueryResult: null as Record<string, unknown> | null,
  setMcpServersImpl: null as ((session: any, servers: any) => Promise<any>) | null,
  turnHandler: null as
    | ((session: any, promptText: string, emit: (m: unknown) => void, id: number) => Promise<void> | void)
    | null,
}));

// Partial mock: only `query` is replaced. The rest is real, because the in-process compute server
// is built with the SDK's own `createSdkMcpServer` on the way to every session.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const query = ({
    prompt,
    options,
  }: {
    prompt: string | AsyncIterable<{ message: { content: string } }>;
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
    const interruptSpy = vi.fn(async () => {
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
    const setModelSpy = vi.fn(async () => undefined);
    const session = {
      options,
      pushed: [] as string[],
      rawPushed: [] as unknown[],
      closed: false,
      closeSpy,
      interruptSpy,
      setMcpServersSpy,
      setModelSpy,
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

    const runDefaultTurn = () => {
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
    };

    void (async () => {
      if (typeof prompt === 'string') {
        session.rawPushed.push(prompt);
        session.pushed.push(prompt);
        if (h.turnHandler) {
          await h.turnHandler(session, prompt, emit, id);
        } else {
          runDefaultTurn();
        }
        return;
      }
      for await (const msg of prompt) {
        session.rawPushed.push(msg.message.content);
        const text =
          typeof msg.message.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message.content);
        session.pushed.push(text);
        if (h.turnHandler) {
          await h.turnHandler(session, text, emit, id);
        } else {
          runDefaultTurn();
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
      setModel: setModelSpy,
      setMaxThinkingTokens: async () => undefined,
      interrupt: interruptSpy,
      close: closeSpy,
      setMcpServers: setMcpServersSpy,
    };
  };
  const createSdkMcpServer = (cfg: Record<string, any>) => {
    const res = actual.createSdkMcpServer(cfg as any);
    const handlers: Record<string, (args: any) => Promise<any>> = {};
    for (const t of (cfg.tools as Array<{ name?: string; handler?: (args: any, extra: any) => Promise<any> }>) ?? []) {
      if (t && typeof t.name === 'string' && typeof t.handler === 'function') {
        const fn = t.handler;
        handlers[t.name] = (args: any) => fn(args, {});
      }
    }
    return Object.assign(res, { _testHandlers: handlers });
  };
  return { ...actual, query, createSdkMcpServer };
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
    },
  } as AppSettings;
}

function thread(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id: 'thread-1',
    title: 'T',
    model: 'sonnet',
    thinkingLevel: 'medium',
    createdAt: '',
    updatedAt: '',
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    syncState: 'synced',
    ...overrides,
  };
}

let sandboxDir: string;
let events: AgentEvent[];

/** A service wired to a thread, mirroring how AppCore persists the session id back onto the meta. */
function makeService(
  meta: ThreadMeta,
  overrides: Partial<ConstructorParameters<typeof AgentService>[0]> = {},
) {
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
    ...overrides,
  });
}

/** Ask one question under `playbookName` and wait for the turn to come back. */
async function ask(
  svc: InstanceType<typeof AgentService>,
  meta: ThreadMeta,
  text: string,
  playbookName?: string,
): Promise<void> {
  const before = events.filter((e) => e.kind === 'turn-complete').length;
  await svc.sendMessage(meta, text, {
    playbook: playbookName,
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
  h.turnHandler = null;
  events = [];
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-agent-'));
});

afterEach(() => {
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

describe('playbook injection across a session', () => {
  it('combines system prompt and playbook instructions in systemPrompt, and passes raw user input', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    await ask(svc, meta, 'Follow-up question', 'oim-schema');

    expect(h.sessions).toHaveLength(1); // stayed warm — no restart for an unchanged playbook
    expect(h.sessions[0].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );
    expect(h.sessions[0].pushed).toEqual([
      'First question',
      'Follow-up question',
    ]);
    svc.closeAll();
  });

  it('rejects switching playbooks mid-conversation on an existing thread session', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    expect(meta.sessionId).toBe('sdk-session-1');
    await expect(ask(svc, meta, 'Different area question', 'oim-customers')).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session/,
    );

    expect(h.sessions).toHaveLength(1); // session was not replaced
    svc.closeAll();
  });

  it('rejects switching from a playbook to no playbook on an existing thread session', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    await expect(ask(svc, meta, 'Second question without playbook', undefined)).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session \(locked to "oim-schema", requested "none"\)/,
    );

    expect(h.sessions).toHaveLength(1);
    svc.closeAll();
  });

  it('rejects switching from no playbook to a playbook on an existing thread session', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', undefined);
    await expect(ask(svc, meta, 'Second question with playbook', 'oim-schema')).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session \(locked to "none", requested "oim-schema"\)/,
    );

    expect(h.sessions).toHaveLength(1);
    svc.closeAll();
  });

  it('does not prepend playbook text when user message includes image attachments', async () => {
    const meta = thread();
    const svc = makeService(meta);
    const before = events.filter((e) => e.kind === 'turn-complete').length;

    await svc.sendMessage(meta, 'Question with image', {
      playbook: 'oim-schema',
      images: [
        {
          id: 'img-1',
          mediaType: 'image/png',
          data: 'base64data',
          name: 'diagram.png',
        },
      ],
    });
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );
    expect(h.sessions[0].rawPushed).toEqual([
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
        },
        {
          type: 'text',
          text: 'Question with image',
        },
      ],
    ]);
    svc.closeAll();
  });

  it('combines system prompt and playbook instructions when the conversation is resumed cold', async () => {
    const meta = thread();
    const first = makeService(meta);
    await ask(first, meta, 'First question', 'oim-schema');
    first.closeAll();

    // App restart: a fresh service, no warm sessions, but the thread remembers its transcript.
    h.sessions.length = 0;
    const second = makeService(meta);
    await ask(second, meta, 'Follow-up question', 'oim-schema');

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.resume).toBe('sdk-session-1');
    expect(h.sessions[0].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );
    expect(h.sessions[0].pushed).toEqual([
      'Follow-up question',
    ]);
    second.closeAll();
  });

  it('keeps session warm across three turns with raw user input and rejects mid-conversation switch on turn 3', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First turn', 'oim-schema');
    await ask(svc, meta, 'Second turn', 'oim-schema');
    await ask(svc, meta, 'Third turn', 'oim-schema');

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );
    expect(h.sessions[0].pushed).toEqual([
      'First turn',
      'Second turn',
      'Third turn',
    ]);

    // Attempting to switch playbook on turn 4 rejects
    await expect(ask(svc, meta, 'Fourth turn switch', 'oim-customers')).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session/,
    );
    expect(h.sessions).toHaveLength(1);
    svc.closeAll();
  });

  it('combines system prompt with empty playbook text when getText returns empty string', async () => {
    const meta = thread();
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async () => '',
      } as never,
    });

    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Question with empty playbook body', {
      playbook: 'oim-schema',
    });
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.systemPrompt).toBe('BASE SYSTEM PROMPT\n\n---\n\n');
    expect(h.sessions[0].pushed).toEqual(['Question with empty playbook body']);
    svc.closeAll();
  });

  it('fails closed when getText throws a backend error during prompt resolution', async () => {
    const meta = thread();
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async () => {
          throw new Error('Playbook file unreadable');
        },
      } as never,
    });

    await expect(
      svc.sendMessage(meta, 'Question with unreadable playbook', {
        playbook: 'oim-schema',
      }),
    ).rejects.toThrow(/Playbook metadata for "oim-schema" could not be loaded: Playbook file unreadable/);

    expect(h.sessions).toHaveLength(0);
    svc.closeAll();
  });

  it('prepends nothing when the question carries no playbook', async () => {
    const meta = thread();
    const svc = makeService(meta);
    await svc.sendMessage(meta, 'Bare question', {});
    for (let i = 0; i < 200 && events.every((e) => e.kind !== 'turn-complete'); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.sessions[0].options.systemPrompt).toBe('BASE SYSTEM PROMPT');
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

  it('deduplicates remote system prompt requests across roles in an orchestrator profile via memoizedLoadPrompt', async () => {
    const meta = thread();
    meta.orchestratorProfile = 'OIM';
    const getSystemPromptSpy = vi.fn().mockImplementation(async (name: string) => `PROMPT(${name})`);
    const customPlaybooks: McpPromptInfo[] = [
      {
        name: 'oim-schema',
        title: 'Schema',
        description: 'Tables.',
        arguments: [],
        tools: ['get_section'],
        systemPrompt: 'shared-schema-prompt',
      },
      {
        name: 'oim-customers',
        title: 'Customers',
        description: 'Accounts.',
        arguments: [],
        tools: ['search_corpus'],
      },
    ];
    const svc = makeService(meta, {
      syncClient: { getSystemPrompt: getSystemPromptSpy } as never,
      mcpPrompts: {
        list: async () => customPlaybooks,
        getText: async (name: string) => TEXT[name] ?? 'INSTRUCTIONS',
      } as never,
    });

    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Multi-agent question', {});
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    const callsForShared = getSystemPromptSpy.mock.calls.filter(([name]) => name === 'shared-schema-prompt');
    expect(callsForShared).toHaveLength(1);
    svc.closeAll();
  });

  it('passes the playbook designated system prompt to single-agent session options', async () => {
    const meta = thread();
    const customPlaybooks: McpPromptInfo[] = [
      {
        name: 'custom-playbook',
        title: 'Custom',
        description: 'Custom playbook.',
        arguments: [],
        tools: ['search_corpus'],
        systemPrompt: 'custom-designated-prompt',
      },
    ];
    const getSystemPromptSpy = vi.fn().mockImplementation(async (name: string) => `BODY OF ${name}`);
    const svc = makeService(meta, {
      syncClient: { getSystemPrompt: getSystemPromptSpy } as never,
      mcpPrompts: {
        list: async () => customPlaybooks,
        getText: async () => 'PLAYBOOK BODY',
      } as never,
    });

    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Hello single agent', {
      playbook: 'custom-playbook',
    });
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(getSystemPromptSpy).toHaveBeenCalledWith('custom-designated-prompt');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.systemPrompt).toBe('BODY OF custom-designated-prompt\n\n---\n\nPLAYBOOK BODY');
    svc.closeAll();
  });

  it('ignores thread playbook designated prompt in orchestrator mode, using default-chat as base', async () => {
    const meta = thread();
    meta.orchestratorProfile = 'OIM';
    const customPlaybooks: McpPromptInfo[] = [
      {
        name: 'custom-playbook',
        title: 'Custom',
        description: 'Custom playbook.',
        arguments: [],
        tools: ['search_corpus'],
        systemPrompt: 'custom-designated-prompt',
      },
      {
        name: 'oim-orchestrator',
        title: 'Orchestrator',
        description: 'Orchestrator playbook',
        arguments: [],
        tools: [],
      },
    ];
    const getSystemPromptSpy = vi.fn().mockImplementation(async (name: string) => `BODY OF ${name}`);
    const svc = makeService(meta, {
      syncClient: { getSystemPrompt: getSystemPromptSpy } as never,
      mcpPrompts: {
        list: async () => customPlaybooks,
        getText: async () => 'PLAYBOOK BODY',
      } as never,
    });

    const before = events.filter((e) => e.kind === 'turn-complete').length;
    await svc.sendMessage(meta, 'Hello orchestrator', {
      playbook: 'custom-playbook',
    });
    for (let i = 0; i < 200; i++) {
      if (events.filter((e) => e.kind === 'turn-complete').length > before) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    // In orchestrator mode, the base prompt must be default-chat, NOT custom-designated-prompt
    expect(getSystemPromptSpy).toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
    expect(getSystemPromptSpy).not.toHaveBeenCalledWith('custom-designated-prompt');
    expect(h.sessions).toHaveLength(1);
    const agents = h.sessions[0].options.agents as Record<string, { prompt: string }> | undefined;
    const orchPrompt = agents?.[ORCHESTRATOR_AGENT]?.prompt;
    expect(orchPrompt).toContain(`BODY OF ${BASE_SYSTEM_PROMPT_NAME}`);
    expect(orchPrompt).not.toContain('BODY OF custom-designated-prompt');
    svc.closeAll();
  });

  it('fails closed when playbook metadata lookup throws an Entra error', async () => {
    const meta = thread();
    const entraError = new Error('Entra: Interactive login required');
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => {
          throw entraError;
        },
      } as never,
    });

    await expect(
      svc.sendMessage(meta, 'Hello', {
        playbook: 'custom-playbook',
      }),
    ).rejects.toBe(entraError);
    svc.closeAll();
  });

  it('fails closed when playbook metadata lookup throws a backend error', async () => {
    const meta = thread();
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => {
          throw new Error('500 Internal Server Error');
        },
      } as never,
    });

    await expect(
      svc.sendMessage(meta, 'Hello', {
        playbook: 'custom-playbook',
      }),
    ).rejects.toThrow(/Playbook metadata for "custom-playbook" could not be loaded/);
    svc.closeAll();
  });

  it('Negative 1.3.1: session eviction & cold session re-locking enforces lock against divergent playbook and resumes under initialPlaybook', async () => {
    const meta = thread();
    meta.initialPlaybook = 'oim-schema';
    const svc = makeService(meta);

    // Turn 1 on cold thread with initialPlaybook
    await ask(svc, meta, 'First question', 'oim-schema');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );

    // Evict session from memory (e.g. by closing or simulating warm session eviction)
    svc.closeThread(meta.id);
    expect(h.sessions[0].closed).toBe(true);

    // Attempting to send on cold thread with divergent playbook throws locking error
    await expect(ask(svc, meta, 'Divergent question', 'oim-customers')).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session/,
    );

    // Resending on cold thread with locked initialPlaybook succeeds and rebuilds session under oim-schema
    await ask(svc, meta, 'Valid follow-up', 'oim-schema');
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1].options.systemPrompt).toBe(
      'BASE SYSTEM PROMPT\n\n---\n\nSCHEMA PLAYBOOK INSTRUCTIONS',
    );
    svc.closeAll();
  });

  it('Negative 1.3.2: mcpPrompts failure & attribution attributes generic errors to Yvoke Backend and emits error event', async () => {
    const meta = thread();
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async () => {
          throw new Error('500 Internal Server Error in playbook prompt fetch');
        },
      } as never,
    });

    await expect(
      svc.sendMessage(meta, 'Question with failing getText', {
        playbook: 'oim-schema',
      }),
    ).rejects.toThrow(/Yvoke Backend: Playbook metadata for "oim-schema" could not be loaded: 500 Internal Server Error/);

    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('Yvoke Backend: Playbook metadata for "oim-schema" could not be loaded: 500 Internal Server Error');
    svc.closeAll();
  });

  it('Negative 1.3.3: Entra token expiry preservation preserves Entra error prefix without wrapping in Yvoke Backend', async () => {
    const meta = thread();
    const svc = makeService(meta, {
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async () => {
          throw new Error('Entra: Authentication token expired. Please re-authenticate.');
        },
      } as never,
    });

    await expect(
      svc.sendMessage(meta, 'Question with expired token', {
        playbook: 'oim-schema',
      }),
    ).rejects.toThrow('Entra: Authentication token expired. Please re-authenticate.');

    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toBe('Entra: Authentication token expired. Please re-authenticate.');
    expect(errorEvent?.message).not.toContain('Yvoke Backend');
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
      svc.sendMessage(meta, 'Second question while busy', { playbook: 'oim-customers' }),
    ).rejects.toThrow('A turn is already running for this conversation.');

    expect(closeSpy).not.toHaveBeenCalled();
    expect(svc.isBusy(meta.id)).toBe(true);
    svc.closeAll();
  });

  it('Test 1.9: Session config change handling in ensureSession rejects playbook changes on an existing session', async () => {
    const meta = thread();
    const svc = makeService(meta);

    await ask(svc, meta, 'First question', 'oim-schema');
    const initialSession = (svc as any).sessions.get(meta.id);
    expect(initialSession.playbookName).toBe('oim-schema');

    await expect(ask(svc, meta, 'Second question with new playbook', 'oim-customers')).rejects.toThrow(
      /Cannot switch playbook on an existing conversation session/,
    );
    const existingSession = (svc as any).sessions.get(meta.id);
    expect(existingSession.playbookName).toBe('oim-schema');
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
      playbook: 'oim-schema',
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
    await expect(svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-schema' })).rejects.toThrow(
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

  it('11c. Failed MCP update when session became busy mid-wait does not close session and rejects without emitting error event', async () => {
    const meta = thread();
    let currentAuth = 'Bearer token-1';
    const svc = makeAuthService(meta, async () => ({ Authorization: currentAuth }));

    await ask(svc, meta, 'Turn 1', 'oim-schema');
    expect(h.sessions).toHaveLength(1);
    const initialSession = h.sessions[0];

    currentAuth = 'Bearer token-race-update-failed';
    // During the setMcpServers call, the session becomes busy (e.g. concurrent turn started) and the update fails
    h.setMcpServersImpl = async () => {
      const activeSession = (svc as any).sessions.get(meta.id);
      if (activeSession) {
        activeSession.busy = true;
      }
      return { added: [], removed: [], errors: { [MCP_SERVER_NAME]: 'Failed to connect' } };
    };

    const prevErrorEvents = events.filter((e) => e.kind === 'error');
    await expect(svc.sendMessage(meta, 'Turn 2', { playbook: 'oim-schema' })).rejects.toThrow(
      'A turn is already running for this conversation.',
    );
    // Crucial: ensure no error event was emitted and active session was NOT closed mid-turn
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(prevErrorEvents.length);
    expect(initialSession.closeSpy).not.toHaveBeenCalled();
    expect((svc as any).sessions.get(meta.id)).toBeDefined();

    svc.closeAll();
  });
});

describe('completeTurn error handling with isResultFailure', () => {
  it('treats SDK result with subtype "success" and is_error: true as a failed turn', async () => {
    const meta = thread();
    const onTurnPersist = vi.fn();
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId, profile) => {
        meta.sessionId = sessionId;
        meta.sessionProfile = profile;
      },
      onTurnPersist,
      sandboxDir,
      syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => TEXT[name] ?? 'INSTRUCTIONS',
      } as never,
      getOrchestratorProfile: async () => undefined,
    });

    h.nextQueryResult = {
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      usage: {},
    };

    await ask(svc, meta, 'Test query', 'oim-schema');

    const completeEvents = events.filter((e) => e.kind === 'turn-complete');
    expect(completeEvents).toHaveLength(1);
    const complete = completeEvents[0] as Extract<AgentEvent, { kind: 'turn-complete' }>;
    expect(complete.isError).toBe(true);
    expect(complete.message.content).toBe('');
    expect(complete.errorMessage).toBe('Claude: Not logged in · Please run /login');
    expect(onTurnPersist).not.toHaveBeenCalled();

    svc.closeAll();
  });

  it('treats SDK result with non-success subtype as a failed turn even when is_error is false', async () => {
    const meta = thread();
    const onTurnPersist = vi.fn();
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (_threadId, sessionId, profile) => {
        meta.sessionId = sessionId;
        meta.sessionProfile = profile;
      },
      onTurnPersist,
      sandboxDir,
      syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => TEXT[name] ?? 'INSTRUCTIONS',
      } as never,
      getOrchestratorProfile: async () => undefined,
    });

    h.nextQueryResult = {
      subtype: 'error_during_execution',
      is_error: false,
      errors: ['Process crashed unexpectedly'],
      usage: {},
    };

    await ask(svc, meta, 'Test query', 'oim-schema');

    const completeEvents = events.filter((e) => e.kind === 'turn-complete');
    expect(completeEvents).toHaveLength(1);
    const complete = completeEvents[0] as Extract<AgentEvent, { kind: 'turn-complete' }>;
    expect(complete.isError).toBe(true);
    expect(complete.message.content).toBe('');
    expect(complete.errorMessage).toBe('Claude: error_during_execution');
    expect(onTurnPersist).not.toHaveBeenCalled();

    svc.closeAll();
  });
});

describe('canonical model mapping', () => {
  it('maps model aliases to canonical 5.5 wire IDs when spawning session and switching models', async () => {
    const meta = thread({ model: 'sonnet' });
    const svc = makeService(meta);

    await ask(svc, meta, 'First turn', 'oim-schema');
    expect(h.sessions[0].options.model).toBe('claude-sonnet-5-5');

    // Switch model to opus alias
    meta.model = 'opus';
    await ask(svc, meta, 'Second turn', 'oim-schema');
    expect(h.sessions[0].setModelSpy).toHaveBeenCalledWith('claude-opus-5-5');

    svc.closeAll();
  });
});

describe('background execution is switched off in the CLI environment', () => {
  const FLAG = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';
  const inherited = process.env[FLAG];

  afterEach(() => {
    if (inherited === undefined) delete process.env[FLAG];
    else process.env[FLAG] = inherited;
  });

  // Delegation must be synchronous, and nothing in this app can make it so except the CLI's own
  // switch: the Agent tool is never routed through `canUseTool` for the orchestrator agent (observed
  // live), so a `run_in_background: false` rewrite there is never reached, and the model passes no
  // such argument by itself. Without the switch every specialist and reviewer call came back as
  // "Async agent launched successfully" instead of an answer.
  it('is set on an orchestrator session, where delegation happens', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);
    await ask(svc, meta, 'Multi-agent question');

    expect(h.sessions).toHaveLength(1);
    const env = h.sessions[0].options.env as Record<string, string | undefined>;
    expect(env[FLAG]).toBe('1');
    svc.closeAll();
  });

  it('is set on a single-agent session too', async () => {
    const meta = thread();
    const svc = makeService(meta);
    await ask(svc, meta, 'Plain question', 'oim-schema');

    const env = h.sessions[0].options.env as Record<string, string | undefined>;
    expect(env[FLAG]).toBe('1');
    svc.closeAll();
  });

  it('wins over a value inherited from the environment the app was started in', async () => {
    process.env[FLAG] = '0';
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);
    await ask(svc, meta, 'Multi-agent question');

    const env = h.sessions[0].options.env as Record<string, string | undefined>;
    expect(env[FLAG]).toBe('1');
    svc.closeAll();
  });
});

describe('code-driven multi-agent reviewer loop (yvoke-web parity)', () => {
  const CITED_ID = '11111111-2222-3333-4444-555555555555';
  const UNCITED_ID = '99999999-8888-7777-6666-555555555555';
  const DOC_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const SEARCH_RESULT_TWO_CHUNKS = [
    'Found 2 chunks:',
    `### doc/Schema Guide  (score=0.912  id=${CITED_ID}  doc_id=${DOC_ID})`,
    '_Section: Tables_',
    'The USR table stores user accounts in OIM.',
    '',
    `### doc/Unrelated Guide  (score=0.511  id=${UNCITED_ID}  doc_id=${DOC_ID})`,
    '_Section: Misc_',
    'This uncited chunk body must never be sent to the reviewer.',
  ].join('\n');

  function emitSpecialistDelegation(
    emit: (m: unknown) => void,
    callId: string,
    subagentType: string,
    toolResultText: string,
  ): void {
    // 1. Orchestrator delegates to specialist
    emit({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: 'Agent',
            input: { subagent_type: subagentType, prompt: 'Find schema tables' },
          },
        ],
      },
    });
    // 2. Specialist runs search_corpus tool inside its own sub-agent turn (parent_tool_use_id = callId)
    const innerToolId = `${callId}-search`;
    emit({
      type: 'assistant',
      parent_tool_use_id: callId,
      message: {
        content: [
          {
            type: 'tool_use',
            id: innerToolId,
            name: 'mcp__yvoke__search_corpus',
            input: { query: 'USR table' },
          },
        ],
      },
    });
    emit({
      type: 'user',
      parent_tool_use_id: callId,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: innerToolId,
            content: toolResultText,
          },
        ],
      },
    });
    // 3. Specialist delegation completes
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: 'Specialist summary prose.',
          },
        ],
      },
    });
  }

  it('1. runs code-driven Reviewer query with cite-scoped specialist evidence, strips <<<FINAL_ANSWER>>>, and delivers on submit_review approval', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    h.turnHandler = (session, _promptText, emit, id) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `orch-session-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: `I have gathered the specialist findings.\n\n<<<FINAL_ANSWER>>>\nThe USR table stores user accounts [${CITED_ID}].`,
              },
            ],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      } else {
        // Reviewer query
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'rev-session-1',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-verify-1',
                name: 'mcp__yvoke__verify_citations',
                input: { text: `The USR table stores user accounts [${CITED_ID}].` },
              },
              {
                type: 'tool_use',
                id: 'rev-submit-1',
                name: 'mcp__review__submit_review',
                input: {
                  approved: true,
                  feedback: 'All claims verified against USR table chunk.',
                  unsupported_claims: [],
                  citation_fixes: [],
                },
              },
            ],
          },
        });
        emit({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'rev-verify-1', content: '1 valid citation' },
              { type: 'tool_result', tool_use_id: 'rev-submit-1', content: 'Verdict recorded.' },
            ],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Verdict recorded.',
          usage: { input_tokens: 40, output_tokens: 20 },
        });
      }
    };

    await ask(svc, meta, 'What table stores user accounts?');

    // Two SDK query sessions: [0] orchestrator, [1] code-driven reviewer
    expect(h.sessions).toHaveLength(2);
    const revSession = h.sessions[1];
    expect(revSession.options.maxTurns).toBe(6);
    expect(revSession.options.mcpServers).toHaveProperty('review');
    expect(revSession.options.mcpServers).toHaveProperty(MCP_SERVER_NAME);

    // Reviewer prompt is cite-scoped: includes CITED_ID body, omits UNCITED_ID body, and omits pre-marker chatter
    const reviewerPrompt = revSession.pushed[0];
    expect(reviewerPrompt).toContain(`The USR table stores user accounts [${CITED_ID}].`);
    expect(reviewerPrompt).not.toContain('I have gathered the specialist findings.');
    expect(reviewerPrompt).not.toContain('<<<FINAL_ANSWER>>>');
    expect(reviewerPrompt).toContain('The USR table stores user accounts in OIM.');
    expect(reviewerPrompt).not.toContain('This uncited chunk body must never be sent to the reviewer.');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete).toBeDefined();
    expect(complete.isError).toBe(false);
    expect(complete.message.content).toBe(`The USR table stores user accounts [${CITED_ID}].`);
    expect(complete.message.blocks?.map((b) => b.text).filter(Boolean)).toEqual([
      `The USR table stores user accounts [${CITED_ID}].`,
    ]);
    expect(complete.message.review).toEqual({
      outcome: 'approved',
      feedback: 'All claims verified against USR table chunk.',
    });
    // Token usage aggregates orchestrator (100/50) + reviewer (40/20)
    expect(complete.usage.inputTokens).toBe(140);
    expect(complete.usage.outputTokens).toBe(70);

    // Synthetic reviewer ToolCallInfo has structured verdict + nested subagentBlocks
    const revCall = complete.message.toolCalls?.find((c) => c.subagentType === 'reviewer');
    expect(revCall).toBeDefined();
    expect(revCall?.verdict).toEqual({
      approved: true,
      feedback: 'All claims verified against USR table chunk.',
      unsupportedClaims: [],
      citationFixes: [],
    });
    expect(revCall?.subagentBlocks?.[0]?.toolCalls?.map((t) => t.name)).toEqual([
      'mcp__yvoke__verify_citations',
      'mcp__review__submit_review',
    ]);
    svc.closeAll();
  });

  it('2. drives a revision round on rejection, discards rejected draft blocks, and resumes Reviewer session with SentLedger delta', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    const CHUNK_A = 'aaaaaaaa-1111-2222-3333-444444444444';
    const CHUNK_B = 'bbbbbbbb-1111-2222-3333-444444444444';
    const TWO_CHUNKS_AB = [
      'Found 2 chunks:',
      `### doc/Part A  (score=0.900  id=${CHUNK_A}  doc_id=${DOC_ID})`,
      '_Section: A_',
      'Body of chunk A.',
      '',
      `### doc/Part B  (score=0.850  id=${CHUNK_B}  doc_id=${DOC_ID})`,
      '_Section: B_',
      'Body of chunk B.',
    ].join('\n');

    let orchRound = 0;
    let revRound = 0;

    h.turnHandler = (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        if (orchRound === 0) {
          orchRound++;
          emit({
            type: 'system',
            subtype: 'init',
            session_id: 'orch-session-main',
            mcp_servers: [],
            tools: [],
            slash_commands: [],
          });
          emitSpecialistDelegation(emit, 'spec-ab', 'oim-schema', TWO_CHUNKS_AB);
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: `<<<FINAL_ANSWER>>>\nDraft 1 citing only A [${CHUNK_A}].`,
                },
              ],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 80, output_tokens: 30 },
          });
        } else {
          orchRound++;
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'text',
                  text: `<<<FINAL_ANSWER>>>\nRevised draft citing A [${CHUNK_A}] and B [${CHUNK_B}].`,
                },
              ],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 60, output_tokens: 25 },
          });
        }
      } else {
        if (revRound === 0) {
          revRound++;
          emit({
            type: 'system',
            subtype: 'init',
            session_id: 'rev-session-persist',
            mcp_servers: [],
            tools: [],
            slash_commands: [],
          });
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-0',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: false,
                    feedback: 'Add citation for chunk B.',
                    unsupported_claims: [],
                    citation_fixes: [`Also cite [${CHUNK_B}] for Part B.`],
                  },
                },
              ],
            },
          });
          emit({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'rev-sub-0', content: 'Verdict recorded.' }],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 30, output_tokens: 15 },
          });
        } else {
          revRound++;
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-1',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: true,
                    feedback: 'Both A and B are properly cited.',
                  },
                },
              ],
            },
          });
          emit({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'rev-sub-1', content: 'Verdict recorded.' }],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 25, output_tokens: 10 },
          });
        }
      }
    };

    await ask(svc, meta, 'Explain Part A and Part B.');

    // Sessions: [0] orchestrator (2 turns pushed), [1] reviewer round 0, [2] reviewer round 1
    expect(h.sessions).toHaveLength(3);
    const orchSession = h.sessions[0];
    expect(orchSession.pushed).toHaveLength(2);
    expect(orchSession.pushed[1]).toContain('## Citation fixes — no research needed');
    expect(orchSession.pushed[1]).toContain(`Also cite [${CHUNK_B}] for Part B.`);
    expect(orchSession.pushed[1]).toContain('do NOT call the Task tool');

    // Reviewer round 1 resumed 'rev-session-persist' and received only newly cited CHUNK_B (not CHUNK_A)
    const revRound1 = h.sessions[2];
    expect(revRound1.options.resume).toBe('rev-session-persist');
    expect(revRound1.pushed[0]).toContain('## Revised candidate answer');
    expect(revRound1.pushed[0]).toContain('Body of chunk B.');
    expect(revRound1.pushed[0]).not.toContain('Body of chunk A.');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.message.content).toBe(`Revised draft citing A [${CHUNK_A}] and B [${CHUNK_B}].`);
    // Rejected Draft 1 text must not remain in message.blocks
    const blockTexts = complete.message.blocks?.map((b) => b.text).filter(Boolean) ?? [];
    expect(blockTexts).toEqual([`Revised draft citing A [${CHUNK_A}] and B [${CHUNK_B}].`]);
    expect(complete.message.review).toEqual({
      outcome: 'approved',
      feedback: 'Both A and B are properly cited.',
    });
    svc.closeAll();
  });

  it('3. appends reviewFlagNote(attempts, feedback) when maxReviewRounds is exhausted', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta, {
      getSettings: () => ({
        ...settings(),
        orchestrator: {
          ...settings().orchestrator!,
          maxReviewRounds: 1,
        },
      }),
    });

    let orchRound = 0;
    let revRound = 0;

    h.turnHandler = (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        if (orchRound === 0) {
          orchRound++;
          emit({
            type: 'system',
            subtype: 'init',
            session_id: 'orch-flag-session',
            mcp_servers: [],
            tools: [],
            slash_commands: [],
          });
          emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        } else {
          orchRound++;
        }
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `<<<FINAL_ANSWER>>>\nUnverified claim attempt ${orchRound} [${CITED_ID}].` }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      } else {
        revRound++;
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'rev-flag-session',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `rev-sub-${revRound}`,
                name: 'mcp__review__submit_review',
                input: {
                  approved: false,
                  feedback: revRound === 1 ? 'First rejection' : 'Still missing USR_LOGIN evidence',
                  unsupported_claims: ['Unverified claim'],
                },
              },
            ],
          },
        });
        emit({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: `rev-sub-${revRound}`, content: 'Verdict recorded.' }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      }
    };

    await ask(svc, meta, 'Question that exhausts review rounds');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.isError).toBe(false);
    expect(complete.message.content).toContain(`Unverified claim attempt 2 [${CITED_ID}].`);
    expect(complete.message.content).toContain(
      'This answer did not pass automated review after 2 attempt(s). Reviewer notes: Still missing USR_LOGIN evidence',
    );
    const blockTexts = complete.message.blocks?.map((b) => b.text).filter(Boolean) ?? [];
    expect(blockTexts[blockTexts.length - 1]).toContain(
      'Reviewer notes: Still missing USR_LOGIN evidence',
    );
    expect(complete.message.review).toEqual({
      outcome: 'rejected',
      feedback: 'Still missing USR_LOGIN evidence',
    });
    svc.closeAll();
  });

  it('4. delivers non-blank draft with unreviewedNote() when Reviewer query fails, and surfaces error when draft is blank', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    h.turnHandler = (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-unrev',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `<<<FINAL_ANSWER>>>\nGood draft [${CITED_ID}].` }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      } else {
        // Reviewer query fails with is_error: true
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Reviewer subprocess crashed',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Question where reviewer crashes');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.isError).toBe(false);
    expect(complete.message.content).toContain(`Good draft [${CITED_ID}].`);
    expect(complete.message.content).toContain(
      'This answer could not be checked — the automated review failed to run, so nothing has validated its claims or citations. Treat it as unverified.',
    );
    expect(complete.message.content).not.toContain('did not pass automated review');

    // Second turn: blank draft + reviewer failure -> surfaces error
    events = [];
    h.turnHandler = (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-2', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '   ',
          usage: {},
        });
      } else {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Reviewer crashed on blank draft',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Question with blank draft');
    const completeBlank = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(completeBlank.isError).toBe(true);
    expect(completeBlank.errorMessage).toContain('Claude: Reviewer crashed on blank draft');
    expect(completeBlank.message.content).toBe('');
    svc.closeAll();
  });

  it('5. interrupts activeReviewerQuery immediately on user interrupt(threadId) and completes as aborted without unreviewedNote', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    let reviewerStartedResolve: (() => void) | null = null;
    const reviewerStarted = new Promise<void>((resolve) => {
      reviewerStartedResolve = resolve;
    });

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-int',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `<<<FINAL_ANSWER>>>\nDraft before stop [${CITED_ID}].` }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: {},
        });
      } else {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'rev-int',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        reviewerStartedResolve?.();
        // Wait until interrupted/closed
      }
    };

    await svc.sendMessage(meta, 'Interrupt me during review');
    await reviewerStarted;

    // Reviewer session is h.sessions[1]
    expect(h.sessions).toHaveLength(2);
    await svc.interrupt(meta.id);

    expect(h.sessions[1].interruptSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 200; i++) {
      if (events.some((e) => e.kind === 'turn-complete')) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete).toBeDefined();
    expect(complete.aborted).toBe(true);
    expect(complete.message.content).toBe(`Draft before stop [${CITED_ID}].`);
    expect(complete.message.content).not.toContain(unreviewedNote());
    expect(complete.message.content).not.toContain('did not pass automated review');
    svc.closeAll();
  });

  it('6. bypasses Reviewer query when orchestrator makes zero specialist delegations', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    h.turnHandler = (_session, _promptText, emit) => {
      emit({
        type: 'system',
        subtype: 'init',
        session_id: 'orch-zero-del',
        mcp_servers: [],
        tools: [],
        slash_commands: [],
      });
      emit({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '<<<FINAL_ANSWER>>>\nDirect greeting without delegation.' }],
        },
      });
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '',
        usage: {},
      });
    };

    await ask(svc, meta, 'Hello!');

    expect(h.sessions).toHaveLength(1);
    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.message.content).toBe('Direct greeting without delegation.');
    expect(complete.message.review).toBeUndefined();
    svc.closeAll();
  });

  async function invokeSubmitAnswer(
    session: { options: Record<string, unknown> },
    emit: (m: unknown) => void,
    callId: string,
    answer: string,
  ): Promise<{ text: string; isError?: boolean }> {
    emit({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: 'mcp__review__submit_answer',
            input: { answer },
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    const reviewSrv = (session.options.mcpServers as Record<string, any> | undefined)?.review;
    if (!reviewSrv || !reviewSrv._testHandlers?.submit_answer) {
      throw new Error('mcpServers.review.submit_answer handler not mounted on orchestrator session');
    }
    const res = await reviewSrv._testHandlers.submit_answer({ answer });
    const text = res?.content?.[0]?.text ?? '';
    const isError = Boolean(res?.isError);
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: callId,
            content: text,
            is_error: isError,
          },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    return { text, isError };
  }

  it('7. Task 4.2: runs Reviewer inside submit_answer MCP tool handler on approval, strips intermediate orchestrator text, and ignores redundant second submit_answer calls', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    let firstToolReply = '';
    let secondToolReply = '';

    h.turnHandler = async (session, _promptText, emit, id) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: `orch-sub-ans-${id}`,
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'I have synthesized the USR findings and will now submit.' }],
          },
        });
        const first = await invokeSubmitAnswer(
          session,
          emit,
          'sub-ans-1',
          `The USR table stores user accounts [${CITED_ID}].`,
        );
        firstToolReply = first.text;

        // Redundant second call after settled must NOT spawn a second Reviewer query or overwrite answer
        const second = await invokeSubmitAnswer(
          session,
          emit,
          'sub-ans-2',
          'Accidental duplicate submission that must be ignored.',
        );
        secondToolReply = second.text;

        emit({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          result: 'Maximum turns reached after submit_answer already settled',
          usage: { input_tokens: 110, output_tokens: 45 },
        });
      } else {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'rev-sub-ans-1',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-submit-1',
                name: 'mcp__review__submit_review',
                input: {
                  approved: true,
                  feedback: 'Verified via submit_answer tool.',
                  unsupported_claims: [],
                  citation_fixes: [],
                },
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
                tool_use_id: 'rev-submit-1',
                content: 'Verdict recorded.',
              },
            ],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 35, output_tokens: 15 },
        });
      }
    };

    await ask(svc, meta, 'What does the USR table store?');

    // Only 1 orchestrator session + 1 reviewer session (the 2nd submit_answer was short-circuited)
    expect(h.sessions).toHaveLength(2);
    expect(firstToolReply).toContain('APPROVED');
    expect(secondToolReply).toContain('APPROVED');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete).toBeDefined();
    expect(complete.isError).toBe(false);
    expect(complete.message.content).toBe(`The USR table stores user accounts [${CITED_ID}].`);
    // Intermediate reasoning text stripped; only final submitted answer remains in blocks
    expect(complete.message.blocks?.map((b) => b.text).filter(Boolean)).toEqual([
      `The USR table stores user accounts [${CITED_ID}].`,
    ]);
    // Internal submit_answer tool call must not appear in message.toolCalls
    expect(complete.message.toolCalls?.some((c) => c.name === 'mcp__review__submit_answer')).toBe(false);
    expect(complete.message.review).toEqual({
      outcome: 'approved',
      feedback: 'Verified via submit_answer tool.',
    });
    expect(complete.usage.inputTokens).toBe(145);
    expect(complete.usage.outputTokens).toBe(60);
    svc.closeAll();
  });

  it('8. Task 4.2: returns buildRevisionPrompt as submit_answer tool result on rejection so orchestrator revises in-turn and resumes Reviewer session on second submit_answer call', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    const CHUNK_A = 'aaaaaaaa-1111-2222-3333-444444444444';
    const CHUNK_B = 'bbbbbbbb-1111-2222-3333-444444444444';
    const TWO_CHUNKS_AB = [
      'Found 2 chunks:',
      `### doc/Part A  (score=0.900  id=${CHUNK_A}  doc_id=${DOC_ID})`,
      '_Section: A_',
      'Body of chunk A.',
      '',
      `### doc/Part B  (score=0.850  id=${CHUNK_B}  doc_id=${DOC_ID})`,
      '_Section: B_',
      'Body of chunk B.',
    ].join('\n');

    let revRound = 0;
    let firstSubmitResult = '';
    let secondSubmitResult = '';

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-in-turn-rev',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-ab', 'oim-schema', TWO_CHUNKS_AB);

        // Round 0 submission (rejected by Reviewer)
        const r0 = await invokeSubmitAnswer(
          session,
          emit,
          'sub-ans-r0',
          `Draft 1 citing only A [${CHUNK_A}].`,
        );
        firstSubmitResult = r0.text;

        // Round 1 submission in the SAME orchestrator turn (approved by Reviewer)
        const r1 = await invokeSubmitAnswer(
          session,
          emit,
          'sub-ans-r1',
          `Revised draft citing A [${CHUNK_A}] and B [${CHUNK_B}].`,
        );
        secondSubmitResult = r1.text;

        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 120, output_tokens: 55 },
        });
      } else {
        if (revRound === 0) {
          revRound++;
          emit({
            type: 'system',
            subtype: 'init',
            session_id: 'rev-session-in-tool',
            mcp_servers: [],
            tools: [],
            slash_commands: [],
          });
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-0',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: false,
                    feedback: 'Add citation for chunk B.',
                    unsupported_claims: [],
                    citation_fixes: [`Also cite [${CHUNK_B}] for Part B.`],
                  },
                },
              ],
            },
          });
          emit({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'rev-sub-0', content: 'Verdict recorded.' }],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 30, output_tokens: 15 },
          });
        } else {
          revRound++;
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-1',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: true,
                    feedback: 'Both A and B are properly cited.',
                  },
                },
              ],
            },
          });
          emit({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'rev-sub-1', content: 'Verdict recorded.' }],
            },
          });
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            usage: { input_tokens: 25, output_tokens: 10 },
          });
        }
      }
    };

    await ask(svc, meta, 'Explain Part A and Part B.');

    // Orchestrator ran in a SINGLE turn (pushed.length === 1), with 2 Reviewer sessions
    expect(h.sessions).toHaveLength(3);
    expect(h.sessions[0].pushed).toHaveLength(1);
    expect(firstSubmitResult).toContain('## Citation fixes — no research needed');
    expect(firstSubmitResult).toContain(`Also cite [${CHUNK_B}] for Part B.`);
    expect(firstSubmitResult).toContain('submit the complete revised answer via `submit_answer`');
    expect(secondSubmitResult).toContain('APPROVED');

    // Reviewer round 1 resumed 'rev-session-in-tool' and received only newly cited CHUNK_B
    const revRound1 = h.sessions[2];
    expect(revRound1.options.resume).toBe('rev-session-in-tool');
    expect(revRound1.pushed[0]).toContain('## Revised candidate answer');
    expect(revRound1.pushed[0]).toContain('Body of chunk B.');
    expect(revRound1.pushed[0]).not.toContain('Body of chunk A.');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.message.content).toBe(`Revised draft citing A [${CHUNK_A}] and B [${CHUNK_B}].`);
    expect(complete.message.review).toEqual({
      outcome: 'approved',
      feedback: 'Both A and B are properly cited.',
    });
    // Usage: orchestrator (120/55) + reviewer round 0 (30/15) + reviewer round 1 (25/10) = 175/80
    expect(complete.usage.inputTokens).toBe(175);
    expect(complete.usage.outputTokens).toBe(80);
    svc.closeAll();
  });

  it('9. Task 4.2: handles exhausted maxReviewRounds, Reviewer failure, and zero-specialist delegation inside submit_answer', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta, {
      getSettings: () => ({
        ...settings(),
        orchestrator: {
          ...settings().orchestrator!,
          maxReviewRounds: 1,
        },
      }),
    });

    let revRound = 0;
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-exhaust-in-tool',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        await invokeSubmitAnswer(session, emit, 'sub-1', `Attempt 1 [${CITED_ID}].`);
        await invokeSubmitAnswer(session, emit, 'sub-2', `Attempt 2 [${CITED_ID}].`);
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      } else {
        revRound++;
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `rev-sub-${revRound}`,
                name: 'mcp__review__submit_review',
                input: {
                  approved: false,
                  feedback: revRound === 1 ? 'First rejection' : 'Second rejection note',
                  unsupported_claims: ['Unverified'],
                },
              },
            ],
          },
        });
        emit({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: `rev-sub-${revRound}`, content: 'Verdict recorded.' }],
          },
        });
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
    };

    await ask(svc, meta, 'Exhaust review rounds via submit_answer');
    const complete1 = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete1.message.content).toContain(`Attempt 2 [${CITED_ID}].`);
    expect(complete1.message.content).toContain(
      'This answer did not pass automated review after 2 attempt(s). Reviewer notes: Second rejection note',
    );

    // Turn 2: Reviewer fails inside submit_answer -> delivers draft + unreviewedNote()
    events = [];
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-2', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        await invokeSubmitAnswer(session, emit, 'sub-err', `Draft when reviewer fails [${CITED_ID}].`);
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: {},
        });
      } else {
        emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'Reviewer crashed inside submit_answer',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Reviewer fails inside submit_answer');
    const complete2 = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete2.isError).toBe(false);
    expect(complete2.message.content).toContain(`Draft when reviewer fails [${CITED_ID}].`);
    expect(complete2.message.content).toContain(
      'This answer could not be checked — the automated review failed to run',
    );

    // Turn 3: Zero specialist delegations inside submit_answer -> bypasses Reviewer query
    events = [];
    const sessionsBefore = h.sessions.length;
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        await invokeSubmitAnswer(session, emit, 'sub-direct', 'Direct answer via submit_answer.');
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Hello via submit_answer');
    expect(h.sessions.length).toBe(sessionsBefore); // No Reviewer session spawned
    const complete3 = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete3.message.content).toBe('Direct answer via submit_answer.');
    expect(complete3.message.review).toBeUndefined();
    svc.closeAll();
  });

  it('10. Task 4.2: preserves mcpServers.review across warm-session Entra token rotation and falls back to runCodeDrivenReview when revision round omits submit_answer', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    let currentToken = 'Bearer tok-1';
    const svc = new AgentService({
      getSettings: () => ({ ...settings(), serverAuthMode: 'entra' }),
      mcpAuthProvider: { headers: async () => ({ Authorization: currentToken }) },
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

    // Turn 1: initial orchestrator session
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-warm-1',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        await invokeSubmitAnswer(session, emit, 'sub-w1', 'Turn 1 answer.');
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      }
    };
    await ask(svc, meta, 'Turn 1');
    expect(h.sessions).toHaveLength(1);

    // Turn 2: Entra token rotates -> setMcpServers must preserve mcpServers.review!
    // Also test hybrid fallback: round 0 calls submit_answer (rejected), round 1 omits submit_answer and outputs plain text -> completeTurn runs runCodeDrivenReview fallback!
    currentToken = 'Bearer tok-2';
    let revCount = 0;
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-w2', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Stale Round 0 prose that must be cleared on rejection.' }],
          },
        });
        // Round 0 calls submit_answer -> rejected
        await invokeSubmitAnswer(session, emit, 'sub-w2-r0', `Draft 1 [${CITED_ID}].`);
        // Model forgets to call submit_answer on revision and ends turn with text!
        emit({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `Fallback revised answer [${CITED_ID}].` }],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      } else {
        revCount++;
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `rev-w2-${revCount}`,
                name: 'mcp__review__submit_review',
                input: {
                  approved: revCount === 2,
                  feedback: revCount === 1 ? 'Needs revision' : 'Fallback approved!',
                },
              },
            ],
          },
        });
        emit({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: `rev-w2-${revCount}`, content: 'Verdict recorded.' }],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      }
    };

    events = [];
    await ask(svc, meta, 'Turn 2 with token rotation and fallback');

    expect(h.sessions[0].setMcpServersSpy).toHaveBeenCalledTimes(1);
    const updatedServers = h.sessions[0].setMcpServersSpy.mock.calls[0][0];
    expect(updatedServers).toHaveProperty(MCP_SERVER_NAME);
    expect(updatedServers).toHaveProperty('review');

    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.message.content).toBe(`Fallback revised answer [${CITED_ID}].`);
    expect(complete.message.review).toEqual({
      outcome: 'approved',
      feedback: 'Fallback approved!',
    });
    svc.closeAll();
  });

  it('11. Task 4.2: interrupts activeReviewerQuery when user calls interrupt(threadId) during in-tool submit_answer review and returns isError without unreviewedNote', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    let reviewerStartedResolve: (() => void) | null = null;
    const reviewerStarted = new Promise<void>((resolve) => {
      reviewerStartedResolve = resolve;
    });
    let submitRes: { text: string; isError?: boolean } | null = null;

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-int-in-tool',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        submitRes = await invokeSubmitAnswer(
          session,
          emit,
          'sub-int-1',
          `Draft before interrupt [${CITED_ID}].`,
        );
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: {},
        });
      } else {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'rev-int-in-tool',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        reviewerStartedResolve?.();
        // Wait until interrupted by user
      }
    };

    await svc.sendMessage(meta, 'Interrupt me during submit_answer review');
    await reviewerStarted;

    expect(h.sessions).toHaveLength(2);
    // Let the orchestrator session emit its final result message after submit_answer resolves
    h.sessions[0].interruptSpy.mockImplementation(async () => undefined);
    await svc.interrupt(meta.id);
    expect(h.sessions[0].interruptSpy).toHaveBeenCalledTimes(1);
    expect(h.sessions[1].interruptSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 200; i++) {
      if (events.some((e) => e.kind === 'turn-complete')) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(submitRes).toEqual({ text: 'Turn interrupted by user.', isError: true });
    expect(events.some((e) => e.kind === 'subagent-complete' && e.subagentType === 'reviewer')).toBe(false);
    expect(events.some((e) => e.kind === 'review-enforced')).toBe(false);
    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete).toBeDefined();
    expect(complete.aborted).toBe(true);
    expect(complete.message.content).toBe(`Draft before interrupt [${CITED_ID}].`);
    expect(complete.message.content).not.toContain(unreviewedNote());
    expect(complete.message.content).not.toContain('did not pass automated review');
    svc.closeAll();
  });

  it('12. Task 5.2: status-neutral settled notice on non-approved settles, malformed submit_review recovery, and concurrent submit_answer serialization', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta, {
      getSettings: () => ({
        ...settings(),
        orchestrator: {
          ...settings().orchestrator!,
          maxReviewRounds: 0,
        },
      }),
    });

    // Part A: Duplicate submit_answer after a non-approved settle (out of rounds) returns status-neutral notice (not APPROVED)
    const partAResults: Array<{ text: string; isError?: boolean }> = [];

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-wave5-a',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-w5-a', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        partAResults.push(await invokeSubmitAnswer(session, emit, 'sub-w5-1', `Draft 1 [${CITED_ID}].`));
        partAResults.push(
          await invokeSubmitAnswer(session, emit, 'sub-w5-2', `Duplicate draft [${CITED_ID}].`),
        );
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      } else {
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-w5-1',
                name: 'mcp__review__submit_review',
                input: {
                  approved: false,
                  feedback: 'Rejected with 0 maxReviewRounds',
                },
              },
            ],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      }
    };

    await ask(svc, meta, 'Test non-approved settled notice');
    expect(partAResults[0]?.text).toContain('maximum number of review rounds');
    expect(partAResults[1]?.text).toBe(
      'Your answer has already been delivered to the user. End your turn now without repeating the answer.',
    );
    expect(partAResults[1]?.text).not.toContain('APPROVED');

    // Part B: Malformed submit_review tool_use in Reviewer stream does not crash executeReviewerQuery; second valid submit_review succeeds
    events = [];
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-w5-b', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        await invokeSubmitAnswer(session, emit, 'sub-w5-b', `Draft B [${CITED_ID}].`);
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      } else {
        // First assistant message has malformed input (null) which throws in parseSubmitReviewArgs
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-malformed',
                name: 'mcp__review__submit_review',
                input: null,
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
                tool_use_id: 'rev-malformed',
                content: 'Validation error: expected object',
                is_error: true,
              },
            ],
          },
        });
        // Second assistant message in same Reviewer session has valid submit_review
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-valid-retry',
                name: 'mcp__review__submit_review',
                input: {
                  approved: true,
                  feedback: 'Recovered after malformed tool_use!',
                },
              },
            ],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      }
    };

    await ask(svc, meta, 'Test malformed submit_review recovery');
    const completeB = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(completeB.message.content).toBe(`Draft B [${CITED_ID}].`);
    expect(completeB.message.content).not.toContain(unreviewedNote());
    expect(completeB.message.review).toEqual({
      outcome: 'approved',
      feedback: 'Recovered after malformed tool_use!',
    });

    // Part C: Concurrent submit_answer calls serialize via in-flight lock so only ONE Reviewer query runs when the first settles
    events = [];
    const sessionsBeforeC = h.sessions.length;
    let concurrentResults: Array<{ text: string; isError?: boolean }> = [];

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-w5-c', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        concurrentResults = await Promise.all([
          invokeSubmitAnswer(session, emit, 'sub-c1', `Concurrent draft 1 [${CITED_ID}].`),
          invokeSubmitAnswer(session, emit, 'sub-c2', `Concurrent draft 2 [${CITED_ID}].`),
        ]);
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      } else {
        await new Promise((r) => setTimeout(r, 10));
        emit({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'rev-conc-1',
                name: 'mcp__review__submit_review',
                input: {
                  approved: true,
                  feedback: 'Approved first concurrent call.',
                },
              },
            ],
          },
        });
        emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
      }
    };

    await ask(svc, meta, 'Test concurrent submit_answer serialization');
    // Only ONE Reviewer query should have been spawned for the two concurrent calls
    expect(h.sessions.length - sessionsBeforeC).toBe(1);
    expect(concurrentResults[0].text).toContain('APPROVED — the answer you passed to submit_answer');
    expect(concurrentResults[1].text).toContain('APPROVED — your answer has already been delivered');
    const completeC = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(completeC.message.content).toBe(`Concurrent draft 1 [${CITED_ID}].`);
    svc.closeAll();
  });

  it('13. caps >60 KB specialist evidence inside submit_answer revision result with feedback at index 0, suppresses pre-submission and post-approval closing chatter ("The revised answer was approved and delivered."), and preserves zero-specialist direct replies in message.blocks', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    const CHUNK_A = 'aaaaaaaa-1111-2222-3333-444444444444';
    const CHUNK_B = 'bbbbbbbb-1111-2222-3333-444444444444';
    const fillerChunks = Array.from({ length: 20 }, (_, i) => {
      const hex = (i + 16).toString(16).padStart(2, '0');
      const id = `${hex}000000-1111-2222-3333-444444444444`;
      return [
        `### doc/Filler ${i}  (score=0.700  id=${id}  doc_id=${DOC_ID})`,
        '_Section: Filler_',
        `Uncited filler body ${i}: ${'X'.repeat(3200)}`,
        '',
      ].join('\n');
    }).join('\n');

    const OVER_60KB_SEARCH_RESULT = [
      'Found 22 chunks:',
      fillerChunks,
      `### doc/Part A  (score=0.950  id=${CHUNK_A}  doc_id=${DOC_ID})`,
      '_Section: A_',
      'Body of chunk A about USR.',
      '',
      `### doc/Part B  (score=0.920  id=${CHUNK_B}  doc_id=${DOC_ID})`,
      '_Section: B_',
      'Body of chunk B about ACT.',
    ].join('\n');
    expect(OVER_60KB_SEARCH_RESULT.length).toBeGreaterThan(60_000);

    let revRound = 0;
    let firstSubmitReply = '';

    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-spill-guard',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-huge', 'oim-schema', OVER_60KB_SEARCH_RESULT);

        // Pre-submission live text delta and assistant plain text (must be suppressed from live UI events)
        emit({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Synthesizing specialist evidence before submit_answer...' },
          },
        });
        emit({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'Synthesizing specialist evidence before submit_answer...' }],
          },
        });

        // Round 0 submit_answer -> rejected
        const r0 = await invokeSubmitAnswer(
          session,
          emit,
          'sub-r0',
          `Draft 1 citing A [${CHUNK_A}].`,
        );
        firstSubmitReply = r0.text;

        // Round 1 submit_answer -> approved
        await invokeSubmitAnswer(
          session,
          emit,
          'sub-r1',
          `Approved revised answer citing A [${CHUNK_A}] and B [${CHUNK_B}].`,
        );

        // Post-approval closing chatter (exact defect from live trace)
        emit({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'The revised answer was approved and delivered.' },
          },
        });
        emit({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'The revised answer was approved and delivered.' }],
          },
        });

        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The revised answer was approved and delivered.',
          usage: { input_tokens: 100, output_tokens: 40 },
        });
      } else {
        if (revRound === 0) {
          revRound++;
          emit({
            type: 'system',
            subtype: 'init',
            session_id: 'rev-spill-guard',
            mcp_servers: [],
            tools: [],
            slash_commands: [],
          });
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-0',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: false,
                    feedback: `Missing ACT table citation from [${CHUNK_B}].`,
                    citation_fixes: [`Add [${CHUNK_B}] to the ACT table claim.`],
                    unsupported_claims: ['Unsupported claim about LDAP sync'],
                  },
                },
              ],
            },
          });
          emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
        } else {
          revRound++;
          emit({
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'rev-sub-1',
                  name: 'mcp__review__submit_review',
                  input: {
                    approved: true,
                    feedback: 'All claims grounded.',
                  },
                },
              ],
            },
          });
          emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
        }
      }
    };

    await ask(svc, meta, 'Explain USR and ACT tables.');

    // 1. Verify submit_answer rejection result is feedback-first and under MAX_REVISION_PROMPT_CHARS (32 KB)
    expect(firstSubmitReply.length).toBeLessThanOrEqual(MAX_REVISION_PROMPT_CHARS);
    expect(firstSubmitReply.indexOf(REVIEW_FEEDBACK_HEADING)).toBe(0);
    expect(firstSubmitReply.indexOf(REVIEW_FEEDBACK_HEADING)).toBeLessThan(
      firstSubmitReply.indexOf('## Citation fixes — no research needed'),
    );
    expect(firstSubmitReply.indexOf('## Citation fixes — no research needed')).toBeLessThan(
      firstSubmitReply.indexOf('## Unsupported claims'),
    );
    expect(firstSubmitReply.indexOf('## Unsupported claims')).toBeLessThan(
      firstSubmitReply.indexOf('## Source evidence behind the specialist answers above'),
    );
    expect(firstSubmitReply).toContain('Body of chunk A about USR.');
    expect(firstSubmitReply).toContain('Body of chunk B about ACT.');

    // 2. Verify zero live-text and zero non-empty-text assistant-block events were emitted during the live turn
    expect(events.filter((e) => e.kind === 'live-text')).toEqual([]);
    const nonEmptyAssistantBlocks = events.filter(
      (e): e is Extract<AgentEvent, { kind: 'assistant-block' }> =>
        e.kind === 'assistant-block' && e.text.length > 0,
    );
    expect(nonEmptyAssistantBlocks).toEqual([]);

    // 3. Verify turn-complete delivers only the approved submittedAnswer in content and blocks
    const complete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(complete.message.content).toBe(
      `Approved revised answer citing A [${CHUNK_A}] and B [${CHUNK_B}].`,
    );
    expect(complete.message.content).not.toContain('The revised answer was approved and delivered.');
    expect(complete.message.blocks?.map((b) => b.text).filter(Boolean)).toEqual([
      `Approved revised answer citing A [${CHUNK_A}] and B [${CHUNK_B}].`,
    ]);

    // 4. Verify zero-specialist direct plain-text reply still populates both message.content and message.blocks
    events = [];
    h.turnHandler = (_session, _promptText, emit) => {
      emit({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Direct plain-text reply.' } },
      });
      emit({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Direct plain-text reply.' }] },
      });
      emit({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {} });
    };

    await ask(svc, meta, 'Quick direct question');
    expect(events.filter((e) => e.kind === 'live-text')).toEqual([]);
    const directComplete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(directComplete.message.content).toBe('Direct plain-text reply.');
    expect(directComplete.message.blocks).toEqual([{ text: 'Direct plain-text reply.' }]);

    svc.closeAll();
  });

  it('14. attaches cleaned turnText to message.blocks when an orchestrator turn is aborted before submit_answer, and never mistakes an is_error result string for answer prose', async () => {
    const meta = thread({ orchestratorProfile: 'OIM' });
    const svc = makeService(meta);

    // Part A: Orchestrator turn is interrupted after emitting partial plain text before submit_answer
    h.turnHandler = async (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emit({
          type: 'system',
          subtype: 'init',
          session_id: 'orch-abort-before-submit',
          mcp_servers: [],
          tools: [],
          slash_commands: [],
        });
        emitSpecialistDelegation(emit, 'spec-abort-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'text', text: 'Planning notes...\n<<<FINAL_ANSWER>>>\nPartial answer before stop.' }],
          },
        });
        // Simulate user pressing Stop before submit_answer or reviewer runs
        session.interruptSpy.mockImplementation(async () => undefined);
        await svc.interrupt(meta.id);
        emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Stop me mid-orchestration');
    const abortComplete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(abortComplete).toBeDefined();
    expect(abortComplete.aborted).toBe(true);
    expect(abortComplete.message.content).toBe('Partial answer before stop.');
    expect(abortComplete.message.blocks?.map((b) => b.text).filter(Boolean)).toEqual([
      'Partial answer before stop.',
    ]);

    // Part B: Orchestrator turn ends with is_error: true and empty turnText -> result.result error string must NOT be copied into message.content or message.blocks
    events = [];
    h.turnHandler = (session, _promptText, emit) => {
      if (session.options.agent === ORCHESTRATOR_AGENT) {
        emitSpecialistDelegation(emit, 'spec-err-1', 'oim-schema', SEARCH_RESULT_TWO_CHUNKS);
        emit({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          result: 'Reached maximum number of turns (20)',
          usage: {},
        });
      }
    };

    await ask(svc, meta, 'Hit max turns error in orchestrator');
    const errComplete = events.find((e) => e.kind === 'turn-complete') as Extract<
      AgentEvent,
      { kind: 'turn-complete' }
    >;
    expect(errComplete).toBeDefined();
    expect(errComplete.isError).toBe(true);
    expect(errComplete.errorMessage).toContain('Claude: Reached maximum number of turns (20)');
    expect(errComplete.message.content).toBe('');
    expect(errComplete.message.blocks?.map((b) => b.text).filter(Boolean)).toEqual([]);

    svc.closeAll();
  });
});

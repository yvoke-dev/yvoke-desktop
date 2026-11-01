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
  }[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const query = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: unknown } }>;
    options: Record<string, unknown>;
  }) => {
    const session = {
      options,
      pushed: [] as string[],
      closed: false,
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
        session.pushed.push(
          typeof msg.message.content === 'string'
            ? msg.message.content
            : JSON.stringify(msg.message.content),
        );
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
      syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
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

  it('restarts a warm playbook-less session when a playbook is assigned on a follow-up turn (undefined -> oim-full) without resuming the playbook-less sessionId', async () => {
    const meta = makeThread({ id: 'thread-late-pb' });
    const sessionIdEvents: { threadId: string; sessionId: string; profile?: string }[] = [];
    const svc = new AgentService({
      getSettings: settings,
      mcpAuthProvider: { headers: async () => ({}) } as never,
      emit: (e) => events.push(e),
      onSessionId: (threadId, sessionId, profile) => {
        sessionIdEvents.push({ threadId, sessionId, profile });
        meta.sessionId = sessionId || undefined;
        meta.sessionProfile = profile;
      },
      onTurnPersist: (threadId, userMessage, assistantMessage) => {
        persistedTurns.push({ threadId, userMessage, assistantMessage });
      },
      sandboxDir,
      syncClient: { getSystemPrompt: async () => 'BASE SYSTEM PROMPT' } as never,
      mcpPrompts: {
        list: async () => PLAYBOOKS,
        getText: async (name: string) => `INSTRUCTIONS FOR ${name}`,
      } as never,
      getOrchestratorProfile: async (name: string) => (name === 'OIM' ? OIM_PROFILE : undefined),
    });

    // Turn 1: sent while catalogue was empty (no playbook)
    await runTurn(svc, meta, 'Turn 1 without playbook', undefined);
    expect(h.sessions).toHaveLength(1);
    expect(meta.sessionId).toBe('sdk-session-1');
    expect(persistedTurns[0].userMessage.playbook).toBeUndefined();
    expect(persistedTurns[0].assistantMessage.playbook).toBeUndefined();

    // Turn 2: playbook assigned on follow-up turn while warm session is still alive and passed thread snapshot carries sessionId
    await runTurn(svc, { ...meta, initialPlaybook: 'oim-full' }, 'Turn 2 with playbook', 'oim-full');

    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[0].closed).toBe(true);
    expect(sessionIdEvents).toContainEqual({ threadId: 'thread-late-pb', sessionId: '', profile: undefined });
    expect(h.sessions[1].options.resume).toBeUndefined();
    expect(String(h.sessions[1].options.systemPrompt)).toContain('INSTRUCTIONS FOR oim-full');
    expect(persistedTurns[1].userMessage.playbook).toBe('oim-full');
    expect(persistedTurns[1].userMessage.playbookVersion).toBe(2);
    expect(persistedTurns[1].assistantMessage.playbook).toBe('oim-full');
    expect(persistedTurns[1].assistantMessage.playbookVersion).toBe(2);

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

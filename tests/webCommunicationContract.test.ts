import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import type { ConversationDto, MessageDto, NewMessagePayload } from '../src/main/sync/SyncClient';
import type {
  ChatMessage,
  McpPromptInfo,
  OrchestratorProfile,
  OrchestratorRunPayload,
  ValidSystemPromptName,
} from '../src/shared/types';

interface InMemoryWebServer {
  conversations: Map<string, ConversationDto>;
  messagesByConv: Map<string, MessageDto[]>;
  messagesById: Map<string, MessageDto>;
  runs: (OrchestratorRunPayload & { id: string })[];
  failNextAppendStatus: number | null;
  failNextRunStatus: number | null;
  profilesDelayMs: number;
  fetchFn: typeof fetch;
}

function normalizeServerSettings(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!raw) return {};
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'thinkingLevel') {
      mapped['thinking-level'] = v;
    } else {
      mapped[k] = v;
    }
  }
  return mapped;
}

function createInMemoryYvokeWebServer(): InMemoryWebServer {
  let seq = 1;
  const conversations = new Map<string, ConversationDto>();
  const messagesByConv = new Map<string, MessageDto[]>();
  const messagesById = new Map<string, MessageDto>();
  const runs: (OrchestratorRunPayload & { id: string })[] = [];

  const server: InMemoryWebServer = {
    conversations,
    messagesByConv,
    messagesById,
    runs,
    failNextAppendStatus: null,
    failNextRunStatus: null,
    profilesDelayMs: 0,
    fetchFn: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      const p = url.pathname.replace(/^\/api\/chat\/v1/, '');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      // GET /prompts/system/:name
      if (method === 'GET' && p.startsWith('/prompts/system/')) {
        const name = decodeURIComponent(p.slice('/prompts/system/'.length));
        return new Response(JSON.stringify({ systemPrompt: `SYSTEM_PROMPT(${name})` }), { status: 200 });
      }

      // GET /orchestrator/profiles
      if (method === 'GET' && p === '/orchestrator/profiles') {
        if (server.profilesDelayMs > 0) {
          await new Promise((r) => setTimeout(r, server.profilesDelayMs));
        }
        const profiles: OrchestratorProfile[] = [
          {
            name: 'OIM',
            orchestratorPlaybook: 'oim-orchestrator',
            reviewerPlaybook: 'oim-orchestrator-reviewer',
            specialistPlaybooks: ['oim-access-governance'],
          },
        ];
        return new Response(JSON.stringify(profiles), { status: 200 });
      }

      // GET /conversations
      if (method === 'GET' && p === '/conversations') {
        return new Response(JSON.stringify([...conversations.values()]), { status: 200 });
      }

      // POST /conversations
      if (method === 'POST' && p === '/conversations') {
        const id = `conv-${seq++}`;
        const now = new Date().toISOString();
        const conv: ConversationDto = {
          id,
          title: body?.title ?? 'New Conversation',
          settings: normalizeServerSettings(body?.settings),
          createdAt: now,
          updatedAt: now,
        };
        conversations.set(id, conv);
        messagesByConv.set(id, []);
        return new Response(JSON.stringify(conv), { status: 200 });
      }

      // PATCH /conversations/:id
      const convMatch = p.match(/^\/conversations\/([^/]+)$/);
      if (convMatch && method === 'PATCH') {
        const conv = conversations.get(convMatch[1]);
        if (!conv) return new Response('Conversation not found', { status: 404 });
        if (body && 'title' in body && body.title !== undefined) {
          conv.title = body.title ?? '';
        }
        if (body && body.settings !== undefined) {
          // Mirrors DesktopSyncService.updateConversation in yvoke-web: replaces settings map if desktop sends partial settings!
          conv.settings = normalizeServerSettings(body.settings);
        }
        conv.updatedAt = new Date().toISOString();
        return new Response('', { status: 200 });
      }

      // DELETE /conversations/:id
      if (convMatch && method === 'DELETE') {
        conversations.delete(convMatch[1]);
        messagesByConv.delete(convMatch[1]);
        return new Response(null, { status: 204 });
      }

      // GET /conversations/:id/messages
      const msgMatch = p.match(/^\/conversations\/([^/]+)\/messages$/);
      if (msgMatch && method === 'GET') {
        const list = messagesByConv.get(msgMatch[1]);
        if (!list) return new Response('Conversation not found', { status: 404 });
        return new Response(JSON.stringify(list), { status: 200 });
      }

      // POST /conversations/:id/messages
      if (msgMatch && method === 'POST') {
        if (server.failNextAppendStatus !== null) {
          const status = server.failNextAppendStatus;
          server.failNextAppendStatus = null;
          return new Response(`Simulated ${status}`, { status });
        }
        const convId = msgMatch[1];
        const list = messagesByConv.get(convId);
        if (!list) return new Response('Conversation not found', { status: 404 });
        const incoming = (body?.messages ?? []) as NewMessagePayload[];
        const ids: string[] = [];
        for (const m of incoming) {
          if (m.playbookVersion != null && (!Number.isInteger(m.playbookVersion) || m.playbookVersion < 1)) {
            return new Response('Invalid playbookVersion', { status: 400 });
          }
          const id = `srv-msg-${seq++}`;
          const dto: MessageDto = {
            id,
            role: m.role,
            content: m.content,
            playbook: m.playbook ?? null,
            playbookVersion: m.playbook ? (m.playbookVersion ?? null) : null,
            promptTokens: m.promptTokens ?? null,
            completionTokens: m.completionTokens ?? null,
            totalTokens: m.totalTokens ?? null,
            cachedTokens: m.cachedTokens ?? null,
            thoughtTokens: m.thoughtTokens ?? null,
            createdAt: new Date().toISOString(),
            feedbackRating: null,
            feedbackComment: null,
          };
          list.push(dto);
          messagesById.set(id, dto);
          ids.push(id);
        }
        return new Response(JSON.stringify({ ids }), { status: 200 });
      }

      // PUT /messages/:id/feedback
      const fbMatch = p.match(/^\/messages\/([^/]+)\/feedback$/);
      if (fbMatch && method === 'PUT') {
        const msg = messagesById.get(fbMatch[1]);
        if (!msg) return new Response('Message not found', { status: 404 });
        msg.feedbackRating = body.rating;
        msg.feedbackComment = body.comment ?? null;
        return new Response(
          JSON.stringify({ messageId: msg.id, rating: msg.feedbackRating, comment: msg.feedbackComment }),
          { status: 200 },
        );
      }

      // POST /orchestrator/runs
      if (method === 'POST' && p === '/orchestrator/runs') {
        if (server.failNextRunStatus !== null) {
          const status = server.failNextRunStatus;
          server.failNextRunStatus = null;
          return new Response(`Simulated run failure ${status}`, { status });
        }
        const payload = body as OrchestratorRunPayload;
        if (!conversations.has(payload.conversationId)) {
          return new Response('Unknown conversationId', { status: 404 });
        }
        if (!payload.messageId || !messagesById.has(payload.messageId)) {
          return new Response('FK violation: messageId does not exist', { status: 400 });
        }
        for (const step of payload.steps ?? []) {
          if (step.playbookVersion != null && (!Number.isInteger(step.playbookVersion) || step.playbookVersion < 1)) {
            return new Response('Invalid step playbookVersion', { status: 400 });
          }
        }
        const runId = `srv-run-${seq++}`;
        runs.push({ ...payload, id: runId });
        return new Response(JSON.stringify({ id: runId }), { status: 200 });
      }

      return new Response(`Unhandled ${method} ${p}`, { status: 404 });
    }) as typeof fetch,
  };

  return server;
}

const TEST_PROMPTS: McpPromptInfo[] = [
  {
    name: 'oim-schema',
    title: 'OIM Schema',
    description: 'Database schema specialist',
    arguments: [],
    version: 2,
  },
  {
    name: 'oim-orchestrator',
    title: 'OIM Orchestrator',
    description: 'Orchestrator prompt',
    arguments: [],
    targetAgent: 'orchestrator',
    version: 2,
  },
  {
    name: 'oim-access-governance',
    title: 'OIM Access Governance',
    description: 'Access governance specialist',
    arguments: [],
    targetAgent: 'specialist',
    version: 4,
  },
  {
    name: 'oim-orchestrator-reviewer',
    title: 'OIM Reviewer',
    description: 'Reviewer prompt',
    arguments: [],
    targetAgent: 'reviewer',
    version: 3,
  },
];

describe('End-to-End Web Communication Contract (AppCore + SyncQueue + SyncClient + yvoke-web Harness)', () => {
  let tmpDir1: string;
  let tmpDir2: string;
  let server: InMemoryWebServer;
  let appCore1: AppCore;
  let appCore2: AppCore | null = null;

  function wireAppCore(userDataDir: string): AppCore {
    const core = new AppCore({
      userDataDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
    // Route SyncClient through the in-memory yvoke-web server harness
    (core.syncClient as any).fetchFn = server.fetchFn;
    vi.spyOn(core.serverAuth, 'getAccessToken').mockResolvedValue('dev-token');
    vi.spyOn(core.mcpPrompts, 'list').mockImplementation(async () => TEST_PROMPTS);
    return core;
  }

  beforeEach(() => {
    tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'web-contract-dev1-'));
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'web-contract-dev2-'));
    server = createInMemoryYvokeWebServer();
    appCore1 = wireAppCore(tmpDir1);
  });

  afterEach(async () => {
    await appCore1.drain();
    appCore1.dispose();
    if (appCore2) {
      await appCore2.drain();
      appCore2.dispose();
      appCore2 = null;
    }
    fs.rmSync(tmpDir1, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Scenario A: Single-Agent Round-Trip, Assistant Playbook Attribution, Feedback, & Second-Device Rehydration', async () => {
    const prompts = await appCore1.listPrompts();
    expect(prompts.find((p) => p.name === 'oim-schema')?.version).toBe(2);

    const sysPrompt = await appCore1.syncClient.getSystemPrompt('default-chat' as ValidSystemPromptName);
    expect(sysPrompt).toBe('SYSTEM_PROMPT(default-chat)');

    const thread = await appCore1.createThread();
    appCore1.threads.patch(thread.id, { initialPlaybook: 'oim-schema', hasStarted: true });

    const userMsg: ChatMessage = {
      localId: 'local-u-1',
      role: 'user',
      content: 'What tables store attestation cases?',
      playbook: 'oim-schema',
      playbookVersion: 2,
      createdAt: '2026-10-28T10:00:00.000Z',
    };
    const assistantMsg: ChatMessage = {
      localId: 'local-a-1',
      role: 'assistant',
      content: 'The `AttestationCase` table stores attestation cases.',
      thinking: 'Checking AttestationCase table schema...',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'mcp__yvoke__get_json_schema',
          input: { table: 'AttestationCase' },
          result: 'Table AttestationCase columns...',
        },
      ],
      blocks: [
        {
          thinking: 'Checking AttestationCase table schema...',
          toolCalls: [
            {
              id: 'tc-1',
              name: 'mcp__yvoke__get_json_schema',
              input: { table: 'AttestationCase' },
              result: 'Table AttestationCase columns...',
            },
          ],
          text: 'The `AttestationCase` table stores attestation cases.',
        },
      ],
      playbook: 'oim-schema',
      playbookVersion: 2,
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        thoughtTokens: 25,
      },
      createdAt: '2026-10-28T10:00:05.000Z',
    };

    (appCore1 as any).persistTurn(thread.id, userMsg, assistantMsg);
    await appCore1.drain();
    await appCore1.syncQueue.flush();

    // Verify server received both user and assistant messages with playbook + playbookVersion
    const serverMsgs = server.messagesByConv.get(thread.id)!;
    expect(serverMsgs).toHaveLength(2);
    expect(serverMsgs[0]).toMatchObject({
      role: 'user',
      playbook: 'oim-schema',
      playbookVersion: 2,
    });
    expect(serverMsgs[1]).toMatchObject({
      role: 'assistant',
      playbook: 'oim-schema',
      playbookVersion: 2,
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      cachedTokens: 40,
      thoughtTokens: 25,
    });
    expect(serverMsgs[1].content).toContain('<think>');
    expect(serverMsgs[1].content).toContain('🔧 *Calling tool:*');

    // Submit positive feedback on assistant message
    await appCore1.submitFeedback({
      threadId: thread.id,
      messageLocalId: 'local-a-1',
      rating: 1,
      comment: 'Accurate schema reference',
    });

    // Second device rehydration
    appCore2 = wireAppCore(tmpDir2);
    const listRes = await appCore2.listThreads();
    expect(listRes.serverReachable).toBe(true);
    expect(listRes.threads.some((t) => t.id === thread.id)).toBe(true);

    const rehydrated = await appCore2.getMessages(thread.id);
    expect(rehydrated).toHaveLength(2);
    expect(rehydrated[0]).toMatchObject({
      role: 'user',
      content: 'What tables store attestation cases?',
      playbook: 'oim-schema',
      playbookVersion: 2,
    });
    expect(rehydrated[1]).toMatchObject({
      role: 'assistant',
      content: 'The `AttestationCase` table stores attestation cases.',
      thinking: 'Checking AttestationCase table schema...',
      playbook: 'oim-schema',
      playbookVersion: 2,
      feedback: { rating: 1, comment: 'Accurate schema reference' },
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        thoughtTokens: 25,
      },
    });
    expect(rehydrated[1].toolCalls).toHaveLength(1);

    // Verify getMessages backfilled initialPlaybook and hasStarted on second device
    const rehydratedMeta = appCore2.threads.get(thread.id)!;
    expect(rehydratedMeta.initialPlaybook).toBe('oim-schema');
    expect(rehydratedMeta.hasStarted).toBe(true);
    expect(rehydratedMeta.totals.inputTokens).toBe(120);
    expect(rehydratedMeta.totals.outputTokens).toBe(80);
  });

  it('Scenario B: Multi-Agent Round-Trip, Full Settings Retention, Server Repair, & Slow-Cache Race Proof', async () => {
    const thread = await appCore1.createThread();

    // Seed web-owned settings onto the server conversation and sync via listThreads()
    const srvConv = server.conversations.get(thread.id)!;
    srvConv.settings['chat-prompt'] = 'corp-default';
    srvConv.settings['show-thinking'] = true;
    await appCore1.listThreads();

    // Select multi-agent profile, then subsequently patch model, thinkingLevel, and title
    appCore1.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    appCore1.patchThread(thread.id, { model: 'opus' });
    appCore1.patchThread(thread.id, { thinkingLevel: 'high' });
    appCore1.patchThread(thread.id, { title: 'OIM Multi-Agent Deep Dive' });

    // Wait for async PATCH calls to settle
    await new Promise((r) => setTimeout(r, 10));

    // Server settings must still retain 'orchestrator-profile': 'OIM', 'model': 'opus', AND web-owned sibling keys
    expect(srvConv.title).toBe('OIM Multi-Agent Deep Dive');
    expect(srvConv.settings).toMatchObject({
      'chat-prompt': 'corp-default',
      'show-thinking': true,
      model: 'opus',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // Simulate a broken v1.3.0 server conversation whose 'orchestrator-profile' was wiped on the server
    delete srvConv.settings['orchestrator-profile'];
    await appCore1.listThreads();
    await new Promise((r) => setTimeout(r, 10));
    expect(server.conversations.get(thread.id)!.settings).toMatchObject({
      'chat-prompt': 'corp-default',
      'show-thinking': true,
      model: 'opus',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // Expire profilesCache and make both profile resolution and mcpPrompts.list() slower (40ms) than appendMessages (0ms)
    (appCore1 as any).profilesCache = null;
    server.profilesDelayMs = 40;
    vi.spyOn(appCore1.mcpPrompts, 'list').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return TEST_PROMPTS;
    });

    const userMsg: ChatMessage = {
      localId: 'orch-u-1',
      role: 'user',
      content: 'Explain DynamicGroup evaluation in OIM',
      createdAt: '2026-10-28T10:05:00.000Z',
    };
    const assistantMsg: ChatMessage = {
      localId: 'orch-a-1',
      role: 'assistant',
      content: 'DynamicGroup memberships are evaluated by the DBQueue.',
      toolCalls: [
        {
          id: 'tc-spec-1',
          name: 'Agent',
          subagentType: 'oim-access-governance',
          input: { prompt: 'Check DynamicGroup evaluation' },
          result: 'DBQueue calculates DynamicGroup memberships.',
        },
        {
          id: 'tc-rev-1',
          name: 'Agent',
          subagentType: 'reviewer',
          input: { prompt: 'Review draft' },
          result: 'APPROVED\nVerified.',
          verdict: { approved: true, feedback: 'Verified.' },
        },
      ],
      review: { outcome: 'approved', feedback: 'Verified.' },
      usage: { inputTokens: 500, outputTokens: 250, cacheReadTokens: 100, cacheWriteTokens: 0, thoughtTokens: 50 },
      createdAt: '2026-10-28T10:06:30.000Z',
    };

    (appCore1 as any).persistTurn(thread.id, userMsg, assistantMsg);
    await appCore1.drain();
    await appCore1.syncQueue.flush();

    // Wait for the slow 40ms stashOrchestratorRun promise chain to finish and POST to /orchestrator/runs
    for (let i = 0; i < 40 && server.runs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(server.runs).toHaveLength(1);
    const recordedRun = server.runs[0];
    const syncedAssistantDto = server.messagesByConv.get(thread.id)!.find((m) => m.role === 'assistant')!;
    expect(recordedRun.conversationId).toBe(thread.id);
    expect(recordedRun.messageId).toBe(syncedAssistantDto.id);
    expect(recordedRun.profileName).toBe('OIM');
    expect(recordedRun.steps).toHaveLength(3);
    expect(recordedRun.steps[0]).toMatchObject({
      role: 'orchestrator',
      playbookName: 'oim-orchestrator',
      playbookVersion: 2,
    });
    expect(recordedRun.steps[1]).toMatchObject({
      role: 'specialist',
      playbookName: 'oim-access-governance',
      playbookVersion: 4,
    });
    expect(recordedRun.steps[2]).toMatchObject({
      role: 'reviewer',
      playbookName: 'oim-orchestrator-reviewer',
      playbookVersion: 3,
    });
  });

  it('Scenario C: Offline Queue Recovery & Transient POST /orchestrator/runs 502 Retry Recovery', async () => {
    const thread = await appCore1.createThread();
    appCore1.patchThread(thread.id, { orchestratorProfile: 'OIM' });

    // Part 1: appendMessages fails with 502 first, then succeeds on retry flush
    server.failNextAppendStatus = 502;
    (appCore1 as any).persistTurn(
      thread.id,
      { localId: 'c-u-1', role: 'user', content: 'Turn 1', createdAt: 'now' },
      {
        localId: 'c-a-1',
        role: 'assistant',
        content: 'Answer 1',
        toolCalls: [
          { id: 'tc-1', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'q' }, result: 'a' },
        ],
        createdAt: 'now',
      },
    );
    await appCore1.drain();
    await ((appCore1.syncQueue as any).flushPromise ?? Promise.resolve());
    expect(server.messagesByConv.get(thread.id)).toHaveLength(0);
    expect(server.runs).toHaveLength(0);

    // Retry flush succeeds for both messages and run
    await appCore1.syncQueue.flush();
    for (let i = 0; i < 20 && server.runs.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.messagesByConv.get(thread.id)).toHaveLength(2);
    expect(server.runs).toHaveLength(1);

    // Part 2: appendMessages succeeds (200), but POST /orchestrator/runs fails transiently with 502
    server.failNextRunStatus = 502;
    (appCore1 as any).persistTurn(
      thread.id,
      { localId: 'c-u-2', role: 'user', content: 'Turn 2', createdAt: 'now' },
      {
        localId: 'c-a-2',
        role: 'assistant',
        content: 'Answer 2',
        toolCalls: [
          { id: 'tc-2', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'q2' }, result: 'a2' },
        ],
        createdAt: 'now',
      },
    );
    await appCore1.drain();
    await appCore1.syncQueue.flush();
    await new Promise((r) => setTimeout(r, 20));

    // Messages were stored on server, but run 2 failed with 502 and is buffered in failedRuns
    expect(server.messagesByConv.get(thread.id)).toHaveLength(4);
    expect(server.runs).toHaveLength(1);
    expect((appCore1 as any).failedRuns).toHaveLength(1);

    // Before backoff window expires (< 5_000ms), listThreads does NOT drain the failed run
    await appCore1.listThreads();
    await new Promise((r) => setTimeout(r, 10));
    expect(server.runs).toHaveLength(1);
    expect((appCore1 as any).failedRuns).toHaveLength(1);

    // Advance Date.now past the 5_000ms backoff window; next sync activity (listThreads) drains failedRuns and records run 2
    const futureNow = Date.now() + 6_000;
    vi.spyOn(Date, 'now').mockReturnValue(futureNow);
    await appCore1.listThreads();
    for (let i = 0; i < 20 && server.runs.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(server.runs).toHaveLength(2);
    expect((appCore1 as any).failedRuns).toHaveLength(0);
  });
});

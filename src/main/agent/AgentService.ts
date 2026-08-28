import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, AppSettings, ChatMessage, OrchestratorProfile, ThinkingLevel, ThreadMeta, McpPromptInfo } from '../../shared/types';
import { EMPTY_USAGE, MCP_TOOL_PREFIX } from '../../shared/types';
import { isAuthError, LOGIN_INSTRUCTIONS, sanitizedEnv } from './ClaudeAuth';
import { log, logError } from '../log';
import { buildMcpServers, type McpAuthProvider } from './McpConnection';
import { buildAllowedTools, buildAutoApproveTools, buildCanUseTool } from './policy';
import { thinkingBudget } from './thinking';
import {
  addUsage,
  newTurnContext,
  nextReviewAction,
  reviewAttempts,
  reviewStatusOf,
  translateMessage,
  usageFromSdk,
  type TurnContext,
} from './translate';
import { SyncClient } from '../sync/SyncClient';
import { McpPrompts } from './McpPrompts';
import {
  buildOrchestrator,
  buildRevisionPrompt,
  ORCHESTRATOR_AGENT,
  REVIEW_ENFORCEMENT_PROMPT,
  reviewFlagNote,
} from './orchestration';

/** The server-managed system prompt every turn runs under. */
export const BASE_SYSTEM_PROMPT_NAME = 'default-chat';

/**
 * Path to the native Claude Code binary staged for this build target, or null in dev.
 *
 * The SDK otherwise locates the binary by interpolating the running host into a package name
 * (`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`) and resolving it
 * from node_modules. That only ever works for the platform the build machine happens to be, so
 * packaged builds ship a single binary fetched for the target instead — see
 * scripts/fetch-claude-binary.ts and the `extraResources` entry in electron-builder.yml.
 *
 * Resolved by probing resourcesPath rather than `app.isPackaged` so this module stays importable
 * outside Electron (tests/systemPrompt.test.ts loads it directly). In a dev run resourcesPath
 * points into node_modules/electron, where no such file exists, and the SDK's own resolution
 * takes over.
 */
function stagedClaudeBinary(): string | null {
  if (!process.resourcesPath) return null;
  const staged = path.join(process.resourcesPath, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(staged) ? staged : null;
}

const claudeBinary = stagedClaudeBinary();

/**
 * The staged binary path (or null), for other local one-shot SDK calls — the playbook preflight
 * check runs its own `query()` and needs the same packaged-build resolution this module does.
 */
export function claudeBinaryPath(): string | null {
  return claudeBinary;
}

/**
 * Loads the base system prompt from the server, throwing if it cannot be had.
 *
 * There is deliberately NO local fallback. The prompt carries the grounding rules, the citation
 * contract and the mermaid/KaTeX delimiters; a hardcoded copy would drift from the server's
 * `default-chat` and silently contradict the playbooks and tools, which is worse than not
 * answering. Running with an empty prompt — which is what the previous "fallback" actually did,
 * since its catch block logged but never assigned — is worse still.
 *
 * Thrown messages reach the user: App.tsx puts them on the failed turn.
 */
export async function loadRequiredSystemPrompt(
  syncClient: Pick<SyncClient, 'getSystemPrompt'>,
): Promise<string> {
  let prompt: string;
  try {
    prompt = await syncClient.getSystemPrompt(BASE_SYSTEM_PROMPT_NAME);
  } catch (err) {
    throw new Error(
      `System prompt "${BASE_SYSTEM_PROMPT_NAME}" could not be loaded (is the server reachable?): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!prompt || !prompt.trim()) {
    // A 200 with an empty body is a failure too, not an empty-but-valid prompt.
    throw new Error(
      `System prompt "${BASE_SYSTEM_PROMPT_NAME}" came back empty (is the server reachable?).`,
    );
  }
  log('agent', `Loaded system prompt "${BASE_SYSTEM_PROMPT_NAME}" from remote server`);
  return prompt;
}

/** Simple push-based async iterable used as the streaming-input prompt. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private buffer: SDKUserMessage[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value: message, done: false });
    } else {
      this.buffer.push(message);
    }
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

export interface SendOptions {
  /** Thinking override for exactly this message. */
  thinkingOverride?: ThinkingLevel;
  /** Playbook text injected ahead of the user's message for the model only. */
  injectBefore?: string;
  /** Display label for the injected playbook, stored on the user message. */
  playbook?: string;
  playbookName?: string;
}

interface ThreadSession {
  query: Query;
  queue: MessageQueue;
  model: string;
  thinkingLevel: ThinkingLevel;
  busy: boolean;
  /** Set when the user presses Stop, so the resulting error reads as a clean stop. */
  interrupted: boolean;
  turn: TurnContext;
  lastActiveAt: number;
  playbookName?: string;
  /** Selected multi-agent profile for this session, if orchestrator mode is active. */
  orchestratorProfile?: string;
  /** The user message for the in-flight turn, persisted once the turn completes. */
  pendingUser?: ChatMessage;
  /** The playbook whose instructions are in this session's context, if any. */
  injectedPlaybook?: string;
}

export interface AgentServiceDeps {
  getSettings: () => AppSettings;
  mcpAuthProvider: McpAuthProvider;
  emit: (event: AgentEvent) => void;
  /** Called when a session id is (re)established for a thread, for resume persistence. */
  onSessionId: (threadId: string, sessionId: string) => void;
  /** Called when a turn finishes so the store/sync layers can persist it. */
  onTurnPersist: (threadId: string, userMessage: ChatMessage, assistantMessage: ChatMessage) => void;
  sandboxDir: string;
  syncClient: SyncClient;
  mcpPrompts: McpPrompts;
  /** Resolve a multi-agent profile by name (orchestrator mode); undefined if unknown/unavailable. */
  getOrchestratorProfile: (name: string) => Promise<OrchestratorProfile | undefined>;
}

/**
 * One live Agent SDK query per open thread (streaming-input mode keeps the bundled
 * CLI subprocess warm between turns). Model and thinking level apply per turn via
 * the SDK's runtime setters; a thinking override lasts exactly one message.
 */
export class AgentService {
  private readonly sessions = new Map<string, ThreadSession>();
  public readonly pendingClarifications = new Map<string, (answer: string) => void>();
  /** Outstanding clarification toolUseIds per thread, so they can be cancelled on interrupt/close. */
  private readonly threadClarifications = new Map<string, Set<string>>();

  resolveClarification(toolUseId: string, answer: string): void {
    const resolve = this.pendingClarifications.get(toolUseId);
    if (resolve) {
      resolve(answer);
      this.pendingClarifications.delete(toolUseId);
    }
    for (const ids of this.threadClarifications.values()) {
      ids.delete(toolUseId);
    }
  }

  /** Resolve any clarifications still awaiting an answer for a thread with an empty (cancel) answer. */
  private cancelClarifications(threadId: string): void {
    const ids = this.threadClarifications.get(threadId);
    if (!ids) return;
    for (const toolUseId of ids) {
      const resolve = this.pendingClarifications.get(toolUseId);
      if (resolve) {
        resolve('');
        this.pendingClarifications.delete(toolUseId);
      }
    }
    this.threadClarifications.delete(threadId);
  }

  constructor(private readonly deps: AgentServiceDeps) {}

  async sendMessage(thread: ThreadMeta, text: string, opts: SendOptions = {}): Promise<void> {
    let session = await this.ensureSession(thread, opts.playbookName);
    if (session.busy) {
      throw new Error('A turn is already running for this conversation.');
    }

    if (session.playbookName !== opts.playbookName || session.orchestratorProfile !== thread.orchestratorProfile) {
      log(
        'agent',
        `Session config changed (playbook "${session.playbookName}"→"${opts.playbookName}", ` +
          `profile "${session.orchestratorProfile}"→"${thread.orchestratorProfile}"), restarting agent session`,
      );
      this.closeThread(thread.id);
      session = await this.ensureSession(thread, opts.playbookName);
    }

    // In orchestrator mode the per-role models/thinking are fixed by the profile + settings; the
    // thread-level model/thinking selectors (and per-message thinking override) do not apply.
    if (!thread.orchestratorProfile) {
      if (session.model !== thread.model) {
        await session.query.setModel(thread.model);
        session.model = thread.model;
      }
      const effectiveThinking = opts.thinkingOverride ?? thread.thinkingLevel;
      if (session.thinkingLevel !== effectiveThinking) {
        await session.query.setMaxThinkingTokens(thinkingBudget(effectiveThinking));
        session.thinkingLevel = effectiveThinking;
      }
    }

    session.busy = true;
    session.interrupted = false;
    session.lastActiveAt = Date.now();
    session.turn = newTurnContext(thread.id, Boolean(thread.orchestratorProfile));
    session.turn.sessionId = thread.sessionId;
    this.deps.emit({ kind: 'turn-start', threadId: thread.id });

    // The model sees the playbook (if any) prepended the first time that playbook is used in this
    // session; follow-up turns under the same playbook omit it to preserve context. Tracking the
    // name rather than a flag is what makes the two switch paths safe: a session rebuilt for a
    // different playbook (the restart below) and a session resumed from disk have both not seen
    // the selected playbook's text, and neither can be relied on to reset a boolean.
    const shouldInjectPlaybook = Boolean(opts.injectBefore) && session.injectedPlaybook !== opts.playbookName;
    const modelText = shouldInjectPlaybook ? `${opts.injectBefore}\n\n---\n\n${text}` : text;
    if (shouldInjectPlaybook) {
      session.injectedPlaybook = opts.playbookName;
    }
    const userMessage: ChatMessage = {
      localId: randomUUID(),
      role: 'user',
      content: text,
      playbook: opts.playbook,
      createdAt: new Date().toISOString(),
    };
    session.pendingUser = userMessage;

    session.queue.push({
      type: 'user',
      message: { role: 'user', content: modelText },
      parent_tool_use_id: null,
    });
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.interrupted = true;
      await session.query.interrupt();
    }
    // A pending clarifying question would otherwise leave its promise (and resolver) hanging forever.
    this.cancelClarifications(threadId);
  }

  closeThread(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.queue.close();
      session.query.close();
      this.sessions.delete(threadId);
    }
    this.cancelClarifications(threadId);
  }

  closeAll(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.closeThread(threadId);
    }
  }

  private async ensureSession(thread: ThreadMeta, playbookName?: string): Promise<ThreadSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    const MAX_WARM_SESSIONS = 3;
    if (this.sessions.size >= MAX_WARM_SESSIONS) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, s] of this.sessions.entries()) {
        if (!s.busy && s.lastActiveAt < oldestTime) {
          oldestTime = s.lastActiveAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        log('agent', `evicting warm session for thread=${oldestId} due to warm session limit`);
        this.closeThread(oldestId);
      }
    }

    const settings = this.deps.getSettings();
    fs.mkdirSync(this.deps.sandboxDir, { recursive: true });

    const systemPrompt = await loadRequiredSystemPrompt(this.deps.syncClient);

    let playbookTools: string[] | undefined;
    // undefined = no playbook metadata resolved, which buildAllowedTools reads as "not declared".
    let playbookCodeExecution: boolean | undefined;
    if (playbookName) {
      try {
        const prompts = await this.deps.mcpPrompts.list();
        const p = prompts.find((pr: McpPromptInfo) => pr.name === playbookName);
        if (p) {
          playbookTools = p.tools;
          playbookCodeExecution = p.codeExecution;
          log('agent', `Resolved playbook "${playbookName}" constraints — tools=${playbookTools ? playbookTools.join(',') : 'all'} codeExecution=${playbookCodeExecution !== false}`);
        }
      } catch (err) {
        logError('agent', `Failed to load playbook metadata for "${playbookName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const queue = new MessageQueue();
    const onClarifyingQuestion = (toolUseId: string, question: string, options: string[]) => {
      this.deps.emit({
        kind: 'clarifying-question',
        threadId: thread.id,
        toolUseId,
        question,
        options,
      });
      let ids = this.threadClarifications.get(thread.id);
      if (!ids) {
        ids = new Set<string>();
        this.threadClarifications.set(thread.id, ids);
      }
      ids.add(toolUseId);
      return new Promise<string>((resolve) => {
        this.pendingClarifications.set(toolUseId, resolve);
      });
    };

    // Orchestrator mode: resolve the selected profile into an `agents` map + allow-list. The
    // orchestrator's system prompt comes from its AgentDefinition, so the base systemPrompt is unused.
    let orchestrator: Awaited<ReturnType<typeof buildOrchestrator>> | undefined;
    if (thread.orchestratorProfile) {
      const profile = await this.deps.getOrchestratorProfile(thread.orchestratorProfile);
      if (!profile) {
        throw new Error(
          `Orchestrator profile "${thread.orchestratorProfile}" is unavailable (is the server reachable?).`,
        );
      }
      orchestrator = await buildOrchestrator(profile, settings, this.deps.mcpPrompts, systemPrompt);
      const oc = settings.orchestrator;
      log(
        'orch',
        `setup profile="${profile.name}" ` +
          `orchestrator=${oc?.orchestrator.model}/${oc?.orchestrator.thinkingLevel} ` +
          `specialist=${oc?.specialist.model}/${oc?.specialist.thinkingLevel} ` +
          `reviewer=${oc?.reviewer.model}/${oc?.reviewer.thinkingLevel} ` +
          `maxRounds=${oc?.maxReviewRounds} maxCalls=${oc?.maxSpecialistCalls}`,
      );
      log('orch', `specialists (${orchestrator.specialistNames.length}): ${orchestrator.specialistNames.join(', ')}`);
    }

    const allowedToolsList = orchestrator
      ? orchestrator.allowedTools
      : buildAllowedTools(settings, playbookTools, playbookCodeExecution);

    const orchCfg = settings.orchestrator;
    const effectiveModel = orchestrator && orchCfg ? orchCfg.orchestrator.model : thread.model;
    const effectiveThinking =
      orchestrator && orchCfg ? orchCfg.orchestrator.thinkingLevel : thread.thinkingLevel;

    const options: Options = {
      systemPrompt: orchestrator ? '' : systemPrompt,
      mcpServers: await buildMcpServers(settings, this.deps.mcpAuthProvider),
      // NOT the full grant: `allowedTools` auto-approves, and an auto-approved tool never reaches
      // canUseTool. Web access and the clarifying question are enforced/intercepted only in that
      // callback, so they are withheld here and answered there instead — see policy.ts.
      allowedTools: buildAutoApproveTools(allowedToolsList),
      // Hard-block the shell everywhere: the safe mcp__compute__* tools replace it, and this
      // ensures the model is never even offered Bash regardless of the allow-list.
      disallowedTools: ['Bash'],
      // The FULL grant, which is what the playbook gate inside the callback compares against.
      canUseTool: buildCanUseTool(this.deps.getSettings, thread.id, onClarifyingQuestion, allowedToolsList,
        playbookCodeExecution, Boolean(orchestrator)),
      settingSources: [],
      includePartialMessages: true,
      model: effectiveModel,
      maxThinkingTokens: thinkingBudget(effectiveThinking),
      maxTurns: orchestrator && orchCfg ? orchCfg.orchestratorMaxTurns : settings.maxTurns,
      cwd: this.deps.sandboxDir,
      // CLAUDE_DEBUG makes the bundled CLI subprocess log its API/tool activity to stderr.
      // Enable it by default only in dev (ELECTRON_RENDERER_URL is set by electron-vite dev);
      // in a packaged build it stays off unless the user explicitly exports CLAUDE_DEBUG
      // (which survives via sanitizedEnv), so production runs aren't verbose by default.
      env: debugEnv(),
      ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
      ...(orchestrator ? { agent: ORCHESTRATOR_AGENT, agents: orchestrator.agents, forwardSubagentText: true } : {}),
      ...(thread.sessionId ? { resume: thread.sessionId } : {}),
    };

    log(
      'agent',
      `new session thread=${thread.id} model=${effectiveModel} thinking=${effectiveThinking}` +
        (orchestrator ? ` orchestrator=${thread.orchestratorProfile}` : '') +
        (thread.sessionId ? ` resume=${thread.sessionId}` : ' (fresh)'),
    );
    const q = query({ prompt: queue, options });
    const session: ThreadSession = {
      query: q,
      queue,
      model: effectiveModel,
      thinkingLevel: effectiveThinking,
      busy: false,
      interrupted: false,
      turn: newTurnContext(thread.id, Boolean(thread.orchestratorProfile)),
      lastActiveAt: Date.now(),
      playbookName,
      orchestratorProfile: thread.orchestratorProfile,
    };
    this.sessions.set(thread.id, session);
    void this.consume(thread.id, session);
    return session;
  }

  /** One-line preview of a longer string for logs (collapse whitespace, cap length). */
  private static preview(text: string, max = 600): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}… (${flat.length} chars)` : flat;
  }

  /**
   * Orchestrator-mode trace: log delegations (with the full prompt handed to the specialist),
   * completions, review verdicts and clarifying questions as they stream by. Scope `orch`.
   */
  private logOrchestrationEvent(event: AgentEvent): void {
    switch (event.kind) {
      case 'subagent-start':
        log('orch', `→ delegate to "${event.subagentType}" — prompt: ${AgentService.preview(event.question, 2000)}`);
        break;
      case 'subagent-complete':
        log(
          'orch',
          `← "${event.subagentType}" ${event.isError ? 'FAILED' : 'returned'}: ${AgentService.preview(event.result)}`,
        );
        break;
      case 'review-verdict':
        log('orch', `⚖ review ${event.approved ? 'APPROVED' : 'REJECTED'}${event.feedback ? ` — ${AgentService.preview(event.feedback)}` : ''}`);
        break;
      case 'clarifying-question':
        log('orch', `❓ clarifying question: ${AgentService.preview(event.question)}${event.options?.length ? ` [options: ${event.options.join(' | ')}]` : ''}`);
        break;
      default:
        break;
    }
  }

  /**
   * Log the tool activity a specialist/reviewer sub-agent performs inside its own turn. These arrive
   * as forwarded messages carrying `parent_tool_use_id` (the spawning Agent call), so we resolve the
   * sub-agent's name from the turn's delegation map. This is what `search_corpus`/`get_section`/… the
   * specialist actually ran — the detail behind its final answer.
   */
  private logSubagentActivity(message: unknown, session: ThreadSession): void {
    const msg = message as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } };
    const parentId = msg.parent_tool_use_id ?? null;
    if (!parentId) return;
    const who = session.turn.agentCalls.get(parentId)?.subagentType ?? 'sub-agent';
    const content = Array.isArray(msg.message?.content) ? (msg.message!.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (msg.type === 'assistant' && block.type === 'tool_use') {
        const name = String(block.name);
        if (name === 'Agent') continue; // nested delegation; surfaced via its own subagent-start
        log('orch', `   [${who}] tool ${name}(${AgentService.preview(JSON.stringify(block.input ?? {}), 300)})`);
      } else if (msg.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        log('orch', `   [${who}] says: ${AgentService.preview(block.text)}`);
      }
    }
  }

  private async consume(threadId: string, session: ThreadSession): Promise<void> {
    const startedAt = Date.now();
    try {
      for await (const message of session.query) {
        log('sdk', `${message.type}${'subtype' in message && message.subtype ? `/${message.subtype}` : ''}`);
        if (session.orchestratorProfile) {
          this.logSubagentActivity(message, session);
        }
        for (const event of translateMessage(message, session.turn)) {
          if (session.orchestratorProfile) {
            this.logOrchestrationEvent(event);
          }
          this.deps.emit(event);
        }
        if (message.type === 'system' && message.subtype === 'init') {
          const servers = (message.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`).join(', ') || 'none';
          const tools = (message.tools ?? []) as string[];
          const kbTools = tools.filter((t) => t.startsWith(MCP_TOOL_PREFIX));
          log('agent', `init session=${message.session_id} model=${message.model}`);
          log(
            'mcp',
            `agent connection — servers: [${servers}] · ${kbTools.length} knowledge-base tools` +
              ` of ${tools.length} total · ${(message.slash_commands ?? []).length} slash-commands`,
          );
          if (kbTools.length > 0) {
            log('mcp', `agent knowledge-base tools: ${kbTools.join(', ')}`);
          }
          this.deps.onSessionId(threadId, message.session_id);
        }
        if (message.type === 'result') {
          this.completeTurn(threadId, session, message, startedAt);
        }
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      logError('agent', `turn failed thread=${threadId}:`, messageText);
      const authRequired = isAuthError(messageText);
      this.deps.emit({
        kind: 'error',
        threadId,
        message: authRequired ? LOGIN_INSTRUCTIONS : messageText,
        authRequired,
      });
      session.busy = false;
      this.sessions.delete(threadId);
    }
  }

  /**
   * Code-driven review loop (Correctness Property: an orchestrated answer is never delivered
   * unreviewed, and a rejected one is never delivered without a revision attempt).
   *
   * The orchestrator adapter only *asks* for a reviewer pass and for revisions, so a model that
   * judges its answer obvious can skip the review, and one that disagrees with the reviewer can ship
   * the rejected draft anyway (both observed). The web harness drives these rounds from code; here we
   * do the same by discarding the draft, pushing a runtime notice back into the same session and
   * letting the turn continue — the next `result` completes it for real.
   *
   * Returns true when the turn was extended (the caller must not finalise it yet).
   */
  private maybeContinueForReview(threadId: string, session: ThreadSession, isError: boolean, aborted: boolean): boolean {
    const cfg = this.deps.getSettings().orchestrator;
    const action = nextReviewAction({
      orchestratorMode: !!session.orchestratorProfile && !!cfg,
      isError,
      aborted,
      alreadyEnforced: !!session.turn.reviewEnforced,
      revisionRounds: session.turn.revisionRounds,
      maxReviewRounds: cfg?.maxReviewRounds,
      requireReview: cfg?.requireReview,
      toolCalls: session.turn.toolCalls,
    });
    if (action.kind === 'deliver') return false;

    let content: string;
    let reason: 'skipped' | 'rejected' | 'unclear';
    let round: number | undefined;
    if (action.kind === 'enforce') {
      session.turn.reviewEnforced = true;
      content = REVIEW_ENFORCEMENT_PROMPT;
      reason = 'skipped';
      log('orch', '⚖ turn ended with no review pass — re-prompting the orchestrator to run the reviewer');
    } else {
      session.turn.revisionRounds = action.round;
      const maxRounds = cfg?.maxReviewRounds ?? 0;
      // Re-supplying the evidence is the point: the observed failure was a review request sent
      // without it, which the reviewer (correctly) rejected as unvalidatable.
      content = buildRevisionPrompt({
        feedback: action.feedback,
        toolCalls: session.turn.toolCalls,
        round: action.round,
        maxRounds,
      });
      reason = action.outcome;
      round = action.round;
      log(
        'orch',
        `⚖ reviewer ${action.outcome === 'unclear' ? 'returned no clear verdict' : 'REJECTED'} — ` +
          `revision round ${action.round}/${maxRounds}: handing the feedback + evidence back to the orchestrator`,
      );
    }

    // The draft is superseded by whatever comes back post-review; drop its prose so the delivered
    // message isn't "draft + final" concatenated. Tool cards and thinking stay — that is the trace.
    session.turn.turnText = '';
    session.turn.liveText = '';
    session.turn.blocks = session.turn.blocks
      .map((block) => ({ ...block, text: undefined }))
      .filter((block) => block.thinking || (block.toolCalls?.length ?? 0) > 0);

    this.deps.emit({ kind: 'review-enforced', threadId, reason, round });
    session.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    return true;
  }

  private completeTurn(
    threadId: string,
    session: ThreadSession,
    result: Extract<Awaited<ReturnType<Query['next']>>['value'], { type: 'result' }>,
    startedAt: number,
  ): void {
    const resultUsage = usageFromSdk(result.usage as unknown as Record<string, unknown>);
    const aborted = session.interrupted;
    const isError = result.is_error === true;

    const resultCostUsd = (result as { total_cost_usd?: number }).total_cost_usd;

    if (this.maybeContinueForReview(threadId, session, isError, aborted)) {
      // Each extra round produces a further `result`; keep this one's tokens/cost on the books.
      session.turn.carriedUsage = addUsage(session.turn.carriedUsage ?? EMPTY_USAGE, resultUsage);
      if (resultCostUsd != null) {
        session.turn.carriedCostUsd = (session.turn.carriedCostUsd ?? 0) + resultCostUsd;
      }
      return;
    }

    const usage = session.turn.carriedUsage ? addUsage(session.turn.carriedUsage, resultUsage) : resultUsage;
    const review = session.orchestratorProfile
      ? reviewStatusOf(session.turn.toolCalls, session.turn.reviewEnforced)
      : undefined;
    let content = session.turn.turnText || (isError ? '' : String((result as { result?: string }).result ?? ''));
    // Out of revision rounds with the reviewer still unsatisfied: the warning ships inside the
    // content (what gets synced and copied), not just as a renderer badge.
    if (content && (review?.outcome === 'rejected' || review?.outcome === 'unclear')) {
      content += reviewFlagNote(reviewAttempts(session.turn.toolCalls));
    }
    const assistantMessage: ChatMessage = {
      localId: randomUUID(),
      role: 'assistant',
      content,
      thinking: session.turn.turnThinking || undefined,
      toolCalls: session.turn.toolCalls,
      blocks: session.turn.blocks,
      review,
      usage,
      createdAt: new Date().toISOString(),
    };

    const costUsd =
      session.turn.carriedCostUsd != null ? session.turn.carriedCostUsd + (resultCostUsd ?? 0) : resultCostUsd;
    const errorMessage = isError ? String((result as { result?: string }).result ?? result.subtype) : undefined;
    log(
      'agent',
      `turn ${aborted ? 'stopped' : isError ? 'error' : 'complete'} thread=${threadId} ` +
        `in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} ` +
        `tools=${session.turn.toolCalls.length} ` +
        (review ? `review=${review.outcome}${review.enforced ? '(enforced)' : ''} ` : '') +
        (session.turn.revisionRounds ? `revisions=${session.turn.revisionRounds} ` : '') +
        `${costUsd != null ? `cost=$${costUsd.toFixed(4)} ` : ''}` +
        `${errorMessage ? `error="${errorMessage}" ` : ''}` +
        `${Date.now() - startedAt}ms`,
    );

    const pendingUser = session.pendingUser;
    if (!isError && pendingUser) {
      this.deps.onTurnPersist(threadId, pendingUser, assistantMessage);
    }

    this.deps.emit({
      kind: 'turn-complete',
      threadId,
      message: assistantMessage,
      usage,
      costUsd,
      durationMs: Date.now() - startedAt,
      isError,
      aborted,
      errorMessage: isError ? String((result as { result?: string }).result ?? result.subtype) : undefined,
    });

    session.busy = false;
    session.interrupted = false;
    session.lastActiveAt = Date.now();
    session.turn = newTurnContext(threadId, Boolean(session.orchestratorProfile));
  }
}

export function sandboxDirFor(userDataDir: string): string {
  return path.join(userDataDir, 'agent-sandbox');
}

/** Subprocess env: inherit (minus ANTHROPIC_API_KEY), defaulting CLAUDE_DEBUG on only in dev. */
export function debugEnv(): Record<string, string | undefined> {
  const env = sanitizedEnv();
  if (env.CLAUDE_DEBUG === undefined && process.env.ELECTRON_RENDERER_URL) {
    env.CLAUDE_DEBUG = '1';
  }
  return env;
}

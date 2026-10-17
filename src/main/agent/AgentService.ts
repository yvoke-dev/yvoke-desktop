import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AbortError,
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  ClarificationOption,
  ImageAttachment,
  ImageMediaType,
  LoginVerificationResult,
  McpPromptInfo,
  OrchestratorProfile,
  ReviewVerdict,
  ThinkingLevel,
  ThreadMeta,
  ToolCallInfo,
  UsageTotals,
} from '../../shared/types';
import { EMPTY_USAGE, MCP_SERVER_NAME, MCP_TOOL_PREFIX, parseVerdict, resolveCanonicalModel } from '../../shared/types';
import { hasErrorSourcePrefix, tagAttributedError, type ErrorSource } from '../../shared/error';
import { classifyClaudeFailure, detectClaudeAccount, detectClaudeCredentials, isAuthError, LOGIN_INSTRUCTIONS, sanitizedEnv } from './ClaudeAuth';
import { isResultFailure, NoReplyError, readSingleReply } from './singleTurn';
import { VALIDATION_TIMEOUT_MS } from './playbookValidation';
import { log, logError } from '../log';
import { buildMcpServers, type McpAuthProvider } from './McpConnection';
import { buildAllowedTools, buildAutoApproveTools, buildCanUseTool } from './policy';
import { thinkingBudget } from './thinking';
import {
  addUsage,
  newTurnContext,
  reviewAttempts,
  reviewStatusOf,
  translateMessage,
  usageFromSdk,
  type TurnContext,
} from './translate';
import { SyncClient } from '../sync/SyncClient';
import { McpPrompts } from './McpPrompts';
import { harvestSpecialistEvidence, SentLedger } from './evidenceDigest';
import {
  formatVerdictSummary,
  parseSubmitReviewArgs,
  REVIEW_SERVER_NAME,
  REVIEW_SUBMIT_TOOL,
} from './reviewTools';
import { buildReviewServer, buildSubmitAnswerServer } from './reviewServer';
import {
  afterAnswerMarker,
  buildOrchestrator,
  buildRevisionPrompt,
  ORCHESTRATOR_AGENT,
  renderReviewFollowUp,
  renderReviewTask,
  REVIEWER_SUBAGENT,
  reviewFlagNote,
  stripBeforeAnswerMarker,
  unreviewedNote,
  type ResolvedOrchestrator,
} from './orchestration';
import {
  BASE_SYSTEM_PROMPT_NAME,
  loadDesignatedSystemPrompt,
  loadRequiredSystemPrompt,
} from './systemPrompt';

/** The server-managed system prompt every turn runs under and helper loaders. */
export { BASE_SYSTEM_PROMPT_NAME, loadDesignatedSystemPrompt, loadRequiredSystemPrompt };

/** Timeout ceiling for dynamic MCP server configuration updates on warm sessions. */
export const MCP_UPDATE_TIMEOUT_MS = 10_000;

/** Expected model response token during Claude credential verification. */
const PROBE_TOKEN = 'pong';

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
 * Decides how a thrown turn failure reaches the user.
 *
 * An Entra or Yvoke Backend message was already attributed by the layer that raised it and
 * passes through untouched — re-tagging it would blame the wrong subsystem. Anything else is
 * attributed to `fallbackSource`, except a Claude auth failure, which is replaced by the
 * login instructions.
 */
function attributeTurnFailure(
  error: unknown,
  fallbackSource: ErrorSource,
): { messageText: string; message: string; authRequired: boolean } {
  const messageText = error instanceof Error ? error.message : String(error);
  const preAttributed =
    hasErrorSourcePrefix(messageText, 'Entra') || hasErrorSourcePrefix(messageText, 'Yvoke Backend');
  const authRequired = !preAttributed && isAuthError(messageText);

  if (authRequired) {
    return { messageText, message: tagAttributedError('Claude', LOGIN_INSTRUCTIONS), authRequired };
  }
  if (preAttributed) {
    return { messageText, message: messageText, authRequired };
  }
  // `error`, not `messageText`: a thrown non-Error stringifies to '[object Object]' here but
  // still serializes usefully inside tagAttributedError.
  return { messageText, message: tagAttributedError(fallbackSource, error), authRequired };
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
  /** Playbook identifier / name for this turn. */
  playbook?: string;
  /** Attached images for multimodal prompt context. */
  images?: ImageAttachment[];
}

interface ReviewTurnState {
  allEvidence: string[];
  reviewerSent: SentLedger;
  reviewerSessionId?: string;
  processedCallIds: Set<string>;
  originalQuestion: string;
  submittedAnswer?: string;
  settled?: boolean;
  settledApproved?: boolean;
  inFlight?: Promise<void>;
}

type ReviewPassOutcome =
  | { kind: 'approved'; content: string }
  | { kind: 'revise'; revisionPrompt: string }
  | { kind: 'flagged'; content: string }
  | { kind: 'unreviewed'; content: string; errorMessage: string }
  | { kind: 'aborted'; content: string };

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
  playbookVersion?: number;
  /** Selected multi-agent profile for this session, if orchestrator mode is active. */
  orchestratorProfile?: string;
  /** Resolved orchestrator build (including ReviewerConfig) when in orchestrator mode. */
  orchestrator?: ResolvedOrchestrator;
  /** In-process MCP server exposing `mcp__review__submit_answer` when in orchestrator mode. */
  submitAnswerServer?: McpSdkServerConfigWithInstance;
  /** In-flight Reviewer SDK query, if a review pass is currently running. */
  activeReviewerQuery?: Query;
  /** Per-turn review state (evidence accumulator, SentLedger, reviewerSessionId). */
  reviewState?: ReviewTurnState;
  /** The user message for the in-flight turn, persisted once the turn completes. */
  pendingUser?: ChatMessage;
  /** Last resolved MCP headers serialized to JSON for change detection. */
  lastMcpHeadersJson: string;
}

export interface AgentServiceDeps {
  getSettings: () => AppSettings;
  mcpAuthProvider: McpAuthProvider;
  emit: (event: AgentEvent) => void;
  /** Called when a session id is (re)established for a thread, for resume persistence. */
  onSessionId: (threadId: string, sessionId: string, profile?: string) => void;
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

  resolveClarification(toolUseId: string, answer: string): boolean {
    if (!toolUseId || typeof toolUseId !== 'string') return false;
    const cleanAnswer = typeof answer === 'string' ? answer.trim() : String(answer ?? '').trim();
    const resolve = this.pendingClarifications.get(toolUseId);
    if (!resolve) {
      return false;
    }
    resolve(cleanAnswer);
    this.pendingClarifications.delete(toolUseId);
    for (const [threadId, set] of this.threadClarifications.entries()) {
      set.delete(toolUseId);
      if (set.size === 0) {
        this.threadClarifications.delete(threadId);
      }
    }
    return true;
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

  isBusy(threadId: string): boolean {
    return Boolean(this.sessions.get(threadId)?.busy);
  }

  async sendMessage(thread: ThreadMeta, text: string, opts: SendOptions = {}): Promise<void> {
    if (this.isBusy(thread.id)) {
      throw new Error('A turn is already running for this conversation.');
    }

    let session: ThreadSession;
    try {
      session = await this.ensureSession(thread, opts.playbook);
    } catch (error) {
      const { messageText, message, authRequired } = attributeTurnFailure(error, 'Yvoke Backend');
      logError('agent', `turn failed before start thread=${thread.id}:`, messageText);
      this.deps.emit({ kind: 'error', threadId: thread.id, message, authRequired });
      throw error;
    }

    if (session.busy) {
      throw new Error('A turn is already running for this conversation.');
    }

    // In orchestrator mode the per-role models/thinking are fixed by the profile + settings; the
    // thread-level model/thinking selectors (and per-message thinking override) do not apply.
    if (!thread.orchestratorProfile) {
      if (session.model !== thread.model) {
        await session.query.setModel(resolveCanonicalModel(thread.model));
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
    session.reviewState = session.orchestrator
      ? {
          allEvidence: [],
          reviewerSent: new SentLedger(),
          processedCallIds: new Set(),
          originalQuestion: text,
        }
      : undefined;
    this.deps.emit({ kind: 'turn-start', threadId: thread.id });

    const userMessage: ChatMessage = {
      localId: randomUUID(),
      role: 'user',
      content: text,
      playbook: opts.playbook,
      playbookVersion: opts.playbook ? session.playbookVersion : undefined,
      createdAt: new Date().toISOString(),
      images: opts.images && opts.images.length > 0 ? opts.images : undefined,
    };
    session.pendingUser = userMessage;

    if (opts.images && opts.images.length > 0) {
      const blocks: Array<
        | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
        | { type: 'text'; text: string }
      > = [
        ...opts.images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
      ];
      if (text.trim().length > 0) {
        blocks.push({ type: 'text', text });
      }
      session.queue.push({
        type: 'user',
        message: { role: 'user', content: blocks },
        parent_tool_use_id: null,
      });
    } else {
      session.queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.interrupted = true;
      await Promise.all([
        session.query.interrupt(),
        session.activeReviewerQuery ? session.activeReviewerQuery.interrupt() : Promise.resolve(),
      ]);
    }
    // A pending clarifying question would otherwise leave its promise (and resolver) hanging forever.
    this.cancelClarifications(threadId);
  }

  closeThread(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.queue.close();
      session.query.close();
      session.activeReviewerQuery?.close();
      this.sessions.delete(threadId);
    }
    this.cancelClarifications(threadId);
  }

  async verifyClaudeCredentials(
    sandboxDir: string = this.deps.sandboxDir,
    model?: string,
  ): Promise<LoginVerificationResult> {
    if (detectClaudeCredentials() === 'missing') {
      return { status: 'missing', message: LOGIN_INSTRUCTIONS };
    }

    try {
      fs.mkdirSync(sandboxDir, { recursive: true });
    } catch {
      // ignore failure, caught on spawn
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), CLAUDE_VERIFY_TIMEOUT_MS);

    const binary = claudeBinaryPath();
    const options: Options = {
      // A bare string replaces the Claude Code preset outright — the same isolation the other
      // single-turn probes rely on, and without it a "ping" drags the whole preset along.
      systemPrompt: `Reply with the single word: ${PROBE_TOKEN}.`,
      tools: [],
      disallowedTools: ['Bash'],
      canUseTool: async () => ({ behavior: 'deny', message: 'No tools for verification' }),
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      thinking: { type: 'disabled' },
      effort: 'low',
      maxTurns: 1,
      abortController,
      cwd: sandboxDir,
      env: debugEnv(),
      pathToClaudeCodeExecutable: binary ?? undefined,
      ...(model ? { model: resolveCanonicalModel(model) } : {}),
    };

    let q: Query | undefined;
    try {
      q = query({ prompt: 'ping', options });
      const reply = await readSingleReply(q, 'login check');
      const trimmed = reply.trim();
      if (!trimmed.toLowerCase().includes(PROBE_TOKEN.toLowerCase())) {
        const preview = trimmed.length > 0 ? trimmed.slice(0, 100) : '(empty reply)';
        return {
          status: 'error',
          message: `Claude verification failed: unexpected reply: ${preview}`,
        };
      }
      return { status: 'ok', account: detectClaudeAccount() };
    } catch (err) {
      if (abortController.signal.aborted || err instanceof AbortError) {
        return { status: 'unreachable', message: 'Claude verification timed out' };
      }
      // A stream that closed with nothing in it says the subprocess failed, not that the login
      // did — and it must be settled by type, before any prose matching gets a chance at it.
      if (err instanceof NoReplyError) {
        return { status: 'error', message: `Claude verification failed: ${err.message}` };
      }
      const failure = classifyClaudeFailure(err);
      if (failure) {
        return failure;
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = rawMsg.trim().slice(0, 200);
      return { status: 'error', message: `Claude verification failed: ${msg}` };
    } finally {
      clearTimeout(timer);
      if (q) {
        try {
          q.close();
        } catch {
          // ignore
        }
      }
    }
  }

  closeAll(): void {
    for (const threadId of [...this.sessions.keys()]) {
      this.closeThread(threadId);
    }
  }

  private async ensureSession(
    thread: ThreadMeta,
    playbookName?: string,
  ): Promise<ThreadSession> {
    const existing = this.sessions.get(thread.id);
    let resolvedHeaders: Record<string, string> | undefined;

    if (existing) {
      if (existing.orchestratorProfile !== thread.orchestratorProfile) {
        log(
          'agent',
          `Session config changed (profile "${existing.orchestratorProfile}"→"${thread.orchestratorProfile}"), restarting agent session`,
        );
        this.closeThread(thread.id);
      } else if (existing.playbookName !== playbookName) {
        throw new Error(
          `Cannot switch playbook on an existing conversation session (locked to "${existing.playbookName ?? 'none'}", requested "${playbookName ?? 'none'}")`,
        );
      } else {
        const headers = await this.deps.mcpAuthProvider.headers();
        resolvedHeaders = headers;
        const headersJson = JSON.stringify(headers);
        const hasAuthChanged = headersJson !== existing.lastMcpHeadersJson;
        let updateFailed = false;
        let updateError: unknown = null;
        let isAuthFailure = false;

        if (hasAuthChanged) {
          try {
            const mcpServers = {
              ...buildMcpServers(this.deps.getSettings(), headers),
              ...(existing.submitAnswerServer ? { [REVIEW_SERVER_NAME]: existing.submitAnswerServer } : {}),
            };
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error('Timed out updating MCP servers'));
              }, MCP_UPDATE_TIMEOUT_MS);
            });
            try {
              const result = await Promise.race([existing.query.setMcpServers(mcpServers), timeoutPromise]);
              if (result?.errors && result.errors[MCP_SERVER_NAME]) {
                const errMsg = result.errors[MCP_SERVER_NAME];
                if (/\b401\b|unauthori[sz]ed|token.*expired|invalid.*token/i.test(errMsg)) {
                  isAuthFailure = true;
                }
                throw new Error(`MCP server update error: ${errMsg}`);
              }
            } finally {
              if (timer) clearTimeout(timer);
            }
          } catch (err) {
            updateFailed = true;
            updateError = err;
          }
        }

        // Verify session was not closed or replaced while awaiting headers or setMcpServers
        const current = this.sessions.get(thread.id);
        if (current !== existing) {
          log('agent', `Session for thread=${thread.id} was closed or replaced during MCP check; verifying or recreating`);
          if (current) {
            if (
              current.orchestratorProfile === thread.orchestratorProfile &&
              current.playbookName === playbookName
            ) {
              return current;
            }
            if (current.busy) {
              return current;
            }
            // Configuration mismatch on an idle session; close it before creating a replacement
            this.closeThread(thread.id);
          }
          // Session was closed or replaced with different config; fall through to recreate below
        } else if (updateFailed) {
          if (existing.busy) {
            return existing;
          }
          log(
            'agent',
            `Failed to update MCP servers dynamically for thread=${thread.id}: ${
              updateError instanceof Error ? updateError.message : 'Update failed'
            }`,
          );
          this.closeThread(thread.id);
          if (isAuthFailure) {
            this.deps.mcpAuthProvider.invalidate?.();
            resolvedHeaders = undefined;
          }
          // Fall through to recreate fresh session resuming thread.sessionId below
        } else {
          existing.lastMcpHeadersJson = headersJson;
          existing.lastActiveAt = Date.now();
          return existing;
        }
      }
    } else if (!thread.orchestratorProfile && thread.initialPlaybook && playbookName !== thread.initialPlaybook) {
      throw new Error(
        `Cannot switch playbook on an existing conversation session (locked to "${thread.initialPlaybook}", requested "${playbookName ?? 'none'}")`,
      );
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

    let playbookTools: string[] | undefined;
    // undefined = no playbook metadata resolved, which buildAllowedTools reads as "not declared".
    let playbookCodeExecution: boolean | undefined;
    let playbookSystemPrompt: string | undefined;
    let playbookVersion: number | undefined;
    let playbookText: string | undefined;
    if (playbookName && !thread.orchestratorProfile) {
      try {
        const prompts = await this.deps.mcpPrompts.list();
        const p = prompts.find((pr: McpPromptInfo) => pr.name === playbookName);
        if (p) {
          playbookTools = p.tools;
          playbookCodeExecution = p.codeExecution;
          playbookSystemPrompt = p.systemPrompt;
          playbookVersion = p.version;
          log('agent', `Resolved playbook "${playbookName}" constraints — tools=${playbookTools ? playbookTools.join(',') : 'all'} codeExecution=${playbookCodeExecution !== false} systemPrompt=${playbookSystemPrompt ?? 'default'}`);
        }
        playbookText = await this.deps.mcpPrompts.getText(playbookName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (hasErrorSourcePrefix(msg, 'Entra')) {
          throw err;
        }
        throw new Error(
          tagAttributedError(
            'Yvoke Backend',
            `Playbook metadata for "${playbookName}" could not be loaded: ` + msg,
          ),
        );
      }
    }

    // In orchestrator mode, each role resolves its designated prompt from the profile's playbooks,
    // and the base fallback prompt is always default-chat. In single-agent mode, use the thread's playbook.
    const designatedPrompt = thread.orchestratorProfile ? undefined : playbookSystemPrompt;
    const systemPrompt = await loadRequiredSystemPrompt(this.deps.syncClient, designatedPrompt);
    const singleAgentPrompt =
      playbookName && playbookText !== undefined
        ? `${systemPrompt}\n\n---\n\n${playbookText}`
        : systemPrompt;

    const queue = new MessageQueue();
    const onClarifyingQuestion = (toolUseId: string, question: string, options: ClarificationOption[]) => {
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
      orchestrator = await buildOrchestrator(
        profile,
        settings,
        this.deps.mcpPrompts,
        systemPrompt,
        (name) => this.deps.syncClient.getSystemPrompt(name),
      );
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

    const canResume =
      Boolean(thread.sessionId) &&
      (thread.sessionProfile === thread.orchestratorProfile ||
        (!thread.sessionProfile && !thread.orchestratorProfile));

    if (!canResume && thread.sessionId) {
      log(
        'agent',
        `Mode changed: session ${thread.sessionId} was established under profile "${thread.sessionProfile ?? 'single-agent'}" ` +
          `but thread is now "${thread.orchestratorProfile ?? 'single-agent'}". Clearing incompatible session id.`,
      );
      thread.sessionId = undefined;
      thread.sessionProfile = undefined;
      this.deps.onSessionId(thread.id, '', undefined);
    }

    if (!resolvedHeaders) {
      resolvedHeaders = await this.deps.mcpAuthProvider.headers();
    }

    const sessionRef: { current?: ThreadSession } = {};
    const submitAnswerServer = orchestrator
      ? buildSubmitAnswerServer((answer) => {
          if (!sessionRef.current) {
            return Promise.resolve({ text: 'Session not ready.', isError: true });
          }
          return this.handleSubmittedAnswer(thread.id, sessionRef.current, answer);
        })
      : undefined;

    const options: Options = {
      systemPrompt: orchestrator ? '' : singleAgentPrompt,
      mcpServers: {
        ...buildMcpServers(settings, resolvedHeaders),
        ...(submitAnswerServer ? { [REVIEW_SERVER_NAME]: submitAnswerServer } : {}),
      },
      // NOT the full grant: `allowedTools` auto-approves, and an auto-approved tool never reaches
      // canUseTool. Web access and the clarifying question are enforced/intercepted only in that
      // callback, so they are withheld here and answered there instead — see policy.ts.
      allowedTools: buildAutoApproveTools(allowedToolsList),
      // Hard-block the shell everywhere: the safe mcp__compute__execute_code tool replaces it, and
      // this ensures the model is never even offered Bash regardless of the allow-list.
      disallowedTools: ['Bash'],
      // The FULL grant, which is what the playbook gate inside the callback compares against.
      canUseTool: buildCanUseTool(this.deps.getSettings, thread.id, onClarifyingQuestion, allowedToolsList,
        playbookCodeExecution, Boolean(orchestrator)),
      settingSources: [],
      includePartialMessages: true,
      model: resolveCanonicalModel(effectiveModel),
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
      ...(canResume ? { resume: thread.sessionId } : {}),
    };

    log(
      'agent',
      `new session thread=${thread.id} model=${effectiveModel} thinking=${effectiveThinking}` +
        (orchestrator ? ` orchestrator=${thread.orchestratorProfile}` : '') +
        (canResume ? ` resume=${thread.sessionId}` : ' (fresh)'),
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
      playbookName: thread.orchestratorProfile ? undefined : playbookName,
      playbookVersion: thread.orchestratorProfile ? undefined : playbookVersion,
      orchestratorProfile: thread.orchestratorProfile,
      orchestrator,
      submitAnswerServer,
      lastMcpHeadersJson: JSON.stringify(resolvedHeaders),
    };
    sessionRef.current = session;
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
        log('orch', `❓ clarifying question: ${AgentService.preview(event.question)}${event.options?.length ? ` [options: ${event.options.map((o) => o.label).join(' | ')}]` : ''}`);
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
          this.deps.onSessionId(threadId, message.session_id, session.orchestratorProfile);
        }
        if (message.type === 'result') {
          await this.completeTurn(threadId, session, message, startedAt);
        }
      }
    } catch (error) {
      this.cancelClarifications(threadId);
      const { messageText, message, authRequired } = attributeTurnFailure(error, 'Claude');
      logError('agent', `turn failed thread=${threadId}:`, messageText);
      this.deps.emit({ kind: 'error', threadId, message, authRequired });
      session.busy = false;
      this.sessions.delete(threadId);
    }
  }

  /**
   * Execute one Reviewer SDK `query()` pass with `verify_citations` + `submit_review`, resuming
   * `reviewState.reviewerSessionId` across revision rounds.
   */
  private async executeReviewerQuery(
    threadId: string,
    session: ThreadSession,
    reviewPrompt: string,
    reviewerCall: ToolCallInfo,
    reviewState: ReviewTurnState,
  ): Promise<{
    verdict?: ReviewVerdict;
    resultText: string;
    usage: UsageTotals;
    costUsd?: number;
    failed: boolean;
    errorMessage?: string;
  }> {
    const reviewerCfg = session.orchestrator!.reviewer;
    const settings = this.deps.getSettings();
    let capturedVerdict: ReviewVerdict | undefined;
    let usage: UsageTotals = { ...EMPTY_USAGE };
    let costUsd: number | undefined;
    let resultText = '';
    let failed = false;
    let errorMessage: string | undefined;

    let revQuery: Query | undefined;
    try {
      const headers = await this.deps.mcpAuthProvider.headers();
      const reviewerOptions: Options = {
        systemPrompt: reviewerCfg.prompt,
        mcpServers: {
          ...buildMcpServers(settings, headers),
          [REVIEW_SERVER_NAME]: buildReviewServer((v) => {
            capturedVerdict = v;
          }),
        },
        tools: [],
        allowedTools: buildAutoApproveTools(reviewerCfg.tools),
        disallowedTools: ['Bash'],
        canUseTool: buildCanUseTool(
          this.deps.getSettings,
          threadId,
          undefined,
          reviewerCfg.tools,
          false,
          false,
        ),
        settingSources: [],
        model: reviewerCfg.model,
        maxThinkingTokens: thinkingBudget(reviewerCfg.thinkingLevel),
        ...(reviewerCfg.effort ? { effort: reviewerCfg.effort } : {}),
        maxTurns: 6,
        cwd: this.deps.sandboxDir,
        env: debugEnv(),
        ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
        ...(reviewState.reviewerSessionId ? { resume: reviewState.reviewerSessionId } : {}),
      };

      revQuery = query({ prompt: reviewPrompt, options: reviewerOptions });
      session.activeReviewerQuery = revQuery;

      for await (const msg of revQuery) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          reviewState.reviewerSessionId = msg.session_id;
        } else if (msg.type === 'assistant') {
          const content = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
          let blockText = '';
          let blockThinking = '';
          const innerToolCalls: ToolCallInfo[] = [];
          for (const block of content) {
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
              blockThinking += block.thinking;
            } else if (block.type === 'text' && typeof block.text === 'string') {
              blockText += block.text;
            } else if (block.type === 'tool_use') {
              const name = String(block.name);
              const input = block.input;
              log('orch', `   [reviewer] tool ${name}(${AgentService.preview(JSON.stringify(input ?? {}), 300)})`);
              if (name === REVIEW_SUBMIT_TOOL) {
                try {
                  capturedVerdict = parseSubmitReviewArgs(input);
                } catch {
                  // MCP tool handler reports the validation error so the reviewer can retry
                }
              }
              innerToolCalls.push({
                id: String(block.id),
                name,
                input,
              });
            }
          }
          if (blockText) {
            resultText += (resultText ? '\n\n' : '') + blockText;
          }
          if (blockText || blockThinking || innerToolCalls.length > 0) {
            (reviewerCall.subagentBlocks ??= []).push({
              text: blockText || undefined,
              thinking: blockThinking || undefined,
              toolCalls: innerToolCalls.length > 0 ? innerToolCalls : undefined,
            });
          }
        } else if (msg.type === 'user') {
          const message = (msg as { message?: { content?: unknown } }).message;
          const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const toolUseId = String(block.tool_use_id);
            const isErr = block.is_error === true;
            const resStr =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((b) =>
                        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
                          ? ((b as { text?: string }).text ?? '')
                          : '',
                      )
                      .join('\n')
                  : block.content == null
                    ? ''
                    : JSON.stringify(block.content);
            const inner = reviewerCall.subagentBlocks
              ?.flatMap((b) => b.toolCalls ?? [])
              .find((c) => c.id === toolUseId);
            if (inner) {
              inner.result = resStr;
              inner.isError = isErr;
            }
          }
        } else if (msg.type === 'result') {
          usage = usageFromSdk(msg.usage as unknown as Record<string, unknown>);
          costUsd = (msg as { total_cost_usd?: number }).total_cost_usd;
          if (isResultFailure(msg)) {
            failed = true;
            errorMessage = String((msg as { result?: string }).result ?? msg.subtype);
          } else if (!resultText && typeof (msg as { result?: string }).result === 'string') {
            resultText = (msg as { result?: string }).result!;
          }
          break;
        }
      }
    } catch (err) {
      failed = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      if (session.activeReviewerQuery === revQuery) {
        session.activeReviewerQuery = undefined;
      }
      if (revQuery) {
        try {
          revQuery.close();
        } catch {
          // ignore
        }
      }
    }

    return {
      verdict: capturedVerdict,
      resultText,
      usage,
      costUsd,
      failed,
      errorMessage,
    };
  }

  private ensureReviewState(session: ThreadSession): ReviewTurnState {
    return (session.reviewState ??= {
      allEvidence: [],
      reviewerSent: new SentLedger(),
      processedCallIds: new Set(),
      originalQuestion: session.pendingUser?.content ?? '',
    });
  }

  /**
   * Shared single review pass used by both `handleSubmittedAnswer` (in-turn MCP tool) and
   * `runCodeDrivenReview` (fallback when the orchestrator ends its turn without calling `submit_answer`).
   *
   * Harvests new specialist tool outputs, emits the synthetic Reviewer `SubagentCard` events, runs
   * `executeReviewerQuery` (resuming `reviewerSessionId` across rounds), accumulates usage, and
   * classifies the pass into `approved`, `revise`, `flagged`, `unreviewed`, or `aborted`.
   */
  private async runReviewPass(
    threadId: string,
    session: ThreadSession,
    draftAnswer: string,
    reviewState: ReviewTurnState,
  ): Promise<ReviewPassOutcome> {
    const newSpecialistCalls = session.turn.toolCalls.filter(
      (c) =>
        c.name === 'Agent' &&
        c.subagentType !== REVIEWER_SUBAGENT &&
        !reviewState.processedCallIds.has(c.id),
    );
    for (const c of newSpecialistCalls) {
      reviewState.processedCallIds.add(c.id);
    }
    const newEvidence = harvestSpecialistEvidence(newSpecialistCalls, [this.deps.sandboxDir]);
    reviewState.allEvidence.push(...newEvidence);

    const round = session.turn.revisionRounds ?? 0;
    const reviewPrompt =
      round === 0
        ? renderReviewTask(
            reviewState.originalQuestion,
            draftAnswer,
            reviewState.allEvidence,
            reviewState.reviewerSent,
          )
        : renderReviewFollowUp(draftAnswer, reviewState.allEvidence, reviewState.reviewerSent);

    const reviewerCallId = randomUUID();
    const reviewerCall: ToolCallInfo = {
      id: reviewerCallId,
      name: 'Agent',
      subagentType: REVIEWER_SUBAGENT,
      input: { prompt: reviewPrompt },
      subagentBlocks: [],
    };
    session.turn.toolCalls.push(reviewerCall);
    session.turn.blocks.push({ toolCalls: [reviewerCall] });

    const startEvent: AgentEvent = {
      kind: 'subagent-start',
      threadId,
      toolUseId: reviewerCallId,
      subagentType: REVIEWER_SUBAGENT,
      question: reviewPrompt.slice(0, 2000),
    };
    this.logOrchestrationEvent(startEvent);
    this.deps.emit(startEvent);
    this.deps.emit({
      kind: 'assistant-block',
      threadId,
      text: '',
      toolCalls: [reviewerCall],
    });

    const revOutcome = await this.executeReviewerQuery(
      threadId,
      session,
      reviewPrompt,
      reviewerCall,
      reviewState,
    );

    session.turn.carriedUsage = addUsage(session.turn.carriedUsage ?? EMPTY_USAGE, revOutcome.usage);
    if (revOutcome.costUsd != null) {
      session.turn.carriedCostUsd = (session.turn.carriedCostUsd ?? 0) + revOutcome.costUsd;
    }

    if (session.interrupted) {
      return { kind: 'aborted', content: draftAnswer };
    }

    if (revOutcome.failed && !revOutcome.verdict) {
      const errText = revOutcome.errorMessage || 'Reviewer failed';
      reviewerCall.isError = true;
      reviewerCall.result = errText;
      this.deps.emit({
        kind: 'tool-result',
        threadId,
        toolUseId: reviewerCallId,
        result: errText,
        isError: true,
      });
      const completeEvt: AgentEvent = {
        kind: 'subagent-complete',
        threadId,
        toolUseId: reviewerCallId,
        subagentType: REVIEWER_SUBAGENT,
        result: errText,
        isError: true,
      };
      this.logOrchestrationEvent(completeEvt);
      this.deps.emit(completeEvt);
      logError('orch', `⚖ reviewer pass failed on round ${round}: ${errText}`);

      const unreviewedContent = draftAnswer.trim().length > 0 ? draftAnswer + unreviewedNote() : '';
      return { kind: 'unreviewed', content: unreviewedContent, errorMessage: errText };
    }

    const verdict =
      revOutcome.verdict ??
      (revOutcome.resultText ? parseVerdict(revOutcome.resultText) ?? undefined : undefined);
    const resultSummary = verdict
      ? formatVerdictSummary(verdict)
      : revOutcome.resultText || '(no verdict)';

    reviewerCall.verdict = verdict;
    reviewerCall.result = resultSummary;
    reviewerCall.isError = false;

    this.deps.emit({
      kind: 'tool-result',
      threadId,
      toolUseId: reviewerCallId,
      result: resultSummary,
      isError: false,
    });
    const completeEvt: AgentEvent = {
      kind: 'subagent-complete',
      threadId,
      toolUseId: reviewerCallId,
      subagentType: REVIEWER_SUBAGENT,
      result: resultSummary,
      isError: false,
    };
    this.logOrchestrationEvent(completeEvt);
    this.deps.emit(completeEvt);

    if (verdict) {
      const verdictEvt: AgentEvent = {
        kind: 'review-verdict',
        threadId,
        toolUseId: reviewerCallId,
        approved: verdict.approved,
        feedback: verdict.feedback,
      };
      this.logOrchestrationEvent(verdictEvt);
      this.deps.emit(verdictEvt);
    }

    if (verdict?.approved) {
      return { kind: 'approved', content: draftAnswer };
    }

    const maxRounds = this.deps.getSettings().orchestrator?.maxReviewRounds ?? 0;
    const doneRounds = session.turn.revisionRounds ?? 0;

    if (doneRounds < maxRounds) {
      const nextRound = doneRounds + 1;
      session.turn.revisionRounds = nextRound;
      const reason: 'rejected' | 'unclear' = verdict ? 'rejected' : 'unclear';
      const revisionPrompt = buildRevisionPrompt({
        verdict,
        feedback: verdict?.feedback,
        newEvidence,
        allEvidence: reviewState.allEvidence,
        draft: draftAnswer,
        round: nextRound,
        maxRounds,
      });
      log(
        'orch',
        `⚖ reviewer ${reason === 'unclear' ? 'returned no clear verdict' : 'REJECTED'} — ` +
          `revision round ${nextRound}/${maxRounds}: handing feedback + evidence back to the orchestrator`,
      );

      session.turn.turnText = '';
      session.turn.liveText = '';
      session.turn.blocks = session.turn.blocks
        .map((block) => ({ ...block, text: undefined }))
        .filter((block) => block.thinking || (block.toolCalls?.length ?? 0) > 0);

      this.deps.emit({ kind: 'review-enforced', threadId, reason, round: nextRound });
      return { kind: 'revise', revisionPrompt };
    }

    const flaggedContent =
      draftAnswer + reviewFlagNote(reviewAttempts(session.turn.toolCalls), verdict?.feedback);
    return { kind: 'flagged', content: flaggedContent };
  }

  /**
   * Fallback code-driven Reviewer loop when the orchestrator ends its turn without calling `submit_answer`.
   */
  private async runCodeDrivenReview(
    threadId: string,
    session: ThreadSession,
    result: Extract<Awaited<ReturnType<Query['next']>>['value'], { type: 'result' }>,
    resultUsage: UsageTotals,
    resultCostUsd: number | undefined,
  ): Promise<
    | { status: 'continue' }
    | { status: 'finalize'; isError: boolean; aborted: boolean; errorMessage?: string }
  > {
    session.turn.carriedUsage = addUsage(session.turn.carriedUsage ?? EMPTY_USAGE, resultUsage);
    if (resultCostUsd != null) {
      session.turn.carriedCostUsd = (session.turn.carriedCostUsd ?? 0) + resultCostUsd;
    }

    const rawDraft = session.turn.turnText || String((result as { result?: string }).result ?? '');
    const draftAnswer = afterAnswerMarker(rawDraft);
    const reviewState = this.ensureReviewState(session);

    const outcome = await this.runReviewPass(threadId, session, draftAnswer, reviewState);
    if (outcome.kind === 'revise') {
      session.queue.push({
        type: 'user',
        message: { role: 'user', content: outcome.revisionPrompt },
        parent_tool_use_id: null,
      });
      return { status: 'continue' };
    }

    session.turn.turnText = outcome.content;
    session.turn.blocks = stripBeforeAnswerMarker(session.turn.blocks, outcome.content);

    if (outcome.kind === 'aborted') {
      return { status: 'finalize', isError: false, aborted: true };
    }
    if (outcome.kind === 'unreviewed' && outcome.content.length === 0) {
      return {
        status: 'finalize',
        isError: true,
        aborted: false,
        errorMessage: tagAttributedError('Claude', outcome.errorMessage),
      };
    }
    return { status: 'finalize', isError: false, aborted: false };
  }

  /**
   * Handle an orchestrator `mcp__review__submit_answer` tool call in-turn, serialized through
   * `reviewState.inFlight` so concurrent `submit_answer` tool_use blocks cannot race.
   */
  private async handleSubmittedAnswer(
    threadId: string,
    session: ThreadSession,
    rawDraft: string,
  ): Promise<{ text: string; isError?: boolean }> {
    const reviewState = this.ensureReviewState(session);
    const prev = reviewState.inFlight ?? Promise.resolve();
    let release!: () => void;
    reviewState.inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    await prev;
    try {
      return await this.handleSubmittedAnswerLocked(threadId, session, rawDraft, reviewState);
    } finally {
      release();
    }
  }

  private async handleSubmittedAnswerLocked(
    threadId: string,
    session: ThreadSession,
    rawDraft: string,
    reviewState: ReviewTurnState,
  ): Promise<{ text: string; isError?: boolean }> {
    const draftAnswer = afterAnswerMarker(rawDraft);

    if (reviewState.settled) {
      return {
        text: reviewState.settledApproved
          ? 'APPROVED — your answer has already been delivered to the user. End your turn now without repeating the answer.'
          : 'Your answer has already been delivered to the user. End your turn now without repeating the answer.',
      };
    }

    const hasSpecialistDelegation = session.turn.toolCalls.some(
      (c) => c.name === 'Agent' && c.subagentType !== REVIEWER_SUBAGENT,
    );
    if (!hasSpecialistDelegation && reviewState.allEvidence.length === 0) {
      reviewState.submittedAnswer = draftAnswer;
      reviewState.settled = true;
      return {
        text: 'Your answer has been delivered to the user. End your turn now without repeating the answer.',
      };
    }

    const outcome = await this.runReviewPass(threadId, session, draftAnswer, reviewState);
    switch (outcome.kind) {
      case 'aborted':
        reviewState.submittedAnswer = outcome.content;
        reviewState.settled = true;
        return { text: 'Turn interrupted by user.', isError: true };
      case 'unreviewed':
        reviewState.submittedAnswer = outcome.content;
        reviewState.settled = true;
        return {
          text: 'The automated review could not be completed. The answer you passed to submit_answer has been delivered to the user with an unverified notice. End your turn now without repeating the answer.',
        };
      case 'approved':
        reviewState.submittedAnswer = outcome.content;
        reviewState.settled = true;
        reviewState.settledApproved = true;
        return {
          text: 'APPROVED — the answer you passed to submit_answer has been delivered to the user. End your turn now without repeating the answer.',
        };
      case 'revise':
        reviewState.submittedAnswer = undefined;
        return { text: outcome.revisionPrompt };
      case 'flagged':
        reviewState.submittedAnswer = outcome.content;
        reviewState.settled = true;
        return {
          text: 'The maximum number of review rounds has been reached. Your latest answer has been delivered to the user with a reviewer note. End your turn now without repeating the answer.',
        };
    }
  }

  private async completeTurn(
    threadId: string,
    session: ThreadSession,
    result: Extract<Awaited<ReturnType<Query['next']>>['value'], { type: 'result' }>,
    startedAt: number,
  ): Promise<void> {
    const resultUsage = usageFromSdk(result.usage as unknown as Record<string, unknown>);
    let aborted = session.interrupted;
    let isError = isResultFailure(result);
    const resultCostUsd = (result as { total_cost_usd?: number }).total_cost_usd;

    let usageOverride: UsageTotals | undefined;
    let costOverride: number | undefined;
    let errorOverride: string | undefined;

    if (
      session.orchestratorProfile &&
      session.orchestrator &&
      session.reviewState?.submittedAnswer !== undefined
    ) {
      isError = false;
      session.turn.turnText = session.reviewState.submittedAnswer;
      session.turn.blocks = stripBeforeAnswerMarker(
        session.turn.blocks,
        session.reviewState.submittedAnswer,
      );
    } else if (session.orchestratorProfile && session.orchestrator && !isError && !aborted) {
      const hasSpecialistDelegation = session.turn.toolCalls.some(
        (c) => c.name === 'Agent' && c.subagentType !== REVIEWER_SUBAGENT,
      );
      if (!hasSpecialistDelegation) {
        const rawText = session.turn.turnText || String((result as { result?: string }).result ?? '');
        const cleanText = afterAnswerMarker(rawText);
        session.turn.turnText = cleanText;
        session.turn.blocks = stripBeforeAnswerMarker(session.turn.blocks, cleanText);
      } else {
        const outcome = await this.runCodeDrivenReview(
          threadId,
          session,
          result,
          resultUsage,
          resultCostUsd,
        );
        if (outcome.status === 'continue') {
          return;
        }
        isError = outcome.isError;
        aborted = outcome.aborted;
        errorOverride = outcome.errorMessage;
        usageOverride = session.turn.carriedUsage ?? EMPTY_USAGE;
        costOverride = session.turn.carriedCostUsd;
      }
    }

    const usage =
      usageOverride ??
      (session.turn.carriedUsage ? addUsage(session.turn.carriedUsage, resultUsage) : resultUsage);
    const review = session.orchestratorProfile ? reviewStatusOf(session.turn.toolCalls) : undefined;
    const content =
      session.turn.turnText || (isError ? '' : String((result as { result?: string }).result ?? ''));
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
      costOverride !== undefined
        ? costOverride
        : session.turn.carriedCostUsd != null
          ? session.turn.carriedCostUsd + (resultCostUsd ?? 0)
          : resultCostUsd;
    const rawErrorMessage = isError ? String((result as { result?: string }).result ?? result.subtype) : undefined;
    const errorMessage =
      errorOverride ?? (isError && rawErrorMessage ? tagAttributedError('Claude', rawErrorMessage) : undefined);
    log(
      'agent',
      `turn ${aborted ? 'stopped' : isError ? 'error' : 'complete'} thread=${threadId} ` +
        `in=${usage.inputTokens} out=${usage.outputTokens} cacheRead=${usage.cacheReadTokens} ` +
        `tools=${session.turn.toolCalls.length} ` +
        (review ? `review=${review.outcome} ` : '') +
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
      errorMessage,
    });

    session.busy = false;
    session.interrupted = false;
    session.reviewState = undefined;
    session.lastActiveAt = Date.now();
    session.turn = newTurnContext(threadId, Boolean(session.orchestratorProfile));
  }
}

/**
 * How long the credential probe waits. It must cover a cold spawn of the packaged Claude CLI
 * plus a full model round trip, so it matches the structurally identical playbook check rather
 * than guessing lower — a probe that fails closed reports working credentials as broken.
 */
export const CLAUDE_VERIFY_TIMEOUT_MS = VALIDATION_TIMEOUT_MS;

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

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  ChatMessage,
  CitationRef,
  FeedbackRequest,
  McpPromptInfo,
  OrchestratorProfile,
  OrchestratorRunPayload,
  PlaybookValidation,
  PlaybookValidationRequest,
  SendMessageRequest,
  SyncEvent,
  ThreadMeta,
  ThreadSearchHit,
  ThinkingLevel,
  UsageTotals,
} from '../shared/types';
import { controlPlaybookNames, isUserSelectablePlaybook } from '../shared/types';
import { log, logError } from './log';
import { AgentService, sandboxDirFor } from './agent/AgentService';
import { McpPrompts } from './agent/McpPrompts';
import { PASSES } from './agent/playbookValidation';
import { validatePlaybookSelection } from './agent/PlaybookValidator';
import { buildRunTrace } from './agent/runTrace';
import { detectClaudeAccount, detectClaudeCredentials } from './agent/ClaudeAuth';
import { ServerAuth, type TokenCachePersistence } from './auth/ServerAuth';
import { SettingsStore } from './settings/Settings';
import { SearchIndex } from './store/SearchIndex';
import { ThreadStore } from './store/ThreadStore';
import { parseStoredContent, serializeAssistantContent } from './store/messageCodec';
import { SyncClient, type MessageDto } from './sync/SyncClient';
import { SyncQueue } from './sync/SyncQueue';

export interface AppCoreDeps {
  userDataDir: string;
  emitAgentEvent: (event: AgentEvent) => void;
  emitSyncEvent: (event: SyncEvent) => void;
  openBrowser: (url: string) => Promise<void>;
  tokenCache: TokenCachePersistence | null;
}

/** Wires settings, server auth, sync, local store, and the agent service together. */
export class AppCore {
  readonly settings: SettingsStore;
  readonly threads: ThreadStore;
  readonly searchIndex: SearchIndex;
  readonly serverAuth: ServerAuth;
  readonly syncClient: SyncClient;
  readonly syncQueue: SyncQueue;
  readonly agent: AgentService;
  readonly mcpPrompts: McpPrompts;

  private profilesCache: { at: number; profiles: OrchestratorProfile[] } | null = null;
  /** Completed orchestrator runs awaiting their assistant message's server id (to link on POST). */
  private readonly pendingRuns = new Map<string, OrchestratorRunPayload>();

  constructor(private readonly deps: AppCoreDeps) {
    this.settings = new SettingsStore(deps.userDataDir);
    const threadsDir = path.join(deps.userDataDir, 'threads');
    this.threads = new ThreadStore(threadsDir);
    this.searchIndex = new SearchIndex(threadsDir, path.join(deps.userDataDir, 'search-index.json'));
    this.serverAuth = new ServerAuth(() => this.settings.get(), deps.tokenCache, deps.openBrowser);
    this.syncClient = new SyncClient({
      getBaseUrl: () => this.settings.get().serverBaseUrl,
      getToken: (force) => this.serverAuth.getAccessToken(force),
    });
    this.syncQueue = new SyncQueue({
      client: this.syncClient,
      file: path.join(deps.userDataDir, 'sync-queue.json'),
      emit: (event) => {
        if (event.kind === 'sync-state') {
          this.threads.setSyncState(event.threadId, event.state);
        }
        deps.emitSyncEvent(event);
      },
      onServerIds: (threadId, mapping) => this.handleServerIds(threadId, mapping),
    });
    // M19 flip: when serverAuthMode is 'entra' the same JWT goes to /mcp/**;
    // in dev mode the mock decoder accepts the static token as well.
    const mcpAuthProvider = { headers: () => this.serverAuth.headers() };
    this.mcpPrompts = new McpPrompts({ getSettings: () => this.settings.get(), auth: mcpAuthProvider });
    this.agent = new AgentService({
      getSettings: () => this.settings.get(),
      mcpAuthProvider,
      emit: deps.emitAgentEvent,
      onSessionId: (threadId, sessionId) => this.threads.setSessionId(threadId, sessionId),
      onTurnPersist: (threadId, userMessage, assistantMessage) =>
        this.persistTurn(threadId, userMessage, assistantMessage),
      sandboxDir: sandboxDirFor(deps.userDataDir),
      syncClient: this.syncClient,
      mcpPrompts: this.mcpPrompts,
      getOrchestratorProfile: (name) => this.resolveOrchestratorProfile(name),
    });
    // Local content search. Deliberately not awaited: the sweep only re-reads logs that changed
    // since last run, and until it lands the sidebar still searches titles.
    void this.searchIndex
      .start()
      .then(({ indexed, skipped, removed }) =>
        log('search', `content index ready — ${indexed} indexed, ${skipped} unchanged, ${removed} dropped`),
      )
      .catch((err) => logError('search', `index sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Multi-agent profiles the server exposes; empty list if unreachable. Cached with a short TTL. */
  async listOrchestratorProfiles(): Promise<OrchestratorProfile[]> {
    if (this.profilesCache && Date.now() - this.profilesCache.at < 60_000) {
      return this.profilesCache.profiles;
    }
    try {
      const profiles = await this.syncClient.getOrchestratorProfiles();
      this.profilesCache = { at: Date.now(), profiles };
      return profiles;
    } catch {
      return this.profilesCache?.profiles ?? [];
    }
  }

  /** Resolve one profile by name for the agent layer (uses the same cache). */
  async resolveOrchestratorProfile(name: string): Promise<OrchestratorProfile | undefined> {
    const profiles = await this.listOrchestratorProfiles();
    return profiles.find((p) => p.name === name);
  }

  /** MCP prompts (playbooks) the server exposes; empty list if the server is unreachable. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      return await this.mcpPrompts.list();
    } catch {
      return [];
    }
  }

  /** Resolve a `[<uuid>]` / `[chunk_id=…]` / `[file=…]` citation marker to its source section markdown. */
  async getCitation(ref: CitationRef): Promise<string> {
    return this.mcpPrompts.getSection(ref);
  }

  /**
   * Preflight the playbook attached to a message — the desktop's side of the web's
   * `POST /chat/{id}/validate-playbook`.
   *
   * Every guard here resolves to "fine": the check is an assist, so a disabled setting, an
   * unknown thread, an unreachable server, or a playbook the picker does not offer all let the
   * message through unchallenged rather than stalling it on a check that cannot be made.
   */
  async validatePlaybook(request: PlaybookValidationRequest): Promise<PlaybookValidation> {
    const settings = this.settings.get();
    if (settings.playbookValidationEnabled === false) return PASSES;

    const thread = this.threads.get(request.threadId);
    // Orchestrator mode drives its own playbooks from the profile; a message there carries none.
    if (!thread || thread.orchestratorProfile) return PASSES;

    const question = request.text?.trim() ?? '';
    if (!question || !request.promptName) return PASSES;

    const [prompts, profiles] = await Promise.all([
      this.listPrompts(),
      this.listOrchestratorProfiles(),
    ]);
    // The same list the picker shows: suggesting an orchestrator or reviewer playbook would
    // recommend something the user cannot select (see isUserSelectablePlaybook).
    const control = controlPlaybookNames(profiles);
    const showPrototypes = Boolean(settings.showPrototypePlaybooks);
    const candidates = prompts.filter((p) => isUserSelectablePlaybook(p, control, showPrototypes));
    const selected = candidates.find((p) => p.name === request.promptName);
    // Nothing to compare against: the server was unreachable, or this is the only playbook there is.
    if (!selected || candidates.length < 2) return PASSES;

    return validatePlaybookSelection({
      question,
      selected,
      playbooks: candidates,
      // The conversation's own model, as on the web (which reads ConversationSetting.MODEL).
      model: thread.model,
      sandboxDir: sandboxDirFor(this.deps.userDataDir),
    });
  }

  private persistTurn(threadId: string, userMessage: ChatMessage, assistantMessage: ChatMessage): void {
    // Best-effort local cache write (the server is the system of record); don't block the turn on it.
    void this.threads
      .appendMessages(threadId, [userMessage, assistantMessage])
      .catch((err) => logError('store', `appendMessages failed: ${err instanceof Error ? err.message : String(err)}`));
    // Keep search current within the session — no need to wait for the next startup sweep.
    this.searchIndex.addMessages(threadId, [userMessage, assistantMessage]);
    const usage = assistantMessage.usage;
    const thread = this.threads.get(threadId);
    const isOrchestrator = !!thread?.orchestratorProfile;

    const syncedContent = serializeAssistantContent(assistantMessage, isOrchestrator);

    this.syncQueue.enqueue({
      threadId,
      localIds: [userMessage.localId, assistantMessage.localId],
      messages: [
        { role: 'user', content: userMessage.content },
        {
          role: 'assistant',
          content: syncedContent,
          promptTokens: usage?.inputTokens ?? null,
          completionTokens: usage?.outputTokens ?? null,
          totalTokens: usage ? usage.inputTokens + usage.outputTokens : null,
          cachedTokens: usage?.cacheReadTokens ?? null,
          thoughtTokens: usage?.thoughtTokens ?? null,
        },
      ],
    });

    if (isOrchestrator && thread) {
      void this.stashOrchestratorRun(thread, userMessage, assistantMessage);
    }
  }

  /** Assemble the run trace and hold it until the assistant message's server id is known. */
  private async stashOrchestratorRun(thread: ThreadMeta, userMessage: ChatMessage, assistantMessage: ChatMessage): Promise<void> {
    const orchestrator = this.settings.get().orchestrator;
    if (!orchestrator || !thread.orchestratorProfile) return;
    try {
      const profile = await this.resolveOrchestratorProfile(thread.orchestratorProfile);
      const payload = buildRunTrace({
        conversationId: thread.id,
        userText: userMessage.content,
        assistant: assistantMessage,
        profileName: thread.orchestratorProfile,
        profile,
        orchestrator,
      });
      if (payload) {
        this.pendingRuns.set(assistantMessage.localId, payload);
        // Entries only clear on a successful server-id mapping; a turn dropped as
        // non-retriable (4xx) would otherwise leak forever. Bound the map by
        // evicting the oldest entries (Map preserves insertion order).
        const MAX_PENDING_RUNS = 50;
        while (this.pendingRuns.size > MAX_PENDING_RUNS) {
          const oldest = this.pendingRuns.keys().next().value;
          if (oldest === undefined) break;
          this.pendingRuns.delete(oldest);
        }
      }
    } catch (err) {
      logError('sync', `Failed to assemble orchestrator run trace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persist localId→serverId mapping, then POST any pending run trace now that we can link it. */
  private handleServerIds(threadId: string, mapping: Record<string, string>): void {
    void this.threads
      .applyServerIds(threadId, mapping)
      .catch((err) => logError('store', `applyServerIds failed: ${err instanceof Error ? err.message : String(err)}`));
    for (const [localId, serverId] of Object.entries(mapping)) {
      const run = this.pendingRuns.get(localId);
      if (!run) continue;
      this.pendingRuns.delete(localId);
      run.messageId = serverId;
      void this.syncClient
        .recordOrchestratorRun(run)
        .then((res) => log('sync', `Recorded orchestrator run ${res.id} (${run.steps.length} steps) → message ${serverId}`))
        .catch((err) => logError('sync', `Failed to record orchestrator run: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // --- threads ---------------------------------------------------------------

  async listThreads(): Promise<{ threads: ThreadMeta[]; serverReachable: boolean }> {
    try {
      const conversations = await this.syncClient.listConversations();
      for (const c of conversations) {
        const existing = this.threads.get(c.id);
        const settings = this.settings.get();
        this.threads.upsert({
          id: c.id,
          sessionId: existing?.sessionId,
          title: c.title,
          model: existing?.model ?? String(c.settings?.model ?? settings.defaultModel),
          thinkingLevel: existing?.thinkingLevel ?? (String(c.settings?.['thinking-level'] ?? c.settings?.thinkingLevel ?? settings.defaultThinkingLevel) as ThinkingLevel),
          createdAt: c.createdAt,
          updatedAt: c.updatedAt ?? existing?.updatedAt ?? c.createdAt,
          totals: existing?.totals ?? ThreadStore.emptyTotals(),
          syncState: existing?.syncState ?? 'synced',
          orchestratorProfile:
            existing?.orchestratorProfile ??
            (c.settings?.['orchestrator-profile'] ? String(c.settings['orchestrator-profile']) : undefined),
        });
      }
      // Drop local cache entries the server no longer knows (deleted elsewhere).
      const serverIds = new Set(conversations.map((c) => c.id));
      for (const local of this.threads.list()) {
        if (!serverIds.has(local.id) && this.syncQueue.pendingCount(local.id) === 0) {
          this.threads.delete(local.id);
        }
      }
      return { threads: this.threads.list(), serverReachable: true };
    } catch (err) {
      logError('sync', 'listThreads failed:', err instanceof Error ? err.message : String(err));
      return { threads: this.threads.list(), serverReachable: false };
    }
  }

  async createThread(): Promise<ThreadMeta> {
    const settings = this.settings.get();
    const conversation = await this.syncClient.createConversation(null, {
      model: settings.defaultModel,
      thinkingLevel: settings.defaultThinkingLevel,
      'thinking-level': settings.defaultThinkingLevel,
      client: 'desktop',
    });
    const meta: ThreadMeta = {
      id: conversation.id,
      title: conversation.title,
      model: settings.defaultModel,
      thinkingLevel: settings.defaultThinkingLevel,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt ?? conversation.createdAt,
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    };
    this.threads.upsert(meta);
    return meta;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.agent.closeThread(threadId);
    await this.syncClient.deleteConversation(threadId);
    this.threads.delete(threadId);
    this.searchIndex.remove(threadId);
  }

  patchThread(threadId: string, update: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>>): ThreadMeta | undefined {
    // Whitelist the mutable keys so a malicious/buggy renderer can't inject
    // arbitrary fields (e.g. id, sessionId, totals) into the stored meta.
    const sanitized: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>> = {};
    if (update.model !== undefined) sanitized.model = update.model;
    if (update.thinkingLevel !== undefined) sanitized.thinkingLevel = update.thinkingLevel;
    if (update.title !== undefined) sanitized.title = update.title;
    if (update.orchestratorProfile !== undefined) sanitized.orchestratorProfile = update.orchestratorProfile;
    update = sanitized;
    const patched = this.threads.patch(threadId, sanitized);
    if (patched) {
      // Undefined means "this patch is not about the title" — see updateConversation.
      const title = update.title;
      const settingsPayload: Record<string, unknown> = {};
      if (update.model) settingsPayload.model = update.model;
      if (update.thinkingLevel) {
        settingsPayload.thinkingLevel = update.thinkingLevel;
        settingsPayload['thinking-level'] = update.thinkingLevel;
      }
      // Mirror the web ConversationSetting key so both surfaces share the selection.
      if (update.orchestratorProfile !== undefined) {
        settingsPayload['orchestrator-profile'] = update.orchestratorProfile;
      }
      void this.syncClient.updateConversation(threadId, title, settingsPayload).catch(() => undefined);
    }
    return patched;
  }

  /** Local log first; falls back to server rehydration (reinstall / second device). */
  async getMessages(threadId: string): Promise<ChatMessage[]> {
    const local = await this.threads.readMessages(threadId);
    if (local.length > 0) {
      return local;
    }
    try {
      const remote = await this.syncClient.getMessages(threadId);
      const rehydrated = remote.map((m) => this.fromDto(m));
      if (rehydrated.length > 0) {
        await this.threads.replaceMessages(threadId, rehydrated);
        // A thread pulled back from the server has no local log until now, so this is the
        // moment its content becomes searchable.
        this.searchIndex.replaceMessages(threadId, rehydrated);
        // appendMessages accrues totals per turn; a rehydrated log bypasses that,
        // so recompute the thread totals from the synced per-message usage.
        const totals = rehydrated.reduce<UsageTotals>((acc, m) => {
          if (m.role === 'assistant' && m.usage) {
            acc.inputTokens += m.usage.inputTokens;
            acc.outputTokens += m.usage.outputTokens;
            acc.cacheReadTokens += m.usage.cacheReadTokens;
            acc.cacheWriteTokens += m.usage.cacheWriteTokens;
          }
          return acc;
        }, ThreadStore.emptyTotals());
        this.threads.patch(threadId, { totals });
      }
      return rehydrated;
    } catch {
      return [];
    }
  }

  private fromDto(dto: MessageDto): ChatMessage {
    const parsed = parseStoredContent(dto.content);
    return {
      localId: dto.id,
      serverId: dto.id,
      role: dto.role,
      content: parsed.content,
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
      blocks: parsed.blocks,
      usage:
        dto.promptTokens != null || dto.completionTokens != null
          ? {
              inputTokens: dto.promptTokens ?? 0,
              outputTokens: dto.completionTokens ?? 0,
              cacheReadTokens: dto.cachedTokens ?? 0,
              cacheWriteTokens: 0,
              thoughtTokens: dto.thoughtTokens ?? 0,
            }
          : undefined,
      createdAt: dto.createdAt,
      feedback:
        dto.feedbackRating === 1 || dto.feedbackRating === -1
          ? { rating: dto.feedbackRating, comment: dto.feedbackComment ?? undefined }
          : undefined,
    };
  }

  /** Threads whose message content matches `query`, searched against the local index only. */
  async searchThreads(query: string): Promise<ThreadSearchHit[]> {
    return this.searchIndex.search(query);
  }

  // --- chat -------------------------------------------------------------------

  async sendMessage(request: SendMessageRequest): Promise<void> {
    const thread = this.threads.get(request.threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${request.threadId}`);
    }
    let injectBefore: string | undefined;
    let playbook: string | undefined;
    // Orchestrator mode drives everything from the orchestrator's system prompt — never prepend a playbook.
    if (request.promptName && !thread.orchestratorProfile) {
      // Resolve the playbook text up front so a server hiccup surfaces before the turn starts.
      injectBefore = await this.mcpPrompts.getText(request.promptName);
      playbook = request.promptName;
    }
    await this.agent.sendMessage(thread, request.text, {
      thinkingOverride: request.thinkingOverride,
      injectBefore,
      playbook,
      playbookName: request.promptName,
    });
  }

  // --- feedback ----------------------------------------------------------------

  async submitFeedback(request: FeedbackRequest): Promise<void> {
    if (request.rating === -1 && (!request.comment || request.comment.trim().length === 0)) {
      throw new Error('A comment is required for negative feedback.');
    }
    const message = (await this.threads.readMessages(request.threadId)).find((m) => m.localId === request.messageLocalId);
    if (!message) {
      throw new Error('Message not found.');
    }
    if (!message.serverId) {
      throw new Error('This message is still syncing to the server — try again in a moment.');
    }
    await this.syncClient.submitFeedback(message.serverId, request.rating, request.comment?.trim() || undefined);
    await this.threads.setFeedback(request.threadId, request.messageLocalId, request.rating, request.comment?.trim() || undefined);
  }

  // --- auth ---------------------------------------------------------------------

  async authStatus(): Promise<AuthStatus> {
    return {
      claude: detectClaudeCredentials() === 'missing' ? 'missing' : 'ok',
      claudeAccount: detectClaudeAccount(),
      server: await this.serverAuth.status(),
    };
  }

  dispose(): void {
    this.agent.closeAll();
    this.syncQueue.dispose();
    this.searchIndex.dispose();
  }
}

export function newLocalId(): string {
  return randomUUID();
}

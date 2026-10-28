import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  AuthVerificationResponse,
  ChatMessage,
  CitationRef,
  FeedbackRequest,
  ImageAttachment,
  LoginVerificationResult,
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
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  controlPlaybookNames,
  isPlaybookValidationExcluded,
  isThreadStarted,
  isUserSelectablePlaybook,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  normalizeImageDescription,
} from '../shared/types';
import { log, logError } from './log';
import { webAccessDiagnostics } from './agent/policy';
import { AgentService, sandboxDirFor } from './agent/AgentService';
import { McpPrompts } from './agent/McpPrompts';
import { PASSES } from './agent/playbookValidation';
import { validatePlaybookSelection } from './agent/PlaybookValidator';
import { describeImages } from './agent/ImageDescriptor';
import { buildRunTrace } from './agent/runTrace';
import { detectClaudeAccount, detectClaudeCredentials } from './agent/ClaudeAuth';
import { ServerAuth, type TokenCachePersistence } from './auth/ServerAuth';
import { SettingsStore } from './settings/Settings';
import { SearchIndex } from './store/SearchIndex';
import { ThreadStore } from './store/ThreadStore';
import { parseStoredContent, serializeAssistantContent } from './store/messageCodec';
import { SyncApiError, SyncClient, type MessageDto } from './sync/SyncClient';
import { SyncQueue } from './sync/SyncQueue';

const MAX_PENDING_RUNS = 50;
const RUN_TRACE_METADATA_TIMEOUT_MS = 5_000;
const RUN_RETRY_BASE_DELAY_MS = 5_000;
const RUN_RETRY_MAX_DELAY_MS = 60_000;
const MAX_RUN_RETRY_ATTEMPTS = 5;

interface FailedOrchestratorRun {
  run: OrchestratorRunPayload;
  attempts: number;
  nextRetryAt: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface AppCoreDeps {
  userDataDir: string;
  emitAgentEvent: (event: AgentEvent) => void;
  emitSyncEvent: (event: SyncEvent) => void;
  openBrowser: (url: string) => Promise<void>;
  tokenCache: TokenCachePersistence | null;
}

const ALLOWED_IMAGE_TYPES = new Set<string>(ALLOWED_IMAGE_MEDIA_TYPES);

/** How long persisting a turn will wait on descriptions still running — see `awaitDescriptions`. */
export const DESCRIPTION_PERSIST_GRACE_MS = 2_000;
const MB = 1024 * 1024;

export function validateAndSanitizeImages(images?: ImageAttachment[]): ImageAttachment[] | undefined {
  if (!images || images.length === 0) return undefined;
  if (images.length > MAX_IMAGE_COUNT) {
    throw new Error(`Maximum ${MAX_IMAGE_COUNT} image attachments allowed.`);
  }

  const sizeLimitMb = Math.round(MAX_IMAGE_BYTES / MB);
  const sanitized = images.map((img, idx) => {
    if (!img.mediaType || !ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      throw new Error(`Unsupported image type "${img.mediaType}". Allowed: ${ALLOWED_IMAGE_MEDIA_TYPES.join(', ')}.`);
    }
    if (!img.data || typeof img.data !== 'string' || img.data.trim().length === 0) {
      throw new Error(`Image attachment ${idx + 1} has empty data; non-empty base64 string required.`);
    }
    const cleanData = img.data.trim();
    if (img.size !== undefined && img.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image attachment "${img.name || idx + 1}" exceeds the ${sizeLimitMb}MB size limit.`);
    }
    const byteLength = Buffer.byteLength(cleanData, 'base64');
    if (byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image attachment "${img.name || idx + 1}" exceeds the ${sizeLimitMb}MB size limit.`);
    }
    return {
      id: img.id || randomUUID(),
      mediaType: img.mediaType,
      data: cleanData,
      name: img.name,
      size: img.size ?? byteLength,
      // A renderer-supplied description gets the same fold as a generated one — this is the only
      // attachment field the composer can put free text in, and it ends up in the synced body.
      description: normalizeImageDescription(img.description),
    };
  });

  // Each attachment can be under the per-image limit while the batch still overflows the API's
  // per-request ceiling (base64 inflates by ~4/3), so the total is checked as well.
  const totalBytes = sanitized.reduce((sum, img) => sum + Buffer.byteLength(img.data, 'base64'), 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(
      `Image attachments total ${(totalBytes / MB).toFixed(1)}MB, over the ${Math.round(MAX_TOTAL_IMAGE_BYTES / MB)}MB limit for one message.`,
    );
  }
  return sanitized;
}

/**
 * Format user content for syncing to the server, appending concise image references and descriptions.
 */
export function formatSyncedUserContent(content: string, images?: ImageAttachment[]): string {
  if (!images || images.length === 0) {
    return content;
  }
  const imageNotes = images
    .map(
      (img, i) =>
        `[Attached Image ${i + 1} (${img.name || 'image.png'})${img.description ? `: ${img.description}` : ''}]`,
    )
    .join('\n');
  return content ? `${content}\n\n${imageNotes}` : imageNotes;
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
  private readonly pendingRuns = new Map<
    string,
    OrchestratorRunPayload | Promise<OrchestratorRunPayload | null>
  >();
  /** Resolved orchestrator runs whose POST failed transiently and will retry on next sync activity. */
  private readonly failedRuns: FailedOrchestratorRun[] = [];
  /** Started threads whose message log has already been inspected once for initialPlaybook backfill. */
  private readonly playbookBackfillChecked = new Set<string>();
  /**
   * Image descriptions in flight, keyed by the attachment array they describe.
   *
   * Started in `sendMessage` so they run alongside the agent turn — which nearly always outlasts
   * them — instead of adding their latency to persistence. The key is the very array `AgentService`
   * hangs off the user message, which is what lets `persistTurn` find them again without an id the
   * renderer never sees; being weak, an entry goes away with the message that owned it.
   */
  private readonly pendingDescriptions = new WeakMap<ImageAttachment[], Promise<ImageAttachment[]>>();
  /** Per-thread tail of the persist chain — see `chainPersist`. */
  private readonly persistTails = new Map<string, Promise<void>>();
  private activeVerification: Promise<AuthVerificationResponse> | null = null;

  constructor(private readonly deps: AppCoreDeps) {
    this.settings = new SettingsStore(deps.userDataDir);
    // The allow-list and the bot-challenged-host list are maintained apart and can drift into a
    // combination that grants WebFetch nothing. That never surfaces at runtime — the calls just
    // deny, one turn at a time — so the effective grant is stated here where it can be read.
    for (const line of webAccessDiagnostics(this.settings.get())) log('web', line);
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
    const mcpAuthProvider = {
      headers: () => this.serverAuth.headers(),
      invalidate: () => this.serverAuth.invalidate(),
    };
    this.mcpPrompts = new McpPrompts({ getSettings: () => this.settings.get(), auth: mcpAuthProvider });
    this.agent = new AgentService({
      getSettings: () => this.settings.get(),
      mcpAuthProvider,
      emit: deps.emitAgentEvent,
      onSessionId: (threadId, sessionId, profile) => this.threads.setSessionId(threadId, sessionId, profile),
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

    // Fast-path (Stage 1): evaluate slug match before listing prompts or profiles
    if (
      isPlaybookValidationExcluded(
        { name: request.promptName },
        settings.playbookValidationExcludedPlaybooks,
      )
    ) {
      return PASSES;
    }

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

    // Stage 2 (Candidate Title Match): evaluate resolved candidate against exclusion list
    if (isPlaybookValidationExcluded(selected, settings.playbookValidationExcludedPlaybooks)) {
      return PASSES;
    }

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
    // Resolved before anything is written, so the local log, the search index and the sync payload
    // all carry the same attachments. `sendMessage` started this alongside the turn, so by now it
    // is almost always settled; `describeImages` caps its own wait either way.
    const pending = userMessage.images ? this.pendingDescriptions.get(userMessage.images) : undefined;
    this.chainPersist(threadId, async () => {
      const images = pending ? await this.awaitDescriptions(pending, userMessage.images) : userMessage.images;
      // Never write through to the caller's message: `AgentService` still holds it as the session's
      // pendingUser, and the renderer is already showing it.
      const user = images === userMessage.images ? userMessage : { ...userMessage, images };
      this.writeTurn(threadId, user, assistantMessage);
    });
  }

  /**
   * The descriptions for a turn, or the undescribed attachments if they are still running well
   * after the turn ended.
   *
   * They start when the message is sent, so a real turn nearly always outlasts them and the grace
   * period is never reached. It exists because until this resolves the exchange is written nowhere
   * — not the local log, not the sync queue — and a quit in that window would lose it; a batch of
   * five attachments could otherwise hold it open for the descriptor's timeout several times over.
   * The losing batch keeps running and is simply discarded.
   */
  private async awaitDescriptions(
    pending: Promise<ImageAttachment[]>,
    fallback: ImageAttachment[] | undefined,
  ): Promise<ImageAttachment[] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DESCRIPTION_PERSIST_GRACE_MS);
    });
    try {
      const described = await Promise.race([pending, grace]);
      if (described) return described;
      logError(
        'agent',
        `image descriptions outran the turn by ${DESCRIPTION_PERSIST_GRACE_MS}ms — ` +
          'persisting with the attachment filenames alone',
      );
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run each turn's persistence after the previous turn's for the same thread.
   *
   * `SyncQueue` posts in enqueue order and `ThreadStore.appendMessages` appends in call order, so
   * without this a turn that waits on image descriptions would be overtaken by the short text turn
   * the user sent straight after it, and both the local log and the server transcript would carry
   * the two turns swapped.
   */
  private chainPersist(threadId: string, work: () => Promise<void>): void {
    const previous = this.persistTails.get(threadId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch((err) =>
        logError('store', `persisting a turn failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        // Only the newest link clears the entry; an older one finishing must not drop a tail that
        // a later turn is already queued behind.
        if (this.persistTails.get(threadId) === next) this.persistTails.delete(threadId);
      });
    this.persistTails.set(threadId, next);
  }

  /** The write itself: local log, search index, sync queue, orchestrator trace. */
  private writeTurn(threadId: string, userMessage: ChatMessage, assistantMessage: ChatMessage): void {
    const usage = assistantMessage.usage;
    const thread = this.threads.get(threadId);
    const isOrchestrator = !!thread?.orchestratorProfile;

    // Best-effort local cache write (the server is the system of record); don't block the turn on it.
    void this.threads
      .appendMessages(threadId, [userMessage, assistantMessage])
      .catch((err) => logError('store', `appendMessages failed: ${err instanceof Error ? err.message : String(err)}`));
    // Keep search current within the session — no need to wait for the next startup sweep.
    this.searchIndex.addMessages(threadId, [userMessage, assistantMessage]);

    if (isOrchestrator && thread) {
      void this.stashOrchestratorRun(thread, userMessage, assistantMessage);
    }

    this.syncQueue.enqueue({
      threadId,
      localIds: [userMessage.localId, assistantMessage.localId],
      messages: [
        {
          role: 'user',
          content: formatSyncedUserContent(userMessage.content, userMessage.images),
          playbook: userMessage.playbook,
          playbookVersion: userMessage.playbookVersion,
        },
        {
          role: 'assistant',
          content: serializeAssistantContent(assistantMessage, isOrchestrator),
          playbook: assistantMessage.playbook,
          playbookVersion: assistantMessage.playbookVersion,
          promptTokens: usage?.inputTokens ?? null,
          completionTokens: usage?.outputTokens ?? null,
          totalTokens: usage ? usage.inputTokens + usage.outputTokens : null,
          cachedTokens: usage?.cacheReadTokens ?? null,
          thoughtTokens: usage?.thoughtTokens ?? null,
        },
      ],
    });
  }

  /** Assemble the run trace and hold it until the assistant message's server id is known. */
  private async stashOrchestratorRun(thread: ThreadMeta, userMessage: ChatMessage, assistantMessage: ChatMessage): Promise<void> {
    const orchestrator = this.settings.get().orchestrator;
    const profileName = thread.orchestratorProfile;
    if (!orchestrator || !profileName) return;

    const tracePromise: Promise<OrchestratorRunPayload | null> = (async () => {
      try {
        const [profile, playbookVersions] = await Promise.all([
          withTimeout(
            this.resolveOrchestratorProfile(profileName),
            RUN_TRACE_METADATA_TIMEOUT_MS,
            'resolveOrchestratorProfile',
          ).catch(() => this.profilesCache?.profiles.find((p) => p.name === profileName)),
          withTimeout(
            this.mcpPrompts.list(),
            RUN_TRACE_METADATA_TIMEOUT_MS,
            'mcpPrompts.list',
          )
            .then((prompts) => {
              const versions = new Map<string, number>();
              for (const p of prompts) {
                if (typeof p.version === 'number') {
                  versions.set(p.name, p.version);
                }
              }
              return versions;
            })
            .catch((err) => {
              log(
                'sync',
                `Failed to resolve playbook versions for orchestrator run trace: ${err instanceof Error ? err.message : String(err)}`,
              );
              return undefined;
            }),
        ]);

        return buildRunTrace({
          conversationId: thread.id,
          userText: userMessage.content,
          assistant: assistantMessage,
          profileName,
          profile,
          orchestrator,
          playbookVersions,
        });
      } catch (err) {
        logError('sync', `Failed to assemble orchestrator run trace: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    })();

    // Register synchronously BEFORE awaiting so a fast appendMessages ack never misses the entry.
    this.pendingRuns.set(assistantMessage.localId, tracePromise);
    while (this.pendingRuns.size > MAX_PENDING_RUNS) {
      const oldest = this.pendingRuns.keys().next().value;
      if (oldest === undefined) break;
      this.pendingRuns.delete(oldest);
    }

    const payload = await tracePromise;
    if (this.pendingRuns.get(assistantMessage.localId) === tracePromise) {
      if (payload) {
        this.pendingRuns.set(assistantMessage.localId, payload);
      } else {
        this.pendingRuns.delete(assistantMessage.localId);
      }
    }
  }

  /** Persist localId→serverId mapping, then POST any pending run trace now that we can link it. */
  private handleServerIds(threadId: string, mapping: Record<string, string>): void {
    void this.threads
      .applyServerIds(threadId, mapping)
      .catch((err) => logError('store', `applyServerIds failed: ${err instanceof Error ? err.message : String(err)}`));
    this.drainFailedRuns();
    for (const [localId, serverId] of Object.entries(mapping)) {
      const entry = this.pendingRuns.get(localId);
      if (!entry) continue;
      this.pendingRuns.delete(localId);
      if (entry instanceof Promise) {
        void entry.then((run) => {
          if (!run) return;
          run.messageId = serverId;
          this.postOrchestratorRun(run);
        });
      } else {
        entry.messageId = serverId;
        this.postOrchestratorRun(entry);
      }
    }
  }

  private drainFailedRuns(): void {
    if (this.failedRuns.length === 0) return;
    const now = Date.now();
    const ready: FailedOrchestratorRun[] = [];
    for (let i = 0; i < this.failedRuns.length; ) {
      if (this.failedRuns[i].nextRetryAt <= now) {
        ready.push(...this.failedRuns.splice(i, 1));
      } else {
        i++;
      }
    }
    for (const entry of ready) {
      this.postOrchestratorRun(entry.run, entry.attempts);
    }
  }

  private postOrchestratorRun(run: OrchestratorRunPayload, attempts = 0): void {
    void this.syncClient
      .recordOrchestratorRun(run)
      .then((res) =>
        log(
          'sync',
          `Recorded orchestrator run ${res.id} (${run.steps.length} steps) → message ${run.messageId ?? 'unknown'}`,
        ),
      )
      .catch((err) => {
        logError('sync', `Failed to record orchestrator run: ${err instanceof Error ? err.message : String(err)}`);
        const isRetriable =
          err instanceof SyncApiError &&
          (err.status === 401 || err.status === 429 || err.status === 502 || err.status === 503);
        if (isRetriable && attempts < MAX_RUN_RETRY_ATTEMPTS) {
          const nextAttempts = attempts + 1;
          const delay = Math.min(
            RUN_RETRY_MAX_DELAY_MS,
            RUN_RETRY_BASE_DELAY_MS * 2 ** (nextAttempts - 1),
          );
          this.failedRuns.push({
            run,
            attempts: nextAttempts,
            nextRetryAt: Date.now() + delay,
          });
          while (this.failedRuns.length > MAX_PENDING_RUNS) {
            this.failedRuns.shift();
          }
        }
      });
  }

  private buildThreadSettings(thread: ThreadMeta): Record<string, unknown> {
    return {
      ...(thread.remoteSettings ?? {}),
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      'thinking-level': thread.thinkingLevel,
      'orchestrator-profile': thread.orchestratorProfile ?? '',
      client: 'desktop',
    };
  }

  // --- threads ---------------------------------------------------------------

  async listThreads(): Promise<{ threads: ThreadMeta[]; serverReachable: boolean }> {
    try {
      const conversations = await this.syncClient.listConversations();
      this.drainFailedRuns();
      for (const c of conversations) {
        const existing = this.threads.get(c.id);
        const settings = this.settings.get();
        const rawRemoteProfile = c.settings?.['orchestrator-profile'];
        const remoteProfile =
          typeof rawRemoteProfile === 'string' && rawRemoteProfile.trim().length > 0
            ? rawRemoteProfile.trim()
            : undefined;
        const isStarted = existing ? isThreadStarted(existing) : false;
        const isBusy = existing ? this.agent.isBusy(c.id) : false;
        const canAdoptRemoteProfile = !isStarted && !isBusy;
        const orchestratorProfile = canAdoptRemoteProfile
          ? (remoteProfile ?? existing?.orchestratorProfile)
          : existing?.orchestratorProfile;
        const modeMatches =
          existing?.sessionProfile === orchestratorProfile ||
          (!existing?.sessionProfile && !orchestratorProfile);
        const shouldResetSession = Boolean(
          existing && !isBusy && (existing.orchestratorProfile !== orchestratorProfile || !modeMatches),
        );
        if (shouldResetSession) {
          this.agent.closeThread(c.id);
        }
        const remoteSettings = c.settings
          ? { ...c.settings }
          : existing?.remoteSettings;
        const upserted: ThreadMeta = {
          id: c.id,
          sessionId: shouldResetSession ? undefined : existing?.sessionId,
          sessionProfile: shouldResetSession ? undefined : existing?.sessionProfile,
          title: c.title,
          model: existing?.model ?? String(c.settings?.model ?? settings.defaultModel),
          thinkingLevel: existing?.thinkingLevel ?? (String(c.settings?.['thinking-level'] ?? c.settings?.thinkingLevel ?? settings.defaultThinkingLevel) as ThinkingLevel),
          createdAt: c.createdAt,
          updatedAt: c.updatedAt ?? existing?.updatedAt ?? c.createdAt,
          totals: existing?.totals ?? ThreadStore.emptyTotals(),
          syncState: existing?.syncState ?? 'synced',
          orchestratorProfile,
          initialPlaybook: orchestratorProfile ? undefined : existing?.initialPlaybook,
          hasStarted: existing?.hasStarted,
          remoteSettings,
        };
        this.threads.upsert(upserted);
        if (existing && (orchestratorProfile ?? '') !== (remoteProfile ?? '')) {
          void this.syncClient
            .updateConversation(c.id, undefined, this.buildThreadSettings(upserted))
            .catch(() => undefined);
        }
      }
      // Drop local cache entries the server no longer knows (deleted elsewhere).
      const serverIds = new Set(conversations.map((c) => c.id));
      for (const local of this.threads.list()) {
        if (!serverIds.has(local.id) && this.syncQueue.pendingCount(local.id) === 0) {
          this.threads.delete(local.id);
          this.playbookBackfillChecked.delete(local.id);
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
      remoteSettings: conversation.settings ? { ...conversation.settings } : undefined,
    };
    this.threads.upsert(meta);
    return meta;
  }

  async deleteThread(threadId: string): Promise<void> {
    this.agent.closeThread(threadId);
    await this.syncClient.deleteConversation(threadId);
    this.threads.delete(threadId);
    this.playbookBackfillChecked.delete(threadId);
    this.searchIndex.remove(threadId);
  }

  patchThread(threadId: string, update: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>>): ThreadMeta | undefined {
    // Whitelist the mutable keys so a malicious/buggy renderer can't inject
    // arbitrary fields (e.g. id, sessionId, totals) into the stored meta.
    const sanitized: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>> = {};
    if (update.model !== undefined) sanitized.model = update.model;
    if (update.thinkingLevel !== undefined) sanitized.thinkingLevel = update.thinkingLevel;
    if (update.title !== undefined) sanitized.title = update.title;
    if ('orchestratorProfile' in update) {
      sanitized.orchestratorProfile = update.orchestratorProfile || undefined;
    }
    update = sanitized;

    const existing = this.threads.get(threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const modeChanged =
      'orchestratorProfile' in update &&
      (sanitized.orchestratorProfile || undefined) !== (existing.orchestratorProfile || undefined);

    if (modeChanged && isThreadStarted(existing)) {
      throw new Error('Cannot change agent mode once a conversation has started');
    }

    if (modeChanged) {
      if (this.agent.isBusy(threadId)) {
        throw new Error('Cannot change agent mode while a turn is in progress');
      }
      this.agent.closeThread(threadId);
    }

    const patchPayload: Partial<ThreadMeta> = { ...sanitized };
    if (modeChanged) {
      patchPayload.sessionId = undefined;
      patchPayload.sessionProfile = undefined;
    }
    const fullSettings = this.buildThreadSettings({ ...existing, ...patchPayload });
    patchPayload.remoteSettings = fullSettings;

    const patched = this.threads.patch(threadId, patchPayload);
    if (patched) {
      // Undefined means "this patch is not about the title" — see updateConversation.
      const title = update.title;
      void this.syncClient
        .updateConversation(threadId, title, fullSettings)
        .catch(() => undefined);
    }
    return patched;
  }

  private backfillInitialPlaybook(threadId: string, messages: readonly ChatMessage[]): void {
    this.playbookBackfillChecked.add(threadId);
    const thread = this.threads.get(threadId);
    if (!thread || thread.orchestratorProfile || thread.initialPlaybook) return;
    const firstPlaybook = messages
      .find((m) => m.role === 'user' && Boolean(m.playbook?.trim()))
      ?.playbook?.trim();
    if (firstPlaybook) {
      this.threads.patch(threadId, { initialPlaybook: firstPlaybook, hasStarted: true });
    }
  }

  /** Local log first; falls back to server rehydration (reinstall / second device). */
  async getMessages(threadId: string): Promise<ChatMessage[]> {
    const local = await this.threads.readMessages(threadId);
    if (local.length > 0) {
      this.backfillInitialPlaybook(threadId, local);
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
        this.backfillInitialPlaybook(threadId, rehydrated);
      }
      return rehydrated;
    } catch {
      return [];
    }
  }

  private fromDto(dto: MessageDto): ChatMessage {
    const parsed = parseStoredContent(dto.content);
    const playbook =
      typeof dto.playbook === 'string' && dto.playbook.trim().length > 0
        ? dto.playbook.trim()
        : undefined;
    const playbookVersion =
      playbook !== undefined &&
      typeof dto.playbookVersion === 'number' &&
      Number.isInteger(dto.playbookVersion) &&
      dto.playbookVersion >= 1
        ? dto.playbookVersion
        : undefined;
    return {
      localId: dto.id,
      serverId: dto.id,
      role: dto.role,
      content: parsed.content,
      thinking: parsed.thinking,
      toolCalls: parsed.toolCalls,
      blocks: parsed.blocks,
      playbook,
      playbookVersion,
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
    if (this.agent.isBusy(thread.id)) {
      throw new Error('A turn is already running for this conversation.');
    }
    const sanitizedImages = validateAndSanitizeImages(request.images);
    this.startImageDescriptions(sanitizedImages);

    const isOrchestrator = Boolean(thread.orchestratorProfile);
    const wasStarted = isThreadStarted(thread);
    let storedPlaybook: string | undefined;
    if (
      !isOrchestrator &&
      !thread.initialPlaybook &&
      wasStarted &&
      !this.playbookBackfillChecked.has(thread.id)
    ) {
      this.playbookBackfillChecked.add(thread.id);
      const msgs = await this.threads.readMessages(thread.id);
      storedPlaybook = msgs
        .find((m) => m.role === 'user' && Boolean(m.playbook?.trim()))
        ?.playbook?.trim();
    }

    const lockedPlaybook = thread.initialPlaybook ?? storedPlaybook;
    const canSetPlaybook = !isOrchestrator && !lockedPlaybook;
    const sanitizedPrompt = request.promptName?.trim() || undefined;
    const effectivePlaybook = isOrchestrator
      ? undefined
      : (lockedPlaybook ?? (canSetPlaybook ? sanitizedPrompt : undefined));

    let effectiveThread = thread;
    const startPatch: Partial<ThreadMeta> = {};
    if (!thread.hasStarted) {
      startPatch.hasStarted = true;
    }
    if (!thread.initialPlaybook && effectivePlaybook) {
      startPatch.initialPlaybook = effectivePlaybook;
    }
    if (!lockedPlaybook && effectivePlaybook && wasStarted) {
      this.agent.closeThread(thread.id);
      startPatch.sessionId = undefined;
      startPatch.sessionProfile = undefined;
    }
    if (Object.keys(startPatch).length > 0) {
      const patched = this.threads.patch(thread.id, startPatch);
      if (patched) {
        effectiveThread = patched;
      }
    }

    await this.agent.sendMessage(effectiveThread, request.text, {
      thinkingOverride: request.thinkingOverride,
      playbook: effectivePlaybook,
      images: sanitizedImages,
    });
  }

  /**
   * Begin describing a message's attachments, to be awaited when the turn is persisted.
   *
   * Fire-and-forget on purpose: the turn must not wait on it, and `describeImages` already resolves
   * to the undescribed attachments on any failure. Skipped entirely when the setting is off, in
   * which case the sync payload carries the filename note alone.
   */
  private startImageDescriptions(images?: ImageAttachment[]): void {
    if (!images || images.length === 0) return;
    if (this.settings.get().imageDescriptionsEnabled === false) return;
    const described = describeImages(images, {
      sandboxDir: sandboxDirFor(this.deps.userDataDir),
    }).catch((err) => {
      logError('agent', `describeImages failed: ${err instanceof Error ? err.message : String(err)}`);
      return images;
    });
    this.pendingDescriptions.set(images, described);
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

  /**
   * Test both logins at once, coalescing concurrent callers onto one run.
   *
   * The latch is cleared with `.finally()` on the *assigned* promise rather than inside the async
   * body: a body that threw synchronously would run its own `finally` before the assignment
   * completed, leaving a permanently-rejected promise latched and the check dead until restart.
   */
  verifyAuth(): Promise<AuthVerificationResponse> {
    if (this.activeVerification) {
      return this.activeVerification;
    }

    const run = (async (): Promise<AuthVerificationResponse> => {
      const [server, claude] = await Promise.all([
        this.verifyServerLogin(),
        this.agent.verifyClaudeCredentials(
          sandboxDirFor(this.deps.userDataDir),
          this.settings.get().defaultModel,
        ),
      ]);
      return { server, claude };
    })();

    this.activeVerification = run;
    run.finally(() => {
      if (this.activeVerification === run) {
        this.activeVerification = null;
      }
    }).catch(() => {
      // The rejection is delivered to the real callers; this arm only guards the latch.
    });

    return run;
  }

  /**
   * The corporate half of `verifyAuth`. The token stays inside this method: what it returns is the
   * renderer-facing `LoginVerificationResult`, which has no field a bearer could occupy.
   */
  private async verifyServerLogin(): Promise<LoginVerificationResult> {
    // Nothing to test against, and no reason to make Entra mint a token for it.
    if (!this.settings.get().serverBaseUrl?.trim()) {
      return { status: 'unreachable', message: 'Server URL not configured' };
    }
    const tokenResult = await this.serverAuth.verifyToken();
    if (tokenResult.status !== 'ok') {
      const { status, message, account } = tokenResult;
      return { status, message, account };
    }
    const connResult = await this.syncClient.verifyConnection(tokenResult.token);
    if (connResult.status === 'ok' && tokenResult.account) {
      return { status: 'ok', account: tokenResult.account };
    }
    return connResult;
  }

  /**
   * Flushes in-flight turn persistence and drains ThreadStore writes.
   */
  async drain(threadId?: string): Promise<void> {
    if (threadId !== undefined) {
      await this.persistTails.get(threadId);
      await this.threads.drain(threadId);
      return;
    }
    while (this.persistTails.size > 0) {
      await Promise.all(Array.from(this.persistTails.values()));
    }
    await this.threads.drain();
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

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
  ThreadsListResult,
  ThreadSearchHit,
  ThinkingLevel,
  UsageTotals,
} from '../shared/types';
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  assertValidThreadId,
  controlPlaybookNames,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  isPlaybookValidationExcluded,
  isThreadStarted,
  isUserSelectablePlaybook,
  isValidThreadId,
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
import { ThreadStore, type StoredChatMessage } from './store/ThreadStore';
import { decodeQueuedMessagePayload, parseStoredContent } from './store/messageCodec';
import { SyncApiError, SyncClient, type ConversationDto, type MessageDto } from './sync/SyncClient';
import {
  SyncQueue,
  type HeldThreadResolution,
  type MissingConversationResolution,
  type QueuedTurn,
} from './sync/SyncQueue';
import {
  buildAllTurnsForRecreation,
  countUnqueuedLocalTurns,
  formatSyncedUserContent,
  reconcileWithRemote,
  reconstructOrphanThreadMeta,
  toNewMessagePayload,
} from './sync/reconcile';

export { formatSyncedUserContent };

const MAX_PENDING_RUNS = 50;
const RUN_TRACE_METADATA_TIMEOUT_MS = 5_000;
const RUN_RETRY_BASE_DELAY_MS = 5_000;
const RUN_RETRY_MAX_DELAY_MS = 60_000;
const MAX_RUN_RETRY_ATTEMPTS = 5;
const SCAN_CONCURRENCY = 12;

/** Minimum age before an untouched empty desktop conversation is eligible for startup sweep. */
export const EMPTY_THREAD_STALE_MS = 5 * 60 * 1000;

const PLACEHOLDER_TITLES = new Set(['new conversation', 'new chat', 'untitled']);

function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const trimmed = title.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_TITLES.has(trimmed.toLowerCase());
}

type ReconcileOutcome = 'ready' | 'recreated' | 'deferred' | 'pruned' | 'halt' | 'error';

interface DeferredRecoveryTrace {
  conversationId: string;
  profileName: string;
  userText: string;
  assistant: StoredChatMessage;
}

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
  appVersion?: string;
}

const MAX_APP_VERSION_LENGTH = 256;

function normalizeAppVersion(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_APP_VERSION_LENGTH) return undefined;
  return trimmed;
}

let cachedPackageAppVersion: string | undefined | null = null;
function readPackageAppVersion(): string | undefined {
  if (cachedPackageAppVersion !== null) return cachedPackageAppVersion;
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedPackageAppVersion =
      typeof parsed.version === 'string' ? normalizeAppVersion(parsed.version) : undefined;
  } catch {
    cachedPackageAppVersion = undefined;
  }
  return cachedPackageAppVersion;
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
  private promptsCache: { at: number; prompts: McpPromptInfo[] } | null = null;
  private promptsInFlight: Promise<McpPromptInfo[]> | null = null;
  /** Completed orchestrator runs awaiting their assistant message's server id (to link on POST). */
  private readonly pendingRuns = new Map<
    string,
    OrchestratorRunPayload | Promise<OrchestratorRunPayload | null>
  >();
  /** Resolved orchestrator runs whose POST failed transiently and will retry on next sync activity. */
  private readonly failedRuns: FailedOrchestratorRun[] = [];
  /** Recovered feedback ratings awaiting newly assigned server message IDs. */
  private readonly pendingFeedback = new Map<
    string,
    { conversationId: string; rating: 1 | -1; comment?: string }
  >();
  /** Recovered multi-agent turns awaiting newly assigned server message IDs (assembled lazily). */
  private readonly deferredRecoveryTraces = new Map<string, DeferredRecoveryTrace>();
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
  private readonly appVersion: string | undefined;

  private disposed = false;
  private localScanPromise: Promise<void> | null = null;
  private localScanCompleted = false;
  private readonly postListContinuations = new Set<Promise<void>>();
  private readonly initialIndexedIds: ReadonlySet<string>;
  private readonly newlyInsertedOrphans = new Set<string>();
  private readonly enrichedOrphans = new Set<string>();
  private readonly notifiedScanOrphans = new Set<string>();
  private readonly startupDirtyThreads = new Set<string>();
  private readonly sessionEnqueuedLocalIds = new Set<string>();
  private readonly lastAttemptedRemoteByThread = new Map<string, string>();
  private readonly threadsWithLocalMessages = new Set<string>();
  private readonly threadsWithUnsyncedMessages = new Set<string>();
  private readonly unqueuedStartupTurnsByThread = new Map<string, number>();
  private readonly verifiedOffPageThreads = new Set<string>();
  private readonly deletingOrDeletedThreads = new Set<string>();
  private readonly sessionTouchedThreads = new Set<string>();
  private readonly sweepSparedThreads = new Set<string>();
  private readonly sessionDroppedLocalIds = new Set<string>();
  private readonly deferredMissingRecreationThreads = new Set<string>();
  private readonly reconcileInFlight = new Map<string, Promise<ReconcileOutcome>>();
  private recoveryPromise: Promise<void> | null = null;
  private pendingRecoveryServerIds: ReadonlySet<string> | null = null;
  private flushHitBackoff = false;
  private emptySweepCompleted = false;
  private emptySweepPromise: Promise<void> | null = null;

  constructor(private readonly deps: AppCoreDeps) {
    this.appVersion =
      deps.appVersion !== undefined ? normalizeAppVersion(deps.appVersion) : readPackageAppVersion();
    this.settings = new SettingsStore(deps.userDataDir);
    // The allow-list and the bot-challenged-host list are maintained apart and can drift into a
    // combination that grants WebFetch nothing. That never surfaces at runtime — the calls just
    // deny, one turn at a time — so the effective grant is stated here where it can be read.
    for (const line of webAccessDiagnostics(this.settings.get())) log('web', line);
    const threadsDir = path.join(deps.userDataDir, 'threads');
    this.threads = new ThreadStore(threadsDir);
    this.initialIndexedIds = new Set(this.threads.list().map((t) => t.id));
    this.searchIndex = new SearchIndex(threadsDir, path.join(deps.userDataDir, 'search-index.json'));
    this.serverAuth = new ServerAuth(() => this.settings.get(), deps.tokenCache, deps.openBrowser);
    this.syncClient = new SyncClient({
      getBaseUrl: () => this.settings.get().serverBaseUrl,
      getToken: (force) => this.serverAuth.getAccessToken(force),
    });
    const syncQueueClient = {
      appendMessages: (
        threadId: string,
        messages: Parameters<SyncClient['appendMessages']>[1],
      ) => {
        const targetRemoteId = this.remoteIdFor(threadId);
        this.lastAttemptedRemoteByThread.set(threadId, targetRemoteId);
        return this.syncClient.appendMessages(targetRemoteId, messages);
      },
    } as SyncClient;
    this.syncQueue = new SyncQueue({
      client: syncQueueClient,
      file: path.join(deps.userDataDir, 'sync-queue.json'),
      emit: (event) => {
        if (event.kind === 'sync-state') {
          if (isValidThreadId(event.threadId)) {
            this.threads.setSyncState(event.threadId, event.state);
          }
          if (event.state === 'error' && !event.dropped) {
            this.flushHitBackoff = true;
          }
        }
        deps.emitSyncEvent(event);
      },
      onServerIds: (threadId, mapping) => this.handleServerIds(threadId, mapping),
      totalPendingCount: () => this.totalPendingSyncCount(),
      reconcileHeldThread: (threadId) => this.handleReconcileHeldThread(threadId),
      onMissingConversation: (threadId) => this.handleMissingOnAppend(threadId),
      onTurnDropped: (turn) => {
        for (const lid of turn.localIds) {
          this.sessionDroppedLocalIds.add(lid);
          this.pendingFeedback.delete(lid);
          this.deferredRecoveryTraces.delete(lid);
          this.pendingRuns.delete(lid);
        }
      },
    });

    // Purge any tombstoned or malformed thread IDs from sync-queue.json FIRST so deleted
    // conversations never hold SyncQueue, inflate pendingSyncCount, or probe the server.
    for (const qid of this.syncQueue.queuedThreadIds()) {
      if (!isValidThreadId(qid) || this.threads.isDeleted(qid)) {
        this.syncQueue.removeThread(qid);
      }
    }

    // Scoped startup hold & dirty set: strictly surviving startup SyncQueue threads and non-tombstoned .jsonl files.
    const { nonEmptyIds, allLogIds } = this.threads.inspectLogsSync();
    for (const id of nonEmptyIds) {
      this.threadsWithLocalMessages.add(id);
    }
    const startupHoldIds = new Set<string>();
    for (const qid of this.syncQueue.queuedThreadIds()) {
      if (isValidThreadId(qid)) {
        startupHoldIds.add(qid);
        if (this.syncQueue.pendingCount(qid) > 0) {
          this.startupDirtyThreads.add(qid);
        }
      }
    }
    for (const id of allLogIds) {
      startupHoldIds.add(id);
    }
    if (startupHoldIds.size > 0) {
      this.syncQueue.holdThreads(startupHoldIds);
    }

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
      emit: (event) => {
        deps.emitAgentEvent(event);
        if (event.kind === 'turn-complete' || event.kind === 'error') {
          const settledId = event.threadId;
          queueMicrotask(() => {
            void this.onAgentTurnSettled(settledId);
          });
        }
      },
      onSessionId: (threadId, sessionId, profile) => {
        if (isValidThreadId(threadId)) {
          this.threads.setSessionId(threadId, sessionId, profile);
        }
      },
      onTurnPersist: (threadId, userMessage, assistantMessage) =>
        this.persistTurn(threadId, userMessage, assistantMessage),
      sandboxDir: sandboxDirFor(deps.userDataDir),
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

  private remoteIdFor(threadId: string): string {
    const remoteId = this.threads.get(threadId)?.remoteConversationId;
    return typeof remoteId === 'string' && isValidThreadId(remoteId) ? remoteId : threadId;
  }

  private unqueuedStartupTurnsTotal(): number {
    let total = 0;
    for (const count of this.unqueuedStartupTurnsByThread.values()) {
      total += count;
    }
    return total;
  }

  totalPendingSyncCount(): number {
    return this.syncQueue.pendingCount() + this.unqueuedStartupTurnsTotal();
  }

  /** Wait for any in-flight startup scan, recovery, or once-per-launch empty sweep to settle. */
  async waitForStartupTasks(): Promise<void> {
    while (
      this.localScanPromise ||
      this.postListContinuations.size > 0 ||
      this.recoveryPromise ||
      this.emptySweepPromise
    ) {
      await Promise.all([
        this.localScanPromise ?? Promise.resolve(),
        Promise.all(Array.from(this.postListContinuations)),
        this.recoveryPromise ?? Promise.resolve(),
        this.emptySweepPromise ?? Promise.resolve(),
      ]);
    }
  }

  private async onAgentTurnSettled(threadId: string): Promise<void> {
    if (this.disposed || !isValidThreadId(threadId)) return;
    const tail = this.persistTails.get(threadId);
    if (tail) {
      await tail;
    }
    if (this.disposed || this.agent.isBusy(threadId)) return;

    if (this.deferredMissingRecreationThreads.has(threadId)) {
      const outcome = await this.reconcileSingleThread(threadId, { knownMissing: true });
      if (!this.disposed && outcome === 'recreated' && this.syncQueue.pendingCount() > 0) {
        await this.syncQueue.flush();
      }
      return;
    }

    if (this.syncQueue.pendingCount(threadId) > 0) {
      await this.syncQueue.flush();
    }
  }

  private ensureLocalThreadScan(): Promise<void> {
    if (this.localScanCompleted || this.disposed) {
      return Promise.resolve();
    }
    if (this.localScanPromise) {
      return this.localScanPromise;
    }

    const run = (async () => {
      const logIds = await this.threads.listLogThreadIds();
      if (this.disposed) return;

      const settings = this.settings.get();
      let cursor = 0;
      const workerCount = Math.min(SCAN_CONCURRENCY, Math.max(1, logIds.length));

      const worker = async (): Promise<void> => {
        while (!this.disposed) {
          const idx = cursor++;
          if (idx >= logIds.length) return;
          const id = logIds[idx];
          if (this.deletingOrDeletedThreads.has(id) || this.threads.isDeleted(id)) {
            continue;
          }
          const raw = await this.threads.readRawMessages(id);
          if (
            this.disposed ||
            this.deletingOrDeletedThreads.has(id) ||
            this.threads.isDeleted(id) ||
            raw.length === 0
          ) {
            continue;
          }
          this.threadsWithLocalMessages.add(id);

          const excluded = new Set<string>([
            ...this.sessionDroppedLocalIds,
            ...this.sessionEnqueuedLocalIds,
          ]);
          const queuedTurns = this.syncQueue.getQueuedTurns(id);
          const unqueuedTurns = countUnqueuedLocalTurns(raw, queuedTurns, excluded);
          const anyPreExistingUnsynced = raw.some((m) => !m.serverId && !excluded.has(m.localId));

          if (anyPreExistingUnsynced || unqueuedTurns > 0) {
            this.threadsWithUnsyncedMessages.add(id);
            this.startupDirtyThreads.add(id);
          }
          if (unqueuedTurns > 0) {
            this.unqueuedStartupTurnsByThread.set(id, unqueuedTurns);
          }

          const existing = this.threads.get(id);
          if (!existing) {
            const reconstructed = reconstructOrphanThreadMeta({
              threadId: id,
              messages: raw,
              defaultModel: settings.defaultModel,
              defaultThinkingLevel: settings.defaultThinkingLevel,
            });
            if (
              reconstructed &&
              !this.deletingOrDeletedThreads.has(id) &&
              !this.threads.isDeleted(id)
            ) {
              if (!anyPreExistingUnsynced && unqueuedTurns === 0 && this.syncQueue.pendingCount(id) === 0) {
                reconstructed.syncState = 'synced';
              }
              this.threads.upsert(reconstructed);
              this.newlyInsertedOrphans.add(id);
            }
          } else if (!this.initialIndexedIds.has(id)) {
            const reconstructed = reconstructOrphanThreadMeta({
              threadId: id,
              messages: raw,
              defaultModel: settings.defaultModel,
              defaultThinkingLevel: settings.defaultThinkingLevel,
            });
            if (
              reconstructed &&
              !this.deletingOrDeletedThreads.has(id) &&
              !this.threads.isDeleted(id)
            ) {
              const nextSyncState =
                anyPreExistingUnsynced || unqueuedTurns > 0 || this.syncQueue.pendingCount(id) > 0
                  ? 'pending'
                  : existing.syncState;
              this.threads.patch(id, {
                totals: reconstructed.totals,
                hasStarted: true,
                ...(existing.orchestratorProfile ||
                existing.initialPlaybook ||
                !reconstructed.initialPlaybook
                  ? {}
                  : { initialPlaybook: reconstructed.initialPlaybook }),
                syncState: nextSyncState,
              });
              this.enrichedOrphans.add(id);
            }
          } else if (anyPreExistingUnsynced || unqueuedTurns > 0) {
            this.threads.setSyncState(id, 'pending');
          }
        }
      };

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (!this.disposed) {
        this.localScanCompleted = true;
      }
    })();

    this.localScanPromise = run;
    run.finally(() => {
      if (this.localScanPromise === run) {
        this.localScanPromise = null;
      }
    });
    return run;
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
      const prompts = await this.mcpPrompts.list();
      this.promptsCache = { at: Date.now(), prompts };
      return prompts;
    } catch {
      return [];
    }
  }

  private listPromptsCached(): Promise<McpPromptInfo[]> {
    if (this.promptsCache && Date.now() - this.promptsCache.at < 60_000) {
      return Promise.resolve(this.promptsCache.prompts);
    }
    if (this.promptsInFlight) {
      return this.promptsInFlight;
    }
    const run = this.mcpPrompts
      .list()
      .then((prompts) => {
        this.promptsCache = { at: Date.now(), prompts };
        return prompts;
      })
      .finally(() => {
        if (this.promptsInFlight === run) {
          this.promptsInFlight = null;
        }
      });
    this.promptsInFlight = run;
    return run;
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
    if (!request || !isValidThreadId(request.threadId)) {
      return PASSES;
    }
    const threadId = request.threadId;
    this.sessionTouchedThreads.add(threadId);

    const settings = this.settings.get();
    if (settings.playbookValidationEnabled === false) return PASSES;

    const thread = this.threads.get(threadId);
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
    this.sessionTouchedThreads.add(threadId);
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
        if (this.persistTails.get(threadId) === next) {
          this.persistTails.delete(threadId);
          if (
            !this.disposed &&
            this.deferredMissingRecreationThreads.has(threadId) &&
            !this.agent.isBusy(threadId)
          ) {
            queueMicrotask(() => {
              void this.onAgentTurnSettled(threadId);
            });
          }
        }
      });
    this.persistTails.set(threadId, next);
  }

  /** The write itself: local log, search index, sync queue, orchestrator trace. */
  private writeTurn(threadId: string, userMessage: ChatMessage, assistantMessage: ChatMessage): void {
    const thread = this.threads.get(threadId);
    const isOrchestrator = !!thread?.orchestratorProfile;

    this.sessionEnqueuedLocalIds.add(userMessage.localId);
    this.sessionEnqueuedLocalIds.add(assistantMessage.localId);
    this.sessionTouchedThreads.add(threadId);
    this.threadsWithLocalMessages.add(threadId);
    this.threadsWithUnsyncedMessages.add(threadId);

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
        toNewMessagePayload(userMessage, isOrchestrator),
        toNewMessagePayload(assistantMessage, isOrchestrator),
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
      if (
        payload &&
        !this.disposed &&
        !this.sessionDroppedLocalIds.has(assistantMessage.localId) &&
        !this.deletingOrDeletedThreads.has(payload.conversationId)
      ) {
        this.pendingRuns.set(assistantMessage.localId, payload);
      } else {
        this.pendingRuns.delete(assistantMessage.localId);
      }
    }
  }

  private async assembleAndPostRecoveredTrace(
    deferredTrace: DeferredRecoveryTrace,
    serverId: string,
  ): Promise<void> {
    if (this.disposed) return;
    const orchestrator = this.settings.get().orchestrator ?? DEFAULT_ORCHESTRATOR_SETTINGS;
    try {
      const [profile, playbookVersions] = await Promise.all([
        withTimeout(
          this.resolveOrchestratorProfile(deferredTrace.profileName),
          RUN_TRACE_METADATA_TIMEOUT_MS,
          'resolveOrchestratorProfile',
        ).catch(() =>
          this.profilesCache?.profiles.find((p) => p.name === deferredTrace.profileName),
        ),
        withTimeout(
          this.listPromptsCached(),
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
          .catch(() => undefined),
      ]);
      if (this.disposed) return;

      const run = buildRunTrace({
        conversationId: deferredTrace.conversationId,
        userText: deferredTrace.userText,
        assistant: deferredTrace.assistant as ChatMessage,
        profileName: deferredTrace.profileName,
        profile,
        orchestrator,
        playbookVersions,
      });
      if (!run) return;
      run.messageId = serverId;
      this.postOrchestratorRun(run);
    } catch (err) {
      if (!this.disposed) {
        logError(
          'sync',
          `Failed to assemble recovered orchestrator run trace: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private registerRecoveredSideEffects(
    targetThreadId: string,
    meta: ThreadMeta | undefined,
    localMessages: readonly StoredChatMessage[],
    turnsToSync: readonly QueuedTurn[],
  ): void {
    if (turnsToSync.length === 0) return;
    const queuedLocalIds = new Set(turnsToSync.flatMap((t) => t.localIds));

    for (const msg of localMessages) {
      if (!queuedLocalIds.has(msg.localId)) continue;
      if (msg.feedback && (msg.feedback.rating === 1 || msg.feedback.rating === -1)) {
        this.pendingFeedback.set(msg.localId, {
          conversationId: targetThreadId,
          rating: msg.feedback.rating,
          comment: msg.feedback.comment,
        });
      }
    }

    const profileName = meta?.orchestratorProfile;
    if (!profileName) return;

    for (let i = 0; i < localMessages.length; i += 1) {
      const msg = localMessages[i];
      if (msg.role !== 'assistant' || !queuedLocalIds.has(msg.localId)) continue;
      if (this.pendingRuns.has(msg.localId)) continue;
      // Strict local-delegation guard: never fabricate empty 0-step traces for single-agent or
      // MessageDto-rehydrated turns that lack real local Agent delegations.
      if (!Array.isArray(msg.toolCalls) || !msg.toolCalls.some((tc) => tc.name === 'Agent')) {
        continue;
      }
      const prev = i > 0 && localMessages[i - 1].role === 'user' ? localMessages[i - 1] : undefined;
      this.deferredRecoveryTraces.set(msg.localId, {
        conversationId: targetThreadId,
        profileName,
        userText: prev?.content ?? '',
        assistant: msg,
      });
    }
  }

  private pruneThreadSideEffects(threadId: string): void {
    for (const [lid, fb] of this.pendingFeedback.entries()) {
      if (fb.conversationId === threadId) {
        this.pendingFeedback.delete(lid);
      }
    }
    for (const [lid, trace] of this.deferredRecoveryTraces.entries()) {
      if (trace.conversationId === threadId) {
        this.deferredRecoveryTraces.delete(lid);
      }
    }
    for (const [lid, entry] of this.pendingRuns.entries()) {
      if (entry instanceof Promise) {
        const filtered = entry.then((r) => {
          if (!r || r.conversationId === threadId) {
            if (this.pendingRuns.get(lid) === filtered) {
              this.pendingRuns.delete(lid);
            }
            return null;
          }
          if (this.pendingRuns.get(lid) === filtered) {
            this.pendingRuns.set(lid, r);
          }
          return r;
        });
        this.pendingRuns.set(lid, filtered);
      } else if (entry.conversationId === threadId) {
        this.pendingRuns.delete(lid);
      }
    }
    for (let i = this.failedRuns.length - 1; i >= 0; i -= 1) {
      if (this.failedRuns[i].run.conversationId === threadId) {
        this.failedRuns.splice(i, 1);
      }
    }
  }

  /** Persist localId→serverId mapping, then POST any pending feedback & run traces now that we can link them. */
  private handleServerIds(threadId: string, mapping: Record<string, string>): void {
    if (isValidThreadId(threadId)) {
      void this.threads
        .applyServerIds(threadId, mapping)
        .then(({ hasUnsynced }) => {
          if (!hasUnsynced && this.syncQueue.pendingCount(threadId) === 0) {
            this.threadsWithUnsyncedMessages.delete(threadId);
          }
        })
        .catch((err) => logError('store', `applyServerIds failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    this.drainFailedRuns();
    for (const [localId, serverId] of Object.entries(mapping)) {
      const fb = this.pendingFeedback.get(localId);
      if (fb) {
        this.pendingFeedback.delete(localId);
        if (!this.disposed) {
          void this.syncClient
            .submitFeedback(serverId, fb.rating, fb.comment)
            .catch((err) =>
              logError(
                'sync',
                `Failed to replay feedback on ${serverId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
      }

      const entry = this.pendingRuns.get(localId);
      if (entry) {
        this.pendingRuns.delete(localId);
        if (entry instanceof Promise) {
          void entry.then((run) => {
            if (!run || this.disposed) return;
            run.messageId = serverId;
            this.postOrchestratorRun(run);
          });
        } else if (!this.disposed) {
          entry.messageId = serverId;
          this.postOrchestratorRun(entry);
        }
        continue;
      }

      const deferredTrace = this.deferredRecoveryTraces.get(localId);
      if (deferredTrace) {
        this.deferredRecoveryTraces.delete(localId);
        if (!this.disposed) {
          void this.assembleAndPostRecoveredTrace(deferredTrace, serverId);
        }
      }
    }
  }

  private drainFailedRuns(): void {
    if (this.disposed || this.failedRuns.length === 0) return;
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
    if (this.disposed) return;
    const outboundRun: OrchestratorRunPayload = {
      ...run,
      conversationId: isValidThreadId(run.conversationId)
        ? this.remoteIdFor(run.conversationId)
        : run.conversationId,
    };
    void this.syncClient
      .recordOrchestratorRun(outboundRun)
      .then((res) =>
        log(
          'sync',
          `Recorded orchestrator run ${res.id} (${outboundRun.steps.length} steps) → message ${outboundRun.messageId ?? 'unknown'}`,
        ),
      )
      .catch((err) => {
        if (this.disposed) return;
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

  /**
   * Builds settings for recreating a missing (404) conversation. Preserves valid original
   * `desktopVersion` if present on `remoteSettings`, and NEVER stamps `this.appVersion` onto
   * legacy unversioned conversations.
   */
  private buildRecreationSettings(thread: ThreadMeta): Record<string, unknown> {
    const baseRemote: Record<string, unknown> = { ...(thread.remoteSettings ?? {}) };
    if ('desktopVersion' in baseRemote) {
      const validVersion =
        typeof baseRemote.desktopVersion === 'string'
          ? normalizeAppVersion(baseRemote.desktopVersion)
          : undefined;
      if (validVersion !== undefined) {
        baseRemote.desktopVersion = validVersion;
      } else {
        delete baseRemote.desktopVersion;
      }
    }
    return {
      ...baseRemote,
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      'thinking-level': thread.thinkingLevel,
      'orchestrator-profile': thread.orchestratorProfile ?? '',
      client: 'desktop',
    };
  }

  private async handleReconcileHeldThread(threadId: string): Promise<HeldThreadResolution> {
    await this.ensureLocalThreadScan();
    if (this.disposed) return 'deferred';
    const outcome = await this.reconcileSingleThread(threadId);
    if (outcome === 'ready' || outcome === 'recreated' || outcome === 'pruned') {
      return 'ready';
    }
    return 'deferred';
  }

  private async handleMissingOnAppend(threadId: string): Promise<MissingConversationResolution> {
    const attemptedRemoteId = this.lastAttemptedRemoteByThread.get(threadId);
    if (attemptedRemoteId && this.remoteIdFor(threadId) !== attemptedRemoteId) {
      return 'recreated';
    }
    await this.ensureLocalThreadScan();
    if (this.disposed) return 'deferred';
    if (attemptedRemoteId && this.remoteIdFor(threadId) !== attemptedRemoteId) {
      return 'recreated';
    }
    const outcome = await this.reconcileSingleThread(threadId, { knownMissing: true });
    if (outcome === 'recreated') return 'recreated';
    if (outcome === 'pruned') return 'drop';
    if (outcome === 'deferred') return 'deferred';
    return 'retry';
  }

  private reconcileSingleThread(
    threadId: string,
    opts?: { knownMissing?: boolean; serverListed?: boolean },
  ): Promise<ReconcileOutcome> {
    if (!isValidThreadId(threadId)) {
      return Promise.resolve('pruned');
    }
    const existing = this.reconcileInFlight.get(threadId);
    if (existing) {
      return existing;
    }

    const run = this.doReconcileSingleThread(threadId, opts).finally(() => {
      if (this.reconcileInFlight.get(threadId) === run) {
        this.reconcileInFlight.delete(threadId);
      }
    });
    this.reconcileInFlight.set(threadId, run);
    return run;
  }

  private async doReconcileSingleThread(
    threadId: string,
    opts?: { knownMissing?: boolean; serverListed?: boolean },
  ): Promise<ReconcileOutcome> {
    if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
      this.startupDirtyThreads.delete(threadId);
      return 'pruned';
    }

    const remoteId = this.remoteIdFor(threadId);
    let isMissingOnServer = Boolean(opts?.knownMissing);
    let remoteResult: { messages: MessageDto[]; truncated: boolean } | undefined;

    if (!isMissingOnServer && !opts?.serverListed && !this.startupDirtyThreads.has(threadId)) {
      try {
        await this.syncClient.getMessages(remoteId, 1, 0);
        if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
          this.startupDirtyThreads.delete(threadId);
          return 'pruned';
        }
        this.syncQueue.unholdThread(threadId);
        this.verifiedOffPageThreads.add(threadId);
        return 'ready';
      } catch (err) {
        if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
          this.startupDirtyThreads.delete(threadId);
          return 'pruned';
        }
        if (err instanceof SyncApiError && err.status === 404) {
          isMissingOnServer = true;
        } else if (err instanceof SyncApiError && err.status === 401) {
          return 'halt';
        } else if (err instanceof SyncApiError) {
          logError(
            'sync',
            `lightweight off-page probe failed for ${threadId} (HTTP ${err.status}): ${err.message}`,
          );
          return 'error';
        } else {
          logError(
            'sync',
            `lightweight off-page probe halted on ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return 'halt';
        }
      }
    }

    if (!isMissingOnServer) {
      try {
        remoteResult = await this.syncClient.getAllMessages(remoteId);
      } catch (err) {
        if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
          this.startupDirtyThreads.delete(threadId);
          return 'pruned';
        }
        if (err instanceof SyncApiError && err.status === 404) {
          isMissingOnServer = true;
        } else if (err instanceof SyncApiError && err.status === 401) {
          return 'halt';
        } else if (err instanceof SyncApiError) {
          logError(
            'sync',
            `reconcile probe failed for ${threadId} (HTTP ${err.status}): ${err.message}`,
          );
          return 'error';
        } else {
          logError(
            'sync',
            `reconcile probe halted on ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return 'halt';
        }
      }
    }

    if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
      this.startupDirtyThreads.delete(threadId);
      return 'pruned';
    }

    // --- 200 OK: conversation exists on server -------------------------------
    if (!isMissingOnServer && remoteResult) {
      if (!opts?.serverListed) {
        this.verifiedOffPageThreads.add(threadId);
      }
      const localMessages = await this.threads.readRawMessages(threadId);
      if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
        this.startupDirtyThreads.delete(threadId);
        return 'pruned';
      }
      if (localMessages.length > 0) {
        this.threadsWithLocalMessages.add(threadId);
      }

      const existingMeta = this.threads.get(threadId);
      const isOrchestrator = Boolean(existingMeta?.orchestratorProfile);
      const queuedTurns = this.syncQueue.getQueuedTurns(threadId);
      const inspectedLocalIds = new Set<string>([
        ...localMessages.map((m) => m.localId),
        ...queuedTurns.flatMap((t) => t.localIds),
      ]);
      const hadPendingBefore =
        (this.unqueuedStartupTurnsByThread.get(threadId) ?? 0) > 0 ||
        queuedTurns.length > 0 ||
        existingMeta?.syncState === 'pending';

      const reconciled = reconcileWithRemote({
        threadId,
        localMessages,
        queuedTurns,
        remoteMessages: remoteResult.messages,
        isOrchestrator,
        truncated: remoteResult.truncated,
        droppedLocalIds: this.sessionDroppedLocalIds,
      });

      if (Object.keys(reconciled.adoptedServerIds).length > 0) {
        await this.threads.applyServerIds(threadId, reconciled.adoptedServerIds);
        if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
          this.startupDirtyThreads.delete(threadId);
          return 'pruned';
        }
        if (!this.disposed) {
          this.deps.emitSyncEvent({
            kind: 'server-ids',
            threadId,
            mapping: reconciled.adoptedServerIds,
          });
        }
      }

      this.registerRecoveredSideEffects(
        threadId,
        existingMeta,
        localMessages,
        reconciled.turnsToQueue,
      );

      this.unqueuedStartupTurnsByThread.delete(threadId);
      this.startupDirtyThreads.delete(threadId);
      this.syncQueue.reconcileThreadTurns(threadId, reconciled.turnsToQueue, inspectedLocalIds, {
        resetAttempts: false,
      });
      this.syncQueue.unholdThread(threadId);

      if (this.syncQueue.pendingCount(threadId) > 0) {
        this.threadsWithUnsyncedMessages.add(threadId);
        this.threads.setSyncState(threadId, 'pending');
      } else {
        this.threadsWithUnsyncedMessages.delete(threadId);
        this.threads.setSyncState(threadId, 'synced');
        if (hadPendingBefore && !this.disposed) {
          this.deps.emitSyncEvent({
            kind: 'sync-state',
            threadId,
            state: 'synced',
            pendingCount: this.totalPendingSyncCount(),
          });
        }
      }

      if (reconciled.skippedMidThreadTurns > 0) {
        log(
          'sync',
          `Skipped ${reconciled.skippedMidThreadTurns} stranded mid-thread turn(s) on ${threadId}`,
        );
      }
      return 'ready';
    }

    // --- 404 Not Found: conversation missing on server -----------------------
    if (this.agent.isBusy(threadId) || this.persistTails.has(threadId)) {
      this.deferredMissingRecreationThreads.add(threadId);
      return 'deferred';
    }

    const localMessages = await this.threads.readRawMessages(threadId);
    if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
      this.startupDirtyThreads.delete(threadId);
      return 'pruned';
    }
    if (this.agent.isBusy(threadId) || this.persistTails.has(threadId)) {
      this.deferredMissingRecreationThreads.add(threadId);
      return 'deferred';
    }

    const queuedTurns = this.syncQueue.getQueuedTurns(threadId);
    const inspectedLocalIds = new Set<string>([
      ...localMessages.map((m) => m.localId),
      ...queuedTurns.flatMap((t) => t.localIds),
    ]);
    if (localMessages.length === 0 && queuedTurns.length === 0) {
      this.deferredMissingRecreationThreads.delete(threadId);
      this.unqueuedStartupTurnsByThread.delete(threadId);
      this.startupDirtyThreads.delete(threadId);
      this.lastAttemptedRemoteByThread.delete(threadId);
      this.threadsWithLocalMessages.delete(threadId);
      this.threadsWithUnsyncedMessages.delete(threadId);
      this.verifiedOffPageThreads.delete(threadId);
      this.sweepSparedThreads.delete(threadId);
      this.playbookBackfillChecked.delete(threadId);
      this.pruneThreadSideEffects(threadId);
      this.syncQueue.removeThread(threadId);
      void this.threads.delete(threadId);
      this.searchIndex.remove(threadId);
      if (!this.disposed) {
        this.deps.emitSyncEvent({ kind: 'thread-deleted', threadId });
      }
      return 'pruned';
    }

    const existingMeta = this.threads.get(threadId);
    const localIdSet = new Set(localMessages.map((m) => m.localId));
    const extraMessages: StoredChatMessage[] = [];
    for (const qt of queuedTurns) {
      const fallbackCreatedAt =
        qt.enqueuedAt || existingMeta?.updatedAt || existingMeta?.createdAt || new Date().toISOString();
      for (let idx = 0; idx < qt.messages.length; idx += 1) {
        const lid = qt.localIds[idx] || randomUUID();
        if (localIdSet.has(lid)) continue;
        localIdSet.add(lid);
        extraMessages.push(decodeQueuedMessagePayload(qt.messages[idx], lid, fallbackCreatedAt));
      }
    }

    const defaults = this.settings.get();
    const reconstructedOrphan = !existingMeta
      ? reconstructOrphanThreadMeta({
          threadId,
          messages: [...localMessages, ...extraMessages],
          defaultModel: defaults.defaultModel,
          defaultThinkingLevel: defaults.defaultThinkingLevel,
        })
      : undefined;
    const oldMeta: ThreadMeta =
      existingMeta ??
      reconstructedOrphan ?? {
        id: threadId,
        title: 'New Conversation',
        model: defaults.defaultModel,
        thinkingLevel: defaults.defaultThinkingLevel,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'pending',
        hasStarted: true,
      };

    const createTitle = isPlaceholderTitle(oldMeta.title) ? null : oldMeta.title.trim();
    const recreationSettings = this.buildRecreationSettings(oldMeta);

    let createdConv: ConversationDto;
    try {
      createdConv = await this.syncClient.createConversation(createTitle, recreationSettings);
    } catch (err) {
      if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
        this.startupDirtyThreads.delete(threadId);
        return 'pruned';
      }
      if (err instanceof SyncApiError && err.status === 401) {
        return 'halt';
      }
      logError(
        'sync',
        `Failed to recreate missing conversation ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return err instanceof SyncApiError ? 'error' : 'halt';
    }

    if (this.disposed || this.deletingOrDeletedThreads.has(threadId) || this.threads.isDeleted(threadId)) {
      void this.syncClient.deleteConversation(createdConv.id).catch(() => undefined);
      this.startupDirtyThreads.delete(threadId);
      return 'pruned';
    }
    if (this.agent.isBusy(threadId) || this.persistTails.has(threadId)) {
      void this.syncClient.deleteConversation(createdConv.id).catch(() => undefined);
      this.deferredMissingRecreationThreads.add(threadId);
      return 'deferred';
    }

    const isOrchestrator = Boolean(oldMeta.orchestratorProfile);
    const replacementTurns = buildAllTurnsForRecreation({
      threadId,
      localMessages,
      queuedTurns,
      isOrchestrator,
    });

    const newRemoteSettings: Record<string, unknown> = createdConv.settings
      ? { ...recreationSettings, ...createdConv.settings }
      : { ...recreationSettings };
    if (!('desktopVersion' in recreationSettings)) {
      delete newRemoteSettings.desktopVersion;
    }

    const metaPatch: Partial<Omit<ThreadMeta, 'id'>> = {
      remoteConversationId: createdConv.id,
      title: isPlaceholderTitle(oldMeta.title) ? (createdConv.title || oldMeta.title) : oldMeta.title,
      syncState: replacementTurns.length > 0 ? 'pending' : 'synced',
      remoteSettings: newRemoteSettings,
    };

    let updatedMeta: ThreadMeta;
    try {
      updatedMeta = await this.threads.prepareForRecreation(
        threadId,
        oldMeta,
        metaPatch,
        extraMessages,
      );
      if (extraMessages.length > 0) {
        this.searchIndex.addMessages(threadId, extraMessages as ChatMessage[]);
      }

      this.syncQueue.reconcileThreadTurns(threadId, replacementTurns, inspectedLocalIds, {
        resetAttempts: true,
      });

      const hasPendingAfter = this.syncQueue.pendingCount(threadId) > 0;
      if (hasPendingAfter) {
        this.threads.setSyncState(threadId, 'pending');
        updatedMeta = this.threads.get(threadId) ?? { ...updatedMeta, syncState: 'pending' };
      }

      for (let i = this.failedRuns.length - 1; i >= 0; i -= 1) {
        if (this.failedRuns[i].run.conversationId === threadId) {
          this.failedRuns.splice(i, 1);
        }
      }

      this.registerRecoveredSideEffects(
        threadId,
        updatedMeta,
        [...localMessages, ...extraMessages],
        replacementTurns,
      );

      this.deferredMissingRecreationThreads.delete(threadId);
      this.unqueuedStartupTurnsByThread.delete(threadId);
      this.startupDirtyThreads.delete(threadId);
      if (!opts?.serverListed) {
        this.verifiedOffPageThreads.add(threadId);
      } else {
        this.verifiedOffPageThreads.delete(threadId);
      }
      this.sweepSparedThreads.delete(threadId);
      if (localMessages.length > 0 || extraMessages.length > 0) {
        this.threadsWithLocalMessages.add(threadId);
      }
      if (hasPendingAfter) {
        this.threadsWithUnsyncedMessages.add(threadId);
      } else {
        this.threadsWithUnsyncedMessages.delete(threadId);
      }
      this.syncQueue.unholdThread(threadId);
    } catch (commitErr) {
      logError(
        'sync',
        `Local commit failed after recreating ${threadId} -> ${createdConv.id}: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
      );
      await this.syncClient.deleteConversation(createdConv.id).catch(() => undefined);
      return 'error';
    }

    if (!this.disposed) {
      this.notifiedScanOrphans.add(threadId);
      this.deps.emitSyncEvent({ kind: 'thread-recreated', thread: updatedMeta });
    }
    return 'recreated';
  }

  private triggerStartupRecovery(serverIds: ReadonlySet<string>): void {
    if (this.disposed) return;
    this.pendingRecoveryServerIds = serverIds;
    if (this.recoveryPromise) return;

    const run = (async () => {
      while (!this.disposed && this.pendingRecoveryServerIds !== null) {
        const currentServerIds = this.pendingRecoveryServerIds;
        this.pendingRecoveryServerIds = null;
        await this.runStartupRecoveryPass(currentServerIds);
      }
    })();

    this.recoveryPromise = run;
    run
      .catch((err) => {
        if (!this.disposed) {
          logError(
            'sync',
            `startup recovery failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })
      .finally(() => {
        if (this.recoveryPromise === run) {
          this.recoveryPromise = null;
        }
      });
  }

  private async runStartupRecoveryPass(serverIds: ReadonlySet<string>): Promise<void> {
    const candidateIds: string[] = [];
    const seen = new Set<string>();

    for (const local of this.threads.list()) {
      seen.add(local.id);
      if (this.deletingOrDeletedThreads.has(local.id) || this.threads.isDeleted(local.id)) {
        continue;
      }
      if (serverIds.has(local.id)) {
        if (this.startupDirtyThreads.has(local.id) || this.syncQueue.isHeld(local.id)) {
          candidateIds.push(local.id);
        }
      } else if (
        !this.verifiedOffPageThreads.has(local.id) &&
        (this.threadsWithLocalMessages.has(local.id) ||
          this.syncQueue.pendingCount(local.id) > 0 ||
          this.startupDirtyThreads.has(local.id) ||
          Boolean(local.hasStarted))
      ) {
        candidateIds.push(local.id);
      }
    }

    for (const qid of this.syncQueue.queuedThreadIds()) {
      if (seen.has(qid) || !isValidThreadId(qid)) continue;
      if (this.deletingOrDeletedThreads.has(qid) || this.threads.isDeleted(qid)) continue;
      candidateIds.push(qid);
    }

    let halted = false;
    for (const id of candidateIds) {
      if (this.disposed) {
        halted = true;
        break;
      }
      let outcome: ReconcileOutcome;
      try {
        outcome = await this.reconcileSingleThread(id, { serverListed: serverIds.has(id) });
      } catch (err) {
        if (this.disposed) {
          halted = true;
          break;
        }
        logError(
          'sync',
          `Unexpected startup recovery error on ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (this.disposed || outcome === 'halt') {
        halted = true;
        break;
      }
      if (outcome === 'recreated' && this.syncQueue.pendingCount() > 0) {
        this.flushHitBackoff = false;
        await this.syncQueue.flush();
        await this.threads.drain();
        if (this.disposed || this.flushHitBackoff) {
          halted = true;
          break;
        }
      }
    }

    if (!this.disposed && !halted && candidateIds.length > 0 && this.syncQueue.pendingCount() > 0) {
      this.flushHitBackoff = false;
      await this.syncQueue.flush();
      await this.threads.drain();
    }
  }

  private collectEmptySweepCandidates(
    conversations: readonly ConversationDto[],
    preFetchDesktopIds: ReadonlySet<string>,
    nonEmptyIds: ReadonlySet<string>,
  ): string[] {
    const now = Date.now();
    const serverByLocalId = new Map<string, ConversationDto>();
    for (const c of conversations) {
      if (isValidThreadId(c.id)) {
        const localId = this.threads.findByRemoteId(c.id)?.id ?? c.id;
        serverByLocalId.set(localId, c);
      }
    }

    const unionIds = new Set<string>(serverByLocalId.keys());
    for (const local of this.threads.list()) {
      unionIds.add(local.id);
    }

    const candidates: string[] = [];
    for (const id of unionIds) {
      if (nonEmptyIds.has(id)) continue;
      const srv = serverByLocalId.get(id);
      const local = this.threads.get(id);

      const explicitSrvClient = srv?.settings?.client;
      if (
        typeof explicitSrvClient === 'string' &&
        explicitSrvClient.length > 0 &&
        explicitSrvClient !== 'desktop'
      ) {
        continue;
      }
      const isDesktop =
        explicitSrvClient === 'desktop' ||
        local?.remoteSettings?.client === 'desktop' ||
        preFetchDesktopIds.has(id);
      if (!isDesktop) continue;

      if (srv && !isPlaceholderTitle(srv.title)) continue;
      if (local && !isPlaceholderTitle(local.title)) continue;
      if (local && isThreadStarted(local)) continue;

      const tsCandidates = [srv?.updatedAt, srv?.createdAt, local?.updatedAt, local?.createdAt]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => Date.parse(v))
        .filter((ms) => Number.isFinite(ms));

      if (tsCandidates.length === 0) continue;
      const latestMs = Math.max(...tsCandidates);
      if (now - latestMs < EMPTY_THREAD_STALE_MS) continue;

      if (!this.isStillEligibleForEmptySweep(id)) continue;
      candidates.push(id);
    }
    return candidates;
  }

  private isStillEligibleForEmptySweep(
    id: string,
    opts?: { ignoreDeleting?: boolean },
  ): boolean {
    if (this.disposed) return false;
    if (this.sessionTouchedThreads.has(id) || this.threads.isDeleted(id)) {
      return false;
    }
    if (!opts?.ignoreDeleting && this.deletingOrDeletedThreads.has(id)) {
      return false;
    }
    if (
      this.threadsWithLocalMessages.has(id) ||
      (this.unqueuedStartupTurnsByThread.get(id) ?? 0) > 0 ||
      this.syncQueue.pendingCount(id) > 0
    ) {
      return false;
    }
    if (this.agent.isBusy(id) || this.persistTails.has(id) || this.reconcileInFlight.has(id)) {
      return false;
    }
    const local = this.threads.get(id);
    if (local && (!isPlaceholderTitle(local.title) || isThreadStarted(local))) {
      return false;
    }
    return true;
  }

  private triggerEmptyConversationSweep(candidateIds: readonly string[]): void {
    if (this.disposed || candidateIds.length === 0) return;

    const run = (async () => {
      for (const id of candidateIds) {
        if (this.disposed) break;
        if (!this.isStillEligibleForEmptySweep(id)) continue;

        const remoteId = this.remoteIdFor(id);
        let serverAlreadyGone = false;
        try {
          const msgs = await this.syncClient.getMessages(remoteId, 1, 0);
          if (this.disposed) break;
          if (msgs.length > 0) {
            continue;
          }
        } catch (err) {
          if (this.disposed) break;
          if (err instanceof SyncApiError && err.status === 404) {
            serverAlreadyGone = true;
          } else {
            continue;
          }
        }

        if (!this.isStillEligibleForEmptySweep(id)) {
          if (serverAlreadyGone) {
            this.sweepSparedThreads.add(id);
          }
          continue;
        }

        const currentRemoteId = this.remoteIdFor(id);
        if (!serverAlreadyGone) {
          this.deletingOrDeletedThreads.add(id);
          this.deletingOrDeletedThreads.add(currentRemoteId);
          try {
            await this.syncClient.deleteConversation(currentRemoteId);
          } catch (err) {
            if (!(err instanceof SyncApiError && err.status === 404)) {
              this.deletingOrDeletedThreads.delete(id);
              if (currentRemoteId !== id) {
                this.deletingOrDeletedThreads.delete(currentRemoteId);
              }
              continue;
            }
          }
          if (!this.isStillEligibleForEmptySweep(id, { ignoreDeleting: true })) {
            this.deletingOrDeletedThreads.delete(id);
            if (currentRemoteId !== id) {
              this.deletingOrDeletedThreads.delete(currentRemoteId);
            }
            this.sweepSparedThreads.add(id);
            continue;
          }
        } else {
          this.deletingOrDeletedThreads.add(id);
          this.deletingOrDeletedThreads.add(currentRemoteId);
        }

        this.sweepSparedThreads.delete(id);
        this.pruneThreadSideEffects(id);
        this.syncQueue.removeThread(id);
        this.unqueuedStartupTurnsByThread.delete(id);
        this.startupDirtyThreads.delete(id);
        this.lastAttemptedRemoteByThread.delete(id);
        this.playbookBackfillChecked.delete(id);
        void this.threads.delete(id);
        this.searchIndex.remove(id);
        if (!this.disposed) {
          this.deps.emitSyncEvent({ kind: 'thread-deleted', threadId: id });
        }
      }
    })();

    this.emptySweepPromise = run;
    run
      .catch(() => {
        // Silent fail-open by design.
      })
      .finally(() => {
        if (this.emptySweepPromise === run) {
          this.emptySweepPromise = null;
        }
      });
  }

  // --- threads ---------------------------------------------------------------

  async listThreads(): Promise<ThreadsListResult> {
    const scanPromise = this.ensureLocalThreadScan();
    const remotePromise = this.syncClient.listConversations();

    const initialList = this.threads.list();
    const preFetchLocalIds = new Set(initialList.map((t) => t.id));
    const preFetchDesktopIds = new Set(
      initialList
        .filter((t) => t.remoteSettings?.client === 'desktop')
        .map((t) => t.id),
    );

    try {
      const conversations = await remotePromise;
      this.drainFailedRuns();

      const { nonEmptyIds } = this.threads.inspectLogsSync();
      for (const id of nonEmptyIds) {
        this.threadsWithLocalMessages.add(id);
      }

      const serverMatchedLocalIds = new Set<string>();
      for (const c of conversations) {
        if (!isValidThreadId(c.id)) continue;
        if (this.deletingOrDeletedThreads.has(c.id) || this.threads.isDeleted(c.id)) {
          continue;
        }
        const existing = this.threads.findByRemoteId(c.id);
        const localId = existing?.id ?? c.id;
        if (this.deletingOrDeletedThreads.has(localId) || this.threads.isDeleted(localId)) {
          continue;
        }

        serverMatchedLocalIds.add(localId);
        this.verifiedOffPageThreads.delete(localId);
        this.sweepSparedThreads.delete(localId);

        const settings = this.settings.get();
        const rawRemoteProfile = c.settings?.['orchestrator-profile'];
        const remoteProfile =
          typeof rawRemoteProfile === 'string' && rawRemoteProfile.trim().length > 0
            ? rawRemoteProfile.trim()
            : undefined;
        const isStarted = existing ? isThreadStarted(existing) : false;
        const isBusy = existing ? this.agent.isBusy(localId) : false;
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
          this.agent.closeThread(localId);
        }
        const remoteSettings = c.settings
          ? { ...c.settings }
          : existing?.remoteSettings;
        const upserted: ThreadMeta = {
          id: localId,
          ...(localId !== c.id ? { remoteConversationId: c.id } : {}),
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

      let sweepCandidates: string[] = [];
      const sweepCandidateSet = new Set<string>();
      if (!this.emptySweepCompleted && !this.disposed) {
        this.emptySweepCompleted = true;
        sweepCandidates = this.collectEmptySweepCandidates(
          conversations,
          preFetchDesktopIds,
          nonEmptyIds,
        );
        for (const id of sweepCandidates) {
          sweepCandidateSet.add(id);
        }
      }

      // Prune ONLY unopened header-only #201+ entries absent from serverMatchedLocalIds (never local transcripts!).
      for (const local of this.threads.list()) {
        if (
          !serverMatchedLocalIds.has(local.id) &&
          preFetchLocalIds.has(local.id) &&
          !this.sessionTouchedThreads.has(local.id) &&
          !sweepCandidateSet.has(local.id) &&
          !this.sweepSparedThreads.has(local.id) &&
          !nonEmptyIds.has(local.id) &&
          !this.threadsWithLocalMessages.has(local.id) &&
          this.syncQueue.pendingCount(local.id) === 0 &&
          !this.agent.isBusy(local.id) &&
          !this.persistTails.has(local.id) &&
          !this.reconcileInFlight.has(local.id) &&
          !local.hasStarted
        ) {
          this.syncQueue.removeThread(local.id);
          void this.threads.delete(local.id);
          this.playbookBackfillChecked.delete(local.id);
          this.searchIndex.remove(local.id);
        }
      }

      const pendingAtReturn = this.totalPendingSyncCount();
      const threads = this.threads
        .list()
        .filter((t) => !this.deletingOrDeletedThreads.has(t.id) && !this.threads.isDeleted(t.id));

      const continuation = scanPromise
        .then(() => {
          if (this.disposed) return;

          for (const localId of serverMatchedLocalIds) {
            if (
              !this.deletingOrDeletedThreads.has(localId) &&
              !this.threads.isDeleted(localId) &&
              !this.startupDirtyThreads.has(localId) &&
              this.syncQueue.pendingCount(localId) === 0
            ) {
              this.syncQueue.unholdThread(localId);
              this.unqueuedStartupTurnsByThread.delete(localId);
            }
          }

          for (const orphanId of [...this.newlyInsertedOrphans, ...this.enrichedOrphans]) {
            if (
              this.notifiedScanOrphans.has(orphanId) ||
              this.deletingOrDeletedThreads.has(orphanId) ||
              this.threads.isDeleted(orphanId)
            ) {
              continue;
            }
            const currentMeta = this.threads.get(orphanId);
            if (!currentMeta) continue;
            this.notifiedScanOrphans.add(orphanId);
            this.deps.emitSyncEvent({ kind: 'thread-recreated', thread: currentMeta });
          }

          const pendingAfterScan = this.totalPendingSyncCount();
          if (pendingAfterScan !== pendingAtReturn) {
            const dirtyId =
              Array.from(this.unqueuedStartupTurnsByThread.keys())[0] ??
              Array.from(this.startupDirtyThreads)[0];
            if (
              dirtyId &&
              !this.deletingOrDeletedThreads.has(dirtyId) &&
              !this.threads.isDeleted(dirtyId)
            ) {
              this.deps.emitSyncEvent({
                kind: 'sync-state',
                threadId: dirtyId,
                state: 'pending',
                pendingCount: pendingAfterScan,
              });
            }
          }

          this.triggerStartupRecovery(serverMatchedLocalIds);
          if (sweepCandidates.length > 0) {
            this.triggerEmptyConversationSweep(sweepCandidates);
          }
        })
        .catch((scanErr) => {
          if (!this.disposed) {
            logError(
              'sync',
              `post-listThreads scan continuation failed: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
            );
          }
        })
        .finally(() => {
          this.postListContinuations.delete(continuation);
        });
      this.postListContinuations.add(continuation);

      return {
        threads,
        serverReachable: true,
        pendingSyncCount: pendingAtReturn,
      };
    } catch (err) {
      logError('sync', 'listThreads failed:', err instanceof Error ? err.message : String(err));
      await scanPromise;
      return {
        threads: this.threads
          .list()
          .filter((t) => !this.deletingOrDeletedThreads.has(t.id) && !this.threads.isDeleted(t.id)),
        serverReachable: false,
        pendingSyncCount: this.totalPendingSyncCount(),
      };
    }
  }

  async createThread(): Promise<ThreadMeta> {
    const settings = this.settings.get();
    const conversation = await this.syncClient.createConversation(null, {
      model: settings.defaultModel,
      thinkingLevel: settings.defaultThinkingLevel,
      'thinking-level': settings.defaultThinkingLevel,
      client: 'desktop',
      ...(this.appVersion ? { desktopVersion: this.appVersion } : {}),
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
      remoteSettings: conversation.settings
        ? { ...conversation.settings }
        : {
            client: 'desktop',
            ...(this.appVersion ? { desktopVersion: this.appVersion } : {}),
          },
    };
    this.sessionTouchedThreads.add(meta.id);
    this.threads.upsert(meta);
    return meta;
  }

  async deleteThread(threadId: string): Promise<void> {
    assertValidThreadId(threadId);
    const remoteId = this.remoteIdFor(threadId);
    this.deletingOrDeletedThreads.add(threadId);
    this.deletingOrDeletedThreads.add(remoteId);
    try {
      await this.syncClient.deleteConversation(remoteId);
    } catch (err) {
      if (!(err instanceof SyncApiError && err.status === 404)) {
        this.deletingOrDeletedThreads.delete(threadId);
        if (remoteId !== threadId) {
          this.deletingOrDeletedThreads.delete(remoteId);
        }
        throw err;
      }
    }
    this.agent.closeThread(threadId);
    this.deferredMissingRecreationThreads.delete(threadId);
    this.unqueuedStartupTurnsByThread.delete(threadId);
    this.startupDirtyThreads.delete(threadId);
    this.lastAttemptedRemoteByThread.delete(threadId);
    this.threadsWithLocalMessages.delete(threadId);
    this.threadsWithUnsyncedMessages.delete(threadId);
    this.verifiedOffPageThreads.delete(threadId);
    this.sweepSparedThreads.delete(threadId);
    this.playbookBackfillChecked.delete(threadId);
    this.newlyInsertedOrphans.delete(threadId);
    this.enrichedOrphans.delete(threadId);
    this.pruneThreadSideEffects(threadId);
    this.syncQueue.removeThread(threadId);
    void this.threads.delete(threadId);
    this.searchIndex.remove(threadId);
  }

  patchThread(threadId: string, update: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>>): ThreadMeta | undefined {
    assertValidThreadId(threadId);
    this.sessionTouchedThreads.add(threadId);

    const safeUpdate: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>> =
      typeof update === 'object' && update !== null && !Array.isArray(update) ? update : {};

    // Whitelist strictly mutable keys so a malicious/buggy renderer can't inject
    // arbitrary fields (e.g. id, remoteConversationId, sessionId, totals, syncState).
    const sanitized: Partial<Pick<ThreadMeta, 'model' | 'thinkingLevel' | 'title' | 'orchestratorProfile'>> = {};
    if (safeUpdate.model !== undefined) sanitized.model = safeUpdate.model;
    if (safeUpdate.thinkingLevel !== undefined) sanitized.thinkingLevel = safeUpdate.thinkingLevel;
    if (safeUpdate.title !== undefined) sanitized.title = safeUpdate.title;
    if ('orchestratorProfile' in safeUpdate) {
      sanitized.orchestratorProfile = safeUpdate.orchestratorProfile || undefined;
    }

    const existing = this.threads.get(threadId);
    if (!existing) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const modeChanged =
      'orchestratorProfile' in safeUpdate &&
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
      const title = sanitized.title;
      void this.syncClient
        .updateConversation(this.remoteIdFor(threadId), title, fullSettings)
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
    assertValidThreadId(threadId);
    this.sessionTouchedThreads.add(threadId);

    const local = await this.threads.readMessages(threadId);
    if (local.length > 0) {
      this.threadsWithLocalMessages.add(threadId);
      this.backfillInitialPlaybook(threadId, local);
      return local;
    }
    try {
      const remote = await this.syncClient.getMessages(this.remoteIdFor(threadId));
      const rehydrated = remote.map((m) => this.fromDto(m));
      if (rehydrated.length > 0) {
        this.threadsWithLocalMessages.add(threadId);
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

  async interrupt(threadId: string): Promise<void> {
    if (!isValidThreadId(threadId)) {
      return;
    }
    await this.agent.interrupt(threadId);
  }

  async sendMessage(request: SendMessageRequest): Promise<void> {
    if (!request) {
      throw new Error('Invalid SendMessageRequest');
    }
    assertValidThreadId(request.threadId);
    const threadId = request.threadId;
    this.sessionTouchedThreads.add(threadId);

    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${threadId}`);
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
    if (!request) {
      throw new Error('Invalid FeedbackRequest');
    }
    assertValidThreadId(request.threadId);
    const threadId = request.threadId;
    this.sessionTouchedThreads.add(threadId);

    if (request.rating === -1 && (!request.comment || request.comment.trim().length === 0)) {
      throw new Error('A comment is required for negative feedback.');
    }
    const message = (await this.threads.readMessages(threadId)).find((m) => m.localId === request.messageLocalId);
    if (!message) {
      throw new Error('Message not found.');
    }
    if (!message.serverId) {
      throw new Error('This message is still syncing to the server — try again in a moment.');
    }
    await this.syncClient.submitFeedback(message.serverId, request.rating, request.comment?.trim() || undefined);
    await this.threads.setFeedback(threadId, request.messageLocalId, request.rating, request.comment?.trim() || undefined);
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
    this.disposed = true;
    this.pendingRecoveryServerIds = null;
    this.pendingFeedback.clear();
    this.deferredRecoveryTraces.clear();
    this.pendingRuns.clear();
    this.failedRuns.length = 0;
    this.agent.closeAll();
    this.syncQueue.dispose();
    this.searchIndex.dispose();
  }
}

export function newLocalId(): string {
  return randomUUID();
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controlPlaybookNames, DEFAULT_APPEARANCE, isUserSelectablePlaybook } from '../../shared/types';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  ChatMessage,
  ClarificationOption,
  ImageAttachment,
  McpPromptInfo,
  OrchestratorProfile,
  SyncEvent,
  ThreadMeta,
  ToolCallInfo,
} from '../../shared/types';
import { ChatView } from './components/ChatView';
import { SettingsView } from './components/SettingsView';
import { StatusBanners } from './components/StatusBanners';
import { ThreadList } from './components/ThreadList';
import { TooltipLayer } from './components/Tooltip';
import { PlusIcon } from './components/icons';

/** In-progress turn state for the active thread. */
export interface LiveTurn {
  running: boolean;
  liveText: string;
  liveThinking: string;
  blocks: { text: string; thinking?: string; toolCalls: ToolCallInfo[] }[];
  error?: string;
  /** Neutral status note (e.g. after the user stops a turn). */
  notice?: string;
  /**
   * Whether the user has had this error/notice on screen. A failure on a background thread has to
   * survive the switch back that first shows it; a banner already read must not follow the user
   * around every time they revisit the conversation.
   */
  seen?: boolean;
  clarifyingQuestion?: {
    toolUseId: string;
    question: string;
    options: ClarificationOption[];
  };
}

const EMPTY_TURN: LiveTurn = { running: false, liveText: '', liveThinking: '', blocks: [] };
const MAX_RECENT_SERVER_ID_THREADS = 200;

export default function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [prompts, setPrompts] = useState<McpPromptInfo[]>([]);
  const [profiles, setProfiles] = useState<OrchestratorProfile[]>([]);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [serverReachable, setServerReachable] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, ChatMessage[]>>({});
  const [liveTurnsByThread, setLiveTurnsByThread] = useState<Record<string, LiveTurn>>({});
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [pendingSync, setPendingSync] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [droppedSyncError, setDroppedSyncError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const mountedRef = useRef(true);
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const threadsRef = useRef<ThreadMeta[]>([]);
  threadsRef.current = threads;
  const liveTurnsByThreadRef = useRef<Record<string, LiveTurn>>({});
  liveTurnsByThreadRef.current = liveTurnsByThread;
  const promptsCountRef = useRef(0);
  promptsCountRef.current = prompts.length;
  const initialPromptsLoadedRef = useRef(false);
  const migratedIdsRef = useRef<Map<string, string>>(new Map());
  const originIdByThreadRef = useRef<Map<string, string>>(new Map());
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const recentServerIdsByThreadRef = useRef<Map<string, Record<string, string>>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolveThreadId = useCallback((id: string): string => {
    let cur = id;
    const visited = new Set<string>();
    while (migratedIdsRef.current.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      cur = migratedIdsRef.current.get(cur)!;
    }
    return cur;
  }, []);

  const overlayRecentServerIds = useCallback((threadId: string, msgs: ChatMessage[]): ChatMessage[] => {
    const recent = recentServerIdsByThreadRef.current.get(threadId);
    if (!recent) return msgs;
    return msgs.map((m) => (recent[m.localId] ? { ...m, serverId: recent[m.localId] } : m));
  }, []);

  const messages = useMemo(
    () => (activeThreadId ? messagesByThread[activeThreadId] ?? [] : []),
    [activeThreadId, messagesByThread],
  );
  const liveTurn = useMemo(
    () => (activeThreadId ? liveTurnsByThread[activeThreadId] ?? EMPTY_TURN : EMPTY_TURN),
    [activeThreadId, liveTurnsByThread],
  );

  // Stable identity so the sidebar's debounced search effect doesn't re-fire every render.
  const searchContent = useCallback((query: string) => window.api.searchThreads(query), []);

  /** Re-read the conversation list. Returns whether the server answered, for callers that need it. */
  const refreshThreads = useCallback(async () => {
    let result: Awaited<ReturnType<typeof window.api.listThreads>>;
    try {
      result = await window.api.listThreads();
    } catch (error) {
      if (mountedRef.current) {
        console.warn('Failed to list threads:', error);
      }
      return false;
    }
    if (!mountedRef.current) return false;
    setThreads((prev) => {
      const byId = new Map<string, ThreadMeta>();
      for (const p of prev) {
        byId.set(p.id, p);
      }
      const seen = new Set<string>();
      const next: ThreadMeta[] = [];
      for (const raw of result.threads) {
        const resolvedId = resolveThreadId(raw.id);
        if (deletedIdsRef.current.has(raw.id) || deletedIdsRef.current.has(resolvedId)) continue;
        if (seen.has(resolvedId)) continue;
        seen.add(resolvedId);
        if (resolvedId !== raw.id) {
          next.push(byId.get(resolvedId) ?? { ...raw, id: resolvedId });
        } else {
          next.push(raw);
        }
      }
      threadsRef.current = next;
      return next;
    });
    setServerReachable(result.serverReachable);
    if (typeof result.pendingSyncCount === 'number') {
      setPendingSync(result.pendingSyncCount);
    }
    if (result.serverReachable && initialPromptsLoadedRef.current && promptsCountRef.current === 0) {
      void window.api
        .listPrompts()
        .then((list) => {
          if (!mountedRef.current) return;
          promptsCountRef.current = list.length;
          setPrompts(list);
        })
        .catch(() => undefined);
      void window.api
        .listOrchestratorProfiles()
        .then((list) => {
          if (!mountedRef.current) return;
          setProfiles(list);
        })
        .catch(() => undefined);
    }
    return result.serverReachable;
  }, [resolveThreadId]);

  /**
   * The list plus the catalogues only the server can supply — skipped when it is not answering.
   *
   * `authStatus` is deliberately outside that guard: it reads local cache state, not the server,
   * and the moment it matters most is right after an inline sign-in taken *because* the server
   * check failed — exactly when `refreshThreads()` is still reporting unreachable.
   */
  const refreshServer = useCallback(async () => {
    void window.api
      .authStatus()
      .then((status) => {
        if (mountedRef.current) setAuth(status);
      })
      .catch(() => undefined);
    const shouldFetchCatalogues = !initialPromptsLoadedRef.current || promptsCountRef.current > 0;
    if (!(await refreshThreads())) return;
    if (!mountedRef.current) return;
    if (shouldFetchCatalogues) {
      void window.api
        .listPrompts()
        .then((list) => {
          if (!mountedRef.current) return;
          promptsCountRef.current = list.length;
          setPrompts(list);
        })
        .catch(() => undefined);
      void window.api
        .listOrchestratorProfiles()
        .then((list) => {
          if (!mountedRef.current) return;
          setProfiles(list);
        })
        .catch(() => undefined);
    }
  }, [refreshThreads]);

  useEffect(() => {
    void window.api
      .getAppVersion()
      .then((v) => {
        if (mountedRef.current) setAppVersion(v);
      })
      .catch(() => undefined);
    void window.api
      .getSettings()
      .then((s) => {
        if (mountedRef.current) setSettings(s);
      })
      .catch(() => undefined);
    void window.api
      .authStatus()
      .then((status) => {
        if (mountedRef.current) setAuth(status);
      })
      .catch(() => undefined);
    void window.api
      .listPrompts()
      .then((list) => {
        if (!mountedRef.current) return;
        promptsCountRef.current = list.length;
        setPrompts(list);
      })
      .catch(() => undefined)
      .finally(() => {
        initialPromptsLoadedRef.current = true;
      });
    void window.api
      .listOrchestratorProfiles()
      .then((list) => {
        if (mountedRef.current) setProfiles(list);
      })
      .catch(() => undefined);
    void refreshThreads();
  }, [refreshThreads]);

  // When the server is unreachable or the playbook catalogue is still empty, periodically poll
  // so the banner clears and playbooks load automatically once the backend service answers.
  useEffect(() => {
    if (serverReachable && prompts.length > 0) return;
    const interval = setInterval(() => {
      void refreshServer();
    }, 10_000);
    return () => clearInterval(interval);
  }, [serverReachable, prompts.length, refreshServer]);

  // Orchestrator and reviewer playbooks are the runtime's own machinery, so they never appear in
  // the picker (see isUserSelectablePlaybook). Specialist playbooks stay pickable — they're useful
  // on their own for a quick single-agent query even though a profile also drives them.
  //
  // Sorted by canonical name here rather than in each consumer, so the picker grid and the
  // slash-autocomplete list the same playbooks in the same order. The server returns them in no
  // particular order.
  const visiblePrompts = useMemo(() => {
    const control = controlPlaybookNames(profiles);
    const showPrototypes = Boolean(settings?.showPrototypePlaybooks);
    return prompts
      .filter((p) => isUserSelectablePlaybook(p, control, showPrototypes))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [prompts, profiles, settings?.showPrototypePlaybooks]);

  const openThread = useCallback(
    async (threadId: string) => {
      const initialTarget = resolveThreadId(threadId);
      if (deletedIdsRef.current.has(threadId) || deletedIdsRef.current.has(initialTarget)) return;
      activeThreadIdRef.current = initialTarget;
      setActiveThreadId(initialTarget);
      // A finished turn's live state is only ever a leftover error or stop notice, and it is retired
      // by having been read rather than by the turn ending: the first open after a background failure
      // surfaces it and marks it read, the next one clears it. A running turn keeps everything —
      // surviving a switch is the whole point of per-thread live turns.
      setLiveTurnsByThread((prev) => {
        const current = prev[initialTarget];
        if (!current || current.running || (!current.error && !current.notice)) return prev;
        return { ...prev, [initialTarget]: current.seen ? EMPTY_TURN : { ...current, seen: true } };
      });
      let msgs: ChatMessage[];
      try {
        msgs = await window.api.getMessages(initialTarget);
      } catch (error) {
        const resolvedAfterErr = resolveThreadId(initialTarget);
        if (
          mountedRef.current &&
          !deletedIdsRef.current.has(threadId) &&
          !deletedIdsRef.current.has(initialTarget) &&
          !deletedIdsRef.current.has(resolvedAfterErr)
        ) {
          console.warn('Failed to load messages:', error);
        }
        return;
      }
      const targetId = resolveThreadId(initialTarget);
      if (
        !mountedRef.current ||
        deletedIdsRef.current.has(threadId) ||
        deletedIdsRef.current.has(initialTarget) ||
        deletedIdsRef.current.has(targetId)
      ) {
        return;
      }
      if (activeThreadIdRef.current !== initialTarget && activeThreadIdRef.current !== targetId) {
        return;
      }
      const strippedMsgs =
        targetId !== initialTarget ? msgs.map(({ serverId: _stale, ...rest }) => rest) : msgs;
      const normalizedMsgs = overlayRecentServerIds(targetId, strippedMsgs);
      if (activeThreadIdRef.current === initialTarget && targetId !== initialTarget) {
        activeThreadIdRef.current = targetId;
        setActiveThreadId(targetId);
      }
      setMessagesByThread((prev) => {
        // If a turn is currently running for this thread, prev[targetId] contains the in-flight
        // user message which has not been written to disk yet. Avoid clobbering in-memory messages.
        if (liveTurnsByThreadRef.current[targetId]?.running && (prev[targetId]?.length ?? 0) > 0) {
          return prev;
        }
        // Every open re-reads from disk, so a cached entry for a conversation nobody is looking at is
        // never read again — only the open thread and any with a turn still in flight are
        // load-bearing (the latter hold optimistic messages the store does not have yet). Holding the
        // rest would keep every transcript opened this session, tool results included, resident.
        const next: Record<string, ChatMessage[]> = { [targetId]: normalizedMsgs };
        for (const [id, cached] of Object.entries(prev)) {
          if (id !== targetId && id !== initialTarget && liveTurnsByThreadRef.current[id]?.running) {
            next[id] = cached;
          }
        }
        return next;
      });
      // Drop live turns that carry nothing: a clean turn-complete leaves EMPTY_TURN behind for every
      // thread that has ever run one. Anything still holding an error or an unread notice stays.
      setLiveTurnsByThread((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [id, turn] of Object.entries(prev)) {
          if (id === targetId) continue;
          if (!turn.running && !turn.error && !turn.notice && !turn.clarifyingQuestion && turn.blocks.length === 0) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [resolveThreadId, overlayRecentServerIds],
  );

  useEffect(() => {
    // Live text/thinking events arrive per-token, each carrying the full accumulated string. A
    // setState per token forces a full markdown+KaTeX re-parse (O(n^2)), so we coalesce them:
    // buffer the latest value per thread and flush to state at most once every ~80ms. Non-delta
    // events (turn-start / assistant-block / turn-complete) flush any pending value first so the
    // rendered text is always exact at block/turn boundaries.
    const pendingLiveByThread = new Map<string, { text?: string; thinking?: string }>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushLive = (): void => {
      flushTimer = null;
      if (pendingLiveByThread.size === 0 || !mountedRef.current) return;
      const entries = new Map(pendingLiveByThread);
      pendingLiveByThread.clear();
      setLiveTurnsByThread((prev) => {
        const next = { ...prev };
        for (const [rawId, { text, thinking }] of entries.entries()) {
          const tId = resolveThreadId(rawId);
          if (deletedIdsRef.current.has(tId)) continue;
          const current = next[tId] ?? EMPTY_TURN;
          next[tId] = {
            ...current,
            ...(text !== undefined ? { liveText: text } : {}),
            ...(thinking !== undefined ? { liveThinking: thinking } : {}),
          };
        }
        return next;
      });
    };

    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = setTimeout(flushLive, 80);
    };

    const cancelFlushForThread = (threadId: string): void => {
      pendingLiveByThread.delete(threadId);
    };

    const cancelAllFlush = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingLiveByThread.clear();
    };

    const offAgent = window.api.onAgentEvent((event: AgentEvent) => {
      if (!mountedRef.current) return;
      const threadId = resolveThreadId(event.threadId);
      if (deletedIdsRef.current.has(event.threadId) || deletedIdsRef.current.has(threadId)) return;
      switch (event.kind) {
        case 'turn-start':
          cancelFlushForThread(event.threadId);
          cancelFlushForThread(threadId);
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [threadId]: { running: true, liveText: '', liveThinking: '', blocks: [] },
          }));
          break;
        case 'live-text': {
          const entry = pendingLiveByThread.get(threadId) ?? {};
          entry.text = event.text;
          pendingLiveByThread.set(threadId, entry);
          scheduleFlush();
          break;
        }
        case 'live-thinking': {
          const entry = pendingLiveByThread.get(threadId) ?? {};
          entry.thinking = event.text;
          pendingLiveByThread.set(threadId, entry);
          scheduleFlush();
          break;
        }
        case 'assistant-block':
          cancelFlushForThread(event.threadId);
          cancelFlushForThread(threadId);
          setLiveTurnsByThread((prev) => {
            const current = prev[threadId] ?? { running: true, liveText: '', liveThinking: '', blocks: [] };
            return {
              ...prev,
              [threadId]: {
                ...current,
                liveText: '',
                liveThinking: '',
                blocks: [...current.blocks, { text: event.text, thinking: event.thinking, toolCalls: event.toolCalls }],
              },
            };
          });
          break;
        case 'tool-result':
          setLiveTurnsByThread((prev) => {
            const current = prev[threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [threadId]: {
                ...current,
                clarifyingQuestion:
                  current.clarifyingQuestion?.toolUseId === event.toolUseId
                    ? undefined
                    : current.clarifyingQuestion,
                blocks: current.blocks.map((b) => ({
                  ...b,
                  toolCalls: b.toolCalls.map((c) =>
                    c.id === event.toolUseId ? { ...c, result: event.result, isError: event.isError } : c,
                  ),
                })),
              },
            };
          });
          break;
        case 'turn-complete': {
          cancelFlushForThread(event.threadId);
          cancelFlushForThread(threadId);
          const onScreen = threadId === activeThreadIdRef.current;
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [threadId]: !event.isError
              ? EMPTY_TURN
              : event.aborted
                ? { ...EMPTY_TURN, notice: 'Processing stopped.', seen: onScreen }
                : { ...EMPTY_TURN, error: event.errorMessage ?? 'The turn failed.', seen: onScreen },
          }));
          if (!event.isError) {
            setMessagesByThread((prev) => ({
              ...prev,
              [threadId]: [...(prev[threadId] ?? []), event.message],
            }));
          }
          void refreshThreads();
          break;
        }
        case 'error': {
          cancelFlushForThread(event.threadId);
          cancelFlushForThread(threadId);
          const onScreen = threadId === activeThreadIdRef.current;
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [threadId]: { ...EMPTY_TURN, error: event.message, seen: onScreen },
          }));
          void window.api
            .authStatus()
            .then((status) => {
              if (mountedRef.current) setAuth(status);
            })
            .catch(() => undefined);
          break;
        }
        case 'review-enforced': {
          // Mirror the main process: the draft answer was discarded, so drop the prose already
          // streamed into the live view and keep only the delegation trace.
          cancelFlushForThread(event.threadId);
          cancelFlushForThread(threadId);
          const notice =
            event.reason === 'skipped'
              ? 'No review pass in that answer — asking the reviewer before delivering…'
              : event.reason === 'unclear'
                ? `The reviewer returned no clear verdict — revising (round ${event.round ?? 1})…`
                : `The reviewer rejected that draft — revising (round ${event.round ?? 1})…`;
          setLiveTurnsByThread((prev) => {
            const current = prev[threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [threadId]: {
                ...current,
                liveText: '',
                blocks: current.blocks.map((b) => ({ ...b, text: '' })).filter((b) => b.thinking || b.toolCalls.length > 0),
                notice,
              },
            };
          });
          break;
        }
        case 'clarifying-question':
          setLiveTurnsByThread((prev) => {
            const current = prev[threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [threadId]: {
                ...current,
                clarifyingQuestion: {
                  toolUseId: event.toolUseId,
                  question: event.question,
                  options: event.options ?? [],
                },
              },
            };
          });
          break;
        default:
          break;
      }
    });
    const offSync = window.api.onSyncEvent((event: SyncEvent) => {
      if (!mountedRef.current) return;
      if (event.kind === 'sync-state') {
        setPendingSync(event.pendingCount);
        if (event.state === 'error') {
          if (event.dropped) {
            setDroppedSyncError(
              event.detail ??
                'A queued conversation turn was rejected by the server and could not be synced.',
            );
          } else {
            setSyncError(event.detail ?? 'Sync failed — retrying.');
          }
          void window.api
            .authStatus()
            .then((status) => {
              if (mountedRef.current) setAuth(status);
            })
            .catch(() => undefined);
        } else {
          setSyncError(null);
        }
        // The server names a conversation from its first question but only learns that question
        // when the turn syncs — which happens *after* turn-complete. Re-reading the list here is
        // what replaces the placeholder title without waiting for the next unrelated refresh.
        // Unlike the agent events above, this handler is not filtered to the active thread, so a
        // turn that finishes off screen refreshes its sidebar row too.
        if (event.state === 'synced') {
          void refreshThreads();
        }
      } else if (event.kind === 'server-ids') {
        const resolvedId = resolveThreadId(event.threadId);
        if (deletedIdsRef.current.has(event.threadId) || deletedIdsRef.current.has(resolvedId)) return;
        const recentMap = recentServerIdsByThreadRef.current;
        const existingRecent = recentMap.get(resolvedId);
        recentMap.delete(resolvedId);
        if (recentMap.size >= MAX_RECENT_SERVER_ID_THREADS) {
          const oldestKey = recentMap.keys().next().value;
          if (oldestKey !== undefined) {
            recentMap.delete(oldestKey);
          }
        }
        recentMap.set(resolvedId, { ...existingRecent, ...event.mapping });
        setMessagesByThread((prev) => {
          const targetKey = prev[resolvedId] ? resolvedId : event.threadId;
          const msgs = prev[targetKey];
          if (!msgs) return prev;
          return {
            ...prev,
            [targetKey]: msgs.map((m) =>
              event.mapping[m.localId] ? { ...m, serverId: event.mapping[m.localId] } : m,
            ),
          };
        });
      } else if (event.kind === 'thread-migrated') {
        const origin = originIdByThreadRef.current.get(event.oldThreadId) ?? event.oldThreadId;
        originIdByThreadRef.current.set(event.thread.id, origin);
        migratedIdsRef.current.set(event.oldThreadId, event.thread.id);
        recentServerIdsByThreadRef.current.delete(event.oldThreadId);
        recentServerIdsByThreadRef.current.delete(event.thread.id);
        cancelFlushForThread(event.oldThreadId);

        setThreads((prev) => {
          const hasNew = prev.some((t) => t.id === event.thread.id);
          const hadOld = prev.some((t) => t.id === event.oldThreadId);
          let next: ThreadMeta[];
          if (hasNew) {
            next = prev
              .filter((t) => t.id !== event.oldThreadId)
              .map((t) => (t.id === event.thread.id ? event.thread : t));
          } else if (hadOld) {
            next = prev.map((t) => (t.id === event.oldThreadId ? event.thread : t));
          } else {
            next = [event.thread, ...prev];
          }
          threadsRef.current = next;
          return next;
        });

        setMessagesByThread((prev) => {
          const oldMsgs = prev[event.oldThreadId];
          if (!oldMsgs) return prev;
          const cleared = oldMsgs.map(({ serverId: _stale, ...rest }) => rest);
          const next = { ...prev, [event.thread.id]: cleared };
          delete next[event.oldThreadId];
          return next;
        });

        setLiveTurnsByThread((prev) => {
          if (!(event.oldThreadId in prev)) return prev;
          const next = { ...prev, [event.thread.id]: prev[event.oldThreadId] };
          delete next[event.oldThreadId];
          return next;
        });

        if (activeThreadIdRef.current === event.oldThreadId) {
          activeThreadIdRef.current = event.thread.id;
          setActiveThreadId(event.thread.id);
        }
      } else if (event.kind === 'thread-deleted') {
        const resolvedDeletedId = resolveThreadId(event.threadId);
        deletedIdsRef.current.add(event.threadId);
        recentServerIdsByThreadRef.current.delete(event.threadId);
        recentServerIdsByThreadRef.current.delete(resolvedDeletedId);
        cancelFlushForThread(event.threadId);
        const remaining = threadsRef.current.filter((t) => t.id !== event.threadId);
        threadsRef.current = remaining;

        setThreads((prev) => prev.filter((t) => t.id !== event.threadId));
        setMessagesByThread((prev) => {
          if (!(event.threadId in prev)) return prev;
          const next = { ...prev };
          delete next[event.threadId];
          return next;
        });
        setLiveTurnsByThread((prev) => {
          if (!(event.threadId in prev)) return prev;
          const next = { ...prev };
          delete next[event.threadId];
          return next;
        });

        if (
          activeThreadIdRef.current === event.threadId &&
          !liveTurnsByThreadRef.current[event.threadId]?.running
        ) {
          const fallback = remaining[0] ?? null;
          if (fallback) {
            void openThread(fallback.id);
          } else {
            activeThreadIdRef.current = null;
            setActiveThreadId(null);
          }
        }
      }
    });
    return () => {
      cancelAllFlush();
      offAgent();
      offSync();
    };
  }, [refreshThreads, openThread, resolveThreadId]);

  const createThread = useCallback(async () => {
    const thread = await window.api.createThread();
    await refreshThreads();
    await openThread(thread.id);
  }, [refreshThreads, openThread]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      const resolvedId = resolveThreadId(threadId);
      try {
        await window.api.deleteThread(resolvedId);
      } catch (error) {
        if (mountedRef.current) {
          console.warn('Failed to delete thread:', error);
        }
        return;
      }
      deletedIdsRef.current.add(threadId);
      deletedIdsRef.current.add(resolvedId);
      recentServerIdsByThreadRef.current.delete(threadId);
      recentServerIdsByThreadRef.current.delete(resolvedId);
      if (!mountedRef.current) return;
      setThreads((prev) => {
        const next = prev.filter((t) => t.id !== threadId && t.id !== resolvedId);
        threadsRef.current = next;
        return next;
      });
      setMessagesByThread((prev) => {
        const next = { ...prev };
        delete next[threadId];
        delete next[resolvedId];
        return next;
      });
      setLiveTurnsByThread((prev) => {
        const next = { ...prev };
        delete next[threadId];
        delete next[resolvedId];
        return next;
      });
      if (activeThreadIdRef.current === threadId || activeThreadIdRef.current === resolvedId) {
        activeThreadIdRef.current = null;
        setActiveThreadId(null);
      }
      await refreshThreads();
    },
    [refreshThreads, resolveThreadId],
  );

  const sendMessage = useCallback(
    async (text: string, promptName?: string, images?: ImageAttachment[]) => {
      if (!activeThreadId) return;
      const threadId = resolveThreadId(activeThreadId);
      if (deletedIdsRef.current.has(threadId)) return;
      const userMessage: ChatMessage = {
        localId: `optimistic-${Date.now()}`,
        role: 'user',
        content: text,
        playbook: promptName,
        images: images && images.length > 0 ? images : undefined,
        createdAt: new Date().toISOString(),
      };
      setMessagesByThread((prev) => ({
        ...prev,
        [threadId]: [...(prev[threadId] ?? []), userMessage],
      }));
      setLiveTurnsByThread((prev) => ({
        ...prev,
        [threadId]: { running: true, liveText: '', liveThinking: '', blocks: [] },
      }));
      try {
        await window.api.sendMessage({ threadId, text, promptName, images });
      } catch (error) {
        if (!mountedRef.current) return;
        const currentId = resolveThreadId(threadId);
        // The question never reached the agent, so the card that was posted ahead of it has to go
        // with it — otherwise a rejected send (an attachment the main-process validator refuses,
        // say) leaves a message standing in the transcript that nothing will ever answer.
        setMessagesByThread((prev) => ({
          ...prev,
          [currentId]: (prev[currentId] ?? []).filter((m) => m.localId !== userMessage.localId),
        }));
        setLiveTurnsByThread((prev) => ({
          ...prev,
          [currentId]: { ...EMPTY_TURN, error: error instanceof Error ? error.message : String(error), seen: true },
        }));
        await refreshThreads();
      }
    },
    [activeThreadId, refreshThreads, resolveThreadId],
  );

  const patchThread = useCallback(
    async (threadId: string, update: Partial<ThreadMeta>) => {
      const resolvedId = resolveThreadId(threadId);
      try {
        await window.api.patchThread(resolvedId, update);
      } catch (error) {
        if (mountedRef.current) {
          console.warn('Failed to patch thread:', error);
        }
      } finally {
        await refreshThreads();
      }
    },
    [refreshThreads, resolveThreadId],
  );

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const activeConversationKey = activeThread
    ? (originIdByThreadRef.current.get(activeThread.id) ?? activeThread.id)
    : undefined;

  // Density and answer type size are two CSS variables, so they belong on the document root
  // rather than threaded through every component that reads them. (Theme is not here: it comes
  // from nativeTheme via prefers-color-scheme, so the CSS picks it up with no class to set.)
  const appearance = settings?.appearance ?? DEFAULT_APPEARANCE;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = appearance.density;
    root.style.setProperty('--answer-size', `${appearance.answerTextSize}px`);
  }, [appearance.density, appearance.answerTextSize]);

  if (!settings) {
    return <div className="app-loading">Loading…</div>;
  }

  // The titlebar is the app's own strip: macOS insets the traffic lights into it, Windows draws
  // its control cluster over the right end, and both need the gutter reserved in CSS.
  const platformClass =
    window.api.platform === 'darwin' ? 'mac' : window.api.platform === 'win32' ? 'win' : '';

  return (
    <div className="app">
      <TooltipLayer />
      <div className={`titlebar ${platformClass}`}>
        <span className="titlebar-title">{showSettings ? 'Settings' : 'Yvoke'}</span>
        <span className="titlebar-spacer" />
      </div>
      <div className="app-body">
      <ThreadList
        threads={threads}
        appVersion={appVersion}
        activeThreadId={activeThreadId}
        defaultModel={settings.defaultModel}
        settingsOpen={showSettings}
        searchContent={searchContent}
        onOpen={(id) => {
          setShowSettings(false);
          void openThread(id);
        }}
        onCreate={() => {
          setShowSettings(false);
          void createThread();
        }}
        onDelete={(id) => void deleteThread(id)}
        onOpenSettings={() => setShowSettings((prev) => !prev)}
        onSignOut={async () => {
          await window.api.serverSignOut();
          setAuth(await window.api.authStatus());
          await refreshThreads();
        }}
        auth={auth}
      />
      <main className="main-pane">
        <StatusBanners
          auth={auth}
          serverReachable={serverReachable}
          pendingSync={pendingSync}
          syncError={syncError}
          droppedSyncError={droppedSyncError}
          onDismissDroppedSyncError={() => setDroppedSyncError(null)}
          onServerSignIn={() => {
            void window.api
              .serverSignIn()
              .then(() => {
                if (mountedRef.current) void refreshServer();
              })
              .catch(() => undefined);
          }}
          onRetryAuth={() => {
            void window.api
              .authStatus()
              .then((status) => {
                if (!mountedRef.current) return;
                setAuth(status);
                void refreshServer();
              })
              .catch(() => undefined);
          }}
          onRetryServer={() => {
            void refreshServer();
          }}
        />
        {showSettings ? (
          <SettingsView
            settings={settings}
            appVersion={appVersion}
            auth={auth}
            onAuthChange={() => void refreshServer()}
            onSave={async (update) => {
              const saved = await window.api.setSettings(update);
              if (!mountedRef.current) return;
              setSettings(saved);
              setShowSettings(false);
              // A save can change the server address or auth mode, so re-check auth too — not just
              // the list and the catalogues.
              void refreshServer();
            }}
            onClose={() => setShowSettings(false)}
          />
        ) : activeThread ? (
          <ChatView
            thread={activeThread}
            conversationKey={activeConversationKey}
            settings={settings}
            messages={messages}
            prompts={visiblePrompts}
            profiles={profiles}
            liveTurn={liveTurn}
            onSend={sendMessage}
            onInterrupt={() => {
              if (activeThreadId) {
                void window.api.interrupt(resolveThreadId(activeThreadId));
              }
            }}
            onPatchThread={(update) => void patchThread(activeThread.id, update)}
            onFeedback={async (messageLocalId, rating, comment) => {
              const targetId = resolveThreadId(activeThread.id);
              await window.api.submitFeedback({
                threadId: targetId,
                messageLocalId,
                rating,
                comment,
              });
              const latestId = resolveThreadId(targetId);
              if (!mountedRef.current || deletedIdsRef.current.has(latestId)) return;
              const updated = await window.api.getMessages(latestId);
              const storeKey = resolveThreadId(latestId);
              if (
                !mountedRef.current ||
                deletedIdsRef.current.has(storeKey) ||
                (activeThreadIdRef.current !== latestId && activeThreadIdRef.current !== storeKey)
              ) {
                return;
              }
              const stripped =
                storeKey !== latestId ? updated.map(({ serverId: _stale, ...rest }) => rest) : updated;
              const overlaid = overlayRecentServerIds(storeKey, stripped);
              setMessagesByThread((prev) => ({ ...prev, [storeKey]: overlaid }));
            }}
          />
        ) : (
          <div className="empty-state">
            <h2>Yvoke</h2>
            <p>
              Ask the One Identity knowledge base a question and get a cited answer. Select a
              conversation on the left, or start a new one.
            </p>
            <button className="primary" onClick={() => void createThread()}>
              <PlusIcon size={12} />
              New conversation
            </button>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

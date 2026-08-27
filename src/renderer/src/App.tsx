import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { controlPlaybookNames, DEFAULT_APPEARANCE, isUserSelectablePlaybook } from '../../shared/types';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  ChatMessage,
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
    options: string[];
  };
}

const EMPTY_TURN: LiveTurn = { running: false, liveText: '', liveThinking: '', blocks: [] };

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
  const [showSettings, setShowSettings] = useState(false);
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const liveTurnsByThreadRef = useRef<Record<string, LiveTurn>>({});
  liveTurnsByThreadRef.current = liveTurnsByThread;

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
    const result = await window.api.listThreads();
    setThreads(result.threads);
    setServerReachable(result.serverReachable);
    return result.serverReachable;
  }, []);

  /** The list plus the catalogues only the server can supply — skipped when it is not answering. */
  const refreshServer = useCallback(async () => {
    if (!(await refreshThreads())) return;
    void window.api.authStatus().then(setAuth);
    void window.api.listPrompts().then(setPrompts);
    void window.api.listOrchestratorProfiles().then(setProfiles);
  }, [refreshThreads]);

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion);
    void window.api.getSettings().then(setSettings);
    void window.api.authStatus().then(setAuth);
    void window.api.listPrompts().then(setPrompts);
    void window.api.listOrchestratorProfiles().then(setProfiles);
    void refreshThreads();
  }, [refreshThreads]);

  // When the server is unreachable, periodically poll so the banner clears and playbooks load
  // automatically once the backend service starts.
  useEffect(() => {
    if (serverReachable) return;
    const interval = setInterval(() => {
      void refreshServer();
    }, 10_000);
    return () => clearInterval(interval);
  }, [serverReachable, refreshServer]);

  // Orchestrator and reviewer playbooks are the runtime's own machinery, so they never appear in
  // the picker (see isUserSelectablePlaybook). Specialist playbooks stay pickable — they're useful
  // on their own for a quick single-agent query even though a profile also drives them.
  //
  // Sorted here rather than in each consumer, so the picker grid and the slash-autocomplete list
  // the same playbooks in the same order. The server returns them in no particular order.
  const visiblePrompts = useMemo(() => {
    const control = controlPlaybookNames(profiles);
    const showPrototypes = Boolean(settings?.showPrototypePlaybooks);
    return prompts
      .filter((p) => isUserSelectablePlaybook(p, control, showPrototypes))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [prompts, profiles, settings?.showPrototypePlaybooks]);

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
      if (pendingLiveByThread.size === 0) return;
      const entries = new Map(pendingLiveByThread);
      pendingLiveByThread.clear();
      setLiveTurnsByThread((prev) => {
        const next = { ...prev };
        for (const [tId, { text, thinking }] of entries.entries()) {
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
      switch (event.kind) {
        case 'turn-start':
          cancelFlushForThread(event.threadId);
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [event.threadId]: { running: true, liveText: '', liveThinking: '', blocks: [] },
          }));
          break;
        case 'live-text': {
          const entry = pendingLiveByThread.get(event.threadId) ?? {};
          entry.text = event.text;
          pendingLiveByThread.set(event.threadId, entry);
          scheduleFlush();
          break;
        }
        case 'live-thinking': {
          const entry = pendingLiveByThread.get(event.threadId) ?? {};
          entry.thinking = event.text;
          pendingLiveByThread.set(event.threadId, entry);
          scheduleFlush();
          break;
        }
        case 'assistant-block':
          cancelFlushForThread(event.threadId);
          setLiveTurnsByThread((prev) => {
            const current = prev[event.threadId] ?? { running: true, liveText: '', liveThinking: '', blocks: [] };
            return {
              ...prev,
              [event.threadId]: {
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
            const current = prev[event.threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [event.threadId]: {
                ...current,
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
          const onScreen = event.threadId === activeThreadIdRef.current;
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [event.threadId]: !event.isError
              ? EMPTY_TURN
              : event.aborted
                ? { ...EMPTY_TURN, notice: 'Processing stopped.', seen: onScreen }
                : { ...EMPTY_TURN, error: event.errorMessage ?? 'The turn failed.', seen: onScreen },
          }));
          if (!event.isError) {
            setMessagesByThread((prev) => ({
              ...prev,
              [event.threadId]: [...(prev[event.threadId] ?? []), event.message],
            }));
          }
          void refreshThreads();
          break;
        }
        case 'error': {
          cancelFlushForThread(event.threadId);
          const onScreen = event.threadId === activeThreadIdRef.current;
          setLiveTurnsByThread((prev) => ({
            ...prev,
            [event.threadId]: { ...EMPTY_TURN, error: event.message, seen: onScreen },
          }));
          void window.api.authStatus().then(setAuth);
          break;
        }
        case 'review-enforced': {
          // Mirror the main process: the draft answer was discarded, so drop the prose already
          // streamed into the live view and keep only the delegation trace.
          cancelFlushForThread(event.threadId);
          const notice =
            event.reason === 'skipped'
              ? 'No review pass in that answer — asking the reviewer before delivering…'
              : event.reason === 'unclear'
                ? `The reviewer returned no clear verdict — revising (round ${event.round ?? 1})…`
                : `The reviewer rejected that draft — revising (round ${event.round ?? 1})…`;
          setLiveTurnsByThread((prev) => {
            const current = prev[event.threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [event.threadId]: {
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
            const current = prev[event.threadId] ?? EMPTY_TURN;
            return {
              ...prev,
              [event.threadId]: {
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
      if (event.kind === 'sync-state') {
        setPendingSync(event.pendingCount);
        setSyncError(event.state === 'error' ? (event.detail ?? 'Sync failed — retrying.') : null);
        if (event.state === 'error') {
          void window.api.authStatus().then(setAuth);
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
        setMessagesByThread((prev) => {
          const msgs = prev[event.threadId];
          if (!msgs) return prev;
          return {
            ...prev,
            [event.threadId]: msgs.map((m) =>
              event.mapping[m.localId] ? { ...m, serverId: event.mapping[m.localId] } : m,
            ),
          };
        });
      }
    });
    return () => {
      cancelAllFlush();
      offAgent();
      offSync();
    };
  }, [refreshThreads]);

  const openThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    // A finished turn's live state is only ever a leftover error or stop notice, and it is retired
    // by having been read rather than by the turn ending: the first open after a background failure
    // surfaces it and marks it read, the next one clears it. A running turn keeps everything —
    // surviving a switch is the whole point of per-thread live turns.
    setLiveTurnsByThread((prev) => {
      const current = prev[threadId];
      if (!current || current.running || (!current.error && !current.notice)) return prev;
      return { ...prev, [threadId]: current.seen ? EMPTY_TURN : { ...current, seen: true } };
    });
    const msgs = await window.api.getMessages(threadId);
    setMessagesByThread((prev) => {
      // If a turn is currently running for this thread, prev[threadId] contains the in-flight
      // user message which has not been written to disk yet. Avoid clobbering in-memory messages.
      if (liveTurnsByThreadRef.current[threadId]?.running && (prev[threadId]?.length ?? 0) > 0) {
        return prev;
      }
      // Every open re-reads from disk, so a cached entry for a conversation nobody is looking at is
      // never read again — only the open thread and any with a turn still in flight are
      // load-bearing (the latter hold optimistic messages the store does not have yet). Holding the
      // rest would keep every transcript opened this session, tool results included, resident.
      const next: Record<string, ChatMessage[]> = { [threadId]: msgs };
      for (const [id, cached] of Object.entries(prev)) {
        if (id !== threadId && liveTurnsByThreadRef.current[id]?.running) next[id] = cached;
      }
      return next;
    });
    // Drop live turns that carry nothing: a clean turn-complete leaves EMPTY_TURN behind for every
    // thread that has ever run one. Anything still holding an error or an unread notice stays.
    setLiveTurnsByThread((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, turn] of Object.entries(prev)) {
        if (id === threadId) continue;
        if (!turn.running && !turn.error && !turn.notice && !turn.clarifyingQuestion && turn.blocks.length === 0) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const createThread = useCallback(async () => {
    const thread = await window.api.createThread();
    await refreshThreads();
    await openThread(thread.id);
  }, [refreshThreads, openThread]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      await window.api.deleteThread(threadId);
      setMessagesByThread((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      setLiveTurnsByThread((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      if (activeThreadIdRef.current === threadId) {
        setActiveThreadId(null);
      }
      await refreshThreads();
    },
    [refreshThreads],
  );

  const sendMessage = useCallback(
    async (text: string, promptName?: string) => {
      if (!activeThreadId) return;
      const threadId = activeThreadId;
      const userMessage: ChatMessage = {
        localId: `optimistic-${Date.now()}`,
        role: 'user',
        content: text,
        playbook: promptName,
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
        await window.api.sendMessage({ threadId, text, promptName });
      } catch (error) {
        setLiveTurnsByThread((prev) => ({
          ...prev,
          [threadId]: { ...EMPTY_TURN, error: error instanceof Error ? error.message : String(error), seen: true },
        }));
      }
    },
    [activeThreadId],
  );

  const patchThread = useCallback(
    async (threadId: string, update: Partial<ThreadMeta>) => {
      await window.api.patchThread(threadId, update);
      await refreshThreads();
    },
    [refreshThreads],
  );

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

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
          onServerSignIn={() => {
            void window.api.serverSignIn().then(() => {
              void refreshServer();
            });
          }}
          onRetryAuth={() => {
            void window.api.authStatus().then((status) => {
              setAuth(status);
              void refreshServer();
            });
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
            serverReachable={serverReachable}
            onSave={async (update) => {
              setSettings(await window.api.setSettings(update));
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
            settings={settings}
            messages={messages}
            prompts={visiblePrompts}
            profiles={profiles}
            liveTurn={liveTurn}
            onSend={sendMessage}
            onInterrupt={() => activeThreadId && void window.api.interrupt(activeThreadId)}
            onPatchThread={(update) => void patchThread(activeThread.id, update)}
            onFeedback={async (messageLocalId, rating, comment) => {
              await window.api.submitFeedback({ threadId: activeThread.id, messageLocalId, rating, comment });
              const updated = await window.api.getMessages(activeThread.id);
              setMessagesByThread((prev) => ({ ...prev, [activeThread.id]: updated }));
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

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [liveTurn, setLiveTurn] = useState<LiveTurn>(EMPTY_TURN);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [pendingSync, setPendingSync] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;

  // Stable identity so the sidebar's debounced search effect doesn't re-fire every render.
  const searchContent = useCallback((query: string) => window.api.searchThreads(query), []);

  const refreshThreads = useCallback(async () => {
    const result = await window.api.listThreads();
    setThreads(result.threads);
    setServerReachable(result.serverReachable);
  }, []);

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion);
    void window.api.getSettings().then(setSettings);
    void window.api.authStatus().then(setAuth);
    void window.api.listPrompts().then(setPrompts);
    void window.api.listOrchestratorProfiles().then(setProfiles);
    void refreshThreads();
  }, [refreshThreads]);

  // Orchestrator and reviewer playbooks are the runtime's own machinery, so they never appear in
  // the picker (see isUserSelectablePlaybook). Specialist playbooks stay pickable — they're useful
  // on their own for a quick single-agent query even though a profile also drives them.
  //
  // Sorted here rather than in each consumer, so the picker grid and the slash-autocomplete list
  // the same playbooks in the same order. The server returns them in no particular order.
  const visiblePrompts = useMemo(() => {
    const control = controlPlaybookNames(profiles);
    return prompts
      .filter((p) => isUserSelectablePlaybook(p, control))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }, [prompts, profiles]);

  useEffect(() => {
    // Live text/thinking events arrive per-token, each carrying the full accumulated string. A
    // setState per token forces a full markdown+KaTeX re-parse (O(n^2)), so we coalesce them:
    // buffer the latest value and flush to state at most once every ~80ms. Non-delta events
    // (turn-start / assistant-block / turn-complete) flush any pending value first so the rendered
    // text is always exact at block/turn boundaries.
    let pendingLiveText: string | null = null;
    let pendingLiveThinking: string | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushLive = (): void => {
      flushTimer = null;
      if (pendingLiveText === null && pendingLiveThinking === null) return;
      const text = pendingLiveText;
      const thinking = pendingLiveThinking;
      pendingLiveText = null;
      pendingLiveThinking = null;
      setLiveTurn((t) => ({
        ...t,
        ...(text !== null ? { liveText: text } : {}),
        ...(thinking !== null ? { liveThinking: thinking } : {}),
      }));
    };

    const scheduleFlush = (): void => {
      if (flushTimer === null) flushTimer = setTimeout(flushLive, 80);
    };

    const cancelFlush = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingLiveText = null;
      pendingLiveThinking = null;
    };

    const offAgent = window.api.onAgentEvent((event: AgentEvent) => {
      if ('threadId' in event && event.threadId !== activeThreadIdRef.current) {
        return;
      }
      switch (event.kind) {
        case 'turn-start':
          cancelFlush();
          setLiveTurn({ running: true, liveText: '', liveThinking: '', blocks: [] });
          break;
        case 'live-text':
          pendingLiveText = event.text;
          scheduleFlush();
          break;
        case 'live-thinking':
          pendingLiveThinking = event.text;
          scheduleFlush();
          break;
        case 'assistant-block':
          cancelFlush();
          setLiveTurn((t) => ({
            ...t,
            liveText: '',
            liveThinking: '',
            blocks: [...t.blocks, { text: event.text, thinking: event.thinking, toolCalls: event.toolCalls }],
          }));
          break;
        case 'tool-result':
          setLiveTurn((t) => ({
            ...t,
            blocks: t.blocks.map((b) => ({
              ...b,
              toolCalls: b.toolCalls.map((c) =>
                c.id === event.toolUseId ? { ...c, result: event.result, isError: event.isError } : c,
              ),
            })),
          }));
          break;
        case 'turn-complete':
          cancelFlush();
          setLiveTurn(EMPTY_TURN);
          if (!event.isError) {
            setMessages((m) => [...m, event.message]);
          } else if (event.aborted) {
            setLiveTurn({ ...EMPTY_TURN, notice: 'Processing stopped.' });
          } else {
            setLiveTurn({ ...EMPTY_TURN, error: event.errorMessage ?? 'The turn failed.' });
          }
          void refreshThreads();
          break;
        case 'error':
          cancelFlush();
          setLiveTurn({ ...EMPTY_TURN, error: event.message });
          void window.api.authStatus().then(setAuth);
          break;
        case 'review-enforced': {
          // Mirror the main process: the draft answer was discarded, so drop the prose already
          // streamed into the live view and keep only the delegation trace.
          cancelFlush();
          const notice =
            event.reason === 'skipped'
              ? 'No review pass in that answer — asking the reviewer before delivering…'
              : event.reason === 'unclear'
                ? `The reviewer returned no clear verdict — revising (round ${event.round ?? 1})…`
                : `The reviewer rejected that draft — revising (round ${event.round ?? 1})…`;
          setLiveTurn((t) => ({
            ...t,
            liveText: '',
            blocks: t.blocks.map((b) => ({ ...b, text: '' })).filter((b) => b.thinking || b.toolCalls.length > 0),
            notice,
          }));
          break;
        }
        case 'clarifying-question':
          setLiveTurn((t) => ({
            ...t,
            clarifyingQuestion: {
              toolUseId: event.toolUseId,
              question: event.question,
              options: event.options ?? [],
            },
          }));
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
      } else if (event.kind === 'server-ids' && event.threadId === activeThreadIdRef.current) {
        setMessages((msgs) =>
          msgs.map((m) => (event.mapping[m.localId] ? { ...m, serverId: event.mapping[m.localId] } : m)),
        );
      }
    });
    return () => {
      cancelFlush();
      offAgent();
      offSync();
    };
  }, [refreshThreads]);

  const openThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    setLiveTurn(EMPTY_TURN);
    setMessages(await window.api.getMessages(threadId));
  }, []);

  const createThread = useCallback(async () => {
    const thread = await window.api.createThread();
    await refreshThreads();
    await openThread(thread.id);
  }, [refreshThreads, openThread]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      await window.api.deleteThread(threadId);
      if (activeThreadIdRef.current === threadId) {
        setActiveThreadId(null);
        setMessages([]);
      }
      await refreshThreads();
    },
    [refreshThreads],
  );

  const sendMessage = useCallback(
    async (text: string, promptName?: string) => {
      if (!activeThreadId) return;
      const userMessage: ChatMessage = {
        localId: `optimistic-${Date.now()}`,
        role: 'user',
        content: text,
        playbook: promptName,
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMessage]);
      try {
        await window.api.sendMessage({ threadId: activeThreadId, text, promptName });
      } catch (error) {
        setLiveTurn({ ...EMPTY_TURN, error: error instanceof Error ? error.message : String(error) });
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
              void window.api.authStatus().then(setAuth);
              void refreshThreads();
              void window.api.listPrompts().then(setPrompts);
              void window.api.listOrchestratorProfiles().then(setProfiles);
            });
          }}
          onRetryAuth={() => {
            void window.api.authStatus().then((status) => {
              setAuth(status);
              void refreshThreads();
              void window.api.listPrompts().then(setPrompts);
              void window.api.listOrchestratorProfiles().then(setProfiles);
            });
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
              void refreshThreads();
              void window.api.listPrompts().then(setPrompts);
              void window.api.listOrchestratorProfiles().then(setProfiles);
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
              setMessages(await window.api.getMessages(activeThread.id));
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

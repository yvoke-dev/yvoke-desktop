// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import App from '../../src/renderer/src/App';
import type {
  AgentEvent,
  AppSettings,
  AuthStatus,
  ChatMessage,
  McpPromptInfo,
  SyncEvent,
  ThreadMeta,
} from '../../src/shared/types';

const PROMPTS: McpPromptInfo[] = [
  { name: 'oim-getting-started', title: 'Getting started', description: 'Onboarding.', arguments: [] },
  { name: 'oim-schema', title: 'Schema', description: 'Tables and columns.', arguments: [] },
];

function sampleSettings(): AppSettings {
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
  };
}

describe('App conversation switching with in-progress turn', () => {
  let agentListeners: Array<(event: AgentEvent) => void> = [];
  let syncListeners: Array<(event: SyncEvent) => void> = [];
  let storedThreads: ThreadMeta[] = [];
  let storedMessages: Record<string, ChatMessage[]> = {};
  let sendMessageMock: ReturnType<typeof vi.fn>;

  const emitAgent = (event: AgentEvent) => {
    act(() => {
      for (const listener of agentListeners) {
        listener(event);
      }
    });
  };

  beforeEach(() => {
    agentListeners = [];
    syncListeners = [];
    storedMessages = {};
    sendMessageMock = vi.fn().mockResolvedValue(undefined);

    const t1: ThreadMeta = {
      id: 'thread-1',
      title: 'First Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'synced',
    };
    const t2: ThreadMeta = {
      id: 'thread-2',
      title: 'Second Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T11:00:00.000Z',
      updatedAt: '2026-08-01T11:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'synced',
    };
    storedThreads = [t1, t2];

    storedMessages['thread-2'] = [
      {
        localId: 't2-u1',
        role: 'user',
        content: 'Existing question in thread 2',
        createdAt: '2026-08-01T11:00:00.000Z',
      },
      {
        localId: 't2-a1',
        role: 'assistant',
        content: 'Existing answer in thread 2',
        createdAt: '2026-08-01T11:00:05.000Z',
      },
    ];

    (window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      getAppVersion: vi.fn().mockResolvedValue('1.1.2'),
      getSettings: vi.fn().mockResolvedValue(sampleSettings()),
      setSettings: vi.fn().mockResolvedValue(sampleSettings()),
      authStatus: vi.fn().mockResolvedValue({
        claude: 'ok',
        server: { mode: 'dev', signedIn: true },
      } as AuthStatus),
      listPrompts: vi.fn().mockResolvedValue(PROMPTS),
      listOrchestratorProfiles: vi.fn().mockResolvedValue([]),
      listThreads: vi.fn().mockImplementation(async () => ({
        threads: storedThreads,
        serverReachable: true,
      })),
      createThread: vi.fn().mockImplementation(async () => {
        const newT: ThreadMeta = {
          id: `thread-${storedThreads.length + 1}`,
          title: 'New Conversation',
          model: 'sonnet',
          thinkingLevel: 'medium',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          syncState: 'synced',
        };
        storedThreads = [newT, ...storedThreads];
        return newT;
      }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      patchThread: vi.fn().mockResolvedValue(undefined),
      getMessages: vi.fn().mockImplementation(async (threadId: string) => storedMessages[threadId] ?? []),
      searchThreads: vi.fn().mockResolvedValue([]),
      validatePlaybook: vi.fn().mockResolvedValue({ plausible: true }),
      getCitation: vi.fn().mockResolvedValue('citation text'),
      sendMessage: sendMessageMock,
      interrupt: vi.fn().mockResolvedValue(undefined),
      submitClarification: vi.fn().mockResolvedValue(undefined),
      submitFeedback: vi.fn().mockResolvedValue(undefined),
      serverSignIn: vi.fn().mockResolvedValue(''),
      serverSignOut: vi.fn().mockResolvedValue(undefined),
      onAgentEvent: vi.fn().mockImplementation((listener: (event: AgentEvent) => void) => {
        agentListeners.push(listener);
        return () => {
          agentListeners = agentListeners.filter((l) => l !== listener);
        };
      }),
      onSyncEvent: vi.fn().mockImplementation((listener: (event: SyncEvent) => void) => {
        syncListeners.push(listener);
        return () => {
          syncListeners = syncListeners.filter((l) => l !== listener);
        };
      }),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('preserves user message and live streaming state when navigating away and back before turn finishes', async () => {
    render(<App />);

    // Wait for initial threads to load
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });

    // Click on First Conversation (thread-1)
    fireEvent.click(screen.getByText('First Conversation'));

    // Wait for picker to appear after messages load
    await waitFor(() => {
      expect(screen.getByText('Pick a playbook')).toBeTruthy();
    });

    const playbookBtn = screen.getByText('Getting started').closest('button')!;
    fireEvent.click(playbookBtn);

    // Type question and send
    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'How do I get started?' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    // User message should immediately appear and turn starts running
    await waitFor(() => {
      expect(screen.getByText('How do I get started?')).toBeTruthy();
    });

    // Simulate AgentService streaming turn-start and initial live-text on thread-1
    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });
    emitAgent({
      kind: 'assistant-block',
      threadId: 'thread-1',
      text: 'Here is the onboarding guide',
      toolCalls: [],
    });

    await waitFor(() => {
      expect(screen.getByText('Here is the onboarding guide')).toBeTruthy();
    });

    // Switch to Second Conversation (thread-2)
    fireEvent.click(screen.getByText('Second Conversation'));

    // Second conversation messages should be shown
    await waitFor(() => {
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
      expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();
    });
    expect(screen.queryByText('How do I get started?')).toBeNull();

    // While on thread-2, simulate background streaming progress on thread-1
    emitAgent({
      kind: 'assistant-block',
      threadId: 'thread-1',
      text: 'Here is the onboarding guide:\nStep 1: Install prerequisites.',
      toolCalls: [],
    });

    // Switch back to First Conversation (thread-1) BEFORE turn finishes
    fireEvent.click(screen.getByText('First Conversation'));

    // Verify: User question is still visible (NOT empty conversation!)
    await waitFor(() => {
      expect(screen.getByText('How do I get started?')).toBeTruthy();
    });

    // Verify: The updated streaming content from background is visible
    expect(screen.getByText(/Step 1: Install prerequisites/)).toBeTruthy();

    // Now simulate turn-complete on thread-1
    const finalAssistantMessage: ChatMessage = {
      localId: 't1-a1',
      role: 'assistant',
      content: 'Here is the onboarding guide:\nStep 1: Install prerequisites.\nStep 2: Sign in.',
      createdAt: new Date().toISOString(),
    };
    emitAgent({
      kind: 'turn-complete',
      threadId: 'thread-1',
      message: finalAssistantMessage,
      usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1500,
      isError: false,
    });

    // Verify: Both question and completed response are present
    await waitFor(() => {
      expect(screen.getByText('How do I get started?')).toBeTruthy();
      expect(screen.getByText(/Step 2: Sign in/)).toBeTruthy();
    });
  });

  it('updates background thread when turn-complete arrives while viewing a different thread', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
    });

    // Open First Conversation (thread-1)
    fireEvent.click(screen.getByText('First Conversation'));

    await waitFor(() => {
      expect(screen.getByText('Pick a playbook')).toBeTruthy();
    });
    const playbookBtn = screen.getByText('Getting started').closest('button')!;
    fireEvent.click(playbookBtn);

    // Send question
    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Question for thread 1' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getByText('Question for thread 1')).toBeTruthy();
    });

    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Switch to Second Conversation (thread-2)
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
    });

    // Turn completes on thread-1 while user is viewing thread-2
    const assistantMessage: ChatMessage = {
      localId: 't1-a1',
      role: 'assistant',
      content: 'Finished answer for thread 1',
      createdAt: new Date().toISOString(),
    };
    emitAgent({
      kind: 'turn-complete',
      threadId: 'thread-1',
      message: assistantMessage,
      usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1000,
      isError: false,
    });

    // Switch back to thread-1
    fireEvent.click(screen.getByText('First Conversation'));

    // Both question and completed answer are shown
    await waitFor(() => {
      expect(screen.getByText('Question for thread 1')).toBeTruthy();
      expect(screen.getByText('Finished answer for thread 1')).toBeTruthy();
    });
  });

  it('renders tool calls and thinking in progress after switching away and returning', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Pick a playbook')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Getting started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Show me tool call' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Switch to thread-2
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
    });

    // Background thread receives tool calls and thinking
    emitAgent({
      kind: 'assistant-block',
      threadId: 'thread-1',
      text: '',
      thinking: 'Analyzing the request thoroughly...',
      toolCalls: [
        {
          id: 'call-1',
          name: 'mcp__yvoke__search_corpus',
          input: { query: 'getting started' },
        },
      ],
    });

    // Switch back to thread-1
    fireEvent.click(screen.getByText('First Conversation'));

    await waitFor(() => {
      expect(screen.getByText('Show me tool call')).toBeTruthy();
      expect(screen.getByText(/search_corpus/)).toBeTruthy();
    });
  });

  it('displays error banner when background turn fails', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Pick a playbook')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Getting started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Switch to thread-2
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
    });

    // Background thread errors
    emitAgent({
      kind: 'error',
      threadId: 'thread-1',
      message: 'Network connection dropped unexpectedly',
    });

    // Switch back to thread-1
    fireEvent.click(screen.getByText('First Conversation'));

    await waitFor(() => {
      expect(screen.getByText('Will fail')).toBeTruthy();
      expect(screen.getByText('Network connection dropped unexpectedly')).toBeTruthy();
    });
  });

  /**
   * Regression: switching back to a thread whose turn is still running left it with no playbook.
   * `openThread` deliberately declines to refresh a running thread's messages, so nothing changed
   * identity afterwards to re-run the effect that used to mirror the playbook into state — the chip
   * stayed empty for the rest of the turn. Needs a playbook selected on the thread being LEFT, since
   * that is the stale value the effect read.
   */
  it('keeps the playbook chip when returning to a thread whose turn is still running', async () => {
    storedMessages['thread-2'] = [
      {
        localId: 't2-u1',
        role: 'user',
        content: 'Existing question in thread 2',
        playbook: 'oim-schema',
        createdAt: '2026-08-01T11:00:00.000Z',
      },
    ];
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
    fireEvent.click(screen.getByText('Getting started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Q1' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(screen.getByText('Q1')).toBeTruthy());
    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Away to a conversation under a DIFFERENT playbook, then back mid-turn.
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(container.querySelector('.active-playbook')?.textContent).toContain('Schema'));
    fireEvent.click(screen.getByText('First Conversation'));

    await waitFor(() =>
      expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started'),
    );
  });

  /**
   * A banner is retired by having been READ, not by the turn ending. These two cases pull in opposite
   * directions and are why the `seen` flag exists: a stop the user watched must not follow them back,
   * and a background failure they never saw must survive the switch that first shows it.
   */
  it('retires a stop notice the user already saw, on the next visit', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });
    emitAgent({
      kind: 'turn-complete',
      threadId: 'thread-1',
      message: { localId: 't1-a1', role: 'assistant', content: '', createdAt: '' },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1,
      isError: true,
      aborted: true,
    });
    // Raised while the thread is on screen, so it has been read.
    await waitFor(() => expect(screen.getByText('Processing stopped.')).toBeTruthy());

    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(screen.getByText('Existing question in thread 2')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    expect(screen.queryByText('Processing stopped.')).toBeNull();
  });

  it('surfaces an unseen background failure on the first return, and retires it on the second', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(screen.getByText('Existing question in thread 2')).toBeTruthy());

    // Fails while the user is looking at another conversation entirely.
    emitAgent({ kind: 'error', threadId: 'thread-1', message: 'Network connection dropped' });

    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Network connection dropped')).toBeTruthy());

    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(screen.getByText('Existing question in thread 2')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    expect(screen.queryByText('Network connection dropped')).toBeNull();
  });
});


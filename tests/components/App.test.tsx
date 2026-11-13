// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import App from '../../src/renderer/src/App';
import type { ChatView as ChatViewType } from '../../src/renderer/src/components/ChatView';
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

let latestChatViewProps: React.ComponentProps<typeof ChatViewType> | null = null;

vi.mock('../../src/renderer/src/components/ChatView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/components/ChatView')>();
  return {
    ...actual,
    ChatView: (props: React.ComponentProps<typeof actual.ChatView>) => {
      latestChatViewProps = props;
      return actual.ChatView(props);
    },
  };
});

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
    latestChatViewProps = null;
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
        threads: storedThreads.map((t) => ({ ...t })),
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
      submitClarification: vi.fn().mockResolvedValue(true),
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

    const playbookBtn = screen.getByText('oim-getting-started').closest('button')!;
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

  it('takes the posted question back down when the send is rejected', async () => {
    sendMessageMock.mockRejectedValueOnce(new Error('Image attachment "huge.png" exceeds the 5MB size limit.'));
    render(<App />);

    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
    fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Look at this screenshot' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    // The failure is reported, and the message that will never be answered is gone with it.
    await waitFor(() => expect(screen.getByText(/exceeds the 5MB size limit/)).toBeTruthy());
    expect(screen.queryByText('Look at this screenshot')).toBeNull();
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
    const playbookBtn = screen.getByText('oim-getting-started').closest('button')!;
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
    fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Show me tool call' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

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
    fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

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
    fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Q1' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(screen.getByText('Q1')).toBeTruthy());
    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Away to a conversation under a DIFFERENT playbook, then back mid-turn.
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(container.querySelector('.active-playbook')?.textContent).toContain('oim-schema'));
    fireEvent.click(screen.getByText('First Conversation'));

    await waitFor(() =>
      expect(container.querySelector('.active-playbook')?.textContent).toContain('oim-getting-started'),
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

  it('Test 1.10: patchThread invokes refreshThreads in finally block even if window.api.patchThread rejects', async () => {
    const patchSpy = vi
      .fn()
      .mockRejectedValue(new Error('Cannot change agent mode while a turn is in progress'));
    (window as unknown as { api: Record<string, unknown> }).api.patchThread = patchSpy;
    const listThreadsSpy = vi.spyOn((window as unknown as { api: any }).api, 'listThreads');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeTruthy());

    const initialListCalls = listThreadsSpy.mock.calls.length;

    const modelSelect = screen.getByLabelText('Model');
    fireEvent.change(modelSelect, { target: { value: 'opus' } });

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(listThreadsSpy.mock.calls.length).toBeGreaterThan(initialListCalls);
    });

    expect(warnSpy).toHaveBeenCalledWith('Failed to patch thread:', expect.any(Error));
    warnSpy.mockRestore();
  });

  it('Task 3.5: clears liveTurn.clarifyingQuestion and restores composer placeholder on tool-result for matching toolUseId', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    // Start a turn and dispatch assistant-block with clarification tool call
    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });
    emitAgent({
      kind: 'assistant-block',
      threadId: 'thread-1',
      text: '',
      toolCalls: [
        {
          id: 'tu-clarif-1',
          name: 'AskUserQuestion',
          input: { question: 'Which branch?' },
        },
      ],
    });

    // Dispatch clarifying-question event
    emitAgent({
      kind: 'clarifying-question',
      threadId: 'thread-1',
      toolUseId: 'tu-clarif-1',
      question: 'Which branch?',
      options: [{ label: 'main' }],
    });

    const textarea = container.querySelector('textarea')!;
    await waitFor(() => {
      expect(textarea.placeholder).toBe('Awaiting clarification…');
    });
    expect(screen.getByText('Clarification required')).toBeTruthy();

    // Dispatch tool-result for a NON-matching toolUseId -> clarifyingQuestion must NOT be cleared
    emitAgent({
      kind: 'tool-result',
      threadId: 'thread-1',
      toolUseId: 'other-tool-id',
      result: 'some other result',
      isError: false,
    });

    expect(textarea.placeholder).toBe('Awaiting clarification…');

    // Dispatch tool-result for the MATCHING toolUseId -> clarifyingQuestion must be cleared!
    emitAgent({
      kind: 'tool-result',
      threadId: 'thread-1',
      toolUseId: 'tu-clarif-1',
      result: 'User answered: main',
      isError: false,
    });

    await waitFor(() => {
      expect(textarea.placeholder).not.toBe('Awaiting clarification…');
    });
  });

  it('rejection sync: removes optimistic message, surfaces error, re-enables composer, and locks UI on send rejection', async () => {
    (window as unknown as { api: any }).api.listOrchestratorProfiles = vi.fn().mockResolvedValue([
      {
        name: 'OIM',
        orchestratorPlaybook: 'oim-orchestrator',
        reviewerPlaybook: 'oim-orchestrator-reviewer',
        specialistPlaybooks: [],
      },
    ]);
    const sendRejectError = new Error('Message sending failed');
    (window as unknown as { api: any }).api.sendMessage = vi.fn().mockImplementation(async () => {
      const t1 = storedThreads.find((t) => t.id === 'thread-1');
      if (t1) {
        t1.hasStarted = true;
        t1.initialPlaybook = 'oim-schema';
      }
      throw sendRejectError;
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    const schemaBtn = screen.getByText('oim-schema').closest('button')!;
    fireEvent.click(schemaBtn);

    const textarea = await screen.findByPlaceholderText(/Add your question/);
    fireEvent.change(textarea, { target: { value: 'Why did the table fail?' } });

    // Verify Agent mode and remove playbook button are enabled before sending
    const agentModeSelect = screen.getByLabelText('Agent mode') as HTMLSelectElement;
    expect(agentModeSelect.disabled).toBe(false);
    expect(document.querySelector('.active-playbook-remove')).not.toBeNull();

    const listThreadsSpy = vi.spyOn((window as unknown as { api: any }).api, 'listThreads');
    const initialListCalls = listThreadsSpy.mock.calls.length;

    const sendBtn = screen.getByRole('button', { name: /Send/i });
    fireEvent.click(sendBtn);

    // 1. Optimistic message is removed from transcript on rejection
    await waitFor(() => {
      expect(screen.queryByText('Why did the table fail?')).toBeNull();
    });

    // 2. Error notice is surfaced in error banner
    await waitFor(() => {
      expect(screen.getByText('Message sending failed')).toBeTruthy();
    });

    // 3. Composer controls re-enable
    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);

    // 4. listThreads was called on rejection and UI immediately reflects the lock
    await waitFor(() => {
      expect(listThreadsSpy.mock.calls.length).toBeGreaterThan(initialListCalls);
    });
    await waitFor(() => {
      expect(agentModeSelect.disabled).toBe(true);
    });
    expect(agentModeSelect.closest('.composer-select-wrapper')?.getAttribute('data-tip')).toBe(
      'Agent mode cannot be changed once a conversation has started',
    );
    expect(screen.getByText('oim-schema')).toBeTruthy();
    expect(document.querySelector('.active-playbook-remove')).toBeNull();
  });

  it('updates reviewer card with Rejected verdict badge in real-time when tool-result arrives during live turn', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));

    // Start live turn on thread-1
    emitAgent({ kind: 'turn-start', threadId: 'thread-1' });

    // Orchestrator delegates to reviewer
    emitAgent({
      kind: 'assistant-block',
      threadId: 'thread-1',
      text: '',
      toolCalls: [
        {
          id: 'call-rev-1',
          name: 'Agent',
          subagentType: 'reviewer',
          input: { prompt: 'Verify candidate answer' },
        },
      ],
    });

    // Reviewer finishes and emits tool-result
    emitAgent({
      kind: 'tool-result',
      threadId: 'thread-1',
      toolUseId: 'call-rev-1',
      result: 'REJECTED\nUnsupported claims found.',
      isError: false,
    });

    await waitFor(() => {
      expect(screen.getByText('Reviewer')).toBeTruthy();
      expect(screen.getByText('Rejected')).toBeTruthy();
      expect(document.querySelector('.subagent-card .tool-status.error')).not.toBeNull();
      expect(document.querySelector('.subagent-card .tool-status.ok')).toBeNull();
    });
  });

  it('sorts visiblePrompts by canonical playbook name rather than title', async () => {
    (window as unknown as { api: any }).api.listPrompts = vi.fn().mockResolvedValue([
      { name: 'oim-beta', title: 'Alpha', description: 'Second by name.', arguments: [] },
      { name: 'oim-alpha', title: 'Zebra', description: 'First by name.', arguments: [] },
    ]);

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    const pickerTitles = Array.from(container.querySelectorAll('.picker-row-title')).map(
      (el) => el.textContent,
    );
    expect(pickerTitles).toEqual(['oim-alpha', 'oim-beta']);
  });

  it('continues polling listPrompts every 10s when serverReachable is true but prompts is empty, stops once prompts loads, keeps IPC listeners registered once, and cleans up interval on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listPromptsMock = vi
        .fn()
        .mockResolvedValueOnce([]) // initial mount: empty catalogue (e.g. /mcp startup timeout)
        .mockResolvedValueOnce([]) // 1st 10s retry: still empty
        .mockResolvedValue(PROMPTS); // 2nd 10s retry: catalogue recovered!
      (window as unknown as { api: any }).api.listPrompts = listPromptsMock;

      const onAgentEventSpy = (window as unknown as { api: any }).api.onAgentEvent;
      const onSyncEventSpy = (window as unknown as { api: any }).api.onSyncEvent;

      const { unmount } = render(<App />);

      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
      expect(listPromptsMock).toHaveBeenCalledTimes(1);
      expect(onAgentEventSpy).toHaveBeenCalledTimes(1);
      expect(onSyncEventSpy).toHaveBeenCalledTimes(1);

      // Advance 10s -> triggers 1st retry (still returns [])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(listPromptsMock).toHaveBeenCalledTimes(2));

      // Advance another 10s -> triggers 2nd retry (returns PROMPTS)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await waitFor(() => expect(listPromptsMock).toHaveBeenCalledTimes(3));

      // Open First Conversation -> playbook picker now shows the recovered playbooks!
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
      expect(screen.getByText('oim-getting-started')).toBeTruthy();

      // Crucial: updating `prompts` state must NOT have changed `refreshThreads` identity or re-registered IPC listeners
      expect(onAgentEventSpy).toHaveBeenCalledTimes(1);
      expect(onSyncEventSpy).toHaveBeenCalledTimes(1);
      expect(agentListeners).toHaveLength(1);
      expect(syncListeners).toHaveLength(1);

      // Advance another 20s -> polling has stopped now that prompts.length > 0
      const callsAfterRecovery = listPromptsMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(listPromptsMock).toHaveBeenCalledTimes(callsAfterRecovery);

      // Unmount while polling is active (test unmount cleanup)
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the 10s empty-catalogue polling interval on unmount and re-fetches prompts when refreshThreads runs while prompts is empty', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listPromptsMock = vi
        .fn()
        .mockResolvedValueOnce([]) // initial mount: empty
        .mockResolvedValue(PROMPTS); // subsequent call via refreshThreads (e.g. sync-state synced) recovers prompts
      (window as unknown as { api: any }).api.listPrompts = listPromptsMock;

      const { unmount } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
      expect(listPromptsMock).toHaveBeenCalledTimes(1);

      // Trigger refreshThreads via a sync-state: 'synced' event before the 10s timer fires
      act(() => {
        for (const l of syncListeners) {
          l({ kind: 'sync-state', threadId: 'thread-1', state: 'synced', pendingCount: 0 });
        }
      });

      await waitFor(() => expect(listPromptsMock).toHaveBeenCalledTimes(2));

      // Also verify unmount cleans up active interval when prompts is still empty
      listPromptsMock.mockReset();
      listPromptsMock.mockResolvedValue([]);
      unmount();

      const { unmount: unmount2 } = render(<App />);
      await waitFor(() => expect(listPromptsMock).toHaveBeenCalledTimes(1));
      unmount2();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(listPromptsMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates pendingSync banner immediately on mount from listThreads().pendingSyncCount including when serverReachable is false', async () => {
    (window as unknown as { api: Record<string, unknown> }).api.listThreads = vi.fn().mockResolvedValue({
      threads: storedThreads.map((t) => ({ ...t })),
      serverReachable: false,
      pendingSyncCount: 4,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Server unreachable:/i)).toBeTruthy();
      expect(screen.getByText(/4 turns waiting to sync to the server/i)).toBeTruthy();
    });
  });

  it('keeps sticky droppedSyncError banner visible across sibling sync-state synced events until Dismiss is clicked while clearing transient syncError', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    // 1. Transient error on thread-2 shows inside pendingSync info banner
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'error',
          pendingCount: 2,
          detail: 'Temporary network blip',
        });
      }
    });
    await waitFor(() => {
      expect(screen.getByText(/2 turns waiting to sync to the server — Temporary network blip/i)).toBeTruthy();
    });

    // 2. Permanent 4xx drop on thread-1 raises sticky droppedSyncError banner
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'error',
          dropped: true,
          pendingCount: 1,
          detail: 'A queued turn in "First Conversation" was rejected (HTTP 422).',
        });
      }
    });
    await waitFor(() => {
      expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 422');
      expect(screen.getByText(/1 turn waiting to sync to the server/i)).toBeTruthy();
    });

    // 3. Sibling thread-2 finishes syncing -> clears pendingSync & transient syncError, keeps droppedSyncError sticky
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-2', state: 'synced', pendingCount: 0 });
      }
    });
    await waitFor(() => {
      expect(screen.queryByText(/waiting to sync to the server/i)).toBeNull();
    });
    expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 422');

    // 4. Clicking Dismiss clears droppedSyncError
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container.querySelector('.banner.error')).toBeNull();
  });

  it('updates sidebar row sync-dot in place on pending and error sync-state events without calling listThreads()', async () => {
    const listThreadsMock = (window as unknown as { api: { listThreads: ReturnType<typeof vi.fn> } }).api.listThreads;
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });
    const initialListCalls = listThreadsMock.mock.calls.length;

    const getRowDot = (title: string): Element | null =>
      screen.getByText(title).closest('.thread-item')?.querySelector('.sync-dot') ?? null;

    expect(getRowDot('First Conversation')).toBeNull();
    expect(getRowDot('Second Conversation')).toBeNull();

    // Pending sync-state on thread-1 updates row to .sync-dot.pending in place WITHOUT calling listThreads()
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-1', state: 'pending', pendingCount: 2 });
      }
    });
    expect(getRowDot('First Conversation')?.classList.contains('pending')).toBe(true);
    expect(getRowDot('Second Conversation')).toBeNull();
    expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls);
    expect(screen.getByText(/2 turns waiting to sync to the server…/i)).toBeTruthy();

    // Unchanged syncState ('pending' again on thread-1) and unknown threadId are safe no-ops
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-1', state: 'pending', pendingCount: 2 });
        l({ kind: 'sync-state', threadId: 'non-existent', state: 'pending', pendingCount: 2 });
      }
    });
    expect(getRowDot('First Conversation')?.classList.contains('pending')).toBe(true);
    expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls);

    // Error sync-state on thread-2 updates thread-2 row to .sync-dot.error AND sets transient syncError
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'error',
          pendingCount: 1,
          detail: 'Retry failed',
        });
      }
    });
    expect(getRowDot('Second Conversation')?.classList.contains('error')).toBe(true);
    expect(screen.getByText(/1 turn waiting to sync to the server — Retry failed/i)).toBeTruthy();
  });

  it('preserves transient syncError detail when an unacknowledged post-scan pending sync-state arrives', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });

    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'error',
          pendingCount: 1,
          detail: 'Retry failed',
        });
      }
    });
    expect(screen.getByText(/1 turn waiting to sync to the server — Retry failed/i)).toBeTruthy();

    // Post-scan pending sync-state with pendingCount > 0 (omitting acked) MUST NOT clear transient syncError
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-1', state: 'pending', pendingCount: 3 });
      }
    });
    expect(screen.getByText(/3 turns waiting to sync to the server — Retry failed/i)).toBeTruthy();
  });

  it('skips refreshThreads on synthetic count-only threadId === "" synced event while refreshing on real threadId synced event', async () => {
    const listThreadsMock = (window as unknown as { api: { listThreads: ReturnType<typeof vi.fn> } }).api.listThreads;
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });
    const initialListCalls = listThreadsMock.mock.calls.length;

    const getRowDot = (title: string): Element | null =>
      screen.getByText(title).closest('.thread-item')?.querySelector('.sync-dot') ?? null;

    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-1', state: 'pending', pendingCount: 2 });
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'error',
          pendingCount: 2,
          detail: 'Retry failed',
        });
      }
    });

    // Synthetic count-only { threadId: '', state: 'synced', pendingCount: 0 } clears pendingSync & syncError, preserves row indicators, and adds +0 listThreads calls
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: '', state: 'synced', pendingCount: 0 });
      }
    });
    expect(screen.queryByText(/waiting to sync to the server/i)).toBeNull();
    expect(getRowDot('Second Conversation')?.classList.contains('error')).toBe(true);
    expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls);

    // Real { threadId: 'thread-1', state: 'synced', pendingCount: 0 } clears thread-1 dot and triggers +1 refreshThreads() call
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'sync-state', threadId: 'thread-1', state: 'synced', pendingCount: 0 });
      }
    });
    await waitFor(() => {
      expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls + 1);
    });
    expect(getRowDot('First Conversation')).toBeNull();
  });

  it('ignores sync-state events targeting a conversation already removed by thread-deleted', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });

    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-deleted', threadId: 'thread-2' });
        l({ kind: 'sync-state', threadId: 'thread-2', state: 'pending', pendingCount: 1 });
      }
    });
    expect(screen.queryByText('Second Conversation')).toBeNull();
  });

  it('updates sidebar and active ChatView in place across chained r1 -> r2 thread-recreated events while preserving composer draft, clearing stale serverIds, and routing actions to immutable thread.id', async () => {
    storedMessages['thread-2'] = [
      {
        localId: 't2-u1',
        serverId: 'stale-srv-u1',
        role: 'user',
        content: 'Existing question in thread 2',
        playbook: 'oim-schema',
        createdAt: '2026-08-01T11:00:00.000Z',
      },
      {
        localId: 't2-a1',
        serverId: 'stale-srv-a1',
        role: 'assistant',
        content: 'Existing answer in thread 2',
        createdAt: '2026-08-01T11:00:05.000Z',
      },
    ];

    (window as unknown as { api: Record<string, unknown> }).api.getSettings = vi
      .fn()
      .mockResolvedValue({ ...sampleSettings(), models: ['sonnet', 'opus'] });
    const patchSpy = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api.patchThread;
    const interruptSpy = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api.interrupt;

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());

    // Open thread-2 and type a draft in the composer
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());
    expect(Object.keys(latestChatViewProps ?? {}).sort()).toEqual([
      'liveTurn',
      'messages',
      'onFeedback',
      'onInterrupt',
      'onPatchThread',
      'onSend',
      'profiles',
      'prompts',
      'settings',
      'thread',
    ]);
    expect(latestChatViewProps?.thread.id).toBe('thread-2');
    expect(latestChatViewProps?.messages.map((m) => m.serverId)).toEqual(['stale-srv-u1', 'stale-srv-a1']);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Unsent follow-up across chained recreation' } });

    // Chained 404 recreations on immutable thread-2: remoteConversationId 'r1' -> 'r2'
    const recreatedR1: ThreadMeta = {
      ...storedThreads[1],
      id: 'thread-2',
      remoteConversationId: 'r1',
      title: 'Second Conversation',
      initialPlaybook: 'oim-schema',
      hasStarted: true,
      syncState: 'pending',
    };
    const recreatedR2: ThreadMeta = {
      ...recreatedR1,
      id: 'thread-2',
      remoteConversationId: 'r2',
      title: 'Second Conversation (Recreated)',
      syncState: 'synced',
    };
    storedThreads = [storedThreads[0], recreatedR2];
    storedMessages['thread-2'] = storedMessages['thread-2'].map(({ serverId: _s, ...rest }) => rest);

    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: recreatedR1 });
      }
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: recreatedR2 });
      }
    });

    // Sidebar updated in place without duplicate rows, activeThreadId & thread.id unchanged, composer draft survived!
    await waitFor(() => {
      expect(screen.getAllByText('Second Conversation (Recreated)').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText('Second Conversation')).toBeNull();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Unsent follow-up across chained recreation',
    );
    expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();
    expect(latestChatViewProps?.thread.id).toBe('thread-2');
    expect(latestChatViewProps?.thread.remoteConversationId).toBe('r2');
    expect(latestChatViewProps?.messages.map((m) => m.serverId)).toEqual([undefined, undefined]);

    // Fresh server-ids event on thread-2 maps cleanly
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'server-ids', threadId: 'thread-2', mapping: { 't2-a1': 'fresh-srv-a1' } });
      }
    });
    await waitFor(() => {
      expect(latestChatViewProps?.messages.map((m) => m.serverId)).toEqual([undefined, 'fresh-srv-a1']);
    });

    // Patching model routes to immutable thread-2
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
    await waitFor(() => expect(patchSpy).toHaveBeenCalledWith('thread-2', { model: 'opus' }));

    // Sending follow-up routes to immutable thread-2
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-2',
          text: 'Unsent follow-up across chained recreation',
          promptName: 'oim-schema',
        }),
      );
    });

    // Interrupting live turn routes to immutable thread-2
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }));
    expect(interruptSpy).toHaveBeenCalledWith('thread-2');
  });

  it('inserts late-discovered orphan conversations on thread-recreated sorted by updatedAt descending without stealing active focus or composer draft', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());

    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Unsent follow-up while orphans arrive' } });

    const orphanMiddle: ThreadMeta = {
      id: 'orphan-mid',
      title: 'Middle Orphan Chat',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:30:00.000Z',
      updatedAt: '2026-08-01T10:30:00.000Z',
      totals: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'pending',
      hasStarted: true,
    };
    const orphanNewest: ThreadMeta = {
      id: 'orphan-newest',
      title: 'Newest Orphan Chat',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T12:30:00.000Z',
      updatedAt: '2026-08-01T12:30:00.000Z',
      totals: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'pending',
      hasStarted: true,
    };
    storedThreads = [orphanNewest, storedThreads[1], orphanMiddle, storedThreads[0]];

    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: orphanMiddle });
        l({ kind: 'thread-recreated', thread: orphanNewest });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Newest Orphan Chat')).toBeTruthy();
      expect(screen.getByText('Middle Orphan Chat')).toBeTruthy();
    });
    const sidebarTitles = Array.from(container.querySelectorAll('.thread-title')).map((el) => el.textContent);
    expect(sidebarTitles).toEqual([
      'Newest Orphan Chat',
      'Second Conversation',
      'Middle Orphan Chat',
      'First Conversation',
    ]);
    expect(latestChatViewProps?.thread.id).toBe('thread-2');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Unsent follow-up while orphans arrive',
    );
  });

  it('completes in-flight validatePlaybook and sends to immutable thread.id when thread-recreated arrives mid-preflight', async () => {
    let resolvePreflight!: (v: { plausible: boolean }) => void;
    (window as unknown as { api: Record<string, unknown> }).api.validatePlaybook = vi.fn().mockImplementation(
      () =>
        new Promise<{ plausible: boolean }>((resolve) => {
          resolvePreflight = resolve;
        }),
    );

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
    fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'First question during preflight recreation' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => expect(container.querySelector('.preflight-checking')).not.toBeNull());

    const recreated1: ThreadMeta = {
      ...storedThreads[0],
      id: 'thread-1',
      remoteConversationId: 'remote-1-recreated',
      title: 'First Conversation (Recreated)',
    };
    storedThreads = [recreated1, storedThreads[1]];

    // Emit thread-recreated AND resolve validatePlaybook in the same synchronous turn
    await act(async () => {
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: recreated1 });
      }
      resolvePreflight({ plausible: true });
    });

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-1',
          text: 'First question during preflight recreation',
          promptName: 'oim-getting-started',
        }),
      );
    });
    expect(latestChatViewProps?.thread.id).toBe('thread-1');
    expect(latestChatViewProps?.thread.remoteConversationId).toBe('remote-1-recreated');
  });

  it('ignores thread-recreated arriving after thread-deleted or deleteThread for the same thread.id (deletedIdsRef prevents resurrection)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const { container } = render(<App />);
      await waitFor(() => {
        expect(screen.getByText('First Conversation')).toBeTruthy();
        expect(screen.getByText('Second Conversation')).toBeTruthy();
      });

      const deletedT1Snapshot = { ...storedThreads[0] };
      const deletedT2Snapshot = { ...storedThreads[1] };

      // 1. Sweep deletes thread-1 via thread-deleted event
      storedThreads = [storedThreads[1]];
      act(() => {
        for (const l of syncListeners) {
          l({ kind: 'thread-deleted', threadId: 'thread-1' });
        }
      });
      await waitFor(() => expect(screen.queryByText('First Conversation')).toBeNull());

      // Late thread-recreated for thread-1 arrives -> must NOT resurrect in sidebar
      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'thread-recreated',
            thread: {
              ...deletedT1Snapshot,
              remoteConversationId: 'resurrected-r1',
              title: 'Resurrected Ghost 1',
            },
          });
        }
      });
      expect(screen.queryByText('Resurrected Ghost 1')).toBeNull();
      expect(screen.queryByText('First Conversation')).toBeNull();

      // 2. User deletes thread-2 via sidebar delete button
      storedThreads = [];
      const row2 = container.querySelector('.thread-item')!;
      fireEvent.click(row2.querySelector('.thread-delete') as HTMLButtonElement);
      await waitFor(() => expect(screen.queryByText('Second Conversation')).toBeNull());

      // Late thread-recreated for thread-2 arrives -> must NOT resurrect in sidebar
      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'thread-recreated',
            thread: {
              ...deletedT2Snapshot,
              remoteConversationId: 'resurrected-r2',
              title: 'Resurrected Ghost 2',
            },
          });
        }
      });
      expect(screen.queryByText('Resurrected Ghost 2')).toBeNull();
      expect(screen.getByText('No conversations yet.')).toBeTruthy();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('handles thread-deleted: removes swept empty conversation from sidebar, clears cached messages, and transitions activeThreadId cleanly', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('First Conversation')).toBeTruthy();
      expect(screen.getByText('Second Conversation')).toBeTruthy();
    });

    // Open thread-1 (empty desktop conversation)
    fireEvent.click(screen.getByText('First Conversation'));
    await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

    // Emit thread-deleted for thread-1 -> sidebar removes it and activeThreadId falls back to thread-2
    storedThreads = [storedThreads[1]];
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-deleted', threadId: 'thread-1' });
      }
    });

    await waitFor(() => {
      expect(screen.queryByText('First Conversation')).toBeNull();
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
    });

    // Emit thread-deleted for the last remaining thread (thread-2) -> falls back to empty state
    storedThreads = [];
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-deleted', threadId: 'thread-2' });
      }
    });

    await waitFor(() => {
      expect(screen.queryByText('Second Conversation')).toBeNull();
      expect(screen.getByText('No conversations yet.')).toBeTruthy();
    });
  });

  it('discards late getMessages resolve and ignores late getMessages reject when thread-deleted arrives during in-flight openThread', async () => {
    let resolveThread1Msgs!: (msgs: ChatMessage[]) => void;
    let rejectThread2Msgs!: (err: Error) => void;

    const t3: ThreadMeta = {
      id: 'thread-3',
      title: 'Third Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'synced',
    };
    storedThreads = [...storedThreads, t3];

    (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
      .fn()
      .mockImplementation((id: string) => {
        if (id === 'thread-1') {
          return new Promise<ChatMessage[]>((res) => {
            resolveThread1Msgs = res;
          });
        }
        if (id === 'thread-2') {
          return new Promise<ChatMessage[]>((_res, rej) => {
            rejectThread2Msgs = rej;
          });
        }
        return Promise.resolve([]);
      });

    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    // Click thread-1 -> getMessages('thread-1') in flight -> thread-deleted('thread-1') arrives -> late resolve discarded
    fireEvent.click(screen.getByText('First Conversation'));
    storedThreads = storedThreads.filter((t) => t.id !== 'thread-1');
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-deleted', threadId: 'thread-1' });
      }
    });
    await act(async () => {
      resolveThread1Msgs([
        { localId: 'ghost-1', role: 'assistant', content: 'Ghost message from deleted thread 1', createdAt: '' },
      ]);
    });
    expect(screen.queryByText('Ghost message from deleted thread 1')).toBeNull();
    expect(screen.queryByText('First Conversation')).toBeNull();

    // thread-2 started fallback openThread('thread-2') -> thread-deleted('thread-2') arrives -> late reject causes zero unhandled errors
    storedThreads = storedThreads.filter((t) => t.id !== 'thread-2');
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-deleted', threadId: 'thread-2' });
      }
    });
    await act(async () => {
      rejectThread2Msgs(new Error('ENOENT deleted thread-2'));
    });
    expect(screen.queryByText('Second Conversation')).toBeNull();
  });

  it('strips stale pre-recreation serverIds and routes feedback to immutable thread.id when thread-recreated arrives during in-flight openThread', async () => {
    let resolveRecreatingMsgs!: (msgs: ChatMessage[]) => void;

    const t3: ThreadMeta = {
      id: 'thread-3',
      title: 'Third Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'synced',
    };
    storedThreads = [...storedThreads, t3];

    (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
      .fn()
      .mockImplementation((id: string) => {
        if (id === 'thread-3') {
          return new Promise<ChatMessage[]>((res) => {
            resolveRecreatingMsgs = res;
          });
        }
        return Promise.resolve([]);
      });

    const submitFeedbackSpy = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api
      .submitFeedback;

    render(<App />);
    await waitFor(() => expect(screen.getByText('Third Conversation')).toBeTruthy());

    fireEvent.click(screen.getByText('Third Conversation'));

    // thread-3 has getMessages('thread-3') in flight -> thread-recreated arrives BEFORE getMessages resolves
    const recreatedT3: ThreadMeta = {
      ...t3,
      id: 'thread-3',
      remoteConversationId: 'remote-3-recreated',
      title: 'Third Conversation',
    };
    storedThreads = [...storedThreads.slice(0, 2), recreatedT3];
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: recreatedT3 });
      }
    });

    await act(async () => {
      resolveRecreatingMsgs([
        {
          localId: 't3-u1',
          serverId: 'stale-old-server-id',
          role: 'user',
          content: 'Question in thread 3',
          playbook: 'oim-schema',
          createdAt: '',
        },
        {
          localId: 't3-a1',
          serverId: 'stale-old-assistant-id',
          role: 'assistant',
          content: 'Answer in thread 3 after recreation',
          createdAt: '',
        },
      ]);
    });

    await waitFor(() => {
      expect(screen.getByText('Answer in thread 3 after recreation')).toBeTruthy();
    });
    expect(latestChatViewProps?.thread.id).toBe('thread-3');
    expect(latestChatViewProps?.thread.remoteConversationId).toBe('remote-3-recreated');
    expect(latestChatViewProps?.messages.map((m) => m.serverId)).toEqual([undefined, undefined]);

    // Submitting feedback routes to immutable 'thread-3'
    submitFeedbackSpy.mockRejectedValueOnce(new Error('Message has not synced to the server yet'));
    const goodAnswerBtn = document.querySelector('.feedback .icon-button') as HTMLButtonElement;
    fireEvent.click(goodAnswerBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => {
      expect(submitFeedbackSpy).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-3', messageLocalId: 't3-a1', rating: 1 }),
      );
    });
  });

  it('preserves sidebar row, messagesByThread, and rating controls when deleteThread or submitFeedback rejects', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      (window as unknown as { api: Record<string, unknown> }).api.deleteThread = vi
        .fn()
        .mockRejectedValueOnce(new Error('HTTP 503 Unavailable'));
      (window as unknown as { api: Record<string, unknown> }).api.submitFeedback = vi
        .fn()
        .mockRejectedValueOnce(new Error('Message has not synced to the server yet — try again in a moment'));

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());

      // Open Second Conversation so messagesByThread['thread-2'] is populated
      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());

      // (a) Click delete on Second Conversation -> deleteThread rejects -> sidebar row & messages remain intact
      const activeRow = container.querySelector('.thread-item.active')!;
      const deleteBtn = activeRow.querySelector('.thread-delete') as HTMLButtonElement;
      fireEvent.click(deleteBtn);

      await waitFor(() => expect(warnSpy).toHaveBeenCalled());
      expect(screen.getAllByText('Second Conversation').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
      expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();

      // (b) Click Good answer feedback -> submitFeedback rejects -> error displayed in dialog, buttons re-enable, transcript intact
      const thumbsUpBtn = container.querySelector('.feedback .icon-button') as HTMLButtonElement;
      fireEvent.click(thumbsUpBtn);
      const submitBtn = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(
          screen.getByText('Message has not synced to the server yet — try again in a moment'),
        ).toBeTruthy();
      });
      expect(submitBtn.disabled).toBe(false);
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();
    } finally {
      confirmSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('unmounts cleanly while listThreads retry and getMessages are pending: unsubscribes IPC listeners once, clears 10s interval, and ignores post-unmount getMessages / thread-recreated completions', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let rejectPendingListThreads!: (err: Error) => void;
      let resolvePendingGetMessages!: (msgs: ChatMessage[]) => void;
      let rejectPendingGetMessages!: (err: Error) => void;
      let capturedSyncListener: ((event: SyncEvent) => void) | null = null;

      const listThreadsMock = vi
        .fn()
        .mockResolvedValueOnce({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: false,
          pendingSyncCount: 1,
        })
        .mockImplementationOnce(
          () =>
            new Promise((_res, rej) => {
              rejectPendingListThreads = rej;
            }),
        );
      (window as unknown as { api: Record<string, unknown> }).api.listThreads = listThreadsMock;
      (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<ChatMessage[]>((res) => {
              resolvePendingGetMessages = res;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<ChatMessage[]>((_res, rej) => {
              rejectPendingGetMessages = rej;
            }),
        );

      const offAgentSpy = vi.fn();
      const offSyncSpy = vi.fn();
      (window as unknown as { api: Record<string, unknown> }).api.onAgentEvent = vi
        .fn()
        .mockImplementation((listener: (event: AgentEvent) => void) => {
          agentListeners.push(listener);
          return () => {
            offAgentSpy();
            agentListeners = agentListeners.filter((l) => l !== listener);
          };
        });
      (window as unknown as { api: Record<string, unknown> }).api.onSyncEvent = vi
        .fn()
        .mockImplementation((listener: (event: SyncEvent) => void) => {
          capturedSyncListener = listener;
          syncListeners.push(listener);
          return () => {
            offSyncSpy();
            syncListeners = syncListeners.filter((l) => l !== listener);
          };
        });

      const { unmount } = render(<App />);
      await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());

      // Start pending getMessages() resolutions and rejections
      fireEvent.click(screen.getByText('First Conversation'));
      fireEvent.click(screen.getByText('Second Conversation'));

      // Advance 10s so retry interval fires a pending listThreads()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(listThreadsMock).toHaveBeenCalledTimes(2);

      // Unmount while BOTH listThreads() and getMessages() are still pending!
      unmount();

      expect(offAgentSpy).toHaveBeenCalledTimes(1);
      expect(offSyncSpy).toHaveBeenCalledTimes(1);
      expect(syncListeners).toHaveLength(0);

      // Advance 30s -> 10s retry interval was cleared, zero further listThreads calls
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(listThreadsMock).toHaveBeenCalledTimes(2);

      // Settle pending promises AND invoke stale thread-recreated post-unmount -> zero unhandled rejections or React errors
      await act(async () => {
        capturedSyncListener?.({
          kind: 'thread-recreated',
          thread: { ...storedThreads[1], remoteConversationId: 'post-unmount-r2' },
        });
        resolvePendingGetMessages([
          { localId: 'late-1', role: 'assistant', content: 'Post-unmount message', createdAt: '' },
        ]);
        rejectPendingListThreads(new Error('Post-unmount listThreads failure'));
        rejectPendingGetMessages(new Error('Post-unmount getMessages failure'));
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves post-recreation server-ids that arrive while openThread(id) getMessages is still in flight, while purging pre-recreation serverIds', async () => {
    const t3: ThreadMeta = {
      id: 'thread-3',
      title: 'Third Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      syncState: 'pending',
    };
    storedThreads = [t3, ...storedThreads];

    let resolveThread3Messages!: (msgs: ChatMessage[]) => void;
    let thread3CallCount = 0;
    const submitFeedbackSpy = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { api: Record<string, unknown> }).api.submitFeedback = submitFeedbackSpy;
    (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
      .fn()
      .mockImplementation((threadId: string) => {
        if (threadId === 'thread-3') {
          thread3CallCount += 1;
          if (thread3CallCount === 1) {
            return new Promise<ChatMessage[]>((resolve) => {
              resolveThread3Messages = resolve;
            });
          }
          return Promise.resolve([
            {
              localId: 't3-u1',
              role: 'user',
              content: 'Question in thread 3',
              createdAt: '2026-08-01T12:00:00.000Z',
            },
            {
              localId: 't3-a1',
              serverId: 'post-recreation-fresh-a1',
              role: 'assistant',
              content: 'Answer in thread 3',
              feedback: { rating: 1 },
              createdAt: '2026-08-01T12:00:05.000Z',
            },
          ]);
        }
        return Promise.resolve(storedMessages[threadId] ?? []);
      });

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('Third Conversation')).toBeTruthy());

    // Pre-recreation server-ids on thread-3 MUST be cleared when thread-recreated fires
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'server-ids', threadId: 'thread-3', mapping: { 't3-u1': 'pre-recreation-srv-u1' } });
      }
    });

    // Begin openThread('thread-3') — getMessages('thread-3') stays in flight
    fireEvent.click(screen.getByText('Third Conversation'));
    expect(resolveThread3Messages).toBeTypeOf('function');

    const recreatedT3: ThreadMeta = {
      ...t3,
      id: 'thread-3',
      remoteConversationId: 'remote-3-fresh',
      syncState: 'synced',
    };
    storedThreads = [recreatedT3, ...storedThreads.slice(1)];

    // Both thread-recreated AND post-recreation server-ids arrive BEFORE getMessages('thread-3') resolves!
    act(() => {
      for (const l of syncListeners) {
        l({ kind: 'thread-recreated', thread: recreatedT3 });
      }
      for (const l of syncListeners) {
        l({
          kind: 'server-ids',
          threadId: 'thread-3',
          mapping: { 't3-a1': 'post-recreation-fresh-a1' },
        });
      }
    });

    // Now getMessages('thread-3') resolves with pre-recreation stale serverIds from disk
    await act(async () => {
      resolveThread3Messages([
        {
          localId: 't3-u1',
          serverId: 'stale-disk-u1',
          role: 'user',
          content: 'Question in thread 3',
          createdAt: '2026-08-01T12:00:00.000Z',
        },
        {
          localId: 't3-a1',
          serverId: 'stale-disk-a1',
          role: 'assistant',
          content: 'Answer in thread 3',
          createdAt: '2026-08-01T12:00:05.000Z',
        },
      ]);
    });

    await waitFor(() => expect(screen.getByText('Answer in thread 3')).toBeTruthy());
    expect(latestChatViewProps?.thread.id).toBe('thread-3');
    expect(latestChatViewProps?.thread.remoteConversationId).toBe('remote-3-fresh');
    // Stale disk serverIds AND pre-recreation recentServerIds are cleared, while post-recreation fresh serverId is preserved!
    expect(latestChatViewProps?.messages.map((m) => m.serverId)).toEqual([
      undefined,
      'post-recreation-fresh-a1',
    ]);

    // Submitting message feedback on the assistant turn succeeds against immutable thread-3 and closes the dialog
    const thumbsUpBtn = container.querySelector('.feedback .icon-button') as HTMLButtonElement;
    expect(thumbsUpBtn).not.toBeNull();
    fireEvent.click(thumbsUpBtn);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(submitFeedbackSpy).toHaveBeenCalledWith({
        threadId: 'thread-3',
        messageLocalId: 't3-a1',
        rating: 1,
        comment: undefined,
      });
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull());
  });

  it('leaves App interactive without corrupting messagesByThread when openThread getMessages rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
        .fn()
        .mockImplementation(async (threadId: string) => {
          if (threadId === 'thread-1') {
            throw new Error('Disk read error on thread-1');
          }
          return storedMessages[threadId] ?? [];
        });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Open thread-2 first so messagesByThread['thread-2'] is loaded
      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());

      // Open thread-1 whose getMessages rejects
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith('Failed to load messages:', expect.any(Error));
      });

      // App stays interactive on thread-1 with clean empty messages, and switching back to thread-2 works cleanly
      expect(latestChatViewProps?.thread.id).toBe('thread-1');
      expect(latestChatViewProps?.messages).toEqual([]);
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);

      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());
      expect(latestChatViewProps?.thread.id).toBe('thread-2');
      expect(latestChatViewProps?.messages.map((m) => m.localId)).toEqual(['t2-u1', 't2-a1']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('discards stale slow openThread(thread-1) resolution after switching to fast thread-2 without evicting thread-2 messages', async () => {
    let resolveSlowThread1Messages!: (msgs: ChatMessage[]) => void;
    (window as unknown as { api: Record<string, unknown> }).api.getMessages = vi
      .fn()
      .mockImplementation((threadId: string) => {
        if (threadId === 'thread-1') {
          return new Promise<ChatMessage[]>((resolve) => {
            resolveSlowThread1Messages = resolve;
          });
        }
        return Promise.resolve(storedMessages[threadId] ?? []);
      });

    render(<App />);
    await waitFor(() => expect(screen.getByText('Second Conversation')).toBeTruthy());

    // 1. Click First Conversation -> getMessages('thread-1') stays pending
    fireEvent.click(screen.getByText('First Conversation'));
    expect(resolveSlowThread1Messages).toBeTypeOf('function');

    // 2. Immediately switch to Second Conversation -> fast getMessages('thread-2') loads and renders
    fireEvent.click(screen.getByText('Second Conversation'));
    await waitFor(() => {
      expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
      expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();
    });

    // 3. Slow getMessages('thread-1') resolves late while user is viewing thread-2
    await act(async () => {
      resolveSlowThread1Messages([
        {
          localId: 't1-m1',
          role: 'assistant',
          content: 'Slow message from thread 1',
          createdAt: '2026-08-01T10:00:05.000Z',
        },
      ]);
    });

    // Active thread-2 messages remain intact on screen and were NOT evicted by stale openThread('thread-1')
    expect(screen.getByText('Existing question in thread 2')).toBeTruthy();
    expect(screen.getByText('Existing answer in thread 2')).toBeTruthy();
    expect(screen.queryByText('Slow message from thread 1')).toBeNull();
    expect(latestChatViewProps?.thread.id).toBe('thread-2');
    expect(latestChatViewProps?.messages.map((m) => m.localId)).toEqual(['t2-u1', 't2-a1']);
  });

  it('clears the transient sync retry error banner on the first acknowledged turn upload while more turns remain pending without re-listing threads', async () => {
    const listThreadsMock = (window as unknown as { api: { listThreads: ReturnType<typeof vi.fn> } }).api.listThreads;
    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
    const initialListCalls = listThreadsMock.mock.calls.length;

    const getFirstRowDot = (): Element | null =>
      screen.getByText('First Conversation').closest('.thread-item')?.querySelector('.sync-dot') ?? null;

    // 1. Transient error on a 20-turn backlog surfaces "Sync failed — retrying." and .sync-dot.error
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'error',
          pendingCount: 20,
        });
      }
    });
    expect(getFirstRowDot()?.classList.contains('error')).toBe(true);
    expect(screen.getByText(/20 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();

    // 2. First turn uploads (acked: true, 19 turns still pending): clears error prose immediately, flips dot to pending, +0 listThreads calls
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'pending',
          pendingCount: 19,
          acked: true,
        });
      }
    });
    expect(screen.queryByText(/Sync failed — retrying\./i)).toBeNull();
    expect(screen.getByText(/19 turns waiting to sync to the server…/i)).toBeTruthy();
    expect(getFirstRowDot()?.classList.contains('pending')).toBe(true);
    expect(getFirstRowDot()?.classList.contains('error')).toBe(false);
    expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls);

    // 3. Final turn drains (state: 'synced', acked: true): triggers refreshThreads (+1 listThreads call) and hides banner
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'synced',
          pendingCount: 0,
          acked: true,
        });
      }
    });
    await waitFor(() => {
      expect(listThreadsMock).toHaveBeenCalledTimes(initialListCalls + 1);
    });
    expect(screen.queryByText(/waiting to sync to the server/i)).toBeNull();
  });

  it('keeps the transient sync retry error banner visible across unacknowledged pending sync-state events from startup scan or offline enqueue', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'error',
          pendingCount: 2,
        });
      }
    });
    expect(screen.getByText(/2 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();

    // Unacknowledged startup scan discovery + offline enqueue must preserve "Sync failed — retrying."
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'pending',
          pendingCount: 3,
        });
        l({
          kind: 'sync-state',
          threadId: '',
          state: 'pending',
          pendingCount: 4,
        });
      }
    });
    expect(screen.getByText(/4 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();
  });

  it('clears stale transient syncError when a dropped turn drains pendingCount to zero while keeping active syncError when turns remain pending', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

    // 1. Active transient syncError across 2 queued turns
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'error',
          pendingCount: 2,
          detail: 'Backend 503 retrying',
        });
      }
    });
    expect(screen.getByText(/2 turns waiting to sync to the server — Backend 503 retrying/i)).toBeTruthy();

    // 2. Non-final turn dropped (pendingCount: 1 > 0): surfaces droppedSyncError AND keeps active transient syncError
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-2',
          state: 'error',
          dropped: true,
          pendingCount: 1,
          detail: 'Turn rejected (HTTP 422)',
        });
      }
    });
    expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 422');
    expect(screen.getByText(/1 turn waiting to sync to the server — Backend 503 retrying/i)).toBeTruthy();

    // 3. Final turn dropped (pendingCount: 0): updates droppedSyncError AND clears stale transient syncError
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'error',
          dropped: true,
          pendingCount: 0,
          detail: 'Final turn rejected (HTTP 400)',
        });
      }
    });
    expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 400');
    expect(screen.queryByText(/waiting to sync to the server/i)).toBeNull();

    // 4. Subsequent unacknowledged offline turn enqueue renders clean pending text without flashing stale "Backend 503 retrying"
    act(() => {
      for (const l of syncListeners) {
        l({
          kind: 'sync-state',
          threadId: 'thread-1',
          state: 'pending',
          pendingCount: 1,
        });
      }
    });
    expect(screen.getByText(/1 turn waiting to sync to the server…/i)).toBeTruthy();
    expect(screen.queryByText(/Backend 503 retrying/i)).toBeNull();
  });

  it('clears stale transient syncError when refreshThreads reports pendingSyncCount of zero so subsequent offline turns do not flash old errors', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    (window as unknown as { api: Record<string, unknown> }).api.listThreads = vi
      .fn()
      .mockImplementation(async () => ({
        threads: storedThreads.map((t) => ({ ...t })),
        serverReachable: true,
        pendingSyncCount: storedThreads.some((t) => t.id === 'thread-1') ? 1 : 0,
      }));

    try {
      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // 1. thread-1 hits a transient retry error (pendingCount: 1)
      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'sync-state',
            threadId: 'thread-1',
            state: 'error',
            pendingCount: 1,
            detail: 'Stale failing thread error',
          });
        }
      });
      expect(screen.getByText(/1 turn waiting to sync to the server — Stale failing thread error/i)).toBeTruthy();

      // 2. User deletes thread-1 -> deleteThread calls refreshThreads() which resolves with pendingSyncCount: 0
      storedThreads = storedThreads.filter((t) => t.id !== 'thread-1');
      const firstRow = screen.getByText('First Conversation').closest('.thread-item') as HTMLElement;
      fireEvent.click(firstRow.querySelector('.thread-delete') as HTMLButtonElement);
      await waitFor(() => expect(screen.queryByText('First Conversation')).toBeNull());
      await waitFor(() => expect(screen.queryByText(/waiting to sync to the server/i)).toBeNull());

      // 3. New unacknowledged turn enqueued on thread-2 must NOT flash "Stale failing thread error"
      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'sync-state',
            threadId: 'thread-2',
            state: 'pending',
            pendingCount: 1,
          });
        }
      });
      expect(container.textContent).toContain('1 turn waiting to sync to the server…');
      expect(screen.queryByText(/Stale failing thread error/i)).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('preserves active transient syncError when refreshThreads resolves with non-zero or omitted pendingSyncCount', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let nextPendingCount: number | undefined = 2;
    (window as unknown as { api: Record<string, unknown> }).api.listThreads = vi
      .fn()
      .mockImplementation(async () => ({
        threads: storedThreads.map((t) => ({ ...t })),
        serverReachable: true,
        ...(nextPendingCount !== undefined ? { pendingSyncCount: nextPendingCount } : {}),
      }));

    try {
      render(<App />);
      await waitFor(() => {
        expect(screen.getByText('First Conversation')).toBeTruthy();
        expect(screen.getByText('Second Conversation')).toBeTruthy();
      });

      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'sync-state',
            threadId: 'thread-2',
            state: 'error',
            pendingCount: 2,
          });
        }
      });
      expect(screen.getByText(/2 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();

      // 1. Delete thread-1 while thread-2 still has pendingSyncCount: 2 -> error banner MUST stay visible!
      storedThreads = storedThreads.filter((t) => t.id !== 'thread-1');
      const firstRow = screen.getByText('First Conversation').closest('.thread-item') as HTMLElement;
      fireEvent.click(firstRow.querySelector('.thread-delete') as HTMLButtonElement);
      await waitFor(() => expect(screen.queryByText('First Conversation')).toBeNull());
      expect(screen.getByText(/2 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();

      // 2. Trigger another refreshThreads() (via patchThread) resolving with pendingSyncCount: undefined -> error banner MUST stay visible!
      nextPendingCount = undefined;
      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => expect(screen.getByText('Existing answer in thread 2')).toBeTruthy());
      await act(async () => {
        latestChatViewProps?.onPatchThread({ thinkingLevel: 'high' });
      });
      await waitFor(() => {
        expect((window as unknown as { api: { patchThread: ReturnType<typeof vi.fn> } }).api.patchThread).toHaveBeenCalledWith(
          'thread-2',
          { thinkingLevel: 'high' },
        );
      });
      expect(screen.getByText(/2 turns waiting to sync to the server — Sync failed — retrying\./i)).toBeTruthy();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('preserves sticky droppedSyncError across acknowledged turn uploads and zero-pending thread refreshes until dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    (window as unknown as { api: Record<string, unknown> }).api.listThreads = vi
      .fn()
      .mockImplementation(async () => ({
        threads: storedThreads.map((t) => ({ ...t })),
        serverReachable: true,
        pendingSyncCount: 0,
      }));

    try {
      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'sync-state',
            threadId: 'thread-1',
            state: 'error',
            dropped: true,
            pendingCount: 2,
            detail: 'Sticky rejected turn (HTTP 413)',
          });
        }
      });
      expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 413');

      // 1. Acknowledged upload with remaining turns (acked: true, pendingCount: 1) does NOT clear droppedSyncError
      act(() => {
        for (const l of syncListeners) {
          l({
            kind: 'sync-state',
            threadId: 'thread-2',
            state: 'pending',
            pendingCount: 1,
            acked: true,
          });
        }
      });
      expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 413');

      // 2. Deleting thread-1 -> refreshThreads() resolving with pendingSyncCount: 0 does NOT clear droppedSyncError
      storedThreads = storedThreads.filter((t) => t.id !== 'thread-1');
      const firstRow = screen.getByText('First Conversation').closest('.thread-item') as HTMLElement;
      fireEvent.click(firstRow.querySelector('.thread-delete') as HTMLButtonElement);
      await waitFor(() => expect(screen.queryByText('First Conversation')).toBeNull());
      expect(container.querySelector('.banner.error')?.textContent).toContain('HTTP 413');

      // 3. Explicit Dismiss clears droppedSyncError
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(container.querySelector('.banner.error')).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });
});


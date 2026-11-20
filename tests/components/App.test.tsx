// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      serverSignIn: vi.fn().mockResolvedValue({ status: 'signed_in', account: 'alice@corp.com' }),
      cancelServerSignIn: vi.fn().mockResolvedValue(true),
      serverSignOut: vi.fn().mockResolvedValue(undefined),
      claudeSignIn: vi.fn().mockResolvedValue({ status: 'signed_in', account: 'claude@yvoke.dev' }),
      cancelClaudeSignIn: vi.fn().mockResolvedValue(true),
      copyClaudeSignInUrl: vi.fn().mockResolvedValue(true),
      submitClaudeAuthCode: vi.fn().mockResolvedValue({ accepted: true }),
      claudeSignOut: vi.fn().mockResolvedValue({ status: 'signed_out' }),
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
      'claudeSignIn',
      'claudeSigningOut',
      'liveTurn',
      'messages',
      'onFeedback',
      'onInterrupt',
      'onPatchThread',
      'onSend',
      'profiles',
      'prompts',
      'serverSignIn',
      'settings',
      'signingOut',
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

  describe('Wave 2: Claude sign-in propagation, sendMessage catch guard & focus throttle', () => {
    it('preserves clean attributed error AND authRequired: true across sendMessage catch when AgentService emitted kind: error before throwing, and replaces only authRequired errors on sign-in', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      api.sendMessage = vi.fn().mockImplementation(async () => {
        emitAgent({
          kind: 'error',
          threadId: 'thread-1',
          message: 'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
          authRequired: true,
        });
        throw new Error("Error invoking remote method 'chat:send': Error: Not logged in");
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Seed a non-auth error on background thread-2 to prove sign-in leaves non-auth errors untouched
      emitAgent({
        kind: 'error',
        threadId: 'thread-2',
        message: 'Yvoke Backend: Knowledge base timeout',
        authRequired: false,
      });

      // Open thread-1 and send a question that fails with Claude auth error + rejected invoke
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
      fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);

      const textarea = await screen.findByPlaceholderText(/Add your question/);
      fireEvent.change(textarea, { target: { value: 'Why did login expire?' } });
      fireEvent.click(screen.getByRole('button', { name: /Send/i }));

      // Optimistic message removed, clean attributed message preserved (no Electron IPC wrapper), and Sign in to Claude shown!
      await waitFor(() => {
        expect(screen.queryByText('Why did login expire?')).toBeNull();
        expect(
          screen.getByText(
            'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
          ),
        ).toBeTruthy();
      });
      expect(container.textContent).not.toContain("Error invoking remote method 'chat:send'");
      const inlineSignInBtn = screen.getByRole('button', { name: 'Sign in to Claude' });
      expect(container.querySelector('.chat-notices .banner.error')?.contains(inlineSignInBtn)).toBe(
        true,
      );

      // Click Sign in to Claude -> replaces authRequired error with notice, leaves thread-2's non-auth error intact
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'ok',
        claudeAccount: 'claude@yvoke.dev',
        server: { mode: 'dev', signedIn: true },
      });
      fireEvent.click(inlineSignInBtn);

      await waitFor(() => {
        expect(
          screen.getByText('Signed in to Claude — send your question again.'),
        ).toBeTruthy();
      });
      expect(
        screen.queryByText(
          'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
        ),
      ).toBeNull();

      // Switch to thread-2 -> non-auth error was NOT cleared by Claude sign-in!
      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => {
        expect(screen.getByText('Yvoke Backend: Knowledge base timeout')).toBeTruthy();
      });
    });

    it('propagates authRequired: true and refreshes authStatus() when turn-complete arrives with isError: true and authRequired: true', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

      const initialAuthCalls = api.authStatus.mock.calls.length;
      api.authStatus.mockResolvedValue({
        claude: 'missing',
        server: { mode: 'dev', signedIn: true },
      });

      emitAgent({ kind: 'turn-start', threadId: 'thread-1' });
      emitAgent({
        kind: 'turn-complete',
        threadId: 'thread-1',
        message: { localId: 't1-err', role: 'assistant', content: '', createdAt: '' },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        durationMs: 120,
        isError: true,
        errorMessage: 'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
        authRequired: true,
      });

      await waitFor(() => {
        expect(api.authStatus.mock.calls.length).toBeGreaterThan(initialAuthCalls);
        expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Sign in to Claude' }).length).toBe(2);
      });
    });

    it('polls authStatus on window focus ONLY when auth.claude === "missing" && !signingIn, throttles at 2000ms, and removes listener on unmount', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
        api.authStatus = vi.fn().mockResolvedValue({
          claude: 'missing',
          server: { mode: 'dev', signedIn: true },
        });
        let resolveSignIn!: (res: { status: 'signed_in'; account?: string }) => void;
        api.claudeSignIn = vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSignIn = resolve;
            }),
        );

        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const { unmount } = render(<App />);

        await waitFor(() => expect(screen.getByText(/Connect Claude:/i)).toBeTruthy());
        const afterMountCalls = api.authStatus.mock.calls.length;

        // 1st focus event fires immediately (+1)
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(afterMountCalls + 1);

        // Focus within 2000ms (e.g. +1000ms) is throttled (+0)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(afterMountCalls + 1);

        // Focus after >= 2000ms fires again (+1)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_100);
        });
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(afterMountCalls + 2);

        // Start in-app sign-in -> signingIn === true detaches focus listener so browser focus bounce makes +0 calls
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
        expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeTruthy();

        const duringSignInCalls = api.authStatus.mock.calls.length;
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(duringSignInCalls);

        // Complete sign-in -> auth.claude becomes 'ok', focus events remain inactive
        api.authStatus.mockResolvedValue({
          claude: 'ok',
          claudeAccount: 'claude@yvoke.dev',
          server: { mode: 'dev', signedIn: true },
        });
        await act(async () => {
          resolveSignIn({ status: 'signed_in', account: 'claude@yvoke.dev' });
        });
        await waitFor(() => expect(screen.queryByText(/Connect Claude:/i)).toBeNull());

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
        const afterOkCalls = api.authStatus.mock.calls.length;
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(afterOkCalls);

        unmount();
        expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
        removeSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reconciles external login on window focus by clearing authRequired turn errors (preserving non-auth errors) and stale claudeSignIn.error, and overwrites stale claudeAccount when signed_in account is undefined', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'missing',
        claudeAccount: 'stale-expired@old.com',
        server: { mode: 'dev', signedIn: true },
      });

      render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());

      // 1. Seed a failed in-app sign-in error on claudeSignIn controller
      api.claudeSignIn = vi.fn().mockResolvedValueOnce({
        status: 'error',
        message: 'Temporary browser launch failure',
      });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Temporary browser launch failure'),
      );

      // 2. Seed an authRequired turn error on thread-1 and a non-auth turn error on thread-2
      emitAgent({
        kind: 'error',
        threadId: 'thread-1',
        message: 'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
        authRequired: true,
      });
      emitAgent({
        kind: 'error',
        threadId: 'thread-2',
        message: 'Yvoke Backend: Corpus index offline',
        authRequired: false,
      });
      await waitFor(() =>
        expect(
          screen.getByText(
            'Claude: Your Claude login is missing or expired. Click Sign in to Claude to continue.',
          ),
        ).toBeTruthy(),
      );

      // 3. User signs in externally via terminal and alt-tabs back -> window 'focus' observes claude === 'ok'
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'ok',
        claudeAccount: 'terminal@yvoke.dev',
        server: { mode: 'dev', signedIn: true },
      });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      await waitFor(() => {
        expect(screen.queryByText(/Connect Claude:/i)).toBeNull();
        expect(
          screen.getByText('Signed in to Claude — send your question again.'),
        ).toBeTruthy();
      });
      expect(screen.queryByText('Temporary browser launch failure')).toBeNull();

      // Non-auth error on thread-2 remains intact!
      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() => {
        expect(screen.getByText('Yvoke Backend: Corpus index offline')).toBeTruthy();
      });

      // 4. Verify onSignedIn({ account: undefined }) clears stale claudeAccount instead of retaining old email
      api.authStatus = vi.fn().mockResolvedValueOnce({
        claude: 'missing',
        claudeAccount: 'stale-expired@old.com',
        server: { mode: 'dev', signedIn: true },
      });
      emitAgent({
        kind: 'error',
        threadId: 'thread-2',
        message: 'Claude: Login expired.',
        authRequired: true,
      });
      await waitFor(() => expect(screen.getByText(/Connect Claude:/i)).toBeTruthy());

      // Hold post-signin authStatus pending so we inspect the optimistic setAuth state from onSignedIn(undefined)
      const neverAuth = new Promise<AuthStatus>(() => undefined);
      api.authStatus = vi.fn().mockReturnValue(neverAuth);
      api.claudeSignIn = vi.fn().mockResolvedValueOnce({
        status: 'signed_in',
        account: undefined,
      });

      fireEvent.click(screen.getAllByRole('button', { name: 'Sign in to Claude' })[0]);
      await waitFor(() => expect(screen.queryByText(/Connect Claude:/i)).toBeNull());

      // Open Settings -> Accounts and verify 'stale-expired@old.com' was cleared to 'Signed in'
      fireEvent.click(document.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
      fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
      expect(document.body.textContent).not.toContain('stale-expired@old.com');
      const settingsPane = document.querySelector('.settings-pane') as HTMLElement;
      expect(settingsPane.textContent).toContain('Signed in');
    });
  });

  describe('Wave 6: Entra server sign-in, polling gating, cross-auth isolation, paneRequest & signingOut guard', () => {
    it('pauses 10s reconnect poll and gates catalogue fetches while Entra is unauthenticated, then resumes after Sign in to Yvoke', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
        let signedIn = false;
        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
        api.authStatus = vi.fn().mockImplementation(async () => ({
          claude: 'ok',
          server: {
            mode: 'entra',
            signedIn,
            ...(signedIn ? { account: 'alice@corp.com' } : {}),
          },
        }));
        api.listThreads = vi.fn().mockImplementation(async () => ({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: signedIn,
          serverAuthRequired: !signedIn,
        }));
        api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);
        api.serverSignIn = vi.fn().mockImplementation(async () => {
          signedIn = true;
          return { status: 'signed_in', account: 'alice@corp.com' };
        });

        render(<App />);
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy(),
        );

        // Red Server unreachable banner is suppressed while Entra sign-in banner is active
        expect(screen.queryByText(/Server unreachable:/i)).toBeNull();
        // Catalogues are gated while unauthenticated
        expect(api.listPrompts).not.toHaveBeenCalled();
        expect(api.listOrchestratorProfiles).not.toHaveBeenCalled();

        const listThreadsCountBefore = api.listThreads.mock.calls.length;
        // Advance 30s -> 10s poll must NOT fire while Entra is unauthenticated
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(api.listThreads).toHaveBeenCalledTimes(listThreadsCountBefore);
        expect(api.listPrompts).not.toHaveBeenCalled();

        // Click Sign in to Yvoke -> refreshes threads and catalogues immediately
        fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
        await waitFor(() => {
          expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull();
          expect(api.listPrompts).toHaveBeenCalledTimes(1);
          expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('isolates cross-auth turn errors and preserves serverAuthRequired across sendMessage catch', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'ok',
        server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
      });
      api.sendMessage = vi.fn().mockImplementation(async () => {
        emitAgent({
          kind: 'error',
          threadId: 'thread-1',
          message: 'Yvoke Server: Your corporate sign-in expired. Click Sign in to Yvoke.',
          serverAuthRequired: true,
        });
        throw new Error("Error invoking remote method 'chat:send': Error: 401");
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Seed a Claude authRequired error on thread-2
      emitAgent({
        kind: 'error',
        threadId: 'thread-2',
        message: 'Claude: Your Claude login expired.',
        authRequired: true,
      });

      // Open thread-1 and send -> triggers serverAuthRequired + sendMessage rejection
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
      fireEvent.click(screen.getByText('oim-getting-started').closest('button')!);
      const textarea = await screen.findByPlaceholderText(/Add your question/);
      fireEvent.change(textarea, { target: { value: 'Check Entra expiry' } });
      fireEvent.click(screen.getByRole('button', { name: /Send/i }));

      // sendMessage catch preserves serverAuthRequired and clean error without IPC wrapper
      await waitFor(() =>
        expect(
          screen.getByText('Yvoke Server: Your corporate sign-in expired. Click Sign in to Yvoke.'),
        ).toBeTruthy(),
      );
      expect(container.textContent).not.toContain("Error invoking remote method 'chat:send'");
      const errorBanner = container.querySelector('.chat-notices .banner.error')!;
      const inlineYvokeBtn = Array.from(errorBanner.querySelectorAll('button')).find(
        (b) => b.textContent === 'Sign in to Yvoke',
      );
      expect(inlineYvokeBtn).toBeTruthy();

      // Sign in to Yvoke -> clears thread-1 serverAuthRequired error with notice, leaves thread-2 Claude authRequired error untouched!
      fireEvent.click(inlineYvokeBtn!);
      await waitFor(() =>
        expect(screen.getByText('Signed in to Yvoke — send your question again.')).toBeTruthy(),
      );

      fireEvent.click(screen.getByText('Second Conversation'));
      await waitFor(() =>
        expect(screen.getByText('Claude: Your Claude login expired.')).toBeTruthy(),
      );
    });

    it('opens Settings -> Accounts from sidebar account footer without dropping unsaved Settings edits', async () => {
      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Open Settings via gear icon -> lands on Server pane
      fireEvent.click(container.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
      expect(screen.getByRole('heading', { name: 'Server' })).toBeTruthy();

      // Switch to Models and edit maxTurns (unsaved dirty draft)
      fireEvent.click(screen.getByRole('button', { name: 'Models' }));
      fireEvent.change(screen.getByLabelText('Max turns per message'), { target: { value: '77' } });

      // Click sidebar account footer button -> switches to Accounts WITHOUT unmounting SettingsView or losing draft!
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy();
      expect(screen.getByText('You have unsaved changes in other settings panes.')).toBeTruthy();

      // Switch back to Models -> edited value 77 is still intact
      fireEvent.click(screen.getByRole('button', { name: 'Models' }));
      expect((screen.getByLabelText('Max turns per message') as HTMLInputElement).value).toBe('77');
    });

    it('guards handleSignOut across concurrent clicks, IPC rejection recovery, and success refresh', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let signedIn = true;
      api.authStatus = vi.fn().mockImplementation(async () => ({
        claude: 'ok',
        server: {
          mode: 'entra',
          signedIn,
          ...(signedIn ? { account: 'alice@corp.com' } : {}),
        },
      }));

      let rejectFirst!: (err: Error) => void;
      api.serverSignOut = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectFirst = reject;
            }),
        )
        .mockImplementationOnce(async () => {
          signedIn = false;
        });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { container } = render(<App />);
        await waitFor(() => expect(screen.getByText('alice@corp.com')).toBeTruthy());

        // Sidebar footer must never render a sign-out button (sign-out lives exclusively in Settings → Accounts)
        const footer = container.querySelector('.thread-list-footer') as HTMLElement;
        expect(footer).not.toBeNull();
        expect(within(footer).queryByRole('button', { name: /sign out/i })).toBeNull();

        // Open Settings → Accounts via sidebar footer account button
        fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
        const accountsPane = container.querySelector('.settings-pane') as HTMLElement;

        const signOutBtn = within(accountsPane).getByRole('button', {
          name: 'Sign out of Yvoke',
        }) as HTMLButtonElement;
        fireEvent.click(signOutBtn);
        expect(api.serverSignOut).toHaveBeenCalledTimes(1);
        expect(signOutBtn.disabled).toBe(true);

        // Concurrent click while in-flight is ignored
        fireEvent.click(signOutBtn);
        expect(api.serverSignOut).toHaveBeenCalledTimes(1);

        // First attempt rejects -> restores interactivity without crashing
        await act(async () => {
          rejectFirst(new Error('MSAL cache locked'));
        });
        await waitFor(() => expect(signOutBtn.disabled).toBe(false));

        // Second attempt succeeds -> refreshes auth and shows Sign in to Yvoke in both banner and Accounts pane
        fireEvent.click(signOutBtn);
        await waitFor(() => {
          expect(api.serverSignOut).toHaveBeenCalledTimes(2);
          expect(within(accountsPane).getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
          expect(screen.getAllByRole('button', { name: 'Sign in to Yvoke' }).length).toBeGreaterThanOrEqual(2);
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('clears a stale serverSignIn error when handleSignOut completes', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let signedIn = true;
      api.authStatus = vi.fn().mockImplementation(async () => ({
        claude: 'ok',
        server: {
          mode: 'entra',
          signedIn,
          ...(signedIn ? { account: 'alice@corp.com' } : {}),
        },
      }));
      api.serverSignIn = vi.fn().mockResolvedValueOnce({
        status: 'error',
        message: 'Previous Entra browser failure',
      });
      api.serverSignOut = vi.fn().mockImplementation(async () => {
        signedIn = false;
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Sidebar footer must not expose a sign-out button even while signed into Entra
      const footer = container.querySelector('.thread-list-footer') as HTMLElement;
      expect(within(footer).queryByRole('button', { name: /sign out/i })).toBeNull();

      // Seed a serverAuthRequired turn error so Sign in to Yvoke banner appears even while signedIn is stale-true
      emitAgent({
        kind: 'error',
        threadId: 'thread-1',
        message: 'Yvoke Server: Token expired',
        serverAuthRequired: true,
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy());

      // Trigger a failing Sign in to Yvoke -> surfaces alert
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Yvoke' }));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe('Previous Entra browser failure'),
      );

      // Server recovers (listThreads reports serverAuthRequired: false while signedIn stays true),
      // so Settings → Accounts exposes Sign out of Yvoke while serverSignIn.error is still held.
      act(() => {
        for (const l of syncListeners) {
          l({ kind: 'sync-state', threadId: 'thread-1', state: 'synced', pendingCount: 0 });
        }
      });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign in to Yvoke' })).toBeNull());

      // Open Settings → Accounts and click Sign out of Yvoke -> stale serverSignIn error must be cleared!
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
      const accountsPane = container.querySelector('.settings-pane') as HTMLElement;
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Yvoke' }));
      await waitFor(() => expect(api.serverSignOut).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(within(accountsPane).getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy(),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('fetches catalogues immediately during entra signed-out -> dev Settings save without awaiting slow authStatus()', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let mode: 'entra' | 'dev' = 'entra';
      let resolveDelayedAuth!: (status: AuthStatus) => void;
      let delayNextAuth = false;

      api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
      api.setSettings = vi.fn().mockImplementation(async (update: Partial<AppSettings>) => {
        if (update.serverAuthMode === 'dev') {
          mode = 'dev';
          delayNextAuth = true;
        }
        return { ...sampleSettings(), ...update };
      });
      api.authStatus = vi.fn().mockImplementation(() => {
        if (delayNextAuth) {
          delayNextAuth = false;
          return new Promise<AuthStatus>((resolve) => {
            resolveDelayedAuth = resolve;
          });
        }
        return Promise.resolve({
          claude: 'ok',
          server: mode === 'dev' ? { mode: 'dev', signedIn: true } : { mode: 'entra', signedIn: false },
        });
      });
      api.listThreads = vi.fn().mockImplementation(async () => ({
        threads: storedThreads.map((t) => ({ ...t })),
        serverReachable: mode === 'dev',
        serverAuthRequired: mode === 'entra',
      }));
      api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
      api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

      const { container } = render(<App />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy(),
      );
      expect(api.listPrompts).not.toHaveBeenCalled();

      // Open Settings -> Server, switch Server authentication to Dev token, and Save
      fireEvent.click(container.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
      fireEvent.click(screen.getByRole('button', { name: 'Dev token' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      // Wait until delayed authStatus is in-flight — catalogues MUST already be fetched while authStatus is STILL pending!
      await waitFor(() => expect(resolveDelayedAuth).toBeTypeOf('function'));
      await waitFor(() => {
        expect(api.listPrompts).toHaveBeenCalledTimes(1);
        expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
      });

      // Resolving authStatus afterwards updates auth without triggering duplicate catalogue fetches
      await act(async () => {
        resolveDelayedAuth({ claude: 'ok', server: { mode: 'dev', signedIn: true } });
      });
      expect(api.listPrompts).toHaveBeenCalledTimes(1);
      expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
    });
  });

  describe('Wave 10: One-click Claude sign-out, monotonic authEpochRef & error lifecycle', () => {
    it('handles 3-way claudeSigningOut state machine: double-click guard, cross-flow mutual guards, stale claudeSignIn.error clearing, 2-way post-error recovery, secret redaction, and unmount safety', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let claudeState: 'ok' | 'missing' = 'ok';
      let claudeAccount: string | undefined = 'claude@yvoke.dev';
      let serverSignedIn = true;

      api.authStatus = vi.fn().mockImplementation(async () => ({
        claude: claudeState,
        ...(claudeAccount ? { claudeAccount } : {}),
        server: {
          mode: 'entra',
          signedIn: serverSignedIn,
          ...(serverSignedIn ? { account: 'alice@corp.com' } : {}),
        },
      }));

      let resolveSignOut1!: (res: { status: 'signed_out' } | { status: 'error'; message: string }) => void;
      let resolveSignOut2!: (res: { status: 'signed_out' } | { status: 'error'; message: string }) => void;
      let rejectSignOut3!: (err: Error) => void;
      let resolveSignOut4!: (res: { status: 'signed_out' } | { status: 'error'; message: string }) => void;
      let resolveSignOut5!: (res: { status: 'signed_out' } | { status: 'error'; message: string }) => void;
      let resolveServerSignOut!: () => void;

      api.claudeSignOut = vi
        .fn()
        .mockImplementationOnce(() => new Promise((r) => (resolveSignOut1 = r)))
        .mockImplementationOnce(() => new Promise((r) => (resolveSignOut2 = r)))
        .mockImplementationOnce(() => new Promise((_r, rej) => (rejectSignOut3 = rej)))
        .mockImplementationOnce(() => new Promise((r) => (resolveSignOut4 = r)))
        .mockImplementationOnce(() => new Promise((r) => (resolveSignOut5 = r)));
      api.serverSignOut = vi
        .fn()
        .mockImplementationOnce(() => new Promise<void>((r) => (resolveServerSignOut = r)));

      const { container, unmount } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Open Accounts pane
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
      const accountsPane = container.querySelector('.settings-pane') as HTMLElement;

      // 1. Rapid double-click on Sign out of Claude -> exactly 1 IPC call; blocks serverSignOut too
      const claudeBtn = within(accountsPane).getByRole('button', {
        name: 'Sign out of Claude',
      }) as HTMLButtonElement;
      fireEvent.click(claudeBtn);
      fireEvent.click(claudeBtn);
      expect(api.claudeSignOut).toHaveBeenCalledTimes(1);
      expect(claudeBtn.disabled).toBe(true);
      expect(claudeBtn.textContent).toBe('Signing out…');

      // Sibling Sign out of Yvoke is disabled and cannot fire while claudeSigningOut is active
      const yvokeBtn = within(accountsPane).getByRole('button', {
        name: 'Sign out of Yvoke',
      }) as HTMLButtonElement;
      expect(yvokeBtn.disabled).toBe(true);
      fireEvent.click(yvokeBtn);
      expect(api.serverSignOut).toHaveBeenCalledTimes(0);

      // Outcome A: error status + authStatus still 'ok' -> keeps sanitized inline error and stays signed in
      await act(async () => {
        resolveSignOut1({ status: 'error', message: 'Claude sign-out timed out after 10 seconds.' });
      });
      await waitFor(() => {
        expect(within(accountsPane).getByRole('alert').textContent).toBe(
          'Claude sign-out timed out after 10 seconds.',
        );
      });
      expect(claudeBtn.disabled).toBe(false);
      expect(claudeBtn.textContent).toBe('Sign out');

      // 2. Outcome B: error status + partial logout (authStatus returns claude: 'missing') -> clears error & flips UI cleanly!
      fireEvent.click(claudeBtn);
      expect(api.claudeSignOut).toHaveBeenCalledTimes(2);
      claudeState = 'missing';
      claudeAccount = undefined;
      await act(async () => {
        resolveSignOut2({ status: 'error', message: 'Subprocess exited non-zero after clearing keychain' });
      });
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
        expect(within(accountsPane).queryByRole('alert')).toBeNull();
      });
      expect(within(accountsPane).queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();

      // Re-sign in to Claude (after seeding a failed attempt) to test IPC rejection secret redaction + stale error clearing
      api.claudeSignIn = vi
        .fn()
        .mockResolvedValueOnce({ status: 'error', message: 'Stale sign-in error' })
        .mockImplementationOnce(async () => {
          claudeState = 'ok';
          claudeAccount = 'fresh@yvoke.dev';
          return { status: 'signed_in', account: 'fresh@yvoke.dev' };
        });
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() => expect(within(accountsPane).getByRole('alert').textContent).toBe('Stale sign-in error'));
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() =>
        expect(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' })).toBeTruthy(),
      );

      // 3. Outcome C: IPC rejection containing secrets -> redacts sk-ant-* and Bearer JWT from DOM!
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));
      expect(api.claudeSignOut).toHaveBeenCalledTimes(3);
      await act(async () => {
        rejectSignOut3(
          new Error('IPC failed with sk-ant-api03-SECRET and Bearer secret.jwt.token'),
        );
      });
      await waitFor(() => {
        const alert = within(accountsPane).getByRole('alert');
        expect(alert.textContent).toContain('sk-ant-[REDACTED]');
        expect(alert.textContent).toContain('Bearer [REDACTED]');
      });
      expect(document.body.textContent).not.toContain('sk-ant-api03-SECRET');
      expect(document.body.textContent).not.toContain('Bearer secret.jwt.token');

      // 4. Cross-flow guard: while serverSignOut is in flight, Claude sign-out is disabled & blocked (0 new calls)
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Yvoke' }));
      expect(api.serverSignOut).toHaveBeenCalledTimes(1);
      const claudeBtnDuringEntraOut = within(accountsPane).getByRole('button', {
        name: 'Sign out of Claude',
      }) as HTMLButtonElement;
      expect(claudeBtnDuringEntraOut.disabled).toBe(true);
      fireEvent.click(claudeBtnDuringEntraOut);
      expect(api.claudeSignOut).toHaveBeenCalledTimes(3);

      serverSignedIn = false;
      await act(async () => {
        resolveServerSignOut();
      });
      await waitFor(() =>
        expect(
          (within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );

      // 5. Cross-flow guard: while serverSignIn.signingIn is active, Sign out of Claude is disabled (0 new calls)
      let resolveServerSignIn!: (res: { status: 'signed_in'; account?: string }) => void;
      api.serverSignIn = vi.fn().mockImplementationOnce(() => new Promise((r) => (resolveServerSignIn = r)));
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign in to Yvoke' }));
      const claudeBtnDuringEntraIn = within(accountsPane).getByRole('button', {
        name: 'Sign out of Claude',
      }) as HTMLButtonElement;
      expect(claudeBtnDuringEntraIn.disabled).toBe(true);
      fireEvent.click(claudeBtnDuringEntraIn);
      expect(api.claudeSignOut).toHaveBeenCalledTimes(3);

      serverSignedIn = true;
      await act(async () => {
        resolveServerSignIn({ status: 'signed_in', account: 'alice@corp.com' });
      });
      await waitFor(() =>
        expect(
          (within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );

      // 6. Clean success path: signed_out updates UI optimistically and clears stale errors
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));
      expect(api.claudeSignOut).toHaveBeenCalledTimes(4);
      claudeState = 'missing';
      claudeAccount = undefined;
      await act(async () => {
        resolveSignOut4({ status: 'signed_out' });
      });
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
        expect(within(accountsPane).getByText('Not signed in')).toBeTruthy();
      });
      expect(within(accountsPane).queryByRole('alert')).toBeNull();

      // 7. Unmount safety: unmount while claudeSignOut is pending and settle afterwards -> no error
      claudeState = 'ok';
      claudeAccount = 'relogin@yvoke.dev';
      api.claudeSignIn = vi.fn().mockResolvedValueOnce({ status: 'signed_in', account: 'relogin@yvoke.dev' });
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() =>
        expect(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' })).toBeTruthy(),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));
        expect(api.claudeSignOut).toHaveBeenCalledTimes(5);
        unmount();
        await act(async () => {
          resolveSignOut5({ status: 'signed_out' });
        });
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('authEpochRef discards a stale pre-signout authStatus() resolving after claudeSignOut() completes', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let resolveStalePreSignOutAuth!: (status: AuthStatus) => void;
      let callIndex = 0;

      api.authStatus = vi.fn().mockImplementation(() => {
        callIndex += 1;
        // Call 1: initial mount -> signed in
        if (callIndex === 1) {
          return Promise.resolve({
            claude: 'ok',
            claudeAccount: 'stale@corp.com',
            server: { mode: 'dev', signedIn: true },
          });
        }
        // Call 2: triggered BEFORE sign-out via sync-state error event -> stays pending!
        if (callIndex === 2) {
          return new Promise<AuthStatus>((resolve) => {
            resolveStalePreSignOutAuth = resolve;
          });
        }
        // Call 3+: post-signout authoritative refresh -> signed out
        return Promise.resolve({
          claude: 'missing',
          server: { mode: 'dev', signedIn: true },
        });
      });
      api.claudeSignOut = vi.fn().mockResolvedValueOnce({ status: 'signed_out' });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Open Settings -> Accounts
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
      const accountsPane = container.querySelector('.settings-pane') as HTMLElement;
      expect(within(accountsPane).getByText('stale@corp.com')).toBeTruthy();

      // Trigger a background authStatus() (Call 2) BEFORE sign-out
      act(() => {
        for (const l of syncListeners) {
          l({ kind: 'sync-state', threadId: 'thread-1', state: 'error', pendingCount: 1, detail: 'blip' });
        }
      });
      expect(resolveStalePreSignOutAuth).toBeTypeOf('function');

      // Click Sign out of Claude -> completes and transitions UI to signed out
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
        expect(within(accountsPane).getByText('Not signed in')).toBeTruthy();
      });

      // Now resolve the STALE pre-signout authStatus() with { claude: 'ok', claudeAccount: 'stale@corp.com' }
      await act(async () => {
        resolveStalePreSignOutAuth({
          claude: 'ok',
          claudeAccount: 'stale@corp.com',
          server: { mode: 'dev', signedIn: true },
        });
      });

      // Stale status MUST have been discarded: Connect Claude banner & Not signed in remain intact!
      expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
      expect(within(accountsPane).getByText('Not signed in')).toBeTruthy();
      expect(document.body.textContent).not.toContain('stale@corp.com');
    });

    it('pauses window focus authStatus polling while claudeSigningOut is active', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
        api.authStatus = vi.fn().mockResolvedValue({
          claude: 'ok',
          claudeAccount: 'claude@yvoke.dev',
          server: { mode: 'dev', signedIn: true },
        });
        let resolveSignOut!: (res: { status: 'signed_out' }) => void;
        let resolvePostSignOutAuth!: (status: AuthStatus) => void;
        api.claudeSignOut = vi.fn().mockImplementationOnce(
          () =>
            new Promise<{ status: 'signed_out' }>((resolve) => {
              resolveSignOut = resolve;
            }),
        );

        const { container } = render(<App />);
        await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

        fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
        const accountsPane = container.querySelector('.settings-pane') as HTMLElement;

        // Start claudeSignOut; after it resolves signed_out, hold post-signout authStatus pending so
        // auth.claude is already optimistically 'missing' while claudeSigningOut is STILL true!
        fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));
        api.authStatus = vi.fn().mockImplementationOnce(
          () =>
            new Promise<AuthStatus>((resolve) => {
              resolvePostSignOutAuth = resolve;
            }),
        );
        await act(async () => {
          resolveSignOut({ status: 'signed_out' });
        });
        await waitFor(() => expect(screen.getByText(/Connect Claude:/i)).toBeTruthy());
        expect(api.authStatus).toHaveBeenCalledTimes(1);

        // Window focus while claudeSigningOut is STILL true (even though auth.claude === 'missing') MUST NOT call authStatus!
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_500);
        });
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(1);

        // Once post-signout authStatus finishes, claudeSigningOut becomes false and focus polling resumes
        await act(async () => {
          resolvePostSignOutAuth({ claude: 'missing', server: { mode: 'dev', signedIn: true } });
        });
        await waitFor(() =>
          expect((within(accountsPane).getByRole('button', { name: 'Sign in to Claude' }) as HTMLButtonElement).disabled).toBe(false),
        );

        api.authStatus.mockResolvedValue({ claude: 'missing', server: { mode: 'dev', signedIn: true } });
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears claudeSignOutError when Settings closes via Close, gear toggle, sidebar thread click, or New button', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'ok',
        claudeAccount: 'claude@yvoke.dev',
        server: { mode: 'dev', signedIn: true },
      });
      api.claudeSignOut = vi.fn().mockResolvedValue({
        status: 'error',
        message: 'Keychain locked during logout',
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      const triggerErrorInAccounts = async (): Promise<HTMLElement> => {
        fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
        const pane = container.querySelector('.settings-pane') as HTMLElement;
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Claude' }));
        await waitFor(() =>
          expect(within(pane).getByRole('alert').textContent).toBe('Keychain locked during logout'),
        );
        return pane;
      };

      const reopenAccountsAndAssertNoAlert = async (): Promise<void> => {
        fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
        await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
        const pane = container.querySelector('.settings-pane') as HTMLElement;
        expect(within(pane).queryByRole('alert')).toBeNull();
      };

      // 1. Settings Close button clears claudeSignOutError
      await triggerErrorInAccounts();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await reopenAccountsAndAssertNoAlert();

      // 2. Settings gear toggle closing Settings clears claudeSignOutError
      await triggerErrorInAccounts();
      fireEvent.click(container.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
      await reopenAccountsAndAssertNoAlert();

      // 3. Clicking a thread in sidebar (onOpen) clears claudeSignOutError
      await triggerErrorInAccounts();
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
      await reopenAccountsAndAssertNoAlert();

      // 4. Clicking New in sidebar (onCreate) clears claudeSignOutError
      await triggerErrorInAccounts();
      fireEvent.click(screen.getByRole('button', { name: 'New' }));
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
      await reopenAccountsAndAssertNoAlert();
    });

    it('clears a stale claudeSignIn.error when handleClaudeSignOut runs so signing out never surfaces an old sign-in error', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let claudeState: 'ok' | 'missing' = 'ok';
      api.authStatus = vi.fn().mockImplementation(async () => ({
        claude: claudeState,
        ...(claudeState === 'ok' ? { claudeAccount: 'claude@yvoke.dev' } : {}),
        server: { mode: 'dev', signedIn: true },
      }));
      api.claudeSignIn = vi.fn().mockResolvedValueOnce({
        status: 'error',
        message: 'Stale sign-in error',
      });
      api.claudeSignOut = vi.fn().mockImplementationOnce(async () => {
        claudeState = 'missing';
        return { status: 'signed_out' as const };
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Seed a stale claudeSignIn.error while auth.claude remains 'ok' via an inline authRequired turn error
      fireEvent.click(screen.getByText('First Conversation'));
      await waitFor(() => expect(screen.getByText('Pick a playbook')).toBeTruthy());
      emitAgent({
        kind: 'error',
        threadId: 'thread-1',
        message: 'Claude: Token expired.',
        authRequired: true,
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }));
      await waitFor(() => expect(screen.getByText('Stale sign-in error')).toBeTruthy());

      // Open Settings -> Accounts (where auth.claude is still 'ok') and click Sign out of Claude
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
      const accountsPane = container.querySelector('.settings-pane') as HTMLElement;
      fireEvent.click(within(accountsPane).getByRole('button', { name: 'Sign out of Claude' }));

      // Sign-out flips auth.claude -> 'missing' (rendering Sign in to Claude in banner & Accounts),
      // and Stale sign-in error must have been cleared by handleClaudeSignOut!
      await waitFor(() => {
        expect(screen.getByText(/Connect Claude:/i)).toBeTruthy();
        expect(within(accountsPane).getByRole('button', { name: 'Sign in to Claude' })).toBeTruthy();
      });
      expect(screen.queryByText('Stale sign-in error')).toBeNull();
    });
  });

  describe('Wave 17: serverAuthRequired propagation (#4), Entra sign-out errors (#8) & decoupled catalogue loading (#9)', () => {
    it('#4: propagates serverAuthRequired to sidebar footer and Settings -> Accounts even when auth.server.signedIn is stale-true', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
      api.authStatus = vi.fn().mockResolvedValue({
        claude: 'ok',
        claudeAccount: 'claude@yvoke.dev',
        server: { mode: 'entra', signedIn: true, account: 'alice@corp.com' },
      });
      api.listThreads = vi.fn().mockResolvedValue({
        threads: storedThreads.map((t) => ({ ...t })),
        serverReachable: false,
        serverAuthRequired: true,
      });

      const { container } = render(<App />);
      await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

      // Sidebar footer shows amber dot + Sign in needed (never stale alice@corp.com)
      const footerRows = container.querySelectorAll('.thread-list-footer .account-status-row');
      expect(footerRows[0].querySelector('.account-status-dot.is-warn')).not.toBeNull();
      expect(footerRows[0].querySelector('.account-mode')?.textContent).toBe('Sign in needed');
      expect(footerRows[0].textContent).not.toContain('alice@corp.com');

      // Settings -> Accounts shows Not signed in + Sign in to Yvoke and hides Sign out of Yvoke
      fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
      const accountsPane = container.querySelector('.settings-pane') as HTMLElement;
      const yvokeDd = within(accountsPane).getByText('Yvoke account').nextElementSibling as HTMLElement;
      expect(yvokeDd.textContent).toContain('Not signed in');
      expect(within(yvokeDd).getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
      expect(within(yvokeDd).queryByRole('button', { name: 'Sign out of Yvoke' })).toBeNull();
    });

    it('#8: surfaces secret-redacted serverSignOutError (row-isolated, zero inline styles), handles 2-way post-error authStatus + authStatus-throws + inner try/catch on success + authEpochRef + unmount safety, and clears across all paths', async () => {
      const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
      let signedIn = true;
      api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
      api.authStatus = vi.fn().mockImplementation(async () => ({
        claude: 'ok',
        claudeAccount: 'claude@yvoke.dev',
        server: {
          mode: 'entra',
          signedIn,
          ...(signedIn ? { account: 'alice@corp.com' } : {}),
        },
      }));
      api.verifyAuth = vi.fn().mockResolvedValue({
        server: { status: 'ok', account: 'alice@corp.com' },
        claude: { status: 'ok', account: 'claude@yvoke.dev' },
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { container, unmount } = render(<App />);
        await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());

        const openAccounts = async (): Promise<HTMLElement> => {
          fireEvent.click(container.querySelector('button.footer-account-btn') as HTMLButtonElement);
          await waitFor(() => expect(screen.getByRole('heading', { name: 'Accounts' })).toBeTruthy());
          return container.querySelector('.settings-pane') as HTMLElement;
        };

        // 1. Secret redaction + row isolation + zero inline styles when serverSignOut rejects and authStatus still signedIn
        api.serverSignOut = vi
          .fn()
          .mockRejectedValueOnce(
            new Error(
              'Logout failed with Bearer secret.jwt.token and https://login.example/?code=secret_code_123&state=secret_state_456',
            ),
          );
        let pane = await openAccounts();
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Yvoke' }));
        await waitFor(() => {
          const yvokeDd = within(pane).getByText('Yvoke account').nextElementSibling as HTMLElement;
          const alert = within(yvokeDd).getByRole('alert');
          expect(alert.className).toContain('server-signin-error');
          expect(alert.textContent).toContain('Bearer [REDACTED]');
          expect(alert.textContent).toContain('code=[REDACTED]');
          expect(alert.textContent).toContain('state=[REDACTED]');
        });
        expect(document.body.textContent).not.toContain('secret.jwt.token');
        expect(document.body.textContent).not.toContain('secret_code_123');
        expect(document.body.textContent).not.toContain('secret_state_456');
        const claudeDd = within(pane).getByText('Claude account').nextElementSibling as HTMLElement;
        expect(within(claudeDd).queryByRole('alert')).toBeNull();
        expect(pane.querySelectorAll('[style]')).toHaveLength(0);

        // 2. Check Credentials clears serverSignOutError
        fireEvent.click(within(pane).getByRole('button', { name: 'Check Credentials' }));
        await waitFor(() => expect(within(pane).queryByRole('alert')).toBeNull());

        // 3. Post-error authStatus() throws -> still surfaces sanitized serverSignOutError
        api.serverSignOut = vi.fn().mockRejectedValueOnce(new Error('Keychain locked'));
        api.authStatus.mockRejectedValueOnce(new Error('authStatus IPC blip'));
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Yvoke' }));
        await waitFor(() =>
          expect(within(pane).getByRole('alert').textContent).toBe('Keychain locked'),
        );

        // 4. Retry clears error immediately, and partial sign-out (post-error authStatus returns signedIn: false) clears error & sets serverAuthRequired
        let rejectPartial!: (err: Error) => void;
        api.serverSignOut = vi.fn().mockImplementationOnce(
          () =>
            new Promise<void>((_res, rej) => {
              rejectPartial = rej;
            }),
        );
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Yvoke' }));
        expect(within(pane).queryByRole('alert')).toBeNull();
        signedIn = false;
        await act(async () => {
          rejectPartial(new Error('Post-logout cleanup warning'));
        });
        await waitFor(() => {
          expect(within(pane).queryByRole('alert')).toBeNull();
          expect(within(pane).getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
        });

        // Re-sign in for remaining checks
        api.serverSignIn = vi.fn().mockImplementation(async () => {
          signedIn = true;
          return { status: 'signed_in' as const, account: 'alice@corp.com' };
        });
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign in to Yvoke' }));
        await waitFor(() =>
          expect(within(pane).getByRole('button', { name: 'Sign out of Yvoke' })).toBeTruthy(),
        );

        // 5. Inner try/catch on success: post-success authStatus() throws -> optimistic signed-out state stays, ZERO bogus alert!
        api.serverSignOut = vi.fn().mockResolvedValueOnce(undefined);
        api.authStatus.mockRejectedValueOnce(new Error('Post-signout authStatus transient failure'));
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Yvoke' }));
        await waitFor(() => {
          expect(within(pane).getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy();
          expect(screen.getAllByRole('button', { name: 'Sign in to Yvoke' }).length).toBeGreaterThanOrEqual(2);
        });
        expect(within(pane).queryByRole('alert')).toBeNull();

        // Re-sign in and verify ALL Settings close paths clear serverSignOutError (Close, Save, gear toggle, sidebar onOpen, sidebar onCreate)
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign in to Yvoke' }));
        await waitFor(() =>
          expect(within(pane).getByRole('button', { name: 'Sign out of Yvoke' })).toBeTruthy(),
        );

        const seedServerSignOutError = async (): Promise<HTMLElement> => {
          const p = await openAccounts();
          api.serverSignOut = vi.fn().mockRejectedValueOnce(new Error('Entra cache error'));
          fireEvent.click(within(p).getByRole('button', { name: 'Sign out of Yvoke' }));
          await waitFor(() =>
            expect(within(p).getByRole('alert').textContent).toBe('Entra cache error'),
          );
          return p;
        };
        const assertAlertClearedOnReopen = async (): Promise<void> => {
          const p = await openAccounts();
          expect(within(p).queryByRole('alert')).toBeNull();
        };

        // Close button
        await seedServerSignOutError();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        await assertAlertClearedOnReopen();

        // Gear toggle
        await seedServerSignOutError();
        fireEvent.click(container.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
        await assertAlertClearedOnReopen();

        // Sidebar thread click (onOpen)
        await seedServerSignOutError();
        fireEvent.click(screen.getByText('First Conversation'));
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
        await assertAlertClearedOnReopen();

        // Sidebar New button (onCreate)
        await seedServerSignOutError();
        fireEvent.click(screen.getByRole('button', { name: 'New' }));
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull());
        await assertAlertClearedOnReopen();

        // Settings Save
        await seedServerSignOutError();
        fireEvent.click(screen.getByRole('button', { name: 'Models' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Models' })).toBeNull());
        await assertAlertClearedOnReopen();

        // 6. authEpochRef & unmount safety on pending serverSignOut rejection
        let rejectOnUnmount!: (err: Error) => void;
        pane = await openAccounts();
        api.serverSignOut = vi.fn().mockImplementationOnce(
          () =>
            new Promise<void>((_res, rej) => {
              rejectOnUnmount = rej;
            }),
        );
        fireEvent.click(within(pane).getByRole('button', { name: 'Sign out of Yvoke' }));
        unmount();
        await act(async () => {
          rejectOnUnmount(new Error('Late failure after unmount'));
        });
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('#9: loads catalogues while authStatus() never resolves (dev via getSettings, entra via refreshThreads), gates when serverAuthRequired, deduplicates across concurrent triggers, and passes { forceRefresh: true } ONLY on window focus', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;

        // Case A: dev mode with NEVER-RESOLVING authStatus() -> catalogues still load once (deduped with refreshThreads)!
        const neverAuth = new Promise<AuthStatus>(() => undefined);
        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'dev' });
        api.authStatus = vi.fn().mockReturnValue(neverAuth);
        api.listThreads = vi.fn().mockResolvedValue({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: true,
          serverAuthRequired: false,
        });
        api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

        const first = render(<App />);
        await waitFor(() => {
          expect(api.listPrompts).toHaveBeenCalledTimes(1);
          expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
        });
        // Mount authStatus() called with 0 args
        expect(api.authStatus).toHaveBeenCalledTimes(1);
        expect(api.authStatus.mock.calls[0]).toHaveLength(0);
        first.unmount();

        // Case B: entra signed-in mode with NEVER-RESOLVING authStatus() -> refreshThreads loads catalogues once!
        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
        api.authStatus = vi.fn().mockReturnValue(neverAuth);
        api.listThreads = vi.fn().mockResolvedValue({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: true,
          serverAuthRequired: false,
        });
        api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

        const second = render(<App />);
        await waitFor(() => {
          expect(api.listPrompts).toHaveBeenCalledTimes(1);
          expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
        });
        second.unmount();

        // Case C: entra signed-out (serverAuthRequired: true) with NEVER-RESOLVING authStatus() -> 0 catalogue calls!
        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
        api.authStatus = vi.fn().mockReturnValue(neverAuth);
        api.listThreads = vi.fn().mockResolvedValue({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: false,
          serverAuthRequired: true,
        });
        api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

        const third = render(<App />);
        await waitFor(() => expect(screen.getByText('First Conversation')).toBeTruthy());
        expect(api.listPrompts).toHaveBeenCalledTimes(0);
        expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(0);
        third.unmount();

        // Case D: Deduplication when getSettings (dev) + refreshThreads + authStatus all resolve -> exactly 1 catalogue call
        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'dev' });
        api.authStatus = vi.fn().mockResolvedValue({
          claude: 'missing',
          server: { mode: 'dev', signedIn: true },
        });
        api.listThreads = vi.fn().mockResolvedValue({
          threads: storedThreads.map((t) => ({ ...t })),
          serverReachable: false,
          serverAuthRequired: false,
        });
        api.listPrompts = vi.fn().mockResolvedValue([]);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

        const fourth = render(<App />);
        await waitFor(() => expect(screen.getByText(/Connect Claude:/i)).toBeTruthy());
        expect(api.listPrompts).toHaveBeenCalledTimes(1);
        expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
        // Mount called authStatus with 0 args
        expect(api.authStatus.mock.calls[0]).toHaveLength(0);

        // 10s poll calls refreshServer -> authStatus() with 0 args (and does NOT stall if authStatus is slow)
        const callsBeforePoll = api.authStatus.mock.calls.length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        await waitFor(() => expect(api.authStatus.mock.calls.length).toBeGreaterThan(callsBeforePoll));
        expect(api.authStatus.mock.calls[callsBeforePoll]).toHaveLength(0);

        // Agent error & Sync error call authStatus() with 0 args
        const callsBeforeEvents = api.authStatus.mock.calls.length;
        emitAgent({ kind: 'error', threadId: 'thread-1', message: 'Network hiccup' });
        act(() => {
          for (const l of syncListeners) {
            l({ kind: 'sync-state', threadId: 'thread-1', state: 'error', pendingCount: 1, detail: 'blip' });
          }
        });
        await waitFor(() => expect(api.authStatus.mock.calls.length).toBe(callsBeforeEvents + 2));
        expect(api.authStatus.mock.calls[callsBeforeEvents]).toHaveLength(0);
        expect(api.authStatus.mock.calls[callsBeforeEvents + 1]).toHaveLength(0);

        // Window 'focus' while auth.claude === 'missing' MUST pass { forceRefresh: true }!
        const callsBeforeFocus = api.authStatus.mock.calls.length;
        act(() => {
          window.dispatchEvent(new Event('focus'));
        });
        expect(api.authStatus).toHaveBeenCalledTimes(callsBeforeFocus + 1);
        expect(api.authStatus.mock.calls[callsBeforeFocus]).toEqual([{ forceRefresh: true }]);

        fourth.unmount();
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears stale serverAuthRequired on entra -> dev save and keeps the 10s reconnect poll running in dev mode even when post-save listThreads() throws', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const api = (window as unknown as { api: Record<string, ReturnType<typeof vi.fn>> }).api;
        let mode: 'entra' | 'dev' = 'entra';
        let postSaveListShouldThrow = false;

        api.getSettings = vi.fn().mockResolvedValue({ ...sampleSettings(), serverAuthMode: 'entra' });
        api.setSettings = vi.fn().mockImplementation(async (update: Partial<AppSettings>) => {
          if (update.serverAuthMode === 'dev') {
            mode = 'dev';
            postSaveListShouldThrow = true;
          }
          return { ...sampleSettings(), ...update };
        });
        api.authStatus = vi.fn().mockImplementation(async () => ({
          claude: 'ok',
          server:
            mode === 'dev'
              ? { mode: 'dev', signedIn: true }
              : { mode: 'entra', signedIn: false },
        }));
        api.listThreads = vi.fn().mockImplementation(async () => {
          if (postSaveListShouldThrow) {
            postSaveListShouldThrow = false;
            throw new Error('Transient IPC error right after save');
          }
          return {
            threads: storedThreads.map((t) => ({ ...t })),
            serverReachable: mode === 'dev',
            serverAuthRequired: mode === 'entra',
          };
        });
        api.listPrompts = vi.fn().mockResolvedValue(PROMPTS);
        api.listOrchestratorProfiles = vi.fn().mockResolvedValue([]);

        const { container } = render(<App />);
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Sign in to Yvoke' })).toBeTruthy(),
        );
        expect(api.listPrompts).not.toHaveBeenCalled();

        // Switch Entra (signed out, serverAuthRequired: true) -> Dev token and Save while post-save listThreads() rejects
        fireEvent.click(container.querySelector('[data-tip="Settings"]') as HTMLButtonElement);
        fireEvent.click(screen.getByRole('button', { name: 'Dev token' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.setSettings).toHaveBeenCalledTimes(1));
        // Wait for the throwing post-save refreshThreads() to settle
        await waitFor(() => expect(warnSpy).toHaveBeenCalled());
        const listCallsAfterSave = api.listThreads.mock.calls.length;
        expect(api.listPrompts).not.toHaveBeenCalled();

        // Advance 10s -> 10s reconnect poll MUST fire in dev mode (not stalled by stale serverAuthRequired)
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });

        await waitFor(() => {
          expect(api.listThreads.mock.calls.length).toBeGreaterThan(listCallsAfterSave);
          expect(api.listPrompts).toHaveBeenCalledTimes(1);
          expect(api.listOrchestratorProfiles).toHaveBeenCalledTimes(1);
        });
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});


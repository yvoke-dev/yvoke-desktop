// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { ChatView } from '../../src/renderer/src/components/ChatView';
import type { LiveTurn } from '../../src/renderer/src/App';
import type {
  AppSettings,
  ChatMessage,
  McpPromptInfo,
  OrchestratorProfile,
  PlaybookValidation,
  PlaybookValidationRequest,
  ThreadMeta,
} from '../../src/shared/types';

/**
 * The playbook preflight check, from the composer's side: which submits trigger it, what the
 * recommendation card offers, and — the part that matters most — that nothing it can do stops a
 * question from being asked.
 */

const PROMPTS: McpPromptInfo[] = [
  { name: 'oim-getting-started', title: 'Getting started', description: 'Onboarding.', arguments: [] },
  { name: 'oim-schema', title: 'Schema', description: 'Tables and columns.', arguments: [] },
];

const THREAD: ThreadMeta = {
  id: 't1',
  title: 'New Conversation',
  model: 'sonnet',
  thinkingLevel: 'medium',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
  totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  syncState: 'synced',
};

const IDLE: LiveTurn = { running: false, liveText: '', liveThinking: '', blocks: [] };

const ORDINARY: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-orchestrator',
  reviewerPlaybook: 'oim-orchestrator-reviewer',
  specialistPlaybooks: [],
};

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
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
    ...overrides,
  };
}

let validatePlaybook: Mock<(request: PlaybookValidationRequest) => Promise<PlaybookValidation>>;
let onSend: Mock<(text: string, promptName?: string) => void>;
let onInterrupt: Mock<() => void>;
let writeText: Mock<(text: string) => Promise<void>>;
let originalClipboard: PropertyDescriptor | undefined;

interface ChatOpts {
  thread?: ThreadMeta;
  settings?: AppSettings;
  messages?: ChatMessage[];
  prompts?: McpPromptInfo[];
  profiles?: OrchestratorProfile[];
  liveTurn?: LiveTurn;
  onInterrupt?: () => void;
}

function chat(opts: ChatOpts = {}): React.JSX.Element {
  return (
    <ChatView
      thread={opts.thread ?? THREAD}
      settings={opts.settings ?? settings()}
      messages={opts.messages ?? []}
      prompts={opts.prompts ?? PROMPTS}
      profiles={opts.profiles ?? []}
      liveTurn={opts.liveTurn ?? IDLE}
      onSend={onSend}
      onInterrupt={opts.onInterrupt ?? onInterrupt}
      onPatchThread={() => undefined}
      onFeedback={async () => undefined}
    />
  );
}

function renderChat(opts: ChatOpts = {}) {
  return render(chat(opts));
}

/** A verdict the test holds open, so the composer can be observed mid-check. */
function deferred(): { promise: Promise<PlaybookValidation>; settle: (v: PlaybookValidation) => void } {
  let settle!: (v: PlaybookValidation) => void;
  const promise = new Promise<PlaybookValidation>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Pick a playbook from the first-message picker, type a question, and press Send. The picker row
 * is found within the list rather than by page text, because once a playbook is attached its
 * title also appears on the composer chip.
 */
function ask(container: HTMLElement, question: string, playbookTitle?: string): void {
  if (playbookTitle) {
    const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
      r.textContent?.includes(playbookTitle),
    );
    fireEvent.click(row!);
  }
  const textarea = container.querySelector('textarea')!;
  fireEvent.change(textarea, { target: { value: question } });
  fireEvent.click(container.querySelector('.composer-send')!);
}

beforeEach(() => {
  validatePlaybook = vi.fn(async () => ({ plausible: true }) as PlaybookValidation);
  onSend = vi.fn<(text: string, promptName?: string) => void>();
  onInterrupt = vi.fn<() => void>();
  (window as unknown as { api: unknown }).api = { validatePlaybook };

  // Stubbed per test and restored below: a leaked always-succeeding clipboard would stop a later
  // test from ever reaching CopyButton's execCommand fallback.
  writeText = vi.fn(async () => undefined);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe('playbook preflight', () => {
  it('checks the selected playbook and sends when it fits', async () => {
    const { container } = renderChat();
    ask(container, 'How do I onboard?', 'Getting started');

    await waitFor(() =>
      expect(validatePlaybook).toHaveBeenCalledWith({
        threadId: 't1',
        text: 'How do I onboard?',
        promptName: 'oim-getting-started',
      }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('How do I onboard?', 'oim-getting-started'));
  });

  it('holds the message and shows the recommendation when the playbook does not fit', async () => {
    validatePlaybook.mockResolvedValue({
      plausible: false,
      reason: 'This question is about table columns.',
      suggestedPlaybookName: 'oim-schema',
      suggestedPlaybookTitle: 'Schema',
    });
    const { container } = renderChat();
    ask(container, 'Which columns does Person have?', 'Getting started');

    await waitFor(() => expect(screen.getByText('This question is about table columns.')).toBeTruthy());
    expect(onSend).not.toHaveBeenCalled();
    // The draft has to survive, or the recommendation costs the user their question.
    expect(container.querySelector('textarea')!.value).toBe('Which columns does Person have?');
  });

  it('sends under the suggested playbook when the recommendation is taken', async () => {
    validatePlaybook.mockResolvedValue({
      plausible: false,
      reason: 'Wrong area.',
      suggestedPlaybookName: 'oim-schema',
      suggestedPlaybookTitle: 'Schema',
    });
    const { container } = renderChat();
    ask(container, 'Which columns does Person have?', 'Getting started');

    await waitFor(() => expect(screen.getByText('Switch to Schema')).toBeTruthy());
    fireEvent.click(screen.getByText('Switch to Schema'));
    expect(onSend).toHaveBeenCalledWith('Which columns does Person have?', 'oim-schema');
  });

  it('sends under the original playbook when the recommendation is declined', async () => {
    validatePlaybook.mockResolvedValue({ plausible: false, reason: 'Wrong area.' });
    const { container } = renderChat();
    ask(container, 'Which columns does Person have?', 'Getting started');

    await waitFor(() => expect(screen.getByText('Send anyway')).toBeTruthy());
    // No suggestion came back, so there is nothing to switch to — only the escape hatch.
    expect(screen.queryByText(/^Switch to/)).toBeNull();
    fireEvent.click(screen.getByText('Send anyway'));
    expect(onSend).toHaveBeenCalledWith('Which columns does Person have?', 'oim-getting-started');
  });

  // The card is a question the user has answered by pressing Send again; re-checking would put
  // the same card back and leave a disliked question permanently unsendable.
  it('does not re-check when the composer sends again with the card still open', async () => {
    validatePlaybook.mockResolvedValue({ plausible: false, reason: 'Wrong area.' });
    const { container } = renderChat();
    ask(container, 'Which columns does Person have?', 'Getting started');
    await waitFor(() => expect(screen.getByText('Send anyway')).toBeTruthy());

    fireEvent.click(container.querySelector('.composer-send')!);
    expect(onSend).toHaveBeenCalledWith('Which columns does Person have?', 'oim-getting-started');
    expect(validatePlaybook).toHaveBeenCalledTimes(1);
  });

  it('sends anyway when the check itself fails', async () => {
    validatePlaybook.mockRejectedValue(new Error('bridge is down'));
    const { container } = renderChat();
    ask(container, 'How do I onboard?', 'Getting started');

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('How do I onboard?', 'oim-getting-started'));
  });

  // A playbook is what scopes a single-agent answer, so there is nothing to check *and* nothing
  // to send: the question is refused where the web app refuses it too.
  it('refuses a single-agent question with no playbook attached', () => {
    const { container } = renderChat();
    ask(container, 'Just asking.');
    expect(validatePlaybook).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Playbook required')).toBeTruthy();
    // The draft survives the refusal — picking a playbook is all that is left to do.
    expect(container.querySelector('textarea')!.value).toBe('Just asking.');
  });

  it('clears the refusal and sends once a playbook is picked', async () => {
    const { container } = renderChat();
    ask(container, 'Just asking.');
    expect(screen.getByText('Playbook required')).toBeTruthy();

    // The picker is still up — it is the remedy — so the same question goes out under a playbook.
    ask(container, 'Just asking.', 'Getting started');
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Just asking.', 'oim-getting-started'));
    expect(screen.queryByText('Playbook required')).toBeNull();
  });

  // Fails open where the gate would otherwise be a dead end: an empty catalogue (an unreachable
  // server) offers nothing to pick, so refusing would leave the composer unable to send anything.
  it('sends without a playbook when there are none to pick', () => {
    const { container } = renderChat({ prompts: [] });
    ask(container, 'Just asking.');
    expect(screen.queryByText('Playbook required')).toBeNull();
    expect(onSend).toHaveBeenCalledWith('Just asking.', undefined);
  });

  it('skips the check when it is switched off', () => {
    const { container } = renderChat({ settings: settings({ playbookValidationEnabled: false }) });
    ask(container, 'How do I onboard?', 'Getting started');
    expect(validatePlaybook).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith('How do I onboard?', 'oim-getting-started');
  });

  // The check is an unawaited promise nothing can recall, so the composer has to be able to
  // disown one. Without a per-run ticket a stale verdict lands, unlocks the composer under a
  // newer check, and posts a draft the user has already replaced.
  it('disowns a check the user has navigated away from, and never sends its draft', async () => {
    const first = deferred();
    const second = deferred();
    validatePlaybook.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { container, rerender } = renderChat();
    ask(container, 'the first question', 'Getting started');
    await waitFor(() => expect(container.querySelector('.preflight-checking')).toBeTruthy());

    // Away to another conversation and back: the composer unlocks, but check #1 is still running.
    rerender(chat({ thread: { ...THREAD, id: 't2', title: 'Other' } }));
    rerender(chat());

    ask(container, 'the second question', 'Getting started');
    await waitFor(() => expect(validatePlaybook).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.settle({ plausible: true });
      await first.promise;
    });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      second.settle({ plausible: true });
      await second.promise;
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('the second question', 'oim-getting-started');
  });

  // Picking a playbook used to wipe the composer, so a question typed before the playbook was
  // chosen had to be typed again. Only the "/token" being completed is the picker's to consume.
  it('keeps the typed question when a playbook is picked', () => {
    const { container } = renderChat();
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'How do I onboard?' } });

    const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
      r.textContent?.includes('Getting started'),
    );
    fireEvent.click(row!);
    expect(container.querySelector('textarea')!.value).toBe('How do I onboard?');
  });

  // The autocomplete's "/token" is not a question — it is the selection gesture, so it goes.
  it('consumes the slash token when the playbook comes from the autocomplete', () => {
    const { container } = renderChat();
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '/getting' } });

    fireEvent.click(container.querySelector<HTMLButtonElement>('.prompt-option')!);
    expect(container.querySelector('textarea')!.value).toBe('');
  });

  // The verdict is about the playbook that was sent for checking. If the selection could move
  // under it, the message would go out under a playbook nothing checked — so every control that
  // decides what the message IS stands down for the duration, the picker by leaving the pane.
  it('freezes the playbook selection while the check runs', async () => {
    const gate = deferred();
    validatePlaybook.mockReturnValue(gate.promise);

    const { container } = renderChat();
    expect(container.querySelectorAll('.picker-row').length).toBeGreaterThan(0);
    ask(container, 'How do I onboard?', 'Getting started');
    await waitFor(() => expect(container.querySelector('.preflight-checking')).toBeTruthy());

    expect(container.querySelectorAll('.picker-row')).toHaveLength(0);
    expect(container.querySelector<HTMLButtonElement>('.active-playbook-remove')!.disabled).toBe(true);
    expect(container.querySelector('textarea')!.disabled).toBe(true);

    await act(async () => {
      gate.settle({ plausible: true });
      await gate.promise;
    });
    expect(onSend).toHaveBeenCalledWith('How do I onboard?', 'oim-getting-started');
  });

  // The screenful of playbooks is what the user was choosing from a moment ago; leaving it up
  // buries the recommendation they now have to act on.
  it('stands the picker down while a recommendation is open', async () => {
    validatePlaybook.mockResolvedValue({
      plausible: false,
      reason: 'Wrong area.',
      suggestedPlaybookName: 'oim-schema',
      suggestedPlaybookTitle: 'Schema',
    });
    const { container } = renderChat();
    ask(container, 'Which columns does Person have?', 'Getting started');

    await waitFor(() => expect(container.querySelector('.preflight-card')).toBeTruthy());
    expect(container.querySelectorAll('.picker-row')).toHaveLength(0);
  });

  // The screenful of playbooks used to push every card below the fold, so a refused send looked
  // like nothing had happened at all. The cards live outside the scroller now.
  it('shows the cards above the conversation, outside its scroller', () => {
    const { container } = renderChat();
    ask(container, 'Just asking.');

    const strip = container.querySelector('.chat-notices')!;
    expect(strip.contains(screen.getByText('Playbook required'))).toBe(true);
    expect(container.querySelector('.messages')!.contains(strip)).toBe(false);
    // Before the transcript in document order, so it is on screen whatever the scroll position.
    expect(strip.compareDocumentPosition(container.querySelector('.messages')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  // An empty strip would still take a slice of the transcript's height.
  it('does not render the strip when there is nothing to say', () => {
    const { container } = renderChat();
    expect(container.querySelector('.chat-notices')).toBeNull();
  });

  // Orchestrator mode drives its own playbooks from the profile, so a message carries none and
  // there is nothing to check — the picker is not even rendered there.
  it('skips the check in orchestrator mode', () => {
    const { container } = renderChat({ thread: { ...THREAD, orchestratorProfile: 'OIM' } });
    ask(container, 'How do I onboard?');
    expect(validatePlaybook).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith('How do I onboard?', undefined);
  });

  it('keeps the active playbook across messages so follow-ups send immediately without repeating preflight', async () => {
    const { container, rerender } = renderChat();
    ask(container, 'First question', 'Getting started');

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('First question', 'oim-getting-started'));
    expect(validatePlaybook).toHaveBeenCalledTimes(1);

    // Simulate assistant reply landed
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'First question', playbook: 'oim-getting-started', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'First answer', createdAt: '' },
    ];
    rerender(chat({ messages: existingMessages }));

    // Send follow-up question
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Follow up question' } });
    fireEvent.click(container.querySelector('.composer-send')!);

    expect(onSend).toHaveBeenCalledWith('Follow up question', 'oim-getting-started');
    // Preflight was not re-run for the follow-up under the same playbook
    expect(validatePlaybook).toHaveBeenCalledTimes(1);
  });

  it('initializes active playbook from the last user message when opening an existing thread', () => {
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Old question', playbook: 'oim-schema', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'Old answer', createdAt: '' },
    ];
    const { container } = renderChat({ messages: existingMessages });

    expect(container.querySelector('.active-playbook')?.textContent).toContain('Schema');
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Follow up' } });
    fireEvent.click(container.querySelector('.composer-send')!);

    expect(onSend).toHaveBeenCalledWith('Follow up', 'oim-schema');
  });

  it('runs preflight when the user switches to a different playbook for a follow-up question', async () => {
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Old question', playbook: 'oim-getting-started', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'Old answer', createdAt: '' },
    ];
    const { container } = renderChat({ messages: existingMessages });

    // Switch playbook via autocomplete
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '/schema' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.prompt-option')!);

    // Type new question and submit
    fireEvent.change(textarea, { target: { value: 'Different area question' } });
    fireEvent.click(container.querySelector('.composer-send')!);

    await waitFor(() =>
      expect(validatePlaybook).toHaveBeenCalledWith({
        threadId: 't1',
        text: 'Different area question',
        promptName: 'oim-schema',
      }),
    );
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Different area question', 'oim-schema'));
  });

  it('renders a copy button on user messages that copies the question text', async () => {
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Which database table stores IT Shop requests?', createdAt: '' },
    ];
    const { container } = renderChat({ messages: existingMessages });

    const userMessage = container.querySelector('.message.user');
    expect(userMessage).toBeTruthy();

    const copyBtn = userMessage?.querySelector('.icon-button');
    expect(copyBtn).toBeTruthy();
    expect(copyBtn?.getAttribute('data-tip')).toBe('Copy question');

    fireEvent.click(copyBtn!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Which database table stores IT Shop requests?'));
    await waitFor(() => expect(copyBtn?.getAttribute('data-tip')).toBe('Copied'));
  });

  it('does not auto-select any playbook when starting a new conversation', () => {
    const { container } = renderChat({ messages: [] });
    expect(container.querySelector('.active-playbook')).toBeNull();
    expect(container.querySelector('.picker')).toBeTruthy();
  });

  it('clears active playbook when switching from an existing thread to a new empty thread', async () => {
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Old question', playbook: 'oim-schema', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'Old answer', createdAt: '' },
    ];
    const { container, rerender } = renderChat({ messages: existingMessages });
    await waitFor(() => expect(container.querySelector('.active-playbook')?.textContent).toContain('Schema'));

    // Switch to a new empty conversation
    rerender(chat({ thread: { ...THREAD, id: 't-new', title: 'New chat' }, messages: [] }));
    expect(container.querySelector('.active-playbook')).toBeNull();
    expect(container.querySelector('.picker')).toBeTruthy();
  });

  /**
   * Regression: the playbook was mirrored into state by an effect that read `activePrompt` without
   * depending on it, so the render that switched conversations still saw the PREVIOUS one's pick and
   * skipped — leaving the new conversation with no playbook at all. Both conversations have to carry
   * one for the bug to show: with none selected on the way out the stale read is harmlessly null.
   */
  it('adopts the new conversation\u2019s playbook when switching between two that both have one', async () => {
    const inSchema: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Which table?', playbook: 'oim-schema', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'That one.', createdAt: '' },
    ];
    const inGettingStarted: ChatMessage[] = [
      { localId: 'u2', role: 'user', content: 'How do I start?', playbook: 'oim-getting-started', createdAt: '' },
    ];
    const { container, rerender } = renderChat({ messages: inSchema });
    await waitFor(() => expect(container.querySelector('.active-playbook')?.textContent).toContain('Schema'));

    rerender(chat({ thread: { ...THREAD, id: 't2', title: 'Other' }, messages: inGettingStarted }));
    await waitFor(() =>
      expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started'),
    );
  });

  /**
   * Regression: clearing the playbook only stuck until the message list next changed identity —
   * which a `server-ids` sync event does after every synced turn — and then it was re-selected from
   * the history it had just been cleared against. Backspace and the remove button are the two ways
   * to clear, and they used to disagree about recording it.
   */
  it.each([
    ['Backspace on an empty composer', (c: HTMLElement) => fireEvent.keyDown(c.querySelector('textarea')!, { key: 'Backspace' })],
    ['the remove button', (c: HTMLElement) => fireEvent.click(c.querySelector('.active-playbook-remove')!)],
  ])('keeps the playbook cleared via %s when the message list is replaced', async (_label, clear) => {
    const existingMessages: ChatMessage[] = [
      { localId: 'u1', role: 'user', content: 'Old question', playbook: 'oim-schema', createdAt: '' },
      { localId: 'a1', role: 'assistant', content: 'Old answer', createdAt: '' },
    ];
    const { container, rerender } = renderChat({ messages: existingMessages });
    await waitFor(() => expect(container.querySelector('.active-playbook')).toBeTruthy());

    clear(container);
    expect(container.querySelector('.active-playbook')).toBeNull();

    // Same content, new array identity — what App does when server ids come back for the turn.
    rerender(chat({ messages: existingMessages.map((m) => ({ ...m })) }));
    await waitFor(() => expect(container.querySelector('.active-playbook')).toBeNull());

    // Still reachable afterwards: a clear is not a lock.
    fireEvent.change(container.querySelector('textarea')!, { target: { value: '/getting' } });
    fireEvent.click(container.querySelector<HTMLButtonElement>('.prompt-option')!);
    expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started');
  });
});

describe('the multi-agent profile selector', () => {
  const PROTOTYPE: OrchestratorProfile = { ...ORDINARY, name: 'OIM Browsing', prototype: true };

  /** The agent-mode select's option labels, in order. '' when the selector is not rendered. */
  function options(container: HTMLElement): string[] {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]');
    return select ? Array.from(select.options).map((o) => o.textContent ?? '') : [];
  }

  it('omits a prototype profile while the setting is off', () => {
    const { container } = renderChat({ profiles: [ORDINARY, PROTOTYPE] });
    expect(options(container)).toEqual(['Single agent', 'OIM']);
  });

  it('offers it, badged, once the setting is on', () => {
    const { container } = renderChat({
      profiles: [ORDINARY, PROTOTYPE],
      settings: settings({ showPrototypePlaybooks: true }),
    });
    expect(options(container)).toEqual(['Single agent', 'OIM', '🧪 OIM Browsing']);
  });

  // A select whose value matches no option falls back to the first one, so the composer would read
  // "Single agent" over a thread that is still running the profile — and picking anything else
  // would be the only way to make it agree with itself again.
  it('keeps the profile the thread is bound to, setting off', () => {
    const { container } = renderChat({
      thread: { ...THREAD, orchestratorProfile: 'OIM Browsing' },
      profiles: [ORDINARY, PROTOTYPE],
    });
    expect(options(container)).toEqual(['Single agent', 'OIM', '🧪 OIM Browsing']);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!.value)
      .toBe('OIM Browsing');
  });

  // Otherwise the composer offers a dropdown whose only entry means "no profile", which is what
  // its absence already means.
  it('renders no selector when every profile is a hidden prototype', () => {
    const { container } = renderChat({ profiles: [PROTOTYPE] });
    expect(options(container)).toEqual([]);
  });
});

describe('composer redesign (inline send/stop and split toolbar)', () => {
  describe('negative event tests', () => {
    it('send button is disabled on empty string and clicking it does not call onSend', () => {
      const { container } = renderChat({ prompts: [] });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.disabled).toBe(true);
      fireEvent.click(sendBtn);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('send button is disabled on whitespace-only draft and clicking it does not call onSend', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: '   \n\t  ' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.disabled).toBe(true);
      fireEvent.click(sendBtn);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Enter alone in textarea with a valid draft does not call onSend (allows multiline typing)', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'First sentence. Second sentence.' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Cmd+Enter (macOS) in textarea with a valid draft calls onSend', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Valid question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Valid question', undefined);
    });

    it('pressing Ctrl+Enter (Windows) in textarea with a valid draft calls onSend', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Valid question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Valid question', undefined);
    });

    it('pressing Cmd+Enter or Ctrl+Enter in textarea with whitespace-only draft does not call onSend', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: '   \n\t  ' } });
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Cmd+Enter while liveTurn.running is true does not call onSend', () => {
      const { container } = renderChat({
        prompts: [],
        liveTurn: { ...IDLE, running: true },
      });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Valid question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Cmd+Enter while checking is true does not call onSend', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);
      const { container } = renderChat();
      ask(container, 'First question', 'Getting started');
      await waitFor(() => expect(container.querySelector('.preflight-checking')).toBeTruthy());

      const textarea = container.querySelector('textarea')!;
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('pressing Cmd+Enter while liveTurn.clarifyingQuestion is non-null does not call onSend', () => {
      const { container } = renderChat({
        prompts: [],
        liveTurn: {
          ...IDLE,
          clarifyingQuestion: {
            toolUseId: 'cq-1',
            question: 'Which region?',
            options: [{ label: 'US' }, { label: 'EU' }],
          },
        },
      });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Valid question' } });
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('mutual exclusivity tests', () => {
    it('renders Stop button when liveTurn.running is true; clicking it calls onInterrupt and never onSend', () => {
      const { container } = renderChat({
        liveTurn: { ...IDLE, running: true },
      });
      const stopBtn = container.querySelector<HTMLButtonElement>('.danger.composer-send');
      expect(stopBtn).not.toBeNull();
      expect(stopBtn?.textContent).toContain('Stop');
      fireEvent.click(stopBtn!);
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('renders Send button when liveTurn.running is false; clicking it with valid draft calls onSend and never onInterrupt', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Valid question' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.classList.contains('danger')).toBe(false);
      expect(sendBtn.textContent).toContain('Send');
      fireEvent.click(sendBtn);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onInterrupt).not.toHaveBeenCalled();
    });
  });

  describe('dynamic state transition test', () => {
    it('with empty text, attaching an image enables Send; clicking .attachment-pill-remove returns Send to disabled === true', async () => {
      const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const originalFileReader = window.FileReader;
      class MockFileReader {
        onload: any = null;
        readAsDataURL() {
          setTimeout(() => {
            if (this.onload) {
              this.onload({ target: { result: `data:image/png;base64,${fakeBase64}` } });
            }
          }, 10);
        }
        get result() {
          return `data:image/png;base64,${fakeBase64}`;
        }
      }
      window.FileReader = MockFileReader as any;

      try {
        const { container } = renderChat({ prompts: [] });
        const textarea = container.querySelector('textarea')!;
        const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
        expect(sendBtn.disabled).toBe(true);

        const file = new File(['fake content'], 'diagram.png', { type: 'image/png' });
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ type: 'image/png', getAsFile: () => file }],
          },
        });

        await waitFor(() => {
          expect(container.querySelector('.composer-attachments')).not.toBeNull();
        });
        expect(sendBtn.disabled).toBe(false);

        const removeBtn = container.querySelector('.attachment-pill-remove')!;
        fireEvent.click(removeBtn);

        expect(container.querySelector('.composer-attachments')).toBeNull();
        expect(sendBtn.disabled).toBe(true);
      } finally {
        window.FileReader = originalFileReader;
      }
    });
  });

  describe('attach button boundary tests', () => {
    it('.composer-attach-btn has disabled === true when liveTurn.running === true', () => {
      const { container } = renderChat({
        liveTurn: { ...IDLE, running: true },
      });
      const attachBtn = container.querySelector<HTMLButtonElement>('.composer-attach-btn')!;
      expect(attachBtn.disabled).toBe(true);
    });

    it('.composer-attach-btn has disabled === true when checking === true', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);
      const { container } = renderChat();
      ask(container, 'Checking question', 'Getting started');
      await waitFor(() => expect(container.querySelector('.preflight-checking')).toBeTruthy());

      const attachBtn = container.querySelector<HTMLButtonElement>('.composer-attach-btn')!;
      expect(attachBtn.disabled).toBe(true);
    });
  });

  describe('strict structural pinning tests', () => {
    it('textarea.parentElement and sendBtn.parentElement are both .composer-input, and .composer-controls has no .composer-send', () => {
      const { container } = renderChat();
      const textarea = container.querySelector('textarea')!;
      const sendBtn = container.querySelector('.composer-send')!;
      expect(textarea.parentElement?.classList.contains('composer-input')).toBe(true);
      expect(sendBtn.parentElement?.classList.contains('composer-input')).toBe(true);
      expect(container.querySelector('.composer-controls .composer-send')).toBeNull();
    });

    it('.composer-controls direct children are .composer-controls-left and .composer-controls-right', () => {
      const { container } = renderChat();
      const controls = container.querySelector('.composer-controls')!;
      expect(controls.children.length).toBe(2);
      expect(controls.children[0].classList.contains('composer-controls-left')).toBe(true);
      expect(controls.children[1].classList.contains('composer-controls-right')).toBe(true);
    });

    it('.composer-controls-left contains .composer-attach-btn', () => {
      const { container } = renderChat();
      const left = container.querySelector('.composer-controls-left')!;
      expect(left.querySelector('.composer-attach-btn')).not.toBeNull();
    });

    it('when a playbook is selected, .composer-controls-left contains .active-playbook', async () => {
      const { container } = renderChat();
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.composer-controls-left .active-playbook')).not.toBeNull();
      });
    });

    it('.composer-controls-right contains 2 selects by default (Model, Thinking Level) when profiles: []', () => {
      const { container } = renderChat({ profiles: [] });
      const right = container.querySelector('.composer-controls-right')!;
      expect(right.querySelectorAll('select').length).toBe(2);
    });

    it('.composer-controls-right contains 3 selects (Profile, Model, Thinking Level) when profiles: [ORDINARY]', () => {
      const { container } = renderChat({ profiles: [ORDINARY] });
      const right = container.querySelector('.composer-controls-right')!;
      expect(right.querySelectorAll('select').length).toBe(3);
    });

    it('.composer-controls-right contains 1 select and .orchestrator-hint when orchestratorActive is true', () => {
      const { container } = renderChat({
        thread: { ...THREAD, orchestratorProfile: 'OIM' },
        profiles: [ORDINARY],
      });
      const right = container.querySelector('.composer-controls-right')!;
      expect(right.querySelectorAll('select').length).toBe(1);
      expect(right.querySelector('.orchestrator-hint')).not.toBeNull();
    });
  });

  describe('multi-agent playbook suppression and isolation', () => {
    function StatefulChatView(opts: ChatOpts = {}) {
      const [thread, setThread] = useState<ThreadMeta>(opts.thread ?? THREAD);
      return (
        <ChatView
          {...opts}
          thread={thread}
          settings={opts.settings ?? settings()}
          messages={opts.messages ?? []}
          prompts={opts.prompts ?? PROMPTS}
          profiles={opts.profiles ?? [ORDINARY]}
          liveTurn={opts.liveTurn ?? IDLE}
          onSend={onSend}
          onInterrupt={opts.onInterrupt ?? onInterrupt}
          onPatchThread={(patch) => setThread((prev) => ({ ...prev, ...patch }))}
          onFeedback={async () => undefined}
        />
      );
    }

    it('Test 1.1 (Playbook Badge Suppression): In single-agent mode with an active or draft playbook override, selecting an orchestrator profile hides the playbook badge', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.active-playbook')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      expect(container.querySelector('.active-playbook')).toBeNull();
      expect(container.querySelector('.chat-composer-prompt')).toBeNull();
    });

    it('Test 1.2 (Draft Playbook Restoration): In a stateful harness, setting a draft playbook override, switching dropdown to an orchestrator profile, then switching back to Single agent restores the draft playbook chip', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started');
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });
      expect(container.querySelector('.active-playbook')).toBeNull();

      fireEvent.change(select, { target: { value: '' } });
      expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started');
    });

    it('Test 1.3a (Playbook Notice Dismissal & Empty Container Prevention): With Playbook required refusal active, switching to orchestrator profile dismisses the card and does not leave an empty .chat-notices container', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Question without playbook' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      fireEvent.click(sendBtn);

      expect(container.querySelector('.playbook-required')).not.toBeNull();
      expect(container.querySelector('.chat-notices')).not.toBeNull();

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      expect(container.querySelector('.playbook-required')).toBeNull();
      expect(container.querySelector('.chat-notices')).toBeNull();
    });

    it('Test 1.3a (preflight card): With preflight recommendation card standing, switching to orchestrator profile dismisses the card and does not leave an empty .chat-notices container', async () => {
      validatePlaybook.mockResolvedValueOnce({
        plausible: false,
        reason: 'Better on schema',
        suggestedPlaybookName: 'oim-schema',
        suggestedPlaybookTitle: 'Schema',
      });
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      ask(container, 'Schema question', 'Getting started');

      await waitFor(() => {
        expect(container.querySelector('.preflight-card')).not.toBeNull();
      });
      expect(container.querySelector('.chat-notices')).not.toBeNull();

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      expect(container.querySelector('.preflight-card')).toBeNull();
      expect(container.querySelector('.chat-notices')).toBeNull();
    });

    it('Test 1.3b (Co-existing Notice Isolation): Switching to an orchestrator profile dismisses the playbook card but keeps the attachment error mounted and visible in .chat-notices', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const textarea = container.querySelector('textarea')!;

      const invalidFile = new File(['bad'], 'document.bmp', { type: 'image/bmp' });
      fireEvent.paste(textarea, {
        clipboardData: {
          items: [{ type: 'image/bmp', getAsFile: () => invalidFile }],
        },
      });

      await waitFor(() => {
        expect(container.querySelector('.chat-notices .banner.error')).not.toBeNull();
      });

      fireEvent.change(textarea, { target: { value: 'Question with attachment error' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      fireEvent.click(sendBtn);

      expect(container.querySelector('.playbook-required')).not.toBeNull();
      expect(container.querySelector('.chat-notices .banner.error')).not.toBeNull();
      expect(container.querySelector('.chat-notices')).not.toBeNull();

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      // Playbook-required card must be dismissed
      expect(container.querySelector('.playbook-required')).toBeNull();
      // Attachment error notice remains mounted and visible in .chat-notices
      expect(container.querySelector('.chat-notices .banner.error')).not.toBeNull();
      expect(container.querySelector('.chat-notices .banner.error')?.textContent).toContain('Unsupported image type');
      expect(container.querySelector('.chat-notices')).not.toBeNull();
    });

    it('Test 1.4 (Multi-Agent Send & Override Retirement): In multi-agent mode with a suppressed draft override, clicking Send calls onSend(text, undefined, toSend) and retires the draft override', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.active-playbook')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });
      expect(container.querySelector('.active-playbook')).toBeNull();

      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Investigate system alert' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      fireEvent.click(sendBtn);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Investigate system alert', undefined);

      fireEvent.change(select, { target: { value: '' } });
      expect(container.querySelector('.active-playbook')).toBeNull();
    });

    it('Test 1.5 (Sticky Continuity): In a thread with single-agent history (lastUserPlaybook), switching back to Single agent after sending a multi-agent message restores lastUserPlaybook', async () => {
      const prevMessages: ChatMessage[] = [
        {
          localId: 'm1',
          role: 'user',
          content: 'Previous single agent question',
          playbook: 'oim-schema',
          createdAt: '2026-08-01T10:00:00.000Z',
        },
        {
          localId: 'm2',
          role: 'assistant',
          content: 'Single agent answer',
          createdAt: '2026-08-01T10:01:00.000Z',
        },
      ];

      const { container } = render(
        <StatefulChatView
          messages={prevMessages}
          profiles={[ORDINARY]}
          thread={{ ...THREAD, orchestratorProfile: 'OIM' }}
        />,
      );

      expect(container.querySelector('.active-playbook')).toBeNull();

      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Multi agent question' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      fireEvent.click(sendBtn);

      expect(onSend).toHaveBeenCalledWith('Multi agent question', undefined);

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: '' } });

      expect(container.querySelector('.active-playbook')?.textContent).toContain('Schema');
    });

    it('Test 1.6a (Guarded Preflight Card): If a preflight check resolves with plausible: false after mode switched to multi-agent, no recommendation card is rendered and no empty .chat-notices strip is mounted', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);

      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      ask(container, 'Check question', 'Getting started');

      await waitFor(() => {
        expect(container.querySelector('.preflight-checking')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      act(() => {
        pending.settle({
          plausible: false,
          reason: 'Off topic',
          suggestedPlaybookName: 'oim-schema',
          suggestedPlaybookTitle: 'Schema',
        });
      });

      await waitFor(() => {
        expect(container.querySelector('.preflight-checking')).toBeNull();
      });

      expect(container.querySelector('.preflight-card')).toBeNull();
      expect(container.querySelector('.chat-notices')).toBeNull();
    });

    it('Test 1.6b (Late Preflight Resolution Race - Plausible): If an in-flight preflight check resolves with plausible: true after user switches mode to multi-agent, the resolution is discarded: onSend is NOT called', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);

      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      ask(container, 'Check question', 'Getting started');

      await waitFor(() => {
        expect(container.querySelector('.preflight-checking')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      act(() => {
        pending.settle({ plausible: true });
      });

      await waitFor(() => {
        expect(container.querySelector('.preflight-checking')).toBeNull();
      });

      expect(onSend).not.toHaveBeenCalled();
    });

    it('Test 1.8 (Backspace Safety): Pressing Backspace on an empty composer in multi-agent mode does not clear the suppressed draft override', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.active-playbook')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });
      expect(container.querySelector('.active-playbook')).toBeNull();

      const textarea = container.querySelector('textarea')!;
      expect(textarea.value).toBe('');
      fireEvent.keyDown(textarea, { key: 'Backspace' });

      fireEvent.change(select, { target: { value: '' } });
      expect(container.querySelector('.active-playbook')?.textContent).toContain('Getting started');
    });

    it('Test 1.8 (Cmd+Enter / Ctrl+Enter send in multi-agent): Triggers clean send with promptName = undefined and retires draft override', async () => {
      const { container } = render(<StatefulChatView profiles={[ORDINARY]} />);
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        expect(container.querySelector('.active-playbook')).not.toBeNull();
      });

      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]')!;
      fireEvent.change(select, { target: { value: 'OIM' } });

      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Keyboard shortcut submission' } });
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Keyboard shortcut submission', undefined);

      fireEvent.change(select, { target: { value: '' } });
      expect(container.querySelector('.active-playbook')).toBeNull();
    });

    it('Test 1.9 (Boundary: Empty Prompts Catalogue Resilience): When prompts: [], typing a question and submitting in multi-agent mode succeeds without refusal or error', async () => {
      const { container } = render(
        <StatefulChatView
          prompts={[]}
          profiles={[ORDINARY]}
          thread={{ ...THREAD, orchestratorProfile: 'OIM' }}
        />,
      );

      const textarea = container.querySelector('textarea')!;
      fireEvent.change(textarea, { target: { value: 'Multi-agent question with empty catalogue' } });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.disabled).toBe(false);
      fireEvent.click(sendBtn);

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('Multi-agent question with empty catalogue', undefined);
      expect(container.querySelector('.playbook-required')).toBeNull();
    });
  });

  describe('mid-turn controls lockout and guard retention', () => {
    it('Test 1.1: Mid-turn controls lockout - when liveTurn.running === true, agent mode select, model select, thinking effort select, and .active-playbook-remove are disabled, while Stop button remains enabled', () => {
      const { container } = renderChat({
        liveTurn: { ...IDLE, running: true },
        profiles: [ORDINARY],
        messages: [{ localId: 'm1', role: 'user', content: 'hello', playbook: 'oim-schema', createdAt: '2026-08-01T10:00:00.000Z' }],
      });

      // Playbook remove button
      const removeBtn = container.querySelector<HTMLButtonElement>('.active-playbook-remove');
      expect(removeBtn).not.toBeNull();
      expect(removeBtn?.disabled).toBe(true);

      // Agent mode select
      const modeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]');
      expect(modeSelect).not.toBeNull();
      expect(modeSelect?.disabled).toBe(true);

      // Model select
      const modelSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
      expect(modelSelect).not.toBeNull();
      expect(modelSelect?.disabled).toBe(true);

      // Thinking effort select
      const thinkingSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Thinking effort"]');
      expect(thinkingSelect).not.toBeNull();
      expect(thinkingSelect?.disabled).toBe(true);

      // Stop button
      const stopBtn = container.querySelector<HTMLButtonElement>('.danger.composer-send');
      expect(stopBtn).not.toBeNull();
      expect(stopBtn?.disabled).toBe(false);
      expect(stopBtn?.textContent).toContain('Stop');
    });

    it('Test 1.2: Checking controls lockout - when checking === true, agent mode select, model select, thinking effort select, and .active-playbook-remove are all disabled', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);

      const { container } = renderChat({
        profiles: [ORDINARY],
      });
      ask(container, 'Checking lockout question', 'Getting started');

      await waitFor(() => {
        expect(container.querySelector('.preflight-checking')).not.toBeNull();
      });

      // Active playbook remove button
      const removeBtn = container.querySelector<HTMLButtonElement>('.active-playbook-remove');
      expect(removeBtn).not.toBeNull();
      expect(removeBtn?.disabled).toBe(true);

      // Agent mode select
      const modeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Agent mode"]');
      expect(modeSelect).not.toBeNull();
      expect(modeSelect?.disabled).toBe(true);

      // Model select
      const modelSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
      expect(modelSelect).not.toBeNull();
      expect(modelSelect?.disabled).toBe(true);

      // Thinking effort select
      const thinkingSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Thinking effort"]');
      expect(thinkingSelect).not.toBeNull();
      expect(thinkingSelect?.disabled).toBe(true);

      pending.settle({ plausible: true });
    });

    it('Test 1.3: Declarative guard retention - (!!preflight && !orchestratorActive) prevents mounting recommendation card or empty .chat-notices container when props change without event', async () => {
      validatePlaybook.mockResolvedValueOnce({
        plausible: false,
        reason: 'Better on schema',
        suggestedPlaybookName: 'oim-schema',
        suggestedPlaybookTitle: 'Schema',
      });

      const { container, rerender } = render(
        <ChatView
          thread={THREAD}
          settings={settings()}
          messages={[]}
          prompts={PROMPTS}
          profiles={[ORDINARY]}
          liveTurn={IDLE}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onPatchThread={() => undefined}
          onFeedback={async () => undefined}
        />,
      );

      ask(container, 'Off-topic question', 'Getting started');
      await waitFor(() => {
        expect(container.querySelector('.preflight-card')).not.toBeNull();
      });
      expect(container.querySelector('.chat-notices')).not.toBeNull();

      rerender(
        <ChatView
          thread={{ ...THREAD, orchestratorProfile: 'OIM' }}
          settings={settings()}
          messages={[]}
          prompts={PROMPTS}
          profiles={[ORDINARY]}
          liveTurn={IDLE}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onPatchThread={() => undefined}
          onFeedback={async () => undefined}
        />,
      );

      expect(container.querySelector('.preflight-card')).toBeNull();
      expect(container.querySelector('.chat-notices')).toBeNull();
    });
  });
});

describe('keyboard shortcut submission and Alt/AltGr suppression', () => {
  it('AltGr + Enter (ctrlKey: true, altKey: true) does NOT call onSend and has defaultPrevented === false', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, altKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Meta + Alt + Enter (metaKey: true, altKey: true) does NOT call onSend and has defaultPrevented === false', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', metaKey: true, altKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Alt + Enter (altKey: true) does NOT call onSend and has defaultPrevented === false', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', altKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Shift + Enter (shiftKey: true) does NOT call onSend and has defaultPrevented === false', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Plain Enter (key: "Enter") does NOT call onSend and has defaultPrevented === false', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('Ctrl + Enter (ctrlKey: true) with valid text calls onSend and has defaultPrevented === true', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent(textarea, event);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Valid question', undefined);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Meta + Enter (metaKey: true) with valid text calls onSend and has defaultPrevented === true', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    fireEvent(textarea, event);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Valid question', undefined);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl + Enter with whitespace-only draft does NOT call onSend', () => {
    const { container } = renderChat({ prompts: [] });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '   \t  \n  ' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
  });

  it('Ctrl + Enter while liveTurn.running === true does NOT call onSend', () => {
    const { container } = renderChat({
      prompts: [],
      liveTurn: { ...IDLE, running: true },
    });
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'Valid question' } });

    const event = createEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    fireEvent(textarea, event);

    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('deterministic platform shortcut labels', () => {
  let originalUserAgent: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  });

  afterEach(() => {
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    } else {
      delete (navigator as unknown as { userAgent?: string }).userAgent;
    }
  });

  function setUserAgent(ua: string) {
    Object.defineProperty(navigator, 'userAgent', {
      value: ua,
      configurable: true,
      writable: true,
    });
  }

  describe('macOS stub', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    });

    it('displays ⌘↵ shortcut in placeholder when orchestratorActive is true', () => {
      const { container } = renderChat({
        thread: { ...THREAD, orchestratorProfile: 'OIM' },
        profiles: [ORDINARY],
      });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe(
        'Ask OIM — specialists + reviewer will answer — ⌘↵ to send',
      );
    });

    it('displays ⌘↵ shortcut in placeholder when activePrompt is selected', async () => {
      const { container } = renderChat();
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        const textarea = container.querySelector('textarea')!;
        expect(textarea.placeholder).toBe(
          'Add your question for “Getting started” — ⌘↵ to send',
        );
      });
    });

    it('displays ⌘↵ shortcut in placeholder in default empty prompts state', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe(
        'Ask a question or paste/drop images — ⌘↵ to send',
      );
    });

    it('.composer-send button title equals Send (⌘↵)', () => {
      const { container } = renderChat({ prompts: [] });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.title).toBe('Send (⌘↵)');
    });
  });

  describe('Windows / Linux stub', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    });

    it('displays Ctrl+↵ shortcut in placeholder when orchestratorActive is true', () => {
      const { container } = renderChat({
        thread: { ...THREAD, orchestratorProfile: 'OIM' },
        profiles: [ORDINARY],
      });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe(
        'Ask OIM — specialists + reviewer will answer — Ctrl+↵ to send',
      );
    });

    it('displays Ctrl+↵ shortcut in placeholder when activePrompt is selected', async () => {
      const { container } = renderChat();
      const row = [...container.querySelectorAll<HTMLButtonElement>('.picker-row')].find((r) =>
        r.textContent?.includes('Getting started'),
      );
      fireEvent.click(row!);
      await waitFor(() => {
        const textarea = container.querySelector('textarea')!;
        expect(textarea.placeholder).toBe(
          'Add your question for “Getting started” — Ctrl+↵ to send',
        );
      });
    });

    it('displays Ctrl+↵ shortcut in placeholder in default empty prompts state', () => {
      const { container } = renderChat({ prompts: [] });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe(
        'Ask a question or paste/drop images — Ctrl+↵ to send',
      );
    });

    it('.composer-send button title equals Send (Ctrl+↵)', () => {
      const { container } = renderChat({ prompts: [] });
      const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
      expect(sendBtn.title).toBe('Send (Ctrl+↵)');
    });
  });

  describe('negative copy checks', () => {
    it('shows Clarifying question placeholder without send shortcut', () => {
      const { container } = renderChat({
        prompts: [],
        liveTurn: {
          ...IDLE,
          clarifyingQuestion: {
            toolUseId: 'cq-1',
            question: 'Which region?',
            options: [{ label: 'US' }, { label: 'EU' }],
          },
        },
      });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe('Awaiting clarification…');
      expect(textarea.placeholder).not.toContain('to send');
    });

    it('shows Preflight checking placeholder without send shortcut', async () => {
      const pending = deferred();
      validatePlaybook.mockReturnValueOnce(pending.promise);
      const { container } = renderChat();
      ask(container, 'Checking question', 'Getting started');
      await waitFor(() => expect(container.querySelector('.preflight-checking')).toBeTruthy());

      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe('Checking the playbook…');
      expect(textarea.placeholder).not.toContain('to send');
    });

    it('shows Unselected playbook placeholder without send shortcut when prompts exist', () => {
      const { container } = renderChat({ prompts: PROMPTS });
      const textarea = container.querySelector('textarea')!;
      expect(textarea.placeholder).toBe('Pick a playbook first — / to choose one');
      expect(textarea.placeholder).not.toContain('to send');
    });

    it('renders AskUserQuestion as an inline clarification card rather than folding into trace', () => {
      const message: ChatMessage = {
        localId: 'm1',
        createdAt: '',
        role: 'assistant',
        content: 'Please answer:',
        blocks: [
          {
            text: 'Please answer:',
            toolCalls: [
              {
                id: 'call-1',
                name: 'AskUserQuestion',
                input: { question: 'Which mode?', options: ['fast', 'thorough'] },
              },
            ],
          },
        ],
      };
      renderChat({ messages: [message] });
      expect(screen.getByText('Which mode?')).toBeTruthy();
      expect(screen.getByText('Clarification required')).toBeTruthy();
    });

    it('catches and logs error when submitClarification rejects in handleClarificationSubmit', async () => {
      const submitClarification = vi.fn().mockRejectedValue(new Error('IPC submit failed'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (window as unknown as { api: unknown }).api = {
        validatePlaybook,
        submitClarification,
      };

      const { container } = renderChat({
        liveTurn: {
          running: true,
          liveText: '',
          liveThinking: '',
          blocks: [
            {
              text: 'Need your choice:',
              toolCalls: [
                {
                  id: 'cq-err-1',
                  name: 'AskUserQuestion',
                  input: { question: 'Pick an option', options: ['Option A'] },
                },
              ],
            },
          ],
          clarifyingQuestion: {
            toolUseId: 'cq-err-1',
            question: 'Pick an option',
            options: [{ label: 'Option A' }],
          },
        },
      });

      const optionBtn = container.querySelector('.option-button') as HTMLButtonElement;
      expect(optionBtn).toBeTruthy();

      fireEvent.click(optionBtn);

      await waitFor(() => {
        expect(submitClarification).toHaveBeenCalledWith('t1', 'cq-err-1', 'Option A');
      });

      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith('Failed to submit clarification:', expect.any(Error));
      });

      errorSpy.mockRestore();
    });
  });
});



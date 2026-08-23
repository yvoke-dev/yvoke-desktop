// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
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

interface ChatOpts {
  thread?: ThreadMeta;
  settings?: AppSettings;
  messages?: ChatMessage[];
  prompts?: McpPromptInfo[];
  profiles?: OrchestratorProfile[];
}

function chat(opts: ChatOpts = {}): React.JSX.Element {
  return (
    <ChatView
      thread={opts.thread ?? THREAD}
      settings={opts.settings ?? settings()}
      messages={opts.messages ?? []}
      prompts={opts.prompts ?? PROMPTS}
      profiles={opts.profiles ?? []}
      liveTurn={IDLE}
      onSend={onSend}
      onInterrupt={() => undefined}
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
  (window as unknown as { api: unknown }).api = { validatePlaybook };
});

afterEach(() => cleanup());

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
});

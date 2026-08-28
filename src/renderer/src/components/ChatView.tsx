import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  ChatMessage,
  CitationRef,
  ImageAttachment,
  ImageMediaType,
  McpPromptInfo,
  MessageBlock,
  OrchestratorProfile,
  PlaybookValidation,
  ReviewStatus,
  ThinkingLevel,
  ThreadMeta,
  ToolCallInfo,
  UsageTotals,
} from '../../../shared/types';
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  DEFAULT_APPEARANCE,
  isUserSelectableProfile,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
} from '../../../shared/types';
import type { LiveTurn } from '../App';
import { CitationModal, type CitationState } from './CitationModal';
import { CopyButton } from './CopyButton';
import { FeedbackControls } from './FeedbackControls';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';
import { TraceBar, type TraceEntry } from './TraceBar';
import { AlertIcon, CloseIcon, DownloadIcon, PaperclipIcon, PlaybookIcon, SearchIcon, SendIcon, StopIcon } from './icons';
import { shortName } from './toolNames';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

const IMAGE_SIZE_LIMIT_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

/**
 * Two kinds of tool call are NOT evidence and must not be folded into the trace:
 * a clarifying question is a control the user has to answer, and a delegation is the substance
 * of an orchestrated turn. Everything else is the run's working-out.
 */
function isInlineCall(call: ToolCallInfo): boolean {
  // A delegation is identified by the runtime having attributed a sub-agent to it — translate.ts
  // sets `subagentType` only in orchestrator mode — rather than by the thread's mode as it stands
  // now. A conversation can be moved off its profile mid-thread, and stored orchestrated turns
  // have to keep their cards when it is.
  return (
    (call.name === 'Agent' && call.subagentType !== undefined) ||
    shortName(call.name) === 'ask_clarifying_question'
  );
}

/** Normalise a message into blocks, so the old flat shape and the new one read the same. */
function blocksOf(message: ChatMessage): MessageBlock[] {
  if (message.blocks && message.blocks.length > 0) return message.blocks;
  return [{ text: message.content, thinking: message.thinking, toolCalls: message.toolCalls }];
}

/**
 * The open playbook recommendation, if the preflight check raised one. `forPlaybook` is what
 * makes the card an answerable question rather than a loop: sending again with that same
 * playbook still selected means "send anyway", while picking a different one re-runs the check.
 */
interface PreflightCard {
  reason?: string;
  suggestedName?: string;
  suggestedTitle?: string;
  forPlaybook: string;
}

interface AssembledTurn {
  text: string;
  entries: TraceEntry[];
  inlineCalls: ToolCallInfo[];
}

/**
 * Split one assistant turn into the three things the layout needs: the prose (which goes first,
 * always), the trace entries (reasoning + tools, collapsed), and the calls that stay inline.
 */
function assemble(blocks: MessageBlock[]): AssembledTurn {
  const texts: string[] = [];
  const entries: TraceEntry[] = [];
  const inlineCalls: ToolCallInfo[] = [];
  for (const block of blocks) {
    if (block.thinking) entries.push({ kind: 'thinking', text: block.thinking });
    for (const call of block.toolCalls ?? []) {
      if (isInlineCall(call)) inlineCalls.push(call);
      else entries.push({ kind: 'tool', call });
    }
    if (block.text) texts.push(block.text);
  }
  return { text: texts.join('\n\n'), entries, inlineCalls };
}

/**
 * Orchestrated answers say whether they were reviewed. An approved answer needs no banner (that is
 * the expected path); anything else is worth the user's attention, so only those render.
 */
function ReviewBadge({ review }: { review?: ReviewStatus }): React.JSX.Element | null {
  if (!review || review.outcome === 'approved') return null;
  const text =
    review.outcome === 'skipped'
      ? 'Delivered without review — the orchestrator did not consult the reviewer.'
      : review.outcome === 'unclear'
        ? 'The reviewer ran but returned no clear verdict.'
        : 'The reviewer rejected this answer.';
  return (
    <div className={`review-badge review-${review.outcome}`}>
      <span className="review-badge-head">
        <AlertIcon size={14} />
        {text}
      </span>
      {review.feedback && <span className="review-feedback">{review.feedback}</span>}
    </div>
  );
}

/** Per-message usage, shown here only when the turn had no trace bar to carry it. */
function UsageLine({ usage }: { usage: UsageTotals }): React.JSX.Element {
  return (
    <span className="usage" data-tip="Tokens for this response">
      {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
      {usage.cacheReadTokens > 0 && ` · ${formatTokens(usage.cacheReadTokens)} cache read`}
      {usage.cacheWriteTokens > 0 && ` · ${formatTokens(usage.cacheWriteTokens)} cache write`}
    </span>
  );
}

export function ChatView(props: {
  thread: ThreadMeta;
  settings: AppSettings;
  messages: ChatMessage[];
  prompts: McpPromptInfo[];
  profiles: OrchestratorProfile[];
  liveTurn: LiveTurn;
  onSend: (text: string, promptName?: string, images?: ImageAttachment[]) => void;
  onInterrupt: () => void;
  onPatchThread: (update: Partial<ThreadMeta>) => void;
  onFeedback: (messageLocalId: string, rating: 1 | -1, comment?: string) => Promise<void>;
}): React.JSX.Element {
  const {
    thread,
    settings,
    messages,
    prompts,
    profiles,
    liveTurn,
    onSend,
    onInterrupt,
    onPatchThread,
    onFeedback,
  } = props;
  // Orchestrator mode replaces the single-playbook + model/thinking controls with a profile.
  const orchestratorActive = !!thread.orchestratorProfile;
  // Prototype profiles are hidden under the same setting as prototype playbooks. `profiles` stays
  // unfiltered upstream — App derives the control-playbook names from it, and hiding a profile
  // there would let a hidden profile's orchestrator/reviewer playbooks back into the picker.
  const visibleProfiles = useMemo(
    () =>
      profiles.filter((p) =>
        isUserSelectableProfile(
          p,
          Boolean(settings.showPrototypePlaybooks),
          thread.orchestratorProfile,
        ),
      ),
    [profiles, settings.showPrototypePlaybooks, thread.orchestratorProfile],
  );
  const traceExpanded = settings.appearance?.traceExpanded ?? DEFAULT_APPEARANCE.traceExpanded;
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  // The active playbook follows the conversation's history unless the user has said otherwise for
  // THIS thread (see `activePrompt` below). Keying the override to the thread is what retires it on
  // a switch, so no render can show a previous conversation's pick.
  const [promptOverride, setPromptOverride] = useState<{
    threadId: string;
    prompt: McpPromptInfo | null;
  } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [pickerFilter, setPickerFilter] = useState('');
  const [citation, setCitation] = useState<CitationState | null>(null);
  // Playbook preflight: `checking` while the verdict is outstanding, `preflight` once it objects.
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<PreflightCard | null>(null);
  // Raised when a single-agent question is sent with no playbook attached, which this app refuses.
  const [playbookRequired, setPlaybookRequired] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  /**
   * Which preflight run owns the composer. A bare `checking` boolean is not enough: the check is
   * an unawaited promise that nothing can recall, so a run the user has moved on from would
   * otherwise still land — clearing the lock while a newer run is live, or sending a draft that
   * has since been superseded. Every run takes a ticket here and only acts if it still holds it.
   */
  const runIdRef = useRef(0);

  // When switching conversations, retire the transient cards and composer attachments.
  useEffect(() => {
    runIdRef.current += 1;
    setPreflight(null);
    setChecking(false);
    setPlaybookRequired(false);
    setAttachments([]);
    setAttachmentError(null);
    setLightboxImage(null);
    setIsDraggingOver(false);
    dragCounterRef.current = 0;
  }, [thread.id]);

  // Close image lightbox on Escape key.
  useEffect(() => {
    if (!lightboxImage) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setLightboxImage(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxImage]);

  /**
   * The playbook this message will be sent under. A playbook is sticky for the conversation, so the
   * default is whichever one its last question carried — which is also what restores it after a
   * restart, with nothing to persist. An override (a pick, a send under a different playbook, or an
   * explicit clear, which is `prompt: null`) wins for the thread it was made on.
   *
   * Derived rather than mirrored into state on purpose: an effect that copies this into a `useState`
   * has to name every input in a dependency array and race the thread-switch reset for the same
   * variable, and both of those went wrong.
   */
  /**
   * The playbook the conversation's most recent question carried, if any. Derived once: it decides
   * both what the composer shows and whether the next send is preflighted, and those two must never
   * disagree about which playbook the conversation is already under.
   */
  const lastUserPlaybook = useMemo(
    () => messages.findLast((m) => m.role === 'user' && m.playbook)?.playbook,
    [messages],
  );

  const activePrompt = useMemo<McpPromptInfo | null>(() => {
    if (promptOverride?.threadId === thread.id) return promptOverride.prompt;
    if (orchestratorActive) return null;
    return prompts.find((p) => p.name === lastUserPlaybook) ?? null;
  }, [promptOverride, thread.id, orchestratorActive, lastUserPlaybook, prompts]);

  const handleClarificationSubmit = async (answer: string): Promise<void> => {
    if (!liveTurn.clarifyingQuestion) return;
    const threadId = thread.id;
    const toolUseId = liveTurn.clarifyingQuestion.toolUseId;
    await window.api.submitClarification(threadId, toolUseId, answer);
  };

  const openCitation = useCallback((ref: CitationRef): void => {
    // `id` is a bare `[<uuid>]` marker and `chunkId` the older `[chunk_id=…]` form; both name one
    // passage, so either lets the panel single it out of the section it comes back in. A document
    // or file citation names no passage and leaves this unset.
    const citedId = ref.id ?? ref.chunkId;
    setCitation({ loading: true, citedId });
    void window.api
      .getCitation(ref)
      .then((text) => setCitation({ loading: false, text, citedId }))
      .catch((e) =>
        setCitation({ loading: false, citedId, error: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  // Autocomplete is open while the draft is a single "/token" (no space yet).
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1];
  const suggestions = useMemo(() => {
    if (orchestratorActive || slashQuery == null || prompts.length === 0) return [];
    const q = slashQuery.toLowerCase();
    return prompts.filter((p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q));
  }, [orchestratorActive, slashQuery, prompts]);
  const showAutocomplete = suggestions.length > 0;

  useEffect(() => setHighlight(0), [slashQuery]);

  // Arrow keys move `highlight`, but the list caps at 280px and the server serves ~30 playbooks,
  // so past the eighth one the selection was moving somewhere the user could not see — which
  // reads as "the arrows do nothing". `block: 'nearest'` scrolls only when it has left the box.
  useEffect(() => {
    autocompleteRef.current
      ?.querySelector('.prompt-option.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight, showAutocomplete]);

  // Auto-scroll to the bottom on new content, but only if the user is already near the bottom —
  // don't yank the view if they've scrolled up to read. Scheduled via rAF to coalesce the frequent
  // streaming deltas into at most one scroll per frame.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 120) return;
    const raf = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, liveTurn]);

  // Auto-grow the composer with its content, from 3 rows up to a max of 9 (3×).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const minHeight = lineHeight * 3 + padding;
    const maxHeight = lineHeight * 9 + padding;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
  }, [draft]);

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      setAttachmentError(null);
      const fileList = Array.from(files);
      if (fileList.length === 0) return;

      const currentCount = attachments.length;
      if (currentCount >= MAX_IMAGE_COUNT) {
        setAttachmentError(`Maximum ${MAX_IMAGE_COUNT} image attachments allowed per message.`);
        return;
      }

      const availableSlots = MAX_IMAGE_COUNT - currentCount;
      if (fileList.length > availableSlots) {
        setAttachmentError(`Can only add ${availableSlots} more image${availableSlots > 1 ? 's' : ''} (max ${MAX_IMAGE_COUNT}).`);
      }

      const filesToProcess = fileList.slice(0, availableSlots);
      const newAttachments: ImageAttachment[] = [];

      for (const file of filesToProcess) {
        if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(file.type as ImageMediaType)) {
          setAttachmentError(`Unsupported image type "${file.name}". Please use PNG, JPEG, GIF, or WebP.`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachmentError(`Image "${file.name}" exceeds the ${IMAGE_SIZE_LIMIT_MB}MB size limit.`);
          continue;
        }

        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          const commaIdx = dataUrl.indexOf(',');
          const base64Data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

          newAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            mediaType: file.type as ImageMediaType,
            data: base64Data,
            name: file.name,
            size: file.size,
          });
        } catch {
          setAttachmentError(`Failed to read image "${file.name}".`);
        }
      }

      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, MAX_IMAGE_COUNT));
      }
    },
    [attachments.length],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void processFiles(imageFiles);
      }
    },
    [processFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void processFiles(e.dataTransfer.files);
      }
    },
    [processFiles],
  );

  const pickPrompt = (prompt: McpPromptInfo): void => {
    setPromptOverride({ threadId: thread.id, prompt });
    // Only the "/token" the autocomplete is completing gets consumed. The picker grid and the
    // refusal card are both reachable with a real question already typed, and that question is
    // the whole point of the turn — clearing it made the user retype it.
    setDraft((d) => (/^\/\S*$/.test(d) ? '' : d));
    setPlaybookRequired(false);
    textareaRef.current?.focus();
  };

  /** Whether the message about to be sent gets its playbook checked first. */
  const validationEnabled = settings.playbookValidationEnabled !== false;

  const send = (text: string, promptName?: string, imagesToSend?: ImageAttachment[]): void => {
    setPreflight(null);
    setPlaybookRequired(false);
    setAttachmentError(null);
    const toSend = imagesToSend ?? (attachments.length > 0 ? attachments : undefined);
    // The recommendation card's "Switch to …" sends under a playbook that is not the active one;
    // make it the active one so the composer agrees with what was just asked.
    if (promptName && promptName !== activePrompt?.name) {
      const matching = prompts.find((p) => p.name === promptName);
      if (matching) setPromptOverride({ threadId: thread.id, prompt: matching });
    }
    if (toSend && toSend.length > 0) {
      onSend(text, promptName, toSend);
    } else {
      onSend(text, promptName);
    }
    setDraft('');
    setAttachments([]);
  };

  /**
   * Preflight playbook check: runs on the conversation's first message or when switching to a
   * different playbook. Fails open at every step so a check that cannot run never blocks a question.
   */
  const runPreflight = async (text: string, prompt: McpPromptInfo, imagesToSend?: ImageAttachment[]): Promise<void> => {
    const runId = ++runIdRef.current;
    setChecking(true);
    setPreflight(null);
    let verdict: PlaybookValidation;
    try {
      verdict = await window.api.validatePlaybook({ threadId: thread.id, text, promptName: prompt.name });
    } catch {
      verdict = { plausible: true };
    }
    // Superseded — by a thread switch or by a later run.
    if (runIdRef.current !== runId) return;
    setChecking(false);
    if (verdict.plausible) {
      send(text, prompt.name, imagesToSend);
      return;
    }
    setPreflight({
      reason: verdict.reason,
      suggestedName: verdict.suggestedPlaybookName,
      suggestedTitle: verdict.suggestedPlaybookTitle,
      forPlaybook: prompt.name,
    });
  };

  const submit = (): void => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || liveTurn.running || checking) return;
    const prompt = activePrompt;
    // A single-agent answer runs under a playbook, so a question sent without one is refused
    // rather than quietly answered with the bare default tool set. Multi-agent conversations take
    // their playbooks from the profile, and an empty catalogue — an unreachable server — leaves
    // nothing to pick, so neither is gated: an error the user cannot act on is just a dead end.
    if (!orchestratorActive && !prompt && prompts.length > 0) {
      setPlaybookRequired(true);
      return;
    }
    // An open card is a question the user has already been shown: sending again with the same
    // playbook is their "send anyway". Changing the playbook first is a new question, so it
    // gets checked again.
    const alreadyAnswered = !!preflight && preflight.forPlaybook === prompt?.name;

    // Run preflight only on the conversation's first message or when the user switched playbooks.
    const isFirstMessage = messages.length === 0;
    const isPlaybookChanged = !isFirstMessage && prompt?.name !== lastUserPlaybook;
    const needsPreflight = isFirstMessage || isPlaybookChanged;

    if (prompt && !orchestratorActive && validationEnabled && needsPreflight && !alreadyAnswered) {
      void runPreflight(text, prompt, attachments.length > 0 ? attachments : undefined);
      return;
    }
    send(text, prompt?.name, attachments.length > 0 ? attachments : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (showAutocomplete) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickPrompt(suggestions[highlight]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft('');
        return;
      }
    }
    // Backspace on an empty draft clears the active playbook.
    if (e.key === 'Backspace' && draft === '' && activePrompt) {
      e.preventDefault();
      setPromptOverride({ threadId: thread.id, prompt: null });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  /**
   * Whether anything is standing above the conversation. The strip takes vertical space from the
   * transcript, so it exists only while it has something in it.
   */
  const hasNotice =
    checking ||
    !!preflight ||
    (playbookRequired && !orchestratorActive) ||
    !!attachmentError ||
    !!liveTurn.error ||
    !!liveTurn.notice;

  // The picker owns the empty thread until a question is actually on its way. Once a check is
  // running (or its recommendation is standing), that grid is thirty rows of noise between the
  // user and the one thing they now have to read, so it stands down.
  const showPicker =
    messages.length === 0 &&
    !liveTurn.running &&
    !orchestratorActive &&
    !checking &&
    !preflight &&
    prompts.length > 0;
  const filteredPrompts = useMemo(() => {
    const q = pickerFilter.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [prompts, pickerFilter]);

  const liveTurnParts = useMemo(() => {
    const assembled = assemble(liveTurn.blocks);
    if (liveTurn.liveThinking) {
      assembled.entries.push({ kind: 'thinking', text: liveTurn.liveThinking });
    }
    // `liveText` is the block still streaming; `assembled.text` is every block already closed.
    // Both have to render, or a turn that emitted prose, called a tool, then resumed would drop
    // its first paragraph the moment the second one started arriving.
    const text = [assembled.text, liveTurn.liveText].filter(Boolean).join('\n\n');
    return { ...assembled, text };
  }, [liveTurn.blocks, liveTurn.liveThinking, liveTurn.liveText]);

  return (
    <div
      className="chat-view"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDraggingOver && (
        <div className="chat-drop-overlay">
          <div className="drop-overlay-content">
            <PaperclipIcon size={32} />
            <span>Drop images here to attach</span>
          </div>
        </div>
      )}
      <header className="chat-header">
        <div className="chat-title" data-tip={thread.title}>
          {thread.title}
        </div>
        <div className="chat-controls">
          <span
            className="usage-total"
            data-tip="Total tokens this conversation (input / output / cache-read / cache-write)"
          >
            Σ {formatTokens(thread.totals.inputTokens)} in · {formatTokens(thread.totals.outputTokens)} out
            {thread.totals.cacheReadTokens > 0 && ` · ${formatTokens(thread.totals.cacheReadTokens)} cache read`}
            {thread.totals.cacheWriteTokens > 0 && ` · ${formatTokens(thread.totals.cacheWriteTokens)} cache write`}
          </span>
        </div>
      </header>

      {/* Warnings, errors and the playbook cards sit between the header and the conversation,
          outside the scroller. They are about the message being sent rather than part of the
          transcript, and at the foot of a long thread — or under the playbook picker, which is a
          screenful on its own — they were below the fold: the user saw nothing happen. Here they
          cannot be scrolled past. */}
      {hasNotice && (
        <div className="chat-notices">
          {checking && (
            <div className="thinking-indicator preflight-checking">
              <span className="dot" />
              Checking whether “{activePrompt?.title ?? preflight?.forPlaybook}” fits this question…
            </div>
          )}
          {attachmentError && (
            <div className="banner error">
              <span className="banner-icon">
                <AlertIcon size={14} />
              </span>
              {attachmentError}
              <button
                type="button"
                className="banner-dismiss"
                onClick={() => setAttachmentError(null)}
                title="Dismiss"
              >
                <CloseIcon size={12} />
              </button>
            </div>
          )}
          {preflight && (
            <div className="preflight-card">
              <div className="preflight-card-head">
                <AlertIcon size={14} />
                Playbook recommendation
              </div>
              {preflight.reason && <div className="preflight-card-reason">{preflight.reason}</div>}
              <div className="preflight-card-actions">
                {preflight.suggestedName && (
                  <button
                    className="primary"
                    disabled={draft.trim().length === 0 && attachments.length === 0}
                    onClick={() => send(draft.trim(), preflight.suggestedName)}
                  >
                    Switch to {preflight.suggestedTitle ?? preflight.suggestedName}
                  </button>
                )}
                {/* Sends exactly what the composer shows — normally the playbook the card is
                    about, but the user is free to have changed it while the card stood. */}
                <button
                  disabled={draft.trim().length === 0 && attachments.length === 0}
                  onClick={() => send(draft.trim(), activePrompt?.name)}
                >
                  Send anyway
                </button>
              </div>
            </div>
          )}
          {playbookRequired && !orchestratorActive && (
            <div className="preflight-card playbook-required">
              <div className="preflight-card-head">
                <AlertIcon size={14} />
                Playbook required
              </div>
              <div className="preflight-card-reason">
                Pick a playbook before asking a question — press “/” in the composer to choose one.
              </div>
            </div>
          )}
          {liveTurn.error && (
            <div className="banner error">
              <span className="banner-icon">
                <AlertIcon size={14} />
              </span>
              {liveTurn.error}
            </div>
          )}
          {liveTurn.notice && <div className="banner notice">{liveTurn.notice}</div>}
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {showPicker && (
          <div>
            <div className="picker">
              <div className="picker-head">
                <div>
                  <h2>Pick a playbook</h2>
                  <p>
                    Each one scopes the agent to a slice of the knowledge base. {prompts.length}{' '}
                    available.
                  </p>
                </div>
              </div>
            </div>
            <div className="picker-filter">
              <label className="search-field">
                <SearchIcon size={14} />
                <input
                  type="text"
                  value={pickerFilter}
                  placeholder="Filter playbooks"
                  aria-label="Filter playbooks"
                  onChange={(e) => setPickerFilter(e.target.value)}
                />
              </label>
              <span className="picker-hint">
                or type <span className="mono">/</span> in the composer
              </span>
            </div>
            <div className="picker-list">
              {filteredPrompts.map((prompt) => (
                <button
                  key={prompt.name}
                  type="button"
                  className="picker-row"
                  data-tip={prompt.description}
                  onClick={() => pickPrompt(prompt)}
                >
                  <span className="picker-row-main">
                    <span className="picker-row-title">{prompt.title}</span>
                    {prompt.description && (
                      <span className="picker-row-desc">{prompt.description}</span>
                    )}
                  </span>
                  <span className="picker-row-use">Use</span>
                </button>
              ))}
              {filteredPrompts.length === 0 && (
                <div className="picker-empty">No playbook matches “{pickerFilter.trim()}”.</div>
              )}
            </div>
          </div>
        )}

        {messages.map((message) => {
          if (message.role === 'user') {
            return (
              <div key={message.localId} className="message user">
                <div className="user-kicker">
                  You
                  {message.playbook && (
                    <>
                      <span aria-hidden="true">·</span>
                      <PlaybookIcon size={11} />
                      {message.playbook}
                    </>
                  )}
                </div>
                {message.images && message.images.length > 0 && (
                  <div className="user-images-grid">
                    {message.images.map((img) => (
                      <button
                        key={img.id}
                        type="button"
                        className="user-image-card"
                        onClick={() => setLightboxImage(img)}
                        data-tip="View full image"
                        aria-label={`View ${img.name || 'attached image'} full size`}
                      >
                        <img
                          src={`data:${img.mediaType};base64,${img.data}`}
                          alt={img.name || 'Attached image'}
                        />
                        {img.name && <span className="user-image-name">{img.name}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {message.content && <div className="user-text">{message.content}</div>}
                <div className="message-footer">
                  <span />
                  <span className="message-actions">
                    {message.content && <CopyButton text={message.content} tip="Copy question" />}
                  </span>
                </div>
              </div>
            );
          }
          const { text, entries, inlineCalls } = assemble(blocksOf(message));
          return (
            <div key={message.localId} className="message assistant">
              {text && (
                <>
                  <div className="answer-kicker">Answer</div>
                  <div className="answer-body">
                    <Markdown content={text} onCitation={openCitation} />
                  </div>
                </>
              )}
              {inlineCalls.map((call) => (
                <ToolCallCard
                  key={call.id}
                  call={call}
                  onClarificationSubmit={handleClarificationSubmit}
                  activeClarificationId={liveTurn.clarifyingQuestion?.toolUseId}
                  onCitation={openCitation}
                />
              ))}
              <TraceBar entries={entries} usage={message.usage} defaultOpen={traceExpanded} />
              <ReviewBadge review={message.review} />
              <div className="message-footer">
                {/* The trace bar carries the token counts when there is one; without it they
                    would have nowhere to go, so the footer picks them up. */}
                {message.usage && entries.length === 0 ? <UsageLine usage={message.usage} /> : <span />}
                <span className="message-actions">
                  {text && <CopyButton text={text} />}
                  <FeedbackControls message={message} onFeedback={onFeedback} />
                </span>
              </div>
            </div>
          );
        })}

        {liveTurn.running && (
          <div className="message assistant live">
            {liveTurnParts.text && (
              <>
                <div className="answer-kicker">Answer</div>
                <div className="answer-body">
                  <Markdown content={liveTurnParts.text} onCitation={openCitation} live />
                </div>
              </>
            )}
            {liveTurnParts.inlineCalls.map((call) => (
              <ToolCallCard
                key={call.id}
                call={call}
                onClarificationSubmit={handleClarificationSubmit}
                activeClarificationId={liveTurn.clarifyingQuestion?.toolUseId}
                onCitation={openCitation}
              />
            ))}
            {/* Open while the turn runs so the work stays visible; the finished message then
                renders it collapsed (or per the Appearance setting). */}
            <TraceBar entries={liveTurnParts.entries} defaultOpen />
            {!liveTurnParts.text && liveTurnParts.entries.length === 0 && (
              <div className="thinking-indicator">
                <span className="dot" />
                Working…
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="composer">
        {showAutocomplete && (
          <div className="prompt-autocomplete" ref={autocompleteRef}>
            {suggestions.map((prompt, i) => (
              <button
                key={prompt.name}
                className={`prompt-option ${i === highlight ? 'active' : ''}`}
                // The descriptions run to a paragraph; the row shows one ellipsed line and the
                // whole thing lives on the tooltip.
                data-tip={prompt.description}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pickPrompt(prompt)}
              >
                <span className="prompt-option-title">{prompt.title}</span>
                <span className="prompt-option-desc">{prompt.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((att) => (
                <div key={att.id} className="attachment-pill" title={att.name || 'Attachment'}>
                  <button
                    type="button"
                    className="attachment-pill-thumb"
                    onClick={() => setLightboxImage(att)}
                    aria-label={`Preview ${att.name || 'attachment'}`}
                  >
                    <img src={`data:${att.mediaType};base64,${att.data}`} alt="" />
                  </button>
                  <span className="attachment-pill-name">{att.name || 'Image'}</span>
                  {att.size !== undefined && (
                    <span className="attachment-pill-size">{formatBytes(att.size)}</span>
                  )}
                  <button
                    type="button"
                    className="attachment-pill-remove"
                    data-tip="Remove attachment"
                    aria-label="Remove attachment"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                  >
                    <CloseIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-input">
            <textarea
              ref={textareaRef}
              value={draft}
              disabled={liveTurn.running || checking || !!liveTurn.clarifyingQuestion}
              placeholder={
                liveTurn.clarifyingQuestion
                  ? 'Awaiting clarification…'
                  : checking
                    ? 'Checking the playbook…'
                    : orchestratorActive
                      ? `Ask ${thread.orchestratorProfile} — specialists + reviewer will answer.`
                      : activePrompt
                        ? `Add your question for “${activePrompt.title}” — ↵ to send`
                        : prompts.length > 0
                          ? 'Pick a playbook first — / to choose one'
                          : 'Ask a question or paste/drop images — ↵ to send'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={handlePaste}
              rows={3}
            />
          </div>
          <div className="composer-controls">
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED_IMAGE_MEDIA_TYPES.join(',')}
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void processFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <button
              type="button"
              className="composer-attach-btn"
              data-tip="Attach images"
              aria-label="Attach images"
              disabled={liveTurn.running || checking || attachments.length >= MAX_IMAGE_COUNT}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon size={14} />
            </button>
            {activePrompt && (
              <span className="active-playbook" data-tip={activePrompt.description}>
                <PlaybookIcon size={11} />
                {activePrompt.title}
                <button
                  className="active-playbook-remove"
                  data-tip="Remove playbook"
                  disabled={checking}
                  onClick={() => {
                    setPromptOverride({ threadId: thread.id, prompt: null });
                  }}
                >
                  <CloseIcon size={11} />
                </button>
              </span>
            )}
            {visibleProfiles.length > 0 && (
              <select
                className="composer-select"
                value={thread.orchestratorProfile ?? ''}
                data-tip="Multi-agent profile (orchestrator mode)"
                aria-label="Agent mode"
                // Switching to orchestrator mode mid-check would leave the verdict deciding the
                // playbook for a turn that no longer takes one.
                disabled={checking}
                onChange={(e) => onPatchThread({ orchestratorProfile: e.target.value })}
              >
                <option value="">Single agent</option>
                {visibleProfiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.prototype ? `🧪 ${p.name}` : p.name}
                  </option>
                ))}
              </select>
            )}
            {!orchestratorActive ? (
              <>
                <select
                  className="composer-select"
                  value={thread.model}
                  data-tip="Model"
                  aria-label="Model"
                  onChange={(e) => onPatchThread({ model: e.target.value })}
                >
                  {settings.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  className="composer-select"
                  value={thread.thinkingLevel}
                  data-tip="Thinking effort"
                  aria-label="Thinking effort"
                  onChange={(e) => onPatchThread({ thinkingLevel: e.target.value as ThinkingLevel })}
                >
                  {THINKING_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      thinking · {l}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="orchestrator-hint" data-tip="Models are set per role in Settings → Agents">
                specialists + reviewer
              </span>
            )}
            {liveTurn.running ? (
              <button className="danger composer-send" onClick={onInterrupt}>
                <StopIcon size={10} />
                Stop
              </button>
            ) : (
              <button
                className="primary composer-send"
                disabled={(draft.trim().length === 0 && attachments.length === 0) || checking || !!liveTurn.clarifyingQuestion}
                onClick={submit}
              >
                Send
                <SendIcon size={12} />
              </button>
            )}
          </div>
        </div>
      </footer>

      {lightboxImage && (
        <div className="image-lightbox-overlay" onClick={() => setLightboxImage(null)}>
          <div className="image-lightbox-modal" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-header">
              <div className="lightbox-title">
                <span className="lightbox-name">{lightboxImage.name || 'Image'}</span>
                {lightboxImage.size !== undefined && (
                  <span className="lightbox-meta">({formatBytes(lightboxImage.size)})</span>
                )}
              </div>
              <div className="lightbox-actions">
                <a
                  className="lightbox-action-btn"
                  href={`data:${lightboxImage.mediaType};base64,${lightboxImage.data}`}
                  download={lightboxImage.name || 'image.png'}
                  title="Download image"
                >
                  <DownloadIcon size={14} />
                  Download
                </a>
                <button
                  type="button"
                  className="lightbox-close-btn"
                  onClick={() => setLightboxImage(null)}
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            <div className="lightbox-body">
              <img
                className="lightbox-image"
                src={`data:${lightboxImage.mediaType};base64,${lightboxImage.data}`}
                alt={lightboxImage.name || 'Full image view'}
              />
            </div>
          </div>
        </div>
      )}

      {citation && <CitationModal state={citation} onClose={() => setCitation(null)} />}
    </div>
  );
}

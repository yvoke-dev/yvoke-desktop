import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ChatMessage, CitationRef, McpPromptInfo, OrchestratorProfile, ReviewStatus, ThinkingLevel, ThreadMeta } from '../../../shared/types';
import type { LiveTurn } from '../App';
import { CitationModal, type CitationState } from './CitationModal';
import { FeedbackControls } from './FeedbackControls';
import { Markdown } from './Markdown';
import { ToolCallCard } from './ToolCallCard';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ThinkingBlock({ thinking }: { thinking: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-block">
      <button type="button" className="thinking-toggle-btn" onClick={() => setOpen(!open)}>
        🧠 {open ? 'Hide' : 'View'} Thinking Process
      </button>
      {open && <pre className="thinking-text">{thinking}</pre>}
    </div>
  );
}

/**
 * Orchestrated answers say whether they were reviewed. An approved answer needs no banner (that is
 * the expected path); anything else is worth the user's attention, so only those render.
 */
function ReviewBadge({ review }: { review?: ReviewStatus }): React.JSX.Element | null {
  if (!review || review.outcome === 'approved') return null;
  const text =
    review.outcome === 'skipped'
      ? '⚠️ Delivered without review — the orchestrator did not consult the reviewer.'
      : review.outcome === 'unclear'
        ? '⚠️ The reviewer ran but returned no clear verdict.'
        : '⛔ The reviewer rejected this answer.';
  return (
    <div className={`review-badge review-${review.outcome}`}>
      <span>{text}</span>
      {review.feedback && <span className="review-feedback">{review.feedback}</span>}
    </div>
  );
}

export function ChatView(props: {
  thread: ThreadMeta;
  settings: AppSettings;
  messages: ChatMessage[];
  prompts: McpPromptInfo[];
  profiles: OrchestratorProfile[];
  liveTurn: LiveTurn;
  onSend: (text: string, promptName?: string) => void;
  onInterrupt: () => void;
  onPatchThread: (update: Partial<ThreadMeta>) => void;
  onFeedback: (messageLocalId: string, rating: 1 | -1, comment?: string) => Promise<void>;
}): React.JSX.Element {
  const { thread, settings, messages, prompts, profiles, liveTurn, onSend, onInterrupt, onPatchThread, onFeedback } = props;
  // Orchestrator mode replaces the single-playbook + model/thinking controls with a profile.
  const orchestratorActive = !!thread.orchestratorProfile;
  const [draft, setDraft] = useState('');
  const [activePrompt, setActivePrompt] = useState<McpPromptInfo | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [citation, setCitation] = useState<CitationState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleClarificationSubmit = async (answer: string): Promise<void> => {
    if (!liveTurn.clarifyingQuestion) return;
    const threadId = thread.id;
    const toolUseId = liveTurn.clarifyingQuestion.toolUseId;
    await window.api.submitClarification(threadId, toolUseId, answer);
  };

  const openCitation = useCallback((ref: CitationRef): void => {
    setCitation({ loading: true });
    void window.api
      .getCitation(ref)
      .then((text) => setCitation({ loading: false, text }))
      .catch((e) => setCitation({ loading: false, error: e instanceof Error ? e.message : String(e) }));
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

  const pickPrompt = (prompt: McpPromptInfo): void => {
    setActivePrompt(prompt);
    setDraft('');
    textareaRef.current?.focus();
  };

  const submit = (): void => {
    const text = draft.trim();
    if (!text || liveTurn.running) return;
    onSend(text, activePrompt?.name);
    setDraft('');
    setActivePrompt(null);
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
      setActivePrompt(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat-view">
      <header className="chat-header">
        <div className="chat-title" title={thread.title}>
          {thread.title}
        </div>
        <div className="chat-controls">
          <span
            className="usage-total"
            title="Total tokens this conversation (input / output / cache-read / cache-write)"
          >
            Σ {formatTokens(thread.totals.inputTokens)} in · {formatTokens(thread.totals.outputTokens)} out
            {thread.totals.cacheReadTokens > 0 && ` · ${formatTokens(thread.totals.cacheReadTokens)} cached`}
          </span>
        </div>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && !liveTurn.running && !orchestratorActive && prompts.length > 0 && (
          <div className="prompt-chips">
            <div className="chips-label">Playbooks from the knowledge base (or type “/”):</div>
            {prompts.map((prompt) => (
              <button key={prompt.name} className="chip" title={prompt.description} onClick={() => pickPrompt(prompt)}>
                {prompt.title}
              </button>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <div key={message.localId} className={`message ${message.role}`}>
            {message.role === 'assistant' ? (
              <>
                {message.blocks && message.blocks.length > 0 ? (
                  message.blocks.map((block, i) => (
                    <React.Fragment key={i}>
                      {block.thinking && <ThinkingBlock thinking={block.thinking} />}
                      {block.text && <Markdown content={block.text} onCitation={openCitation} />}
                      {block.toolCalls?.map((call) => (
                        <ToolCallCard
                          key={call.id}
                          call={call}
                          onClarificationSubmit={handleClarificationSubmit}
                          activeClarificationId={liveTurn.clarifyingQuestion?.toolUseId}
                          onCitation={openCitation}
                        />
                      ))}
                    </React.Fragment>
                  ))
                ) : (
                  <>
                    {message.thinking && <ThinkingBlock thinking={message.thinking} />}
                    {message.toolCalls?.map((call) => (
                      <ToolCallCard
                        key={call.id}
                        call={call}
                        onClarificationSubmit={handleClarificationSubmit}
                        activeClarificationId={liveTurn.clarifyingQuestion?.toolUseId}
                        onCitation={openCitation}
                      />
                    ))}
                    <Markdown content={message.content} onCitation={openCitation} />
                  </>
                )}
                <ReviewBadge review={message.review} />
                <div className="message-footer">
                  {message.usage && (
                    <span className="usage" title="Tokens for this response (input / output / cache-read / cache-write / thoughts)">
                      {formatTokens(message.usage.inputTokens)} in · {formatTokens(message.usage.outputTokens)} out
                      {message.usage.cacheReadTokens > 0 && ` · ${formatTokens(message.usage.cacheReadTokens)} cache-read`}
                      {message.usage.cacheWriteTokens > 0 && ` · ${formatTokens(message.usage.cacheWriteTokens)} cache-write`}
                      {message.usage.thoughtTokens && message.usage.thoughtTokens > 0 ? ` · ${formatTokens(message.usage.thoughtTokens)} thoughts` : ''}
                    </span>
                  )}
                  <FeedbackControls message={message} onFeedback={onFeedback} />
                </div>
              </>
            ) : (
              <div className="user-bubble">
                {message.playbook && <span className="playbook-tag">📋 {message.playbook}</span>}
                {message.content}
              </div>
            )}
          </div>
        ))}

        {liveTurn.running && (
          <div className="message assistant live">
            {liveTurn.blocks.map((block, i) => (
              <React.Fragment key={i}>
                {block.thinking && <ThinkingBlock thinking={block.thinking} />}
                {block.text && <Markdown content={block.text} onCitation={openCitation} />}
                {block.toolCalls.map((call) => (
                  <ToolCallCard
                    key={call.id}
                    call={call}
                    onClarificationSubmit={handleClarificationSubmit}
                    activeClarificationId={liveTurn.clarifyingQuestion?.toolUseId}
                    onCitation={openCitation}
                  />
                ))}
              </React.Fragment>
            ))}
            {liveTurn.liveThinking && (
              <div className="thinking-block live">
                <div className="thinking-header">🧠 Thinking...</div>
                <pre className="thinking-text">{liveTurn.liveThinking}</pre>
              </div>
            )}
            {liveTurn.liveText ? (
              <Markdown content={liveTurn.liveText} onCitation={openCitation} live />
            ) : (
              !liveTurn.liveThinking && <div className="thinking-indicator">…</div>
            )}
          </div>
        )}
        {liveTurn.error && <div className="banner error">{liveTurn.error}</div>}
        {liveTurn.notice && <div className="banner notice">{liveTurn.notice}</div>}
      </div>

      <footer className="composer">
        {showAutocomplete && (
          <div className="prompt-autocomplete">
            {suggestions.map((prompt, i) => (
              <button
                key={prompt.name}
                className={`prompt-option ${i === highlight ? 'active' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pickPrompt(prompt)}
              >
                <span className="prompt-option-title">{prompt.title}</span>
                <span className="prompt-option-desc">{prompt.description}</span>
              </button>
            ))}
          </div>
        )}
        {activePrompt && (
          <div className="active-playbook">
            <span className="playbook-tag">📋 {activePrompt.title}</span>
            <span className="active-playbook-hint">applied to your next message</span>
            <button className="active-playbook-remove" title="Remove playbook" onClick={() => setActivePrompt(null)}>
              ×
            </button>
          </div>
        )}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={liveTurn.running || !!liveTurn.clarifyingQuestion}
            placeholder={
              liveTurn.clarifyingQuestion
                ? 'Awaiting clarification...'
                : orchestratorActive
                ? `Ask ${thread.orchestratorProfile} (multi-agent)… specialists + reviewer will answer.`
                : activePrompt
                ? `Add your question for “${activePrompt.title}”…`
                : 'Ask a question… (type “/” for playbooks, Enter to send)'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
          />
          {liveTurn.running && (
            <button className="danger composer-stop" onClick={onInterrupt}>
              Stop
            </button>
          )}
        </div>
        <div className="composer-controls">
          {profiles.length > 0 && (
            <select
              className="composer-select"
              value={thread.orchestratorProfile ?? ''}
              title="Multi-agent profile (orchestrator mode)"
              onChange={(e) => onPatchThread({ orchestratorProfile: e.target.value })}
            >
              <option value="">Off (single agent)</option>
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  🧭 {p.name}
                </option>
              ))}
            </select>
          )}
          {!orchestratorActive && (
            <>
              <select
                className="composer-select"
                value={thread.model}
                title="Model"
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
                title="Thinking effort"
                onChange={(e) => onPatchThread({ thinkingLevel: e.target.value as ThinkingLevel })}
              >
                {THINKING_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </>
          )}
          {orchestratorActive && (
            <span className="orchestrator-hint" title="Models are set per role by the profile">
              multi-agent · specialists + reviewer
            </span>
          )}
        </div>
      </footer>

      {citation && <CitationModal state={citation} onClose={() => setCitation(null)} />}
    </div>
  );
}

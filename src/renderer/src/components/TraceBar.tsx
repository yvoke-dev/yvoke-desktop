import React, { useState } from 'react';
import type { ToolCallInfo, UsageTotals } from '../../../shared/types';
import { ChevronDownIcon, ChevronRightIcon } from './icons';
import { describeArgs, describeResult, shortName } from './toolNames';

/** One line of the run: a stretch of reasoning, or a tool the agent called. */
export type TraceEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: ToolCallInfo };

function formatTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

/** `12 in · 1,296 out · 112.7k cache read · 10k cache write` — moved off the window header and onto the trace. */
function usageLabel(usage: UsageTotals): string {
  const parts = [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`];
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokens(usage.cacheReadTokens)} cache read`);
  if (usage.cacheWriteTokens > 0) parts.push(`${formatTokens(usage.cacheWriteTokens)} cache write`);
  return parts.join(' · ');
}

/**
 * Summary line for the collapsed bar. "9 steps" counts reasoning as well as tools, because
 * that is what the run actually cost; the breakdown after it says how much of that was work.
 */
function summarize(entries: TraceEntry[]): string {
  const tools = entries.filter((e) => e.kind === 'tool');
  const searches = tools.filter(
    (e) => e.kind === 'tool' && shortName(e.call.name) === 'search_corpus',
  ).length;
  const parts = [
    `${entries.length} step${entries.length === 1 ? '' : 's'}`,
    `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
  ];
  if (searches > 0) parts.push(`${searches} corpus search${searches === 1 ? '' : 'es'}`);
  const failed = tools.filter((e) => e.kind === 'tool' && e.call.isError).length;
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

function ThinkingStep(props: { index: number; text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = props.text.replace(/\s+/g, ' ').trim();
  return (
    <>
      <button type="button" className="trace-step" onClick={() => setOpen((o) => !o)}>
        <span className="trace-step-n">{props.index}</span>
        <span>
          <span className="trace-step-name">reasoning</span>{' '}
          <span className="trace-step-detail">
            — {preview.length > 80 ? `${preview.slice(0, 79)}…` : preview}
          </span>
        </span>
        <span className="trace-step-toggle">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {open && (
        <div className="trace-step-body">
          <pre>{props.text}</pre>
        </div>
      )}
    </>
  );
}

function ToolStep(props: { index: number; call: ToolCallInfo }): React.JSX.Element {
  const { index, call } = props;
  const [open, setOpen] = useState(false);
  const args = describeArgs(call);
  const result = describeResult(call);
  const pending = call.result === undefined;
  return (
    <>
      <button
        type="button"
        className={`trace-step ${call.isError ? 'error' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="trace-step-n">{index}</span>
        <span>
          <span className="trace-step-name">{shortName(call.name)}</span>
          {args && <span className="trace-step-detail"> — “{args}”</span>}
          {result && (
            <span className={`trace-step-detail ${result.good ? 'verified' : ''}`}> → {result.text}</span>
          )}
          {pending && <span className="trace-step-detail"> — running…</span>}
        </span>
        <span className="trace-step-toggle">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {open && (
        <div className="trace-step-body">
          <div className="trace-section-label">Input</div>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {!pending && (
            <>
              <div className="trace-section-label">Result</div>
              <pre>{(call.result ?? '').slice(0, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The run's evidence, collapsed to one line above the answer's fold.
 *
 * The old layout stacked every thinking block and tool card ahead of the prose, so roughly 500px
 * of process preceded the first word of the answer. Process is evidence, not content: it stays
 * one line unless the user opens it (or has chosen otherwise in Appearance).
 */
export function TraceBar(props: {
  entries: TraceEntry[];
  usage?: UsageTotals;
  defaultOpen?: boolean;
}): React.JSX.Element | null {
  const { entries, usage, defaultOpen } = props;
  const [open, setOpen] = useState(!!defaultOpen);
  if (entries.length === 0) return null;

  return (
    <div className="trace">
      <button type="button" className="trace-bar" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="trace-caret">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
        <span className="trace-label">Trace</span>
        <span className="trace-summary">{summarize(entries)}</span>
        {usage && (
          <span className="trace-usage" data-tip="Tokens for this response">
            {usageLabel(usage)}
          </span>
        )}
      </button>
      {open && (
        <div className="trace-body">
          {entries.map((entry, i) =>
            entry.kind === 'thinking' ? (
              <ThinkingStep key={i} index={i + 1} text={entry.text} />
            ) : (
              <ToolStep key={entry.call.id || i} index={i + 1} call={entry.call} />
            ),
          )}
          <div className="trace-note">Expand a step to read its reasoning, arguments and result.</div>
        </div>
      )}
    </div>
  );
}

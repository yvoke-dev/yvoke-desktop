import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, MessageBlock, ReviewStatus, ToolCallInfo, UsageTotals } from '../../shared/types';

/** In-stream tool_use name for a delegation (the allow-list token is 'Task'; see orchestration.ts). */
const DELEGATE_TOOL_NAME = 'Agent';
const REVIEWER_SUBAGENT = 'reviewer';

/**
 * Mutable per-turn context the translator threads through consecutive SDK messages.
 * Kept outside AgentService so the translation is a pure, fixture-testable function.
 */
export interface TurnContext {
  threadId: string;
  liveText: string;
  liveThinking: string;
  /** Concatenated final text of the turn (across assistant blocks between tool calls). */
  turnText: string;
  /** Concatenated thinking text of the turn. */
  turnThinking: string;
  toolCalls: ToolCallInfo[];
  blocks: MessageBlock[];
  sessionId?: string;
  /** Orchestrator mode: Agent (delegation) tool calls keyed by their tool_use id, for attributing
   *  forwarded sub-agent messages (parent_tool_use_id) back to the delegation that spawned them. */
  agentCalls: Map<string, ToolCallInfo>;
  /** Set once the runtime has re-prompted this turn for a missing review pass (at most once). */
  reviewEnforced?: boolean;
  /** Revision rounds the runtime has driven this turn after a rejected/unclear verdict. */
  revisionRounds?: number;
  /** Usage from the result(s) already consumed by this turn (a re-prompt produces a second result). */
  carriedUsage?: UsageTotals;
  /** Same, for reported cost — the enforcement pass must not make the first result's cost vanish. */
  carriedCostUsd?: number;
}

export function newTurnContext(threadId: string): TurnContext {
  return {
    threadId,
    liveText: '',
    liveThinking: '',
    turnText: '',
    turnThinking: '',
    toolCalls: [],
    blocks: [],
    agentCalls: new Map(),
  };
}

export function usageFromSdk(usage: Record<string, unknown> | undefined | null): UsageTotals {
  const u = (usage ?? {}) as Record<string, number>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    thoughtTokens: u.thinking_tokens ?? 0,
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          return (block as { text?: string }).text ?? '';
        }
        return '';
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** Parse a reviewer sub-agent's plain-text verdict (first line APPROVED/REJECTED + feedback). */
export function parseVerdict(result: string): { approved: boolean; feedback?: string } | null {
  const trimmed = result.trim();
  if (!trimmed) return null;
  const [firstLine, ...rest] = trimmed.split('\n');
  const head = firstLine.trim().toUpperCase().replace(/[^A-Z]/g, '');
  const feedback = rest.join('\n').trim() || undefined;
  if (head.startsWith('APPROVED')) return { approved: true, feedback };
  if (head.startsWith('REJECTED')) return { approved: false, feedback };

  // Fallback: the model reasoned first and put the token further down. Feedback is whatever follows
  // the LAST standalone verdict line — a revision round replays this text back to the orchestrator,
  // so the pre-verdict deliberation must not ride along as "feedback to address".
  const lines = trimmed.split('\n');
  const verdictLine = lines.reduce(
    (found, line, i) => (/^[*_\s]*(APPROVED|REJECTED)[*_\s]*[:.]?\s*$/i.test(line) ? i : found),
    -1,
  );
  if (verdictLine >= 0) {
    const approved = /APPROVED/i.test(lines[verdictLine]);
    return { approved, feedback: lines.slice(verdictLine + 1).join('\n').trim() || undefined };
  }
  if (/\bAPPROVED\b/.test(trimmed) && !/\bREJECTED\b/.test(trimmed)) return { approved: true, feedback };
  if (/\bREJECTED\b/.test(trimmed)) return { approved: false, feedback };
  return null;
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    thoughtTokens: (a.thoughtTokens ?? 0) + (b.thoughtTokens ?? 0),
  };
}

/**
 * Classify a finished turn's review state from its delegations. Returns undefined when the turn
 * delegated to nobody — that is a plain (non-orchestrated) answer with nothing to review.
 *
 * The LAST reviewer delegation wins: with maxReviewRounds > 1 the orchestrator may be REJECTED,
 * revise, and be APPROVED on the next round, and it is the final verdict that ships.
 */
export function reviewStatusOf(toolCalls: ToolCallInfo[], enforced = false): ReviewStatus | undefined {
  const delegations = toolCalls.filter((c) => c.name === DELEGATE_TOOL_NAME);
  if (delegations.length === 0) return undefined;

  const reviews = delegations.filter((c) => c.subagentType === REVIEWER_SUBAGENT);
  if (reviews.length === 0) return { outcome: 'skipped', ...(enforced ? { enforced } : {}) };

  const last = reviews[reviews.length - 1];
  // A reviewer that errored, or answered without a parseable APPROVED/REJECTED, is not a pass.
  if (last.isError || !last.verdict) return { outcome: 'unclear', ...(enforced ? { enforced } : {}) };
  return {
    outcome: last.verdict.approved ? 'approved' : 'rejected',
    ...(last.verdict.feedback ? { feedback: last.verdict.feedback } : {}),
    ...(enforced ? { enforced } : {}),
  };
}

/**
 * What the runtime must do with a finished orchestrated turn:
 *   deliver — ship it (approved, opted out, or out of revision rounds);
 *   enforce — no reviewer ran; re-prompt for a review pass;
 *   revise  — the reviewer rejected (or gave no clear verdict); hand the feedback back for a fix.
 */
export type ReviewAction =
  | { kind: 'deliver' }
  | { kind: 'enforce' }
  | { kind: 'revise'; outcome: 'rejected' | 'unclear'; feedback?: string; round: number };

/**
 * Gate for the code-driven review loop. Kept pure (and separate from the AgentService plumbing)
 * because it decides whether an answer reaches the user, so it must be directly testable.
 *
 * Mirrors the web harness (OrchestrationService): it re-runs the orchestrator with the reviewer's
 * feedback while `round < maxReviewRounds`, then delivers the last answer flagged. Desktop counts
 * rounds the same way — `revisionRounds` is how many the runtime has already driven this turn.
 *
 * Errored and user-aborted turns are left alone: there is no composed answer worth reviewing, and
 * re-prompting an interrupted turn would fight the user's Stop.
 */
export function nextReviewAction(params: {
  orchestratorMode: boolean;
  isError: boolean;
  aborted: boolean;
  alreadyEnforced: boolean;
  /** Revision rounds already driven this turn (TurnContext.revisionRounds). */
  revisionRounds?: number;
  /** OrchestratorSettings.maxReviewRounds — 0/undefined disables revision rounds. */
  maxReviewRounds?: number;
  /** OrchestratorSettings.requireReview — undefined means enabled (the default). */
  requireReview?: boolean;
  toolCalls: ToolCallInfo[];
}): ReviewAction {
  const deliver: ReviewAction = { kind: 'deliver' };
  if (!params.orchestratorMode || params.isError || params.aborted) return deliver;
  if (params.requireReview === false) return deliver;

  const status = reviewStatusOf(params.toolCalls);
  if (!status || status.outcome === 'approved') return deliver;

  if (status.outcome === 'skipped') {
    return params.alreadyEnforced ? deliver : { kind: 'enforce' }; // one attempt per turn; never loop
  }

  const done = params.revisionRounds ?? 0;
  if (done >= (params.maxReviewRounds ?? 0)) return deliver; // out of rounds — ship it flagged
  return { kind: 'revise', outcome: status.outcome, feedback: status.feedback, round: done + 1 };
}

/** Reviewer delegations in a turn = how many validation attempts the answer went through. */
export function reviewAttempts(toolCalls: ToolCallInfo[]): number {
  return toolCalls.filter((c) => c.name === DELEGATE_TOOL_NAME && c.subagentType === REVIEWER_SUBAGENT).length;
}

/**
 * Translates one SDK message into renderer-facing events, updating the turn context.
 * The caller owns turn lifecycle (creating a fresh context per user turn) and the
 * final turn-complete event (which needs ChatMessage persistence concerns).
 *
 * In orchestrator mode, sub-agent messages arrive with `parent_tool_use_id` set (forwarded by the
 * SDK). Those are attributed to the spawning Agent call's `subagentBlocks` and MUST NOT leak into the
 * orchestrator's own turnText/blocks/liveText — otherwise the composed answer is polluted.
 */
export function translateMessage(msg: SDKMessage, ctx: TurnContext): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        ctx.sessionId = msg.session_id;
        events.push({
          kind: 'mcp-status',
          threadId: ctx.threadId,
          servers: msg.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
        });
      }
      break;
    }

    case 'stream_event': {
      // Only stream the main-thread (orchestrator) deltas into the live area; sub-agent deltas are
      // surfaced through their delegation card, not the composed-answer live view.
      if (parentId) break;
      const event = msg.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          ctx.liveThinking += event.delta.thinking;
          events.push({ kind: 'live-thinking', threadId: ctx.threadId, text: ctx.liveThinking });
        } else if (event.delta?.type === 'text_delta' && event.delta.text) {
          ctx.liveText += event.delta.text;
          events.push({ kind: 'live-text', threadId: ctx.threadId, text: ctx.liveText });
        }
      }
      break;
    }

    case 'assistant': {
      const content = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
      let blockText = '';
      let blockThinking = '';
      const toolCalls: ToolCallInfo[] = [];
      for (const block of content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          blockThinking += block.thinking;
        } else if (block.type === 'text' && typeof block.text === 'string') {
          blockText += block.text;
        } else if (block.type === 'tool_use') {
          const call: ToolCallInfo = { id: String(block.id), name: String(block.name), input: block.input };
          if (call.name === DELEGATE_TOOL_NAME) {
            const input = (block.input ?? {}) as { subagent_type?: string; prompt?: string; description?: string };
            call.subagentType = input.subagent_type;
            call.subagentBlocks = [];
            // Only main-thread delegations spawn sub-agents we attribute forwarded messages to.
            if (!parentId) {
              ctx.agentCalls.set(call.id, call);
              events.push({
                kind: 'subagent-start',
                threadId: ctx.threadId,
                toolUseId: call.id,
                subagentType: input.subagent_type ?? '?',
                question: (input.prompt ?? input.description ?? '').slice(0, 2000),
              });
            }
          }
          toolCalls.push(call);
        }
      }

      if (parentId) {
        // Forwarded sub-agent message → nest under its delegation card; never touch the main turn.
        const agentCall = ctx.agentCalls.get(parentId);
        if (agentCall && (blockText || blockThinking || toolCalls.length > 0)) {
          (agentCall.subagentBlocks ??= []).push({
            text: blockText || undefined,
            thinking: blockThinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        }
        break;
      }

      if (blockText || blockThinking || toolCalls.length > 0) {
        ctx.turnText += (ctx.turnText && blockText ? '\n\n' : '') + blockText;
        ctx.turnThinking += blockThinking;
        ctx.toolCalls.push(...toolCalls);
        ctx.blocks.push({
          text: blockText || undefined,
          thinking: blockThinking || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
        ctx.liveText = '';
        ctx.liveThinking = '';
        events.push({ kind: 'assistant-block', threadId: ctx.threadId, text: blockText, thinking: blockThinking || undefined, toolCalls });
      }
      break;
    }

    case 'user': {
      // Tool results come back as (replayed) user messages carrying tool_result blocks.
      const message = (msg as { message?: { content?: unknown } }).message;
      const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const result = stringifyToolResult(block.content);
        const isError = block.is_error === true;
        const toolUseId = String(block.tool_use_id);

        if (parentId) {
          // Result of a tool the sub-agent itself called → attribute to the delegation's nested trace.
          const agentCall = ctx.agentCalls.get(parentId);
          const inner = agentCall?.subagentBlocks?.flatMap((b) => b.toolCalls ?? []).find((c) => c.id === toolUseId);
          if (inner) {
            inner.result = result;
            inner.isError = isError;
          }
          continue;
        }

        const call = ctx.toolCalls.find((c) => c.id === toolUseId);
        if (call) {
          call.result = result;
          call.isError = isError;
        }
        events.push({ kind: 'tool-result', threadId: ctx.threadId, toolUseId, result, isError });

        // A completed delegation: surface a specialist-complete / reviewer-verdict event.
        if (call?.name === DELEGATE_TOOL_NAME) {
          const subagentType = call.subagentType ?? '?';
          events.push({ kind: 'subagent-complete', threadId: ctx.threadId, toolUseId, subagentType, result, isError });
          if (subagentType === REVIEWER_SUBAGENT && !isError) {
            const verdict = parseVerdict(result);
            if (verdict) {
              call.verdict = verdict;
              events.push({
                kind: 'review-verdict',
                threadId: ctx.threadId,
                toolUseId,
                approved: verdict.approved,
                feedback: verdict.feedback,
              });
            }
          }
        }
      }
      break;
    }

    default:
      break;
  }

  return events;
}

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, MessageBlock, ReviewStatus, ToolCallInfo, UsageTotals } from '../../shared/types';
import { clarificationState, isClarificationTool, parseVerdict } from '../../shared/types';
import { ORCHESTRATOR_SUBMIT_ANSWER_TOOL } from './reviewTools';

/** In-stream tool_use name for a delegation (the allow-list token is 'Task'; see orchestration.ts). */
const DELEGATE_TOOL_NAME = 'Agent';
const REVIEWER_SUBAGENT = 'reviewer';

/**
 * Mutable per-turn context the translator threads through consecutive SDK messages.
 * Kept outside AgentService so the translation is a pure, fixture-testable function.
 */
export interface TurnContext {
  threadId: string;
  orchestratorMode?: boolean;
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
  /** Tool-use IDs of internal protocol tools (e.g. `mcp__review__submit_answer`) suppressed from UI cards. */
  internalToolUseIds: Set<string>;
  /** Revision rounds the runtime has driven this turn after a rejected/unclear verdict. */
  revisionRounds?: number;
  /** Usage from the result(s) already consumed by this turn (a re-prompt produces a second result). */
  carriedUsage?: UsageTotals;
  /** Same, for reported cost — the enforcement pass must not make the first result's cost vanish. */
  carriedCostUsd?: number;
}

export function newTurnContext(threadId: string, orchestratorMode = false): TurnContext {
  return {
    threadId,
    orchestratorMode,
    liveText: '',
    liveThinking: '',
    turnText: '',
    turnThinking: '',
    toolCalls: [],
    blocks: [],
    agentCalls: new Map(),
    internalToolUseIds: new Set(),
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
export function reviewStatusOf(toolCalls: ToolCallInfo[]): ReviewStatus | undefined {
  const delegations = toolCalls.filter((c) => c.name === DELEGATE_TOOL_NAME);
  if (delegations.length === 0) return undefined;

  const reviews = delegations.filter((c) => c.subagentType === REVIEWER_SUBAGENT);
  if (reviews.length === 0) return { outcome: 'skipped' };

  const last = reviews[reviews.length - 1];
  // A reviewer that errored, or answered without a parseable APPROVED/REJECTED, is not a pass.
  if (last.isError || !last.verdict) return { outcome: 'unclear' };
  return {
    outcome: last.verdict.approved ? 'approved' : 'rejected',
    ...(last.verdict.feedback ? { feedback: last.verdict.feedback } : {}),
  };
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
      // In orchestratorMode, root plain-text deltas are also held back so unreviewed prose and
      // post-submit_answer closing remarks never stream live before completeTurn settles the answer.
      if (parentId) break;
      const event = msg.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          ctx.liveThinking += event.delta.thinking;
          events.push({ kind: 'live-thinking', threadId: ctx.threadId, text: ctx.liveThinking });
        } else if (!ctx.orchestratorMode && event.delta?.type === 'text_delta' && event.delta.text) {
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
          const toolName = String(block.name);
          const toolId = String(block.id);
          if (toolName === ORCHESTRATOR_SUBMIT_ANSWER_TOOL) {
            ctx.internalToolUseIds.add(toolId);
            continue;
          }
          const call: ToolCallInfo = { id: toolId, name: toolName, input: block.input };
          if (ctx.orchestratorMode && call.name === DELEGATE_TOOL_NAME) {
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
        const visibleText = ctx.orchestratorMode ? '' : blockText;
        if (visibleText || blockThinking || toolCalls.length > 0) {
          ctx.blocks.push({
            text: visibleText || undefined,
            thinking: blockThinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          });
          events.push({
            kind: 'assistant-block',
            threadId: ctx.threadId,
            text: visibleText,
            thinking: blockThinking || undefined,
            toolCalls,
          });
        }
        ctx.liveText = '';
        ctx.liveThinking = '';
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
        if (ctx.internalToolUseIds.has(toolUseId)) {
          continue;
        }

        if (parentId) {
          // Result of a tool the sub-agent itself called → attribute to the delegation's nested trace.
          const agentCall = ctx.agentCalls.get(parentId);
          const inner = agentCall?.subagentBlocks?.flatMap((b) => b.toolCalls ?? []).find((c) => c.id === toolUseId);
          if (inner) {
            inner.result = result;
            inner.isError = isClarificationTool(inner.name)
              ? clarificationState({ ...inner, result }) !== 'answered'
              : isError;
          }
          continue;
        }

        const call = ctx.toolCalls.find((c) => c.id === toolUseId);
        const effectiveIsError = call && isClarificationTool(call.name)
          ? clarificationState({ ...call, result }) !== 'answered'
          : isError;
        if (call) {
          call.result = result;
          call.isError = effectiveIsError;
        }
        events.push({ kind: 'tool-result', threadId: ctx.threadId, toolUseId, result, isError: effectiveIsError });

        // A completed delegation: surface a specialist-complete / reviewer-verdict event in orchestrator mode.
        if (ctx.orchestratorMode && call?.name === DELEGATE_TOOL_NAME) {
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

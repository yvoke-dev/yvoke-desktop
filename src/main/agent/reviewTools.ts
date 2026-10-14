/**
 * Pure, dependency-free helpers for the reviewer's `submit_review` tool (wired up in
 * `reviewServer.ts`), ported from `SubmitReviewTool.java` and `Verdict.java` in `yvoke-web`.
 *
 * Kept free of Agent SDK imports so `policy.ts`, `orchestration.ts`, and unit tests can import
 * the tool names and argument parser directly without pulling in the SDK runtime.
 */

import type { ReviewVerdict } from '../../shared/types';

export const REVIEW_SERVER_NAME = 'review';
export const REVIEW_TOOL_PREFIX = `mcp__${REVIEW_SERVER_NAME}__`;
export const REVIEW_SUBMIT_TOOL = `${REVIEW_TOOL_PREFIX}submit_review`;
export const ORCHESTRATOR_SUBMIT_ANSWER_TOOL = `${REVIEW_TOOL_PREFIX}submit_answer`;

export const SUBMIT_REVIEW_DESCRIPTION =
  'Submit your final review verdict. You MUST call this exactly once as your ' +
  'last action. Set approved=true only if every claim in the answer is supported ' +
  'by the supplied evidence; otherwise approved=false with concrete feedback the ' +
  'orchestrator can act on.';

export const SUBMIT_ANSWER_DESCRIPTION =
  'Submit your complete, user-facing Markdown answer for automated review and delivery. ' +
  'Call this tool once you have gathered all necessary specialist evidence and verified every ' +
  'citation id via verify_citations. If the reviewer approves your answer, it is delivered to ' +
  'the user and you must end your turn immediately without repeating the answer. If the reviewer ' +
  'rejects your answer, the tool returns the reviewer feedback and evidence so you can revise and ' +
  'call submit_answer again.';

/**
 * Extract and trim the `answer` string from raw `submit_answer` arguments, returning `''` when
 * missing, non-string, or malformed.
 */
export function parseSubmitAnswerArgs(rawArgs: unknown): string {
  try {
    let parsed: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      parsed = JSON.parse(rawArgs);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '';
    }
    const answer = (parsed as Record<string, unknown>).answer;
    return typeof answer === 'string' ? answer.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Validate `submit_answer` arguments and invoke `onSubmitAnswer(answer)`. Rejects missing or
 * whitespace-only `answer` with `isError: true` without invoking `onSubmitAnswer`.
 */
export async function submitAnswerCall(
  rawArgs: unknown,
  onSubmitAnswer: (answer: string) => Promise<{ text: string; isError?: boolean }>,
): Promise<{ text: string; isError?: boolean }> {
  const answer = parseSubmitAnswerArgs(rawArgs);
  if (answer.length === 0) {
    return {
      text: 'Error: answer must be a non-empty string.',
      isError: true,
    };
  }
  return onSubmitAnswer(answer);
}

function coerceStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((item): item is string => typeof item === 'string');
}

/**
 * Parse and coerce raw arguments (either a JSON string or a plain object) into a `ReviewVerdict`.
 * Mirrors `SubmitReviewTool.callWithContext` in `yvoke-web`:
 * - `approved` is `Boolean.TRUE.equals(args.get("approved"))` (missing/non-boolean -> `false`).
 * - `feedback` defaults to `""`.
 * - `unsupported_claims` and `citation_fixes` default to `[]` (explicit `null` coerced to `[]`).
 */
export function parseSubmitReviewArgs(rawArgs: unknown): ReviewVerdict {
  let parsed: unknown = rawArgs;
  if (typeof rawArgs === 'string') {
    parsed = JSON.parse(rawArgs);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Arguments must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const approved = obj.approved === true;
  const feedback = typeof obj.feedback === 'string' ? obj.feedback : '';
  const unsupportedClaims = coerceStringArray(obj.unsupported_claims ?? obj.unsupportedClaims);
  const citationFixes = coerceStringArray(obj.citation_fixes ?? obj.citationFixes);

  return {
    approved,
    feedback,
    unsupportedClaims,
    citationFixes,
  };
}

/**
 * Execute the `submit_review` tool logic: parse arguments, invoke `onVerdict`, and return
 * `"Verdict recorded."` (or `"Error parsing arguments: ..."` on malformed input without invoking
 * `onVerdict`).
 */
export function submitReviewCall(
  rawArgs: unknown,
  onVerdict: (verdict: ReviewVerdict) => void,
): { text: string; isError?: boolean } {
  try {
    const verdict = parseSubmitReviewArgs(rawArgs);
    onVerdict(verdict);
    return { text: 'Verdict recorded.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Error parsing arguments: ${msg}`, isError: true };
  }
}

/**
 * Format a structured `ReviewVerdict` into a readable summary string for `ToolCallInfo.result`,
 * `SubagentCard`, and the admin trace viewer.
 */
export function formatVerdictSummary(verdict: ReviewVerdict): string {
  const status = verdict.approved ? 'APPROVED' : 'REJECTED';
  const lines: string[] = [status];
  if (verdict.feedback && verdict.feedback.trim().length > 0) {
    lines.push(verdict.feedback.trim());
  }
  const fixes = verdict.citationFixes ?? [];
  if (fixes.length > 0) {
    lines.push('');
    lines.push('Citation fixes:');
    for (const fix of fixes) {
      lines.push(`- ${fix}`);
    }
  }
  const unsupported = verdict.unsupportedClaims ?? [];
  if (unsupported.length > 0) {
    lines.push('');
    lines.push('Unsupported claims:');
    for (const claim of unsupported) {
      lines.push(`- ${claim}`);
    }
  }
  return lines.join('\n');
}

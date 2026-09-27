import type { Query, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The stream closed before any result arrived — the subprocess died, the transport dropped, or
 * the CLI exited early. It is a *type* rather than a message because callers that classify
 * failures cannot safely tell it apart from a real one by reading its prose: the credential check
 * used to match its own `what` string against an "is this an auth error?" regex and tell the user
 * to run `claude /login`.
 */
export class NoReplyError extends Error {
  constructor(what: string) {
    super(`${what} ended without a result`);
    this.name = 'NoReplyError';
  }
}

/**
 * A one-shot query ended with a failed result message (`is_error: true` or a non-success subtype).
 * Carries the result subtype and any HTTP status code reported by the Claude Agent SDK
 * (`api_error_status`, e.g. 401, 403, 429) so callers can classify the failure by type rather
 * than parsing prose.
 */
export class ResultError extends Error {
  readonly status?: number;
  readonly subtype: string;

  constructor(message: string, subtype: string, status?: number) {
    super(message);
    this.name = 'ResultError';
    this.subtype = subtype;
    this.status = status;
  }
}

/**
 * Tests whether an SDK result message represents an execution failure.
 * The Claude Agent SDK emits `subtype: 'success'` with `is_error: true` when the Claude Code CLI
 * fails or encounters an unauthenticated turn, so checking `subtype !== 'success'` alone is insufficient.
 */
export function isResultFailure(
  message: SDKResultMessage | { is_error?: boolean; subtype: string },
): boolean {
  return Boolean(message.is_error || message.subtype !== 'success');
}

/**
 * The model's reply text from a one-shot `query()` — shared by local single-turn checks
 * (`verifyClaudeCredentials`, `PlaybookValidator`, `ImageDescriptor`), which differ in what
 * they ask and agree on how they read the answer.
 *
 * Stops at the result message rather than draining the iterator: on a non-success result the SDK
 * re-raises the failure as an exception *after* yielding it, so a full drain turns an ordinary
 * "max turns" outcome into a thrown error. Leaving the loop early runs the generator's own
 * teardown and lets the subtype be read as data.
 *
 * Throws `ResultError` when `isResultFailure` is true, carrying error details and `api_error_status`.
 * Throws `NoReplyError` if the stream closes without producing a result message.
 */
export async function readSingleReply(q: Query, what: string): Promise<string> {
  for await (const message of q) {
    if (message.type !== 'result') continue;
    if (isResultFailure(message)) {
      const errDetail =
        message.subtype === 'success'
          ? (message.result?.trim() || 'Claude Code returned an error result')
          : (message.errors?.filter(Boolean).join('; ') || message.subtype);
      const status =
        message.subtype === 'success' && typeof message.api_error_status === 'number'
          ? message.api_error_status
          : undefined;
      throw new ResultError(errDetail, message.subtype, status);
    }
    return message.subtype === 'success' ? (message.result ?? '') : '';
  }
  throw new NoReplyError(what);
}


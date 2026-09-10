import type { Query } from '@anthropic-ai/claude-agent-sdk';

/**
 * The model's reply text from a one-shot `query()` — shared by the local single-turn checks
 * (`PlaybookValidator`, `ImageDescriptor`), which differ in what they ask and agree on everything
 * about how they read the answer.
 *
 * Stops at the result message rather than draining the iterator: on a non-success result the SDK
 * re-raises the failure as an exception *after* yielding it, so a full drain turns an ordinary
 * "max turns" outcome into a thrown error. Leaving the loop early runs the generator's own
 * teardown and lets the subtype be read as data.
 *
 * `what` names the caller in the "ended without a result" message, which is otherwise the one
 * failure with nothing in it to say where it came from.
 */
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

export async function readSingleReply(q: Query, what: string): Promise<string> {
  for await (const message of q) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      throw new Error(message.errors.join('; ') || message.subtype);
    }
    return message.result ?? '';
  }
  throw new NoReplyError(what);
}

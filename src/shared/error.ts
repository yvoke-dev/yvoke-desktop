export type ErrorSource = 'Claude' | 'Entra' | 'Yvoke Backend';

export const ERROR_SOURCES: readonly ErrorSource[] = ['Claude', 'Entra', 'Yvoke Backend'] as const;

/**
 * Whether `message` is already attributed to `source`.
 *
 * `<source>:` is the whole test: the space that normally follows the colon is part of the
 * message, not part of the prefix, so testing for `'<source>: '` as well can only ever
 * re-match what this already matched.
 */
export function hasErrorSourcePrefix(message: string, source: ErrorSource): boolean {
  return typeof message === 'string' && message.startsWith(`${source}:`);
}

/** Whether `message` is already attributed to any known source. */
export function isAttributedError(message: string): boolean {
  return ERROR_SOURCES.some((source) => hasErrorSourcePrefix(message, source));
}

/**
 * Strips leading known error source prefixes (e.g. 'Claude: ', 'Entra: ', 'Yvoke Backend: ')
 * from an error message while preserving any internal colons (e.g. HTTP status, URLs).
 */
export function stripErrorPrefix(message: string): string {
  if (typeof message !== 'string') {
    return '';
  }

  let stripped = message.trim();
  let changed = true;

  while (changed) {
    changed = false;
    for (const source of ERROR_SOURCES) {
      if (hasErrorSourcePrefix(stripped, source)) {
        // +1 for the colon; any following space is trimmed off with the rest.
        stripped = stripped.slice(source.length + 1).trim();
        changed = true;
      }
    }
  }

  return stripped;
}

/**
 * Safely extracts a readable string from an arbitrary unknown error input.
 * Handles Error instances, strings, circular structures, and arbitrary objects.
 */
function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : 'Unknown error';
  }

  if (error instanceof Error) {
    const msg = error.message.trim();
    if (msg.length > 0) {
      return msg;
    }
    return error.name || 'Error';
  }

  if (typeof error === 'object') {
    if ('message' in error) {
      const raw = (error as { message: unknown }).message;
      if (typeof raw === 'string') {
        const msg = raw.trim();
        return msg.length > 0 ? msg : 'Unknown error';
      }
      // A non-string `message` says nothing by itself, but the object around it usually
      // does. Fall through to serialization rather than reporting less than an object with
      // no `message` property at all would.
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') {
        return json;
      }
    } catch {
      // Circular references or failed JSON serialization
    }

    return 'Unknown error';
  }

  return String(error);
}

/**
 * Attributes an error to a known source subsystem (Claude, Entra, or Yvoke Backend).
 * Strips any existing known prefixes first to ensure idempotency and prevent nested
 * attribution strings like "Yvoke Backend: Entra: ...".
 */
export function tagAttributedError(source: ErrorSource, error: unknown): string {
  const extracted = extractErrorMessage(error);
  const stripped = stripErrorPrefix(extracted);
  const finalMessage = stripped.length > 0 ? stripped : 'Unknown error';
  return `${source}: ${finalMessage}`;
}

/**
 * Sanitizes sensitive credentials and tokens (Bearer JWTs, Anthropic API keys)
 * from text before it is written to disk logs or telemetry.
 */
export function sanitizeLogContent(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]');
}

/**
 * Whether an error is the network failing rather than the peer refusing. Node's undici reports
 * the syscall on `cause`, not in `message`, so both are checked.
 *
 * This lives here because all three callers — the Entra silent refresh, the sync request path and
 * the connection probe — must agree: the same outage classified as "expired" in one place and
 * "unreachable" in another sends the user to re-authenticate against a server that is merely down.
 */
export function isNetworkError(error: unknown): boolean {
  const codes = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'];
  const seen = new Set<unknown>();
  let cursor: unknown = error;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && codes.includes(code)) {
      return true;
    }
    const message = cursor instanceof Error ? cursor.message : String(cursor ?? '');
    if (message.includes('fetch failed') || codes.some((c) => message.includes(c))) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

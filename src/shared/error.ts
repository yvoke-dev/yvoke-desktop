export type ErrorSource = 'Claude' | 'Entra' | 'Yvoke Backend';

export const ERROR_SOURCES: readonly ErrorSource[] = ['Claude', 'Entra', 'Yvoke Backend'] as const;

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
      const withSpace = `${source}: `;
      const withoutSpace = `${source}:`;

      if (stripped.startsWith(withSpace)) {
        stripped = stripped.slice(withSpace.length).trim();
        changed = true;
      } else if (stripped.startsWith(withoutSpace)) {
        stripped = stripped.slice(withoutSpace.length).trim();
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
      if (typeof (error as { message: unknown }).message === 'string') {
        const msg = (error as { message: string }).message.trim();
        return msg.length > 0 ? msg : 'Unknown error';
      }
      return 'Unknown error';
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

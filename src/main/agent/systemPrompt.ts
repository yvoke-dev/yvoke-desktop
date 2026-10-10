import type { SyncClient } from '../sync/SyncClient';
import { BASE_SYSTEM_PROMPT_NAME, isValidSystemPromptName, type ValidSystemPromptName } from '../../shared/types';
import {
  hasErrorSourcePrefix,
  isNotFoundError,
  sanitizeLogContent,
  tagAttributedError,
} from '../../shared/error';
import { log } from '../log';

export { BASE_SYSTEM_PROMPT_NAME };

/**
 * Loads a designated custom system prompt by name.
 * - Re-throws Entra authentication errors immediately (never swallows).
 * - Re-throws transient network errors and 5xx failures (fails closed).
 * - Returns null on 404 Not Found, empty/whitespace prompt, or invalid name shape (clean fallback).
 */
export async function loadDesignatedSystemPrompt(
  fetchPrompt: (name: ValidSystemPromptName) => Promise<string>,
  promptName: string,
): Promise<string | null> {
  const trimmed = promptName.trim();
  if (!isValidSystemPromptName(trimmed)) {
    const safeName = sanitizeLogContent(promptName).slice(0, 80);
    log('agent', `Custom system prompt "${safeName}" has invalid name shape, falling back`);
    return null;
  }
  let prompt: string;
  try {
    prompt = await fetchPrompt(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (hasErrorSourcePrefix(msg, 'Entra')) {
      throw err;
    }
    if (isNotFoundError(err)) {
      const safeName = sanitizeLogContent(trimmed).slice(0, 80);
      const safeMsg = sanitizeLogContent(msg).slice(0, 200).replace(/[\r\n]+/g, ' ');
      log('agent', `Custom system prompt "${safeName}" not found (404), falling back: ${safeMsg}`);
      return null;
    }
    throw new Error(
      tagAttributedError(
        'Yvoke Backend',
        `Custom system prompt "${trimmed.slice(0, 80)}" could not be loaded: ` + msg,
      ),
    );
  }

  if (!prompt || !prompt.trim()) {
    const safeName = sanitizeLogContent(trimmed).slice(0, 80);
    log('agent', `Custom system prompt "${safeName}" came back empty, falling back`);
    return null;
  }
  const safeName = sanitizeLogContent(trimmed).slice(0, 80);
  log('agent', `Loaded designated system prompt "${safeName}" from remote server`);
  return prompt;
}

/**
 * Resolves the system prompt for a session.
 * For custom designated prompts, cleanly falls back to BASE_SYSTEM_PROMPT_NAME ('default-chat')
 * on 404, empty body, or invalid name.
 *
 * For the base system prompt itself (`default-chat`), there is deliberately NO local fallback:
 * the prompt carries the grounding rules, the citation contract and the mermaid/KaTeX delimiters;
 * a hardcoded copy would drift from the server's `default-chat` and silently contradict the
 * playbooks and tools. If `default-chat` cannot be loaded, it fails closed and throws.
 *
 * Thrown messages reach the user: App.tsx puts them on the failed turn.
 */
export async function loadRequiredSystemPrompt(
  syncClient: Pick<SyncClient, 'getSystemPrompt'>,
  promptName?: string,
): Promise<string> {
  const trimmed = promptName?.trim();
  if (trimmed && trimmed !== BASE_SYSTEM_PROMPT_NAME) {
    const customPrompt = await loadDesignatedSystemPrompt(
      (name) => syncClient.getSystemPrompt(name),
      trimmed,
    );
    if (customPrompt !== null) {
      return customPrompt;
    }
    return loadRequiredSystemPrompt(syncClient, BASE_SYSTEM_PROMPT_NAME);
  }

  let prompt: string;
  try {
    prompt = await syncClient.getSystemPrompt(BASE_SYSTEM_PROMPT_NAME);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (hasErrorSourcePrefix(msg, 'Entra')) {
      throw err;
    }
    throw new Error(
      tagAttributedError(
        'Yvoke Backend',
        `System prompt "${BASE_SYSTEM_PROMPT_NAME}" could not be loaded (is the server reachable?): ` +
          msg,
      ),
    );
  }

  if (!prompt || !prompt.trim()) {
    throw new Error(
      tagAttributedError(
        'Yvoke Backend',
        `System prompt "${BASE_SYSTEM_PROMPT_NAME}" came back empty (is the server reachable?).`,
      ),
    );
  }
  log('agent', `Loaded system prompt "${BASE_SYSTEM_PROMPT_NAME}" from remote server`);
  return prompt;
}

import type { McpPromptInfo, PlaybookValidation } from '../../shared/types';

/**
 * Pure prompt-building and response-parsing for the playbook preflight check — the same
 * check the web app runs in `PlaybookValidationController` before a conversation's first
 * message: ask a cheap model whether the playbook the user picked is the right one for the
 * question they typed, and if not, which one is.
 *
 * The LLM call itself lives in `PlaybookValidator`; everything here is deterministic so the
 * contract (what the model is told, what the app will accept back) can be tested without one.
 *
 * Every ambiguity resolves to "the selection is fine". A preflight check that guesses wrong
 * costs the user a wasted question; a preflight check that blocks a good question on a garbled
 * model response costs them the feature.
 */

/** The whole check has to fit inside the pause before a message sends. */
export const VALIDATION_TIMEOUT_MS = 45_000;

/**
 * Deliberately domain-neutral, where the web's copy names One Identity Manager outright. The
 * playbook list carries the domain — every knowledge base is served by the same client, and a
 * product name baked into the client is the kind of per-KB hardcoding this codebase has already
 * had to unpick once (see the note at the foot of shared/types.ts).
 */
export function buildValidatorSystemPrompt(
  playbooks: McpPromptInfo[],
  selectedName: string,
): string {
  const list = playbooks
    .map((p) => `${p.name} | ${p.title} | ${p.description}`)
    .join('\n')
    .trim();
  return `You are a playbook validator for a knowledge-base assistant.
Your task is to analyze the user's question, evaluate if their selected playbook is the most appropriate one, and if not, suggest the single best playbook from the list of available playbooks.

Available Playbooks (name | title | description):
${list}

Selected Playbook Name:
${selectedName}

Decide:
1. Is the selected playbook appropriate and correct for this user question?
2. If not, which playbook name from the list of available playbooks is the best match? (Return null if the selected one is appropriate).
3. Provide a concise explanation (1-2 sentences) of why the selected playbook is wrong and why the recommended one is better.

Rules:
- Be conservative: only answer false when the selected playbook is clearly a poor fit and a DIFFERENT listed playbook is clearly better. A playbook that merely overlaps with a better one is still appropriate.
- If the selected playbook is appropriate or the best match, you MUST set "plausible": true, "suggestedPlaybookName": null, and "reason": "".
- Never suggest the currently selected playbook in "suggestedPlaybookName". Only set "plausible": false if a DIFFERENT playbook from the available list is clearly a better fit.

You MUST respond ONLY with a raw JSON object matching the schema below. Do not wrap the JSON in markdown fences.
JSON Schema:
{
  "plausible": boolean (true if the selected playbook is correct, false if incorrect),
  "reason": string (explanation if incorrect, otherwise an empty string),
  "suggestedPlaybookName": string (the name of the suggested DIFFERENT playbook from the available list if incorrect, otherwise null)
}`;
}

/** The verdict returned whenever the check cannot produce a trustworthy one. */
export const PASSES: PlaybookValidation = { plausible: true };

/**
 * Pull the JSON object out of a model reply. The prompt asks for raw JSON, but a fenced block
 * or a sentence of preamble is the common way that instruction is not followed, and neither is
 * a reason to discard an otherwise usable verdict.
 */
function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (!text) return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Turn a model reply into a verdict the UI can act on, keeping only what the playbook list
 * actually backs:
 *  - a non-boolean `plausible` is not a verdict, so the selection passes;
 *  - a suggestion matching the playbook already selected (by name or title) means the model
 *    considers the current playbook appropriate, so it passes;
 *  - a rejection without a valid, different alternative playbook from the available list has
 *    nothing actionable to offer the user, so it passes rather than raising a dead-end refusal.
 */
export function parseValidation(
  raw: string,
  playbooks: McpPromptInfo[],
  selectedName: string,
): PlaybookValidation {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') return PASSES;
  const obj = parsed as Record<string, unknown>;
  if (obj.plausible !== false) return PASSES;

  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';

  let suggested: McpPromptInfo | undefined;
  if (typeof obj.suggestedPlaybookName === 'string' && obj.suggestedPlaybookName.trim()) {
    const name = obj.suggestedPlaybookName.trim().toLowerCase();
    suggested =
      playbooks.find((p) => p.name.toLowerCase() === name) ??
      playbooks.find((p) => p.title.toLowerCase() === name);
  }

  // If the suggested playbook matches the selected one (by name or title), the model agrees with
  // the user's selection despite a negative `plausible` flag — treat it as passing.
  const selected = playbooks.find(
    (p) =>
      p.name.toLowerCase() === selectedName.toLowerCase() ||
      p.title.toLowerCase() === selectedName.toLowerCase(),
  );
  if (suggested && selected && suggested.name === selected.name) {
    return PASSES;
  }

  // Preflight is an assist, not a gate: if no valid alternative playbook was found on the
  // available list, let the question through.
  if (!suggested) return PASSES;

  return {
    plausible: false,
    reason: reason || undefined,
    suggestedPlaybookName: suggested.name,
    suggestedPlaybookTitle: suggested.title,
  };
}

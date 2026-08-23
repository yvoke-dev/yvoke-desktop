import fs from 'node:fs';
import { AbortError, query, type CanUseTool, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpPromptInfo, PlaybookValidation } from '../../shared/types';
import { log, logError } from '../log';
import { claudeBinaryPath, debugEnv } from './AgentService';
import {
  buildValidatorSystemPrompt,
  parseValidation,
  PASSES,
  VALIDATION_TIMEOUT_MS,
} from './playbookValidation';

/**
 * The preflight check the web runs server-side in `PlaybookValidationController`, run locally
 * instead — this client's agent loop is the Claude Agent SDK, and the server is only ever asked
 * for MCP tools and the sync API, so a round trip to the web app's own LLM would be the odd one
 * out (and would need the `/chat/**` session endpoints the desktop does not speak).
 *
 * One user turn, no tools at all, no MCP, no thinking: the model is handed the playbook list and
 * the question and asked which playbook fits. That is the cheapest shape of whichever model the
 * conversation is already on — the same model the web's validator picks.
 *
 * The reply is plain text that `parseValidation` digs the JSON out of, rather than the SDK's
 * schema-enforced `outputFormat`. Schema mode injects a `StructuredOutput` tool, which costs an
 * extra turn and multiplies the prompt tokens; for a three-field verdict that a bad parse simply
 * waves through, tolerant parsing is the better trade.
 */

/**
 * `tools: []` already leaves the model nothing to call — this is the second lock. `allowedTools`
 * deliberately is NOT that lock: it only auto-approves, it does not restrict the tool set.
 */
const DENY_ALL_TOOLS: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `The tool "${toolName}" is not available for this check — answer from the playbook list alone.`,
});

export interface ValidatePlaybookOptions {
  question: string;
  /** The playbook the user attached to the message. */
  selected: McpPromptInfo;
  /** Every playbook the user could have picked instead — the selected one included. */
  playbooks: McpPromptInfo[];
  model: string;
  sandboxDir: string;
}

/**
 * Ask whether `selected` is the right playbook for `question`.
 *
 * Never rejects: every failure — transport, rate limit, timeout, unparseable reply — resolves to
 * "the selection is fine", because a check that cannot run must not hold a question back. That is
 * the web's fallback too (its controller catches everything and returns `plausible: true`).
 */
export async function validatePlaybookSelection(
  opts: ValidatePlaybookOptions,
): Promise<PlaybookValidation> {
  const startedAt = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), VALIDATION_TIMEOUT_MS);
  const binary = claudeBinaryPath();

  const options: Options = {
    // A bare string replaces the Claude Code preset outright, which is what a classifier wants.
    systemPrompt: buildValidatorSystemPrompt(opts.playbooks, opts.selected.name),
    // The actual no-tool lever: `[]` disables every built-in tool.
    tools: [],
    disallowedTools: ['Bash'],
    canUseTool: DENY_ALL_TOOLS,
    // No MCP from anywhere — not from here, not from a stray .mcp.json or user setting.
    mcpServers: {},
    strictMcpConfig: true,
    // No ~/.claude, no project settings, no CLAUDE.md.
    settingSources: [],
    // A throwaway classification has no business leaving a session on disk.
    persistSession: false,
    includePartialMessages: false,
    thinking: { type: 'disabled' },
    effort: 'low',
    // Exactly one assistant turn, which is safe only because there is nothing to call.
    maxTurns: 1,
    // The SDK has no timeout option; this controller is the only lever.
    abortController,
    model: opts.model,
    cwd: opts.sandboxDir,
    env: debugEnv(),
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
  };

  // The SDK spawns the CLI with `cwd` set to this directory, and a missing one is an ENOENT the
  // SDK reports as "native binary … failed to launch". AgentService creates it too, but only when
  // the first turn starts — which on a fresh profile is *after* this check, so without this the
  // very first playbook-carrying message (the one most likely to have picked the wrong playbook)
  // was silently never checked.
  try {
    fs.mkdirSync(opts.sandboxDir, { recursive: true });
  } catch {
    /* the spawn then fails and the check fails open below, which is the contract anyway */
  }

  // A string prompt (rather than the streaming iterable AgentService uses) is what puts the SDK
  // in single-turn mode: it closes the subprocess's stdin as soon as the first result lands.
  const q = query({ prompt: opts.question, options });
  try {
    const raw = await readReply(q);
    const verdict = parseValidation(raw, opts.playbooks, opts.selected.name);
    log(
      'agent',
      `playbook check "${opts.selected.name}" (${opts.model}) → ` +
        (verdict.plausible
          ? 'fits'
          : `suggests ${verdict.suggestedPlaybookName ?? 'no alternative'}`) +
        ` in ${Date.now() - startedAt}ms`,
    );
    return verdict;
  } catch (err) {
    const why =
      err instanceof AbortError
        ? `no verdict within ${VALIDATION_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    logError(
      'agent',
      `playbook check for "${opts.selected.name}" failed after ${Date.now() - startedAt}ms — ` +
        `sending as selected: ${why}`,
    );
    return PASSES;
  } finally {
    clearTimeout(timer);
    // Idempotent, and the only thing that reaps the CLI subprocess on the abort path.
    try {
      q.close();
    } catch {
      /* already torn down */
    }
  }
}

/**
 * The model's reply text.
 *
 * Stops at the result message rather than draining the iterator: on a non-success result the SDK
 * re-raises the failure as an exception *after* yielding it, so a full drain turns an ordinary
 * "max turns" outcome into a thrown error. Leaving the loop early runs the generator's own
 * teardown and lets the subtype be read as data.
 */
async function readReply(q: Query): Promise<string> {
  for await (const message of q) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      throw new Error(message.errors.join('; ') || message.subtype);
    }
    return message.result ?? '';
  }
  throw new Error('the check ended without a result');
}

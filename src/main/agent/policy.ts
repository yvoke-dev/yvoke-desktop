import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_KB_TOOLS, MCP_SERVER_NAME, MCP_TOOL_PREFIX, qualifyTool } from '../../shared/types';
import { COMPUTE_TOOLS, COMPUTE_TOOL_PREFIX } from './computeTools';


/**
 * Reduce one configured allow-list entry to a bare hostname: `https://Docs.Example.com:8443/x` and
 * `*.example.com` and `.example.com.` all become `example.com`. Returns '' for anything that has no
 * hostname left, which callers must treat as "matches nothing" rather than "matches everything".
 *
 * Both web paths run through this, deliberately. `isUrlDomainAllowed` needs it to compare against a
 * parsed URL's hostname, and the WebSearch allow-list the API receives needs it because that API
 * takes bare domains — a raw `https://example.com/docs` or `*.example.com` copied out of a browser
 * would be passed through as-is and silently match nothing. One normaliser keeps the two consistent.
 */
export function normalizeDomain(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/^\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    // A fully-qualified hostname may carry a root-label dot (`example.com.`); it names the same host.
    .replace(/\.$/, '');
}

/** The configured entries as bare hostnames, with everything that normalised away dropped. */
export function normalizeDomains(allowedDomains: string[]): string[] {
  return allowedDomains.map(normalizeDomain).filter(Boolean);
}

/**
 * Test whether a URL belongs to one of the allowed domains.
 * Matches exact hostname or subdomains of allowed domains (e.g. `docs.example.com` matches `example.com`).
 * Rejects non-HTTP(S) protocols and malformed URLs.
 */
export function isUrlDomainAllowed(rawUrl: unknown, allowedDomains: string[]): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return false;
  }
  const clean = normalizeDomains(allowedDomains);
  if (clean.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    // Same root-label normalisation as the allow-list side: `https://example.com./x` parses to the
    // hostname `example.com.`, which would otherwise fail an exact match against `example.com`.
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!hostname) return false;
    return clean.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/**
 * Tools that must never reach the SDK's `allowedTools`, however they were granted.
 *
 * `allowedTools` is an AUTO-APPROVAL list, not an availability list: the runtime grants anything on
 * it without raising a permission request, and `canUseTool` is only consulted on the ask path. So a
 * tool whose entire enforcement lives inside `canUseTool` is disarmed by being pre-approved — the
 * callback simply never runs for it. That is not a theory; it is the mechanism behind the
 * `ask_clarifying_question` defect: a playbook that
 * named the tool pre-approved it, and the interception that turns the question into a UI prompt was
 * skipped, so the assistant asked and nobody was ever asked. `buildAutoApproveTools` now keeps it
 * off that list too, which is what fixes it.
 *
 * Web access is the same shape. The domain allow-list is applied in `canUseTool` — injected into
 * WebSearch, checked against the URL for WebFetch — so pre-approving either would leave the model
 * free to reach the open web while README and spec claim the opposite.
 *
 * Withholding auto-approval does NOT withhold the tool: it still reaches the model, and the
 * permission request it now raises is answered by `buildCanUseTool` with the same grant list.
 */
const NEVER_AUTO_APPROVE = ['WebSearch', 'WebFetch'];

/** Suffix match, because MCP tools arrive fully qualified (`mcp__yvoke__ask_clarifying_question`). */
const NEVER_AUTO_APPROVE_SUFFIXES = ['ask_clarifying_question'];

/**
 * The SDK's `allowedTools`: the grant from `buildAllowedTools` minus everything whose enforcement
 * or interception lives in `canUseTool`. Pass the FULL grant to `buildCanUseTool` — that is the
 * list the playbook gate compares against — and this reduced one to the SDK.
 *
 * Note the direction of failure if the SDK ever changes: a tool kept off this list that the runtime
 * then refuses outright shows up as web search not working, loudly. The opposite mistake — putting
 * it back on — shows up as nothing at all, which is why it is worth a named function and a test.
 */
export function buildAutoApproveTools(granted: string[]): string[] {
  return granted.filter(
    (tool) =>
      !NEVER_AUTO_APPROVE.includes(tool) &&
      !NEVER_AUTO_APPROVE_SUFFIXES.some((suffix) => tool.endsWith(suffix)),
  );
}

/** Tools granted to the agent; everything else is denied by canUseTool. */
export function buildAllowedTools(
  settings: AppSettings,
  playbookTools?: string[],
  codeExecution?: boolean
): string[] {
  // If the playbook defines allowed tools, we ONLY allow those tools!
  // If not, we allow the standard knowledge-base tools.
  const tools = playbookTools !== undefined
    ? playbookTools.map(qualifyTool)
    : DEFAULT_KB_TOOLS.map(qualifyTool);

  const allowed = [...tools];

  // We only allow ToolSearch by default
  allowed.push('ToolSearch');

  // Safe in-process compute tools (calculate/statistics/date_diff) replace the general Bash
  // tool: they run purely in-memory with no shell, filesystem, or network access. Bash is
  // never allow-listed (and is hard-blocked via disallowedTools in AgentService) so that
  // prompt-injected corpus content can never reach a shell.
  //
  // Gated on the playbook's `codeExecution` flag: replacing Bash with safe tools changed HOW a
  // playbook computes, not WHETHER it may. These went in unconditionally, which silently granted
  // computation to every playbook that had declared codeExecution:false.
  if (codeExecution !== false) {
    allowed.push(...COMPUTE_TOOLS);
  }

  if (settings.webSearch.enabled) {
    allowed.push('WebSearch', 'WebFetch');
  }
  return [...new Set(allowed)];
}

export function isToolAllowed(
  toolName: string,
  settings: AppSettings,
  codeExecution?: boolean,
  delegation?: boolean
): boolean {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    return true;
  }
  // Safe in-process compute tools — no shell/fs/network, but still only for playbooks that
  // declare code execution. Gated in both places on purpose: an entry on the SDK's auto-approval
  // list never reaches this callback at all, so whichever of the two you leave open is the one that
  // waves them through for a codeExecution:false playbook.
  if (toolName.startsWith(COMPUTE_TOOL_PREFIX)) {
    return codeExecution !== false;
  }
  // ToolSearch is harness-internal, read-only: the runtime loads MCP tool schemas on demand
  // through it (verified in the Wave-0 spike) — denying it would break tool discovery.
  // Bash is intentionally NOT here: code execution is unavailable, so it falls through to deny.
  if (toolName === 'ToolSearch') {
    return true;
  }
  // Sub-agent delegation, and ONLY in orchestrator mode. The allow-list uses 'Task'; the in-stream
  // tool_use name is 'Agent' (see orchestration.ts), so both spellings are checked. In single-agent
  // chat nothing declares delegation, the SDK still offers Task, and a sub-agent's tool calls are not
  // forwarded (forwardSubagentText is set for orchestrator runs only) — so a delegated answer would
  // reach the UI with an empty tool trace, its retrieval invisible to the citation panel.
  if (toolName === 'Task' || toolName === 'Agent') {
    return delegation === true;
  }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') {
    return settings.webSearch.enabled;
  }
  return false;
}

/**
 * Default-deny permission policy (Correctness Property 1): only the knowledge-base MCP tools
 * (and WebSearch / WebFetch, when enabled) may run. WebSearch calls get the configured domain
 * allowlist injected and WebFetch calls are strictly checked against it so restrictions are
 * enforced, not merely requested.
 *
 * This only holds while the web tools stay off the SDK's auto-approval list — see
 * `buildAutoApproveTools`. Pre-approve them and none of the below runs.
 */
export function buildCanUseTool(
  getSettings: () => AppSettings,
  threadId?: string,
  onClarifyingQuestion?: (toolUseId: string, question: string, options: string[]) => Promise<string>,
  allowedTools?: string[],
  codeExecution?: boolean,
  delegation?: boolean
): CanUseTool {
  /**
   * Every `allow` carries `updatedInput`, even where nothing is rewritten.
   *
   * The SDK's TypeScript type marks the field optional, but the CLI validates this reply against a
   * zod union whose `allow` branch requires it — a bare `{ behavior: 'allow' }` is rejected as
   * malformed and the call fails with a ZodError instead of running. That is not hypothetical: it
   * is why WebFetch never worked between 1.1.4 and this fix, while WebSearch did, purely because
   * WebSearch happens to pass `updatedInput` for the domain injection. Passing `input` back
   * unchanged is the no-op form of the same reply.
   */
  return async (toolName, input, options) => {
    const settings = getSettings();
    if (!isToolAllowed(toolName, settings, codeExecution, delegation)) {
      return {
        behavior: 'deny',
        message: `The tool "${toolName}" is not available in this application. Use the ${MCP_SERVER_NAME} knowledge-base tools instead.`,
      };
    }
    const isClarify = toolName.endsWith('ask_clarifying_question');
    const toolUseId = options?.toolUseID || (options as any)?.toolUseId;
    if (isClarify && onClarifyingQuestion && toolUseId) {
      const question = String(input.question || '');
      const opts = Array.isArray(input.options) ? input.options.map(String) : [];
      const answer = await onClarifyingQuestion(toolUseId, question, opts);
      return {
        behavior: 'deny',
        message: `User answered: ${answer}`,
      };
    }

    // Delegation bypasses the exact-match gating below because the allow-list token 'Task' differs
    // from the in-stream tool name 'Agent'. isToolAllowed has already refused it outside orchestrator
    // mode, so reaching here means delegation is part of the configured design.
    if (toolName === 'Task' || toolName === 'Agent') {
      return { behavior: 'allow', updatedInput: input };
    }

    // Playbook-specific tools gating
    if (allowedTools && !allowedTools.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `The tool "${toolName}" is not allowed for the selected playbook.`,
      };
    }

    if (toolName === 'WebSearch' || toolName === 'WebFetch') {
      // Never run unrestricted web access: if the feature is on but no usable domain survives
      // normalisation, refuse rather than let the model reach the open web (exfil channel, and for
      // WebFetch an SSRF one). Checked on the NORMALISED list, not the raw one: entries that are
      // pure punctuation would otherwise count as configuration and hand WebSearch an empty
      // `allowed_domains`, which the API reads as "no restriction".
      const domains = normalizeDomains(settings.webSearch.allowedDomains);
      if (domains.length === 0) {
        return {
          behavior: 'deny',
          message: `Web search is enabled but no allowed domains are configured; refusing an unrestricted ${toolName === 'WebSearch' ? 'search' : 'fetch'}.`,
        };
      }

      if (toolName === 'WebSearch') {
        return { behavior: 'allow', updatedInput: { ...input, allowed_domains: domains } };
      }

      const url = (input as Record<string, unknown>)?.url;
      if (!isUrlDomainAllowed(url, domains)) {
        return {
          behavior: 'deny',
          message: `WebFetch is restricted to configured domains (${domains.join(', ')}). The URL "${String(url ?? '')}" is not permitted.`,
        };
      }
      return { behavior: 'allow', updatedInput: input };
    }

    return { behavior: 'allow', updatedInput: input };
  };
}

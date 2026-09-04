import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings } from '../../shared/types';
import { builtinTool, DEFAULT_KB_TOOLS, MCP_SERVER_NAME, MCP_TOOL_PREFIX, qualifyTool } from '../../shared/types';
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
 * One allow-list entry split into the host it names and, when it carries one, the path prefix that
 * narrows it: `www.example.com/community/` becomes `{ host: 'www.example.com', path: '/community/' }`.
 *
 * The reason this exists is a host that serves two very different things. The One Identity community
 * forum lives on the same host as that company's marketing site, so a host-only entry has to grant
 * both or neither. A path prefix lets the entry mean what it says.
 *
 * **It constrains fetching, not searching.** The WebSearch API's `allowed_domains` takes bare
 * domains and cannot express a path, so a search still sees the whole host — see
 * `buildCanUseTool`, which injects `hostsOf` for exactly that reason. Narrowing what may be
 * *retrieved in full* is still worth having, and it is the half an allow-list can actually enforce.
 */
export interface AllowEntry {
  host: string;
  /** Lower-cased, leading-slash path prefix; '' when the entry names the whole host. */
  path: string;
}

export function parseAllowEntry(entry: string): AllowEntry | undefined {
  const host = normalizeDomain(entry);
  if (!host) return undefined;
  // Take the path from the entry as written, after stripping scheme and any wildcard/leading dot,
  // so the slash that separates host from path is the first one left.
  const withoutScheme = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
  const slash = withoutScheme.indexOf('/');
  const raw = slash === -1 ? '' : withoutScheme.slice(slash);
  // A bare '/' narrows nothing; treat it as the whole host rather than a prefix every path matches.
  const path = raw === '/' ? '' : raw;
  return { host, path };
}

/** The configured entries parsed, with everything that normalised away dropped. */
export function parseAllowEntries(allowedDomains: string[]): AllowEntry[] {
  return allowedDomains
    .map(parseAllowEntry)
    .filter((e): e is AllowEntry => e !== undefined);
}

/** Just the hosts, for the WebSearch API — which cannot take a path. */
export function hostsOf(entries: AllowEntry[]): string[] {
  return [...new Set(entries.map((e) => e.host))];
}

/**
 * Hosts that answer a non-browser client with an empty HTTP 202 and `x-amzn-waf-action: challenge`,
 * so WebFetch returns a page with no content rather than an error.
 *
 * That failure is silent, which is what makes it worth a rule: the model is handed an empty
 * document, not a refusal, and the tempting next move is to fill the gap from memory while
 * attributing it to a URL it never read. Denying the call with a message that says what to do
 * instead turns a silent nothing into an instruction.
 *
 * Matched on the exact host, never by suffix: `docs.oneidentity.com` on the same registrable domain
 * serves 200 and is perfectly fetchable.
 */
const WAF_CHALLENGED_HOSTS = ['support.oneidentity.com', 'www.oneidentity.com', 'oneidentity.com'];

/** The same rule against a bare hostname, for judging allow-list entries rather than URLs. */
function isWafChallengedHostname(hostname: string): boolean {
  return WAF_CHALLENGED_HOSTS.includes(hostname);
}

export function isWafChallengedHost(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false;
  try {
    const host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/\.$/, '');
    return isWafChallengedHostname(host);
  } catch {
    return false;
  }
}

/**
 * What this configuration actually buys, described once at startup for the log.
 *
 * Worth emitting because the two lists it compares are maintained independently and can drift into
 * a combination that is silently useless: `WAF_CHALLENGED_HOSTS` denies a fetch BEFORE the
 * allow-list is consulted, so an allow-list whose entries all name challenged hosts grants WebFetch
 * nothing at all. Nothing surfaces that at runtime — every call simply denies, one wasted turn at a
 * time — so it is named here instead, where an operator reading the log can see it.
 *
 * Only an entry's OWN host is judged. A challenged entry still permits its subdomains and those may
 * be perfectly fetchable (`docs.oneidentity.com` under `oneidentity.com` is), which is why the
 * empty case reads "no entry names a fetchable host" rather than "WebFetch cannot work".
 */
export function webAccessDiagnostics(settings: AppSettings): string[] {
  if (!settings.webSearch.enabled) return ['web access is off'];
  const entries = parseAllowEntries(settings.webSearch.allowedDomains);
  if (entries.length === 0) {
    return ['web access is ON but no allowed domain survives parsing, so every search and fetch is refused'];
  }
  const show = (list: AllowEntry[]): string => list.map((e) => `${e.host}${e.path}`).join(', ');
  const challenged = entries.filter((e) => isWafChallengedHostname(e.host));
  const fetchable = entries.filter((e) => !isWafChallengedHostname(e.host));
  const lines = [`web access is ON — WebSearch domains: ${hostsOf(entries).join(', ')}`];
  if (challenged.length > 0) {
    lines.push(`WebFetch refuses these bot-challenged hosts outright: ${show(challenged)}`);
  }
  lines.push(
    fetchable.length > 0
      ? `WebFetch may reach: ${show(fetchable)}`
      : 'no configured entry names a fetchable host, so WebFetch denies every URL except one on a ' +
        'subdomain of the entries above — grant playbooks WebSearch rather than WebFetch here',
  );
  return lines;
}

/**
 * Whether a URL's path falls inside a path-scoped entry's subtree.
 *
 * Compared on segment boundaries rather than as raw text. A bare `startsWith` let
 * `example.com/community` permit `/community-blog/secret` and `/communityXYZ` — the opposite of
 * what an operator adding a path is asking for, and invisible unless they happened to write the
 * trailing slash. Normalising that slash away makes both spellings of an entry mean the same thing,
 * and neither reaches a sibling whose name merely begins the same way.
 *
 * `URL` does NOT percent-decode `pathname`, so `/%63ommunity/x` fails to match `/community/`. That
 * is the fail-closed direction and is left as is. The case-insensitivity comes from both sides
 * being lower-cased, not from any decoding, and a query string never reaches here at all.
 */
function isPathInScope(urlPath: string, entryPath: string): boolean {
  if (entryPath === '') return true;
  const base = entryPath.replace(/\/+$/, '');
  // An entry of '/' or '//' narrows nothing; `parseAllowEntry` already folds the first away.
  if (base === '') return true;
  return urlPath === base || urlPath.startsWith(`${base}/`);
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
  const entries = parseAllowEntries(allowedDomains);
  if (entries.length === 0) {
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
    const urlPath = parsed.pathname.toLowerCase();
    return entries.some(
      (entry) =>
        (hostname === entry.host || hostname.endsWith(`.${entry.host}`)) &&
        isPathInScope(urlPath, entry.path),
    );
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
  // Web tools are stripped here and re-added below under the settings gate, so a declaration alone
  // can never grant them.
  const tools = playbookTools !== undefined
    ? playbookTools.filter((tool) => !isWebTool(tool)).map(qualifyTool)
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

  // Web access is granted per playbook, and only for the tools the playbook actually names. The
  // settings toggle is a deployment-wide ceiling, not the grant itself: it used to be both, which
  // meant enabling it handed the open-ish web to every playbook and every specialist at once —
  // fourteen of them in the OIM profile — with no way to give it to one.
  if (settings.webSearch.enabled) {
    for (const tool of WEB_TOOLS) {
      if (webToolDeclared(tool, playbookTools)) allowed.push(tool);
    }
  }
  return [...new Set(allowed)];
}

const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

/**
 * Whether a declared tool name is one of the web tools, however it was spelled.
 *
 * Needed because the declared list is mapped through `qualifyTool`, which now passes built-ins
 * through unchanged — so a declared `WebSearch` would land in the allow-list directly, ahead of
 * and independent of the settings gate below. That is the same silent grant this change exists to
 * remove, arriving by the other door: caught by the test that asserts the toggle still wins.
 */
export function isWebTool(tool: string): boolean {
  return WEB_TOOLS.some((known) => known === builtinTool(tool));
}

/**
 * Whether this run may use `tool`.
 *
 * A playbook must name it — declaring `WebSearch` alone therefore yields search without fetch,
 * which is the useful shape for a source whose pages cannot be fetched at all.
 *
 * With NO playbook selected there is nothing to read a declaration from, so the operator's setting
 * is the only signal available and it governs. That keeps plain chat behaving as the setting and
 * the README describe, while the per-playbook rule does its work where the fan-out risk actually
 * is: the specialists.
 */
export function webToolDeclared(tool: string, playbookTools?: string[]): boolean {
  if (playbookTools === undefined) return true;
  return playbookTools.some((declared) => builtinTool(declared) === tool);
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
      // parsing, refuse rather than let the model reach the open web (exfil channel, and for
      // WebFetch an SSRF one). Checked on the PARSED list, not the raw one: entries that are
      // pure punctuation would otherwise count as configuration and hand WebSearch an empty
      // `allowed_domains`, which the API reads as "no restriction".
      const entries = parseAllowEntries(settings.webSearch.allowedDomains);
      if (entries.length === 0) {
        return {
          behavior: 'deny',
          message: `Web search is enabled but no allowed domains are configured; refusing an unrestricted ${toolName === 'WebSearch' ? 'search' : 'fetch'}.`,
        };
      }

      if (toolName === 'WebSearch') {
        // Bare hosts, because the API takes domains and has no way to express a path prefix. A
        // path-scoped entry therefore narrows what may be FETCHED, not what may be found.
        return { behavior: 'allow', updatedInput: { ...input, allowed_domains: hostsOf(entries) } };
      }

      const url = (input as Record<string, unknown>)?.url;

      // Checked before the allow-list, so the message the model gets is the one it can act on: a
      // permitted-but-unreadable host would otherwise be allowed and hand back an empty page.
      if (isWafChallengedHost(url)) {
        return {
          behavior: 'deny',
          message:
            `This host answers automated clients with a bot challenge and an empty page, so ` +
            `fetching "${String(url ?? '')}" would return no content. Use WebSearch for this ` +
            `source instead, cite the URL the search result gave you, and describe what the ` +
            `search result indicates — do not state or imply that you read the page.`,
        };
      }

      if (!isUrlDomainAllowed(url, settings.webSearch.allowedDomains)) {
        const shown = entries.map((e) => `${e.host}${e.path}`).join(', ');
        return {
          behavior: 'deny',
          message: `WebFetch is restricted to configured domains (${shown}). The URL "${String(url ?? '')}" is not permitted.`,
        };
      }
      return { behavior: 'allow', updatedInput: input };
    }

    return { behavior: 'allow', updatedInput: input };
  };
}

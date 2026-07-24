import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_KB_TOOLS, MCP_SERVER_NAME, MCP_TOOL_PREFIX, qualifyTool } from '../../shared/types';
import { COMPUTE_TOOLS, COMPUTE_TOOL_PREFIX } from './computeTools';


/** Tools pre-approved for the agent; everything else is denied by canUseTool. */
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
    allowed.push('WebSearch');
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
  // declare code execution. An allow-list entry is auto-approved before this callback runs, so
  // leaving this ungated would have waved them through for a codeExecution:false playbook.
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
  if (toolName === 'WebSearch') {
    return settings.webSearch.enabled;
  }
  return false;
}

/**
 * Default-deny permission policy (Correctness Property 1): only the knowledge-base MCP tools
 * (and WebSearch, when enabled) may run. WebSearch calls get the configured domain
 * allowlist injected so the restriction is enforced, not merely requested.
 */
export function buildCanUseTool(
  getSettings: () => AppSettings,
  threadId?: string,
  onClarifyingQuestion?: (toolUseId: string, question: string, options: string[]) => Promise<string>,
  allowedTools?: string[],
  codeExecution?: boolean,
  delegation?: boolean
): CanUseTool {
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
      return { behavior: 'allow' };
    }

    // Playbook-specific tools gating
    if (allowedTools && !allowedTools.includes(toolName)) {
      return {
        behavior: 'deny',
        message: `The tool "${toolName}" is not allowed for the selected playbook.`,
      };
    }

    if (toolName === 'WebSearch') {
      // Never run an unrestricted web search: if the feature is on but no domains are
      // configured, refuse rather than let the model search the open web (exfil channel).
      if (settings.webSearch.allowedDomains.length === 0) {
        return {
          behavior: 'deny',
          message: 'Web search is enabled but no allowed domains are configured; refusing an unrestricted search.',
        };
      }
      return {
        behavior: 'allow',
        updatedInput: { ...input, allowed_domains: settings.webSearch.allowedDomains },
      };
    }
    return { behavior: 'allow' };
  };
}

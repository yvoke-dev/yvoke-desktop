/**
 * Contracts shared between the main process and the renderer (via the preload bridge).
 * Keep this file free of Node/Electron imports — it is compiled into both worlds.
 */

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface AppSettings {
  /** Base URL of the Spring server; /mcp and /api/chat/v1 are derived from it. */
  serverBaseUrl: string;
  mcpTransport: 'sse' | 'http';
  /** 'dev' sends a static token (APP_SECURITY_MOCK accepts any); 'entra' uses MSAL PKCE. */
  serverAuthMode: 'dev' | 'entra';
  entra: {
    tenantId: string;
    clientId: string;
    scope: string;
  };
  models: string[];
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
  webSearch: {
    enabled: boolean;
    allowedDomains: string[];
  };
  maxTurns: number;
  /** Multi-agent orchestrator mode: role → Claude model binding + budgets. Optional (Off if absent). */
  orchestrator?: OrchestratorSettings;
}

/** Claude model + thinking level bound to one orchestrator role. */
export interface RoleModelConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Desktop-side config for orchestrator mode. The server profile supplies the *structure* (which
 * playbooks); this supplies the *Claude model binding* per role plus budgets (the server profiles'
 * Gemini models are irrelevant to the local Agent SDK run).
 */
export interface OrchestratorSettings {
  orchestrator: RoleModelConfig;
  reviewer: RoleModelConfig;
  specialist: RoleModelConfig;
  /**
   * How many revision rounds the runtime drives after a non-approving verdict (as on the web:
   * revisions, not total reviews — 0 means review once and never revise). Also stated in the
   * orchestrator prompt so the model knows its budget.
   */
  maxReviewRounds: number;
  maxSpecialistCalls: number;
  /**
   * Code-enforced review. When true (the default): a turn that delegated to specialists but never
   * called the reviewer is re-prompted once to run one, and a rejected/unclear verdict is handed
   * back for revision up to `maxReviewRounds` before the answer ships flagged. Set false to leave
   * review entirely to the orchestrator playbook.
   */
  requireReview?: boolean;
  /** Hard backstops on agentic turns. */
  orchestratorMaxTurns: number;
  specialistMaxTurns: number;
}

/**
 * Fallback orchestrator config, shared by the main-process defaults and the settings UI so a
 * settings.json without an `orchestrator` block still renders (and saves) a complete form.
 */
export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  orchestrator: { model: 'opus', thinkingLevel: 'high' },
  reviewer: { model: 'opus', thinkingLevel: 'high' },
  specialist: { model: 'sonnet', thinkingLevel: 'medium' },
  maxReviewRounds: 2,
  maxSpecialistCalls: 8,
  requireReview: true,
  orchestratorMaxTurns: 60,
  specialistMaxTurns: 20,
};

/** A multi-agent profile (knowledge base) as returned by GET /api/chat/v1/orchestrator/profiles. */
export interface OrchestratorProfile {
  name: string;
  orchestratorPlaybook: string;
  reviewerPlaybook: string;
  specialistPlaybooks: string[];
}

/** One agent invocation in a completed run, reported to the server for the admin trace viewer. */
export interface OrchestratorRunStep {
  seq: number;
  role: 'orchestrator' | 'specialist' | 'reviewer';
  round: number;
  playbookName?: string;
  model?: string;
  thinkingLevel?: string;
  input?: string;
  output?: string;
  /** Free-form JSONB payload — the agent's own (sub-)transcript. */
  messages?: unknown;
  verdict?: { approved: boolean; feedback?: string };
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  thoughtTokens?: number;
}

/** A completed local multi-agent run, POSTed to /api/chat/v1/orchestrator/runs for DB persistence. */
export interface OrchestratorRunPayload {
  conversationId: string;
  /** Assistant message server id; filled once the message sync acks (links agent_runs → messages). */
  messageId?: string;
  profileName: string;
  status: string;
  config?: unknown;
  /** Revision rounds (web convention): a first-pass approval is 0, one rejection + redo is 1. */
  reviewRounds: number;
  finalVerdict?: { approved: boolean; feedback?: string } | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  thoughtTokens?: number;
  error?: string | null;
  steps: OrchestratorRunStep[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thoughtTokens?: number;
}

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thoughtTokens: 0,
};

export type SyncState = 'synced' | 'pending' | 'error';

export interface ThreadMeta {
  /** Server conversation id (UUID); generated server-side at creation. */
  id: string;
  /** Agent SDK session id — local only, used for model-context resume. */
  sessionId?: string;
  title: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  createdAt: string;
  updatedAt: string;
  totals: UsageTotals;
  syncState: SyncState;
  /** Selected multi-agent profile name; undefined/'' = Off (normal single-agent chat). */
  orchestratorProfile?: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  /** For the Agent (delegation) tool: the specialist/reviewer this call was dispatched to. */
  subagentType?: string;
  /** Reviewer verdict parsed from an Agent→reviewer call's result (approved/feedback). */
  verdict?: { approved: boolean; feedback?: string };
  /** For an Agent call: the sub-agent's own (forwarded) transcript, for a nested/collapsed view. */
  subagentBlocks?: MessageBlock[];
}

/**
 * Outcome of the reviewer pass for one orchestrated turn.
 *   approved / rejected — the reviewer ran and returned a parseable verdict
 *   unclear             — the reviewer ran but its verdict could not be parsed (or it errored)
 *   skipped             — no reviewer delegation happened at all
 */
export type ReviewOutcome = 'approved' | 'rejected' | 'unclear' | 'skipped';

export interface ReviewStatus {
  outcome: ReviewOutcome;
  feedback?: string;
  /** True when the runtime had to re-prompt the orchestrator to run the reviewer. */
  enforced?: boolean;
}

/** One segment of an assistant turn — interleaved text, thinking, and/or tool calls. */
export interface MessageBlock {
  text?: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
}

export interface ChatMessage {
  /** Local id assigned by the app; serverId arrives once the sync queue is acked. */
  localId: string;
  serverId?: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  blocks?: MessageBlock[];
  /** Orchestrator mode only: whether this answer passed the reviewer. Absent = not orchestrated. */
  review?: ReviewStatus;
  /** Title of the MCP prompt/playbook injected with this (user) message, if any. */
  playbook?: string;
  usage?: UsageTotals;
  createdAt: string;
  feedback?: { rating: 1 | -1; comment?: string };
}

/** Reference to a citation source, parsed from a `[chunk_id=…]` / `[file=…]` marker. */
export interface CitationRef {
  chunkId?: string;
  file?: string;
  version?: string;
  documentId?: string;
}

export interface McpPromptInfo {
  name: string;
  title: string;
  description: string;
  /** Arguments the prompt accepts; empty for every playbook currently served. */
  arguments: { name: string; description?: string; required?: boolean }[];
  /** Allowed tools for this playbook (if any). */
  tools?: string[];
  /** Whether this playbook may compute (the safe mcp__compute__* tools). Undefined = not declared. */
  codeExecution?: boolean;
}

/** Events streamed from the main process to the renderer while a turn runs. */
export type AgentEvent =
  | { kind: 'turn-start'; threadId: string }
  | { kind: 'live-text'; threadId: string; text: string }
  | { kind: 'live-thinking'; threadId: string; text: string }
  | { kind: 'assistant-block'; threadId: string; text: string; thinking?: string; toolCalls: ToolCallInfo[] }
  | { kind: 'tool-result'; threadId: string; toolUseId: string; result: string; isError: boolean }
  | {
      kind: 'turn-complete';
      threadId: string;
      message: ChatMessage;
      usage: UsageTotals;
      costUsd?: number;
      durationMs: number;
      isError: boolean;
      errorMessage?: string;
      /** The turn ended because the user pressed Stop, not because of a failure. */
      aborted?: boolean;
    }
  | { kind: 'error'; threadId: string; message: string; authRequired?: boolean }
  | { kind: 'mcp-status'; threadId: string; servers: { name: string; status: string }[] }
  | { kind: 'clarifying-question'; threadId: string; toolUseId: string; question: string; options?: string[] }
  | { kind: 'subagent-start'; threadId: string; toolUseId: string; subagentType: string; question: string }
  | { kind: 'subagent-complete'; threadId: string; toolUseId: string; subagentType: string; result: string; isError: boolean }
  | { kind: 'review-verdict'; threadId: string; toolUseId: string; approved: boolean; feedback?: string }
  /**
   * The runtime held the turn back for another review pass and discarded the draft: either no
   * reviewer ran (`skipped`), or it ran and did not approve (`rejected` / `unclear`, with the
   * 1-based revision `round` the orchestrator is now on).
   */
  | { kind: 'review-enforced'; threadId: string; reason: 'skipped' | 'rejected' | 'unclear'; round?: number };

export type SyncEvent =
  | { kind: 'sync-state'; threadId: string; state: SyncState; pendingCount: number; detail?: string }
  | { kind: 'server-ids'; threadId: string; mapping: Record<string, string> };

export interface SendMessageRequest {
  threadId: string;
  text: string;
  /** Thinking override for exactly this message; thread default applies afterwards. */
  thinkingOverride?: ThinkingLevel;
  /** Name of an MCP prompt to inject ahead of `text` for this turn (prompts/get). */
  promptName?: string;
}

export interface FeedbackRequest {
  threadId: string;
  messageLocalId: string;
  rating: 1 | -1;
  comment?: string;
}

export interface AuthStatus {
  claude: 'unknown' | 'ok' | 'missing';
  /** Email of the signed-in Claude account, when Claude Code has recorded one. */
  claudeAccount?: string;
  server: { mode: 'dev' | 'entra'; signedIn: boolean; account?: string };
}

/**
 * Alias for the MCP connection, which becomes the `mcp__<name>__` prefix on every tool the SDK
 * exposes. It names the PRODUCT's MCP server, not a knowledge base: every knowledge base is served
 * by the same /mcp endpoint and selected by collection and playbook, so this is deliberately not
 * per-KB. Keep it a single token — the renderer strips the prefix with `mcp__[^_]+__`.
 */
export const MCP_SERVER_NAME = 'yvoke';

export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const QUALIFIED = /^mcp__[^_]+__/;

/**
 * Qualify a playbook-declared tool name with the current server prefix.
 *
 * Playbooks are stored server-side and may name tools bare (`search_corpus`) or already qualified
 * under whatever alias was current when they were written (`mcp__oim__search_corpus`). Re-namespace
 * rather than testing for the current prefix only: a stale prefix would otherwise fail that test,
 * get prefixed a second time into `mcp__yvoke__mcp__oim__search_corpus`, and be silently denied —
 * which is exactly what renaming this constant would have caused for every playbook in the database.
 */
export function qualifyTool(tool: string): string {
  return `${MCP_TOOL_PREFIX}${tool.replace(QUALIFIED, '')}`;
}

/**
 * Knowledge-base tools granted when a playbook declares none. Stored bare and qualified at use, so
 * the list cannot drift out of sync with the server prefix.
 *
 * Single source of truth for the single-agent allow-list (policy.ts) and specialist allow-lists
 * (orchestration.ts). Keeping two copies is exactly what went wrong: policy.ts's list had lost
 * `search_corpus` while orchestration.ts's kept it, so plain chat — every conversation with no
 * playbook selected — was denied the primary corpus-retrieval tool, while a specialist sub-agent
 * doing the same work was granted it.
 */
export const DEFAULT_KB_TOOLS = [
  'query_json_objects',
  'get_section',
  'get_graph_neighbors',
  'verify_citations',
  'list_documents',
  'get_toc',
  'search_graph_entities',
  'get_json_schema',
  'search_corpus',
];

// A hardcoded label map used to live here, keyed by four playbook names of one knowledge base
// (`oim-ask`, `oim-explain-table`, `oim-trace-data-flow`, `oim-browse-manual`). None of them exist
// on the server any more, so every lookup missed and fell through to the raw name — the map had
// been dead for some time, and the display name a playbook gets belongs to the playbook, not to a
// per-knowledge-base table compiled into the client. Callers now use `name` directly, which is what
// they were already receiving.
//
// Note this leaves the UI showing raw names like `oim-ts-directory-messaging-browsing`: the server
// currently returns `title` equal to `name` for all 31 playbooks, so there is nothing better to
// show. Giving playbooks a real `title` in their server-side metadata — alongside `tools` and
// `codeExecution` — is what would actually fix that, for every knowledge base at once.

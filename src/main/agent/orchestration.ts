import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings, McpPromptInfo, OrchestratorProfile, ThinkingLevel, ToolCallInfo } from '../../shared/types';
import { DEFAULT_KB_TOOLS, MCP_TOOL_PREFIX, qualifyTool } from '../../shared/types';
import { COMPUTE_TOOLS } from './computeTools';
import type { McpPrompts } from './McpPrompts';


/**
 * The token that ENABLES delegation in `allowedTools` is `'Task'`, but the model emits the delegation
 * as a `tool_use` block whose `name` is `'Agent'` (confirmed by scripts/spike-mas.ts). Both are kept
 * so the permission layer and the translate layer agree.
 */
export const DELEGATE_ALLOW_TOKEN = 'Task';
export const DELEGATE_TOOL_NAME = 'Agent';
export const REVIEWER_SUBAGENT = 'reviewer';
export const ORCHESTRATOR_AGENT = 'orchestrator';

/** thinkingLevel → sub-agent reasoning effort (AgentDefinition has no thinking-budget field). */
function effortFor(level: ThinkingLevel): 'low' | 'medium' | 'high' {
  return level === 'high' ? 'high' : level === 'off' || level === 'low' ? 'low' : 'medium';
}

/** Map a playbook's declared tool names to the SDK's fully-qualified allow-list for a specialist. */
export function mapSpecialistTools(info: McpPromptInfo | undefined, settings: AppSettings): string[] {
  const declared = info?.tools;
  const tools =
    declared && declared.length > 0
      ? declared.map(qualifyTool)
      : DEFAULT_KB_TOOLS.map(qualifyTool);
  // Specialists get the safe compute tools instead of Bash, and only when their playbook declares
  // code execution — same rule as the single-agent path in policy.ts.
  const out = [...tools, 'ToolSearch'];
  if (info?.codeExecution !== false) out.push(...COMPUTE_TOOLS);
  if (settings.webSearch.enabled) out.push('WebSearch');
  return [...new Set(out)];
}

/** The reviewer is a validate-only agent: it may only re-read evidence, never search anew (as on web). */
const REVIEWER_TOOLS = [`${MCP_TOOL_PREFIX}verify_citations`, `${MCP_TOOL_PREFIX}get_section`];

function orchestratorAdapter(roster: string, maxReviewRounds: number, maxSpecialistCalls: number): string {
  return `

---
## Desktop runtime adapter (how your tools work here)

You have NO \`call_specialist\` tool. To consult a specialist, call the **Task** tool with
\`subagent_type\` set to the specialist's name and \`prompt\` set to a fully self-contained question
(include the version/tag and any entity names — the specialist cannot see this conversation). The Task
result is that specialist's grounded, cited answer. You may delegate to several specialists in
parallel. Aim for at most ${maxSpecialistCalls} specialist calls in total.

To have your composed answer validated, call the **Task** tool with \`subagent_type: "${REVIEWER_SUBAGENT}"\`
and a prompt containing all three of:
1. \`## Original question\` — the user's question.
2. \`## Candidate answer\` — your composed answer in full.
3. \`${EVIDENCE_HEADING}\` — each specialist's answer verbatim, citation markers
   (\`[chunk_id=…]\`, \`[document_id=…]\`, \`[N]\`) intact.

The reviewer cannot see this conversation and validates ONLY against what you paste under (3); a review
request without that section will be rejected for missing evidence.

If the reviewer replies \`REJECTED\`, the runtime hands the feedback (and the evidence) back to you for a
revision round — up to ${maxReviewRounds}. Fix the answer and re-review; do not argue with the reviewer.
Never add a "did not pass review" note yourself: the runtime appends one if the rounds run out.

Available specialists (\`subagent_type\` → coverage):
${roster}
`;
}

/**
 * Headings the SERVER orchestrator playbook keys its behaviour off — it has a
 * "Handling reviewer feedback (revision rounds)" section that triggers on the feedback heading, and
 * the web harness (OrchestrationService) renders the reviewer's task with the evidence heading.
 * The web injects both from code around each orchestrator turn; on desktop the orchestrator drives
 * its own reviewer calls, so the runtime injects them into the running turn instead. Keep these
 * strings byte-identical to the server's — they are the contract, not decoration.
 */
export const REVIEW_FEEDBACK_HEADING = '## Reviewer feedback to address (revise your previous answer)';
export const EVIDENCE_HEADING = '## Evidence gathered by the specialists (the ONLY basis for validation)';

/** Per-specialist cap when re-rendering evidence into a revision notice (keeps the re-prompt bounded). */
const MAX_EVIDENCE_CHARS = 12_000;

/**
 * Re-render the specialists' answers as the evidence block the reviewer must be given. The web
 * harness owns this section (it collects evidence as specialists run); here the same material is
 * recovered from the turn's completed delegations, so a revision round can hand the orchestrator
 * exactly what it must forward — the failure mode being fixed is a review request sent WITHOUT it.
 */
export function renderSpecialistEvidence(toolCalls: ToolCallInfo[]): string {
  const specialists = toolCalls.filter(
    (c) => c.name === DELEGATE_TOOL_NAME && c.subagentType !== REVIEWER_SUBAGENT && !c.isError && c.result?.trim(),
  );
  if (specialists.length === 0) return '(no specialist evidence was captured)';

  return specialists
    .map((c) => {
      const question = String((c.input as { prompt?: string; description?: string })?.prompt ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      const body = c.result!.trim();
      const text = body.length > MAX_EVIDENCE_CHARS ? `${body.slice(0, MAX_EVIDENCE_CHARS)}\n…[truncated]` : body;
      return `### Specialist \`${c.subagentType ?? '?'}\`${question ? ` — asked: ${question}` : ''}\n${text}`;
    })
    .join('\n\n');
}

/**
 * Injected by AgentService when the reviewer rejected the draft (or returned no clear verdict) and
 * revision rounds remain. Mirrors the web harness, which re-runs the orchestrator with the feedback
 * appended to the question under `REVIEW_FEEDBACK_HEADING`; the playbook's "revision rounds" section
 * keys off exactly that heading, so it fires here too.
 */
export function buildRevisionPrompt(params: {
  feedback?: string;
  toolCalls: ToolCallInfo[];
  round: number;
  maxRounds: number;
}): string {
  const { feedback, toolCalls, round, maxRounds } = params;
  return `⚠️ Runtime check: the reviewer did not approve your answer, so it was NOT delivered. This is revision round ${round} of ${maxRounds}.

${REVIEW_FEEDBACK_HEADING}
${feedback?.trim() || '(the reviewer returned no parseable verdict — treat the answer as unvalidated)'}

${EVIDENCE_HEADING}
${renderSpecialistEvidence(toolCalls)}

Now: re-call whichever specialists are needed to close the gaps (an unsupported claim, a missing or
document-level citation, a wrong version), correct the answer, and call the **Task** tool with
\`subagent_type: "${REVIEWER_SUBAGENT}"\` again — passing the user's original question, your corrected
answer in full, and the evidence section above VERBATIM under its heading. The reviewer sees only what
you paste. Do not argue with the reviewer — fix the answer.

Your previous draft has been discarded, so whatever you write after the review is exactly what the user
sees. Restate the corrected answer in full. Do not mention this notice.`;
}

/**
 * Appended in code when an answer ships without passing review (mirrors the web harness's flagNote).
 * The reviewer's own notes are NOT repeated here — the renderer's review badge already shows them —
 * but the warning has to live in the message content, which is what gets synced and copied.
 */
export function reviewFlagNote(attempts: number): string {
  return `\n\n---\n⚠️ *This answer did not pass automated review after ${attempts} attempt${attempts === 1 ? '' : 's'}. See the reviewer's notes.*`;
}

/**
 * Injected by AgentService when a turn consulted specialists but ended without a review pass.
 * The adapter above only *asks* for review; this is what makes it happen. Written as a runtime
 * notice rather than a user turn, because that is what it is — the user never sees it.
 */
export const REVIEW_ENFORCEMENT_PROMPT = `⚠️ Runtime check: you ended your turn without having the answer reviewed, which this deployment requires.

Call the **Task** tool now with \`subagent_type: "${REVIEWER_SUBAGENT}"\`, passing the user's original question, your candidate answer in full, and — under the heading \`${EVIDENCE_HEADING}\` — each specialist's answer verbatim (keep the \`[chunk_id=…]\` / \`[document_id=…]\` markers). The reviewer validates only against that section.

Then deliver the final answer:
- reviewer says \`APPROVED\` → restate the answer in full;
- reviewer says \`REJECTED\` → fix the claims it flagged, then give the corrected answer in full.

Your earlier draft has been discarded, so whatever you write now is exactly what the user sees. Do not mention this notice.`;

const REVIEWER_ADAPTER = `

---
## Desktop runtime adapter

There is no \`submit_review\` tool here. End your turn with your verdict as plain text: the FIRST line
must be exactly \`APPROVED\` or \`REJECTED\`, followed by concise, actionable feedback (name any
unsupported or fabricated claims the orchestrator must fix).`;

export interface ResolvedOrchestrator {
  agents: Record<string, AgentDefinition>;
  allowedTools: string[];
  /** Set of sub-agent names that are specialists (not the reviewer) — for trace labelling. */
  specialistNames: string[];
}

/**
 * Build the SDK `agents` map + `allowedTools` for orchestrator mode from a server profile. Fetches
 * each playbook's text (system prompt) and tool metadata; binds Claude models per role from settings.
 *
 * `baseSystemPrompt` is the server's `default-chat` system prompt. It carries the shared grounding &
 * citation contract (the numbered `[1]` / `## References` output format the renderer expects).
 * SPECIALISTS and the ORCHESTRATOR both run under it with their playbook layered on top: the
 * orchestrator writes the user-facing answer, so it needs that contract as much as they do.
 *
 * It previously did NOT — the orchestrator got its control playbook alone, making it the one agent
 * that never saw the format it was supposed to produce. That mirrored the web, where the same gap
 * produced answers full of raw `[chunk_id=<uuid>]` tokens; the web side has since been fixed too.
 *
 * The REVIEWER still runs on its playbook alone, deliberately: it emits a plain-text verdict rather
 * than prose, so answer-formatting rules are noise in its context.
 */
export async function buildOrchestrator(
  profile: OrchestratorProfile,
  settings: AppSettings,
  mcpPrompts: McpPrompts,
  baseSystemPrompt: string,
): Promise<ResolvedOrchestrator> {
  const cfg = settings.orchestrator;
  if (!cfg) {
    throw new Error('Orchestrator settings are not configured (settings.orchestrator is missing).');
  }

  const metadata = await mcpPrompts.list();
  const byName = new Map(metadata.map((p) => [p.name, p]));

  // Fetch every playbook's text in parallel.
  const names = [profile.orchestratorPlaybook, profile.reviewerPlaybook, ...profile.specialistPlaybooks];
  const textEntries = await Promise.all(
    names.map(async (name) => [name, await mcpPrompts.getText(name)] as const),
  );
  const textByName = new Map(textEntries);

  const specialistNames = profile.specialistPlaybooks;
  const roster = specialistNames
    .map((name) => {
      const info = byName.get(name);
      const desc = info?.description || info?.title || name;
      return `- \`${name}\` — ${desc}`;
    })
    .join('\n');

  const agents: Record<string, AgentDefinition> = {};

  // The orchestrator writes the user-facing answer, so it needs the base prompt's output contract
  // (numbered citations + ## References, mermaid/KaTeX delimiters) exactly as the specialists do.
  // It previously got the control playbook alone — the one agent that never saw the contract it was
  // expected to honour. Playbook last, so its role-specific rules win on any conflict.
  const orchestratorPlaybookText = textByName.get(profile.orchestratorPlaybook) ?? '';
  const orchestratorPrompt = baseSystemPrompt
    ? `${baseSystemPrompt}\n\n---\n\n${orchestratorPlaybookText}`
    : orchestratorPlaybookText;

  agents[ORCHESTRATOR_AGENT] = {
    description: 'Coordinates specialists and composes one grounded, cited answer.',
    prompt:
      orchestratorPrompt +
      orchestratorAdapter(roster, cfg.maxReviewRounds, cfg.maxSpecialistCalls),
    tools: [DELEGATE_ALLOW_TOKEN, `${MCP_TOOL_PREFIX}ask_clarifying_question`],
    model: cfg.orchestrator.model,
    effort: effortFor(cfg.orchestrator.thinkingLevel),
    maxTurns: cfg.orchestratorMaxTurns,
  };

  const specialistToolSets: string[][] = [];
  for (const name of specialistNames) {
    const info = byName.get(name);
    const tools = mapSpecialistTools(info, settings);
    specialistToolSets.push(tools);
    // Specialist system prompt = the server's base default-chat prompt (grounding + citation
    // contract) with the playbook layered on top — mirrors the web, where a specialist runs with
    // systemPromptOverride=null (base prompt) and the playbook prepended to the query.
    const playbookText = textByName.get(name) ?? '';
    const specialistPrompt = baseSystemPrompt
      ? `${baseSystemPrompt}\n\n---\n\n${playbookText}`
      : playbookText;
    agents[name] = {
      description: info?.description || info?.title || name,
      prompt: specialistPrompt,
      tools,
      model: cfg.specialist.model,
      effort: effortFor(cfg.specialist.thinkingLevel),
      maxTurns: cfg.specialistMaxTurns,
    };
  }

  agents[REVIEWER_SUBAGENT] = {
    description: 'Validates the composed answer against the gathered evidence. Never searches anew.',
    prompt: (textByName.get(profile.reviewerPlaybook) ?? '') + REVIEWER_ADAPTER,
    tools: REVIEWER_TOOLS,
    model: cfg.reviewer.model,
    effort: effortFor(cfg.reviewer.thinkingLevel),
    maxTurns: cfg.specialistMaxTurns,
  };

  const allowedTools = [
    ...new Set([
      DELEGATE_ALLOW_TOKEN,
      `${MCP_TOOL_PREFIX}ask_clarifying_question`,
      ...specialistToolSets.flat(),
      ...REVIEWER_TOOLS,
    ]),
  ];

  return { agents, allowedTools, specialistNames };
}

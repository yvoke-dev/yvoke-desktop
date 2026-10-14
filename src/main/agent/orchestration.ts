import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type {
  AppSettings,
  McpPromptInfo,
  MessageBlock,
  OrchestratorProfile,
  ReviewVerdict,
  ThinkingLevel,
} from '../../shared/types';
import {
  BASE_SYSTEM_PROMPT_NAME,
  DEFAULT_KB_TOOLS,
  isCitationOnlyVerdict,
  isValidSystemPromptName,
  MCP_TOOL_PREFIX,
  qualifyTool,
  resolveCanonicalModel,
  type ValidSystemPromptName,
} from '../../shared/types';
import { COMPUTE_TOOLS, isComputeTool } from './computeTools';
import { citeScoped, deduped, type SentLedger } from './evidenceDigest';
import { isWebTool, webToolDeclared } from './policy';
import { ORCHESTRATOR_SUBMIT_ANSWER_TOOL, REVIEW_SUBMIT_TOOL } from './reviewTools';
import type { McpPrompts } from './McpPrompts';
import { loadDesignatedSystemPrompt } from './systemPrompt';


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
export function effortFor(level: ThinkingLevel): 'low' | 'medium' | 'high' {
  return level === 'high' ? 'high' : level === 'off' || level === 'low' ? 'low' : 'medium';
}

/** Map a playbook's declared tool names to the SDK's fully-qualified allow-list for a specialist. */
export function mapSpecialistTools(info: McpPromptInfo | undefined, settings: AppSettings): string[] {
  const declared = info?.tools;
  // Web and compute tools stripped here and re-added below under their respective gates — same
  // reason as policy.ts: `qualifyTool` passes built-ins through and would otherwise qualify
  // compute tool names as `mcp__yvoke__*`.
  const tools =
    declared && declared.length > 0
      ? declared.filter((tool) => !isWebTool(tool) && !isComputeTool(tool)).map(qualifyTool)
      : DEFAULT_KB_TOOLS.map(qualifyTool);
  // Specialists get the safe compute tool instead of Bash, and only when their playbook declares
  // code execution — same rule as the single-agent path in policy.ts.
  const out = [...tools, 'ToolSearch'];
  if (info?.codeExecution !== false) out.push(...COMPUTE_TOOLS);
  // Per-playbook, exactly as in policy.ts: a specialist gets the web tools it declares and no
  // others. `declared` rather than `info?.tools` so a specialist with no declared tool set falls
  // back to DEFAULT_KB_TOOLS and therefore gets no web — the safe direction for a sub-agent whose
  // retrieval the user never sees in a tool picker.
  if (settings.webSearch.enabled) {
    for (const tool of ['WebSearch', 'WebFetch']) {
      if (webToolDeclared(tool, declared ?? [])) out.push(tool);
    }
  }
  return [...new Set(out)];
}

/**
 * The reviewer is a validate-only agent with `verify_citations` and `submit_review` — matching
 * `OrchestrationService.java`, which grants it `verify_citations` plus the per-run `SubmitReviewTool`.
 *
 * It has no search, read or compute tools (`code_execution: false`), and does not receive
 * `ToolSearch` because local MCP tools are directly available without tool discovery.
 * `get_section` was deliberately removed: returning the whole section around a passage lets the
 * reviewer judge claims against neighbouring text no specialist ever retrieved, defeating cite-scoping.
 */
export const REVIEWER_TOOLS = [`${MCP_TOOL_PREFIX}verify_citations`, REVIEW_SUBMIT_TOOL];

/**
 * Fallback delimiter if the model ever emits `<<<FINAL_ANSWER>>>` in plain text without calling
 * `submit_answer`.
 */
export const ANSWER_MARKER = '<<<FINAL_ANSWER>>>';

/**
 * Output contract for the orchestrator: submit the final answer via `submit_answer({ answer })`.
 */
export const SUBMIT_ANSWER_CONTRACT =
  'When your answer is ready and every citation id has been checked with `verify_citations`, ' +
  'call `submit_answer` (`mcp__review__submit_answer`) with your complete, cited Markdown answer ' +
  'in the `answer` parameter. Do not write the user-facing answer as plain text outside `submit_answer`.';

/**
 * Everything after the LAST marker, or the whole text when there is none
 * (ported from `OrchestrationService.afterAnswerMarker`).
 */
export function afterAnswerMarker(text: string): string {
  const at = text.lastIndexOf(ANSWER_MARKER);
  if (at < 0) {
    return text;
  }
  const tail = text.slice(at + ANSWER_MARKER.length).trim();
  // The marker is a control token; it must not reach the reader on either branch.
  return tail.length === 0 ? text.replaceAll(ANSWER_MARKER, '').trim() : tail;
}

/**
 * Strip pre-marker planning prose from `MessageBlock[]` while preserving all `thinking` and
 * `toolCalls` blocks, appending the clean `finalAnswer` as the final text block.
 */
export function stripBeforeAnswerMarker(blocks: MessageBlock[], finalAnswer: string): MessageBlock[] {
  const cleaned: MessageBlock[] = [];
  for (const block of blocks) {
    const hasThinking = Boolean(block.thinking && block.thinking.length > 0);
    const hasTools = Boolean(block.toolCalls && block.toolCalls.length > 0);
    if (hasThinking || hasTools) {
      cleaned.push({
        ...(hasThinking ? { thinking: block.thinking } : {}),
        ...(hasTools ? { toolCalls: block.toolCalls } : {}),
      });
    }
  }
  if (finalAnswer.length > 0) {
    cleaned.push({ text: finalAnswer });
  }
  return cleaned;
}

function orchestratorAdapter(roster: string, maxReviewRounds: number, maxSpecialistCalls: number): string {
  return `

---
## Desktop runtime adapter (how your tools work here)

You have NO \`call_specialist\` tool. To consult a specialist, call the **Task** tool with
\`subagent_type\` set to the specialist's name and \`prompt\` set to a fully self-contained question
(include the version/tag and any entity names — the specialist cannot see this conversation). The Task
result is that specialist's grounded, cited answer. You may delegate to several specialists in
parallel. Aim for at most ${maxSpecialistCalls} specialist calls in total.

### Output & Automated Review
${SUBMIT_ANSWER_CONTRACT}

When you call \`submit_answer\`, the runtime automatically validates your candidate answer against the
raw evidence retrieved by the specialists:
- If the reviewer **approves** your answer, \`submit_answer\` returns an approval confirmation and your
  answer is delivered to the user — end your turn immediately without repeating the answer.
- If the reviewer **rejects** your draft, \`submit_answer\` returns the reviewer feedback and relevant
  source evidence as its tool result (for up to ${maxReviewRounds} revision rounds). Revise the answer
  and call \`submit_answer\` again with the complete revised answer; do not argue with the reviewer.
Never add a "did not pass review" note yourself: the runtime appends one if the rounds run out.

Available specialists (\`subagent_type\` → coverage):
${roster}
`;
}

/**
 * Headings the SERVER orchestrator playbook and web harness (`OrchestrationService.java`) use.
 */
export const REVIEW_FEEDBACK_HEADING = '## Reviewer feedback to address';
export const EVIDENCE_HEADING = '## Evidence gathered by the specialists (the ONLY basis for validation)';

/**
 * Render the initial review prompt for the Reviewer session (ported from
 * `OrchestrationService.renderReviewTask` in `yvoke-web`).
 */
export function renderReviewTask(
  question: string,
  answer: string,
  evidence: string[],
  sent?: SentLedger | null,
): string {
  let sb =
    'Validate the candidate answer below. Do NOT search for new information — check ' +
    'it ONLY against the supplied evidence, then call submit_review.\n\n';
  sb += `## Original question\n${question}\n\n`;
  sb += `## Candidate answer\n${answer}\n\n`;
  sb += `${EVIDENCE_HEADING}\n`;
  if (evidence.length === 0) {
    sb += '(no evidence was captured)\n';
  } else {
    sb +=
      'You are shown the sources this answer cites, and only those. The ' +
      'specialists retrieved others that the answer does not cite; those are not ' +
      'shown here. So when a claim is not supported by the evidence below, the fault ' +
      'may be a missing or wrong citation rather than a missing source — say the ' +
      'answer must cite what supports the claim, rather than concluding no source ' +
      'exists.\n\n';
    sb += `${citeScoped(evidence, answer, sent)}\n`;
  }
  return sb;
}

/**
 * Render the follow-up review prompt on revision rounds (round > 0), carrying only the revised
 * candidate answer and newly cited sources not yet shown in earlier rounds (ported from
 * `OrchestrationService.renderReviewFollowUp` in `yvoke-web`).
 */
export function renderReviewFollowUp(
  answer: string,
  evidence: string[],
  sent?: SentLedger | null,
): string {
  const fresh = evidence.length === 0 ? '' : citeScoped(evidence, answer, sent);
  let sb =
    'The answer has been revised in response to your review. Re-validate it, then ' +
    'call submit_review. Your earlier notes and every source you were already shown are ' +
    'above in this conversation.\n\n';
  sb += `## Revised candidate answer\n${answer}\n\n`;
  sb += '## Sources this revision cites that you have not been shown yet\n';
  sb +=
    fresh.trim().length === 0
      ? '(none — every source this revision cites is already above)\n'
      : `${fresh}\n`;
  return sb;
}

const UUID_ANYWHERE_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * The ids the reviewer's objection actually names, as a bracketed list `citeScoped` can scope to —
 * falling back to the whole draft when it names none (ported from `OrchestrationService.idsUnderReview`).
 */
export function idsUnderReview(verdict: ReviewVerdict | undefined | null, draft: string): string {
  let objection = '';
  if (verdict) {
    if (verdict.feedback) {
      objection += `${verdict.feedback}\n`;
    }
    for (const fix of verdict.citationFixes ?? []) {
      objection += `${fix}\n`;
    }
    for (const claim of verdict.unsupportedClaims ?? []) {
      objection += `${claim}\n`;
    }
  }
  const matches = objection.match(UUID_ANYWHERE_RE);
  if (!matches || matches.length === 0) {
    return draft;
  }
  return matches.map((id) => `[${id}]\n`).join('');
}

export interface BuildRevisionPromptParams {
  verdict?: ReviewVerdict | null;
  feedback?: string;
  newEvidence?: string[];
  allEvidence?: string[];
  draft?: string;
  round?: number;
  maxRounds?: number;
}

/**
 * Render the revision task sent back to the orchestrator after a non-approving review verdict
 * (ported from `OrchestrationService.renderRevisionTask` in `yvoke-web`, adapted for the Desktop
 * `Task` delegation tool).
 */
export function buildRevisionPrompt(params: BuildRevisionPromptParams): string {
  const newEvidence = params.newEvidence ?? [];
  const allEvidence = params.allEvidence ?? [];
  const draft = params.draft ?? '';
  const verdict: ReviewVerdict = params.verdict ?? {
    approved: false,
    feedback: params.feedback,
    unsupportedClaims: [],
    citationFixes: [],
  };
  const feedbackText =
    verdict.feedback?.trim() ||
    params.feedback?.trim() ||
    '(the reviewer returned no parseable verdict — treat the answer as unvalidated)';
  const citationFixes = verdict.citationFixes ?? [];
  const unsupportedClaims = verdict.unsupportedClaims ?? [];

  let sb = '';
  if (newEvidence.length > 0) {
    sb += `## Source evidence behind the specialist answers above\n${deduped(newEvidence)}\n\n`;
  } else if (allEvidence.length > 0 && draft.length > 0) {
    const cited = citeScoped(allEvidence, idsUnderReview(verdict, draft), null);
    if (cited.trim().length > 0) {
      sb +=
        '## The sources your answer currently cites\n' +
        'Re-read these before moving any citation: they are what the reviewer ' +
        'judged, and a claim is mis-cited only if the text below does not say ' +
        'it.\n\n' +
        `${cited}\n\n`;
    }
  }

  sb += `${REVIEW_FEEDBACK_HEADING}\n${feedbackText}\n\n`;

  if (citationFixes.length > 0) {
    sb += '## Citation fixes — no research needed\n';
    sb +=
      'Each of these is repairable from evidence **already supplied** above: the ' +
      'source was retrieved, the citation on it is wrong, missing or duplicated. Apply ' +
      'them by editing the answer\'s citations and `## References` — do NOT call ' +
      'the Task tool for any of them.\n';
    for (const fix of citationFixes) {
      sb += `- ${fix}\n`;
    }
    sb += '\n';
  }

  if (unsupportedClaims.length > 0) {
    sb += '## Unsupported claims\n';
    sb +=
      'Nothing supplied supports these. Either remove the claim, or delegate to a ' +
      'specialist for the material — this is the only part of the feedback that may ' +
      'warrant a new specialist call.\n';
    for (const claim of unsupportedClaims) {
      sb += `- ${claim}\n`;
    }
    sb += '\n';
  }

  sb +=
    'Revise the answer you just gave and submit the complete revised answer via `submit_answer`. Keep everything the reviewer did not object to.';
  if (isCitationOnlyVerdict(verdict)) {
    sb +=
      ' Every objection above is a citation fix, so this revision needs no new ' +
      'evidence at all — do NOT call the Task tool.';
  } else {
    sb += ' Delegate again only for material that is genuinely missing above.';
  }
  return sb;
}

/**
 * Appended in code when an answer ships without passing review after exhausting review rounds
 * (ported from `OrchestrationService.flagNote` in `yvoke-web`).
 */
export function reviewFlagNote(attempts: number, feedback?: string): string {
  const reason = feedback && feedback.trim().length > 0 ? feedback.trim() : 'unspecified concerns';
  return `\n\n---\n⚠️ *This answer did not pass automated review after ${attempts} attempt(s). Reviewer notes: ${reason}*`;
}

/**
 * Appended in code when the automated reviewer failed to run at all (ported from
 * `OrchestrationService.unreviewedNote` in `yvoke-web`).
 */
export function unreviewedNote(): string {
  return (
    '\n\n---\n⚠️ *This answer could not be checked — the automated review failed to ' +
    'run, so nothing has validated its claims or citations. Treat it as unverified.*'
  );
}

/** Configuration for the code-driven Reviewer session (`AgentService.runReviewPass`). */
export interface ReviewerConfig {
  prompt: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  effort: 'low' | 'medium' | 'high';
  tools: string[];
}

export interface ResolvedOrchestrator {
  agents: Record<string, AgentDefinition>;
  allowedTools: string[];
  /** Set of sub-agent names that are specialists (not the reviewer) — for trace labelling. */
  specialistNames: string[];
  /** Code-driven reviewer configuration (never exposed as a Task sub-agent to the orchestrator). */
  reviewer: ReviewerConfig;
}

/**
 * Build the SDK `agents` map + `allowedTools` for orchestrator mode from a server profile. Fetches
 * each playbook's text (system prompt) and tool metadata; binds Claude models per role from settings.
 *
 * `baseSystemPrompt` is the server's `default-chat` system prompt. It carries the shared grounding &
 * citation contract — a bare `[<uuid>]` id inline after each claim, explicitly NO numbering and no
 * `## References` section.
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
/**
 * Delegation must be SYNCHRONOUS. The orchestrator needs a specialist's answer in hand to compose,
 * and the reviewer's verdict in hand to ship — a backgrounded delegation returns a launch receipt
 * instead ("Async agent launched successfully… agentId: …").
 *
 * The Task tool's DEFAULT flipped between SDK versions: the pinned 0.3.170 says `run_in_background:
 * true runs the agent asynchronously` (opt-in), while 0.3.218 says `Subagents run in the background
 * by default`. Measured on 0.3.218 in yvoke-eval on 3 Sep 2026: specialists returned 802-character
 * receipts, the orchestrator re-delegated blind, the reviewer's own verdict became unparseable
 * because its result was a receipt too, and reviewers APPROVED answers while stating in the same
 * breath that they had been given no evidence. Nothing failed loudly — the answers still looked
 * well-formed.
 *
 * Declaring `background: false` per agent says no AGENT is a background agent. It does NOT stop a
 * CALL from being backgrounded: with this set on every definition, on SDK 0.3.295, every specialist
 * and reviewer call still came back as a receipt. What holds is `sanitizedEnv` switching background
 * tasks off in the CLI (see there), checked end to end by `npm run spike:delegation`.
 */
const BACKGROUND_DELEGATION = false;

export async function buildOrchestrator(
  profile: OrchestratorProfile,
  settings: AppSettings,
  mcpPrompts: McpPrompts,
  baseSystemPrompt: string,
  loadSystemPrompt: (name: ValidSystemPromptName) => Promise<string>,
): Promise<ResolvedOrchestrator> {
  const cfg = settings.orchestrator;
  if (!cfg) {
    throw new Error('Orchestrator settings are not configured (settings.orchestrator is missing).');
  }

  const metadata = await mcpPrompts.list();
  const byName = new Map(metadata.map((p) => [p.name, p]));

  const names = [profile.orchestratorPlaybook, profile.reviewerPlaybook, ...profile.specialistPlaybooks];

  // Collect all unique, valid designated system prompt names across all roles in this profile.
  const uniqueDesignatedNames = [
    ...new Set(
      names
        .map((name) => {
          const raw = byName.get(name)?.systemPrompt;
          return typeof raw === 'string' ? raw.trim() : undefined;
        })
        .filter((p): p is ValidSystemPromptName => Boolean(p && isValidSystemPromptName(p))),
    ),
  ];

  // Pre-seed cache with baseSystemPrompt under BASE_SYSTEM_PROMPT_NAME ('default-chat') so designating
  // it explicitly never triggers a redundant remote fetch.
  const promptCache = new Map<string, string>();
  if (baseSystemPrompt && baseSystemPrompt.trim().length > 0) {
    promptCache.set(BASE_SYSTEM_PROMPT_NAME, baseSystemPrompt);
  }

  // Load all unique designated custom prompts and all playbook texts concurrently in a single parallel stage.
  const [, textEntries] = await Promise.all([
    Promise.all(
      uniqueDesignatedNames.map(async (promptName) => {
        if (promptCache.has(promptName)) return;
        const loaded = await loadDesignatedSystemPrompt(loadSystemPrompt, promptName);
        if (loaded !== null) {
          promptCache.set(promptName, loaded);
        }
      }),
    ),
    Promise.all(
      names.map(async (name) => [name, await mcpPrompts.getText(name)] as const),
    ),
  ]);
  const textByName = new Map(textEntries);

  const resolveDesignatedPrompt = (playbookName: string): string | null => {
    const raw = byName.get(playbookName)?.systemPrompt;
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!isValidSystemPromptName(trimmed)) return null;
    return promptCache.get(trimmed) ?? null;
  };

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
  // (bare-id citations, mermaid/KaTeX delimiters) exactly as the specialists do.
  // It previously got the control playbook alone — the one agent that never saw the contract it was
  // expected to honour. Playbook last, so its role-specific rules win on any conflict.
  // Falls back to baseSystemPrompt if no custom prompt is designated, if not found (404), or if empty.
  const customOrchPrompt = resolveDesignatedPrompt(profile.orchestratorPlaybook);
  const orchestratorBase = customOrchPrompt ?? baseSystemPrompt;
  const orchestratorPlaybookText = textByName.get(profile.orchestratorPlaybook) ?? '';
  const orchestratorPrompt = orchestratorBase
    ? `${orchestratorBase}\n\n---\n\n${orchestratorPlaybookText}`
    : orchestratorPlaybookText;

  const orchestratorTools = [
    DELEGATE_ALLOW_TOKEN,
    `${MCP_TOOL_PREFIX}ask_clarifying_question`,
    `${MCP_TOOL_PREFIX}verify_citations`,
    ORCHESTRATOR_SUBMIT_ANSWER_TOOL,
  ];

  agents[ORCHESTRATOR_AGENT] = {
    description: 'Coordinates specialists and composes one grounded, cited answer.',
    prompt:
      orchestratorPrompt +
      orchestratorAdapter(roster, cfg.maxReviewRounds, cfg.maxSpecialistCalls),
    // `verify_citations` is not optional: the server's orchestrator playbook names it as one of the
    // three tools it has, and requires it be run on every id before the answer is sent. The web
    // grants exactly `["ask_clarifying_question", "verify_citations"]`. Without it the orchestrator
    // — the one agent that writes the user-facing answer — was told to pre-flight its citations
    // with a tool it had not been given, leaving a fabricated id to cost a whole review round.
    tools: orchestratorTools,
    background: BACKGROUND_DELEGATION,
    model: resolveCanonicalModel(cfg.orchestrator.model),
    effort: effortFor(cfg.orchestrator.thinkingLevel),
    maxTurns: cfg.orchestratorMaxTurns,
  };

  const specialistToolSets: string[][] = [];
  for (const name of specialistNames) {
    const info = byName.get(name);
    const tools = mapSpecialistTools(info, settings);
    const customSpecPrompt = resolveDesignatedPrompt(name);
    const specialistBase = customSpecPrompt ?? baseSystemPrompt;
    const playbookText = textByName.get(name) ?? '';
    const specialistPrompt = specialistBase
      ? `${specialistBase}\n\n---\n\n${playbookText}`
      : playbookText;
    specialistToolSets.push(tools);
    agents[name] = {
      description: info?.description || info?.title || name,
      prompt: specialistPrompt,
      tools,
      background: BACKGROUND_DELEGATION,
      model: resolveCanonicalModel(cfg.specialist.model),
      effort: effortFor(cfg.specialist.thinkingLevel),
      maxTurns: cfg.specialistMaxTurns,
    };
  }

  // The reviewer runs on its playbook alone (deliberately: no baseSystemPrompt), in its own
  // runtime-driven query() session rather than as an orchestrator-callable Task sub-agent.
  // If a custom designated system prompt is specified and loads successfully, it is layered on top.
  // If absent, not found (404), or empty, it falls back to empty string (playbook alone, NO baseSystemPrompt).
  const customRevPrompt = resolveDesignatedPrompt(profile.reviewerPlaybook);
  const reviewerBase = customRevPrompt ? `${customRevPrompt}\n\n---\n\n` : '';

  const reviewer: ReviewerConfig = {
    prompt: reviewerBase + (textByName.get(profile.reviewerPlaybook) ?? ''),
    model: resolveCanonicalModel(cfg.reviewer.model),
    thinkingLevel: cfg.reviewer.thinkingLevel,
    effort: effortFor(cfg.reviewer.thinkingLevel),
    tools: [...REVIEWER_TOOLS],
  };

  // Spread the orchestrator's OWN grant plus specialist tools.
  const allowedTools = [
    ...new Set([...orchestratorTools, ...specialistToolSets.flat()]),
  ];

  return { agents, allowedTools, specialistNames, reviewer };
}

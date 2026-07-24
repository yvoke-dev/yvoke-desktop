import type {
  ChatMessage,
  OrchestratorProfile,
  OrchestratorRunPayload,
  OrchestratorRunStep,
  OrchestratorSettings,
  ToolCallInfo,
} from '../../shared/types';

const REVIEWER_SUBAGENT = 'reviewer';

export interface BuildRunTraceParams {
  conversationId: string;
  userText: string;
  assistant: ChatMessage;
  profileName: string;
  profile?: OrchestratorProfile;
  orchestrator: OrchestratorSettings;
}

/**
 * Assemble a completed multi-agent run from the finished assistant message. Each Agent (delegation)
 * tool call becomes a specialist/reviewer step; a leading orchestrator step carries the composed
 * answer. Returns null when the turn had no delegations (i.e. not an orchestrated turn worth tracing).
 */
export function buildRunTrace(params: BuildRunTraceParams): OrchestratorRunPayload | null {
  const { conversationId, userText, assistant, profileName, profile, orchestrator } = params;
  const delegations: ToolCallInfo[] = (assistant.toolCalls ?? []).filter((c) => c.name === 'Agent');
  if (delegations.length === 0) {
    return null;
  }

  const promptInput = (c: ToolCallInfo): string | undefined => {
    const input = (c.input ?? {}) as { prompt?: string; description?: string };
    return input.prompt ?? input.description;
  };

  const orchestratorStep: OrchestratorRunStep = {
    seq: 0,
    role: 'orchestrator',
    round: 0,
    playbookName: profile?.orchestratorPlaybook,
    model: orchestrator.orchestrator.model,
    thinkingLevel: orchestrator.orchestrator.thinkingLevel,
    input: userText,
    output: assistant.content,
    messages: { text: assistant.content, thinking: assistant.thinking },
    promptTokens: assistant.usage?.inputTokens,
    completionTokens: assistant.usage?.outputTokens,
    totalTokens: assistant.usage ? assistant.usage.inputTokens + assistant.usage.outputTokens : undefined,
    cachedTokens: assistant.usage?.cacheReadTokens,
    thoughtTokens: assistant.usage?.thoughtTokens,
  };

  const steps: OrchestratorRunStep[] = [orchestratorStep];
  /** Reviewer passes so far; also the step-level `round`, since round N's review is its last step. */
  let reviewersSeen = 0;
  let lastVerdict: { approved: boolean; feedback?: string } | undefined;

  delegations.forEach((c, i) => {
    const isReviewer = c.subagentType === REVIEWER_SUBAGENT;
    const role = isReviewer ? 'reviewer' : 'specialist';
    steps.push({
      seq: i + 1,
      role,
      round: reviewersSeen,
      playbookName: c.subagentType,
      model: isReviewer ? orchestrator.reviewer.model : orchestrator.specialist.model,
      thinkingLevel: isReviewer ? orchestrator.reviewer.thinkingLevel : orchestrator.specialist.thinkingLevel,
      input: promptInput(c),
      output: c.result,
      messages: { transcript: c.subagentBlocks ?? [] },
      verdict: c.verdict,
    });
    if (isReviewer) {
      reviewersSeen += 1;
      if (c.verdict) lastVerdict = c.verdict;
    }
  });

  // An answer that never reached the reviewer is not 'done' — the admin trace should be able to
  // tell a passed review from one that never happened.
  const status = lastVerdict
    ? lastVerdict.approved
      ? 'done'
      : 'delivered_flagged'
    : reviewersSeen > 0
      ? 'delivered_unclear'
      : 'delivered_unreviewed';

  // `reviewRounds` follows the web harness (OrchestrationService), which reports the number of
  // REVISION rounds, not reviewer passes: a first-pass approval is round 0. Desktop runs land in the
  // same table as web runs, so the two must count the same thing.
  const revisionRounds = Math.max(0, reviewersSeen - 1);

  return {
    conversationId,
    profileName,
    status,
    config: {
      profile: profile ?? { name: profileName },
      models: {
        orchestrator: orchestrator.orchestrator,
        reviewer: orchestrator.reviewer,
        specialist: orchestrator.specialist,
      },
    },
    reviewRounds: revisionRounds,
    finalVerdict: lastVerdict ?? null,
    promptTokens: assistant.usage?.inputTokens,
    completionTokens: assistant.usage?.outputTokens,
    totalTokens: assistant.usage ? assistant.usage.inputTokens + assistant.usage.outputTokens : undefined,
    cachedTokens: assistant.usage?.cacheReadTokens,
    thoughtTokens: assistant.usage?.thoughtTokens,
    steps,
  };
}

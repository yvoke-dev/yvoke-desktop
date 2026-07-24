import { describe, expect, it } from 'vitest';
import { buildRunTrace } from '../src/main/agent/runTrace';
import { qualifyTool } from '../src/shared/types';
import type { ChatMessage, OrchestratorProfile, OrchestratorSettings, ToolCallInfo } from '../src/shared/types';

const orchestrator: OrchestratorSettings = {
  orchestrator: { model: 'opus', thinkingLevel: 'high' },
  reviewer: { model: 'opus', thinkingLevel: 'high' },
  specialist: { model: 'haiku', thinkingLevel: 'medium' },
  maxReviewRounds: 2,
  maxSpecialistCalls: 8,
  orchestratorMaxTurns: 60,
  specialistMaxTurns: 20,
};

const profile: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-orchestrator',
  reviewerPlaybook: 'oim-orchestrator-reviewer',
  specialistPlaybooks: ['oim-access-governance', 'oim-developer-api'],
};

function agentCall(partial: Partial<ToolCallInfo>): ToolCallInfo {
  return { id: partial.id ?? 'x', name: 'Agent', input: {}, ...partial };
}

function assistant(toolCalls: ToolCallInfo[], content = 'Final composed answer.'): ChatMessage {
  return {
    localId: 'a1',
    role: 'assistant',
    content,
    toolCalls,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 0, thoughtTokens: 10 },
    createdAt: 'now',
  };
}

describe('buildRunTrace', () => {
  it('returns null when the turn had no delegations', () => {
    const msg = assistant([{ id: 't1', name: qualifyTool('search_corpus'), input: {} }]);
    expect(buildRunTrace({ conversationId: 'c1', userText: 'q', assistant: msg, profileName: 'OIM', profile, orchestrator })).toBeNull();
  });

  it('builds an orchestrator step + one step per delegation, in order', () => {
    const msg = assistant([
      agentCall({ id: 'd1', subagentType: 'oim-access-governance', input: { prompt: 'roles?' }, result: 'roles answer' }),
      agentCall({ id: 'd2', subagentType: 'oim-developer-api', input: { prompt: 'rest?' }, result: 'rest answer' }),
      agentCall({ id: 'r1', subagentType: 'reviewer', input: { prompt: 'check' }, result: 'APPROVED\nok', verdict: { approved: true, feedback: 'ok' } }),
    ]);
    const run = buildRunTrace({ conversationId: 'c1', userText: 'the question', assistant: msg, profileName: 'OIM', profile, orchestrator })!;

    expect(run.conversationId).toBe('c1');
    expect(run.steps).toHaveLength(4);
    expect(run.steps[0]).toMatchObject({ seq: 0, role: 'orchestrator', playbookName: 'oim-orchestrator', model: 'opus', input: 'the question', output: 'Final composed answer.' });
    expect(run.steps[1]).toMatchObject({ seq: 1, role: 'specialist', playbookName: 'oim-access-governance', model: 'haiku', input: 'roles?', output: 'roles answer', round: 0 });
    expect(run.steps[3]).toMatchObject({ seq: 3, role: 'reviewer', playbookName: 'reviewer', model: 'opus', round: 0 });
    // Web convention: rounds count REVISIONS, so an answer approved on the first pass is round 0.
    expect(run.reviewRounds).toBe(0);
    expect(run.finalVerdict).toEqual({ approved: true, feedback: 'ok' });
    expect(run.status).toBe('done');
    // Run-level tokens come from the aggregate SDK usage.
    expect(run).toMatchObject({ promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 30, thoughtTokens: 10 });
  });

  it('marks delivered_flagged when the last review rejected, counting the redo as one round', () => {
    const msg = assistant([
      agentCall({ id: 'd1', subagentType: 'oim-developer-api', input: { prompt: 'q' }, result: 'a' }),
      agentCall({ id: 'r1', subagentType: 'reviewer', result: 'REJECTED\nfix X', verdict: { approved: false, feedback: 'fix X' } }),
      agentCall({ id: 'd2', subagentType: 'oim-developer-api', input: { prompt: 'q2' }, result: 'a2' }),
      agentCall({ id: 'r2', subagentType: 'reviewer', result: 'REJECTED\nstill bad', verdict: { approved: false, feedback: 'still bad' } }),
    ]);
    const run = buildRunTrace({ conversationId: 'c1', userText: 'q', assistant: msg, profileName: 'OIM', profile, orchestrator })!;

    // Two reviewer passes = one revision round, as the web reports it.
    expect(run.reviewRounds).toBe(1);
    expect(run.status).toBe('delivered_flagged');
    expect(run.finalVerdict).toEqual({ approved: false, feedback: 'still bad' });
    // The specialist re-queried after the first rejection is in round 1.
    expect(run.steps.find((s) => s.seq === 3)).toMatchObject({ role: 'specialist', round: 1 });
  });

  it('nests each specialist transcript under its step', () => {
    const msg = assistant([
      agentCall({
        id: 'd1',
        subagentType: 'oim-developer-api',
        input: { prompt: 'q' },
        result: 'a',
        subagentBlocks: [{ text: 'searching', toolCalls: [{ id: 'i1', name: qualifyTool('search_corpus'), input: {} }] }],
      }),
    ]);
    const run = buildRunTrace({ conversationId: 'c1', userText: 'q', assistant: msg, profileName: 'OIM', profile, orchestrator })!;
    expect(run.steps[1].messages).toEqual({ transcript: [{ text: 'searching', toolCalls: [{ id: 'i1', name: qualifyTool('search_corpus'), input: {} }] }] });
  });
});

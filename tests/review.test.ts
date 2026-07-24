import { describe, expect, it } from 'vitest';
import { addUsage, nextReviewAction, reviewAttempts, reviewStatusOf } from '../src/main/agent/translate';
import {
  buildRevisionPrompt,
  EVIDENCE_HEADING,
  REVIEW_ENFORCEMENT_PROMPT,
  REVIEW_FEEDBACK_HEADING,
  renderSpecialistEvidence,
  reviewFlagNote,
} from '../src/main/agent/orchestration';
import { buildRunTrace } from '../src/main/agent/runTrace';
import { qualifyTool } from '../src/shared/types';
import type { ChatMessage, OrchestratorSettings, ToolCallInfo } from '../src/shared/types';

function delegation(subagentType: string, over: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return { id: `t-${subagentType}-${Math.random()}`, name: 'Agent', input: { prompt: 'q' }, subagentType, ...over };
}

describe('reviewStatusOf', () => {
  it('returns undefined for a turn with no delegations (nothing to review)', () => {
    expect(reviewStatusOf([])).toBeUndefined();
    expect(reviewStatusOf([{ id: '1', name: qualifyTool('get_section'), input: {} }])).toBeUndefined();
  });

  it('flags specialists-without-reviewer as skipped — the case that shipped unreviewed', () => {
    expect(reviewStatusOf([delegation('oim-customers')])).toEqual({ outcome: 'skipped' });
  });

  it('reports the reviewer verdict', () => {
    const approved = [delegation('oim-customers'), delegation('reviewer', { verdict: { approved: true } })];
    expect(reviewStatusOf(approved)).toEqual({ outcome: 'approved' });

    const rejected = [delegation('reviewer', { verdict: { approved: false, feedback: 'claim 2 unsupported' } })];
    expect(reviewStatusOf(rejected)).toEqual({ outcome: 'rejected', feedback: 'claim 2 unsupported' });
  });

  it('treats an errored or unparseable reviewer as unclear, never as a pass', () => {
    expect(reviewStatusOf([delegation('reviewer', { result: 'looks fine to me' })])).toEqual({ outcome: 'unclear' });
    expect(reviewStatusOf([delegation('reviewer', { isError: true, verdict: { approved: true } })])).toEqual({
      outcome: 'unclear',
    });
  });

  it('takes the LAST verdict, so a rejected-then-revised turn reads as approved', () => {
    const calls = [
      delegation('reviewer', { verdict: { approved: false, feedback: 'fix citations' } }),
      delegation('reviewer', { verdict: { approved: true } }),
    ];
    expect(reviewStatusOf(calls)?.outcome).toBe('approved');
  });

  it('marks the status as enforced when the runtime had to re-prompt', () => {
    expect(reviewStatusOf([delegation('reviewer', { verdict: { approved: true } })], true)).toEqual({
      outcome: 'approved',
      enforced: true,
    });
    expect(reviewStatusOf([delegation('oim-customers')], true)).toEqual({ outcome: 'skipped', enforced: true });
  });
});

describe('nextReviewAction', () => {
  const base = {
    orchestratorMode: true,
    isError: false,
    aborted: false,
    alreadyEnforced: false,
    maxReviewRounds: 2,
    toolCalls: [delegation('oim-customers')],
  };
  const rejected = (feedback = 'claim 2 unsupported'): ToolCallInfo[] => [
    delegation('oim-customers'),
    delegation('reviewer', { verdict: { approved: false, feedback } }),
  ];

  it('enforces a review when an orchestrated turn skipped the reviewer', () => {
    expect(nextReviewAction(base)).toEqual({ kind: 'enforce' });
    expect(nextReviewAction({ ...base, requireReview: true })).toEqual({ kind: 'enforce' });
  });

  it('drives a revision round when the reviewer rejected the draft', () => {
    expect(nextReviewAction({ ...base, toolCalls: rejected() })).toEqual({
      kind: 'revise',
      outcome: 'rejected',
      feedback: 'claim 2 unsupported',
      round: 1,
    });
  });

  it('counts rounds and stops at maxReviewRounds, delivering the answer flagged', () => {
    const rejectedTwice = [...rejected(), delegation('reviewer', { verdict: { approved: false } })];
    expect(nextReviewAction({ ...base, toolCalls: rejectedTwice, revisionRounds: 1 })).toMatchObject({
      kind: 'revise',
      round: 2,
    });
    expect(nextReviewAction({ ...base, toolCalls: rejectedTwice, revisionRounds: 2 })).toEqual({ kind: 'deliver' });
    // maxReviewRounds: 0 means "review once, never revise".
    expect(nextReviewAction({ ...base, toolCalls: rejected(), maxReviewRounds: 0 })).toEqual({ kind: 'deliver' });
  });

  it('revises on an unclear verdict too — an unparseable reviewer is not a pass', () => {
    const unclear = [delegation('reviewer', { result: 'looks fine to me' })];
    expect(nextReviewAction({ ...base, toolCalls: unclear })).toMatchObject({ kind: 'revise', outcome: 'unclear' });
  });

  it('delivers an approved answer untouched', () => {
    const approved = [delegation('oim-customers'), delegation('reviewer', { verdict: { approved: true } })];
    expect(nextReviewAction({ ...base, toolCalls: approved })).toEqual({ kind: 'deliver' });
  });

  it('never re-prompts twice for a skipped review, so a stubborn orchestrator cannot loop the turn', () => {
    expect(nextReviewAction({ ...base, alreadyEnforced: true })).toEqual({ kind: 'deliver' });
  });

  it('is opt-out via requireReview: false', () => {
    expect(nextReviewAction({ ...base, requireReview: false })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, toolCalls: rejected(), requireReview: false })).toEqual({ kind: 'deliver' });
  });

  it('leaves single-agent, errored and stopped turns alone', () => {
    expect(nextReviewAction({ ...base, orchestratorMode: false })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, isError: true })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, aborted: true })).toEqual({ kind: 'deliver' });
    // A rejected verdict on a stopped turn must not restart it against the user's Stop.
    expect(nextReviewAction({ ...base, toolCalls: rejected(), aborted: true })).toEqual({ kind: 'deliver' });
  });

  it('does not fire on a turn that delegated to nobody', () => {
    expect(nextReviewAction({ ...base, toolCalls: [] })).toEqual({ kind: 'deliver' });
  });
});

describe('revision round prompt', () => {
  const toolCalls = [
    delegation('oim-operations-config', { result: 'Selection scripts are VB.Net [chunk_id=abc]' }),
    delegation('oim-developer-api', { isError: true, result: 'boom' }),
    delegation('reviewer', { result: 'REJECTED\nno evidence supplied' }),
  ];

  it('renders each specialist answer as evidence, skipping failures and the reviewer', () => {
    const evidence = renderSpecialistEvidence(toolCalls);
    expect(evidence).toContain('oim-operations-config');
    expect(evidence).toContain('[chunk_id=abc]');
    expect(evidence).not.toContain('oim-developer-api');
    expect(evidence).not.toContain('REJECTED');
  });

  it('says so explicitly when nothing was captured, rather than rendering an empty section', () => {
    expect(renderSpecialistEvidence([])).toMatch(/no specialist evidence/i);
  });

  it('uses the headings the server playbook and web harness key off', () => {
    const prompt = buildRevisionPrompt({ feedback: 'citations are document-level', toolCalls, round: 1, maxRounds: 2 });
    // The playbook's "revision rounds" section only fires on this exact heading.
    expect(prompt).toContain(REVIEW_FEEDBACK_HEADING);
    expect(prompt).toContain(EVIDENCE_HEADING);
    expect(prompt).toContain('citations are document-level');
    expect(prompt).toContain('[chunk_id=abc]');
    expect(prompt).toContain('revision round 1 of 2');
    expect(prompt).toMatch(/discarded/i);
  });

  it('still asks for a fix when the reviewer gave no parseable feedback', () => {
    const prompt = buildRevisionPrompt({ toolCalls, round: 2, maxRounds: 2 });
    expect(prompt).toContain(REVIEW_FEEDBACK_HEADING);
    expect(prompt).toMatch(/no parseable verdict/i);
  });
});

describe('reviewFlagNote', () => {
  it('warns in the message content itself, pluralising the attempt count', () => {
    expect(reviewFlagNote(1)).toContain('1 attempt.');
    expect(reviewFlagNote(3)).toContain('3 attempts.');
    expect(reviewFlagNote(3)).toMatch(/did not pass automated review/i);
  });
});

describe('reviewAttempts', () => {
  it('counts reviewer delegations only', () => {
    expect(reviewAttempts([delegation('oim-customers'), delegation('reviewer'), delegation('reviewer')])).toBe(2);
    expect(reviewAttempts([{ id: '1', name: qualifyTool('get_section'), input: {} }])).toBe(0);
  });
});

describe('REVIEW_ENFORCEMENT_PROMPT', () => {
  it('names the reviewer subagent and demands a full restatement', () => {
    expect(REVIEW_ENFORCEMENT_PROMPT).toContain('subagent_type: "reviewer"');
    expect(REVIEW_ENFORCEMENT_PROMPT).toContain('APPROVED');
    expect(REVIEW_ENFORCEMENT_PROMPT).toContain('REJECTED');
    // The draft is dropped, so the model must be told its next text is the whole answer.
    expect(REVIEW_ENFORCEMENT_PROMPT).toMatch(/discarded/i);
  });
});

describe('addUsage', () => {
  it('sums both results of an enforced turn so the re-prompt is not free', () => {
    const first = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 1, thoughtTokens: 3 };
    const second = { inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 2 };
    expect(addUsage(first, second)).toEqual({
      inputTokens: 14,
      outputTokens: 8,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      thoughtTokens: 3,
    });
  });
});

describe('buildRunTrace review status', () => {
  const orchestrator: OrchestratorSettings = {
    orchestrator: { model: 'opus', thinkingLevel: 'high' },
    reviewer: { model: 'opus', thinkingLevel: 'high' },
    specialist: { model: 'sonnet', thinkingLevel: 'medium' },
    maxReviewRounds: 2,
    maxSpecialistCalls: 8,
    orchestratorMaxTurns: 60,
    specialistMaxTurns: 20,
  };

  const trace = (toolCalls: ToolCallInfo[]): ReturnType<typeof buildRunTrace> => {
    const assistant: ChatMessage = {
      localId: 'm1',
      role: 'assistant',
      content: 'answer',
      toolCalls,
      createdAt: new Date(0).toISOString(),
    };
    return buildRunTrace({
      conversationId: 'c1',
      userText: 'how many customers are registered?',
      assistant,
      profileName: 'OIM',
      orchestrator,
    });
  };

  it('records an unreviewed run distinctly from a passed one', () => {
    expect(trace([delegation('oim-customers')])?.status).toBe('delivered_unreviewed');
    expect(trace([delegation('oim-customers')])?.reviewRounds).toBe(0);
  });

  it('keeps done / delivered_flagged for real verdicts', () => {
    expect(trace([delegation('reviewer', { verdict: { approved: true } })])?.status).toBe('done');
    expect(trace([delegation('reviewer', { verdict: { approved: false } })])?.status).toBe('delivered_flagged');
  });

  it('marks a reviewer that returned no verdict as unclear', () => {
    expect(trace([delegation('reviewer', { result: 'no idea' })])?.status).toBe('delivered_unclear');
  });
});

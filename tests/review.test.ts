import { describe, expect, it } from 'vitest';
import { addUsage, nextReviewAction, reviewAttempts, reviewStatusOf } from '../src/main/agent/translate';
import {
  afterAnswerMarker,
  ANSWER_MARKER,
  buildRevisionPrompt,
  EVIDENCE_HEADING,
  idsUnderReview,
  renderReviewFollowUp,
  renderReviewTask,
  REVIEW_FEEDBACK_HEADING,
  reviewFlagNote,
  stripBeforeAnswerMarker,
  unreviewedNote,
} from '../src/main/agent/orchestration';
import { formatChunkBlocks } from '../src/main/agent/chunkBlocks';
import { SentLedger } from '../src/main/agent/evidenceDigest';
import { buildRunTrace } from '../src/main/agent/runTrace';
import { qualifyTool } from '../src/shared/types';
import type { ChatMessage, OrchestratorSettings, ToolCallInfo } from '../src/shared/types';

function delegation(subagentType: string, over: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return { id: `t-${subagentType}-${Math.random()}`, name: 'Agent', input: { prompt: 'q' }, subagentType, ...over };
}

const CHUNK_1_ID = '11111111-1111-1111-1111-111111111111';
const CHUNK_2_ID = '22222222-2222-2222-2222-222222222222';
const DOC_1_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeChunkEntry(chunkId: string, body: string, title = 'Admin Guide'): string {
  return `[oim-ops · search_corpus]\n${formatChunkBlocks([
    {
      id: chunkId,
      documentId: DOC_1_ID,
      text: body,
      headingPath: ['Config'],
      documentTitle: title,
      kind: 'manual',
      score: 0.91,
    },
  ])}`;
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

  it('is never consulted for a single-agent turn — nextReviewAction short-circuits first', () => {
    const calls = [delegation('oim-customers')];
    expect(nextReviewAction({ ...base, orchestratorMode: false, toolCalls: calls })).toEqual({ kind: 'deliver' });
    expect(
      nextReviewAction({
        ...base,
        orchestratorMode: false,
        toolCalls: [delegation('reviewer', { verdict: { approved: false } })],
      }),
    ).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, orchestratorMode: true, toolCalls: calls })).toEqual({ kind: 'enforce' });
  });

  it('enforces a review when an orchestrated turn skipped the reviewer', () => {
    expect(nextReviewAction(base)).toEqual({ kind: 'enforce' });
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

  it('always code-enforces review — review toggle cannot be turned off', () => {
    expect(nextReviewAction(base)).toEqual({ kind: 'enforce' });
    expect(nextReviewAction({ ...base, toolCalls: rejected() })).toEqual({
      kind: 'revise',
      outcome: 'rejected',
      feedback: 'claim 2 unsupported',
      round: 1,
    });
  });

  it('leaves single-agent, errored and stopped turns alone', () => {
    expect(nextReviewAction({ ...base, orchestratorMode: false })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, isError: true })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, aborted: true })).toEqual({ kind: 'deliver' });
    expect(nextReviewAction({ ...base, toolCalls: rejected(), aborted: true })).toEqual({ kind: 'deliver' });
  });

  it('does not fire on a turn that delegated to nobody', () => {
    expect(nextReviewAction({ ...base, toolCalls: [] })).toEqual({ kind: 'deliver' });
  });
});

describe('afterAnswerMarker and stripBeforeAnswerMarker', () => {
  it('returns text after the LAST <<<FINAL_ANSWER>>> marker', () => {
    const raw = `I will write ${ANSWER_MARKER} before my answer.\n${ANSWER_MARKER}\nThe real answer [${CHUNK_1_ID}].`;
    expect(afterAnswerMarker(raw)).toBe(`The real answer [${CHUNK_1_ID}].`);
  });

  it('returns the full text untouched when no marker is present', () => {
    expect(afterAnswerMarker('Plain answer with no marker.')).toBe('Plain answer with no marker.');
  });

  it('strips marker and returns preceding text when tail after marker is blank', () => {
    expect(afterAnswerMarker(`Answer written before marker.\n${ANSWER_MARKER}   \n`)).toBe(
      'Answer written before marker.',
    );
  });

  it('stripBeforeAnswerMarker preserves thinking and toolCalls while replacing pre-marker prose with finalAnswer', () => {
    const call1 = delegation('oim-ops');
    const blocks = [
      { thinking: 'step 1', text: 'Let me delegate first.', toolCalls: [call1] },
      { text: `Planning revision...\n${ANSWER_MARKER}\nClean final answer.` },
    ];
    const cleaned = stripBeforeAnswerMarker(blocks, 'Clean final answer.');
    expect(cleaned).toEqual([
      { thinking: 'step 1', toolCalls: [call1] },
      { text: 'Clean final answer.' },
    ]);
  });
});

describe('renderReviewTask and renderReviewFollowUp (OrchestrationService parity)', () => {
  const evidence = [
    makeChunkEntry(CHUNK_1_ID, 'Body of chunk 1 about VB.Net scripts.'),
    makeChunkEntry(CHUNK_2_ID, 'Body of chunk 2 about LDAP connectors.'),
  ];

  it('renderReviewTask cite-scopes evidence to cited chunks and records sent chunks in SentLedger', () => {
    const sent = new SentLedger();
    const answer = `Selection scripts use VB.Net [${CHUNK_1_ID}].`;
    const task = renderReviewTask('How do scripts work?', answer, evidence, sent);

    expect(task).toContain('## Original question\nHow do scripts work?');
    expect(task).toContain(`## Candidate answer\n${answer}`);
    expect(task).toContain(EVIDENCE_HEADING);
    expect(task).toContain('Body of chunk 1 about VB.Net scripts.');
    expect(task).not.toContain('Body of chunk 2 about LDAP connectors.');
    expect(task).toContain(`id=${CHUNK_1_ID}`);
    expect(task).not.toContain(CHUNK_2_ID);
  });

  it('renderReviewTask states (no evidence was captured) when evidence list is empty', () => {
    const task = renderReviewTask('Q?', 'A', []);
    expect(task).toContain('(no evidence was captured)');
  });

  it('renderReviewFollowUp sends only newly cited chunks and reports (none — ...) when all cited chunks were already sent', () => {
    const sent = new SentLedger();
    const draft1 = `Scripts use VB.Net [${CHUNK_1_ID}].`;
    renderReviewTask('Q?', draft1, evidence, sent);

    // Follow-up citing the same chunk 1 -> fresh is blank -> "(none — every source this revision cites is already above)"
    const followUpSame = renderReviewFollowUp(draft1, evidence, sent);
    expect(followUpSame).toContain('## Revised candidate answer');
    expect(followUpSame).toContain('(none — every source this revision cites is already above)');

    // Follow-up newly citing chunk 2 -> chunk 2 body is sent
    const draft2 = `Scripts use VB.Net [${CHUNK_1_ID}] and LDAP [${CHUNK_2_ID}].`;
    const followUpNew = renderReviewFollowUp(draft2, evidence, sent);
    expect(followUpNew).toContain('Body of chunk 2 about LDAP connectors.');
    expect(followUpNew).not.toContain('(none — every source this revision cites is already above)');
  });
});

describe('idsUnderReview and buildRevisionPrompt (OrchestrationService.renderRevisionTask parity)', () => {
  const evidence = [
    makeChunkEntry(CHUNK_1_ID, 'Chunk 1 content'),
    makeChunkEntry(CHUNK_2_ID, 'Chunk 2 content'),
  ];

  it('idsUnderReview extracts UUIDs named anywhere in verdict feedback/fixes/claims, or falls back to draft', () => {
    const verdictWithId = {
      approved: false,
      feedback: `Chunk ${CHUNK_2_ID} does not say this.`,
      citationFixes: [],
      unsupportedClaims: [],
    };
    expect(idsUnderReview(verdictWithId, `Draft [${CHUNK_1_ID}]`)).toBe(`[${CHUNK_2_ID}]\n`);

    const verdictWithoutId = {
      approved: false,
      feedback: 'The second paragraph is unsupported.',
      citationFixes: [],
      unsupportedClaims: [],
    };
    expect(idsUnderReview(verdictWithoutId, `Draft [${CHUNK_1_ID}]`)).toBe(`Draft [${CHUNK_1_ID}]`);
  });

  it('buildRevisionPrompt separates citationFixes and unsupportedClaims and forbids Task delegation on citation-only verdicts', () => {
    const prompt = buildRevisionPrompt({
      verdict: {
        approved: false,
        feedback: 'Wrong citation on claim 1.',
        citationFixes: [`Swap [${CHUNK_2_ID}] to [${CHUNK_1_ID}]`],
        unsupportedClaims: [],
      },
      newEvidence: [],
      allEvidence: evidence,
      draft: `Claim 1 [${CHUNK_2_ID}].`,
    });

    expect(prompt).toContain('## The sources your answer currently cites');
    expect(prompt).toContain('Chunk 2 content');
    expect(prompt).toContain('Chunk 1 content');
    expect(prompt).toContain(REVIEW_FEEDBACK_HEADING);
    expect(prompt).toContain('## Citation fixes — no research needed');
    expect(prompt).not.toContain('## Unsupported claims');
    expect(prompt).toContain('Every objection above is a citation fix, so this revision needs no new evidence at all — do NOT call the Task tool.');
  });

  it('buildRevisionPrompt includes deduped newEvidence when specialists ran in the round and permits delegation for unsupportedClaims', () => {
    const prompt = buildRevisionPrompt({
      verdict: {
        approved: false,
        feedback: 'Claim X has no backing.',
        citationFixes: [],
        unsupportedClaims: ['Claim X about Kerberos delegation'],
      },
      newEvidence: evidence,
      allEvidence: evidence,
      draft: `Draft [${CHUNK_1_ID}]`,
    });

    expect(prompt).toContain('## Source evidence behind the specialist answers above');
    expect(prompt).toContain('Chunk 1 content');
    expect(prompt).toContain('Chunk 2 content');
    expect(prompt).toContain('## Unsupported claims');
    expect(prompt).toContain('- Claim X about Kerberos delegation');
    expect(prompt).toContain('Delegate again only for material that is genuinely missing above.');
  });
});

describe('reviewFlagNote and unreviewedNote', () => {
  it('includes attempt count and reviewer feedback in reviewFlagNote (or unspecified concerns fallback)', () => {
    expect(reviewFlagNote(1, 'Missing citation on claim 2')).toBe(
      '\n\n---\n⚠️ *This answer did not pass automated review after 1 attempt(s). Reviewer notes: Missing citation on claim 2*',
    );
    expect(reviewFlagNote(3)).toBe(
      '\n\n---\n⚠️ *This answer did not pass automated review after 3 attempt(s). Reviewer notes: unspecified concerns*',
    );
  });

  it('renders unreviewedNote when automated review failed to run', () => {
    expect(unreviewedNote()).toBe(
      '\n\n---\n⚠️ *This answer could not be checked — the automated review failed to run, so nothing has validated its claims or citations. Treat it as unverified.*',
    );
  });
});

describe('reviewAttempts', () => {
  it('counts reviewer delegations only', () => {
    expect(reviewAttempts([delegation('oim-customers'), delegation('reviewer'), delegation('reviewer')])).toBe(2);
    expect(reviewAttempts([{ id: '1', name: qualifyTool('get_section'), input: {} }])).toBe(0);
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

import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { newTurnContext, parseVerdict, translateMessage } from '../src/main/agent/translate';
import { buildOrchestrator, mapSpecialistTools, ORCHESTRATOR_AGENT } from '../src/main/agent/orchestration';
import { COMPUTE_TOOLS } from '../src/main/agent/computeTools';
import type { AppSettings, McpPromptInfo, OrchestratorProfile } from '../src/shared/types';
import type { McpPrompts } from '../src/main/agent/McpPrompts';
import { qualifyTool } from '../src/shared/types';

function msg(partial: Record<string, unknown>): SDKMessage {
  return { uuid: 'u', session_id: 's', ...partial } as unknown as SDKMessage;
}

const baseSettings = {
  webSearch: { enabled: false, allowedDomains: [] },
} as unknown as AppSettings;

describe('parseVerdict', () => {
  it('reads APPROVED as the first line', () => {
    expect(parseVerdict('APPROVED\nAll claims grounded.')).toEqual({ approved: true, feedback: 'All claims grounded.' });
  });
  it('reads REJECTED and keeps feedback', () => {
    expect(parseVerdict('REJECTED\nFabricated endpoint /X.')).toEqual({ approved: false, feedback: 'Fabricated endpoint /X.' });
  });
  it('tolerates trailing punctuation / whitespace on the verdict line', () => {
    expect(parseVerdict('  Approved. \nfine')).toEqual({ approved: true, feedback: 'fine' });
  });
  it('falls back to scanning when the token is not on the first line', () => {
    expect(parseVerdict('The answer is fine.\nVerdict: APPROVED')?.approved).toBe(true);
  });
  it('drops the reviewer\'s pre-verdict deliberation, keeping only what follows the verdict line', () => {
    // Observed shape: the reviewer thinks out loud, states REJECTED on its own line, then the notes.
    const raw = 'Let me assess.\nThe correct verdict is REJECTED: no evidence.\n\nREJECTED\n\nUnsupported: the sort-order claim.';
    expect(parseVerdict(raw)).toEqual({ approved: false, feedback: 'Unsupported: the sort-order claim.' });
  });
  it('returns null when no verdict token is present', () => {
    expect(parseVerdict('hmm, unsure')).toBeNull();
  });
});

describe('mapSpecialistTools', () => {
  it('prefixes bare tool names and adds ToolSearch + compute tools; never Bash', () => {
    const info = { tools: ['search_corpus', 'get_section'] } as McpPromptInfo;
    const tools = mapSpecialistTools(info, baseSettings);
    expect(tools).toContain(qualifyTool('search_corpus'));
    expect(tools).toContain(qualifyTool('get_section'));
    expect(tools).toContain('ToolSearch');
    for (const t of COMPUTE_TOOLS) expect(tools).toContain(t);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('WebSearch');
  });
  it('never gives a specialist Bash (code execution is unavailable)', () => {
    const info = { tools: ['search_corpus'] } as McpPromptInfo;
    expect(mapSpecialistTools(info, baseSettings)).not.toContain('Bash');
    expect(mapSpecialistTools(undefined, baseSettings)).not.toContain('Bash');
  });
  it('includes WebSearch only when enabled in settings', () => {
    const info = { tools: ['search_corpus'] } as McpPromptInfo;
    const withWeb = { webSearch: { enabled: true, allowedDomains: [] } } as unknown as AppSettings;
    expect(mapSpecialistTools(info, withWeb)).toContain('WebSearch');
  });
});

describe('orchestrator-mode translation', () => {
  it('records a delegation and emits subagent-start; keeps it out of turn text', () => {
    const ctx = newTurnContext('t1');
    const events = translateMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Delegating.' },
            { type: 'tool_use', id: 'agent1', name: 'Agent', input: { subagent_type: 'oim-developer-api', prompt: 'REST roles?' } },
          ],
        },
      }),
      ctx,
    );
    expect(ctx.agentCalls.has('agent1')).toBe(true);
    expect(events.some((e) => e.kind === 'subagent-start')).toBe(true);
    const start = events.find((e) => e.kind === 'subagent-start');
    if (start?.kind !== 'subagent-start') throw new Error('expected subagent-start');
    expect(start.subagentType).toBe('oim-developer-api');
    // The orchestrator's own text is retained; the Agent call is tracked as a tool call.
    expect(ctx.turnText).toBe('Delegating.');
    expect(ctx.toolCalls.find((c) => c.id === 'agent1')?.subagentType).toBe('oim-developer-api');
  });

  it('nests forwarded sub-agent messages and never pollutes the orchestrator answer', () => {
    const ctx = newTurnContext('t1');
    translateMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'agent1', name: 'Agent', input: { subagent_type: 'oim-developer-api' } }] },
      }),
      ctx,
    );
    // A forwarded sub-agent assistant message (parent set) must not touch turnText/blocks.
    const events = translateMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: 'agent1',
        message: { content: [{ type: 'text', text: 'searching the corpus…' }, { type: 'tool_use', id: 'inner1', name: qualifyTool('search_corpus'), input: {} }] },
      }),
      ctx,
    );
    expect(events).toEqual([]);
    expect(ctx.turnText).toBe('');
    const agentCall = ctx.agentCalls.get('agent1');
    expect(agentCall?.subagentBlocks?.[0].text).toBe('searching the corpus…');
    expect(agentCall?.subagentBlocks?.[0].toolCalls?.[0].name).toBe(qualifyTool('search_corpus'));
  });

  it('parses a reviewer verdict from the delegation result', () => {
    const ctx = newTurnContext('t1');
    translateMessage(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'rev1', name: 'Agent', input: { subagent_type: 'reviewer' } }] },
      }),
      ctx,
    );
    const events = translateMessage(
      msg({
        type: 'user',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'rev1', content: [{ type: 'text', text: 'REJECTED\nUnsupported claim X.' }], is_error: false }] },
      }),
      ctx,
    );
    const verdict = events.find((e) => e.kind === 'review-verdict');
    if (verdict?.kind !== 'review-verdict') throw new Error('expected review-verdict');
    expect(verdict.approved).toBe(false);
    expect(verdict.feedback).toBe('Unsupported claim X.');
    expect(ctx.toolCalls.find((c) => c.id === 'rev1')?.verdict?.approved).toBe(false);
    expect(events.some((e) => e.kind === 'subagent-complete')).toBe(true);
  });

  it('ignores stream deltas that belong to a sub-agent', () => {
    const ctx = newTurnContext('t1');
    const events = translateMessage(
      msg({
        type: 'stream_event',
        parent_tool_use_id: 'agent1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'noise' } },
      }),
      ctx,
    );
    expect(events).toEqual([]);
    expect(ctx.liveText).toBe('');
  });
});

describe('buildOrchestrator prompt composition', () => {
  const BASE = 'BASE-PROMPT: cite as [1] and end with ## References.';

  const profile = {
    name: 'OIM',
    orchestratorPlaybook: 'oim-orchestrator',
    reviewerPlaybook: 'oim-orchestrator-reviewer',
    specialistPlaybooks: ['oim-access-governance'],
  } as unknown as OrchestratorProfile;

  const settings = {
    webSearch: { enabled: false, allowedDomains: [] },
    orchestrator: {
      maxReviewRounds: 2,
      maxSpecialistCalls: 8,
      orchestratorMaxTurns: 20,
      specialistMaxTurns: 20,
      orchestrator: { model: 'claude-x', thinkingLevel: 'high' },
      specialist: { model: 'claude-x', thinkingLevel: 'high' },
      reviewer: { model: 'claude-x', thinkingLevel: 'high' },
    },
  } as unknown as AppSettings;

  const fakePrompts = {
    list: async () => [] as McpPromptInfo[],
    getText: async (name: string) => `PLAYBOOK(${name})`,
  } as unknown as McpPrompts;

  it('runs the orchestrator under the base prompt', async () => {
    // The orchestrator writes the user-facing answer. It used to get its control playbook alone —
    // the only agent never shown the citation contract — which is what produced answers full of
    // raw [chunk_id=<uuid>] tokens.
    const built = await buildOrchestrator(profile, settings, fakePrompts, BASE);
    expect(built.agents[ORCHESTRATOR_AGENT].prompt).toContain(BASE);
    expect(built.agents[ORCHESTRATOR_AGENT].prompt).toContain('PLAYBOOK(oim-orchestrator)');
  });

  it('keeps the specialist under the base prompt too', async () => {
    const built = await buildOrchestrator(profile, settings, fakePrompts, BASE);
    expect(built.agents['oim-access-governance'].prompt).toContain(BASE);
  });

  it('leaves the reviewer on its playbook alone', async () => {
    // Deliberate: it emits a plain-text verdict, so answer-formatting rules are noise for it.
    const built = await buildOrchestrator(profile, settings, fakePrompts, BASE);
    const reviewer = Object.entries(built.agents).find(([k]) => k.includes('review'))?.[1];
    expect(reviewer?.prompt).not.toContain(BASE);
  });

  it('puts the playbook after the base prompt so role rules win on conflict', async () => {
    const built = await buildOrchestrator(profile, settings, fakePrompts, BASE);
    const p = built.agents[ORCHESTRATOR_AGENT].prompt;
    expect(p.indexOf(BASE)).toBeLessThan(p.indexOf('PLAYBOOK(oim-orchestrator)'));
  });

  it('degrades to the playbook alone when no base prompt is supplied', async () => {
    const built = await buildOrchestrator(profile, settings, fakePrompts, '');
    expect(built.agents[ORCHESTRATOR_AGENT].prompt).toContain('PLAYBOOK(oim-orchestrator)');
  });
});

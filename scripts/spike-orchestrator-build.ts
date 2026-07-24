/**
 * Exercises the REAL desktop orchestrator-build path (McpPrompts.list/getText + buildOrchestrator)
 * against the live MCP server — proving the agents map + allow-list assemble from actual playbooks.
 *   npm run spike:build
 */
import { qualifyTool, type AppSettings, type OrchestratorProfile } from '../src/shared/types';
import { McpPrompts } from '../src/main/agent/McpPrompts';
import { buildOrchestrator } from '../src/main/agent/orchestration';
import { SyncClient } from '../src/main/sync/SyncClient';

const SERVER = process.env.YVOKE_SERVER ?? 'http://localhost:8080';

const settings = {
  serverBaseUrl: SERVER,
  mcpTransport: 'http',
  webSearch: { enabled: false, allowedDomains: [] },
  orchestrator: {
    orchestrator: { model: 'opus', thinkingLevel: 'high' },
    reviewer: { model: 'opus', thinkingLevel: 'high' },
    specialist: { model: 'haiku', thinkingLevel: 'medium' },
    maxReviewRounds: 2,
    maxSpecialistCalls: 8,
    orchestratorMaxTurns: 60,
    specialistMaxTurns: 20,
  },
} as unknown as AppSettings;

const profile: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-orchestrator',
  reviewerPlaybook: 'oim-orchestrator-reviewer',
  specialistPlaybooks: ['oim-access-governance', 'oim-developer-api'],
};

async function main(): Promise<void> {
  const mcpPrompts = new McpPrompts({
    getSettings: () => settings,
    auth: { headers: async () => ({ Authorization: 'Bearer dev-local-token' }) },
  });

  const sync = new SyncClient({ getBaseUrl: () => SERVER, getToken: async () => 'dev-local-token' });
  const baseSystemPrompt = await sync.getSystemPrompt('default-chat');
  console.log('base system prompt chars:', baseSystemPrompt.length);

  const { agents, allowedTools, specialistNames } = await buildOrchestrator(profile, settings, mcpPrompts, baseSystemPrompt);

  console.log('agent keys:', Object.keys(agents).join(', '));
  console.log('specialists:', specialistNames.join(', '));
  for (const [name, def] of Object.entries(agents)) {
    console.log(
      `  ${name}: model=${def.model} effort=${def.effort} maxTurns=${def.maxTurns} tools=${def.tools?.length} promptChars=${def.prompt.length}`,
    );
  }
  console.log('allowedTools:', JSON.stringify(allowedTools));

  // Assertions
  const orch = agents.orchestrator;
  const rev = agents.reviewer;
  const assert = (cond: boolean, label: string): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
    if (!cond) process.exitCode = 1;
  };
  assert(orch.prompt.includes('Desktop runtime adapter'), 'orchestrator has adapter preamble');
  assert(orch.prompt.includes('oim-access-governance') && orch.prompt.includes('oim-developer-api'), 'roster lists both specialists');
  assert(orch.tools?.includes('Task') === true, 'orchestrator can delegate (Task)');
  assert(rev.prompt.includes('APPROVED') && rev.prompt.includes('REJECTED'), 'reviewer adapter defines verdict tokens');
  assert(
    JSON.stringify(rev.tools) === JSON.stringify([qualifyTool('verify_citations'), qualifyTool('get_section')]),
    'reviewer is validate-only',
  );
  assert(allowedTools.includes('Task') && allowedTools.includes(qualifyTool('search_corpus')), 'allow-list unions Task + specialist tools');
  assert(agents['oim-access-governance'].prompt.length > 200, 'specialist prompt text loaded from server');
  assert(
    baseSystemPrompt.length > 0 && agents['oim-access-governance'].prompt.includes(baseSystemPrompt),
    'specialist runs under the server base system prompt (grounding + citation contract)',
  );
  // Reversed deliberately. This previously asserted the orchestrator does NOT get the base prompt,
  // pinning the very defect it should have caught: the agent that writes the user-facing answer was
  // the only one never shown the citation contract, so answers came back full of raw
  // [chunk_id=<uuid>] tokens. The orchestrator now runs under it, like the specialists.
  assert(
    orch.prompt.includes(baseSystemPrompt),
    'orchestrator runs under the server base system prompt (it writes the final answer)',
  );
  assert(
    !rev.prompt.includes(baseSystemPrompt),
    'reviewer still uses its control playbook alone (emits a verdict, not prose)',
  );

  mcpPrompts.reset();
}

main().catch((e) => {
  console.error('build spike failed:', e);
  process.exit(1);
});

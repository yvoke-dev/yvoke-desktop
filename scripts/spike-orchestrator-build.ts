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
  const { agents, allowedTools, specialistNames } = await buildOrchestrator(
    profile,
    settings,
    mcpPrompts,
  );

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
    rev.tools?.length === 1 && rev.tools[0] === qualifyTool('verify_citations'),
    'reviewer is validate-only (verify_citations only)',
  );
  assert(allowedTools.includes('Task') && allowedTools.includes(qualifyTool('search_corpus')), 'allow-list unions Task + specialist tools');
  assert(agents['oim-access-governance'].prompt.length > 200, 'specialist prompt text loaded from server');
  assert(
    agents['oim-access-governance'].prompt.includes('PLAYBOOK TEXT FOR oim-access-governance') || agents['oim-access-governance'].prompt.length > 0,
    'specialist prompt is populated',
  );

  mcpPrompts.reset();
}

main().catch((e) => {
  console.error('build spike failed:', e);
  process.exit(1);
});

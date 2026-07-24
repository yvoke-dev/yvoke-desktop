/**
 * Verifies the desktop → server run-trace persistence path end-to-end against the live server:
 * create conversation → append (user+assistant) messages → POST the run trace linked to the assistant
 * message. Prints the ids so the DB can be inspected. Run in mock-auth mode (dev-local-token).
 *   npm run spike:persist
 */
import { SyncClient } from '../src/main/sync/SyncClient';
import { buildRunTrace } from '../src/main/agent/runTrace';
import { qualifyTool, type ChatMessage, type OrchestratorProfile, type OrchestratorSettings } from '../src/shared/types';

const SERVER = process.env.YVOKE_SERVER ?? 'http://localhost:8080';

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

async function main(): Promise<void> {
  const client = new SyncClient({
    getBaseUrl: () => SERVER,
    getToken: async () => 'dev-local-token',
  });

  const conversation = await client.createConversation('Desktop MAS persistence spike', { client: 'desktop' });
  console.log('conversation:', conversation.id);

  const { ids } = await client.appendMessages(conversation.id, [
    { role: 'user', content: 'Difference between business and system roles, and reading roles via REST?' },
    { role: 'assistant', content: 'Business roles model org structure; system roles bundle entitlements. [chunk_id=abc]' },
  ]);
  const assistantServerId = ids[1];
  console.log('message ids:', ids.join(', '), '| assistant:', assistantServerId);

  const assistant: ChatMessage = {
    localId: 'a1',
    role: 'assistant',
    content: 'Business roles model org structure; system roles bundle entitlements. [chunk_id=abc]',
    toolCalls: [
      { id: 'd1', name: 'Agent', input: { subagent_type: 'oim-access-governance', prompt: 'business vs system role?' }, subagentType: 'oim-access-governance', result: 'Business roles… system roles…', subagentBlocks: [{ text: 'searching', toolCalls: [{ id: 'i1', name: qualifyTool('search_corpus'), input: { q: 'role' }, result: 'rows' }] }] },
      { id: 'd2', name: 'Agent', input: { subagent_type: 'oim-developer-api', prompt: 'read roles via REST?' }, subagentType: 'oim-developer-api', result: 'Use the Assignments API…' },
      { id: 'r1', name: 'Agent', input: { subagent_type: 'reviewer', prompt: 'validate' }, subagentType: 'reviewer', result: 'APPROVED\nAll claims grounded.', verdict: { approved: true, feedback: 'All claims grounded.' } },
    ],
    usage: { inputTokens: 1200, outputTokens: 640, cacheReadTokens: 300, cacheWriteTokens: 0, thoughtTokens: 90 },
    createdAt: 'now',
  };

  const payload = buildRunTrace({
    conversationId: conversation.id,
    userText: 'Difference between business and system roles, and reading roles via REST?',
    assistant,
    profileName: 'OIM',
    profile,
    orchestrator,
  });
  if (!payload) throw new Error('buildRunTrace returned null');
  payload.messageId = assistantServerId;

  const { id: runId } = await client.recordOrchestratorRun(payload);
  console.log('agent_run id:', runId);
  console.log('steps posted:', payload.steps.length, '| status:', payload.status, '| reviewRounds:', payload.reviewRounds);
  console.log('\nInspect with:');
  console.log(`  agent_runs:  SELECT id, message_id, profile_name, status, review_rounds, total_tokens FROM agent_runs WHERE id='${runId}';`);
  console.log(`  agent_steps: SELECT seq, role, round, playbook_name, model FROM agent_steps WHERE agent_run_id='${runId}' ORDER BY seq;`);
}

main().catch((e) => {
  console.error('persist spike failed:', e);
  process.exit(1);
});

/**
 * MAS spike: validates the multi-agent (orchestrator + specialists + reviewer) mechanics
 * on the Claude Agent SDK before any desktop wiring exists.
 *   npm run spike:mas -- "your cross-topic OIM question"
 *
 * Requires: the Spring app running (localhost:8080, APP_SECURITY_MOCK=true) and ambient
 * Claude Code credentials. Playbook texts are read from files dumped out of the DB into
 * scratchpad/pb/<name>.md (see the accompanying shell setup).
 *
 * Validates the riskiest assumptions:
 *  1. The exact allowedTools token for delegation ('Task' vs 'Agent').
 *  2. Sub-agents (specialists/reviewer) connect to the oim MCP server and are confined to
 *     their declared tools.
 *  3. forwardSubagentText yields renderable nested messages tagged with parent_tool_use_id.
 *  4. Per-sub-agent usage is observable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, type AgentDefinition, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, qualifyTool } from '../src/shared/types';

const SERVER = process.env.YVOKE_SERVER ?? 'http://localhost:8080';
const PB_DIR =
  process.env.PB_DIR ??
  '/private/tmp/claude-501/-Users-eduardpal-work-yvoke-yvoke-web/90749093-fd43-4636-a83b-eacc1dc642b8/scratchpad/pb';
const QUESTION =
  process.argv.slice(2).join(' ') ||
  'What is the difference between a business role and a system role in OIM, and how can I read a person\'s assigned roles through the REST API?';

const read = (name: string): string => fs.readFileSync(path.join(PB_DIR, `${name}.md`), 'utf8').trim();

const kb = (tools: string[]): string[] => tools.map(qualifyTool);

const ORCH_ADAPTER = (roster: string) => `

---
## Desktop runtime adapter (how your tools work here)

You have NO \`call_specialist\` tool. To consult a specialist, call the **Task** tool with
\`subagent_type\` set to the specialist's name and \`prompt\` set to a fully self-contained question
(include the version/tag and any entity names). The Task result is that specialist's grounded answer.

To have your composed answer reviewed, call the **Task** tool with \`subagent_type: "reviewer"\`,
passing the original question, your candidate answer, and the evidence in the \`prompt\`.

Available specialists (subagent_type → coverage):
${roster}
`;

const REVIEWER_ADAPTER = `

---
## Desktop runtime adapter

There is no \`submit_review\` tool here. End your turn with your verdict as text: the FIRST line must
be exactly \`APPROVED\` or \`REJECTED\`, followed by concise, actionable feedback (name any unsupported
claims).`;

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: QUESTION }, parent_tool_use_id: null };
}

async function main(): Promise<void> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth only

  const accessGovTools = kb([
    'ask_clarifying_question', 'get_graph_neighbors', 'get_json_schema', 'get_section',
    'get_toc', 'list_documents', 'query_json_objects', 'search_corpus', 'search_graph_entities',
    'verify_citations',
  ]);
  const devApiTools = kb([
    'ask_clarifying_question', 'get_graph_neighbors', 'get_section', 'get_toc', 'list_documents',
    'search_corpus', 'search_graph_entities', 'verify_citations',
  ]);
  const reviewerTools = kb(['verify_citations', 'get_section']);

  const roster =
    '- `oim-access-governance` — roles, entitlements, IT Shop, approvals, attestation.\n' +
    '- `oim-developer-api` — REST/SOAP API, connectors, scripting, developer topics.';

  const agents: Record<string, AgentDefinition> = {
    orchestrator: {
      description: 'Coordinates specialists and composes one grounded answer.',
      prompt: read('oim-orchestrator') + ORCH_ADAPTER(roster),
      tools: ['Task', qualifyTool('ask_clarifying_question')],
      model: 'sonnet',
    },
    'oim-access-governance': {
      description: 'Roles, entitlements, IT Shop, approvals, attestation.',
      prompt: read('oim-access-governance'),
      tools: accessGovTools,
      model: 'haiku',
    },
    'oim-developer-api': {
      description: 'REST/SOAP API, connectors, scripting, developer topics.',
      prompt: read('oim-developer-api'),
      tools: devApiTools,
      model: 'haiku',
    },
    reviewer: {
      description: 'Validates the composed answer against gathered evidence. Never searches anew.',
      prompt: read('oim-orchestrator-reviewer') + REVIEWER_ADAPTER,
      tools: reviewerTools,
      model: 'sonnet',
    },
  };

  const allowedTools = [
    'Task',
    ...new Set([...accessGovTools, ...devApiTools, ...reviewerTools, qualifyTool('ask_clarifying_question')]),
  ];

  console.log('question:', QUESTION);
  console.log('allowedTools:', JSON.stringify(allowedTools));
  console.log('---');

  const q = query({
    prompt: prompt(),
    options: {
      agent: 'orchestrator',
      agents,
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: `${SERVER}/mcp`, headers: { Authorization: 'Bearer dev-local-token' } },
      },
      allowedTools,
      forwardSubagentText: true,
      settingSources: [],
      includePartialMessages: false,
      model: 'sonnet',
      maxTurns: 60,
      env,
    },
  });

  // Track per-agent activity so we can prove confinement + attribution.
  const seenTools = new Set<string>();
  const subagentMsgs = new Map<string, number>();

  for await (const message of q) {
    const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    const tag = parent ? `  [sub ${parent.slice(0, 8)}]` : '[main]';

    if (message.type === 'system' && message.subtype === 'init') {
      const tools = message.tools as string[];
      console.log('session:', message.session_id, '| model:', message.model);
      console.log('mcp servers:', JSON.stringify(message.mcp_servers));
      console.log('Task tool visible on main:', tools.includes('Task'), '| Agent visible:', tools.includes('Agent'));
      console.log('knowledge-base tools visible:', tools.filter((t) => t.startsWith(MCP_TOOL_PREFIX)).length);
      console.log('agent-ish tools:', tools.filter((t) => /task|agent/i.test(t)).join(', ') || 'none');
      console.log('---');
    } else if (message.type === 'assistant') {
      if (parent) subagentMsgs.set(parent, (subagentMsgs.get(parent) ?? 0) + 1);
      for (const block of message.message.content as Array<{ type: string; name?: string; text?: string; input?: unknown }>) {
        if (block.type === 'tool_use') {
          seenTools.add(block.name ?? '?');
          const sub = block.name === 'Task' ? ` subagent_type=${(block.input as { subagent_type?: string })?.subagent_type}` : '';
          console.log(`${tag} → tool: ${block.name}${sub}`);
        }
        if (block.type === 'text' && block.text?.trim()) {
          console.log(`${tag} ${block.text.trim().slice(0, 200).replace(/\n/g, ' ')}`);
        }
      }
    } else if (message.type === 'result') {
      console.log('---');
      console.log('subtype:', message.subtype, '| turns:', message.num_turns, '| duration:', message.duration_ms, 'ms');
      console.log('usage:', JSON.stringify(message.usage));
      console.log('cost (USD):', (message as { total_cost_usd?: number }).total_cost_usd);
      console.log('distinct tools used:', [...seenTools].join(', '));
      console.log('sub-agent message counts by parent tool_use:', JSON.stringify([...subagentMsgs]));
    }
  }
}

main().catch((error) => {
  console.error('Spike failed:', error);
  process.exit(1);
});

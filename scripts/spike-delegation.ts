/**
 * Delegation spike: proves a REAL orchestrator turn gets answers back from its specialists and a
 * parseable verdict from the reviewer — not "Async agent launched successfully" launch receipts.
 *
 *   npm run spike:delegation -- "your question"
 *
 * Requires: the Spring app running (localhost:8080, dev token) and ambient Claude Code credentials.
 * Uses the app's own builders and the app's own CLI environment (`debugEnv`), so it exercises the
 * switch that keeps delegation synchronous. Unit tests cannot: what the CLI does with the Agent tool
 * is only visible in a live run, and a regression there fails silently — answers still read well.
 *
 * Exits non-zero if any delegation returns a receipt, if nothing was delegated, or if a reviewer reply
 * carries no APPROVED/REJECTED verdict. Whether the lead chooses to consult the reviewer at all is the
 * model's call, and the app re-prompts for it in code (REVIEW_ENFORCEMENT_PROMPT), so a run without one
 * is reported, not failed — run it again to exercise the reviewer.
 */
import fs from 'node:fs';
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  BASE_SYSTEM_PROMPT_NAME,
  parseVerdict,
  resolveCanonicalModel,
  type AppSettings,
  type OrchestratorProfile,
} from '../src/shared/types';
import { McpPrompts } from '../src/main/agent/McpPrompts';
import { buildMcpServers } from '../src/main/agent/McpConnection';
import { buildOrchestrator, ORCHESTRATOR_AGENT, REVIEWER_SUBAGENT } from '../src/main/agent/orchestration';
import { buildAutoApproveTools, buildCanUseTool } from '../src/main/agent/policy';
import { claudeBinaryPath, debugEnv } from '../src/main/agent/AgentService';
import { SyncClient } from '../src/main/sync/SyncClient';

const SERVER = process.env.YVOKE_SERVER ?? 'http://localhost:8080';
const TOKEN = 'dev-local-token';
const QUESTION = process.argv.slice(2).join(' ') || 'What is a business role in One Identity Manager?';
const RECEIPT = /Async agent launched/i;

// The shipped bundle, as the app loads it, pointed at the local server.
const settings = {
  ...JSON.parse(fs.readFileSync('settings.json', 'utf8')),
  serverBaseUrl: SERVER,
  mcpTransport: 'http',
  webSearch: { enabled: false, allowedDomains: [] },
} as AppSettings;

const profile: OrchestratorProfile = {
  name: 'OIM',
  orchestratorPlaybook: 'oim-orchestrator',
  reviewerPlaybook: 'oim-orchestrator-reviewer',
  specialistPlaybooks: ['oim-access-governance', 'oim-developer-api'],
};

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const mcpPrompts = new McpPrompts({ getSettings: () => settings, auth: { headers: async () => headers } });
  const sync = new SyncClient({ getBaseUrl: () => SERVER, getToken: async () => TOKEN });
  const base = await sync.getSystemPrompt(BASE_SYSTEM_PROMPT_NAME);
  const built = await buildOrchestrator(profile, settings, mcpPrompts, base, (name) => sync.getSystemPrompt(name));

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: QUESTION }, parent_tool_use_id: null };
  }

  const binary = claudeBinaryPath();
  const options: Options = {
    systemPrompt: '',
    mcpServers: buildMcpServers(settings, headers),
    allowedTools: buildAutoApproveTools(built.allowedTools),
    disallowedTools: ['Bash'],
    canUseTool: buildCanUseTool(() => settings, 'spike', undefined, built.allowedTools, undefined, true),
    settingSources: [],
    model: resolveCanonicalModel(settings.orchestrator!.orchestrator.model),
    maxTurns: settings.orchestrator!.orchestratorMaxTurns,
    agent: ORCHESTRATOR_AGENT,
    agents: built.agents,
    forwardSubagentText: true,
    env: debugEnv(),
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
  };

  console.log('question:', QUESTION);
  const delegated = new Map<string, string>(); // tool_use id -> subagent type
  const results: { subagent: string; text: string }[] = [];

  for await (const m of query({ prompt: prompt(), options }) as AsyncIterable<SDKMessage>) {
    if ('parent_tool_use_id' in m && m.parent_tool_use_id) continue; // a subagent's own traffic; only the lead's delegations matter here
    const content = (m as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (m.type === 'assistant' && block.type === 'tool_use' && block.name === 'Agent') {
        const type = String((block.input as { subagent_type?: unknown })?.subagent_type ?? '?');
        delegated.set(String(block.id), type);
        console.log(`  → delegate to ${type}`);
      } else if (m.type === 'user' && block.type === 'tool_result' && delegated.has(String(block.tool_use_id))) {
        const raw = block.content;
        const text = Array.isArray(raw) ? raw.map((c: { text?: string }) => c.text ?? '').join(' ') : String(raw);
        results.push({ subagent: delegated.get(String(block.tool_use_id))!, text });
        console.log(`  ← ${delegated.get(String(block.tool_use_id))}: ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }

  const reviewer = results.filter((r) => r.subagent === REVIEWER_SUBAGENT);
  assert(results.length > 0, `the orchestrator delegated (${results.length} delegation result(s))`);
  assert(results.every((r) => !RECEIPT.test(r.text)), 'no delegation came back as an "Async agent launched" receipt');
  if (reviewer.length === 0) {
    console.log('NOTE  the lead answered without consulting the reviewer this run; re-run to exercise the reviewer');
  } else {
    assert(reviewer.every((r) => parseVerdict(r.text) !== null), "every reviewer reply carries a verdict");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

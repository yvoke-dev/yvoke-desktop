/**
 * Web-search spike: proves the WebSearch path end-to-end without the Spring server or the UI.
 *   npm run spike:websearch -- "your question"
 *   npm run spike:websearch -- --domains en.wikipedia.org "your question"
 *
 * It drives the REAL policy code (buildAllowedTools + buildCanUseTool from src/main/agent/policy.ts),
 * so a pass here means the shipped gate works, not a reimplementation of it. Every permission
 * decision is printed, including the allowed_domains the gate injects into the tool input.
 *
 * Also runs two control cases that must FAIL to search: feature off, and feature on with an
 * empty allow-list. A green run shows all three.
 *
 * Requires ambient Claude Code credentials. No knowledge-base server needed — no mcpServers are
 * configured, so the KB tools simply do not exist for this run.
 */
import { query, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildAllowedTools, buildCanUseTool } from '../src/main/agent/policy';
import type { AppSettings } from '../src/shared/types';

const argv = process.argv.slice(2);
const domainsFlag = argv.indexOf('--domains');
const domains =
  domainsFlag >= 0 ? (argv[domainsFlag + 1] ?? '').split(',').filter(Boolean) : ['en.wikipedia.org'];
if (domainsFlag >= 0) argv.splice(domainsFlag, 2);
const QUESTION =
  argv.join(' ') ||
  'Search the web: what year was the Apollo 11 Moon landing, and what is the exact page title of the source you used?';

function settingsWith(enabled: boolean, allowedDomains: string[]): AppSettings {
  return { webSearch: { enabled, allowedDomains } } as unknown as AppSettings;
}

/** Wrap the production gate so every decision it makes is visible. */
function tracing(inner: CanUseTool, seen: string[]): CanUseTool {
  return async (toolName, input, options) => {
    const result = await inner(toolName, input, options);
    if (result.behavior === 'allow') {
      const injected = (result as { updatedInput?: Record<string, unknown> }).updatedInput?.allowed_domains;
      seen.push(`ALLOW ${toolName}${injected ? ` allowed_domains=${JSON.stringify(injected)}` : ''}`);
    } else {
      seen.push(`DENY  ${toolName} — ${(result as { message?: string }).message ?? ''}`);
    }
    return result;
  };
}

async function* once(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

async function run(label: string, settings: AppSettings): Promise<{ searched: boolean; decisions: string[] }> {
  const decisions: string[] = [];
  const allowedTools = buildAllowedTools(settings);
  console.log(`\n━━ ${label}`);
  console.log(`   allowedTools includes WebSearch: ${allowedTools.includes('WebSearch')}`);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth only, as the app does

  const q = query({
    prompt: once(QUESTION),
    options: {
      systemPrompt:
        'You are a test harness. If a WebSearch tool is available, you MUST use it to answer. ' +
        'If it is not available or is denied, say so plainly and stop.',
      allowedTools,
      disallowedTools: ['Bash'],
      canUseTool: tracing(buildCanUseTool(() => settings), decisions),
      settingSources: [],
      includePartialMessages: false,
      model: 'sonnet',
      maxTurns: 6,
      env,
    },
  });

  let searched = false;
  let answer = '';
  for await (const message of q) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          console.log(`   → tool_use ${block.name} ${JSON.stringify(block.input).slice(0, 160)}`);
          if (block.name === 'WebSearch') searched = true;
        }
        if (block.type === 'text') answer += block.text;
      }
    }
    if (message.type === 'result' && 'result' in message) answer = String(message.result ?? answer);
  }
  for (const d of decisions) console.log(`   ${d}`);
  console.log(`   answer: ${answer.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  return { searched, decisions };
}

async function main(): Promise<void> {
  console.log(`question: ${QUESTION}`);
  console.log(`domains : ${domains.join(', ')}`);

  const on = await run(`CASE 1 — enabled, domains=[${domains.join(', ')}] (expect a real search)`, settingsWith(true, domains));
  const empty = await run('CASE 2 — enabled, NO domains (expect deny, fail-closed)', settingsWith(true, []));
  const off = await run('CASE 3 — disabled (expect WebSearch not offered at all)', settingsWith(false, domains));

  const injected = on.decisions.some((d) => d.startsWith('ALLOW WebSearch') && d.includes('allowed_domains'));
  const deniedEmpty = empty.decisions.some((d) => d.startsWith('DENY  WebSearch'));
  const results = [
    ['search actually ran with domains injected', on.searched && injected],
    ['empty allow-list denied the search', !empty.searched || deniedEmpty],
    ['disabled never allowed a search', off.decisions.every((d) => !d.startsWith('ALLOW WebSearch'))],
  ] as const;

  console.log('\n━━ VERDICT');
  for (const [name, ok] of results) console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
}

void main();

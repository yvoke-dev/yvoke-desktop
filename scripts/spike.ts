/**
 * Wave-0 spike: validates the riskiest assumptions end-to-end before any UI exists.
 *   npm run spike -- "your question"
 *
 * Requires: the Spring app running locally (APP_SECURITY_MOCK=true is fine — the MCP
 * chain accepts any bearer in mock mode) and ambient Claude Code credentials.
 *
 * Validates: SSE MCP transport + tool naming, subscription auth, allowed-tools
 * confinement, maxThinkingTokens, per-turn usage fields, and runtime setters.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from '../src/shared/types';

const SERVER = process.env.YVOKE_SERVER ?? 'http://localhost:8080';
const QUESTION = process.argv.slice(2).join(' ') || 'Which manuals are available in the knowledge base? List a few titles.';

async function* prompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: QUESTION },
    parent_tool_use_id: null,
  };
}

async function main(): Promise<void> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // subscription auth only

  const q = query({
    prompt: prompt(),
    options: {
      systemPrompt: 'You are Yvoke, a knowledge-base assistant. Use the available knowledge-base tools.',
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: `${SERVER}/mcp`,
          headers: { Authorization: 'Bearer dev-local-token' },
        },
      },
      allowedTools: [`${MCP_TOOL_PREFIX}*`],
      settingSources: [],
      includePartialMessages: false,
      maxThinkingTokens: 4096,
      model: 'sonnet',
      maxTurns: 10,
      env,
    },
  });

  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') {
      console.log('session:', message.session_id);
      console.log('model:', message.model);
      console.log('mcp servers:', JSON.stringify(message.mcp_servers));
      console.log('knowledge-base tools visible:', message.tools.filter((t: string) => t.startsWith(MCP_TOOL_PREFIX)).length);
    } else if (message.type === 'assistant') {
      for (const block of message.message.content as Array<{ type: string; name?: string; text?: string }>) {
        if (block.type === 'tool_use') console.log(`→ tool: ${block.name}`);
        if (block.type === 'text' && block.text) console.log(block.text);
      }
    } else if (message.type === 'result') {
      console.log('---');
      console.log('subtype:', message.subtype, '| turns:', message.num_turns, '| duration:', message.duration_ms, 'ms');
      console.log('usage:', JSON.stringify(message.usage));
      console.log('cost (USD, informational):', (message as { total_cost_usd?: number }).total_cost_usd);
    }
  }
}

main().catch((error) => {
  console.error('Spike failed:', error);
  process.exit(1);
});

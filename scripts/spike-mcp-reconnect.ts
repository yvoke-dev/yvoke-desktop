/**
 * CLI MCP dynamic reconnect spike: proves that the Claude Code CLI reconnects
 * an existing MCP server with updated headers when `query.setMcpServers()` is called.
 *
 *   npx tsx scripts/spike-mcp-reconnect.ts
 *
 * Starts a stub MCP HTTP server on 127.0.0.1, connects the SDK/CLI subprocess with an
 * initial Authorization bearer, then calls setMcpServers with a refreshed bearer and
 * verifies the subprocess issues a new initialize request with the updated token.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeBinaryPath } from '../src/main/agent/AgentService';

async function main() {
  console.log('--- Claude CLI Dynamic MCP Reconnect Spike ---');

  const receivedAuthHeaders: string[] = [];

  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] ?? '';
    receivedAuthHeaders.push(auth);
    console.log(`[MCP Server] HTTP ${req.method} ${req.url} — Authorization: "${auth}"`);

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      let json: any = {};
      try {
        json = JSON.parse(body);
      } catch {
        // ignore
      }

      const method = json.method;
      console.log(`[MCP Server] RPC Method: ${method}`);

      if (method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: json.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'reconnect-stub', version: '1.0.0' },
            },
          }),
        );
      } else if (method === 'tools/list') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: json.id,
            result: {
              tools: [
                {
                  name: 'test_tool',
                  description: 'A test tool for reconnection verification',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          }),
        );
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: json.id,
            result: {},
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
  console.log(`[MCP Server] Listening on ${mcpUrl}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-spike-reconnect-'));
  const promptQueue: SDKUserMessage[] = [];
  let queueResolver: (() => void) | null = null;
  let queueClosed = false;

  const asyncIterable = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          while (promptQueue.length === 0 && !queueClosed) {
            await new Promise<void>((resolve) => {
              queueResolver = resolve;
            });
          }
          if (promptQueue.length > 0) {
            return { value: promptQueue.shift()!, done: false };
          }
          return { value: undefined as any, done: true };
        },
      };
    },
  };

  function pushUser(text: string) {
    promptQueue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    });
    if (queueResolver) {
      const r: () => void = queueResolver;
      queueResolver = null;
      r();
    }
  }

  const binary = claudeBinaryPath();
  const q = query({
    prompt: asyncIterable,
    options: {
      mcpServers: {
        yvoke: {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Bearer token-initial-123' },
        },
      },
      allowedTools: [],
      disallowedTools: ['Bash'],
      settingSources: [],
      cwd: tempDir,
      pathToClaudeCodeExecutable: binary ?? undefined,
    },
  });

  try {
    pushUser('Hello, initialize tools.');

    // Wait briefly for initial MCP connection
    await new Promise((r) => setTimeout(r, 2000));

    console.log('Received auth headers before reconnect:', receivedAuthHeaders);
    if (!receivedAuthHeaders.some((h) => h === 'Bearer token-initial-123')) {
      throw new Error('Initial connection did not use Bearer token-initial-123');
    }

    console.log('Updating MCP server headers via setMcpServers()...');
    const updateResult = await q.setMcpServers({
      yvoke: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: 'Bearer token-refreshed-456' },
      },
    });

    console.log('setMcpServers result:', updateResult);

    // Give subprocess a moment to re-initialize with new bearer
    await new Promise((r) => setTimeout(r, 1500));

    console.log('Received auth headers after reconnect:', receivedAuthHeaders);
    if (!receivedAuthHeaders.some((h) => h === 'Bearer token-refreshed-456')) {
      throw new Error('Reconnection did NOT send Bearer token-refreshed-456');
    }

    console.log('✅ CLI Dynamic Reconnection SUCCESS: Bearer token-refreshed-456 was received by MCP server!');
  } finally {
    queueClosed = true;
    if (queueResolver) {
      const r: () => void = queueResolver;
      r();
    }
    q.close();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ Spike failed:', err);
  process.exit(1);
});

/**
 * In-process MCP server exposing the sandboxed JavaScript computation helper (computeTools.ts)
 * to the model as `mcp__compute__execute_code`. Runs inside a zero-privilege `node:vm` context
 * in the main process with no shell, filesystem, or network access — the cross-platform,
 * Windows-safe alternative to the `Bash` tool.
 */
import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { COMPUTE_SERVER_NAME, executeCode, formatExecuteCodeOutput } from './computeTools';

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const ERROR_PREFIX_RE = /^[A-Za-z0-9_]*Error:/;

function formatFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return ERROR_PREFIX_RE.test(msg) ? msg : `Error: ${msg}`;
}

/** Fresh in-process compute server; the SDK namespaces its tools as `mcp__compute__<name>`. */
export function buildComputeServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COMPUTE_SERVER_NAME,
    version: '1.0.0',
    instructions:
      'Safe in-process JavaScript computation sandbox. Use execute_code for arithmetic, statistics, date math, and data transformations.',
    tools: [
      tool(
        'execute_code',
        'Execute JavaScript code in an isolated, zero-privilege in-memory sandbox (no filesystem, network, shell, or timers). ' +
          'Standard ECMAScript built-ins (Math, Date, Intl, JSON, Array, Object, Map, Set, RegExp, BigInt, console) are available. ' +
          'Returns the value of the final expression (or top-level return statement) along with any console.log output.',
        {
          code: z
            .string()
            .describe(
              'JavaScript expression or script to evaluate, e.g. "[12, 15, 20].reduce((a, b) => a + b, 0) / 3"',
            ),
        },
        async ({ code }): Promise<CallToolResult> => {
          try {
            return ok(formatExecuteCodeOutput(executeCode(code)));
          } catch (err) {
            return fail(formatFailure(err));
          }
        },
      ),
    ],
  });
}

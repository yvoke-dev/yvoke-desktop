import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AppSettings } from '../../shared/types';
import { MCP_SERVER_NAME } from '../../shared/types';
import { buildComputeServer } from './computeServer';
import { COMPUTE_SERVER_NAME } from './computeTools';

export interface McpAuthProvider {
  /** Headers attached to the MCP connection; empty while /mcp/** ran open (pre-M19). */
  headers(): Promise<Record<string, string>>;
}

export const NO_AUTH_PROVIDER: McpAuthProvider = {
  headers: async () => ({}),
};

export async function buildMcpServers(
  settings: AppSettings,
  provider: McpAuthProvider,
): Promise<Record<string, McpServerConfig>> {
  const url = `${settings.serverBaseUrl.replace(/\/+$/, '')}/mcp`;
  const headers = await provider.headers();
  return {
    [MCP_SERVER_NAME]: {
      type: settings.mcpTransport,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    // Safe, in-process compute tools (calculate/statistics/date_diff). No shell/fs/network.
    [COMPUTE_SERVER_NAME]: buildComputeServer(),
  };
}

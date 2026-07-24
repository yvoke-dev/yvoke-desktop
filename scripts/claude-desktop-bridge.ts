import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { PublicClientApplication } from '@azure/msal-node';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

let CLIENT_ID = process.env.YVOKE_CLIENT_ID || '';
let TENANT_ID = process.env.YVOKE_TENANT_ID || '';
let SCOPE = process.env.YVOKE_SCOPE || '';

try {
  const settingsPath = path.join(__dirname, '../settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.entra) {
      if (!CLIENT_ID) CLIENT_ID = settings.entra.clientId || '';
      if (!TENANT_ID) TENANT_ID = settings.entra.tenantId || '';
      if (!SCOPE) SCOPE = settings.entra.scope || '';
    }
  }
} catch (e) {
  console.error('Failed to load settings.json in bridge:', e);
}

const TOKEN_CACHE_PATH = path.join(os.homedir(), '.yvoke-mcp-token.json');

interface CachedToken {
  accessToken: string;
  expiresOn: string;
}

function getAzToken(scope: string): string | null {
  const resource = scope.includes('/') ? scope.substring(0, scope.lastIndexOf('/')) : scope;
  const tenantOpt = TENANT_ID ? `--tenant "${TENANT_ID}"` : '';
  console.error(`Requesting Azure CLI token with scope: "${scope}" (Resource: "${resource}"), Tenant: "${TENANT_ID || 'default'}"`);
  try {
    const stdout = execSync(
      `az account get-access-token ${tenantOpt} --scope "${scope}" --query accessToken --output tsv`,
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
    );
    return stdout.trim();
  } catch (e) {
    try {
      const stdout = execSync(
        `az account get-access-token ${tenantOpt} --resource "${resource}" --query accessToken --output tsv`,
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
      );
      return stdout.trim();
    } catch (e2) {
      console.error('Azure CLI token request failed.');
      return null;
    }
  }
}

function getCachedToken(): string | null {
  try {
    if (fs.existsSync(TOKEN_CACHE_PATH)) {
      const data: CachedToken = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
      if (new Date(data.expiresOn).getTime() > Date.now() + 5 * 60 * 1000) {
        return data.accessToken;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function saveCachedToken(accessToken: string, expiresOn: Date) {
  try {
    const data: CachedToken = {
      accessToken,
      expiresOn: expiresOn.toISOString(),
    };
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write token cache:', e);
  }
}

async function getMsalToken(): Promise<string> {
  console.error(`Starting interactive MSAL login for Client ID: ${CLIENT_ID}, Tenant ID: ${TENANT_ID}, Scope: ${SCOPE}`);
  
  const pca = new PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: `https://login.microsoftonline.com/${TENANT_ID}`,
    }
  });

  const response = await pca.acquireTokenInteractive({
    scopes: [SCOPE],
    openBrowser: async (url) => {
      console.error(`Opening browser to sign in: ${url}`);
      const start = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${start} "${url.replace(/"/g, '\\"')}"`);
    },
    successTemplate: '<html><body><h1>Authentication Successful</h1><p>You can close this tab and return to Claude Desktop.</p></body></html>',
  });

  if (!response || !response.accessToken) {
    throw new Error('Failed to acquire access token from MSAL.');
  }

  saveCachedToken(response.accessToken, response.expiresOn || new Date(Date.now() + 3600 * 1000));
  return response.accessToken;
}

async function getAccessToken(): Promise<string> {
  if (process.env.YVOKE_TOKEN) {
    console.error('Using YVOKE_TOKEN from environment variables.');
    return process.env.YVOKE_TOKEN;
  }

  const cached = getCachedToken();
  if (cached) {
    console.error('Using cached Entra ID token.');
    return cached;
  }

  console.error('Attempting to retrieve token from Azure CLI...');
  const azToken = getAzToken(SCOPE);
  if (azToken) {
    console.error('Successfully acquired token from Azure CLI.');
    return azToken;
  }

  console.error('Azure CLI token unavailable. Prompting interactive MSAL login...');
  return await getMsalToken();
}

async function main() {
  try {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };
    
    const serverUrlStr = process.env.YVOKE_SERVER_URL || 'https://app.yvoke.dev';
    const serverUrl = new URL('/mcp', serverUrlStr);
    
    console.error(`Connecting to remote SSE MCP server at: ${serverUrl.href}`);

    const clientTransport = new SSEClientTransport(serverUrl, {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
      },
    });

    const serverTransport = new StdioServerTransport();

    clientTransport.onmessage = (message) => {
      serverTransport.send(message).catch((err) => {
        console.error('Error forwarding message to Claude Desktop:', err);
      });
    };

    serverTransport.onmessage = (message) => {
      clientTransport.send(message).catch((err) => {
        console.error('Error forwarding message to remote MCP server:', err);
      });
    };

    clientTransport.onerror = (err) => {
      console.error('Remote SSE transport error:', err);
    };

    serverTransport.onerror = (err) => {
      console.error('Claude Desktop Stdio transport error:', err);
    };

    clientTransport.onclose = () => {
      console.error('Remote SSE connection closed.');
      process.exit(0);
    };

    serverTransport.onclose = () => {
      console.error('Claude Desktop Stdio connection closed.');
      process.exit(0);
    };

    await clientTransport.start();
    await serverTransport.start();
    
    console.error('Yvoke MCP Bridge is fully initialized and bridging messages.');
  } catch (error) {
    console.error('Bridge failed to start:', error);
    process.exit(1);
  }
}

main();

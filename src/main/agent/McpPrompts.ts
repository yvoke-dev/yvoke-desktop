import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppSettings, CitationRef, McpPromptInfo } from '../../shared/types';
import { log, logError } from '../log';
import type { McpAuthProvider } from './McpConnection';

export interface McpPromptsDeps {
  getSettings: () => AppSettings;
  auth: McpAuthProvider;
}

/**
 * Direct MCP access to the server over the same transport + auth the agent uses:
 *  - prompts/list + prompts/get for the SKILL.md playbooks (the Agent SDK exposes server
 *    *tools* but not server *prompts* as slash commands, so we resolve them ourselves);
 *  - tools/call for on-demand citation lookups (`get_section`) when the user clicks a
 *    `[chunk_id=…]` marker, independent of any agent turn.
 */
/** Per-request timeout (ms). A live call answers in ~tens of ms; this bounds a stale hang. */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * The server serializes a tool's String return as a JSON-encoded string (quoted, with
 * `\n` escapes), so the markdown arrives as `"# Section…\n…"`. Unwrap it back to raw
 * markdown; leave already-raw text untouched.
 */
function unwrapJsonString(text: string): string {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* not a JSON string — fall through */
    }
  }
  return text;
}

export class McpPrompts {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private listCache: { at: number; prompts: McpPromptInfo[] } | null = null;

  constructor(private readonly deps: McpPromptsDeps) {}

  /**
   * Run an MCP request on the (cached) client, retrying once on a fresh connection if it
   * fails. A long-lived SSE stream can die silently — idle/proxy/laptop-sleep — without
   * firing `onclose`, leaving a cached client that hangs until timeout; the retry reconnects.
   */
  private async run<T>(op: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await op(await this.connect());
    } catch (err) {
      logError('mcp', `request failed (${err instanceof Error ? err.message : String(err)}); reconnecting and retrying once`);
      this.reset();
      return op(await this.connect());
    }
  }

  async list(): Promise<McpPromptInfo[]> {
    // Short TTL: the playbook set is static, but re-check occasionally and on cache miss.
    if (this.listCache && Date.now() - this.listCache.at < 60_000) {
      return this.listCache.prompts;
    }
    const result = await this.run((client) => client.listPrompts(undefined, { timeout: REQUEST_TIMEOUT_MS }));
    const prompts: McpPromptInfo[] = result.prompts.map((p) => ({
      name: p.name,
      title: p.title ?? p.name,
      description: p.description ?? '',
      arguments: (p.arguments ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
      tools: Array.isArray((p as any).meta?.tools) ? ((p as any).meta.tools as unknown[]).map(String) : undefined,
      codeExecution:
        typeof (p as any).meta?.codeExecution === 'boolean' ? ((p as any).meta.codeExecution as boolean) : undefined,
    }));
    this.listCache = { at: Date.now(), prompts };
    return prompts;
  }

  /** Returns the prompt's messages concatenated into a single playbook string. */
  async getText(name: string, args?: Record<string, string>): Promise<string> {
    const result = await this.run((client) =>
      client.getPrompt({ name, arguments: args ?? {} }, { timeout: REQUEST_TIMEOUT_MS }),
    );
    return result.messages
      .map((m) => {
        const c = m.content;
        return c && typeof c === 'object' && 'type' in c && c.type === 'text' ? String(c.text) : '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Resolve a citation marker to its source section markdown via the `get_section`
   * tool (the same hierarchical retrieval the web "Citation Source" popup uses).
   */
  async getSection(ref: CitationRef): Promise<string> {
    // Only the parameters the server's `get_section` tool actually declares (document_id, chunk_id,
    // document, heading_path). The tool schema forbids extra properties, so passing anything else
    // (e.g. max_chars/version) makes the whole call fail validation. The server already returns the
    // full section/document text, so no cap parameter is needed.
    const args: Record<string, unknown> = {};
    if (ref.chunkId) args.chunk_id = ref.chunkId;
    if (ref.documentId) args.document_id = ref.documentId;
    if (ref.file) args.document = ref.file;
    const result = await this.run((client) =>
      client.callTool({ name: 'get_section', arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS }),
    );
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((c) => c.type === 'text')
      .map((c) => unwrapJsonString(c.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
    if (result.isError) {
      throw new Error(text || 'Citation lookup failed.');
    }
    return text;
  }

  /** Drop the cached connection (e.g. server URL / auth changed). */
  reset(): void {
    void this.client?.close().catch(() => undefined);
    this.client = null;
    this.connecting = null;
    this.listCache = null;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.openClient()
      .then((c) => {
        this.client = c;
        this.connecting = null;
        return c;
      })
      .catch((err) => {
        this.connecting = null;
        throw err;
      });
    return this.connecting;
  }

  private async openClient(): Promise<Client> {
    const settings = this.deps.getSettings();
    const url = new URL(`${settings.serverBaseUrl.replace(/\/+$/, '')}/mcp`);
    const headers = await this.deps.auth.headers();
    const transport = this.buildTransport(settings, url, headers);
    const client = new Client({ name: 'yvoke-desktop', version: '0.1.0' });
    // A dropped SSE stream should not leave a stale client cached.
    transport.onclose = () => {
      if (this.client?.transport === transport) {
        this.client = null;
      }
    };
    await client.connect(transport);
    const server = client.getServerVersion();
    log('mcp', `direct client connected to ${url.href} (${settings.mcpTransport}) — server: ${server?.name ?? '?'} v${server?.version ?? '?'}`);
    void this.logCapabilities(client);
    return client;
  }

  /** One-time discovery dump of what the server offers: tools, prompts, resources. */
  private async logCapabilities(client: Client): Promise<void> {
    const caps = client.getServerCapabilities() ?? {};
    log('mcp', `server capabilities: ${Object.keys(caps).join(', ') || 'none reported'}`);
    if (caps.tools) {
      try {
        const { tools } = await client.listTools();
        log('mcp', `tools (${tools.length}): ${tools.map((t) => t.name).join(', ') || 'none'}`);
      } catch (e) {
        logError('mcp', 'listTools failed:', e instanceof Error ? e.message : String(e));
      }
    }
    if (caps.prompts) {
      try {
        const { prompts } = await client.listPrompts();
        log('mcp', `prompts (${prompts.length}): ${prompts.map((p) => p.name).join(', ') || 'none'}`);
      } catch (e) {
        logError('mcp', 'listPrompts failed:', e instanceof Error ? e.message : String(e));
      }
    }
    if (caps.resources) {
      try {
        const { resources } = await client.listResources();
        log('mcp', `resources (${resources.length}): ${resources.map((r) => r.uri).join(', ') || 'none'}`);
      } catch (e) {
        logError('mcp', 'listResources failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  private buildTransport(settings: AppSettings, url: URL, headers: Record<string, string>): Transport {
    if (settings.mcpTransport === 'http') {
      return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    }
    return new SSEClientTransport(url, {
      requestInit: { headers },
      // The EventSource (GET stream) needs the bearer too; default EventSource can't set headers.
      eventSourceInit: {
        fetch: (input: string | URL | Request, init?: RequestInit) =>
          fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
      },
    });
  }
}

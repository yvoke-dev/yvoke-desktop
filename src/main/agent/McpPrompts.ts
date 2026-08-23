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
 *    `[<uuid>]` marker (or a legacy `[chunk_id=…]` one), independent of any agent turn.
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

/** The shape this mapper needs from a prompts/list entry, without depending on the SDK's types. */
export interface RawPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
  _meta?: unknown;
  /** Not a field MCP defines — read only so a server that sends it is not ignored. */
  meta?: unknown;
}

/**
 * Map one prompts/list entry into the app's shape.
 *
 * Exported for tests, because this mapping is where the app quietly lost every playbook's
 * declared constraints: it read `p.meta`, and MCP puts prompt metadata under `p._meta`. `tools`
 * and `codeExecution` were therefore undefined for all 31 playbooks, buildAllowedTools fell
 * through to DEFAULT_KB_TOOLS every time, and the compute-tool gate in policy.ts could never
 * close — the client ran every playbook with broader permissions than the playbook asked for.
 * Nothing caught it because the policy layer was well tested and this mapping was not.
 */
export function toPromptInfo(raw: RawPrompt): McpPromptInfo {
  const meta = (raw._meta ?? raw.meta ?? {}) as Record<string, unknown>;
  return {
    name: raw.name,
    title: raw.title ?? raw.name,
    description: raw.description ?? '',
    arguments: (raw.arguments ?? []).map((a) => ({
      name: a.name,
      description: a.description,
      required: a.required,
    })),
    tools: Array.isArray(meta.tools) ? (meta.tools as unknown[]).map(String) : undefined,
    codeExecution: typeof meta.codeExecution === 'boolean' ? meta.codeExecution : undefined,
    targetAgent: typeof meta.targetAgent === 'string' ? meta.targetAgent : undefined,
  };
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
    const prompts: McpPromptInfo[] = result.prompts.map(toPromptInfo);
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
   *
   * A bare `[<uuid>]` marker — what the server's prompts now instruct models to write — names a
   * row without saying which table it is in. It is a CHUNK id in almost every case (`search_corpus`
   * and `get_section` both hand the model a per-passage `id=`), and a DOCUMENT id in the minority
   * of cases where the model held no chunk id, e.g. a `search_graph_entities` row. So both are
   * tried, chunk first. The web backend's `CitationVerifier` already resolves a bare id against
   * both tables to decide it is real; resolving it against only one to decide what to SHOW is the
   * inconsistency this avoids (`citation-render.js` hard-codes `data-chunk-id`, which is why a bare
   * document id reads as "This source is no longer available" in the browser).
   */
  async getSection(ref: CitationRef): Promise<string> {
    if (ref.id) {
      const asChunk = await this.callGetSection({ chunk_id: ref.id });
      if (asChunk.ok) return asChunk.text;
      const asDocument = await this.callGetSection({ document_id: ref.id });
      if (asDocument.ok) return asDocument.text;
      // Neither table has it. Report the chunk attempt: that is the likelier intent, so its
      // message is the more useful one, and a stale id fails identically either way.
      throw new Error(asChunk.text || 'Citation lookup failed.');
    }

    // Only the parameters the server's `get_section` tool actually declares (document_id, chunk_id,
    // document, heading_path). The tool schema forbids extra properties, so passing anything else
    // (e.g. max_chars/version) makes the whole call fail validation. The server already returns the
    // full section/document text, so no cap parameter is needed.
    const args: Record<string, unknown> = {};
    if (ref.chunkId) args.chunk_id = ref.chunkId;
    if (ref.documentId) args.document_id = ref.documentId;
    if (ref.file) args.document = ref.file;
    const call = await this.callGetSection(args);
    if (!call.ok) {
      throw new Error(call.text || 'Citation lookup failed.');
    }
    return call.text;
  }

  /**
   * One `get_section` call, with failure reported rather than thrown so a caller can try again
   * under a different parameter.
   *
   * `ok` is NOT just `!isError`. `GetSectionTool` catches its own exceptions and returns
   * `McpToolUtils.toolError(...)` — a plain string beginning `ERROR:` — with no error flag set, so
   * a missing chunk arrives as a successful call whose body is an error message. Treating that as
   * content is what rendered `ERROR: the 'get_section' tool failed to complete the request.` inside
   * the citation dialog as if it were the cited passage.
   */
  private async callGetSection(
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; text: string }> {
    const result = await this.run((client) =>
      client.callTool({ name: 'get_section', arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS }),
    );
    const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = blocks
      .filter((c) => c.type === 'text')
      .map((c) => unwrapJsonString(c.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
    const failed = !!result.isError || /^\s*(ERROR|Error):/.test(text);
    return { ok: !failed, text };
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

/** Typed client for the Desktop Sync API (/api/desktop/v1) on the Spring server. */

import type { LoginVerificationResult, OrchestratorProfile, OrchestratorRunPayload } from '../../shared/types';
import {
  hasErrorSourcePrefix,
  isNetworkError,
  sanitizeLogContent,
  tagAttributedError,
} from '../../shared/error';

/** The system prompt every conversation starts from; also the connection probe's target. */
export const BASE_SYSTEM_PROMPT_NAME = 'default-chat';

/** How long the connection probe waits before calling the server unreachable. */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Whatever the server said, made safe to render in the About pane: bearer tokens redacted (a
 * gateway that echoes the request would otherwise hand one back) and length capped, since the
 * body may be a multi-kilobyte HTML error page.
 */
function probeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const safe = sanitizeLogContent(raw).trim();
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}

export interface ConversationDto {
  id: string;
  title: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  thoughtTokens: number | null;
  createdAt: string;
  feedbackRating: number | null;
  feedbackComment: string | null;
}

export interface NewMessagePayload {
  role: 'user' | 'assistant';
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  thoughtTokens?: number | null;
}

export class SyncApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SyncClientDeps {
  getBaseUrl: () => string;
  getToken: (forceInteractive?: boolean) => Promise<string>;
  fetchFn?: typeof fetch;
}

export class SyncClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: SyncClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private url(p: string): string {
    return `${this.deps.getBaseUrl().replace(/\/+$/, '')}/api/chat/v1${p}`;
  }

  /** One automatic retry with a fresh (interactive if needed) token on 401. */
  private async request<T>(method: string, p: string, body?: unknown, retried = false): Promise<T> {
    let token: string;
    try {
      token = await this.deps.getToken(retried);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (hasErrorSourcePrefix(msg, 'Entra')) {
        throw err;
      }
      throw new Error(tagAttributedError('Yvoke Backend', err));
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.url(p), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new Error(tagAttributedError('Yvoke Backend', err));
    }

    if (response.status === 401 && !retried) {
      return this.request<T>(method, p, body, true);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const raw = `${method} ${p} failed (${response.status}): ${text}`;
      throw new SyncApiError(response.status, tagAttributedError('Yvoke Backend', raw));
    }
    if (response.status === 204) {
      return undefined as T;
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new Error(tagAttributedError('Yvoke Backend', err));
    }
  }

  listConversations(): Promise<ConversationDto[]> {
    return this.request('GET', '/conversations?limit=200&offset=0');
  }

  createConversation(title: string | null, settings: Record<string, unknown>): Promise<ConversationDto> {
    return this.request('POST', '/conversations', { title, settings });
  }

  /**
   * `title` is omitted from the body when undefined — a settings-only PATCH must not carry a title
   * at all, or it risks clearing the name the server derived from the conversation's first question.
   */
  updateConversation(
    conversationId: string,
    title: string | null | undefined,
    settings?: Record<string, unknown>,
  ): Promise<void> {
    return this.request('PATCH', `/conversations/${conversationId}`, {
      ...(title !== undefined ? { title } : {}),
      settings,
    });
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.request('DELETE', `/conversations/${conversationId}`);
  }

  getMessages(conversationId: string): Promise<MessageDto[]> {
    return this.request('GET', `/conversations/${conversationId}/messages?limit=500&offset=0`);
  }

  appendMessages(conversationId: string, messages: NewMessagePayload[]): Promise<{ ids: string[] }> {
    return this.request('POST', `/conversations/${conversationId}/messages`, { messages });
  }

  submitFeedback(messageId: string, rating: 1 | -1, comment?: string): Promise<{ messageId: string; rating: number; comment: string | null }> {
    return this.request('PUT', `/messages/${messageId}/feedback`, { rating, comment: comment ?? null });
  }

  getSystemPrompt(name: string): Promise<string> {
    return this.request<{ systemPrompt: string }>('GET', `/prompts/system/${name}`)
      .then((res) => res.systemPrompt);
  }

  /** Multi-agent profiles available for orchestrator mode; empty if none configured. */
  getOrchestratorProfiles(): Promise<OrchestratorProfile[]> {
    return this.request('GET', '/orchestrator/profiles');
  }

  /** Persist a completed local multi-agent run (agent_runs + agent_steps) for the admin viewer. */
  recordOrchestratorRun(payload: OrchestratorRunPayload): Promise<{ id: string }> {
    return this.request('POST', '/orchestrator/runs', payload);
  }

  /**
   * Probe the Sync API with a token the caller already holds (spec chapter 5).
   *
   * `token` is required on purpose: an optional one used to fall through to `getToken`, which
   * escalates to an interactive MSAL sign-in and opens a browser — the one thing this check
   * promises not to do.
   */
  async verifyConnection(
    token: string,
    timeoutMs: number = VERIFY_TIMEOUT_MS,
  ): Promise<LoginVerificationResult> {
    const baseUrl = this.deps.getBaseUrl();
    if (!baseUrl || !baseUrl.trim()) {
      return { status: 'unreachable', message: 'Server URL not configured' };
    }

    // A server that accepts the connection and never answers would otherwise hold this for
    // undici's 300s default, with the About pane's button disabled the whole time.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(this.url(`/prompts/system/${BASE_SYSTEM_PROMPT_NAME}`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted || isNetworkError(err)) {
        return { status: 'unreachable', message: 'Server unreachable' };
      }
      // A URL that will not parse, or a header value the fetch rejects, is our configuration
      // being wrong — not the server being down. Say so rather than blaming the network.
      return { status: 'error', message: probeMessage(err) };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      return { status: 'expired', message: 'Server refused credentials (401 Unauthorized)' };
    }
    if (response.status === 429) {
      return { status: 'rate_limited', message: 'Rate limit exceeded' };
    }
    if (response.status !== 200 && response.status !== 204) {
      const text = await response.text().catch(() => '');
      return {
        status: 'error',
        message: text
          ? `Server error (${response.status}): ${probeMessage(text)}`
          : `Server error (${response.status})`,
      };
    }

    // An SSO reverse proxy answers an unauthenticated API GET with 200 and a sign-in page, so
    // the status code alone proves nothing. Insist on the payload this endpoint actually serves.
    const body = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(body) as { systemPrompt?: unknown };
      if (typeof parsed?.systemPrompt !== 'string') throw new Error('unexpected shape');
    } catch {
      return {
        status: 'expired',
        message: 'Server answered with a sign-in page rather than data — credentials were not accepted.',
      };
    }
    return { status: 'ok' };
  }
}

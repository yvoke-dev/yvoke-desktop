/** Typed client for the Desktop Sync API (/api/desktop/v1) on the Spring server. */

import type { OrchestratorProfile, OrchestratorRunPayload } from '../../shared/types';

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
    const token = await this.deps.getToken(retried);
    const response = await this.fetchFn(this.url(p), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !retried) {
      return this.request<T>(method, p, body, true);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SyncApiError(response.status, `${method} ${p} failed (${response.status}): ${text}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
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
}

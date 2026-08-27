import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { newTurnContext, translateMessage, usageFromSdk } from '../src/main/agent/translate';
import { MCP_SERVER_NAME, qualifyTool } from '../src/shared/types';

function msg(partial: Record<string, unknown>): SDKMessage {
  return { uuid: 'u', session_id: 's', ...partial } as unknown as SDKMessage;
}

describe('SDK message translation', () => {
  it('captures session id and mcp status from the init message', () => {
    const ctx = newTurnContext('t1');
    const events = translateMessage(
      msg({ type: 'system', subtype: 'init', mcp_servers: [{ name: MCP_SERVER_NAME, status: 'connected' }] }),
      ctx,
    );
    expect(ctx.sessionId).toBe('s');
    expect(events).toEqual([{ kind: 'mcp-status', threadId: 't1', servers: [{ name: MCP_SERVER_NAME, status: 'connected' }] }]);
  });

  it('accumulates live text from stream_event deltas', () => {
    const ctx = newTurnContext('t1');
    translateMessage(msg({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }), ctx);
    const events = translateMessage(
      msg({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }),
      ctx,
    );
    expect(events).toEqual([{ kind: 'live-text', threadId: 't1', text: 'Hello' }]);
  });

  it('emits assistant blocks with tool calls and accumulates turn text', () => {
    const ctx = newTurnContext('t1');
    const events = translateMessage(
      msg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'tu1', name: qualifyTool('search_corpus'), input: { query: 'person' } },
          ],
        },
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.kind !== 'assistant-block') throw new Error('expected assistant-block');
    expect(event.text).toBe('Let me search.');
    expect(event.toolCalls).toEqual([{ id: 'tu1', name: qualifyTool('search_corpus'), input: { query: 'person' } }]);
    expect(ctx.turnText).toBe('Let me search.');
    expect(ctx.liveText).toBe('');
  });

  it('attaches tool results to the matching call and emits tool-result', () => {
    const ctx = newTurnContext('t1');
    translateMessage(
      msg({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: qualifyTool('search_corpus'), input: {} }] },
      }),
      ctx,
    );
    const events = translateMessage(
      msg({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'rows' }], is_error: false }] },
      }),
      ctx,
    );
    expect(events).toEqual([{ kind: 'tool-result', threadId: 't1', toolUseId: 'tu1', result: 'rows', isError: false }]);
    expect(ctx.toolCalls[0].result).toBe('rows');
  });

  it('maps SDK usage fields to UsageTotals', () => {
    expect(
      usageFromSdk({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, thinking_tokens: 15 }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, thoughtTokens: 15 });
    expect(usageFromSdk(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thoughtTokens: 0 });
  });

  it('handles Agent tool calls as delegations only when orchestratorMode is true', () => {
    const orchCtx = newTurnContext('t1', true);
    const orchEvents = translateMessage(
      msg({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'oim-customers', prompt: 'hi' } }],
        },
      }),
      orchCtx,
    );
    expect(orchEvents).toEqual([
      { kind: 'subagent-start', threadId: 't1', toolUseId: 'tu1', subagentType: 'oim-customers', question: 'hi' },
      {
        kind: 'assistant-block',
        threadId: 't1',
        text: '',
        thinking: undefined,
        toolCalls: [{ id: 'tu1', name: 'Agent', input: { subagent_type: 'oim-customers', prompt: 'hi' }, subagentType: 'oim-customers', subagentBlocks: [] }],
      },
    ]);

    const singleCtx = newTurnContext('t2', false);
    const singleEvents = translateMessage(
      msg({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { prompt: 'hi' } }],
        },
      }),
      singleCtx,
    );
    expect(singleEvents).toEqual([
      {
        kind: 'assistant-block',
        threadId: 't2',
        text: '',
        thinking: undefined,
        toolCalls: [{ id: 'tu2', name: 'Agent', input: { prompt: 'hi' } }],
      },
    ]);
  });
});

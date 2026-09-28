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

  describe('Task 1.3: Clarification effectiveIsError handling in translateMessage', () => {
    it('inverts error flag for valid clarification answers even if SDK reports is_error: true', () => {
      const ctx = newTurnContext('t1');
      translateMessage(
        msg({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'clarif-1', name: 'AskUserQuestion', input: { question: 'Pick env' } }],
          },
        }),
        ctx,
      );

      const events = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'clarif-1',
                content: [{ type: 'text', text: 'User answered: prod' }],
                is_error: true, // SDK denied tool with message
              },
            ],
          },
        }),
        ctx,
      );

      expect(events).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'clarif-1', result: 'User answered: prod', isError: false },
      ]);
      const call = ctx.toolCalls.find((c) => c.id === 'clarif-1');
      expect(call?.result).toBe('User answered: prod');
      expect(call?.isError).toBe(false);
    });

    it('marks validation errors as errors even if SDK reports is_error: false', () => {
      const ctx = newTurnContext('t1');
      translateMessage(
        msg({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'clarif-2', name: 'ask_clarifying_question', input: { question: 'Pick' } },
            ],
          },
        }),
        ctx,
      );

      const errorPayload = 'InputValidationError: options must have <= 4 items';
      const events = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'clarif-2',
                content: [{ type: 'text', text: errorPayload }],
                is_error: false,
              },
            ],
          },
        }),
        ctx,
      );

      expect(events).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'clarif-2', result: errorPayload, isError: true },
      ]);
      const call = ctx.toolCalls.find((c) => c.id === 'clarif-2');
      expect(call?.result).toBe(errorPayload);
      expect(call?.isError).toBe(true);
    });

    it('marks empty/cancelled clarification answers as isError: true', () => {
      const ctx = newTurnContext('t1');
      translateMessage(
        msg({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'clarif-3', name: 'AskUserQuestion', input: {} }],
          },
        }),
        ctx,
      );

      const events = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'clarif-3',
                content: [{ type: 'text', text: 'User answered: ' }],
                is_error: false,
              },
            ],
          },
        }),
        ctx,
      );

      expect(events).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'clarif-3', result: 'User answered: ', isError: true },
      ]);
      const call = ctx.toolCalls.find((c) => c.id === 'clarif-3');
      expect(call?.result).toBe('User answered: ');
      expect(call?.isError).toBe(true);
    });

    it('gracefully passes through tool_result for unmatched toolUseId without throwing', () => {
      const ctx = newTurnContext('t1');
      const events = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'unmatched-id',
                content: [{ type: 'text', text: 'orphan result' }],
                is_error: false,
              },
            ],
          },
        }),
        ctx,
      );

      expect(events).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'unmatched-id', result: 'orphan result', isError: false },
      ]);
      expect(ctx.toolCalls).toHaveLength(0);
    });

    it('passes through incoming is_error unmodified for non-clarification tools', () => {
      const ctx = newTurnContext('t1');
      const corpusTool = qualifyTool('search_corpus');
      translateMessage(
        msg({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'tu-norm-1', name: corpusTool, input: {} },
              { type: 'tool_use', id: 'tu-norm-2', name: corpusTool, input: {} },
            ],
          },
        }),
        ctx,
      );

      const events1 = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-norm-1',
                content: [{ type: 'text', text: 'success result' }],
                is_error: false,
              },
            ],
          },
        }),
        ctx,
      );
      expect(events1).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'tu-norm-1', result: 'success result', isError: false },
      ]);
      expect(ctx.toolCalls.find((c) => c.id === 'tu-norm-1')?.isError).toBe(false);

      const events2 = translateMessage(
        msg({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-norm-2',
                content: [{ type: 'text', text: 'failed result' }],
                is_error: true,
              },
            ],
          },
        }),
        ctx,
      );
      expect(events2).toEqual([
        { kind: 'tool-result', threadId: 't1', toolUseId: 'tu-norm-2', result: 'failed result', isError: true },
      ]);
      expect(ctx.toolCalls.find((c) => c.id === 'tu-norm-2')?.isError).toBe(true);
    });
  });
});


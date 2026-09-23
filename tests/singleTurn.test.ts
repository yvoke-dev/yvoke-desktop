import { describe, expect, it } from 'vitest';
import { NoReplyError, readSingleReply } from '../src/main/agent/singleTurn';

function createMockQuery(messages: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
    close: () => {},
  } as any;
}

describe('readSingleReply', () => {
  it('happy path: returns result text on clean success without is_error', async () => {
    const q = createMockQuery([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', is_error: false, result: 'pong' },
    ]);
    const reply = await readSingleReply(q, 'test check');
    expect(reply).toBe('pong');
  });

  it('throws error when subtype is success but is_error is true (SDK unauthenticated / turn error)', async () => {
    const q = createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      },
    ]);
    await expect(readSingleReply(q, 'test check')).rejects.toThrow(
      'Not logged in · Please run /login',
    );
  });

  it('falls back to descriptive error when is_error is true but result is whitespace/empty', async () => {
    const q = createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: '   \n  ',
      },
    ]);
    await expect(readSingleReply(q, 'test check')).rejects.toThrow(
      'Claude Code returned an error result',
    );
  });

  it('throws error with errors array when subtype is not success', async () => {
    const q = createMockQuery([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Subprocess terminated unexpectedly'],
      },
    ]);
    await expect(readSingleReply(q, 'test check')).rejects.toThrow(
      'Subprocess terminated unexpectedly',
    );
  });

  it('falls back to subtype name when subtype is not success and errors array is empty', async () => {
    const q = createMockQuery([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: [],
      },
    ]);
    await expect(readSingleReply(q, 'test check')).rejects.toThrow(
      'error_during_execution',
    );
  });

  it('throws NoReplyError when stream completes without a result message', async () => {
    const q = createMockQuery([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    await expect(readSingleReply(q, 'login check')).rejects.toThrow(NoReplyError);
  });
});

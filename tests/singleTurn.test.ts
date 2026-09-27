import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { NoReplyError, ResultError, isResultFailure, readSingleReply } from '../src/main/agent/singleTurn';

function createMockQuery(messages: Partial<SDKMessage>[]): Query {
  return {
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg as unknown as SDKMessage;
      }
    },
    close: () => {},
  } as unknown as Query;
}

describe('singleTurn', () => {
  describe('isResultFailure', () => {
    it('returns false for clean success result without error', () => {
      expect(isResultFailure({ type: 'result', subtype: 'success', is_error: false })).toBe(false);
    });

    it('returns true when subtype is success but is_error is true', () => {
      expect(isResultFailure({ type: 'result', subtype: 'success', is_error: true })).toBe(true);
    });

    it('returns true when subtype is not success', () => {
      expect(isResultFailure({ type: 'result', subtype: 'error_during_execution', is_error: false })).toBe(true);
      expect(isResultFailure({ type: 'result', subtype: 'error_max_turns', is_error: true })).toBe(true);
    });
  });

  describe('readSingleReply', () => {
    it('happy path: returns result text on clean success without is_error', async () => {
      const q = createMockQuery([
        { type: 'system', subtype: 'init' },
        { type: 'result', subtype: 'success', is_error: false, result: 'pong' },
      ]);
      const reply = await readSingleReply(q, 'test check');
      expect(reply).toBe('pong');
    });

    it('throws ResultError when subtype is success but is_error is true', async () => {
      const q = createMockQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        },
      ]);
      let caught: unknown;
      try {
        await readSingleReply(q, 'test check');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ResultError);
      const resErr = caught as ResultError;
      expect(resErr.message).toBe('Not logged in · Please run /login');
      expect(resErr.subtype).toBe('success');
      expect(resErr.status).toBeUndefined();
    });

    it('attaches api_error_status to ResultError when present on error result', async () => {
      const q = createMockQuery([
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 429,
          result: 'Claude subscription allowance or rate limit reached',
        },
      ]);
      let caught: unknown;
      try {
        await readSingleReply(q, 'test check');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ResultError);
      const resErr = caught as ResultError;
      expect(resErr.status).toBe(429);
      expect(resErr.subtype).toBe('success');
      expect(resErr.message).toBe('Claude subscription allowance or rate limit reached');
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

    it('throws ResultError with errors array when subtype is not success', async () => {
      const q = createMockQuery([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['Subprocess terminated unexpectedly'],
        },
      ]);
      let caught: unknown;
      try {
        await readSingleReply(q, 'test check');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ResultError);
      const resErr = caught as ResultError;
      expect(resErr.message).toBe('Subprocess terminated unexpectedly');
      expect(resErr.subtype).toBe('error_during_execution');
      expect(resErr.status).toBeUndefined();
    });

    it('falls back to subtype name when subtype is not success and errors array is empty', async () => {
      const q = createMockQuery([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
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
        { type: 'auth_status' },
      ]);
      await expect(readSingleReply(q, 'login check')).rejects.toThrow(NoReplyError);
    });
  });
});

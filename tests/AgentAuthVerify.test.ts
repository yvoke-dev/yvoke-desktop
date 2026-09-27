import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentServiceDeps } from '../src/main/agent/AgentService';
import { classifyClaudeFailure, isAuthError, LOGIN_INSTRUCTIONS } from '../src/main/agent/ClaudeAuth';
import { NoReplyError, ResultError } from '../src/main/agent/singleTurn';

const mockDetectCredentials = vi.fn();
const mockDetectAccount = vi.fn();
const mockQuery = vi.fn();

vi.mock('../src/main/agent/ClaudeAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/agent/ClaudeAuth')>();
  return {
    ...actual,
    detectClaudeCredentials: () => mockDetectCredentials(),
    detectClaudeAccount: () => mockDetectAccount(),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (args: any) => mockQuery(args),
  };
});

const { AgentService } = await import('../src/main/agent/AgentService');

function createFakeQuery(options: {
  messages?: Partial<SDKMessage>[];
  errorToThrow?: unknown;
}) {
  const close = vi.fn();
  const iterator = {
    async *[Symbol.asyncIterator]() {
      if (options.errorToThrow) {
        throw options.errorToThrow;
      }
      if (options.messages) {
        for (const msg of options.messages) {
          yield msg as unknown as SDKMessage;
        }
      }
    },
    close,
  };
  return { iterator, close };
}

describe('AgentService.verifyClaudeCredentials', () => {
  let agentService: InstanceType<typeof AgentService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectAccount.mockReturnValue(undefined);

    const deps: AgentServiceDeps = {
      getSettings: () => ({ defaultModel: 'sonnet' } as any),
      mcpAuthProvider: { headers: async () => ({}) },
      emit: vi.fn(),
      onSessionId: vi.fn(),
      onTurnPersist: vi.fn(),
      sandboxDir: '/tmp/test-sandbox',
      syncClient: {} as any,
      mcpPrompts: {} as any,
      getOrchestratorProfile: vi.fn(),
    };
    agentService = new AgentService(deps);
  });

  it('fast check: returns missing immediately if detectClaudeCredentials() === "missing"', async () => {
    mockDetectCredentials.mockReturnValue('missing');

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'missing',
      message: LOGIN_INSTRUCTIONS,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('Test 2.1: Subprocess timeout & process termination (q.close called on abort)', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const abortErr = new AbortError('The operation was aborted');
    const { iterator, close } = createFakeQuery({ errorToThrow: abortErr });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'unreachable',
      message: 'Claude verification timed out',
    });
    expect(mockQuery).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('Test 2.2: macOS keychain inconclusive state ("unknown") converts to live check', async () => {
    mockDetectCredentials.mockReturnValue('unknown');
    mockDetectAccount.mockReturnValue('user@example.com');
    const { iterator, close } = createFakeQuery({
      messages: [{ type: 'result', subtype: 'success', result: 'pong' }],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox', 'sonnet');

    expect(result).toEqual({
      status: 'ok',
      account: 'user@example.com',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'ping',
        options: expect.objectContaining({
          tools: [],
          disallowedTools: ['Bash'],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          thinking: { type: 'disabled' },
          effort: 'low',
          maxTurns: 1,
          model: 'sonnet',
        }),
      }),
    );
    expect(close).toHaveBeenCalled();
  });

  it('Test 2.3: Expired/revoked Claude session returns expired', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['Invalid API key or authentication session expired: please run /login'],
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'expired',
      message: 'Session expired or not logged in. Run claude /login in a terminal.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('handles real SDK unauthenticated result (subtype success with is_error true) as expired', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'Not logged in · Please run /login',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'expired',
      message: 'Session expired or not logged in. Run claude /login in a terminal.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('rejects unexpected model prose not containing pong as error', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'I am ready to help you with coding.',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: 'Claude verification failed: unexpected reply: I am ready to help you with coding.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('handles SDK error result with non-auth text as error (pins is_error throw over ok)', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'API Error: 500 Internal Server Error pong',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: 'Claude verification failed: API Error: 500 Internal Server Error pong',
    });
    expect(close).toHaveBeenCalled();
  });

  it('classifies SDK result with api_error_status 401 as expired even with non-standard body', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 401,
          result: 'Organization access revoked by administrator',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'expired',
      message: 'Session expired or not logged in. Run claude /login in a terminal.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('classifies SDK result with api_error_status 403 as expired with denied access message', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 403,
          result: 'Account suspended or forbidden',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'expired',
      message: 'Claude denied access for this account. Try claude /login, or check your subscription.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('does not classify 500 mentioning auth words as expired', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 500,
          result: 'Internal server error: unable to load api key from vault',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: 'Claude verification failed: Internal server error: unable to load api key from vault',
    });
    expect(close).toHaveBeenCalled();
  });

  it('classifies SDK result with api_error_status 429 as rate_limited even with non-standard body', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          api_error_status: 429,
          result: 'Too many requests for tenant',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'rate_limited',
      message: 'Claude subscription allowance or rate limit reached.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('formats empty reply as (empty reply) when model produces whitespace-only response', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '   \n  ',
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: 'Claude verification failed: unexpected reply: (empty reply)',
    });
    expect(close).toHaveBeenCalled();
  });

  it('truncates very long unexpected error messages to 200 characters', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const longMsg = 'X'.repeat(500);
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: longMsg,
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: `Claude verification failed: ${'X'.repeat(200)}`,
    });
    expect(close).toHaveBeenCalled();
  });

  it('handles rate limit error properly with SDK result subtype', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['429 rate limit exceeded or usage limit reached'],
        },
      ],
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'rate_limited',
      message: 'Claude subscription allowance or rate limit reached.',
    });
    expect(close).toHaveBeenCalled();
  });

  it('Test 2.4: Malformed SDK error output maps to error without crashing', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      errorToThrow: 'Unexpected string error without Error instance',
    });
    mockQuery.mockReturnValue(iterator);

    const result = await agentService.verifyClaudeCredentials('/tmp/test-sandbox');

    expect(result).toEqual({
      status: 'error',
      message: 'Claude verification failed: Unexpected string error without Error instance',
    });
    expect(close).toHaveBeenCalled();
  });
});

describe('AgentService.verifyClaudeCredentials error classification', () => {
  let agentService: InstanceType<typeof AgentService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectAccount.mockReturnValue(undefined);
    mockDetectCredentials.mockReturnValue('ok');
    const deps: AgentServiceDeps = {
      getSettings: () => ({ defaultModel: 'sonnet' }) as any,
      mcpAuthProvider: { headers: async () => ({}) },
      emit: vi.fn(),
      onSessionId: vi.fn(),
      onTurnPersist: vi.fn(),
      sandboxDir: '/tmp/test-sandbox',
      syncClient: {} as any,
      mcpPrompts: {} as any,
      getOrchestratorProfile: vi.fn(),
    };
    agentService = new AgentService(deps);
  });

  async function verifyWith(error: unknown) {
    const { iterator } = createFakeQuery({ errorToThrow: error });
    mockQuery.mockReturnValue(iterator);
    return agentService.verifyClaudeCredentials('/tmp/test-sandbox');
  }

  // The probe's own "ended without a result" message contains the word "credential", which
  // isAuthError matches — so a subprocess that died reported an expired login and the user was
  // sent to re-run `claude /login`, which could not help.
  it('does not report a stream that ended without a result as an expired login', async () => {
    // The label is deliberately one isAuthError WOULD match: the type, not the prose, must
    // decide. This is what keeps a dead subprocess from being reported as a stale login.
    const result = await verifyWith(new NoReplyError('credential check'));
    expect(result.status).not.toBe('expired');
    expect(result.status).toBe('error');
  });

  // Belt and braces: even read as prose, the probe's own label must not look like an auth
  // failure. `isAuthError` matches /credential/, so the old 'credential verification' collided.
  it('uses a probe label that no auth-error match can claim', async () => {
    expect(isAuthError(new NoReplyError('login check').message)).toBe(false);
  });

  // A real Anthropic 429 body names the API key, which isAuthError matched first.
  it('reports a rate-limit body that mentions the api key as rate limited', async () => {
    const result = await verifyWith(
      new Error('429 rate_limit_error: your API key has exceeded the per-minute rate limit'),
    );
    expect(result.status).toBe('rate_limited');
  });

  // `429` was unanchored, so any digit run containing it read as an allowance failure.
  it.each([
    ['spawn /opt/build/claude/4290/claude ENOENT'],
    ['Request id req_011CQ429ab failed'],
  ])('does not read an incidental 429 (%s) as a rate limit', async (msg) => {
    const result = await verifyWith(new Error(msg));
    expect(result.status).not.toBe('rate_limited');
  });

  it('still reports a genuine allowance failure as rate limited', async () => {
    const result = await verifyWith(new Error('Claude AI usage limit reached'));
    expect(result.status).toBe('rate_limited');
  });

  it('still reports a genuine auth failure as expired', async () => {
    const result = await verifyWith(new Error('Invalid API key · Please run /login'));
    expect(result.status).toBe('expired');
  });
});

describe('AgentService.verifyClaudeCredentials isolation', () => {
  it('budgets the same time as the other single-turn probes and isolates the preset', async () => {
    const { CLAUDE_VERIFY_TIMEOUT_MS } = await import('../src/main/agent/AgentService');
    const { VALIDATION_TIMEOUT_MS } = await import('../src/main/agent/playbookValidation');
    // A cold CLI spawn plus a model round trip does not fit in a fraction of what the
    // structurally identical playbook probe already needs.
    expect(CLAUDE_VERIFY_TIMEOUT_MS).toBeGreaterThanOrEqual(VALIDATION_TIMEOUT_MS);

    vi.clearAllMocks();
    mockDetectCredentials.mockReturnValue('ok');
    mockDetectAccount.mockReturnValue(undefined);
    const { iterator } = createFakeQuery({
      messages: [{ type: 'result', subtype: 'success', result: 'pong' }],
    });
    mockQuery.mockReturnValue(iterator);

    const svc = new AgentService({
      getSettings: () => ({ defaultModel: 'sonnet' }) as any,
      mcpAuthProvider: { headers: async () => ({}) },
      emit: vi.fn(),
      onSessionId: vi.fn(),
      onTurnPersist: vi.fn(),
      sandboxDir: '/tmp/test-sandbox',
      syncClient: {} as any,
      mcpPrompts: {} as any,
      getOrchestratorProfile: vi.fn(),
    });
    await svc.verifyClaudeCredentials('/tmp/test-sandbox');

    // A bare systemPrompt string replaces the Claude Code preset outright, as the sibling
    // probes do — without it this "isolated" check drags the whole preset along.
    const options = mockQuery.mock.calls[0][0].options;
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt.length).toBeGreaterThan(0);
  });
});

describe('classifyClaudeFailure', () => {
  it('classifies ResultError with status 429 as rate_limited', () => {
    const err = new ResultError('API error', 'success', 429);
    expect(classifyClaudeFailure(err)).toEqual({
      status: 'rate_limited',
      message: 'Claude subscription allowance or rate limit reached.',
    });
  });

  it('classifies ResultError with status 401 as expired with login message', () => {
    const err401 = new ResultError('Unauthorized', 'success', 401);
    expect(classifyClaudeFailure(err401)).toEqual({
      status: 'expired',
      message: 'Session expired or not logged in. Run claude /login in a terminal.',
    });
  });

  it('classifies ResultError with status 403 as expired with denied access message', () => {
    const err403 = new ResultError('Forbidden', 'success', 403);
    expect(classifyClaudeFailure(err403)).toEqual({
      status: 'expired',
      message: 'Claude denied access for this account. Try claude /login, or check your subscription.',
    });
  });

  it('does not fall back to text matching when ResultError has another status code (e.g. 500)', () => {
    const err500 = new ResultError('Internal error: invalid api key', 'success', 500);
    expect(classifyClaudeFailure(err500)).toBeUndefined();
  });

  it('falls back to regex inspection when status code is absent', () => {
    const rateLimitErr = new ResultError('monthly usage limit reached', 'success');
    expect(classifyClaudeFailure(rateLimitErr)).toEqual({
      status: 'rate_limited',
      message: 'Claude subscription allowance or rate limit reached.',
    });

    const authErr = new ResultError('Not logged in · Please run /login', 'success');
    expect(classifyClaudeFailure(authErr)).toEqual({
      status: 'expired',
      message: 'Session expired or not logged in. Run claude /login in a terminal.',
    });
  });

  it('returns undefined for non-auth non-rate-limit errors', () => {
    const err = new ResultError('API Error: 500 Internal Server Error', 'success', 500);
    expect(classifyClaudeFailure(err)).toBeUndefined();
    expect(classifyClaudeFailure(new Error('Network disconnected'))).toBeUndefined();
  });
});

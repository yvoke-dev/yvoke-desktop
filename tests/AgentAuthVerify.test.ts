import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentServiceDeps } from '../src/main/agent/AgentService';
import { isAuthError, LOGIN_INSTRUCTIONS } from '../src/main/agent/ClaudeAuth';
import { NoReplyError } from '../src/main/agent/singleTurn';

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
  messages?: any[];
  errorToThrow?: any;
}) {
  const close = vi.fn();
  const iterator = {
    async *[Symbol.asyncIterator]() {
      if (options.errorToThrow) {
        throw options.errorToThrow;
      }
      if (options.messages) {
        for (const msg of options.messages) {
          yield msg;
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
          subtype: 'error',
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

  it('handles rate limit error properly', async () => {
    mockDetectCredentials.mockReturnValue('ok');
    const { iterator, close } = createFakeQuery({
      messages: [
        {
          type: 'result',
          subtype: 'error',
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

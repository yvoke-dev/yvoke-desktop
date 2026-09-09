import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentServiceDeps } from '../src/main/agent/AgentService';
import { LOGIN_INSTRUCTIONS } from '../src/main/agent/ClaudeAuth';

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

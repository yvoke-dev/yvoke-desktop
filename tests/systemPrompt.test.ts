import { describe, expect, it, vi } from 'vitest';

import { BASE_SYSTEM_PROMPT_NAME, loadRequiredSystemPrompt } from '../src/main/agent/AgentService';

/**
 * The base system prompt is not optional: it carries the grounding rules, the citation contract and
 * the mermaid/KaTeX delimiters. The previous code declared `let systemPrompt = ''` and a catch that
 * logged "using fallback" without ever assigning one, so an unreachable server ran the agent with
 * NO system prompt at all — silently, and with a log line claiming otherwise.
 */
describe('loadRequiredSystemPrompt', () => {
  const client = (impl: () => Promise<string>) => ({ getSystemPrompt: vi.fn(impl) });

  it('returns the prompt the server supplies', async () => {
    const c = client(async () => 'You are Yvoke.');
    await expect(loadRequiredSystemPrompt(c)).resolves.toBe('You are Yvoke.');
    expect(c.getSystemPrompt).toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });

  it('throws when the server is unreachable, naming the cause', async () => {
    const c = client(async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    });
    await expect(loadRequiredSystemPrompt(c)).rejects.toThrow(/could not be loaded/);
    await expect(loadRequiredSystemPrompt(c)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws on a 200 with an empty body', async () => {
    // The endpoint can answer 200 with nothing; that is a failure, not a valid empty prompt.
    await expect(loadRequiredSystemPrompt(client(async () => ''))).rejects.toThrow(/came back empty/);
  });

  it('throws on a whitespace-only body', async () => {
    await expect(loadRequiredSystemPrompt(client(async () => '   \n  '))).rejects.toThrow(
      /came back empty/,
    );
  });

  it('never resolves to an empty string', async () => {
    // The property that actually matters: no input makes this return something unusable.
    for (const body of ['', '   ', '\n\t']) {
      await expect(loadRequiredSystemPrompt(client(async () => body))).rejects.toThrow();
    }
  });

  it('surfaces a non-Error rejection without losing it', async () => {
    const c = client(async () => {
      throw 'plain string failure';
    });
    await expect(loadRequiredSystemPrompt(c)).rejects.toThrow(/plain string failure/);
  });

  it('re-throws Entra error untouched without wrapping into Yvoke Backend:', async () => {
    const entraError = new Error('Entra: Interactive login required');
    const c = client(async () => {
      throw entraError;
    });
    await expect(loadRequiredSystemPrompt(c)).rejects.toBe(entraError);
  });

  it('re-throws Entra error on custom prompt load without falling back to base prompt', async () => {
    const entraError = new Error('Entra: Interactive login required');
    const c = {
      getSystemPrompt: vi.fn(async () => {
        throw entraError;
      }),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).rejects.toBe(entraError);
    expect(c.getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
  });

  it('loads a custom designated prompt when requested', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (name: string) => `Prompt for ${name}`),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).resolves.toBe('Prompt for custom-prompt');
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
  });

  it('falls back to BASE_SYSTEM_PROMPT_NAME when custom prompt throws', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (name: string) => {
        if (name === 'custom-prompt') throw new Error('Not found: 404');
        return 'Base Prompt';
      }),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).resolves.toBe('Base Prompt');
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
    expect(c.getSystemPrompt).toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });

  it('falls back to BASE_SYSTEM_PROMPT_NAME when custom prompt returns empty', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (name: string) => {
        if (name === 'custom-prompt') return '   ';
        return 'Base Prompt';
      }),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).resolves.toBe('Base Prompt');
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
    expect(c.getSystemPrompt).toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });

  it('re-throws transient 5xx or network error on custom prompt load without falling back to base prompt', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (name: string) => {
        if (name === 'custom-prompt') throw new Error('500 Internal Server Error');
        return 'Base Prompt';
      }),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).rejects.toThrow(/could not be loaded/);
    expect(c.getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
    expect(c.getSystemPrompt).not.toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });

  it('re-throws connection error on custom prompt load without falling back to base prompt', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (name: string) => {
        if (name === 'custom-prompt') throw new Error('fetch failed: ECONNREFUSED');
        return 'Base Prompt';
      }),
    };
    await expect(loadRequiredSystemPrompt(c, 'custom-prompt')).rejects.toThrow(/could not be loaded/);
    expect(c.getSystemPrompt).toHaveBeenCalledTimes(1);
    expect(c.getSystemPrompt).toHaveBeenCalledWith('custom-prompt');
    expect(c.getSystemPrompt).not.toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });

  it('falls back to BASE_SYSTEM_PROMPT_NAME when custom prompt name is invalid', async () => {
    const c = {
      getSystemPrompt: vi.fn(async (_name: string) => 'Base Prompt'),
    };
    await expect(loadRequiredSystemPrompt(c, '../../conversations')).resolves.toBe('Base Prompt');
    expect(c.getSystemPrompt).not.toHaveBeenCalledWith('../../conversations');
    expect(c.getSystemPrompt).toHaveBeenCalledWith(BASE_SYSTEM_PROMPT_NAME);
  });
});


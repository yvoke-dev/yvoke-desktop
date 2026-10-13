import { describe, expect, it } from 'vitest';
import { sanitizedEnv } from '../src/main/agent/ClaudeAuth';

/**
 * `sanitizedEnv` is the one place the environment of every Claude CLI subprocess the app starts is
 * decided — sessions, the credential ping, playbook preflight and image descriptions all derive from
 * it through `debugEnv`.
 */
describe('sanitizedEnv', () => {
  it('drops ANTHROPIC_API_KEY, which would silently move billing off the subscription', () => {
    const env = sanitizedEnv({ ANTHROPIC_API_KEY: 'sk-secret', PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps the rest of the inherited environment', () => {
    const env = sanitizedEnv({ HOME: '/home/u', LANG: 'en_GB.UTF-8' });
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_GB.UTF-8');
  });

  it('turns background tasks off, so a delegated call cannot return a launch receipt', () => {
    expect(sanitizedEnv({}).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('turns them off even when the app was started with them explicitly enabled', () => {
    for (const inherited of ['0', 'false', '']) {
      expect(sanitizedEnv({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: inherited }).CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    }
  });
});

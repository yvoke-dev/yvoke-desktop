import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude (model) authentication helpers. The app never handles claude.ai credentials
 * itself — the Agent SDK picks up ambient Claude Code credentials from ~/.claude/.
 * This module only detects their presence, classifies auth failures, and strips an
 * inherited ANTHROPIC_API_KEY so usage stays on the subscription's Agent SDK credit
 * (Correctness Property 2).
 */

export type ClaudeCredentialStatus = 'ok' | 'missing' | 'unknown';

export function detectClaudeCredentials(home: string = os.homedir()): ClaudeCredentialStatus {
  try {
    // Linux/Windows store credentials on disk; macOS may use the keychain, in which
    // case absence of the file is inconclusive — report 'unknown' rather than 'missing'.
    const credentialsFile = path.join(home, '.claude', '.credentials.json');
    if (fs.existsSync(credentialsFile)) {
      return 'ok';
    }
    const claudeDir = path.join(home, '.claude');
    if (process.platform === 'darwin' && fs.existsSync(claudeDir)) {
      return 'unknown';
    }
    return fs.existsSync(claudeDir) ? 'unknown' : 'missing';
  } catch {
    return 'unknown';
  }
}

/**
 * The signed-in Claude account's email, if Claude Code has recorded one. Claude Code
 * stores the OAuth identity in ~/.claude.json under `oauthAccount.emailAddress`. Returns
 * undefined when absent or unreadable — this is display-only, never an auth gate.
 */
export function detectClaudeAccount(home: string = os.homedir()): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: string } })?.oauthAccount
      ?.emailAddress;
    return typeof email === 'string' && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

export function isAuthError(message: string): boolean {
  return /invalid api key|not logged in|please run \/login|authentication|credential|oauth token|api key/i.test(message);
}

/**
 * Environment for the SDK subprocess: inherit everything except ANTHROPIC_API_KEY,
 * which would silently switch billing from the subscription to pay-per-token.
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export const LOGIN_INSTRUCTIONS =
  'No Claude credentials found. Sign in with your Claude (Pro/Max) account by running ' +
  '`claude /login` in a terminal (install via `npm install -g @anthropic-ai/claude-code` if needed), ' +
  'then click Retry. Desktop-app usage draws from the Agent SDK credit of your subscription.';

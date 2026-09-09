import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `CLAUDE.md` and `.agents/AGENTS.md` are the same project rules written for two
 * different agent toolchains, and an agent that loads only one of them must not be missing a
 * pitfall.
 *
 * This test enforces that § 6 Known Pitfalls in both files match word-for-word.
 */

const CLAUDE_PATH = resolve(__dirname, '..', 'CLAUDE.md');
const AGENTS_PATH = resolve(__dirname, '..', '.agents', 'AGENTS.md');

const HEADING = /^##\s*\d*\.?\s*Known Pitfalls.*$/m;
const BULLET = /^- \*\*/gm;

function section(filePath: string): string {
  expect(existsSync(filePath), `${filePath} must exist`).toBe(true);
  const text = readFileSync(filePath, 'utf8');
  const match = text.match(HEADING);
  expect(match, `${filePath} must have a 'Known Pitfalls' section`).not.toBeNull();
  return text.slice(match!.index! + match![0].length);
}

function pitfallsIn(sectionText: string): string[] {
  const matches = [...sectionText.matchAll(BULLET)];
  const out: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : sectionText.length;
    out.push(sectionText.slice(start, end).trim());
  }
  return out;
}

function title(pitfall: string): string {
  const m = pitfall.match(/^- \*\*([^*]+)\*\*/);
  return m ? m[1].trim() : pitfall.slice(0, 40);
}

describe('AgentRuleFilesParity', () => {
  it('both rule files exist and contain pitfalls', () => {
    const claudePitfalls = pitfallsIn(section(CLAUDE_PATH));
    const agentsPitfalls = pitfallsIn(section(AGENTS_PATH));

    expect(claudePitfalls.length).toBeGreaterThan(0);
    expect(agentsPitfalls.length).toBeGreaterThan(0);
  });

  it('both files carry the exact same pitfall titles in the exact same order', () => {
    const claudePitfalls = pitfallsIn(section(CLAUDE_PATH));
    const agentsPitfalls = pitfallsIn(section(AGENTS_PATH));

    const claudeTitles = claudePitfalls.map(title);
    const agentsTitles = agentsPitfalls.map(title);

    expect(agentsTitles).toEqual(claudeTitles);
  });

  it('both files carry the exact same pitfall text word-for-word', () => {
    const claudePitfalls = pitfallsIn(section(CLAUDE_PATH));
    const agentsPitfalls = pitfallsIn(section(AGENTS_PATH));

    expect(agentsPitfalls).toEqual(claudePitfalls);
  });
});

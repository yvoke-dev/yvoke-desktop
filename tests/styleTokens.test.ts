import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `var(--x)` with no fallback and no definition is invalid at computed-value time: the property
 * silently resets to its initial value with no console error, so a typo'd token looks like a
 * design choice rather than a bug. These tests make that unrepresentable — the theme is the
 * contract, and a reference without a definition fails the build.
 */
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css'),
  'utf8',
);

/** Tokens the stylesheet defines, anywhere (`:root`, a theme block, a density block). */
function definedTokens(): Set<string> {
  return new Set([...CSS.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
}

/** Tokens the stylesheet reads, excluding those given an inline `var(--x, fallback)`. */
function referencedTokens(): Map<string, number> {
  const refs = new Map<string, number>();
  const lines = CSS.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (!refs.has(m[1])) refs.set(m[1], i + 1);
    }
  });
  return refs;
}

describe('theme tokens', () => {
  it('every var() reference resolves to a definition', () => {
    const defined = definedTokens();
    const dangling = [...referencedTokens()]
      .filter(([token]) => !defined.has(token))
      .map(([token, line]) => `${token} (styles.css:${line})`);
    expect(dangling).toEqual([]);
  });

  it('defines every palette token in both the light and the dark theme', () => {
    // The dark theme is a `prefers-color-scheme` block that redefines the palette; a token
    // defined in only one of the two renders unthemed (or not at all) in the other.
    const darkBlock = CSS.slice(CSS.indexOf('@media (prefers-color-scheme: dark)'));
    const darkTokens = new Set([...darkBlock.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));

    const palette = [
      '--ok-bg',
      '--ok-ink',
      '--warn-bg',
      '--warn-ink',
      '--warn-line',
      '--danger-bg',
      '--danger-ink',
      '--danger-line',
    ];
    expect(palette.filter((t) => !darkTokens.has(t))).toEqual([]);
  });
});

describe('button variant selectors', () => {
  /**
   * The default `button:not(...)` chrome excludes every variant that styles itself — its own
   * comment says so. A variant left out of that list is outranked by (0,27,1) specificity and
   * silently loses its border, padding, font size and hover state.
   */
  it('excludes .secondary from the default button chrome', () => {
    const defaultChrome = CSS.match(/^button:not\([^{]*\{/m)?.[0];
    expect(defaultChrome).toBeDefined();
    expect(defaultChrome).toContain(':not(.secondary)');
  });

  it('needs no !important to make the inline credential button win', () => {
    const block = CSS.match(/\.cred-inline-btn\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).not.toContain('!important');
  });

  it('excludes .option-button from the default button chrome', () => {
    const defaultChrome = CSS.match(/^button:not\([^{]*\{/m)?.[0];
    expect(defaultChrome).toBeDefined();
    expect(defaultChrome).toContain(':not(.option-button)');
  });

  it('needs no !important for option-button rules', () => {
    const optionButtonBlock = CSS.match(/\.option-button\s*\{[^}]*\}/)?.[0] ?? '';
    expect(optionButtonBlock).not.toContain('!important');
    const optionButtonHoverBlock = CSS.match(/\.option-button:hover:not\(:disabled\)\s*\{[^}]*\}/)?.[0] ?? '';
    expect(optionButtonHoverBlock).not.toContain('!important');
  });

  it('styles open-logs-btn with the same compact secondary button size as check-credentials-btn', () => {
    expect(CSS).toMatch(/\.button\.check-credentials-btn,\s*\.button\.open-logs-btn/);
  });
});

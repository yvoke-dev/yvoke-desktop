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

  it('excludes .claude-alt-toggle from the default button chrome and uses no !important on Claude sign-in styles', () => {
    const defaultChrome = CSS.match(/^button:not\([^{]*\{/m)?.[0];
    expect(defaultChrome).toBeDefined();
    expect(defaultChrome).toContain(':not(.claude-alt-toggle)');

    for (const selector of [
      /\.claude-alt-toggle\s*\{[^}]*\}/,
      /\.claude-signin-controls\s*\{[^}]*\}/,
      /\.claude-alt-panel\s*\{[^}]*\}/,
    ]) {
      const block = CSS.match(selector)?.[0];
      expect(block).toBeDefined();
      expect(block).not.toContain('!important');
    }
  });

  it('excludes .footer-account-btn from the default button chrome and uses no !important on account/server sign-in rules', () => {
    const defaultChrome = CSS.match(/^button:not\([^{]*\{/m)?.[0];
    expect(defaultChrome).toBeDefined();
    expect(defaultChrome).toContain(':not(.footer-account-btn)');

    for (const selector of [
      /\.footer-account-btn\s*\{[^}]*\}/,
      /\.server-signin-controls\s*\{[^}]*\}/,
      /\.account-status-dot\s*\{[^}]*\}/,
    ]) {
      const block = CSS.match(selector)?.[0];
      expect(block).toBeDefined();
      expect(block).not.toContain('!important');
    }

    const footerBtnBlock = CSS.match(/\.footer-account-btn\s*\{[^}]*\}/)?.[0] ?? '';
    expect(footerBtnBlock).toContain('width: calc(100% + 12px)');
  });

  it('uses overflow-wrap on .about-grid dd and reserves word-break: break-all strictly for .about-url', () => {
    const ddBlock = CSS.match(/\.about-grid dd\s*\{[^}]*\}/)?.[0];
    expect(ddBlock).toBeDefined();
    expect(ddBlock).not.toContain('word-break: break-all');
    expect(ddBlock).toMatch(/overflow-wrap:\s*(?:break-word|anywhere)/);

    const urlBlock = CSS.match(/\.about-url\s*\{[^}]*\}/)?.[0];
    expect(urlBlock).toBeDefined();
    expect(urlBlock).toContain('word-break: break-all');
    expect(urlBlock).not.toContain('!important');
  });
});

describe('clarifying question card styles', () => {
  it('scopes markdown headings with compact margin and font size', () => {
    const headingMatch = CSS.match(
      /\.clarifying-question-card\s+\.card-question\s+\.markdown\s+h1,\s*\.clarifying-question-card\s+\.card-question\s+\.markdown\s+h2,\s*\.clarifying-question-card\s+\.card-question\s+\.markdown\s+h3,\s*\.clarifying-question-card\s+\.card-question\s+\.markdown\s+h4\s*\{([^}]*)\}/,
    );
    expect(headingMatch).toBeTruthy();
    const body = headingMatch?.[1] ?? '';
    expect(body).toMatch(/margin:\s*0\s+0\s+6px\s+0/);
    expect(body).toMatch(/font-size:\s*13px/);
    expect(body).toMatch(/font-weight:\s*600/);
  });
});

describe('thread list row styles', () => {
  it('lays out .thread-header, .thread-title, .model-badge, .thread-delete, .thread-meta, and .sync-dot with single-line truncation and zero !important', () => {
    const threadItem = CSS.match(/\.thread-item\s*\{[^}]*\}/)?.[0];
    expect(threadItem).toBeDefined();
    expect(threadItem).not.toContain('gap: 8px');

    const threadHeader = CSS.match(/\.thread-header\s*\{[^}]*\}/)?.[0];
    expect(threadHeader).toBeDefined();
    expect(threadHeader).toContain('display: flex');
    expect(threadHeader).toContain('align-items: center');
    expect(threadHeader).toContain('min-width: 0');
    expect(threadHeader).not.toContain('!important');

    const threadTitle = CSS.match(/\.thread-title\s*\{[^}]*\}/)?.[0];
    expect(threadTitle).toBeDefined();
    expect(threadTitle).toContain('flex: 1');
    expect(threadTitle).toContain('min-width: 0');
    expect(threadTitle).toContain('text-overflow: ellipsis');
    expect(threadTitle).not.toContain('!important');

    const modelBadge = CSS.match(/\.model-badge\s*\{[^}]*\}/)?.[0];
    expect(modelBadge).toBeDefined();
    expect(modelBadge).toMatch(/max-width:\s*\d+px/);
    expect(modelBadge).toContain('white-space: nowrap');
    expect(modelBadge).toContain('overflow: hidden');
    expect(modelBadge).toContain('text-overflow: ellipsis');
    expect(modelBadge).not.toContain('margin-top: 1px');
    expect(modelBadge).not.toContain('!important');

    const threadDelete = CSS.match(/\.thread-item\s+\.thread-delete\s*\{[^}]*\}/)?.[0];
    expect(threadDelete).toBeDefined();
    expect(threadDelete).toContain('padding: 2px');
    expect(threadDelete).not.toContain('margin-top: 1px');
    expect(threadDelete).not.toContain('!important');

    const threadMeta = CSS.match(/\.thread-meta\s*\{[^}]*\}/)?.[0];
    expect(threadMeta).toBeDefined();
    expect(threadMeta).toContain('white-space: nowrap');
    expect(threadMeta).toContain('overflow: hidden');
    expect(threadMeta).toContain('min-width: 0');
    expect(threadMeta).not.toContain('!important');

    const threadMetaSpan = CSS.match(/\.thread-meta\s*>\s*span:not\(\.sync-dot\)\s*\{[^}]*\}/)?.[0];
    expect(threadMetaSpan).toBeDefined();
    expect(threadMetaSpan).toContain('min-width: 0');
    expect(threadMetaSpan).toContain('overflow: hidden');
    expect(threadMetaSpan).toContain('text-overflow: ellipsis');
    expect(threadMetaSpan).not.toContain('!important');

    const syncDot = CSS.match(/\.sync-dot\s*\{[^}]*\}/)?.[0];
    expect(syncDot).toBeDefined();
    expect(syncDot).toContain('flex: 0 0 auto');
    expect(syncDot).not.toContain('!important');
  });
});


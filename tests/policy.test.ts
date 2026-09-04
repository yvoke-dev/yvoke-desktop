import { describe, expect, it } from 'vitest';
import {
  buildAllowedTools,
  buildCanUseTool,
  isToolAllowed,
  isUrlDomainAllowed,
  normalizeDomain,
  buildAutoApproveTools,
  webAccessDiagnostics,
} from '../src/main/agent/policy';
import { COMPUTE_TOOLS } from '../src/main/agent/computeTools';
import { mapSpecialistTools } from '../src/main/agent/orchestration';
import { DEFAULT_SETTINGS } from '../src/main/settings/Settings';
import { DEFAULT_KB_TOOLS, MCP_TOOL_PREFIX, qualifyTool, type AppSettings } from '../src/shared/types';

const base: AppSettings = { ...DEFAULT_SETTINGS };
const withSearch: AppSettings = {
  ...base,
  webSearch: { enabled: true, allowedDomains: ['docs.oneidentity.com', 'learn.microsoft.com'] },
};

const callOptions = { signal: new AbortController().signal, toolUseID: 't1' };

/**
 * Playbooks live server-side and were authored while the MCP alias was `oim`, so many still declare
 * tools as `mcp__oim__search_corpus`. Renaming MCP_SERVER_NAME without re-namespacing would have
 * prefixed those a second time into `mcp__yvoke__mcp__oim__search_corpus` — a name the server does
 * not serve and canUseTool then denies, silently, for every playbook in the database.
 */
describe('qualifyTool', () => {
  it('prefixes a bare tool name', () => {
    expect(qualifyTool('search_corpus')).toBe(`${MCP_TOOL_PREFIX}search_corpus`);
  });

  it('leaves an already-current name alone', () => {
    expect(qualifyTool(`${MCP_TOOL_PREFIX}search_corpus`)).toBe(`${MCP_TOOL_PREFIX}search_corpus`);
  });

  it('re-namespaces a name qualified under a previous alias instead of double-prefixing', () => {
    expect(qualifyTool('mcp__oim__search_corpus')).toBe(`${MCP_TOOL_PREFIX}search_corpus`);
    expect(qualifyTool('mcp__oim__search_corpus')).not.toContain('mcp__oim__');
  });

  // isToolAllowed only tests the prefix, so it returns true for a double-prefixed name too — it
  // cannot detect this bug. Count the prefixes instead: exactly one, whatever the input spelling.
  it('produces exactly one prefix for every input spelling', () => {
    for (const input of [
      'search_corpus',
      `${MCP_TOOL_PREFIX}search_corpus`,
      'mcp__oim__search_corpus',
      'mcp__legacy__search_corpus',
    ]) {
      expect(qualifyTool(input).match(/mcp__/g)).toHaveLength(1);
      expect(qualifyTool(input)).toBe(`${MCP_TOOL_PREFIX}search_corpus`);
    }
  });
});

/**
 * The two default lists — policy.ts for single-agent chat, orchestration.ts for specialists — were
 * hand-maintained copies, and policy.ts's had lost `search_corpus`. Since canUseTool denies anything
 * outside the allow-list, plain chat (no playbook selected, so playbookTools is undefined) was
 * refused the primary corpus-retrieval tool while a specialist doing the same work was granted it.
 */
describe('default tool set', () => {
  it('grants corpus search to a chat with no playbook selected', async () => {
    const allowed = buildAllowedTools(base, undefined, undefined);
    expect(allowed).toContain(qualifyTool('search_corpus'));

    const canUse = buildCanUseTool(() => base, 'th', undefined, allowed, undefined, false);
    const r = await canUse(qualifyTool('search_corpus'), {}, callOptions);
    expect(r?.behavior).toBe('allow');
  });

  it('grants the same set to a specialist as to plain chat', async () => {
    const chat = buildAllowedTools(base, undefined, undefined)
      .filter((t) => t.startsWith(MCP_TOOL_PREFIX)).sort();
    const specialist = mapSpecialistTools(undefined, base)
      .filter((t) => t.startsWith(MCP_TOOL_PREFIX)).sort();
    expect(chat).toEqual(specialist);
  });
});

/**
 * Task/Agent used to be permitted unconditionally AND to bypass the allow-list check below it. In
 * single-agent chat nothing declares delegation and forwardSubagentText is off, so a sub-agent's
 * retrieval never reaches the UI — the answer would arrive with an empty tool trace.
 */
describe('sub-agent delegation', () => {
  for (const tool of ['Task', 'Agent']) {
    it(`denies ${tool} in single-agent chat and allows it in orchestrator mode`, async () => {
      expect(isToolAllowed(tool, base, undefined, false)).toBe(false);
      expect(isToolAllowed(tool, base, undefined, true)).toBe(true);

      const single = buildCanUseTool(() => base, 'th', undefined, [], undefined, false);
      expect((await single(tool, {}, callOptions))?.behavior).toBe('deny');

      const orch = buildCanUseTool(() => base, 'th', undefined, [], undefined, true);
      expect((await orch(tool, {}, callOptions))?.behavior).toBe('allow');
    });
  }
});

describe('isUrlDomainAllowed', () => {
  const allowed = ['docs.oneidentity.com', 'microsoft.com'];

  it('allows exact hostname matches', () => {
    expect(isUrlDomainAllowed('https://docs.oneidentity.com/page.html', allowed)).toBe(true);
    expect(isUrlDomainAllowed('http://microsoft.com', allowed)).toBe(true);
  });

  it('allows subdomains of allowed domains', () => {
    expect(isUrlDomainAllowed('https://learn.microsoft.com/en-us/docs', allowed)).toBe(true);
    expect(isUrlDomainAllowed('https://api.docs.oneidentity.com/v1', allowed)).toBe(true);
  });

  it('denies domains not on the allowlist', () => {
    expect(isUrlDomainAllowed('https://evil.com/payload', allowed)).toBe(false);
    expect(isUrlDomainAllowed('https://notmicrosoft.com', allowed)).toBe(false);
    expect(isUrlDomainAllowed('https://oneidentity.com', allowed)).toBe(false);
  });

  it('denies non-http/https protocols', () => {
    expect(isUrlDomainAllowed('file:///etc/passwd', allowed)).toBe(false);
    expect(isUrlDomainAllowed('ftp://microsoft.com/file', allowed)).toBe(false);
    expect(isUrlDomainAllowed('javascript:alert(1)', allowed)).toBe(false);
  });

  it('handles malformed URLs or non-string inputs safely', () => {
    expect(isUrlDomainAllowed('not-a-valid-url', allowed)).toBe(false);
    expect(isUrlDomainAllowed('', allowed)).toBe(false);
    expect(isUrlDomainAllowed(null, allowed)).toBe(false);
    expect(isUrlDomainAllowed(undefined, allowed)).toBe(false);
    expect(isUrlDomainAllowed(123, allowed)).toBe(false);
  });

  it('fails closed when allowedDomains is empty', () => {
    expect(isUrlDomainAllowed('https://docs.oneidentity.com', [])).toBe(false);
    expect(isUrlDomainAllowed('https://docs.oneidentity.com', ['   ', 'https://'])).toBe(false);
  });

  it('matches a fully-qualified hostname carrying the root-label dot', () => {
    // `new URL('https://microsoft.com./x').hostname` is `microsoft.com.` — the same host, which
    // used to miss the exact match and be refused.
    expect(isUrlDomainAllowed('https://microsoft.com./x', allowed)).toBe(true);
    expect(isUrlDomainAllowed('https://learn.microsoft.com./x', allowed)).toBe(true);
  });

  it('is not fooled by a hostname that merely contains an allowed domain', () => {
    expect(isUrlDomainAllowed('https://microsoft.com.evil.com', allowed)).toBe(false);
    expect(isUrlDomainAllowed('https://microsoft.com@evil.com/', allowed)).toBe(false);
  });
});

describe('auto-approval is withheld from anything canUseTool has to see', () => {
  // The SDK's `allowedTools` grants without asking, and canUseTool is only consulted on the ask
  // path — so a tool whose enforcement lives in that callback is disarmed by being pre-approved.
  // This is the same mechanism that switched clarifying questions off for any playbook that named
  // the tool. If these ever go back on the auto-approval list, the domain allow-list stops being
  // enforced and README/spec start lying.
  it('keeps WebSearch and WebFetch out of the SDK auto-approval list', () => {
    const granted = buildAllowedTools(withSearch);
    expect(granted).toContain('WebSearch');
    expect(granted).toContain('WebFetch');

    const autoApproved = buildAutoApproveTools(granted);
    expect(autoApproved).not.toContain('WebSearch');
    expect(autoApproved).not.toContain('WebFetch');
  });

  it('keeps a playbook-declared ask_clarifying_question out of it, however it is qualified', () => {
    const granted = buildAllowedTools(base, ['search_corpus', 'ask_clarifying_question']);
    expect(granted).toContain(qualifyTool('ask_clarifying_question'));
    expect(buildAutoApproveTools(granted)).not.toContain(qualifyTool('ask_clarifying_question'));
    expect(buildAutoApproveTools(['ask_clarifying_question'])).toEqual([]);
  });

  it('withholds nothing else — every other granted tool is still auto-approved', () => {
    const granted = buildAllowedTools(base);
    expect(buildAutoApproveTools(granted)).toEqual(granted);
    for (const t of COMPUTE_TOOLS) expect(buildAutoApproveTools(granted)).toContain(t);
    expect(buildAutoApproveTools(granted)).toContain('ToolSearch');
  });
});

describe('normalizeDomain', () => {
  it('reduces an entry to a bare hostname', () => {
    expect(normalizeDomain('https://Docs.Example.com:8443/r/guide?x=1')).toBe('docs.example.com');
    expect(normalizeDomain('  example.com  ')).toBe('example.com');
  });

  it('accepts the wildcard and leading-dot spellings an operator is likely to paste', () => {
    expect(normalizeDomain('*.example.com')).toBe('example.com');
    expect(normalizeDomain('.example.com')).toBe('example.com');
    expect(normalizeDomain('example.com.')).toBe('example.com');
  });

  it('returns empty for an entry with no hostname left, which callers treat as matching nothing', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('   ')).toBe('');
    expect(normalizeDomain('/')).toBe('');
    expect(normalizeDomain('https://')).toBe('');
  });
});

describe('tool confinement (Correctness Property 1)', () => {
  it('allows only mcp__<server>__*, compute tools, and ToolSearch by default; Bash is denied', () => {
    expect(isToolAllowed(qualifyTool('search_corpus'), base)).toBe(true);
    expect(isToolAllowed(qualifyTool('get_graph_neighbors'), base)).toBe(true);
    expect(isToolAllowed('ToolSearch', base)).toBe(true);
    for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__other__x']) {
      expect(isToolAllowed(tool, base)).toBe(false);
    }
  });

  it('allows WebSearch and WebFetch only when enabled in settings', () => {
    expect(isToolAllowed('WebSearch', withSearch)).toBe(true);
    expect(isToolAllowed('WebFetch', withSearch)).toBe(true);
    expect(isToolAllowed('WebSearch', base)).toBe(false);
    expect(isToolAllowed('WebFetch', base)).toBe(false);
    // Derived from the single source of truth: a hand-copied list here is how the production copy
    // drifted in the first place, and the test would have pinned the drift rather than caught it.
    const baseAllowed = [
      ...DEFAULT_KB_TOOLS.map(qualifyTool),
      'ToolSearch',
      ...COMPUTE_TOOLS,
    ];
    // Bash is never in the set — code execution is unavailable.
    expect(buildAllowedTools(base)).toEqual(baseAllowed);
    expect(buildAllowedTools(withSearch)).toEqual([...baseAllowed, 'WebSearch', 'WebFetch']);
    // Granted, but never pre-approved: the domain check runs in canUseTool, which the SDK skips
    // for anything on `allowedTools`.
    expect(buildAutoApproveTools(buildAllowedTools(withSearch))).toEqual(baseAllowed);
  });

  it('never allow-lists Bash (code execution is unavailable)', () => {
    expect(buildAllowedTools(base)).not.toContain('Bash');
    expect(buildAllowedTools(base, ['search_corpus'])).not.toContain('Bash');
    expect(isToolAllowed('Bash', base)).toBe(false);
  });

  it('exposes the safe in-process compute tools when the playbook does not forbid it', () => {
    for (const t of COMPUTE_TOOLS) {
      expect(buildAllowedTools(base)).toContain(t);
      expect(isToolAllowed(t, base)).toBe(true);
    }
  });

  // Swapping Bash for safe tools changed HOW a playbook computes, not WHETHER it may. The compute
  // tools went in unconditionally, so a playbook that had declared codeExecution:false silently got
  // computation back. Both layers have to agree: an allow-list entry is auto-approved before
  // canUseTool ever runs, so gating only isToolAllowed would not have held.
  it('withholds the compute tools from a playbook that declares codeExecution:false', () => {
    for (const t of COMPUTE_TOOLS) {
      expect(buildAllowedTools(base, ['search_corpus'], false)).not.toContain(t);
      expect(isToolAllowed(t, base, false)).toBe(false);
    }
  });

  it('grants them when the playbook declares codeExecution:true', () => {
    for (const t of COMPUTE_TOOLS) {
      expect(buildAllowedTools(base, ['search_corpus'], true)).toContain(t);
      expect(isToolAllowed(t, base, true)).toBe(true);
    }
  });

  it('canUseTool denies disallowed tools with a message', async () => {
    const canUse = buildCanUseTool(() => base);
    const result = await canUse('Edit', { file: 'secret.txt' }, callOptions);
    expect(result.behavior).toBe('deny');
  });

  it('canUseTool allows knowledge-base tools untouched', async () => {
    const canUse = buildCanUseTool(() => base);
    const result = await canUse(qualifyTool('search_corpus'), { query: 'x' }, callOptions);
    expect(result).toEqual({ behavior: 'allow', updatedInput: { query: 'x' } });
  });

  it('canUseTool intercepts ask_clarifying_question and calls onClarifyingQuestion', async () => {
    let calledId = '';
    let calledQuestion = '';
    let calledOpts: string[] = [];
    const onClarify = async (id: string, q: string, opts: string[]) => {
      calledId = id;
      calledQuestion = q;
      calledOpts = opts;
      return 'clarified-answer';
    };
    const canUse = buildCanUseTool(() => base, 'thread-1', onClarify);
    const result = await canUse(
      qualifyTool('ask_clarifying_question'),
      { question: 'Which one?', options: ['A', 'B'] },
      callOptions,
    );
    expect(calledId).toBe('t1');
    expect(calledQuestion).toBe('Which one?');
    expect(calledOpts).toEqual(['A', 'B']);
    expect(result).toEqual({
      behavior: 'deny',
      message: 'User answered: clarified-answer',
    });
  });

  it('denies WebSearch when it is enabled but no domains are configured', async () => {
    const noDomains: AppSettings = { ...base, webSearch: { enabled: true, allowedDomains: [] } };
    const canUse = buildCanUseTool(() => noDomains);
    const result = await canUse('WebSearch', { query: 'x' }, callOptions);
    expect(result.behavior).toBe('deny');
  });

  it('injects the domain allowlist into every WebSearch call', async () => {
    const canUse = buildCanUseTool(() => withSearch);
    const result = await canUse('WebSearch', { query: 'person table', allowed_domains: ['evil.example'] }, callOptions);
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow') {
      expect(result.updatedInput?.allowed_domains).toEqual(['docs.oneidentity.com', 'learn.microsoft.com']);
    }
  });

  it('respects settings changes between calls (toggle off denies WebSearch)', async () => {
    let current = withSearch;
    const canUse = buildCanUseTool(() => current);
    expect((await canUse('WebSearch', {}, callOptions)).behavior).toBe('allow');
    current = base;
    expect((await canUse('WebSearch', {}, callOptions)).behavior).toBe('deny');
  });

  it('denies WebFetch when it is enabled but no domains are configured', async () => {
    const noDomains: AppSettings = { ...base, webSearch: { enabled: true, allowedDomains: [] } };
    const canUse = buildCanUseTool(() => noDomains);
    const result = await canUse('WebFetch', { url: 'https://docs.oneidentity.com/page' }, callOptions);
    expect(result.behavior).toBe('deny');
  });

  it('denies WebFetch when target URL is not in the allowed domain list', async () => {
    const canUse = buildCanUseTool(() => withSearch);
    const result = await canUse('WebFetch', { url: 'https://evil.com/exfiltrate' }, callOptions);
    expect(result.behavior).toBe('deny');
  });

  it('allows WebFetch when target URL is in the allowed domain list or its subdomain', async () => {
    const canUse = buildCanUseTool(() => withSearch);
    const result1 = await canUse('WebFetch', { url: 'https://docs.oneidentity.com/r/Identity-Manager' }, callOptions);
    expect(result1).toEqual({
      behavior: 'allow',
      updatedInput: { url: 'https://docs.oneidentity.com/r/Identity-Manager' },
    });

    const result2 = await canUse('WebFetch', { url: 'https://learn.microsoft.com/en-us/entra' }, callOptions);
    expect(result2).toEqual({
      behavior: 'allow',
      updatedInput: { url: 'https://learn.microsoft.com/en-us/entra' },
    });
  });

  it('injects the NORMALISED domain list into WebSearch, not the raw entries', async () => {
    const messy: AppSettings = {
      ...base,
      webSearch: { enabled: true, allowedDomains: ['https://docs.oneidentity.com/r/guide', '*.microsoft.com'] },
    };
    const canUse = buildCanUseTool(() => messy);
    const result = await canUse('WebSearch', { query: 'x' }, callOptions);
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { query: 'x', allowed_domains: ['docs.oneidentity.com', 'microsoft.com'] },
    });
  });

  it('refuses both web tools when every configured entry normalises away to nothing', async () => {
    // A list of pure punctuation is not configuration. Counting it as such would hand WebSearch an
    // empty `allowed_domains`, which the API reads as no restriction at all.
    const junk: AppSettings = { ...base, webSearch: { enabled: true, allowedDomains: ['https://', '  ', '/'] } };
    const canUse = buildCanUseTool(() => junk);
    expect((await canUse('WebSearch', { query: 'x' }, callOptions)).behavior).toBe('deny');
    expect((await canUse('WebFetch', { url: 'https://evil.com' }, callOptions)).behavior).toBe('deny');
  });

  it('honours a wildcard entry for WebFetch instead of silently matching nothing', async () => {
    const wildcard: AppSettings = { ...base, webSearch: { enabled: true, allowedDomains: ['*.microsoft.com'] } };
    const canUse = buildCanUseTool(() => wildcard);
    expect((await canUse('WebFetch', { url: 'https://learn.microsoft.com/x' }, callOptions)).behavior).toBe('allow');
    expect((await canUse('WebFetch', { url: 'https://microsoft.com' }, callOptions)).behavior).toBe('allow');
    expect((await canUse('WebFetch', { url: 'https://evil.com' }, callOptions)).behavior).toBe('deny');
  });

  it('respects settings changes between calls for WebFetch', async () => {
    let current = withSearch;
    const canUse = buildCanUseTool(() => current);
    expect((await canUse('WebFetch', { url: 'https://docs.oneidentity.com' }, callOptions)).behavior).toBe('allow');
    current = base;
    expect((await canUse('WebFetch', { url: 'https://docs.oneidentity.com' }, callOptions)).behavior).toBe('deny');
  });

  /**
   * Asserting only `.behavior` is what let WebFetch ship broken: the CLI validates this reply
   * against a zod union whose `allow` branch requires `updatedInput`, so a bare allow is rejected
   * and the call dies with a ZodError. Every allow the policy can emit is checked here, because a
   * `.behavior`-only assertion cannot tell a working allow from an unusable one.
   */
  it('every allow decision carries updatedInput, which the SDK requires at runtime', async () => {
    const orchestrated = buildCanUseTool(() => withSearch, undefined, undefined, undefined, undefined, true);
    const canUse = buildCanUseTool(() => withSearch);
    const cases: Array<[string, Record<string, unknown>, ReturnType<typeof buildCanUseTool>]> = [
      [qualifyTool('search_corpus'), { query: 'x' }, canUse],
      ['ToolSearch', { query: 'x' }, canUse],
      ['WebSearch', { query: 'x' }, canUse],
      ['WebFetch', { url: 'https://docs.oneidentity.com/r/x' }, canUse],
      ['Agent', { prompt: 'x' }, orchestrated],
    ];
    for (const [tool, input, policy] of cases) {
      const result = await policy(tool, input, callOptions);
      expect(result.behavior, `${tool} should be allowed`).toBe('allow');
      // A record, not merely present: the schema rejects null/undefined on this branch.
      expect(
        result.behavior === 'allow' && typeof result.updatedInput === 'object' && result.updatedInput !== null,
        `${tool} allow is missing updatedInput and would fail the SDK's schema`,
      ).toBe(true);
    }
  });
});

/**
 * `qualifyTool` used to prefix everything, which quietly made per-playbook web access
 * inexpressible: a declared `WebSearch` became `mcp__yvoke__WebSearch`, a tool no server serves,
 * while the real one arrived from the global settings toggle instead. The only way to grant web
 * access was therefore to grant it to every playbook and every specialist at once.
 */
describe('qualifyTool — built-ins', () => {
  it('leaves harness tools unprefixed', () => {
    expect(qualifyTool('WebSearch')).toBe('WebSearch');
    expect(qualifyTool('WebFetch')).toBe('WebFetch');
    expect(qualifyTool('ToolSearch')).toBe('ToolSearch');
  });

  it('accepts the casing a playbook author is likely to write', () => {
    expect(qualifyTool('websearch')).toBe('WebSearch');
    expect(qualifyTool('webfetch')).toBe('WebFetch');
  });

  it('still prefixes a server tool whose name merely resembles one', () => {
    expect(qualifyTool('web_search_corpus')).toBe(`${MCP_TOOL_PREFIX}web_search_corpus`);
  });
});

describe('buildAllowedTools — per-playbook web access', () => {
  const on: AppSettings = { ...base, webSearch: { enabled: true, allowedDomains: ['example.com'] } };

  it('withholds the web tools from a playbook that does not declare them', () => {
    const granted = buildAllowedTools(on, ['search_corpus']);
    expect(granted).not.toContain('WebSearch');
    expect(granted).not.toContain('WebFetch');
  });

  it('grants exactly what the playbook declares', () => {
    const granted = buildAllowedTools(on, ['search_corpus', 'WebSearch']);
    expect(granted).toContain('WebSearch');
    expect(granted).not.toContain('WebFetch');
  });

  it('never lets a declaration outrank the settings toggle', () => {
    // The declared name now survives qualifyTool unchanged, so without stripping it before the
    // gate it would land in the allow-list on its own. That is the bug this asserts against.
    const granted = buildAllowedTools(base, ['search_corpus', 'WebSearch', 'WebFetch']);
    expect(granted).not.toContain('WebSearch');
    expect(granted).not.toContain('WebFetch');
    expect(granted).not.toContain(`${MCP_TOOL_PREFIX}WebSearch`);
  });

  it('keeps plain chat governed by the setting alone', () => {
    // No playbook means no declaration to read, so the operator's switch is the only signal there
    // is. The per-playbook rule exists for the specialists, where the fan-out risk lives.
    expect(buildAllowedTools(on)).toContain('WebSearch');
    expect(buildAllowedTools(base)).not.toContain('WebSearch');
  });
});

describe('isUrlDomainAllowed — path-scoped entries', () => {
  const scoped = ['www.example.com/community/'];

  it('permits the named subtree', () => {
    expect(isUrlDomainAllowed('https://www.example.com/community/f/forum/1/x', scoped)).toBe(true);
  });

  it('refuses the rest of the same host', () => {
    expect(isUrlDomainAllowed('https://www.example.com/', scoped)).toBe(false);
    expect(isUrlDomainAllowed('https://www.example.com/products/pricing', scoped)).toBe(false);
  });

  it('ignores case and query string', () => {
    expect(isUrlDomainAllowed('https://www.example.com/Community/x?y=1', scoped)).toBe(true);
  });

  it('treats a bare trailing slash as the whole host, not a prefix', () => {
    expect(isUrlDomainAllowed('https://www.example.com/anything', ['www.example.com/'])).toBe(true);
  });

  it('leaves a host-only entry unrestricted, as before', () => {
    expect(isUrlDomainAllowed('https://docs.example.com/a/b', ['example.com'])).toBe(true);
  });

  /*
   * The prefix is matched on segment boundaries, not as raw text. A bare `startsWith` let an entry
   * written without its trailing slash reach every sibling whose name merely began the same way —
   * the opposite of what adding a path asks for, and silent: nothing in the editor flags a missing
   * slash, because a missing slash is not what is wrong with the entry.
   */
  it('does not leak into a sibling whose name merely starts the same way', () => {
    const noSlash = ['www.example.com/community'];
    expect(isUrlDomainAllowed('https://www.example.com/community-blog/secret', noSlash)).toBe(false);
    expect(isUrlDomainAllowed('https://www.example.com/communityXYZ', noSlash)).toBe(false);
  });

  it('means the same thing written with or without the trailing slash', () => {
    for (const entry of ['www.example.com/community', 'www.example.com/community/']) {
      expect(isUrlDomainAllowed('https://www.example.com/community', [entry])).toBe(true);
      expect(isUrlDomainAllowed('https://www.example.com/community/f/1', [entry])).toBe(true);
      expect(isUrlDomainAllowed('https://www.example.com/products', [entry])).toBe(false);
    }
  });

  it('refuses a percent-encoded path rather than decoding it — the fail-closed direction', () => {
    // `URL` does not decode `pathname`, and nothing here pretends otherwise.
    expect(isUrlDomainAllowed('https://www.example.com/%63ommunity/x', ['www.example.com/community/'])).toBe(false);
  });
});

/**
 * The allow-list and `WAF_CHALLENGED_HOSTS` are maintained independently, and the fetch gate
 * consults the second one FIRST — so a configuration whose every entry names a challenged host
 * grants WebFetch nothing at all. Runtime says nothing about that: the calls simply deny, one
 * wasted turn at a time. These assert that the startup log names the state instead.
 */
describe('webAccessDiagnostics', () => {
  const on = (allowedDomains: string[]): AppSettings => ({
    ...base,
    webSearch: { enabled: true, allowedDomains },
  });

  it('says nothing is fetchable when every entry names a bot-challenged host', () => {
    const lines = webAccessDiagnostics(on(['support.oneidentity.com', 'www.oneidentity.com/community/']));
    expect(lines.join('\n')).toMatch(/no configured entry names a fetchable host/);
    expect(lines.join('\n')).toMatch(/support\.oneidentity\.com/);
  });

  it('reports what a fetch can actually reach when something can', () => {
    const lines = webAccessDiagnostics(on(['docs.oneidentity.com', 'support.oneidentity.com'])).join('\n');
    expect(lines).toMatch(/WebFetch may reach: docs\.oneidentity\.com/);
    expect(lines).toMatch(/refuses these bot-challenged hosts outright: support\.oneidentity\.com/);
    expect(lines).not.toMatch(/no configured entry names a fetchable host/);
  });

  it('reports the fail-closed states plainly', () => {
    expect(webAccessDiagnostics(base).join('\n')).toMatch(/off/);
    expect(webAccessDiagnostics(on([' . '])).join('\n')).toMatch(/every search and fetch is refused/);
  });
});

/**
 * These hosts answer a non-browser client with an empty HTTP 202 and `x-amzn-waf-action: challenge`.
 * WebFetch therefore returns a page with no content rather than an error — a silent nothing, which
 * is the shape that invites the model to fill the gap from memory and attribute it to a URL it
 * never read. Denying with a message that names the alternative is the point of the rule.
 */
describe('canUseTool — WebFetch on a bot-challenged host', () => {
  const on: AppSettings = {
    ...base,
    webSearch: {
      enabled: true,
      allowedDomains: ['support.oneidentity.com', 'www.oneidentity.com/community/'],
    },
  };
  const canUse = buildCanUseTool(() => on, 't', undefined, buildAllowedTools(on));

  it('refuses even though the host is on the allow-list, and says what to do instead', async () => {
    const result = await canUse(
      'WebFetch',
      { url: 'https://support.oneidentity.com/kb/4380945/x' },
      callOptions,
    );
    expect(result.behavior).toBe('deny');
    const message = (result as { message: string }).message;
    expect(message).toMatch(/WebSearch/);
    expect(message).toMatch(/do not state or imply that you read the page/i);
  });

  it('refuses the community host too', async () => {
    const result = await canUse(
      'WebFetch',
      { url: 'https://www.oneidentity.com/community/identity-manager/f/forum' },
      callOptions,
    );
    expect(result.behavior).toBe('deny');
  });

  it('leaves the fetchable sibling host alone — matched exactly, never by suffix', async () => {
    const docs: AppSettings = {
      ...base,
      webSearch: { enabled: true, allowedDomains: ['docs.oneidentity.com'] },
    };
    const canUseDocs = buildCanUseTool(() => docs, 't', undefined, buildAllowedTools(docs));
    const result = await canUseDocs(
      'WebFetch',
      { url: 'https://docs.oneidentity.com/identity-manager/9.3.1/x' },
      callOptions,
    );
    expect(result.behavior).toBe('allow');
  });

  it('still allows WebSearch against those hosts — the index is reachable, the page is not', async () => {
    const result = await canUse('WebSearch', { query: 'defect 4380945' }, callOptions);
    expect(result.behavior).toBe('allow');
    // The API takes bare domains, so a path-scoped entry contributes its host and the path is lost.
    expect(
      (result as unknown as { updatedInput: { allowed_domains: string[] } }).updatedInput
        .allowed_domains,
    ).toEqual(['support.oneidentity.com', 'www.oneidentity.com']);
  });
});

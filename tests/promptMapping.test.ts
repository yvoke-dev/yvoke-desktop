import { describe, expect, it } from 'vitest';
import { toPromptInfo } from '../src/main/agent/McpPrompts';
import { buildAllowedTools } from '../src/main/agent/policy';
import { COMPUTE_TOOLS } from '../src/main/agent/computeTools';
import { qualifyTool } from '../src/shared/types';
import type { AppSettings } from '../src/shared/types';

/**
 * A prompts/list entry exactly as the server sends it — note `_meta`, with the underscore.
 * Reproduced from a live response so this test fails if the field name ever drifts again.
 */
const SERVED = {
  name: 'oim-getting-started',
  description: 'Answer One Identity Manager onboarding and end-user questions.',
  _meta: {
    codeExecution: false,
    targetAgent: 'specialist',
    tools: ['ask_clarifying_question', 'get_section', 'search_corpus', 'search_graph_entities', 'verify_citations'],
  },
};

// buildAllowedTools only reads webSearch; the rest is irrelevant to this seam.
const settings = { webSearch: { enabled: false, allowedDomains: [] } } as unknown as AppSettings;

describe('toPromptInfo', () => {
  // The regression this file exists for: the mapper read `p.meta`, which MCP does not define, so
  // every playbook arrived unconstrained and the policy layer silently applied its defaults.
  it('reads the constraints from _meta, where MCP actually puts them', () => {
    const info = toPromptInfo(SERVED);
    expect(info.tools).toEqual(SERVED._meta.tools);
    expect(info.codeExecution).toBe(false);
    expect(info.targetAgent).toBe('specialist');
  });

  it('still reads a server that sends a bare `meta`', () => {
    const info = toPromptInfo({ name: 'x', meta: { targetAgent: 'reviewer', codeExecution: true, tools: ['a'] } });
    expect(info.targetAgent).toBe('reviewer');
    expect(info.codeExecution).toBe(true);
    expect(info.tools).toEqual(['a']);
  });

  // Undefined is meaningful downstream: buildAllowedTools reads it as "not declared" and falls
  // back to the default set, so it must not be confused with an empty declaration.
  it('leaves everything undefined when the server declares nothing', () => {
    const info = toPromptInfo({ name: 'x' });
    expect(info.tools).toBeUndefined();
    expect(info.codeExecution).toBeUndefined();
    expect(info.targetAgent).toBeUndefined();
    expect(info.title).toBe('x');
    expect(info.description).toBe('');
  });

  it('ignores metadata of the wrong type rather than passing it on', () => {
    const info = toPromptInfo({ name: 'x', _meta: { tools: 'search_corpus', codeExecution: 'yes', targetAgent: 7 } });
    expect(info.tools).toBeUndefined();
    expect(info.codeExecution).toBeUndefined();
    expect(info.targetAgent).toBeUndefined();
  });
});

// End to end over the seam that was broken: a served payload has to reach the allow-list.
describe('served metadata reaches the tool policy', () => {
  it('grants exactly the declared tools and withholds compute for codeExecution:false', () => {
    const info = toPromptInfo(SERVED);
    const allowed = buildAllowedTools(settings, info.tools, info.codeExecution);

    for (const tool of SERVED._meta.tools) expect(allowed).toContain(qualifyTool(tool));
    // Not declared by this playbook, and previously granted anyway via DEFAULT_KB_TOOLS.
    expect(allowed).not.toContain(qualifyTool('query_json_objects'));
    expect(allowed).not.toContain(qualifyTool('get_toc'));
    for (const tool of COMPUTE_TOOLS) expect(allowed).not.toContain(tool);
    expect(allowed).not.toContain('Bash');
  });

  it('grants compute to a playbook that declares codeExecution:true', () => {
    const info = toPromptInfo({
      name: 'oim-customers',
      _meta: { targetAgent: 'specialist', codeExecution: true, tools: ['search_corpus'] },
    });
    const allowed = buildAllowedTools(settings, info.tools, info.codeExecution);
    for (const tool of COMPUTE_TOOLS) expect(allowed).toContain(tool);
  });

  // What the app did for every playbook while the mapping was broken.
  it('falls back to the default set only when nothing was declared', () => {
    const info = toPromptInfo({ name: 'unconstrained' });
    const allowed = buildAllowedTools(settings, info.tools, info.codeExecution);
    expect(allowed).toContain(qualifyTool('query_json_objects'));
    expect(allowed).toContain(qualifyTool('search_corpus'));
    for (const tool of COMPUTE_TOOLS) expect(allowed).toContain(tool);
  });
});

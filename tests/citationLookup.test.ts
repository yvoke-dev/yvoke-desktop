import { describe, expect, it } from 'vitest';
import { McpPrompts } from '../src/main/agent/McpPrompts';
import type { AppSettings, CitationRef } from '../src/shared/types';

/** One recorded `get_section` call, so a test can assert WHICH parameter was tried and in what order. */
interface Call {
  chunk_id?: string;
  document_id?: string;
  document?: string;
}

/**
 * A stand-in MCP client. `McpPrompts.connect()` returns its cached client when one is already set,
 * so assigning the private field is enough to keep the whole transport/auth path out of the test.
 */
function withFakeClient(reply: (args: Call) => { text: string; isError?: boolean }): {
  prompts: McpPrompts;
  calls: Call[];
} {
  const calls: Call[] = [];
  const prompts = new McpPrompts({
    getSettings: () => ({}) as AppSettings,
    auth: {} as never,
  });
  (prompts as unknown as { client: unknown }).client = {
    async callTool({ arguments: args }: { arguments: Call }) {
      calls.push(args);
      const { text, isError } = reply(args);
      // The server serializes a tool's String return as a JSON-encoded string.
      return { content: [{ type: 'text', text: JSON.stringify(text) }], isError };
    },
  };
  return { prompts, calls };
}

const CHUNK = '274b9610-9148-4621-a5a1-089e807210c1';
const SECTION = '# Section: How are schemas mapped\n_(document: Basics…)_\n';
/**
 * What `GetSectionTool` actually returns for a miss: a plain string from
 * `McpToolUtils.toolError`, with NO `isError` flag. That is the whole reason the fallback cannot
 * key on `isError` alone.
 */
const TOOL_ERROR = "ERROR: the 'get_section' tool failed to complete the request.";

describe('bare-id citation lookup', () => {
  it('resolves a bare id as a chunk when the chunk exists — one call, no document probe', async () => {
    const { prompts, calls } = withFakeClient((a) =>
      a.chunk_id === CHUNK ? { text: SECTION } : { text: TOOL_ERROR },
    );
    await expect(prompts.getSection({ id: CHUNK })).resolves.toBe(SECTION);
    expect(calls).toEqual([{ chunk_id: CHUNK }]);
  });

  it('falls back to document_id when the id names a document, not a chunk', async () => {
    // The minority case the web frontend gets wrong: it hard-codes data-chunk-id, so a bare
    // document id shows "This source is no longer available" instead of the document.
    const { prompts, calls } = withFakeClient((a) =>
      a.document_id === CHUNK ? { text: SECTION } : { text: TOOL_ERROR },
    );
    await expect(prompts.getSection({ id: CHUNK })).resolves.toBe(SECTION);
    expect(calls).toEqual([{ chunk_id: CHUNK }, { document_id: CHUNK }]);
  });

  it('throws when neither table has the id', async () => {
    const { prompts, calls } = withFakeClient(() => ({ text: TOOL_ERROR }));
    await expect(prompts.getSection({ id: CHUNK })).rejects.toThrow(/get_section/);
    expect(calls).toHaveLength(2);
  });

  it('never renders a tool error as if it were the cited passage', async () => {
    // Regression: `isError` is unset on this reply, so the old code returned the error STRING as
    // the section body and the citation dialog rendered it as markdown.
    const { prompts } = withFakeClient(() => ({ text: TOOL_ERROR }));
    await expect(prompts.getSection({ chunkId: 'abc123' })).rejects.toThrow(TOOL_ERROR);
  });

  it('still sends an explicit chunk/document/file ref as a single call', async () => {
    const cases: [CitationRef, Call][] = [
      [{ chunkId: 'abc123' }, { chunk_id: 'abc123' }],
      [{ documentId: CHUNK }, { document_id: CHUNK }],
      [{ file: 'guide.md' }, { document: 'guide.md' }],
    ];
    for (const [ref, expected] of cases) {
      const { prompts, calls } = withFakeClient(() => ({ text: SECTION }));
      await expect(prompts.getSection(ref)).resolves.toBe(SECTION);
      expect(calls).toEqual([expected]);
    }
  });
});

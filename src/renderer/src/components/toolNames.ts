import type { ToolCallInfo } from '../../../shared/types';

/** Strip the `mcp__<server>__` namespace the SDK prefixes onto every server tool. */
export function shortName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' › ');
  }
  return undefined;
}

function truncate(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * The argument a tool was actually called with, as one readable phrase.
 *
 * A trace of nine rows that all read "search_corpus" is a spinner with extra steps — the whole
 * point of the list is that each row says what happened. Keys are tried in the order that reads
 * best for each tool, then a generic sweep covers tools this list has never heard of, so a new
 * server tool degrades to "its first string argument" rather than to nothing.
 */
export function describeArgs(call: ToolCallInfo): string | undefined {
  const tool = shortName(call.name);
  const byTool: Record<string, string[]> = {
    search_corpus: ['query', 'q'],
    search_graph_entities: ['query', 'name'],
    get_section: ['heading_path', 'document', 'chunk_id', 'document_id'],
    get_toc: ['document', 'document_id'],
    list_documents: ['collection', 'tag'],
    query_json_objects: ['query', 'table', 'collection'],
    get_json_schema: ['table', 'collection'],
    get_graph_neighbors: ['entity', 'id', 'name'],
    verify_citations: ['answer', 'text'],
    ToolSearch: ['query'],
    WebSearch: ['query'],
    WebFetch: ['url'],
    Bash: ['command'],
    Read: ['file_path'],
  };
  const found = firstString(call.input, byTool[tool] ?? []);
  if (found) return truncate(found);
  // Generic fallback: the first non-trivial string argument, whatever it is called.
  if (call.input && typeof call.input === 'object') {
    for (const value of Object.values(call.input as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 1) return truncate(value);
    }
  }
  return undefined;
}

/**
 * What came back, in a few words. Returns `undefined` rather than guessing when a result has no
 * shape this understands — an honest blank beats an invented count.
 */
export function describeResult(call: ToolCallInfo): { text: string; good?: boolean } | undefined {
  if (call.result === undefined) return undefined;
  if (call.isError) return { text: 'failed' };
  const tool = shortName(call.name);
  const raw = call.result;

  if (tool === 'verify_citations') {
    const verified = /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:citations?\s*)?verified/i.exec(raw);
    if (verified) return { text: `${verified[1]} of ${verified[2]} verified`, good: true };
  }

  // Corpus retrieval answers as a JSON array (or an object wrapping one); a count is the only
  // part of it worth a trace row.
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (Array.isArray(parsed)) return { text: `${parsed.length} result${parsed.length === 1 ? '' : 's'}` };
    if (parsed && typeof parsed === 'object') {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          return { text: `${value.length} result${value.length === 1 ? '' : 's'}` };
        }
      }
    }
  } catch {
    /* not JSON — fall through to the size hint below */
  }

  const chars = raw.trim().length;
  if (chars === 0) return { text: 'empty' };
  if (chars > 400) return { text: `${Math.round(chars / 100) / 10}k chars` };
  return undefined;
}

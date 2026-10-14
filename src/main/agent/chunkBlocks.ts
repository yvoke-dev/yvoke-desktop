/**
 * TypeScript port of `yvoke-web`'s `ChunkBlocks.java` — the one place the `search_corpus` and
 * `get_section` passage layouts are parsed (and formatted in test fixtures) for `EvidenceDigest`.
 *
 * The parser is deliberately strict about the header and deliberately generous about everything
 * else: text with no recognisable header is NOT chunk output, and reporting that honestly (zero
 * blocks, everything as preamble) is what lets callers pass a `query_json_objects` table or a tool
 * error through untouched instead of mangling it.
 */

/**
 * Anchored on the WHOLE header line, never on the `"### "` prefix alone. Chunk bodies are ingested
 * markdown and routinely contain their own `### Heading` lines, so a prefix match shreds one chunk
 * into several fragments — each then carrying the wrong id, or none.
 *
 * The double spaces are load-bearing (they are what `search_corpus` writes), and both id groups
 * accept the empty string because `format` emits a bare `id=` for a null id.
 */
const HEADER_LINE =
  /^### (?<kind>[^/\n]*)\/(?<title>[^\n]*?)  \(score=(?<score>-?\d+\.\d{3})  id=(?<id>[0-9a-fA-F-]*)  doc_id=(?<doc>[0-9a-fA-F-]*)\)$/;

const HEADER_GLOBAL = new RegExp(HEADER_LINE.source, 'gm');

/**
 * The second block shape: what `get_section` writes above each passage it returns.
 *
 * It carries `doc_id` as well as `id` so an answer citing a section by its document still retains
 * the passages.
 */
const SECTION_MARKER_LINE = /^_\(id=(?<id>[0-9a-fA-F-]*)  doc_id=(?<doc>[0-9a-fA-F-]*)\)_$/;

const SECTION_MARKER_GLOBAL = new RegExp(SECTION_MARKER_LINE.source, 'gm');

/**
 * A trailing italic parenthetical on its own paragraph — what `search_corpus` appends to say the
 * result was capped. Split off rather than left on the last chunk's body so reducing that chunk to
 * a reference does not delete the notice.
 */
const TRAILING_NOTE = /\n\n_\([^\n]*\)_\s*$/;

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Stands in for the body of a chunk this conversation already received in full.
 * Parentheses, never brackets, so citation scanners looking inside `[...]` never mistake it for a
 * citation.
 */
export const SHOWN_ABOVE = '_(already shown above — full text is earlier in this conversation)_';

export interface ChunkBlock {
  readonly raw: string;
  readonly header: string;
  readonly kind: string;
  readonly title: string;
  readonly chunkId: string | null;
  readonly documentId: string | null;
  readonly headingPath: string;
  readonly body: string;
  readonly isShownAboveMarker: boolean;
  /** The same block with its body replaced — the inverse of parsing, minus the separator. */
  withBody(replacement: string): string;
  /** Names the chunk well enough to decide whether to fetch it, without quoting any of it. */
  manifestLine(): string;
}

export interface ParsedChunkBlocks {
  readonly preamble: string;
  readonly blocks: readonly ChunkBlock[];
  readonly suffix: string;
}

export interface ChunkHitInput {
  id?: string | null;
  documentId?: string | null;
  text?: string | null;
  headingPath?: string[] | null;
  heading?: string | null;
  documentTitle?: string | null;
  kind?: string | null;
  score: number;
}

function toUuid(value: string | undefined | null): string | null {
  if (!value || !value.trim()) return null;
  const clean = value.trim();
  return UUID_REGEX.test(clean) ? clean.toLowerCase() : null;
}

function createBlock(
  raw: string,
  header: string,
  kind: string,
  title: string,
  chunkId: string | null,
  documentId: string | null,
  headingPath: string,
  body: string,
): ChunkBlock {
  return {
    raw,
    header,
    kind,
    title,
    chunkId,
    documentId,
    headingPath,
    body,
    isShownAboveMarker: body === SHOWN_ABOVE,
    withBody(replacement: string): string {
      let out = header;
      if (headingPath.length > 0) {
        out += `\n> ${headingPath}`;
      }
      out += `\n${replacement}`;
      return out.replace(/\s+$/, '');
    },
    manifestLine(): string {
      let out = '- ';
      if (chunkId !== null) {
        out += `chunk_id=${chunkId}`;
      } else if (documentId !== null) {
        out += `document_id=${documentId}`;
      } else {
        out += '(no id)';
      }
      out += ` · ${kind}/${title}`;
      if (headingPath.length > 0) {
        out += ` · ${headingPath}`;
      }
      return out;
    },
  };
}

function toBlock(raw: string): ChunkBlock {
  const nl = raw.indexOf('\n');
  const header = nl < 0 ? raw : raw.slice(0, nl);
  let rest = nl < 0 ? '' : raw.slice(nl + 1);

  let headingPath = '';
  if (rest.startsWith('> ')) {
    const hnl = rest.indexOf('\n');
    headingPath = (hnl < 0 ? rest : rest.slice(0, hnl)).slice(2);
    rest = hnl < 0 ? '' : rest.slice(hnl + 1);
  }

  let kind = '?';
  let title = '?';
  let chunkId: string | null = null;
  let documentId: string | null = null;

  const m = HEADER_LINE.exec(header);
  if (m && m.groups) {
    kind = m.groups.kind;
    title = m.groups.title;
    chunkId = toUuid(m.groups.id);
    documentId = toUuid(m.groups.doc);
  } else {
    const sm = SECTION_MARKER_LINE.exec(header);
    if (sm && sm.groups) {
      chunkId = toUuid(sm.groups.id);
      documentId = toUuid(sm.groups.doc);
    }
  }

  return createBlock(raw, header, kind, title, chunkId, documentId, headingPath, rest.trim());
}

/**
 * Splits a rendered tool result into its chunk blocks. Text containing no chunk header comes back
 * as pure preamble with an empty block list — the caller's signal that there is nothing here to
 * reduce.
 */
export function parseChunkBlocks(rendered: string | null | undefined): ParsedChunkBlocks {
  if (!rendered) {
    return { preamble: '', blocks: [], suffix: '' };
  }

  const starts: number[] = [];
  for (const match of rendered.matchAll(HEADER_GLOBAL)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  for (const match of rendered.matchAll(SECTION_MARKER_GLOBAL)) {
    if (match.index !== undefined) starts.push(match.index);
  }
  starts.sort((a, b) => a - b);

  if (starts.length === 0) {
    return { preamble: rendered, blocks: [], suffix: '' };
  }

  let contentEnd = rendered.length;
  let suffix = '';
  const note = TRAILING_NOTE.exec(rendered);
  if (note && note.index > starts[starts.length - 1]) {
    contentEnd = note.index;
    suffix = rendered.slice(contentEnd);
  }

  const blocks: ChunkBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : contentEnd;
    blocks.push(toBlock(rendered.slice(from, to)));
  }

  return {
    preamble: rendered.slice(0, starts[0]),
    blocks,
    suffix,
  };
}

/**
 * Renders search hits in the exact format `search_corpus` produces, replacing the body of any
 * chunk `seen` has already recorded with `SHOWN_ABOVE`.
 */
export function formatChunkBlocks(chunks: readonly ChunkHitInput[], seen?: Set<string>): string {
  if (!chunks || chunks.length === 0) {
    return '(no matching chunks)';
  }
  const lines: string[] = [];
  for (const c of chunks) {
    const cid = toUuid(c.id) ?? '';
    const docId = toUuid(c.documentId) ?? '';
    const text = (c.text ?? '').trim();
    const title = c.documentTitle ?? '?';
    const kind = c.kind ?? '?';
    let headPath = '';
    if (c.headingPath && c.headingPath.length > 0) {
      headPath = c.headingPath.join(' > ');
    } else if (c.heading) {
      headPath = c.heading;
    }

    lines.push(`### ${kind}/${title}  (score=${c.score.toFixed(3)}  id=${cid}  doc_id=${docId})`);
    if (headPath.length > 0) {
      lines.push(`> ${headPath}`);
    }
    let firstSighting = true;
    if (cid.length > 0 && seen) {
      if (seen.has(cid)) {
        firstSighting = false;
      } else {
        seen.add(cid);
      }
    }
    lines.push(firstSighting ? text : SHOWN_ABOVE);
    lines.push('');
  }
  return lines.join('\n').trim();
}

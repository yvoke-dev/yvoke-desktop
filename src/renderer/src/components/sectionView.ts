/*
 * Splits a `get_section` result into the passages it is made of.
 *
 * `get_section` is an AGENT-facing tool that the citation panel happens to reuse, and since the
 * server started emitting a per-passage chunk id its output carries plumbing meant for a model, not
 * a reader: an `_(id=…  doc_id=…)_` line above every passage, and a meta line ending in the
 * directive "cite a passage by the id shown above it". Rendering that string as markdown put two
 * raw uuids and an instruction addressed to an agent in front of the user, once per passage.
 *
 * Deleting the markers would be enough to fix the noise, but they are worth more than that. A
 * citation names ONE passage, while `get_section` returns the whole section around it — so the
 * marker is exactly what tells us which part of the panel the user actually clicked. Parsing lets
 * that passage be marked instead of leaving the reader to guess which paragraph was the source.
 */

/** One passage of a section: its ids, and its prose with the marker line removed. */
export interface SectionPassage {
  /** Chunk id from the marker; absent for a section rendered without markers. */
  id?: string;
  documentId?: string;
  text: string;
}

export interface ParsedSection {
  /** The `# Section: …` line, without the leading hash. */
  heading?: string;
  /** The `_(document: …  ·  tag: …)_` line, stripped of any agent-facing directive. */
  meta?: string;
  documentTitle?: string;
  passages: SectionPassage[];
}

/**
 * The per-passage marker, mirroring `ChunkBlocks.SECTION_MARKER` on the server
 * (`^_\(id=(?<id>[0-9a-fA-F-]*)  doc_id=(?<doc>[0-9a-fA-F-]*)\)_$`).
 *
 * The server writes exactly two spaces between the fields; `\s+` is used here rather than a literal
 * `  ` so a future change to that spacing degrades into a still-parsed marker instead of a raw uuid
 * back on screen. Both id groups accept the empty string because the server emits a bare `id=` for
 * a null id.
 */
const PASSAGE_MARKER = /^_\(id=([0-9a-fA-F-]*)\s+doc_id=([0-9a-fA-F-]*)\)_$/;

/** `# Section: How are schemas mapped` */
const HEADING = /^#\s+Section:\s*(.+)$/;

/** The `_( … )_` line under the heading. Not a passage marker — that is matched first. */
const META = /^_\((.+)\)_$/;

/**
 * Trailing ` · cite a passage by the id shown above it` and friends: instructions the tool gives a
 * model about how to cite, which say nothing to someone reading the source. Matched on the leading
 * verb rather than the full sentence so a reworded directive is still dropped.
 */
const AGENT_DIRECTIVE = /\s*·\s*cite\b[^·]*$/i;

/**
 * Some DB extracts contain markdown table cells with embedded line breaks (a bare `\r` or `\n`
 * inside a Description cell — e.g. a bulleted list). CommonMark treats all of `\r`, `\n`, `\r\n` as
 * line endings, so micromark/remark-gfm sees the cell as multi-line, terminates the table, and
 * dumps the remaining rows as raw `| … |` text. Rejoin any table row that a wrapped cell left open
 * (no trailing `|`) into one line.
 */
function joinWrappedTableRows(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*\|/.test(line) && !/\|\s*$/.test(line)) {
      while (i + 1 < lines.length && !/\|\s*$/.test(line)) {
        i++;
        line = line.replace(/\s+$/, '') + ' ' + lines[i].replace(/^\s+/, '');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The section markdown carries invisible raw HTML (per-topic `<a id>` anchors and `<!-- … -->`
 * comments). react-markdown doesn't render HTML, so strip them rather than leaking literal tags.
 */
export function cleanPassage(md: string): string {
  const normalized = md.replace(/\r\n?/g, '\n');
  return joinWrappedTableRows(normalized)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s+id="[^"]*"\s*\/?>(\s*<\/a>)?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Compare two ids ignoring case and hyphens, the two ways the same uuid gets written. */
function sameId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();
}

/** True when this passage is the one the citation pointed at. */
export function isCited(passage: SectionPassage, citedId?: string): boolean {
  return sameId(passage.id, citedId);
}

/**
 * Parse a `get_section` result. A section with no markers at all — an older server, or any other
 * text that reached the panel — comes back as one unlabelled passage holding everything, so the
 * caller renders it exactly as before rather than showing nothing.
 */
export function parseSection(md: string): ParsedSection {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const result: ParsedSection = { passages: [] };

  let current: { id?: string; documentId?: string; body: string[] } | null = null;
  const preamble: string[] = [];

  const flush = (): void => {
    if (!current) return;
    const text = cleanPassage(current.body.join('\n'));
    // A marker with no prose under it is plumbing with nothing attached; dropping it keeps an
    // empty bordered box out of the panel.
    if (text) {
      result.passages.push({ id: current.id || undefined, documentId: current.documentId || undefined, text });
    }
    current = null;
  };

  for (const line of lines) {
    const marker = PASSAGE_MARKER.exec(line.trim());
    if (marker) {
      flush();
      current = { id: marker[1], documentId: marker[2], body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
      continue;
    }
    // Still above the first marker: heading and meta are recognised, anything else is prose that
    // belongs to the section itself (a document read with no markers lands entirely here).
    const heading = HEADING.exec(line.trim());
    if (heading && result.heading === undefined) {
      result.heading = heading[1].trim();
      continue;
    }
    const meta = META.exec(line.trim());
    if (meta && result.meta === undefined) {
      const docTitleMatch = /\bdocument:\s*([^·]+)/i.exec(meta[1]);
      if (docTitleMatch) {
        result.documentTitle = docTitleMatch[1].trim();
      }
      const text = meta[1].replace(AGENT_DIRECTIVE, '').trim();
      if (text) result.meta = text;
      continue;
    }
    preamble.push(line);
  }
  flush();

  // No markers anywhere: keep the whole thing as one passage so nothing is lost.
  if (result.passages.length === 0) {
    const text = cleanPassage(preamble.join('\n'));
    if (text) result.passages.push({ text });
  }
  return result;
}

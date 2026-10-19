import { fromHtml } from 'hast-util-from-html';

/**
 * Matches a fenced code block in raw Markdown (` ``` ` or `~~~`), anchored at line start under `/m`
 * using a named capture group `(?<fence>...)` so combining `.source` in `MD_CODE_REGIONS` never shifts
 * backreference numbers. Uses `|(?![\s\S])` rather than `|$` so unclosed fences match to end-of-input
 * instead of stopping at the first content line's EOL under `/m`.
 */
export const MD_FENCE =
  /^[ \t]*(?<fence>`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?(?:\r?\n[ \t]*\k<fence>+[ \t]*(?=\r?\n|$)|(?![\s\S]))/gm;

/**
 * Matches an inline code span in raw Markdown: either a multi-backtick span (` ``...`` `) that may
 * contain single backticks, or a single-backtick span on one line. Uses named capture group
 * `(?<span>...)` so combining `.source` with `MD_FENCE` never collides with `(?<fence>...)`.
 */
export const MD_CODE_SPAN = /(?<span>`{2,})(?:(?!\k<span>)[\s\S])+?\k<span>|`[^`\r\n]+`/gm;

/**
 * Combined left-to-right matcher for fenced code blocks and inline code spans.
 */
const MD_CODE_REGIONS = new RegExp(`${MD_FENCE.source}|${MD_CODE_SPAN.source}`, 'gm');

/**
 * Applies `fn` only to slices of `text` that lie outside matches of `regionRe`, leaving matched
 * regions (fenced code blocks and inline code spans) byte-for-byte untouched.
 */
function mapOutsideRegions(text: string, regionRe: RegExp, fn: (segment: string) => string): string {
  const re = new RegExp(regionRe.source, regionRe.flags.includes('g') ? regionRe.flags : `${regionRe.flags}g`);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out += fn(text.slice(last, m.index));
    }
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out += fn(text.slice(last));
  }
  return out;
}

/** Matches empty `<a id="..."></a>` or `<a name="..."></a>` bookmark anchors. */
const EMPTY_ANCHOR = /<a(?=\s)[^>]*\s(?:id|name)\s*=[^>]*(?:>\s*<\/a>|\s*\/>)/gi;

/**
 * Drops empty `<a id>` / `<a name>` bookmark tags outside code fences and inline code spans.
 */
export function stripEmptyAnchorBookmarks(text: string): string {
  return mapOutsideRegions(text, MD_CODE_REGIONS, (segment) => segment.replace(EMPTY_ANCHOR, ''));
}

/**
 * Drops `<!-- ... -->` HTML comments outside code fences and inline code spans. Runs before
 * `balanceHtmlTables` so an HTML comment immediately after `<table...>` never blocks
 * `REAL_TABLE_OPEN_RE` lookahead.
 */
export function stripHtmlComments(text: string): string {
  return mapOutsideRegions(text, MD_CODE_REGIONS, (segment) => segment.replace(/<!--[\s\S]*?-->/g, ''));
}

/**
 * Matches a standalone MadCap Flare `<a class="codeSnippetCopyButton">Copy</a>` line at the end of
 * a prose segment immediately preceding an opening code fence, optionally followed by one of the
 * 4 exact MadCap `codeSnippetCaption` strings observed across the 9.3.1 & 10.0 manual corpus.
 */
const CODE_SNIPPET_COPY_BEFORE_FENCE =
  /^[ \t]*Copy[ \t]*\r?\n(?:[ \t]*\r?\n)*(?:[ \t]*(?:Example(?: of a multi-line statement)?|Schema extension file structure|Script structure)[ \t]*\r?\n(?:[ \t]*\r?\n)*)?(?![\s\S])/m;

/**
 * Drops standalone MadCap Flare "Copy" toolbar lines (and any accompanying corpus-verified
 * `codeSnippetCaption` line) immediately preceding a fenced code block.
 */
export function stripCodeSnippetCopyButtons(text: string): string {
  const re = new RegExp(MD_FENCE.source, 'gm');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index).replace(CODE_SNIPPET_COPY_BEFORE_FENCE, '') + m[0];
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/**
 * Strips a MadCap Flare `<span class="codeSnippetLineNumbers">` line-number gutter (`1\n2\n…\nN`)
 * fused onto the top of a `<pre><code>` block during HTML-to-Markdown conversion, normalizes
 * non-breaking spaces (`\u00a0`) to ASCII spaces, and removes common leading indentation on the
 * remaining code lines.
 */
export function stripCodeLineNumberGutter(text: string): string {
  const lines = text.split('\n');
  let gutterCount = 0;
  while (gutterCount < lines.length && /^[ \t]*\d+[ \t]*\r?$/.test(lines[gutterCount])) {
    if (Number(lines[gutterCount].trim()) !== gutterCount + 1) {
      break;
    }
    gutterCount++;
  }

  const codeLines = lines.slice(gutterCount);
  if (gutterCount < 2 || !codeLines.some((l) => l.trim().length > 0)) {
    return text.replace(/\u00a0/g, ' ');
  }

  const normalized = codeLines.map((l) => l.replace(/\u00a0/g, ' '));
  const nonEmpty = normalized.filter((l) => l.trim().length > 0);
  const minIndent = Math.min(...nonEmpty.map((l) => (l.match(/^[ \t]*/) ?? [''])[0].length));
  return normalized.map((l) => (l.trim().length > 0 ? l.slice(minIndent) : '')).join('\n');
}

/** Allowed lowercase HTML tags inside an imported manual table block. */
const TABLE_HTML_TAGS = new Set([
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'p',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'div',
  'span',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'sub',
  'sup',
  'code',
  'pre',
  'br',
  'hr',
  'a',
  'img',
]);

/** Self-closing / void HTML elements inside a table block. */
const VOID_HTML_TAGS = new Set(['br', 'hr', 'img', 'col']);

/**
 * Validates HTML attribute lists: quoted (`colspan="2"`), single-quoted (`colspan='2'`), and
 * unquoted (`colspan=2`) `key=value` attributes, plus boolean attributes (`nowrap`, `hidden`,
 * `inert`, `data-*`, `aria-*`), while rejecting prose words after a tag name (`<table name>`,
 * `<column name>`, `<form name>`).
 */
const HTML_ATTR_LIST_RE =
  /^(?:\s+(?:[a-zA-Z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)|(?:nowrap|hidden|inert|(?:data|aria)-[a-zA-Z0-9_.:-]+)(?=\s|$)))*\s*$/;

/** Matches any `<...>` tag candidate in a fragment. */
const ANY_ANGLE_TAG_RE = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^>]*?)?)(\/?)>/g;

/**
 * Matches a real HTML `<table...>` opening tag (after HTML comments and `<madcap:conditionaltext>`
 * wrappers have been stripped) followed by whitespace and a structural table child tag (`<caption`,
 * `<colgroup`, `<col`, `<thead`, `<tbody`, `<tfoot`, `<tr`, `<td`, `<th`), distinguishing genuine
 * HTML tables from prose placeholders like `**<table>**` or `<table name>`.
 *
 * Deliberately unsupported opener shapes (left as literal text):
 * - Uppercase `<TABLE>` (converter emits lowercase HTML; uppercase tags in manuals are XML examples)
 * - `<table><p>` (non-structural first child directly inside `<table>`)
 * - `<table inert>` (boolean attributes other than `hidden` on `<table>` with no `=`)
 */
const REAL_TABLE_OPEN_RE =
  /<table(?:\s+[^>]*=[^>]*|\s+hidden\b|\s*)>(?=\s*<(?:caption|colgroup|col|thead|tbody|tfoot|tr|td|th)\b)/;

/**
 * Corpus-scoped detector for raw HTML tables and split table/cell fragments.
 * Purposefully lowercase-only (matching the converter's lowercase HTML output while ignoring
 * uppercase XML examples like `<Key><T>DialogTable</T></Key>`), allowing optional whitespace
 * before `>` on closing tags (`</td >`).
 */
const TABLE_FRAGMENT_DETECTOR_RE =
  /<\/(?:table|thead|tbody|tfoot|tr|td|th|colgroup|caption|p|ul|ol|li|div)\s*>|<(?:tr|td|th|thead|tbody|tfoot|colgroup|caption)\b/;

/** Leading orphan closing tags at the very start of a split chunk before any cell content. */
const LEADING_EMPTY_CLOSERS_RE =
  /^(?:\s*<\/(?:p|ul|ol|li|div|span|b|i|strong|em|u|s|sub|sup|code|pre|a|td|th|tr|tbody|thead|tfoot|colgroup|caption|table)\s*>)+/;

/** MadCap Flare conditional text wrapper tags (`<madcap:conditionaltext ...>...</madcap:conditionaltext>`). */
const MADCAP_CONDITIONAL_TAG_RE = /<\/?madcap:conditionaltext\b[^>]*>/gi;

/** Matches leading `>` blockquote lines and `#{1,6}` markdown headings at the top of a split chunk. */
const LEADING_MD_HEADER_RE = /^(?:[ \t]*(?:>[^\r\n]*|#{1,6}[ \t]+[^\r\n]+)\r?\n(?:[ \t]*\r?\n)*)+/;

function escapeHtmlString(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Returns true when a regex match (`slash`, `rawName`, `attrs`) is a genuine lowercase HTML
 * table/cell tag with well-formed attributes (not an uppercase XML element like
 * `<Class Name="Group">` or a prose placeholder like `<table name>` / `<column name>`).
 */
function isValidTableHtmlTag(slash: string, rawName: string, attrs: string): boolean {
  if (rawName !== rawName.toLowerCase() || !TABLE_HTML_TAGS.has(rawName)) {
    return false;
  }
  return slash ? attrs.trim() === '' : HTML_ATTR_LIST_RE.test(attrs);
}

/**
 * Escapes any `<...>` inside a balanced HTML table that is not a valid lowercase HTML table/cell
 * tag (for example `<condition>`, `<column name>`, `<form name>`, or `<Class Name="Group">`) so
 * `parse5` (`hast-util-from-html`) preserves them as visible text nodes instead of stripping them.
 */
export function escapeNonTableHtmlTags(html: string): string {
  return html.replace(ANY_ANGLE_TAG_RE, (full, slash: string, rawName: string, attrs: string) => {
    return isValidTableHtmlTag(slash, rawName, attrs) ? full : escapeHtmlString(full);
  });
}

/**
 * Checks whether a trimmed HAST `raw` node is a balanced `<table...>...</table>` block.
 */
export function isBalancedHtmlTableBlock(trimmed: string): boolean {
  return REAL_TABLE_OPEN_RE.test(trimmed) && trimmed.endsWith('</table>');
}

/**
 * Counts `<td`/`<th` cells in the first `<tr>` (`firstRowCols`, which includes the synthesized
 * leading `<td>`) vs the widest `<tr>` (`maxCols`) of a balanced table. When a split chunk started
 * mid-row (`'tr'` was in `unmatchedClosers`) and `maxCols > firstRowCols`, adds
 * `colspan="${maxCols - firstRowCols + 1}"` to the synthesized leading `<td>`/`<th>` so the first
 * row's `firstRowCols` cells span all `maxCols` columns.
 */
function applyLeadingPartialRowColspan(tableHtml: string): string {
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let firstRowCols = 0;
  let maxCols = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const cols = (rowMatch[1].match(/<(?:td|th)\b/g) || []).length;
    if (firstRowCols === 0) {
      firstRowCols = cols;
    }
    if (cols > maxCols) {
      maxCols = cols;
    }
  }
  if (firstRowCols > 0 && maxCols > firstRowCols) {
    const span = maxCols - firstRowCols + 1;
    return tableHtml.replace(
      /^(<table\b[^>]*>(?:<tbody>|<thead\b[^>]*>|<tfoot>)?<tr>)<(td|th)>/,
      `$1<$2 colspan="${span}">`,
    );
  }
  return tableHtml;
}

/**
 * Balances missing opening and closing HTML tags for a raw HTML table or a split table/cell
 * fragment, reconstructing missing outer `table`/`tbody`/`tr`/`td` ancestors, applying partial
 * leading row `colspan`, and collapsing internal blank lines so CommonMark parses the table as a
 * single HTML block at column 0.
 */
function balanceTableFragment(fragment: string): string {
  const cleaned = fragment.replace(LEADING_EMPTY_CLOSERS_RE, '');
  const openStack: string[] = [];
  const unmatchedClosers: string[] = [];

  ANY_ANGLE_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANY_ANGLE_TAG_RE.exec(cleaned)) !== null) {
    const [, slash, rawName, attrs, selfSlash] = match;
    if (!isValidTableHtmlTag(slash, rawName, attrs)) {
      continue;
    }
    if (VOID_HTML_TAGS.has(rawName) || selfSlash === '/') {
      continue;
    }
    if (!slash) {
      openStack.push(rawName);
    } else {
      const idx = openStack.lastIndexOf(rawName);
      if (idx !== -1) {
        openStack.splice(idx);
      } else {
        unmatchedClosers.push(rawName);
      }
    }
  }

  const firstTagMatch = cleaned.match(/^\s*<([a-z0-9]+)\b/);
  const firstTag = firstTagMatch ? firstTagMatch[1] : null;
  const allTags = new Set([...unmatchedClosers, ...openStack]);
  if (firstTag) {
    allTags.add(firstTag);
  }

  const outerAncestors: string[] = [];
  if (!allTags.has('table')) {
    outerAncestors.push('table');
  }
  if (!allTags.has('tbody') && !allTags.has('thead') && !allTags.has('tfoot')) {
    if (
      allTags.has('tr') ||
      allTags.has('td') ||
      allTags.has('th') ||
      (!allTags.has('colgroup') && !allTags.has('caption') && firstTag !== 'table')
    ) {
      outerAncestors.push('tbody');
    }
  }
  if (!allTags.has('tr')) {
    if (
      allTags.has('td') ||
      allTags.has('th') ||
      (!allTags.has('tbody') &&
        !allTags.has('thead') &&
        !allTags.has('tfoot') &&
        !allTags.has('colgroup') &&
        !allTags.has('caption') &&
        !allTags.has('table'))
    ) {
      outerAncestors.push('tr');
    }
  }
  if (
    !allTags.has('td') &&
    !allTags.has('th') &&
    !allTags.has('tr') &&
    !allTags.has('tbody') &&
    !allTags.has('thead') &&
    !allTags.has('tfoot') &&
    !allTags.has('colgroup') &&
    !allTags.has('caption') &&
    !allTags.has('table')
  ) {
    outerAncestors.push('td');
  }

  const prefixTags = [...outerAncestors, ...[...unmatchedClosers].reverse()];
  const suffixTags = [...[...openStack].reverse(), ...[...outerAncestors].reverse()];
  const prefix = prefixTags.map((t) => `<${t}>`).join('');
  const suffix = suffixTags.map((t) => `</${t}>`).join('');

  let balanced = escapeNonTableHtmlTags(prefix + cleaned.trim() + suffix);
  if (unmatchedClosers.includes('tr')) {
    balanced = applyLeadingPartialRowColspan(balanced);
  }
  return balanced.replace(/\r?\n(?:[ \t]*\r?\n)+/g, '\n');
}

/**
 * Finds the end index (after `</table>`) of the outermost `<table...>` starting at `startIdx`,
 * or `-1` if the table was cut off before its closing `</table>` tag.
 */
function findMatchingTableEnd(segment: string, startIdx: number): number {
  const tableTagRe = /<(\/?)table(?:\s+[^>]*=[^>]*|\s+hidden\b|\s*)>/g;
  tableTagRe.lastIndex = startIdx;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tableTagRe.exec(segment)) !== null) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) {
      return m.index + m[0].length;
    }
  }
  return -1;
}

function appendBalancedBlock(out: string, headerPrefix: string, balancedTable: string): string {
  let base = out;
  if (headerPrefix) {
    const trimmedHeader = headerPrefix.replace(/[ \t]*\r?\n*$/, '');
    base = base.length > 0 ? `${base.replace(/[ \t]*\r?\n*$/, '')}\n\n${trimmedHeader}` : trimmedHeader;
  }
  if (base.length === 0) {
    return balancedTable;
  }
  return `${base.replace(/[ \t]*\r?\n*$/, '')}\n\n${balancedTable}`;
}

/**
 * Unwraps `<madcap:conditionaltext>` tags and repairs complete and chunk-split HTML tables outside
 * fenced code blocks and inline code spans so manual tables render cleanly in both `Markdown` and
 * `CitationModal`.
 */
export function balanceHtmlTables(text: string): string {
  return mapOutsideRegions(text, MD_CODE_REGIONS, (rawSegment) => {
    const segment = rawSegment.replace(MADCAP_CONDITIONAL_TAG_RE, '');
    if (!TABLE_FRAGMENT_DETECTOR_RE.test(segment)) {
      return segment;
    }

    let out = '';
    let pos = 0;
    while (pos < segment.length) {
      const rest = segment.slice(pos);
      const openMatch = REAL_TABLE_OPEN_RE.exec(rest);
      const closeIdx = rest.indexOf('</table>');

      // Case 1: Leading split table tail before `</table>` (no opening `<table>` for it).
      if (closeIdx !== -1 && (openMatch === null || closeIdx < openMatch.index)) {
        const beforeClose = rest.slice(0, closeIdx + '</table>'.length);
        const headerMatch = beforeClose.match(LEADING_MD_HEADER_RE);
        const headerPrefix = headerMatch ? headerMatch[0] : '';
        const frag = beforeClose.slice(headerPrefix.length);
        out = appendBalancedBlock(out, headerPrefix, balanceTableFragment(frag));
        pos += beforeClose.length;
        const afterClose = segment.slice(pos);
        if (afterClose.trim().length > 0) {
          out += '\n\n';
          const leadingBlank = afterClose.match(/^[ \t]*\r?\n(?:[ \t]*\r?\n)*/);
          if (leadingBlank) {
            pos += leadingBlank[0].length;
          }
        }
        continue;
      }

      // Case 2: An explicit `<table...>` starts here or later in `rest`.
      if (openMatch !== null) {
        const tableStart = pos + openMatch.index;
        out += segment.slice(pos, tableStart);
        const tableEnd = findMatchingTableEnd(segment, tableStart);
        if (tableEnd !== -1) {
          const frag = segment.slice(tableStart, tableEnd);
          out = appendBalancedBlock(out, '', balanceTableFragment(frag));
          pos = tableEnd;
          const afterTable = segment.slice(pos);
          if (afterTable.trim().length > 0) {
            out += '\n\n';
            const leadingBlank = afterTable.match(/^[ \t]*\r?\n(?:[ \t]*\r?\n)*/);
            if (leadingBlank) {
              pos += leadingBlank[0].length;
            }
          }
        } else {
          const frag = segment.slice(tableStart);
          out = appendBalancedBlock(out, '', balanceTableFragment(frag));
          pos = segment.length;
        }
        continue;
      }

      // Case 3: Mid-table / mid-cell split chunk with neither `<table...>` nor `</table>` in `rest`.
      if (pos === 0 && TABLE_FRAGMENT_DETECTOR_RE.test(rest)) {
        const headerMatch = rest.match(LEADING_MD_HEADER_RE);
        const headerPrefix = headerMatch ? headerMatch[0] : '';
        const frag = rest.slice(headerPrefix.length);
        out = appendBalancedBlock(out, headerPrefix, balanceTableFragment(frag));
        break;
      }

      out += rest;
      break;
    }
    return out;
  });
}

/**
 * Shared pre-parse Markdown normalization pipeline used by both `cleanPassage` (`sectionView.ts`)
 * and `preprocessMarkdown` (`Markdown.tsx`).
 */
export function normalizeMarkdownText(text: string): string {
  let out = stripEmptyAnchorBookmarks(text);
  out = stripHtmlComments(out);
  out = stripCodeSnippetCopyButtons(out);
  out = balanceHtmlTables(out);
  return out;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Allowed HAST properties on table elements. `className` is intentionally stripped alongside
 * `style`, `id`, `data*`, and `on*` event handlers so imported HTML can never inject app-global
 * CSS classes (`banner`, `error`, `primary`, `icon-button`, `citation-passage`, etc.).
 */
const ALLOWED_TABLE_HAST_PROPS = new Set([
  'colSpan',
  'rowSpan',
  'scope',
  'span',
  'align',
  'valign',
  'href',
  'title',
  'src',
  'alt',
  'width',
  'height',
]);

/**
 * Structural table containers that forbid direct text children in HTML / React 19.
 */
const STRUCTURAL_TABLE_TAGS = new Set(['table', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr']);

function isSafeHref(url: string): boolean {
  const trimmed = url.trim();
  return /^(?:https?:\/\/|mailto:|#|\/|\.\.?\/|[a-zA-Z0-9_.-]+(?:[/?#]|$))/i.test(trimmed);
}

function isSafeSrc(url: string): boolean {
  const trimmed = url.trim();
  return /^(?:data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,|\/|\.\.?\/)/i.test(trimmed);
}

/**
 * Sanitizes a parsed HAST table subtree against `TABLE_HTML_TAGS`, `ALLOWED_TABLE_HAST_PROPS`,
 * URL scheme allowlists, and React 19 structural table whitespace rules.
 */
function sanitizeTableHast(nodes: HastNode[], parentTag?: string): HastNode[] {
  const out: HastNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      if (parentTag && STRUCTURAL_TABLE_TAGS.has(parentTag)) {
        continue;
      }
      out.push(node);
      continue;
    }
    if (node.type !== 'element' || !node.tagName) {
      continue;
    }
    const tag = node.tagName.toLowerCase();
    if (!TABLE_HTML_TAGS.has(tag)) {
      continue;
    }

    const cleanProps: Record<string, unknown> = {};
    if (node.properties) {
      for (const [key, val] of Object.entries(node.properties)) {
        if (!ALLOWED_TABLE_HAST_PROPS.has(key) || val === undefined || val === null) {
          continue;
        }
        if (key === 'href') {
          if (typeof val === 'string' && isSafeHref(val)) {
            cleanProps.href = val;
          }
          continue;
        }
        if (key === 'src') {
          if (typeof val === 'string' && isSafeSrc(val)) {
            cleanProps.src = val;
          }
          continue;
        }
        cleanProps[key] = val;
      }
    }

    const children = node.children ? sanitizeTableHast(node.children, tag) : [];
    out.push({
      type: 'element',
      tagName: tag,
      properties: cleanProps,
      children,
    });
  }
  return out;
}

function walkHast(node: HastNode): void {
  if (!Array.isArray(node.children)) {
    return;
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];

    if (child.type === 'comment') {
      node.children.splice(i, 1);
      i--;
      continue;
    }

    if (child.type === 'raw' && typeof child.value === 'string') {
      const trimmed = child.value.trim();
      if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
        node.children.splice(i, 1);
        i--;
        continue;
      }
      if (isBalancedHtmlTableBlock(trimmed)) {
        const parsed = fromHtml(escapeNonTableHtmlTags(trimmed), { fragment: true }) as unknown as HastNode;
        const sanitized = sanitizeTableHast(parsed.children ?? []);
        node.children.splice(i, 1, ...sanitized);
        i += sanitized.length - 1;
        continue;
      }
      continue;
    }

    if (child.type === 'element' && child.tagName === 'pre' && Array.isArray(child.children)) {
      for (const preChild of child.children) {
        if (preChild.type === 'element' && preChild.tagName === 'code' && Array.isArray(preChild.children)) {
          for (const codeChild of preChild.children) {
            if (codeChild.type === 'text' && typeof codeChild.value === 'string') {
              codeChild.value = stripCodeLineNumberGutter(codeChild.value);
            }
          }
        }
      }
    }

    walkHast(child);
  }
}

/**
 * Rehype plugin that converts balanced `<table...>...</table>` `raw` HAST nodes into sanitized
 * HAST element subtrees (placed before `rehypeCitations` so citations inside table cells still
 * linkify), strips HTML comments, and cleans fused MadCap `1..N` line-number gutters from `<pre><code>`.
 */
export function rehypeHtmlTables() {
  return (tree: HastNode): void => {
    walkHast(tree);
  };
}

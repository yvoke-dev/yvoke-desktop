/*
 * Rehype plugin that rewrites citation markers, AFTER markdown has been parsed.
 *
 * This used to be a string replace over the raw markdown, before react-markdown saw it. Being
 * markdown-unaware, it corrupted real content: `[2](https://ex.com)` was severed and its URL leaked
 * into the visible prose, and `args[1]` inside a fenced block rendered as a mangled link.
 * Working on the parsed tree makes that structurally impossible — code and existing links are
 * whole nodes here, so they are simply not descended into.
 *
 * Three kinds of marker, handled differently:
 *   - `[<uuid>]` — a BARE id, which is what the server now instructs models to write. This is the
 *     common case; the two kinded forms below survive only for answers already in the local cache.
 *     Rendered with a SHORT label (`[274b9610]`) rather than the raw 36 characters, because the
 *     system prompt promises the model that "the reader is shown a short link, not the raw id",
 *     and because an answer citing every sentence is unreadable at full width. Matches the web's
 *     `citation-render.js`, which shortens to the same 8 characters.
 *   - `[chunk_id=…]` / `[document_id=…]` / `[file=…]` become <a> elements with a private
 *     `citation:` scheme, which Markdown.tsx's `a` component turns into clickable pills.
 *   - `[N]` becomes a plain <sup> — a typographic marker, not a link. Linking it to the References
 *     list was dropped deliberately: the same `[N]` appears in the list itself, so half the markers
 *     would have been links to themselves. In a References entry the `[N]` is left as literal text.
 */

/** Minimal HAST shapes — enough for this walk, without pulling in a types dependency. */
interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

/** Elements whose text is code or is already a link: never rewrite inside these. */
const OPAQUE = new Set(['code', 'pre', 'a']);

const UUID_HEX =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}';
const CITE_ITEM = `(?:(?:chunk_id|document_id|file)=[a-zA-Z0-9_.-]+|${UUID_HEX})`;
const CITE_GROUP = new RegExp(`\\[\\s*${CITE_ITEM}(?:\\s*,\\s*${CITE_ITEM})*\\s*\\]`, 'g');

const NUMBERED_GROUP = /\[\s*\d{1,2}(?:\s*,\s*\d{1,2})*\s*\]/g;

/**
 * A References entry: `[N]` at the start of its block, followed by a citation token.
 *
 * Both citation spellings are listed. Answers are no longer written this way — the current prompt
 * forbids a References section outright — but a cached one is, and recognising only the kinded
 * form would superscript the `[1]` labels of a legacy bare-id list.
 */
const REF_DEF_BLOCK =
  /^\s*\[\d{1,2}(?:\s*,\s*\d{1,2})*\]\s+\[(?:(?:chunk_id|document_id|file)=|[0-9a-fA-F]{8})/;

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element';
}

function textContent(node: HastNode): string {
  if (node.type === 'text') return (node as HastText).value;
  const children = (node as HastElement).children ?? [];
  return children.map(textContent).join('');
}

function link(href: string, label: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href },
    children: [{ type: 'text', value: label }],
  };
}

/** An inline `[N]` marker, rendered as a bare superscript digit. Not interactive. */
function marker(num: string): HastElement {
  return {
    type: 'element',
    tagName: 'sup',
    properties: { className: ['ref-marker'] },
    children: [{ type: 'text', value: num }],
  };
}

/**
 * Splits one text node into text + citation nodes.
 * `inRefBlock` keeps `[N]` as literal text — inside the References list those digits are the
 * list's own labels, not markers pointing at it.
 */
function splitText(value: string, inRefBlock: boolean): HastNode[] {
  const out: HastNode[] = [];
  let pos = 0;

  // One pass over both patterns, so the earliest match always wins.
  const combined = new RegExp(
    `${CITE_GROUP.source}|${NUMBERED_GROUP.source}`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = combined.exec(value)) !== null) {
    if (m.index > pos) {
      out.push({ type: 'text', value: value.slice(pos, m.index) });
    }
    const full = m[0];
    const inner = full.slice(1, -1).trim();

    if (/^\d{1,2}(?:\s*,\s*\d{1,2})*$/.test(inner)) {
      if (inRefBlock) {
        out.push({ type: 'text', value: full });
      } else {
        const nums = inner.split(',');
        for (const num of nums) {
          out.push(marker(num.trim()));
        }
      }
    } else {
      const items = inner.split(',');
      for (const item of items) {
        const s = item.trim();
        const kindMatch = /^(chunk_id|document_id|file)=([a-zA-Z0-9_.-]+)$/i.exec(s);
        if (kindMatch) {
          const kind = kindMatch[1].toLowerCase();
          const id = kindMatch[2];
          const scheme = kind === 'chunk_id' ? 'chunk' : kind === 'document_id' ? 'document' : 'file';
          out.push(link(`citation:${scheme}:${id}`, `[${s}]`));
          continue;
        }
        const uuidMatch = new RegExp(`^(${UUID_HEX})$`).exec(s);
        if (uuidMatch) {
          const bareId = uuidMatch[1];
          out.push(link(`citation:id:${bareId}`, `[${bareId.slice(0, 8)}]`));
          continue;
        }
      }
    }
    pos = m.index + full.length;
  }

  if (pos === 0) return [];
  if (pos < value.length) {
    out.push({ type: 'text', value: value.slice(pos) });
  }
  return out;
}

/** Rehype plugin factory. */
export function rehypeCitations() {
  return function transform(tree: HastNode): HastNode {
    walk(tree);
    return tree;
  };
}

function walk(node: HastNode): void {
  const children = (node as HastElement).children;
  if (!children || children.length === 0) return;

  // A References entry starts its own block, so decide once per parent whether the [N]s below are
  // entry labels (kept literal) or inline markers (superscripted).
  const inRefBlock = REF_DEF_BLOCK.test(textContent(node));

  const next: HastNode[] = [];
  for (const child of children) {
    if (isElement(child) && OPAQUE.has(child.tagName)) {
      // Code and existing links are left entirely alone — this is the whole point of the plugin.
      next.push(child);
      continue;
    }
    if (child.type === 'text') {
      const parts = splitText((child as HastText).value, inRefBlock);
      if (parts.length > 0) {
        next.push(...parts);
        continue;
      }
      next.push(child);
      continue;
    }
    walk(child);
    next.push(child);
  }
  (node as HastElement).children = next;
}

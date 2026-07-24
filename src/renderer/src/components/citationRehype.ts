/*
 * Rehype plugin that rewrites citation markers, AFTER markdown has been parsed.
 *
 * This used to be a string replace over the raw markdown, before react-markdown saw it. Being
 * markdown-unaware, it corrupted real content: `[2](https://ex.com)` was severed and its URL leaked
 * into the visible prose, and `args[1]` inside a fenced block rendered as a mangled link.
 * Working on the parsed tree makes that structurally impossible — code and existing links are
 * whole nodes here, so they are simply not descended into.
 *
 * Two kinds of marker, handled differently:
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

const CITATION = /\[(chunk_id|document_id|file)=([a-zA-Z0-9_.-]+)\]/g;
const NUMBERED = /\[(\d{1,2})\]/g;

/** A References entry: `[N]` at the start of its block, followed by a citation token. */
const REF_DEF_BLOCK = /^\s*\[\d{1,2}\]\s+\[(?:chunk_id|document_id|file)=/;

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
  const combined = new RegExp(`${CITATION.source}|${NUMBERED.source}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = combined.exec(value)) !== null) {
    if (m.index > pos) {
      out.push({ type: 'text', value: value.slice(pos, m.index) });
    }
    const [full, kind, id, num] = m;
    if (kind && id) {
      const scheme = kind === 'chunk_id' ? 'chunk' : kind === 'document_id' ? 'document' : 'file';
      out.push(link(`citation:${scheme}:${id}`, full));
    } else if (num) {
      // Every `[N]` labelling a References entry stays as written — a block often holds the whole
      // list, so scoping this to the first one left `[2]`, `[3]`, … superscripted mid-list.
      out.push(inRefBlock ? { type: 'text', value: full } : marker(num));
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

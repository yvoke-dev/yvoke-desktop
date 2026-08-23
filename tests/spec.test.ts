import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `spec.md` is the functional specification: the one prose document this repository keeps, and the
 * thing its own header tells "anyone — person or agent — about to make a substantial change" to read
 * first. This test pins the parts of it a machine can actually check.
 *
 * What it deliberately does NOT do is check that the prose is current. Nothing can, and that limit
 * is worth stating plainly here because it is easy to mistake a passing spec test for a guarantee
 * the spec is true: in a single session this document twice ended up describing behaviour that had
 * been changed underneath it — a reviewer tool that had been withdrawn, and a citation panel that
 * had stopped showing what it claimed. Both were semantic, and neither is the kind of thing this
 * file could ever fail on. The exact behaviour contract lives in the rest of the suite, which is
 * why the spec's own header says "to change behaviour, change a test".
 *
 * What it CAN enforce is the shape the document promises its readers, and that promise carries
 * weight in four ways:
 *
 *  - **The file must exist.** It is the only place recording what the product deliberately does not
 *    do, which is invisible in the code by definition, so its loss is silent.
 *  - **Every chapter must carry all four sections.** A chapter missing *Limits* or *Not supported*
 *    is not merely thin — those two are where a decision against something is written down, and
 *    omitting them quietly turns "we decided against this" into "nobody considered it".
 *  - **The Contents table must resolve.** It is the document's only navigation. A chapter appended
 *    without an entry, or an entry whose anchor no longer matches a renamed heading, makes that
 *    chapter unreachable while the document still looks complete.
 *  - **Chapter numbers must run 1..N without gaps or repeats.** The numbers are the anchors, so a
 *    duplicated or skipped one silently points two Contents rows at one chapter.
 */

const SPEC_PATH = resolve(__dirname, '..', 'spec.md');

/** The four sections every capability chapter promises. */
const REQUIRED_SECTIONS = ['What you can do', 'How it behaves', 'Limits', 'Not supported'] as const;

/** A numbered capability chapter, e.g. `## 3. Multi-agent investigations`. */
const CHAPTER = /^## (\d+)\. (.+)$/gm;

/** Any second- or third-level heading, used to resolve the Contents anchors. */
const HEADING = /^#{2,3} (.+)$/gm;

/** A markdown link to an in-document anchor, e.g. `[Limits](#3-limits)`. */
const ANCHOR_LINK = /\[[^\]]+\]\(#([a-z0-9-]+)\)/g;

/**
 * GitHub's heading-to-anchor rule: lower-case, drop everything that is not a letter, digit, space
 * or hyphen, then spaces to hyphens.
 *
 * The surviving hyphens are why this cannot be simplified to a slug helper — "What Yvoke - Desktop
 * is" anchors as `what-yvoke---desktop-is`, with all three hyphens, because the spaces either side
 * of the literal hyphen each become one.
 */
function githubAnchor(headingText: string): string {
  return headingText
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

function spec(): string {
  // Read per test rather than once at module load: a cached copy would make a failure survive the
  // edit that fixed it, on a file whose whole point is being edited.
  return readFileSync(SPEC_PATH, 'utf8');
}

interface Chapter {
  number: number;
  title: string;
  start: number;
}

function chapters(text: string): Chapter[] {
  const out: Chapter[] = [];
  for (const m of text.matchAll(CHAPTER)) {
    out.push({ number: Number(m[1]), title: m[2].trim(), start: m.index ?? 0 });
  }
  return out;
}

/** The Contents table: everything between its heading and the first numbered chapter. */
function contentsTable(text: string): string {
  const start = text.indexOf('## Contents');
  expect(start, 'spec.md must have a Contents table').toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## 1.');
  expect(end, 'spec.md must have a chapter 1 after the Contents table').toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('spec.md structure', () => {
  it('exists and is a substantial document', () => {
    // The spec is the only record of what the product deliberately does not do — a record that is
    // invisible in the code, so its absence would not otherwise fail anything.
    const text = spec();
    expect(text.length).toBeGreaterThan(1000);
    expect(text.startsWith('# ')).toBe(true);
  });

  it('has numbered capability chapters, or the rest of this file is vacuous', () => {
    const found = chapters(spec());
    expect(found.length).toBeGreaterThan(0);
  });

  it('numbers its chapters 1..N with no gaps and no repeats', () => {
    // The number is part of the anchor, so a duplicate silently aims two Contents rows at one
    // chapter and a gap leaves a row aimed at nothing.
    const numbers = chapters(spec()).map((c) => c.number);
    const expected = Array.from({ length: numbers.length }, (_, i) => i + 1);
    expect(numbers).toEqual(expected);
  });

  it.each(REQUIRED_SECTIONS)('gives every chapter a "%s" section', (section) => {
    const text = spec();
    const found = chapters(text);
    const missing = found
      .filter((chapter, i) => {
        const end = i + 1 < found.length ? found[i + 1].start : text.length;
        return !text.slice(chapter.start, end).includes(`### ${section}`);
      })
      .map((c) => `${c.number}. ${c.title}`);

    // Asserted per section rather than per chapter so a failure names the missing section once,
    // instead of one opaque failure per chapter.
    expect(missing, `chapters with no "### ${section}" section`).toEqual([]);
  });

  it('keeps the four sections in the promised order within each chapter', () => {
    // The order is the document's argument: what it does, how, where it stops, what it refuses.
    // A chapter that lists Limits before How it behaves reads as a different claim.
    const text = spec();
    const found = chapters(text);
    for (const [i, chapter] of found.entries()) {
      const end = i + 1 < found.length ? found[i + 1].start : text.length;
      const body = text.slice(chapter.start, end);
      const positions = REQUIRED_SECTIONS.map((s) => body.indexOf(`### ${s}`));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions, `section order in chapter ${chapter.number}. ${chapter.title}`).toEqual(
        sorted,
      );
    }
  });

  it('resolves every Contents link to a heading that exists', () => {
    const text = spec();
    const anchors = new Set([...text.matchAll(HEADING)].map((m) => githubAnchor(m[1])));
    const linked = [...contentsTable(text).matchAll(ANCHOR_LINK)].map((m) => m[1]);

    expect(linked.length, 'the Contents table must link to the chapters').toBeGreaterThan(0);
    const dangling = linked.filter((a) => !anchors.has(a));
    expect(dangling, 'Contents links pointing at no heading').toEqual([]);
  });

  it('lists every capability chapter in the Contents', () => {
    // The other direction: a chapter can exist, be complete, and still be unreachable.
    const text = spec();
    const table = contentsTable(text);
    const unlisted = chapters(text)
      .filter((c) => !table.includes(`(#${githubAnchor(`${c.number}. ${c.title}`)})`))
      .map((c) => `${c.number}. ${c.title}`);
    expect(unlisted, 'chapters missing from the Contents table').toEqual([]);
  });

  it('keeps the glossary, which is what settles a word when code and prose disagree', () => {
    // "Words we use" is not decoration: it is the tie-breaker. It is what established that a
    // "passage" is the product's word for what the database calls a chunk — the question that
    // decided how the citation panel and the tools are allowed to label the same count.
    expect(spec()).toContain('## Words we use');
  });
});

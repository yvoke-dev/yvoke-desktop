import { describe, expect, it } from 'vitest';
import { cleanPassage, isCited, parseSection } from '../../src/renderer/src/components/sectionView';

/**
 * Byte-for-byte what `GetSectionTool.render()` writes: a `# Section:` line, a meta line whose tail
 * is a directive addressed to the MODEL, then one `_(id=…  doc_id=…)_` marker per passage. Two
 * spaces between the marker fields, as the server writes them.
 */
const CITED = '274b9610-9148-4621-a5a1-089e807210c1';
const OTHER = '8f5ca25a-18d7-4a2a-947d-40b5e807db6a';
const DOC = '8d86048e-54d0-4a4d-a4ab-87b053ba1e0a';

const SERVED = [
  '# Section: How are schemas mapped',
  `_(document: Basics of target system synchronization  ·  tag: 9.3.1  ·  2 passage(s)  ·  section  ·  cite a passage by the id shown above it)_`,
  '',
  `_(id=${CITED}  doc_id=${DOC})_`,
  'A mapping groups together all the rules used to relate the schema properties.',
  '',
  `_(id=${OTHER}  doc_id=${DOC})_`,
  'OIM distinguishes four schema variants.',
  '',
].join('\n');

describe('parseSection', () => {
  it('never leaves a raw id marker in the rendered text', () => {
    // The regression this exists for: the panel showed `_(id=… doc_id=…)_` above every passage.
    const parsed = parseSection(SERVED);
    for (const p of parsed.passages) {
      expect(p.text).not.toContain('doc_id=');
      expect(p.text).not.toContain(CITED);
    }
  });

  it('splits the section into its passages, each keeping its ids', () => {
    const parsed = parseSection(SERVED);
    expect(parsed.passages).toHaveLength(2);
    expect(parsed.passages[0].id).toBe(CITED);
    expect(parsed.passages[0].documentId).toBe(DOC);
    expect(parsed.passages[0].text).toBe(
      'A mapping groups together all the rules used to relate the schema properties.',
    );
    expect(parsed.passages[1].id).toBe(OTHER);
  });

  it('keeps the heading and the useful half of the meta line', () => {
    const parsed = parseSection(SERVED);
    expect(parsed.heading).toBe('How are schemas mapped');
    expect(parsed.meta).toContain('Basics of target system synchronization');
    expect(parsed.meta).toContain('tag: 9.3.1');
    expect(parsed.documentTitle).toBe('Basics of target system synchronization');
  });

  it('drops the directive aimed at the model, not the reader', () => {
    const parsed = parseSection(SERVED);
    expect(parsed.meta).not.toContain('cite a passage');
  });

  it('identifies the cited passage, hyphens and case notwithstanding', () => {
    const parsed = parseSection(SERVED);
    expect(isCited(parsed.passages[0], CITED)).toBe(true);
    expect(isCited(parsed.passages[1], CITED)).toBe(false);
    expect(isCited(parsed.passages[0], CITED.replace(/-/g, ''))).toBe(true);
    expect(isCited(parsed.passages[0], CITED.toUpperCase())).toBe(true);
  });

  it('marks nothing when the click carried no passage id', () => {
    // A `[document_id=…]` or `[file=…]` citation names no single passage.
    const parsed = parseSection(SERVED);
    expect(parsed.passages.some((p) => isCited(p, undefined))).toBe(false);
    expect(parsed.passages.some((p) => isCited(p, DOC))).toBe(false);
  });

  it('keeps unmarked text whole rather than showing nothing', () => {
    // An older server, or any other text that reaches the panel: one passage holding everything.
    const plain = '# Section: Full Document\n\nJust prose, no markers at all.';
    const parsed = parseSection(plain);
    expect(parsed.passages).toHaveLength(1);
    expect(parsed.passages[0].id).toBeUndefined();
    expect(parsed.passages[0].text).toBe('Just prose, no markers at all.');
  });

  it('tolerates a marker whose id is empty — the server emits a bare id= for a null', () => {
    const parsed = parseSection('_(id=  doc_id=)_\nSome text.');
    expect(parsed.passages).toHaveLength(1);
    expect(parsed.passages[0].id).toBeUndefined();
    expect(parsed.passages[0].text).toBe('Some text.');
  });

  it('drops a marker with no prose under it instead of rendering an empty box', () => {
    const parsed = parseSection(`_(id=${CITED}  doc_id=${DOC})_\n\n_(id=${OTHER}  doc_id=${DOC})_\nReal text.`);
    expect(parsed.passages).toHaveLength(1);
    expect(parsed.passages[0].id).toBe(OTHER);
  });

  it('does not mistake a passage marker for the meta line', () => {
    // Both are `_( … )_`; the marker has to be tested first or every passage id becomes "meta".
    const parsed = parseSection(`_(id=${CITED}  doc_id=${DOC})_\nText.`);
    expect(parsed.meta).toBeUndefined();
    expect(parsed.passages[0].id).toBe(CITED);
  });

  it('survives the server changing the marker spacing', () => {
    const parsed = parseSection(`_(id=${CITED} doc_id=${DOC})_\nText.`);
    expect(parsed.passages[0].id).toBe(CITED);
  });
});

describe('cleanPassage', () => {
  it('strips the invisible HTML the corpus carries', () => {
    expect(cleanPassage('<!-- note -->\n<a id="topic"></a>\nVisible.')).toBe('Visible.');
  });

  it('rejoins a table row that a wrapped cell left open', () => {
    // A Description cell containing a newline otherwise terminates the table and dumps the
    // remaining rows as raw pipe text.
    const md = '| A | B |\n| --- | --- |\n| x | first\nsecond |';
    expect(cleanPassage(md)).toBe('| A | B |\n| --- | --- |\n| x | first second |');
  });
});

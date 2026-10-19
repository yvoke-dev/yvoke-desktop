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

  it('balances a mid-table split HTML fragment and applies leading partial-row colspan', () => {
    const splitPart7 = [
      '> Section path: Target system synchronization > One Identity Manager tools (part 7/11)',
      '### One Identity Manager tools (part 7/11)',
      '',
      '                            <p class="TableText">Designer is the main tool for customizing One Identity Manager.</p>',
      '                        </td>',
      '                    </tr>',
      '                    <tr class="TableStyle-ListTable-Body-Body1">',
      '                        <td class="TableStyle-ListTable-BodyE-Column1-Body1">',
      '                            <p class="TableText">Data Import</p>',
      '                        </td>',
      '                        <td class="TableStyle-ListTable-BodyD-Column1-Body1">',
      '                            <p class="TableText">Imports CSV data.</p>',
    ].join('\n');
    const cleaned = cleanPassage(splitPart7);
    expect(cleaned).toContain('### One Identity Manager tools (part 7/11)');
    expect(cleaned).toContain('<table><tbody><tr><td colspan="2">');
    expect(cleaned.trim().endsWith('</p></td></tr></tbody></table>')).toBe(true);
  });

  it('strips leading orphan closing tags at the start of a split chunk without minting a phantom row', () => {
    const fragment = '</td>\n</tr>\n<tr><td><p>Tool A</p></td><td><p>Description A</p></td></tr></tbody></table>';
    const cleaned = cleanPassage(fragment);
    expect(cleaned).toBe('<table><tbody><tr><td><p>Tool A</p></td><td><p>Description A</p></td></tr></tbody></table>');
  });

  it('wraps a mid-cell split chunk containing only indented <p> and <ul><li> with internal blank lines', () => {
    const midCell = [
      '### Tool details (part 5/11)',
      '',
      '                                <p class="TableText">First paragraph.</p>',
      '',
      '                                <p class="TableText">Second paragraph.</p>',
      '                                <ul>',
      '                                    <li><p class="TableText">Bullet one</p>',
    ].join('\n');
    const cleaned = cleanPassage(midCell);
    expect(cleaned).toContain('<table><tbody><tr><td>');
    expect(cleaned).not.toMatch(/<table>[\s\S]*\n\n[\s\S]*<\/table>/);
    expect(cleaned.trim().endsWith('</p></li></ul></td></tr></tbody></table>')).toBe(true);
  });

  it('leaves multi-line fenced code blocks (including fences closed by a longer delimiter) and single/multi-backtick inline code untouched while balancing real tables', () => {
    const md = [
      'Inline `</td></tr>` and `` `</td></tr>` `` and `` a`<td>`b `` and `` a`<a id="x"></a>`b ``.',
      '',
      '```html',
      '<tr>',
      '<a id="x"></a><td>x</td></tr>',
      '<!-- comment -->',
      '````',
      '',
      '<table><tbody><tr><td><p>Real table cell</p>',
    ].join('\n');
    const cleaned = cleanPassage(md);
    expect(cleaned).toContain('`</td></tr>`');
    expect(cleaned).toContain('`` `</td></tr>` ``');
    expect(cleaned).toContain('`` a`<td>`b ``');
    expect(cleaned).toContain('`` a`<a id="x"></a>`b ``');
    expect(cleaned).toContain('```html\n<tr>\n<a id="x"></a><td>x</td></tr>\n<!-- comment -->\n````');
    expect(cleaned).toContain('<table><tbody><tr><td><p>Real table cell</p></td></tr></tbody></table>');
  });

  it('strips standalone MadCap Copy lines and the 4 corpus captions before fences, but keeps arbitrary lines', () => {
    const directCopy = 'Intro\nCopy\n```sql\nSELECT 1\n```';
    expect(cleanPassage(directCopy)).toBe('Intro\n```sql\nSELECT 1\n```');

    const blankCopy = 'Intro\nCopy\n\n```sql\nSELECT 1\n```';
    expect(cleanPassage(blankCopy)).toBe('Intro\n```sql\nSELECT 1\n```');

    for (const caption of [
      'Example',
      'Example of a multi-line statement',
      'Schema extension file structure',
      'Script structure',
    ]) {
      const withCaption = `Intro\nCopy\n\n${caption}\n\n\`\`\`vb\nDim x As Integer\n\`\`\``;
      expect(cleanPassage(withCaption)).toBe(`Intro\n\`\`\`vb\nDim x As Integer\n\`\`\``);
    }

    const arbitraryLine = 'Intro\nCopy\nArbitrary line not a caption\n```sql\nSELECT 1\n```';
    expect(cleanPassage(arbitraryLine)).toContain('Copy\nArbitrary line not a caption');
  });

  it('is idempotent across split fragments, tail fragments without tbody, and tables with unknown XML / placeholders', () => {
    const splitSample = '### Part 7\n\n                            <p>Designer</p></td></tr><tr><td><p>A</p></td><td><p>B</p>';
    const onceSplit = cleanPassage(splitSample);
    expect(onceSplit).toContain('<table><tbody><tr><td colspan="2"><p>Designer</p></td></tr>');
    expect(onceSplit.trim().endsWith('<td><p>B</p></td></tr></tbody></table>')).toBe(true);
    expect(cleanPassage(onceSplit)).toBe(onceSplit);

    const prosePlusTail = 'Intro…\n</td></tr></table>\n\nAfter.';
    const onceTail = cleanPassage(prosePlusTail);
    expect(onceTail).toBe('<table><tr><td>Intro…\n</td></tr></table>\n\nAfter.');
    expect(onceTail).not.toContain('<tbody><table>');
    expect(onceTail).not.toContain('&lt;tbody&gt;');
    expect(cleanPassage(onceTail)).toBe(onceTail);

    const xmlSample = '<table><tbody><tr><td><p>Specify <condition>, <column name>, and <Class Name="Group">.</p>';
    const onceXml = cleanPassage(xmlSample);
    expect(onceXml).toContain('</tbody></table>');
    expect(cleanPassage(onceXml)).toBe(onceXml);
  });
});


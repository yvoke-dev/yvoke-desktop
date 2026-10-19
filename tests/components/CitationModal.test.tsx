// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: { initialize: () => undefined, render: async () => ({ svg: '<svg></svg>' }) },
}));

import { CitationModal } from '../../src/renderer/src/components/CitationModal';

afterEach(() => cleanup());

const CITED = '274b9610-9148-4621-a5a1-089e807210c1';
const OTHER = '8f5ca25a-18d7-4a2a-947d-40b5e807db6a';
const THIRD = 'a57b789d-2a11-478b-8c68-d490fdf9c2af';
const DOC = '8d86048e-54d0-4a4d-a4ab-87b053ba1e0a';

const CITED_TEXT = 'A mapping groups the rules relating schema properties.';
const OTHER_TEXT = 'OIM distinguishes four schema variants.';
const THIRD_TEXT = 'Mapping direction governs which rules apply.';

const SERVED = [
  '# Section: How are schemas mapped',
  '_(document: Basics of target system synchronization  ·  tag: 9.3.1  ·  3 passage(s)  ·  with sub-sections  ·  cite a passage by the id shown above it)_',
  '',
  `_(id=${CITED}  doc_id=${DOC})_`,
  CITED_TEXT,
  '',
  `_(id=${OTHER}  doc_id=${DOC})_`,
  OTHER_TEXT,
  '',
  `_(id=${THIRD}  doc_id=${DOC})_`,
  THIRD_TEXT,
].join('\n');

const noop = (): void => undefined;
const open = (citedId?: string) =>
  render(<CitationModal state={{ loading: false, text: SERVED, citedId }} onClose={noop} />);

describe('CitationModal', () => {
  it('shows only the cited passage — a citation names one passage, not its section', () => {
    // get_section returns the whole enclosing section; on one real answer a 1,357-character
    // passage arrived inside 220 passages / 314,064 characters.
    const { container } = open(CITED);
    expect(container.textContent).toContain(CITED_TEXT);
    expect(container.textContent).not.toContain(OTHER_TEXT);
    expect(container.textContent).not.toContain(THIRD_TEXT);
    expect(container.querySelectorAll('.citation-passage')).toHaveLength(1);
  });

  it('never shows a raw uuid or the directive meant for the model', () => {
    const { container } = open(CITED);
    const shown = container.textContent ?? '';
    expect(shown).not.toContain('doc_id=');
    expect(shown).not.toContain(CITED);
    expect(shown).not.toContain('cite a passage');
  });

  it('does not offer a link or button to load the rest of the passages', () => {
    const { container } = open(CITED);
    // Asserted on the rendered controls rather than on the old toggle's class name, which no
    // longer exists and so could never fail for the right reason again.
    expect(container.querySelectorAll('.citation-modal-body button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /surrounding section/i })).toBeNull();
    expect(container.textContent).toContain(CITED_TEXT);
    expect(container.textContent).not.toContain(OTHER_TEXT);
    expect(container.textContent).not.toContain(THIRD_TEXT);
  });

  it('falls back to the whole section when the citation names no passage', () => {
    // A `[document_id=…]` or `[file=…]` citation: nothing to single out, so show everything
    // rather than nothing.
    const { container } = open(undefined);
    expect(container.querySelectorAll('.citation-passage')).toHaveLength(3);
    expect(container.textContent).toContain(OTHER_TEXT);
  });

  it('falls back when the id does not match anything that came back', () => {
    const { container } = open('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(container.querySelectorAll('.citation-passage')).toHaveLength(3);
  });

  it('keeps document title and version', () => {
    const { container } = open(CITED);
    expect(container.textContent).toContain('Basics of target system synchronization');
    expect(container.textContent).toContain('tag: 9.3.1');
  });

  it('renders an error instead of a section', () => {
    const { container } = render(
      <CitationModal state={{ loading: false, error: 'This source is no longer available.' }} onClose={noop} />,
    );
    expect(container.querySelector('.banner.error')?.textContent).toContain('no longer available');
    expect(container.querySelector('.citation-passage')).toBeNull();
  });

  it('renders markdown inside a passage rather than its source', () => {
    const md = `_(id=${CITED}  doc_id=${DOC})_\n| A | B |\n| --- | --- |\n| 1 | 2 |`;
    const { container } = render(
      <CitationModal state={{ loading: false, text: md, citedId: CITED }} onClose={noop} />,
    );
    expect(container.querySelector('.citation-passage table')).not.toBeNull();
  });

  it('preserves heading when it represents a distinct sub-section', () => {
    // SERVED has heading "How are schemas mapped" and document "Basics of target system synchronization"
    const { container } = open(CITED);
    const heading = container.querySelector('.citation-section-heading');
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toBe('How are schemas mapped');
  });

  it('suppresses heading when it equals "Full Document"', () => {
    const servedFullDoc = [
      '# Section: Full Document',
      '_(document: API Specs  ·  tag: 1.0)_',
      '',
      `_(id=${CITED}  doc_id=${DOC})_`,
      'Spec details.',
    ].join('\n');
    const { container } = render(
      <CitationModal state={{ loading: false, text: servedFullDoc, citedId: CITED }} onClose={noop} />,
    );
    expect(container.querySelector('.citation-section-heading')).toBeNull();
  });

  it('suppresses heading when it matches documentTitle', () => {
    const servedMatchingDoc = [
      '# Section: User Guide',
      '_(document: User Guide  ·  tag: 1.0)_',
      '',
      `_(id=${CITED}  doc_id=${DOC})_`,
      'Guide content.',
    ].join('\n');
    const { container } = render(
      <CitationModal state={{ loading: false, text: servedMatchingDoc, citedId: CITED }} onClose={noop} />,
    );
    expect(container.querySelector('.citation-section-heading')).toBeNull();
  });

  it('suppresses heading when the first shown passage starts with # Heading', () => {
    const servedWithPassageHeading = [
      '# Section: Getting Started',
      '_(document: Documentation  ·  tag: 1.0)_',
      '',
      `_(id=${CITED}  doc_id=${DOC})_`,
      '# Getting Started\n\nWelcome to the documentation.',
    ].join('\n');
    const { container } = render(
      <CitationModal state={{ loading: false, text: servedWithPassageHeading, citedId: CITED }} onClose={noop} />,
    );
    expect(container.querySelector('.citation-section-heading')).toBeNull();
    expect(container.textContent).toContain('Getting Started');
  });

  it('renders split HTML table passages ([e613e51c] part 7/11 and [3bbcf4ec] part 3/3) as HTML tables instead of code blocks', () => {
    const e613e51c = 'e613e51c-725c-4b02-9b96-066a227319d5';
    const servedPart7 = [
      '# Section: One Identity Manager tools (part 7/11)',
      '_(document: Target system synchronization  ·  tag: 9.3.1  ·  1 passage(s))_',
      '',
      `_(id=${e613e51c}  doc_id=${DOC})_`,
      '> Section path: Target system synchronization > One Identity Manager tools (part 7/11)',
      '### One Identity Manager tools (part 7/11)',
      '',
      '                            <p class="TableText">The Designer is the main tool for customizing One Identity Manager.</p>',
      '                        </td>',
      '                    </tr>',
      '                    <tr class="TableStyle-ListTable-Body-Body1">',
      '                        <td class="TableStyle-ListTable-BodyE-Column1-Body1">',
      '                            <p class="TableText">Data Import</p>',
      '                        </td>',
      '                        <td class="TableStyle-ListTable-BodyD-Column1-Body1">',
      '                            <p class="TableText">Imports data from CSV files.</p>',
    ].join('\n');

    const { container: c1 } = render(
      <CitationModal state={{ loading: false, text: servedPart7, citedId: e613e51c }} onClose={noop} />,
    );
    expect(c1.querySelector('.citation-passage table')).not.toBeNull();
    expect(c1.querySelector('.citation-passage table tr td')?.getAttribute('colspan')).toBe('2');
    expect(c1.querySelector('.citation-passage .code-block-wrapper')).toBeNull();

    const c3bbcf4ec = '3bbcf4ec-2211-4099-9111-112233445566';
    const servedPart3 = [
      '# Section: One Identity Manager users for managing resources (part 3/3)',
      '_(document: Administration Guide  ·  tag: 9.3.1  ·  1 passage(s))_',
      '',
      `_(id=${c3bbcf4ec}  doc_id=${DOC})_`,
      '> Section path: Users (part 3/3)',
      '### One Identity Manager users for managing resources (part 3/3)',
      '',
      '                                    <p class="TableText">Create system users for synchronization.</p>',
      '                                </li>',
      '                            </ul>',
      '                        </td>',
      '                    </tr>',
      '                </tbody>',
      '            </table>',
    ].join('\n');

    const { container: c2 } = render(
      <CitationModal state={{ loading: false, text: servedPart3, citedId: c3bbcf4ec }} onClose={noop} />,
    );
    expect(c2.querySelector('.citation-passage table')).not.toBeNull();
    expect(c2.querySelector('.citation-passage table ul li')?.textContent).toContain(
      'Create system users for synchronization.',
    );
    expect(c2.querySelector('.citation-passage .code-block-wrapper')).toBeNull();
  });
});


// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

  it('offers the rest of the section as context, counted and collapsed', () => {
    const { container } = open(CITED);
    const toggle = screen.getByRole('button', { name: /Show surrounding section \(2 more passages\)/ });
    expect(toggle).toBeTruthy();
    expect(container.querySelector('.citation-context')).toBeNull();
  });

  it('reveals the context on request, labelled as not being the source', () => {
    const { container } = open(CITED);
    fireEvent.click(screen.getByRole('button', { name: /Show surrounding section/ }));
    expect(container.textContent).toContain(OTHER_TEXT);
    expect(container.textContent).toContain(THIRD_TEXT);
    expect(container.querySelector('.citation-context-note')?.textContent).toMatch(/not part of the cited source/i);
    // The cited passage stays outside the context block, so evidence and context never merge.
    expect(container.querySelector('.citation-context .citation-passage.cited')).toBeNull();
  });

  it('collapses again on a second click', () => {
    const { container } = open(CITED);
    const toggle = screen.getByRole('button', { name: /surrounding section/ });
    fireEvent.click(toggle);
    expect(container.querySelector('.citation-context')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Hide surrounding section/ }));
    expect(container.querySelector('.citation-context')).toBeNull();
  });

  it('singularises a one-passage remainder', () => {
    const two = [
      `_(id=${CITED}  doc_id=${DOC})_`, CITED_TEXT, '',
      `_(id=${OTHER}  doc_id=${DOC})_`, OTHER_TEXT,
    ].join('\n');
    render(<CitationModal state={{ loading: false, text: two, citedId: CITED }} onClose={noop} />);
    expect(screen.getByRole('button', { name: /\(1 more passage\)/ })).toBeTruthy();
  });

  it('offers no toggle when the cited passage is the whole section', () => {
    const one = `_(id=${CITED}  doc_id=${DOC})_\n${CITED_TEXT}`;
    const { container } = render(
      <CitationModal state={{ loading: false, text: one, citedId: CITED }} onClose={noop} />,
    );
    expect(container.querySelector('.citation-context-toggle')).toBeNull();
    expect(container.textContent).toContain(CITED_TEXT);
  });

  it('falls back to the whole section when the citation names no passage', () => {
    // A `[document_id=…]` or `[file=…]` citation: nothing to single out, so show everything
    // rather than nothing.
    const { container } = open(undefined);
    expect(container.querySelectorAll('.citation-passage')).toHaveLength(3);
    expect(container.querySelector('.citation-context-toggle')).toBeNull();
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
});

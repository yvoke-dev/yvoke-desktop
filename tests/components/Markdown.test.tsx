// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mermaid is heavy and only used for diagram fences; stub it so these tests stay fast.
vi.mock('mermaid', () => ({
  default: { initialize: () => undefined, render: async () => ({ svg: '<svg></svg>' }) },
}));

import { Markdown } from '../../src/renderer/src/components/Markdown';

afterEach(() => cleanup());

describe('Markdown citations', () => {
  it('renders a chunk_id marker as a clickable pill that reports the ref', () => {
    const onCitation = vi.fn();
    render(<Markdown content="See [chunk_id=abc123] for details." onCitation={onCitation} />);
    fireEvent.click(screen.getByRole('button', { name: /chunk_id=abc123/ }));
    expect(onCitation).toHaveBeenCalledWith({ chunkId: 'abc123' });
  });

  it('renders a file marker with the right ref kind', () => {
    const onCitation = vi.fn();
    render(<Markdown content="[file=guide.md]" onCitation={onCitation} />);
    fireEvent.click(screen.getByRole('button', { name: /file=guide\.md/ }));
    expect(onCitation).toHaveBeenCalledWith({ file: 'guide.md' });
  });

  it('renders plain markdown without citation handling', () => {
    render(<Markdown content="**bold words**" onCitation={vi.fn()} />);
    expect(screen.getByText('bold words')).toBeTruthy();
  });
});

describe('numbered reference markers', () => {
  // [N] markers are typography, not navigation: a plain <sup>, never a link or a button. Anything
  // interactive here was also getting boxed by the generic `button:not(…)` chrome in styles.css.
  const REFS = '\n\n## References\n[1] [chunk_id=abc123]\n';

  it('renders an inline [N] as a plain sup, not a link or button', () => {
    const { container } = render(<Markdown content={`Claim [1].${REFS}`} onCitation={vi.fn()} />);
    expect(container.querySelector('sup.ref-marker')).not.toBeNull();
    expect(container.querySelector('button.ref-marker')).toBeNull();
    expect(container.querySelector('a[href=""]')).toBeNull();
  });

  it('shows the bare digit, not literal "[1]"', () => {
    const { container } = render(<Markdown content={`Claim [1].${REFS}`} onCitation={vi.fn()} />);
    const sup = container.querySelector('sup.ref-marker');
    expect(sup?.textContent).toBe('1');
    expect(sup?.textContent).not.toContain('[');
  });

  it('leaves the [N] of a plain References line as literal text', () => {
    const { container } = render(<Markdown content={`Claim [1].${REFS}`} onCitation={vi.fn()} />);
    // Exactly one marker — the inline one. The list's own [1] is not a marker.
    expect(container.querySelectorAll('sup.ref-marker')).toHaveLength(1);
    expect(container.textContent).toContain('[1]');
  });

  it('leaves the [N] of a BULLETED References list alone too', () => {
    // Models write the list as `- [1] [chunk_id=…]` at least as often as bare lines.
    const md = 'Claim [1].\n\n## References\n- [1] [chunk_id=abc123]\n';
    const { container } = render(<Markdown content={md} onCitation={vi.fn()} />);
    expect(container.querySelectorAll('sup.ref-marker')).toHaveLength(1);
    expect(container.querySelector('li')?.textContent).toContain('[1]');
  });

  it('leaves EVERY [N] of a multi-entry References block literal', () => {
    // Models emit the whole list as one soft-broken paragraph. Scoping the rule to the first [N]
    // per block left [2] and [3] rendered as superscripts in the middle of the list.
    const md = 'Claim [1].\n\n## References\n[1] [chunk_id=a]\n[2] [chunk_id=b]\n[3] [chunk_id=c]\n';
    const { container } = render(<Markdown content={md} onCitation={vi.fn()} />);
    expect(container.querySelectorAll('sup.ref-marker')).toHaveLength(1);
    const refs = container.querySelectorAll('p')[1];
    expect(refs?.textContent).toContain('[2]');
    expect(refs?.textContent).toContain('[3]');
  });

  it('leaves the [N] of a numbered References list alone too', () => {
    const md = 'Claim [1].\n\n## References\n1. [1] [chunk_id=abc123]\n';
    const { container } = render(<Markdown content={md} onCitation={vi.fn()} />);
    expect(container.querySelectorAll('sup.ref-marker')).toHaveLength(1);
    expect(container.querySelector('li')?.textContent).toContain('[1]');
  });

  it('still renders real markdown links normally', () => {
    const { container } = render(
      <Markdown content="See [the docs](https://example.com)." onCitation={vi.fn()} />,
    );
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.textContent).toBe('the docs');
  });
});

describe('citation rewriting never corrupts real content', () => {
  // These are the cases the old pre-parse string replace destroyed. It ran over the raw markdown
  // with no idea what was code and what was syntax; the rehype plugin walks the parsed tree, where
  // code blocks and links are whole nodes it simply does not descend into.
  const cite = { onCitation: vi.fn() };

  it('leaves a real markdown link whose label is a number intact', () => {
    // Was severed into a dead marker plus the bare URL leaking into the prose.
    const { container } = render(<Markdown content="See [2](https://example.com)." {...cite} />);
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.textContent).toBe('2');
    expect(container.textContent).not.toContain('https://example.com)');
  });

  it('leaves an array index in a fenced code block alone', () => {
    const md = '```java\nString s = args[1];\n```';
    const { container } = render(<Markdown content={md} {...cite} />);
    expect(container.querySelector('code')?.textContent).toContain('String s = args[1];');
    expect(container.querySelector('code button')).toBeNull();
  });

  it('leaves an array index in inline code alone', () => {
    const { container } = render(<Markdown content="Use `items[2]` here." {...cite} />);
    expect(container.querySelector('code')?.textContent).toBe('items[2]');
    expect(container.querySelector('code button')).toBeNull();
  });

  it('leaves a citation token inside a code fence as literal text', () => {
    const md = '```\nlookup[chunk_id=abc123]\n```';
    const { container } = render(<Markdown content={md} {...cite} />);
    expect(container.querySelector('code')?.textContent).toContain('[chunk_id=abc123]');
    expect(container.querySelector('code button')).toBeNull();
  });

  it('still linkifies citations in ordinary prose beside a code block', () => {
    const md = 'Before [chunk_id=abc123].\n\n```\nargs[1]\n```\n\nAfter [1].\n\n## References\n[1] [chunk_id=abc123]\n';
    const { container } = render(<Markdown content={md} {...cite} />);
    expect(container.querySelector('button.citation-link')).not.toBeNull();
    expect(container.querySelector('sup.ref-marker')).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('args[1]');
  });

  it('does not rewrite inside an existing link', () => {
    const md = 'See [docs [1] here](https://example.com).';
    const { container } = render(<Markdown content={md} {...cite} />);
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link?.querySelector('button, sup')).toBeNull();
    expect(link?.textContent).toContain('[1]');
  });

  it('leaves markers as plain text when there is no citation handler', () => {
    const { container } = render(<Markdown content="Claim [chunk_id=abc123]." />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('[chunk_id=abc123]');
  });
});

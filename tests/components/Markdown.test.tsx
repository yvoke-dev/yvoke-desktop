// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Mermaid is heavy and only used for diagram fences; stub it so these tests stay fast.
//
// The stub rejects one construct the sanitizer exists to repair — a semicolon inside a sequence
// message, where it is a statement delimiter — rather than a magic token. A stub keyed on the
// repaired output would pass no matter what the sanitizer produced, which is the failure mode this
// replaced. Tests that need a different failure add one with `mockImplementationOnce`, so each
// says out loud which attempts it is failing instead of hiding it in a shared heuristic.
const mockRender = vi.fn(async (_id: string, code: string) => {
  const lines = code.split('\n');
  const isSequence = lines.some((l) => /^\s*sequenceDiagram\b/.test(l));
  if (isSequence && lines.some((l) => /^\s*\S+\s*-{1,2}>>?\s*\S+\s*:[^\n]*;/.test(l))) {
    throw new Error('Parse error on line 3: unexpected ";"');
  }
  return { svg: '<svg class="rendered-diagram"></svg>' };
});

const mockInitialize = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (config: unknown) => mockInitialize(config),
    render: (id: string, code: string) => mockRender(id, code),
  },
}));

import { Markdown } from '../../src/renderer/src/components/Markdown';

afterEach(() => {
  cleanup();
  // Call history is asserted per-test ("the last chart mermaid accepted"), and any unconsumed
  // `mockImplementationOnce` would otherwise leak into the next test's first render.
  mockRender.mockReset();
  mockInitialize.mockReset();
});

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

// The format the server's prompts actually mandate now: a bare uuid, no `chunk_id=` prefix, no
// numbering, no References section. These went unrecognised entirely and rendered as dead text.
describe('bare id citations', () => {
  const UUID = '274b9610-9148-4621-a5a1-089e807210c1';

  it('renders a bare uuid as a clickable pill labelled with its first 8 characters', () => {
    const onCitation = vi.fn();
    render(<Markdown content={`A mapping groups the rules. [${UUID}]`} onCitation={onCitation} />);
    const pill = screen.getByRole('button', { name: '[274b9610]' });
    fireEvent.click(pill);
    // `id`, not `chunkId`: the marker does not say which table it names.
    expect(onCitation).toHaveBeenCalledWith({ id: UUID });
  });

  it('recognises the hyphen-free 32-hex spelling', () => {
    const onCitation = vi.fn();
    const bare = UUID.replace(/-/g, '');
    render(<Markdown content={`Claim [${bare}].`} onCitation={onCitation} />);
    fireEvent.click(screen.getByRole('button', { name: '[274b9610]' }));
    expect(onCitation).toHaveBeenCalledWith({ id: bare });
  });

  it('links the same id twice — a repeat is the same source, not a duplicate to collapse', () => {
    const onCitation = vi.fn();
    const md = `First claim [${UUID}]. Second claim [${UUID}].`;
    const { container } = render(<Markdown content={md} onCitation={onCitation} />);
    expect(container.querySelectorAll('button.citation-link')).toHaveLength(2);
  });

  it('leaves a bare id inside a code fence as literal text', () => {
    const md = `\`\`\`\nget_section(chunk_id="${UUID}")\n\`\`\``;
    const { container } = render(<Markdown content={md} onCitation={vi.fn()} />);
    expect(container.querySelector('code')?.textContent).toContain(UUID);
    expect(container.querySelector('code button')).toBeNull();
  });

  it('does not linkify a truncated id — 8 hex characters is also ordinary prose', () => {
    const { container } = render(<Markdown content="Error code [decade00]." onCitation={vi.fn()} />);
    expect(container.querySelector('button.citation-link')).toBeNull();
    expect(container.textContent).toContain('[decade00]');
  });

  it('keeps a bare id and a [N] marker in one sentence apart', () => {
    const onCitation = vi.fn();
    const md = `Claim [1] and claim [${UUID}].`;
    const { container } = render(<Markdown content={md} onCitation={onCitation} />);
    expect(container.querySelector('sup.ref-marker')?.textContent).toBe('1');
    expect(container.querySelector('button.citation-link')?.textContent).toBe('[274b9610]');
  });

  it('renders adjacent separate brackets [uuid1][uuid2] as multiple clickable pills', () => {
    const onCitation = vi.fn();
    const UUID2 = '9ab3009d-2057-49db-a03f-27aeb336ff49';
    render(<Markdown content={`Adjacent [${UUID}][${UUID2}].`} onCitation={onCitation} />);
    const pill1 = screen.getByRole('button', { name: '[274b9610]' });
    const pill2 = screen.getByRole('button', { name: '[9ab3009d]' });
    expect(pill1).toBeTruthy();
    expect(pill2).toBeTruthy();
    fireEvent.click(pill1);
    expect(onCitation).toHaveBeenCalledWith({ id: UUID });
    fireEvent.click(pill2);
    expect(onCitation).toHaveBeenCalledWith({ id: UUID2 });
  });

  it('renders grouped comma-separated bare uuids in a single bracket as multiple clickable pills (with or without space)', () => {
    const onCitation = vi.fn();
    const UUID2 = '9ab3009d-2057-49db-a03f-27aeb336ff49';
    // Test with space: [uuid1, uuid2]
    const { unmount } = render(<Markdown content={`Multiple sources [${UUID}, ${UUID2}].`} onCitation={onCitation} />);
    expect(screen.getByRole('button', { name: '[274b9610]' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '[9ab3009d]' })).toBeTruthy();
    unmount();

    // Test without space: [uuid1,uuid2]
    render(<Markdown content={`Multiple sources [${UUID},${UUID2}].`} onCitation={onCitation} />);
    const pill1 = screen.getByRole('button', { name: '[274b9610]' });
    const pill2 = screen.getByRole('button', { name: '[9ab3009d]' });
    expect(pill1).toBeTruthy();
    expect(pill2).toBeTruthy();
    fireEvent.click(pill2);
    expect(onCitation).toHaveBeenCalledWith({ id: UUID2 });
  });

  it('renders grouped chunk_ids in a single bracket as multiple clickable pills', () => {
    const onCitation = vi.fn();
    render(<Markdown content="Sources [chunk_id=abc123, chunk_id=def456]." onCitation={onCitation} />);
    const pill1 = screen.getByRole('button', { name: '[chunk_id=abc123]' });
    const pill2 = screen.getByRole('button', { name: '[chunk_id=def456]' });
    expect(pill1).toBeTruthy();
    expect(pill2).toBeTruthy();
    fireEvent.click(pill1);
    expect(onCitation).toHaveBeenCalledWith({ chunkId: 'abc123' });
  });

  it('renders grouped numbered markers [1, 2] as individual superscripts', () => {
    const { container } = render(<Markdown content="Claim [1, 2]." onCitation={vi.fn()} />);
    const markers = container.querySelectorAll('sup.ref-marker');
    expect(markers).toHaveLength(2);
    expect(markers[0]?.textContent).toBe('1');
    expect(markers[1]?.textContent).toBe('2');
  });

  it('leaves markers as plain text when there is no citation handler', () => {
    const { container } = render(<Markdown content={`Claim [${UUID}].`} />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain(UUID);
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

describe('Mermaid diagram rendering and auto-repair', () => {
  it('configures mermaid with compact typography and disabled useMaxWidth', async () => {
    const md = '```mermaid\nflowchart TD\n  A --> B\n```';
    render(<Markdown content={md} />);
    await screen.findByText((_content, el) => el?.classList.contains('mermaid-diagram-container') || false);
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        fontSize: 13,
        flowchart: expect.objectContaining({ useMaxWidth: false }),
        sequence: expect.objectContaining({ useMaxWidth: false }),
      }),
    );
  });

  it('renders a valid diagram inside mermaid-diagram-container', async () => {
    const md = '```mermaid\nflowchart TD\n  A --> B\n```';
    const { container } = render(<Markdown content={md} />);
    const diagram = await screen.findByText((_content, el) => el?.classList.contains('mermaid-diagram-container') || false);
    expect(diagram).toBeTruthy();
    expect(container.querySelector('.mermaid-repaired-marker')).toBeNull();
  });

  it('renders a preformatted placeholder while live streaming', () => {
    const md = '```mermaid\nflowchart TD\n  A --> B\n```';
    const { container } = render(<Markdown content={md} live={true} />);
    expect(container.querySelector('.mermaid-streaming')).toBeTruthy();
    expect(container.querySelector('.mermaid-diagram-container')).toBeNull();
  });

  it('auto-repairs broken sequence diagram syntax and displays the marker badge', async () => {
    const brokenMd = '```mermaid\nsequenceDiagram\nU->>DB: Request; Policy\\nInherit\n```';
    const { container } = render(<Markdown content={brokenMd} />);

    const marker = await screen.findByText(/Auto-repaired syntax/);
    expect(marker).toBeTruthy();
    expect(container.querySelector('.mermaid-repaired-marker')).toBeTruthy();
    expect(container.querySelector('.mermaid-diagram-container')).toBeTruthy();
  });

  it('names the repairs it applied in the badge tooltip', async () => {
    const brokenMd = '```mermaid\nsequenceDiagram\nU->>DB: Request; Policy\n```';
    const { container } = render(<Markdown content={brokenMd} />);

    await screen.findByText(/Auto-repaired syntax/);
    const title = container.querySelector('.mermaid-repaired-marker')?.getAttribute('title') ?? '';
    expect(title).toContain('Replaced semicolons with commas in sequence message label');
  });

  it('stops at the first repair that parses, leaving a backslash path intact', async () => {
    // The semicolon is the only parse error; `C:\new` is ordinary content that the escape rewrite
    // would mangle into `C:<br/>ew`. The staged retry must stop at the repair that works.
    const md = '```mermaid\nsequenceDiagram\nU->>DB: Load C:\\new\\config; then run\n```';
    const { container } = render(<Markdown content={md} />);

    await screen.findByText(/Auto-repaired syntax/);
    const accepted = mockRender.mock.calls[mockRender.mock.calls.length - 1][1];
    expect(accepted).toContain('Load C:\\new\\config, then run');
    expect(accepted).not.toContain('<br/>');

    const title = container.querySelector('.mermaid-repaired-marker')?.getAttribute('title') ?? '';
    expect(title).not.toContain('<br/>');
  });

  it('falls through to the escape rewrite when the safe repairs still do not parse', async () => {
    // Fail the raw chart and the text-level repair; only the escape stage is left.
    mockRender
      .mockImplementationOnce(async () => { throw new Error('Parse error: raw'); })
      .mockImplementationOnce(async () => { throw new Error('Parse error: still broken'); });

    const md = '```mermaid\nsequenceDiagram\nU->>DB: Assign product; then\\ninherit\n```';
    const { container } = render(<Markdown content={md} />);

    await screen.findByText(/Auto-repaired syntax/);
    const accepted = mockRender.mock.calls[mockRender.mock.calls.length - 1][1];
    expect(accepted).toContain('then<br/>inherit');

    const title = container.querySelector('.mermaid-repaired-marker')?.getAttribute('title') ?? '';
    expect(title).toContain('Replaced literal \\n with <br/>');
  });

  it('shows the raw source and the original error when no repair parses', async () => {
    mockRender.mockImplementationOnce(async () => { throw new Error('Parse error: totally broken'); });
    const md = '```mermaid\nsequenceDiagram\n  !!! not a diagram\n```';
    const { container } = render(<Markdown content={md} />);

    const label = await screen.findByText(/Mermaid render error: Parse error: totally broken/);
    expect(label).toBeTruthy();
    expect(container.querySelector('.mermaid-raw')?.textContent).toContain('!!! not a diagram');
    expect(container.querySelector('.mermaid-repaired-marker')).toBeNull();
  });
});

describe('Code block copy button', () => {
  it('renders a copy button on code blocks and copies code content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const md = '```python\ndef hello():\n    return "world"\n```';
    render(<Markdown content={md} />);

    const copyBtn = screen.getByRole('button', { name: 'Copy code' });
    expect(copyBtn).toBeTruthy();
    fireEvent.click(copyBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('def hello():\n    return "world"'));
  });
});

describe('Mermaid diagram copy and zoom buttons', () => {
  it('renders copy source, copy image, and zoom buttons for diagrams', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const md = '```mermaid\nflowchart TD\n  A --> B\n```';
    render(<Markdown content={md} />);

    const sourceBtn = await screen.findByRole('button', { name: 'Copy Mermaid source' });
    const imageBtn = screen.getByRole('button', { name: 'Copy diagram as image' });
    const zoomBtn = screen.getByRole('button', { name: 'Zoom and inspect diagram' });
    expect(sourceBtn).toBeTruthy();
    expect(imageBtn).toBeTruthy();
    expect(zoomBtn).toBeTruthy();

    fireEvent.click(sourceBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('flowchart TD\n  A --> B'));
  });

  it('opens zoom modal when zoom button is clicked and closes on Escape', async () => {
    const md = '```mermaid\nflowchart TD\n  A --> B\n```';
    render(<Markdown content={md} />);

    const zoomBtn = await screen.findByRole('button', { name: 'Zoom and inspect diagram' });
    fireEvent.click(zoomBtn);

    expect(screen.getByRole('dialog', { name: 'Diagram preview' })).toBeTruthy();
    expect(screen.getByText('Diagram Preview')).toBeTruthy();

    // Close via Escape
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Diagram preview' })).toBeNull();
  });
});

describe('HTML tables, split table fragments, and MadCap artifacts', () => {
  it('renders a complete HTML table with caption, colgroup, thead, tbody, comments, and madcap:conditionaltext', () => {
    const md = [
      '<table class="TableStyle-ListTable" cellspacing="0">',
      '  <!-- comment immediately after table opener -->',
      '  <madcap:conditionaltext data-mc-conditions="Default.ScreenOnly">',
      '    <caption><span>Table 1: </span><span>Tools overview</span></caption>',
      '  </madcap:conditionaltext>',
      '  <colgroup><col /><col /></colgroup>',
      '  <thead>',
      '    <tr><th>Tool</th><th>Purpose</th></tr>',
      '  </thead>',
      '  <tbody>',
      '    <tr>',
      '      <td><p>Designer [274b9610-9148-4621-a5a1-089e807210c1]</p></td>',
      '      <td><madcap:conditionaltext data-mc-conditions="Default.Print">Schema editor</madcap:conditionaltext></td>',
      '    </tr>',
      '  </tbody>',
      '</table>',
    ].join('\n');

    const onCitation = vi.fn();
    const { container } = render(<Markdown content={md} onCitation={onCitation} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('caption')?.textContent).toBe('Table 1: Tools overview');
    expect(table?.querySelectorAll('th')).toHaveLength(2);
    expect(table?.querySelectorAll('td')).toHaveLength(2);
    expect(table?.textContent).toContain('Schema editor');
    expect(container.querySelector('madcap\\:conditionaltext')).toBeNull();
    // Citation inside table cell is still interactive because rehypeHtmlTables runs before rehypeCitations
    const pill = screen.getByRole('button', { name: '[274b9610]' });
    fireEvent.click(pill);
    expect(onCitation).toHaveBeenCalledWith({ id: '274b9610-9148-4621-a5a1-089e807210c1' });
  });

  it('renders a mid-table split chunk ([e613e51c] part 7/11 shape) as a table with colSpan={2} and zero code blocks', () => {
    const md = [
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
      '                            <p class="TableText">Imports CSV files.</p>',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    expect(container.querySelector('h3')?.textContent).toBe('One Identity Manager tools (part 7/11)');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(container.querySelector('.code-block-wrapper')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
    const firstTd = table?.querySelector('tr td');
    expect(firstTd?.getAttribute('colspan')).toBe('2');
    expect(firstTd?.textContent).toContain('The Designer is the main tool');
  });

  it('renders a tail split chunk ([3bbcf4ec] part 3/3 shape) and preserves trailing Related topics markdown', () => {
    const md = [
      '> Section path: Managing resources (part 3/3)',
      '### One Identity Manager users for managing resources (part 3/3)',
      '',
      '                                    <p class="TableText">Create system users and assign permissions.</p>',
      '                                </li>',
      '                                <li>',
      '                                    <p class="TableText">Maintain password policies.</p>',
      '                                </li>',
      '                            </ul>',
      '                        </td>',
      '                    </tr>',
      '                </tbody>',
      '            </table>',
      '',
      '###### Related topics',
      '',
      '- [Using system users](https://example.com/system-users)',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('table li')).toHaveLength(2);
    expect(container.querySelector('h6')?.textContent).toBe('Related topics');
    expect(container.querySelector('a[href="https://example.com/system-users"]')?.textContent).toBe('Using system users');
    expect(container.querySelector('.code-block-wrapper')).toBeNull();
  });

  it('renders a mid-list split chunk (part 3/11 shape) with reconstructed ul/td/tr/tbody/table ancestors', () => {
    const md = [
      '### One Identity Manager tools (part 3/11)',
      '',
      '                                <li>',
      '                                    <p class="TableText">Changing your own main data</p>',
      '                                </li>',
      '                            </ul>',
      '                        </td>',
      '                    </tr>',
      '                    <tr>',
      '                        <td><p>Launchpad</p></td>',
      '                        <td><p>Starts apps</p></td>',
      '                    </tr>',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('tr td')?.getAttribute('colspan')).toBe('2');
    expect(table?.querySelector('tr td ul li')?.textContent).toContain('Changing your own main data');
  });

  it('renders a head split chunk (part 2/11 shape) and a live={true} streaming truncated table cleanly', () => {
    const truncated = [
      '<table class="TableStyle-ListTable">',
      '  <thead><tr><th>Tool</th><th>Features</th></tr></thead>',
      '  <tbody>',
      '    <tr>',
      '      <td><p>Manager</p></td>',
      '      <td><ul><li><p>Master data administration',
    ].join('\n');

    const { container: c1 } = render(<Markdown content={truncated} live={false} />);
    expect(c1.querySelector('table')).not.toBeNull();
    expect(c1.querySelector('table li')?.textContent).toContain('Master data administration');

    const { container: c2 } = render(<Markdown content={truncated} live={true} />);
    expect(c2.querySelector('table')).not.toBeNull();
    expect(c2.querySelector('table li')?.textContent).toContain('Master data administration');
  });

  it('strips leading orphan closing tags so they do not mint an empty phantom row', () => {
    const md = '</td>\n</tr>\n<tr><td><p>Tool A</p></td><td><p>Description A</p></td></tr></tbody></table>';
    const { container } = render(<Markdown content={md} />);
    expect(container.querySelectorAll('table tr')).toHaveLength(1);
  });

  it('preserves unknown XML tags and angle-bracket placeholders inside table cells as visible text', () => {
    const md =
      '<table><tbody><tr><td><p>Specify <condition>, <column name>, <form name>, and <Class Name="Group">.</p></td></tr></tbody></table>';
    const { container } = render(<Markdown content={md} />);
    const cellText = container.querySelector('table td')?.textContent ?? '';
    expect(cellText).toContain('<condition>');
    expect(cellText).toContain('<column name>');
    expect(cellText).toContain('<form name>');
    expect(cellText).toContain('<Class Name="Group">');
  });

  it('keeps prose placeholders and uppercase XML outside tables as visible literal text while rendering real tables', () => {
    const md = [
      '1. Select the **<table>** category.',
      '',
      'Use <table name>.<column name> in your query.',
      '',
      '<Key><T>DialogTable</T><P>RMB-T-Org</P></Key>',
      '',
      '<table><tbody><tr><td><p>Actual table</p></td></tr></tbody></table>',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(container.querySelector('table td')?.textContent).toBe('Actual table');
    expect(container.textContent).toContain('<table>');
    expect(container.textContent).toContain('<table name>.<column name>');
    expect(container.textContent).toContain('<Key><T>DialogTable</T><P>RMB-T-Org</P></Key>');
  });

  it('preserves unquoted/boolean table attributes while stripping className, event handlers, style, data-*, <script>, and javascript: URLs', () => {
    const md = [
      '<table hidden>',
      '  <tbody>',
      '    <tr>',
      '      <td colspan=2 nowrap class="banner error primary" onclick="alert(1)" style="color:red" data-mc-conditions="X">',
      '        <p>Safe cell</p>',
      '        <a href="javascript:alert(1)">Bad link</a>',
      '        <a href="https://example.com/docs">Good link</a>',
      '        <img src="javascript:alert(1)" onerror="alert(1)" alt="bad" />',
      '        <script>alert(1)</script>',
      '      </td>',
      '    </tr>',
      '  </tbody>',
      '</table>',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    const td = container.querySelector('table td');
    expect(td).not.toBeNull();
    expect(td?.getAttribute('colspan')).toBe('2');
    expect(td?.getAttribute('class')).toBeNull();
    expect(td?.getAttribute('onclick')).toBeNull();
    expect(td?.getAttribute('style')).toBeNull();
    expect(td?.getAttribute('data-mc-conditions')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    const links = container.querySelectorAll('table a');
    expect(links[0]?.getAttribute('href')).toBeNull();
    expect(links[1]?.getAttribute('href')).toBe('https://example.com/docs');
    const img = container.querySelector('table img');
    expect(img?.getAttribute('src')).toBeNull();
    expect(img?.getAttribute('onerror')).toBeNull();
  });

  it('strips fused 1..N line-number gutters and non-breaking spaces from code blocks while preserving normal lines', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const md = [
      'Copy',
      '',
      'Example',
      '',
      '```vb',
      '1',
      '2',
      '3',
      '\u00a0\u00a0\u00a0\u00a0Public Sub Test()',
      '\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0Dim x As Integer = 1',
      '\u00a0\u00a0\u00a0\u00a0End Sub',
      '```',
    ].join('\n');

    const { container } = render(<Markdown content={md} />);
    expect(container.textContent).not.toContain('Example');
    const code = container.querySelector('pre code')?.textContent ?? '';
    expect(code).toBe('Public Sub Test()\n    Dim x As Integer = 1\nEnd Sub\n');

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('Public Sub Test()\n    Dim x As Integer = 1\nEnd Sub'),
    );

    const { container: singleOne } = render(<Markdown content={'```\n1\nfoo()\n```'} />);
    expect(singleOne.querySelector('pre code')?.textContent).toBe('1\nfoo()\n');

    const { container: nonSeq } = render(<Markdown content={'```\n1\n3\nfoo()\n```'} />);
    expect(nonSeq.querySelector('pre code')?.textContent).toBe('1\n3\nfoo()\n');
  });
});



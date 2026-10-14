import { describe, expect, it } from 'vitest';
import {
  formatChunkBlocks,
  parseChunkBlocks,
  SHOWN_ABOVE,
  type ChunkHitInput,
} from '../src/main/agent/chunkBlocks';

const CHUNK_A = '8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071';
const DOC_A = '11111111-2222-4333-8444-555555555555';
const CHUNK_B = '2c3d4e5f-1122-4333-8444-666666666666';
const DOC_B = '99999999-8888-4777-8666-555555555555';

function chunk(
  id: string | null,
  docId: string | null,
  body: string,
  headingPath: string[],
  title: string,
  kind: string,
  score: number,
): ChunkHitInput {
  return {
    id,
    documentId: docId,
    text: body,
    headingPath,
    documentTitle: title,
    kind,
    score,
  };
}

function chunkA(body: string): ChunkHitInput {
  return chunk(CHUNK_A, DOC_A, body, ['Install', 'Prerequisites'], 'install-kit.md', 'manual', 0.87);
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    n++;
  }
  return n;
}

describe('ChunkBlocks', () => {
  it('a repeated chunk keeps its ranked slot and header but loses its body', () => {
    const seen = new Set<string>();
    const body = 'Install the kit first.';

    const first = formatChunkBlocks([chunkA(body)], seen);
    const second = formatChunkBlocks([chunkA(body)], seen);

    expect(first).toContain(body);
    expect(second).toContain(`### manual/install-kit.md  (score=0.870  id=${CHUNK_A}  doc_id=${DOC_A})`);
    expect(second).toContain('> Install > Prerequisites');
    expect(second).toContain('already shown above');
    expect(second).not.toContain(body);
  });

  it('the same chunk twice in one result set is rendered in full only once', () => {
    const seen = new Set<string>();
    const body = 'Install the kit first.';

    const out = formatChunkBlocks([chunkA(body), chunkA(body)], seen);

    expect(countOf(out, `id=${CHUNK_A}`)).toBe(2);
    expect(countOf(out, body)).toBe(1);
    expect(countOf(out, 'already shown above')).toBe(1);
  });

  it('a chunk with no id is always rendered in full', () => {
    const seen = new Set<string>();

    const out = formatChunkBlocks(
      [
        chunk(null, null, 'First body.', [], '?', '?', 0.1),
        chunk(null, null, 'Second body.', [], '?', '?', 0.1),
      ],
      seen,
    );

    expect(out).toContain('First body.');
    expect(out).toContain('Second body.');
    expect(out).not.toContain('already shown above');
  });

  it('the ledger never spans two conversations', () => {
    const body = 'Install the kit first.';

    const inOne = formatChunkBlocks([chunkA(body)], new Set());
    const inAnother = formatChunkBlocks([chunkA(body)], new Set());

    expect(inOne).toContain(body);
    expect(inAnother).toContain(body);
    expect(inAnother).not.toContain('already shown above');
  });

  it('a marked repeat is recognisable when the render is read back', () => {
    const seen = new Set<string>();
    formatChunkBlocks([chunkA('Install the kit first.')], seen);

    const repeat = formatChunkBlocks([chunkA('Install the kit first.')], seen);
    const block = parseChunkBlocks(repeat).blocks[0];

    expect(block.isShownAboveMarker).toBe(true);
    expect(block.chunkId).toBe(CHUNK_A);
  });

  it('parse recovers every field that format writes and round-trips byte for byte', () => {
    const rendered = formatChunkBlocks([
      chunk(CHUNK_A, DOC_A, 'Install the kit first.', ['Install', 'Prerequisites'], 'install-kit.md', 'manual', 0.87),
      chunk(CHUNK_B, DOC_B, 'The Person table holds identities.', ['Columns'], 'Person', 'table', 0.812),
    ]);

    const parsed = parseChunkBlocks(rendered);

    expect(parsed.blocks).toHaveLength(2);

    const first = parsed.blocks[0];
    expect(first.chunkId).toBe(CHUNK_A);
    expect(first.documentId).toBe(DOC_A);
    expect(first.kind).toBe('manual');
    expect(first.title).toBe('install-kit.md');
    expect(first.headingPath).toBe('Install > Prerequisites');
    expect(first.body).toBe('Install the kit first.');

    const second = parsed.blocks[1];
    expect(second.chunkId).toBe(CHUNK_B);
    expect(second.documentId).toBe(DOC_B);
    expect(second.kind).toBe('table');
    expect(second.title).toBe('Person');
    expect(second.body).toBe('The Person table holds identities.');

    const rebuilt = parsed.preamble + parsed.blocks.map((b) => b.raw).join('') + parsed.suffix;
    expect(rebuilt).toBe(rendered);
  });

  it('a chunk body containing its own markdown headings (including id= tokens) is not split', () => {
    const body = 'Before.\n\n### Configuration\n\nSet the flag.\n\n### Release id=12345678\n\nA table.';
    const rendered = formatChunkBlocks([
      chunk(CHUNK_A, DOC_A, body, ['Reference'], 'ref.md', 'manual', 0.5),
    ]);

    const parsed = parseChunkBlocks(rendered);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].body).toBe(body);
  });

  it('text with no chunk header is all preamble and no blocks', () => {
    const notChunks = 'query_json_objects rows: [from 9.2.2 to 9.3]\n| a | b |\n| --- | --- |';

    const parsed = parseChunkBlocks(notChunks);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.preamble).toBe(notChunks);
    expect(parsed.suffix).toBe('');
  });

  it('a chunk with no id still parses and keeps its text', () => {
    const rendered = formatChunkBlocks([
      chunk(null, null, 'Body with no ids.', [], '?', '?', 0.1),
    ]);

    const parsed = parseChunkBlocks(rendered);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0].chunkId).toBeNull();
    expect(parsed.blocks[0].documentId).toBeNull();
    expect(parsed.blocks[0].body).toBe('Body with no ids.');
  });

  it('a trailing notice is kept as suffix rather than swallowed into the last body', () => {
    const notice = '\n\n_(showing 2 chunks — the result is capped and more may match.)_';
    const rendered =
      formatChunkBlocks([
        chunk(CHUNK_A, DOC_A, 'First.', ['A'], 'a.md', 'manual', 0.9),
        chunk(CHUNK_B, DOC_B, 'Second.', ['B'], 'b.md', 'manual', 0.8),
      ]) + notice;

    const parsed = parseChunkBlocks(rendered);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1].body).toBe('Second.');
    expect(parsed.suffix).toBe(notice);
  });

  it('withBody reproduces the block when handed its own body', () => {
    const rendered = formatChunkBlocks([
      chunk(CHUNK_A, DOC_A, 'Kept whole.', ['Install', 'Prerequisites'], 'install-kit.md', 'manual', 0.87),
    ]);

    const block = parseChunkBlocks(rendered).blocks[0];

    expect(block.withBody(block.body)).toBe(block.raw.trim());
    expect(block.withBody(SHOWN_ABOVE)).toContain(SHOWN_ABOVE);
  });

  it('a manifest line names the chunk without quoting it', () => {
    const rendered = formatChunkBlocks([
      chunk(CHUNK_A, DOC_A, 'Some long body that must not appear.', ['Install', 'Prerequisites'], 'install-kit.md', 'manual', 0.87),
    ]);

    const line = parseChunkBlocks(rendered).blocks[0].manifestLine();

    expect(line).toContain(`chunk_id=${CHUNK_A}`);
    expect(line).toContain('manual/install-kit.md');
    expect(line).toContain('Install > Prerequisites');
    expect(line).not.toContain('Some long body');
  });

  it('a section marker is parsed as a block just like a search header', () => {
    const rendered = [
      '# Section: Installing > Prerequisites',
      '_(document: OIM Admin Guide  ·  tag: 10.0  ·  2 passage(s))_',
      '',
      '_(id=8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071  doc_id=3d9a0000-1111-4222-8333-444455556666)_',
      '###### Prerequisites',
      'First body.',
      '',
      '_(id=1a2b3c4d-5e6f-4071-8899-aabbccddeeff  doc_id=3d9a0000-1111-4222-8333-444455556666)_',
      '###### Next steps',
      'Second body.',
      '',
    ].join('\n');

    const parsed = parseChunkBlocks(rendered);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0].chunkId).toBe('8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071');
    expect(parsed.blocks[0].documentId).toBe('3d9a0000-1111-4222-8333-444455556666');
    expect(parsed.blocks[0].body).toContain('First body.');
    expect(parsed.preamble).toContain('# Section:');
  });

  it('a section render survives parse and re-emission', () => {
    const rendered = [
      '# Section: A',
      '_(document: D  ·  tag: 9.3)_',
      '',
      '_(id=8f7c1a2b-3d4e-4f50-8a1b-2c3d4e5f6071  doc_id=3d9a0000-1111-4222-8333-444455556666)_',
      'Body one.',
      '',
    ].join('\n');

    const parsed = parseChunkBlocks(rendered);
    const rebuilt = parsed.preamble + parsed.blocks.map((b) => b.raw).join('\n\n') + parsed.suffix;

    expect(rebuilt).toBe(rendered);
  });
});

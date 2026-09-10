import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `spec/` is the functional specification: the modular prose documentation this repository keeps,
 * and the thing a person or an agent is told to read before making a substantial change.
 * This test pins the parts of it a machine can actually check.
 *
 * What it deliberately does NOT do is check that the prose is current — nothing can, which is
 * exactly why the exact behaviour contract lives in the rest of the test suite rather than in a
 * document. What it can enforce is the shape the document promises its readers, and that promise
 * carries weight in four ways:
 *
 *  - **The specification directory and README must exist.** It is the only place recording what the
 *    product deliberately does not do, which is invisible in the code by definition, so its loss is silent.
 *  - **Every chapter must carry all four sections in order.** A chapter missing *Limits* or *Not supported*
 *    is not merely thin — those two are where a decision against something is written down, and
 *    omitting them quietly turns "we decided against this" into "nobody considered it".
 *  - **The Contents table must resolve.** It is the document's navigation. A chapter added without an
 *    entry, or an entry whose link or anchor no longer matches, makes that chapter unreachable while
 *    the documentation still looks complete.
 *  - **Chapter numbers must run 1..N without gaps or repeats.**
 */

const SPEC_DIR = resolve(__dirname, '..', 'spec');
const SPEC_README = resolve(SPEC_DIR, 'README.md');

/** The four sections every capability chapter promises. */
const REQUIRED_SECTIONS = ['What you can do', 'How it behaves', 'Limits', 'Not supported'] as const;

/** A numbered capability chapter heading, e.g. `# 3. Multi-agent investigations`. */
const CHAPTER_HEADING = /^# (\d+)\. (.+)$/m;

/** Any second- or third-level heading in README, used to resolve in-document anchors. */
const README_HEADING = /^#{2,3} (.+)$/gm;

/** A markdown link to an in-document anchor, e.g. `[What Yvoke is](#what-yvoke---desktop-is)`. */
const ANCHOR_LINK = /\[[^\]]+\]\(#([a-z0-9-]+)\)/g;

/** A markdown link to a chapter file, e.g. `[Asking questions](01_asking_questions.md)`. */
const CHAPTER_FILE_LINK = /\[[^\]]+\]\((0\d_[a-z0-9_-]+\.md)\)/g;

function githubAnchor(headingText: string): string {
  return headingText
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

function specReadme(): string {
  expect(existsSync(SPEC_README), 'spec/README.md must exist').toBe(true);
  return readFileSync(SPEC_README, 'utf8');
}

interface ChapterFile {
  filename: string;
  fullPath: string;
  number: number;
  title: string;
  content: string;
}

function chapterFiles(): ChapterFile[] {
  expect(existsSync(SPEC_DIR), 'spec/ directory must exist').toBe(true);
  expect(statSync(SPEC_DIR).isDirectory(), 'spec/ must be a directory').toBe(true);

  const files = readdirSync(SPEC_DIR)
    .filter((f) => /^0\d_.+\.md$/.test(f))
    .sort();

  return files.map((f) => {
    const fullPath = resolve(SPEC_DIR, f);
    const content = readFileSync(fullPath, 'utf8');
    const m = content.match(CHAPTER_HEADING);
    expect(m, `${f} must start with '# <N>. <Title>' heading`).not.toBeNull();
    return {
      filename: f,
      fullPath,
      number: Number(m![1]),
      title: m![2].trim(),
      content,
    };
  });
}

/** The Contents table in spec/README.md. */
function contentsTable(readmeText: string): string {
  const start = readmeText.indexOf('## Contents');
  expect(start, 'spec/README.md must have a Contents table').toBeGreaterThanOrEqual(0);
  const end = readmeText.indexOf('\n## What Yvoke - Desktop is');
  expect(end, 'spec/README.md must have "What Yvoke - Desktop is" after Contents').toBeGreaterThan(start);
  return readmeText.slice(start, end);
}

describe('spec/ modular structure', () => {
  it('exists with spec/README.md as a substantial document', () => {
    const readme = specReadme();
    expect(readme.length).toBeGreaterThan(1000);
    expect(readme.startsWith('# ')).toBe(true);
  });

  it('contains at least 8 numbered capability chapters (01_ to 08_)', () => {
    const chapters = chapterFiles();
    expect(chapters.length).toBeGreaterThanOrEqual(8);
  });

  it('numbers its chapters 1..N with no gaps and no repeats', () => {
    const numbers = chapterFiles().map((c) => c.number);
    const expected = Array.from({ length: numbers.length }, (_, i) => i + 1);
    expect(numbers).toEqual(expected);
  });

  it.each(REQUIRED_SECTIONS)('gives every chapter a "## %s" section', (section) => {
    const chapters = chapterFiles();
    const missing = chapters
      .filter((c) => !c.content.includes(`## ${section}`))
      .map((c) => `${c.filename} (${c.number}. ${c.title})`);

    expect(missing, `chapters with no "## ${section}" section`).toEqual([]);
  });

  it('keeps the four sections in the promised order within each chapter', () => {
    const chapters = chapterFiles();
    for (const chapter of chapters) {
      const positions = REQUIRED_SECTIONS.map((s) => chapter.content.indexOf(`## ${s}`));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions, `section order in ${chapter.filename} (${chapter.number}. ${chapter.title})`).toEqual(
        sorted,
      );
    }
  });

  it('resolves every in-document anchor in the Contents table', () => {
    const readme = specReadme();
    const anchors = new Set([...readme.matchAll(README_HEADING)].map((m) => githubAnchor(m[1])));
    const table = contentsTable(readme);
    const linked = [...table.matchAll(ANCHOR_LINK)].map((m) => m[1]);

    expect(linked.length, 'Contents table must have in-document links').toBeGreaterThan(0);
    const dangling = linked.filter((a) => !anchors.has(a));
    expect(dangling, 'Contents links pointing to no heading in README.md').toEqual([]);
  });

  it('resolves every chapter file link in the Contents table', () => {
    const readme = specReadme();
    const table = contentsTable(readme);
    const linkedFiles = [...table.matchAll(CHAPTER_FILE_LINK)].map((m) => m[1]);
    const actualFiles = new Set(chapterFiles().map((c) => c.filename));

    expect(linkedFiles.length, 'Contents table must link to chapter files').toBeGreaterThanOrEqual(8);
    for (const file of linkedFiles) {
      expect(actualFiles.has(file), `Contents links to non-existent chapter file: ${file}`).toBe(true);
    }
  });

  it('lists every capability chapter in the Contents table', () => {
    const readme = specReadme();
    const table = contentsTable(readme);
    const chapters = chapterFiles();
    const unlisted = chapters
      .filter((c) => !table.includes(`(${c.filename})`))
      .map((c) => c.filename);

    expect(unlisted, 'chapter files missing from Contents table in README.md').toEqual([]);
  });

  it('keeps the glossary in spec/README.md', () => {
    expect(specReadme()).toContain('## Words we use');
  });

  it('keeps the architectural overview in spec/README.md', () => {
    expect(specReadme()).toContain('## What Yvoke - Desktop is');
  });

  it('keeps the decisions register in spec/README.md', () => {
    expect(specReadme()).toContain('## Decisions worth taking');
  });

  it('documents credential verification in 05_signing_in.md and 06_settings_and_what_they_change.md', () => {
    const signingIn = readFileSync(resolve(SPEC_DIR, '05_signing_in.md'), 'utf8');
    const settings = readFileSync(resolve(SPEC_DIR, '06_settings_and_what_they_change.md'), 'utf8');

    expect(signingIn).toContain('Verify logins');
    expect(signingIn).toContain('Verifying logins tests the server token silently without launching the browser.');
    expect(signingIn).toContain('Claude verification performs an isolated, single-turn live probe.');
    expect(signingIn).toContain('On macOS, Claude verification reaches keychain credentials.');
    expect(signingIn).toContain('Dev server mode is verified against the server endpoint');
    expect(signingIn).toContain('Check Credentials');

    expect(settings).toContain('on-demand credential verification checkmarks');
    expect(settings).toContain('Verifying credentials in the About pane is on-demand.');

    // Limits are load-bearing: an intentional absence is what no other test can fail on.
    expect(signingIn).toContain('Verifying Claude gives up after 45 seconds');
    expect(signingIn).toContain("Nothing warns in advance when the subscription's allowance runs out.");
    expect(settings).toContain('A verification result describes the settings as they were saved.');
  });
});


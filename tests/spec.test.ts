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

  it('documents on-demand update checking in 06_settings_and_what_they_change.md and 08_installing_updating_and_diagnosing.md', () => {
    const settings = readFileSync(resolve(SPEC_DIR, '06_settings_and_what_they_change.md'), 'utf8');
    const installing = readFileSync(resolve(SPEC_DIR, '08_installing_updating_and_diagnosing.md'), 'utf8');

    expect(settings).toContain('Version, on-demand update check, server address, both sign-in states, and on-demand credential verification checkmarks.');
    expect(settings).toContain('Checking for updates in the About pane is on-demand.');

    expect(installing).toContain('Check for updates');
    expect(installing).toContain('Checking for updates is strictly on-demand.');
    expect(installing).toContain('There is no automatic background update or background notification.');
    expect(installing).toContain('Version comparison requires a three-part numeric semantic version');
    expect(installing).toContain('Automatic background updates, background update notifications, or automatic downloading of new releases.');
  });

  it('documents clarification formatting and single-response turn limit in 01_asking_questions.md', () => {
    const askingQuestions = readFileSync(resolve(SPEC_DIR, '01_asking_questions.md'), 'utf8');
    expect(askingQuestions).toContain(
      "**A user's prompt is displayed exactly as typed.** A question containing code, markdown\n  or a citation-shaped token appears verbatim. Answers and assistant clarifying questions\n  are rendered as formatted text.",
    );
    expect(askingQuestions).toContain(
      '**Multi-question and multi-select clarification tools are not supported as separate interactive steps.**\n  When an assistant call specifies multiple questions or multi-select choices, the questions are\n  presented together in the card, and the user provides a single selection or custom text answer for the turn.',
    );
    expect(askingQuestions).toContain(
      '**Option preview content is not rendered.** While clarification options display labels\n  and descriptions, optional preview attachments (such as code blocks or visual comparisons\n  declared in CLI schemas) are not rendered in the card.',
    );
    expect(askingQuestions).toContain(
      '**Clarifying questions sit chronologically alongside the turn\'s prose in the order they occurred.**\n  In both live and finished turns, clarifying question cards are rendered in block-level chronological order\n  alongside surrounding prose.',
    );
    expect(askingQuestions).toContain(
      '**Failed clarification tool calls fold into the trace rather than rendering as cards.** If a\n  clarification tool call fails (due to schema/input validation errors or execution failure without a valid\n  user answer), it does not render an inline card and never displays a completed *Clarification provided*\n  card with a checkmark. Instead, it is treated as a standard failed tool call in the trace bar (`N failed`).',
    );
    expect(askingQuestions).toContain(
      '*Clarification provided* with the answer, remaining in place alongside the turn\'s prose.',
    );
    expect(askingQuestions).toContain(
      '**Conversations restored from the server show every clarification as answered.** The remote sync\n  payload does not retain tool execution results or error states, storing only that a tool was called.\n  Upon rehydration, all preserved clarification calls are restored with a placeholder result, displaying\n  them as *Clarification provided* regardless of whether the original turn was answered, cancelled, or failed.',
    );
    expect(askingQuestions).toContain(
      "(in a multi-agent conversation, the lead's answer text is held back until the turn finishes)",
    );
  });

  it('documents preflight exclusion of oim-full, shipped defaults, and removes code fallback disagreement', () => {
    const multiAgent = readFileSync(resolve(SPEC_DIR, '03_multi_agent_investigations.md'), 'utf8');
    const settings = readFileSync(resolve(SPEC_DIR, '06_settings_and_what_they_change.md'), 'utf8');

    // spec/03: code fallback disagreement limit removed
    expect(multiAgent).not.toContain("The code's own fallback and the shipped configuration disagree");

    // spec/06: oim-full reason documented in deployment configuration list
    expect(settings).toContain('oim-full');

    // spec/06: shipped defaults documented
    expect(settings).toContain('haiku');
    expect(settings).toContain('high');
  });

  it('documents code-enforced review and live verdicts in 03_multi_agent_investigations.md and removes review toggle from 06_settings_and_what_they_change.md', () => {
    const multiAgent = readFileSync(resolve(SPEC_DIR, '03_multi_agent_investigations.md'), 'utf8');
    const settings = readFileSync(resolve(SPEC_DIR, '06_settings_and_what_they_change.md'), 'utf8');

    // spec/03: "Turn code-enforced review off" removed
    expect(multiAgent).not.toContain('Turn code-enforced review off');

    // spec/03: end-of-turn verdict limit removed
    expect(multiAgent).not.toContain('Verdicts and specialist results appear only when the whole turn ends');

    // spec/03: review is driven by the app in code and cannot be switched off
    expect(multiAgent).toContain('Review is driven by the app in code, and cannot be switched off');
    expect(multiAgent).toContain(
      "the lead's plain-text prose is held back from live streaming",
    );
    expect(multiAgent).toContain(
      "A revision notice places the reviewer's\n  feedback, citation fixes, unsupported claims, and revision instructions ahead of the source evidence",
    );
    expect(multiAgent).toContain(
      'If the lead ends its turn in plain text without submitting its answer, coordination prose is not\n  stripped.',
    );
    expect(multiAgent).not.toContain('NOT APPROVED');
    expect(multiAgent).not.toContain("always reports `reviewer` as the reviewer's playbook name");

    // spec/06: review toggle removed from Agents row
    expect(settings).not.toContain('whether review is enforced in code');
  });

  it('documents creation-time desktop version recording and preservation in 07_what_the_app_tells_the_server.md, 08_installing_updating_and_diagnosing.md, and README.md', () => {
    const serverContract = readFileSync(resolve(SPEC_DIR, '07_what_the_app_tells_the_server.md'), 'utf8');
    const normalizedServerContract = serverContract.replace(/\s+/g, ' ');
    const installing = readFileSync(resolve(SPEC_DIR, '08_installing_updating_and_diagnosing.md'), 'utf8');
    const readme = specReadme();

    // spec/07: records the desktop version verbatim on new conversations and preserves the creation version across later settings updates
    expect(normalizedServerContract).not.toContain(
      'which is what lets the web sidebar, the conversation header, and the admin conversation register tell them apart',
    );
    expect(normalizedServerContract).not.toMatch(/stripp(ing|ed)\b/i);
    expect(normalizedServerContract).not.toMatch(/\bdesktop v(?!ersion\b)/i);
    expect(normalizedServerContract).toContain(
      'and the desktop version that created them, which is what lets the web sidebar mark them as desktop conversations and lets the conversation header and the admin conversation register show which desktop version started each one.',
    );
    expect(normalizedServerContract).toContain(
      'Creating a conversation records the desktop version that created it, and later settings updates preserve that creation version',
    );
    expect(normalizedServerContract).toContain(
      'records its own version verbatim (trimming only surrounding whitespace, and omitting non-text, blank, or over-256-character values)',
    );
    expect(normalizedServerContract).toContain(
      'Beyond the desktop version recorded when a conversation is created, the app tells the server nothing about the client machine.',
    );
    expect(normalizedServerContract).not.toContain('No version, no platform, no build.');
    expect(normalizedServerContract).not.toContain('The app tells the server nothing about itself.');

    // spec/08: no contradiction on version reporting while keeping background update limit intact
    expect(installing).not.toContain('or tells the team which versions are in the field');
    expect(installing).toContain('only new conversations record the desktop version that created them');

    // spec/README.md: row 10 updated
    expect(readme).not.toContain('and the app tells the server nothing about itself either');
    expect(readme).toContain('only new conversations record the desktop version that created them');
  });

  it('documents startup sync recovery, missing-conversation recreation, #201+ local cache preservation, once-per-launch rejected-turn retry, and empty desktop conversation cleanup without stale contradictions', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ');
    const askingQuestions = norm(readFileSync(resolve(SPEC_DIR, '01_asking_questions.md'), 'utf8'));
    const multiAgent = norm(readFileSync(resolve(SPEC_DIR, '03_multi_agent_investigations.md'), 'utf8'));
    const whereConversationsLive = norm(readFileSync(resolve(SPEC_DIR, '04_where_conversations_live.md'), 'utf8'));
    const serverContract = norm(readFileSync(resolve(SPEC_DIR, '07_what_the_app_tells_the_server.md'), 'utf8'));
    const readme = norm(specReadme());

    // Positive capabilities & limits in 04_where_conversations_live.md
    expect(whereConversationsLive).toContain('Undelivered turns resume automatically when the app starts.');
    expect(whereConversationsLive).toContain('without opening a browser sign-in prompt');
    expect(whereConversationsLive).toContain('up to 10,000 messages');
    expect(whereConversationsLive).toContain(
      'A conversation missing on the server is recreated whenever local messages exist.',
    );
    expect(whereConversationsLive).toContain('Deleting a conversation from the web app alone');
    expect(whereConversationsLive).toContain(
      'A turn the server rejects as invalid is set aside for the session and retried once on the next launch.',
    );
    expect(whereConversationsLive).toContain(
      'because the turn stays in the local message log as unsaved on the server, the next app launch attempts it once more',
    );
    expect(whereConversationsLive).toContain('sticky dismissible error banner');
    expect(whereConversationsLive).toContain(
      "Conversations past the server's 200-conversation refresh window stay cached and listed while they still exist on the server.",
    );
    expect(whereConversationsLive).toContain('remain listed, openable, and searchable in the sidebar');
    expect(whereConversationsLive).toContain(
      'Uncached conversations past the 200 most recent on the server do not appear in the sidebar.',
    );
    expect(whereConversationsLive).toContain(
      'Untouched empty desktop conversations are cleaned up once per launch.',
    );
    expect(whereConversationsLive).toContain(
      'Startup comparison inspects at most 10,000 server messages per conversation.',
    );
    expect(whereConversationsLive).toContain(
      'Unsaved local turns stranded earlier than a later server-saved message are skipped.',
    );
    expect(whereConversationsLive).toContain(
      'Aside from the once-per-launch cleanup of untouched, empty desktop-created conversations at least five minutes old, nothing local is ever aged out or deleted automatically.',
    );

    // Negative contradiction guards in 04_where_conversations_live.md
    expect(whereConversationsLive).not.toContain(
      'Past 200 conversations, the oldest are deleted from this machine on every refresh.',
    );
    expect(whereConversationsLive).not.toContain(
      'Conversations past the 200 most recent drop out of the sidebar, even when their local cache is kept.',
    );
    expect(whereConversationsLive).not.toContain(
      'because the turn remains unrecorded in the local message log',
    );
    expect(whereConversationsLive).not.toContain('Undelivered turns are not sent when the app starts.');
    expect(whereConversationsLive).not.toContain(
      'The "waiting to sync" banner counts one conversation, not the backlog',
    );
    expect(whereConversationsLive).not.toContain('A corrupt sync queue is preserved but never delivered.');
    expect(whereConversationsLive).not.toContain(
      '- Any retention policy. Nothing local is ever aged out or deleted automatically.',
    );

    // 01_asking_questions.md & spec/README.md Decision #3 agree on #201+ preservation and empty cleanup
    expect(askingQuestions).toContain(
      'Refresh fetches the 200 most recently updated conversations from the server, while locally cached conversations past 200 stay in the sidebar.',
    );
    expect(askingQuestions).toContain('remain listed, openable, and searchable in the sidebar');
    expect(askingQuestions).toContain(
      'Untouched empty desktop-created conversations at least five minutes old',
    );
    expect(askingQuestions).not.toContain(
      'The sidebar lists the 200 most recently updated conversations, and the rest are deleted from this machine.',
    );
    expect(askingQuestions).not.toContain(
      'The sidebar lists at most the 200 most recently updated conversations.',
    );

    expect(readme).toContain(
      'Past 200 conversations, uncached conversations on the server do not appear in the sidebar, while locally cached ones stay listed with unrefreshed headers.',
    );
    expect(readme).not.toContain(
      'Past 200 conversations, the oldest are silently deleted from the machine on every refresh.',
    );
    expect(readme).not.toContain(
      'older conversations drop out of the sidebar even though cached transcripts stay on disk',
    );

    // 03_multi_agent_investigations.md documents rebuilding multi-agent traces from the local message cache
    expect(multiAgent).toContain(
      'desktop-authored multi-agent traces are rebuilt from the local message cache and uploaded once those turns receive server identifiers',
    );
    expect(multiAgent).not.toContain('A run whose answer the server rejects loses its trace silently');

    // 07_what_the_app_tells_the_server.md documents startup comparison, missing-conversation recreation, once-per-launch retry, and empty cleanup
    expect(serverContract).toContain(
      "Startup compares unsaved local turns against the server's stored messages.",
    );
    expect(serverContract).toContain(
      'Missing server conversations with local messages are recreated in full, preserving their creation desktop version.',
    );
    expect(serverContract).toContain(
      'Turns rejected as invalid are dropped for the session with a dismissible error banner and retried once on the next launch.',
    );
    expect(serverContract).toContain(
      'Confirmed-empty stale desktop conversations are deleted once per launch.',
    );
    expect(serverContract).toContain(
      'The sidebar applies no topic or visibility filter to the 200 most recent conversations the server returns',
    );
    expect(serverContract).toContain('retaining locally cached conversations past 200');
    expect(serverContract).not.toContain('A dropped turn drops its trace.');
    expect(serverContract).not.toContain('Nothing de-duplicates.');
    expect(serverContract).not.toContain(
      "Which conversations the sidebar shows is entirely the server's decision. The app asks for the signed-in user's conversations and lists what comes back; it applies no filter of its own.",
    );

    // Functional-spec purity guard: no internal TypeScript identifiers, endpoints, HTTP status numbers, or .jsonl extensions
    for (const [name, doc] of [
      ['01_asking_questions.md', askingQuestions],
      ['03_multi_agent_investigations.md', multiAgent],
      ['04_where_conversations_live.md', whereConversationsLive],
      ['07_what_the_app_tells_the_server.md', serverContract],
      ['README.md', readme],
    ] as const) {
      expect(
        doc,
        `${name} must remain pure functional specification prose without internal code/HTTP identifiers`,
      ).not.toMatch(
        /\b(AppCore|ThreadStore|SyncClient|SyncQueue|reconcileWithRemote|serverId|localId|desktopVersion|404|4xx)\b|GET \/conversations|\.jsonl\b/,
      );
    }
  });
});


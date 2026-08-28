/**
 * Mermaid diagram sanitizer.
 *
 * LLMs frequently generate slightly invalid Mermaid syntax due to edge-case grammar rules:
 * 1. In sequence diagrams: semicolons (`;`) inside message labels act as statement delimiters,
 *    causing immediate parse errors.
 * 2. In sequence diagrams: arrow operators (`->`, `-->`) in message text confusing the lexer.
 * 3. In flowcharts: unquoted parentheses or semicolons inside node shape labels and subgraph
 *    titles (e.g. `A[Text (Detail)]`, `A[Do this; then that]`).
 * 4. Anywhere: a literal `\n` in a label where `<br/>` was meant.
 *
 * Repairs are STAGED rather than applied all at once, because they are not equally safe. Quoting a
 * label cannot change what the diagram says; rewriting `\n` to `<br/>` can, and does — `C:\new\file`
 * comes out as `C:<br/>ew\file`, and Windows paths are entirely ordinary content in an Identity
 * Manager corpus. The stages let the renderer try the harmless repairs first and only reach for the
 * lossy one when the diagram is still unparseable, where the alternative is no diagram at all.
 */

export interface SanitizeResult {
  sanitized: string;
  isModified: boolean;
  appliedFixes: string[];
}

/**
 * How far one pass may go, in ascending order of how much it can alter what the reader sees.
 * - `syntactic` — quoting only. The rendered text is byte-identical; only the parse changes.
 * - `text`      — substitutes characters inside labels (`;` → `,`, ` -> ` → ` → `). Visible, but
 *                 each replaced character is one the parser cannot accept in that position anyway.
 * - `escapes`   — rewrites a literal `\n` to `<br/>`. Cannot be told apart from a backslash that
 *                 belongs to the content, so it is the last thing tried.
 */
export type RepairLevel = 'syntactic' | 'text' | 'escapes';

const LEVEL_ORDER: RepairLevel[] = ['syntactic', 'text', 'escapes'];

function allows(level: RepairLevel, min: RepairLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(min);
}

/**
 * A flowchart node label that needs quoting: `[...]` holding a parenthesis or a semicolon and no
 * `"` of its own. The `"` exclusion is what leaves an already-quoted label alone.
 */
const FLOWCHART_NODE_LABEL = /(\b[A-Za-z0-9_-]+)\[([^"\]\n]*[();][^"\]\n]*)\]/g;

/** The same, for a subgraph title — `subgraph S1 [Group (one)]` — where a space precedes the `[`. */
const SUBGRAPH_TITLE = /^(\s*subgraph\s+[A-Za-z0-9_-]+\s+)\[([^"\]\n]*[();][^"\]\n]*)\]/i;

export function sanitizeMermaid(chart: string, level: RepairLevel = 'escapes'): SanitizeResult {
  if (!chart || typeof chart !== 'string') {
    return { sanitized: chart, isModified: false, appliedFixes: [] };
  }

  const fixes: string[] = [];
  const lines = chart.split('\n');

  const isSequenceDiagram = lines.some((line) => /^\s*sequenceDiagram\b/i.test(line));
  const isFlowchartOrGraph = lines.some((line) => /^\s*(?:flowchart|graph)\b/i.test(line));

  /** `\n` → `<br/>`, the one lossy repair. Only ever reached at the `escapes` level. */
  const rewriteEscapes = (value: string): string => {
    if (!allows(level, 'escapes') || !value.includes('\\n')) return value;
    fixes.push('Replaced literal \\n with <br/>');
    return value.replace(/\\n/g, '<br/>');
  };

  const sanitizedLines = lines.map((line) => {
    let l = line;

    if (isSequenceDiagram) {
      // Regex for sequence diagram message lines:
      // Examples:
      //   U->>WP: Browse catalog, add item
      //   DB-->>JOB: Confirmation
      //   A -) B: Async message
      //   A--x B: Lost message
      // Matches: prefix (leading whitespace + actor + arrow + actor + colon) and the message body
      const seqMsgMatch = l.match(/^(\s*[A-Za-z0-9_(). -]+?\s*(?:->>|-->>|->|-->|--x|-x|--\)|-\))\s*[A-Za-z0-9_(). -]+?:\s*)(.*)$/);

      if (seqMsgMatch) {
        const prefix = seqMsgMatch[1];
        let msg = seqMsgMatch[2];

        // Fix semicolons inside sequence message label (which terminate the sequence statement)
        if (allows(level, 'text') && msg.includes(';')) {
          msg = msg.replace(/;/g, ',');
          fixes.push('Replaced semicolons with commas in sequence message label');
        }

        // Fix arrow operators within message body (e.g., "Status -> Provisioned")
        if (allows(level, 'text') && /\s(?:->>|-->>|->|-->)\s/.test(msg)) {
          msg = msg.replace(/\s(?:->>|-->>|->|-->)\s/g, ' → ');
          fixes.push('Replaced arrow operator inside label with Unicode arrow');
        }

        msg = rewriteEscapes(msg);

        if (msg !== seqMsgMatch[2]) {
          l = `${prefix}${msg}`;
        }
      } else {
        // Line might be self-reference or general line with a literal \n
        l = rewriteEscapes(l);
      }
    } else if (isFlowchartOrGraph) {
      // In flowcharts, node labels like A[Some text (with parens)] break without double quotes.
      // Convert A[Text (with parens)] -> A["Text (with parens)"]. Quoting is invisible to the
      // reader, so it is the safest repair available and runs at every level.
      if (allows(level, 'syntactic')) {
        // Compare rather than `.test()` first: these are /g regexes, whose `lastIndex` `.test()`
        // advances and `.replace()` does not read — mixing the two is how a stateful-regex bug
        // starts. `.replace()` always scans from the beginning and leaves `lastIndex` at 0.
        const quotedNodes = l.replace(FLOWCHART_NODE_LABEL, '$1["$2"]');
        if (quotedNodes !== l) {
          l = quotedNodes;
          fixes.push('Quoted node label containing parentheses or semicolons');
        }

        const quotedTitle = l.replace(SUBGRAPH_TITLE, '$1["$2"]');
        if (quotedTitle !== l) {
          l = quotedTitle;
          fixes.push('Quoted subgraph title containing parentheses or semicolons');
        }
      }

      l = rewriteEscapes(l);
    }

    return l;
  });

  const sanitized = sanitizedLines.join('\n');
  const isModified = sanitized !== chart;

  return {
    sanitized,
    isModified,
    appliedFixes: Array.from(new Set(fixes)),
  };
}

/**
 * Every distinct repair of `chart`, safest first, for a renderer to try in order. Stages that
 * changed nothing — and stages that produced text an earlier stage already produced, which is the
 * common case since the sequence and flowchart branches are mutually exclusive — are dropped, so a
 * typical broken diagram costs exactly one extra render attempt rather than three.
 */
export function sanitizeMermaidStages(chart: string): SanitizeResult[] {
  const seen = new Set<string>();
  const stages: SanitizeResult[] = [];
  for (const level of LEVEL_ORDER) {
    const result = sanitizeMermaid(chart, level);
    if (!result.isModified || seen.has(result.sanitized)) continue;
    seen.add(result.sanitized);
    stages.push(result);
  }
  return stages;
}

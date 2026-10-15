import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isClarificationTool, MCP_PREFIX_RE, type ToolCallInfo } from '../../shared/types';
import { parseChunkBlocks, SHOWN_ABOVE } from './chunkBlocks';

/**
 * TypeScript port of `yvoke-web`'s `EvidenceDigest.java` + `CitationVerifier.citedIds`, plus
 * specialist tool-result harvesting and safe recovery of tool outputs spilled to disk by the
 * Claude Code CLI.
 */

const BRACKET_PATTERN = /\[([^\]]+)\]/g;
const NUMERIC_REF_PATTERN = /^\d{1,2}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_NO_HYPHENS_PATTERN = /^[0-9a-fA-F]{32}$/;
const ID_PREFIX_PATTERN = /^[0-9a-fA-F]{8,31}$/;

function isValidUuid(value: string | null | undefined): boolean {
  if (!value) return false;
  const clean = value.trim();
  return UUID_PATTERN.test(clean) || UUID_NO_HYPHENS_PATTERN.test(clean);
}

function isIdPrefix(value: string | null | undefined): boolean {
  if (!value) return false;
  return ID_PREFIX_PATTERN.test(value.trim().replace(/-/g, ''));
}

type CitationKind = 'chunk' | 'document' | 'id' | 'numref' | 'unknown';

interface SingleCitation {
  kind: CitationKind;
  value: string;
}

function parseSingleCitation(s: string): SingleCitation {
  if (NUMERIC_REF_PATTERN.test(s)) {
    return { kind: 'numref', value: s };
  }
  const low = s.toLowerCase();
  if (low.startsWith('chunk_id=')) {
    return { kind: 'chunk', value: s.slice(9).trim() };
  }
  if (low.startsWith('document_id=')) {
    return { kind: 'document', value: s.slice(12).trim() };
  }
  const frag = s.replace(/-/g, '');
  if (UUID_NO_HYPHENS_PATTERN.test(frag)) {
    return { kind: 'id', value: frag };
  }
  return { kind: 'unknown', value: s };
}

function collectPrefix(item: SingleCitation, prefixes: Set<string>): void {
  if (item.kind !== 'chunk' && item.kind !== 'document' && item.kind !== 'id') {
    return;
  }
  const clean = item.value.trim().replace(/-/g, '').toLowerCase();
  // Short 8-31 char hex prefixes are ONLY accepted when preceded by chunk_id= or document_id=
  // (which parseSingleCitation classifies as 'chunk' or 'document'). Bare 8-char hex words like
  // [feedback] or [deadbeef] have kind 'unknown' and never reach here.
  if (isIdPrefix(clean) || isValidUuid(clean)) {
    prefixes.add(clean);
  }
}

export class CitedIds {
  private readonly prefixes: ReadonlySet<string>;

  constructor(prefixes: Iterable<string>) {
    this.prefixes = new Set(prefixes);
  }

  /** Whether the answer cited this row — by full id, or by any resolvable prefix of it. */
  covers(id: string | null | undefined): boolean {
    if (!id || this.prefixes.size === 0) {
      return false;
    }
    const full = id.replace(/-/g, '').toLowerCase();
    for (const prefix of this.prefixes) {
      if (full.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  isEmpty(): boolean {
    return this.prefixes.size === 0;
  }
}

/**
 * Every corpus id `text` cites. Scans the WHOLE text, not just a `## References` section, and
 * mirrors `CitationVerifier.citedIds` in `yvoke-web`.
 */
export function citedIds(text: string | null | undefined): CitedIds {
  const prefixes = new Set<string>();
  if (!text || !text.trim()) {
    return new CitedIds(prefixes);
  }
  for (const match of text.matchAll(BRACKET_PATTERN)) {
    const inner = match[1].trim();
    if (inner.includes(',')) {
      for (const part of inner.split(',')) {
        collectPrefix(parseSingleCitation(part.trim()), prefixes);
      }
    } else {
      collectPrefix(parseSingleCitation(inner), prefixes);
    }
  }
  return new CitedIds(prefixes);
}

/**
 * What a resumed reviewer agent has already been handed, so a follow-up carries only what is new.
 */
export class SentLedger {
  readonly chunks = new Set<string>();
  private readonly other = new Set<string>();

  /** True the first time this chunk is sent to its agent, and records it. */
  send(chunkId: string): boolean {
    const key = chunkId.toLowerCase();
    if (this.chunks.has(key)) return false;
    this.chunks.add(key);
    return true;
  }

  /** True the first time this non-chunk entry is sent to its agent, and records it. */
  sendEntry(entry: string): boolean {
    if (this.other.has(entry)) return false;
    this.other.add(entry);
    return true;
  }

  alreadySent(chunkId: string): boolean {
    return this.chunks.has(chunkId.toLowerCase());
  }
}

/**
 * The reviser's view: one copy of each chunk body, everything else untouched.
 */
export function deduped(evidence: readonly string[]): string {
  return renderDigest(evidence, null, null);
}

/**
 * The reviewer's view: the text of every source `answer` cites, and nothing else.
 * Falls back to `deduped` when `answer` has no resolvable citation.
 */
export function citeScoped(
  evidence: readonly string[],
  answer: string,
  sent?: SentLedger | null,
): string {
  const cited = citedIds(answer);
  return renderDigest(evidence, cited.isEmpty() ? null : cited, sent ?? null);
}

function fullBodies(evidence: readonly string[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const entry of evidence) {
    for (const block of parseChunkBlocks(entry).blocks) {
      if (block.chunkId !== null && !block.isShownAboveMarker) {
        const key = block.chunkId.toLowerCase();
        if (!bodies.has(key)) {
          bodies.set(key, block.body);
        }
      }
    }
  }
  return bodies;
}

function renderDigest(
  evidence: readonly string[],
  cited: CitedIds | null,
  sent: SentLedger | null,
): string {
  if (!evidence || evidence.length === 0) {
    return '';
  }

  const bodies = fullBodies(evidence);
  const sentEarlier = sent === null ? new Set<string>() : new Set<string>(sent.chunks);
  const emitted = new Set<string>();
  const out: string[] = [];

  for (const entry of evidence) {
    const parsed = parseChunkBlocks(entry);
    if (parsed.blocks.length === 0) {
      if (sent === null || sent.sendEntry(entry)) {
        out.push(entry);
      }
      continue;
    }

    const rendered: string[] = [];
    for (const block of parsed.blocks) {
      const id = block.chunkId ? block.chunkId.toLowerCase() : null;
      const indexed = id !== null ? bodies.get(id) : block.body;
      const haveText = indexed !== undefined && indexed !== SHOWN_ABOVE;
      const keep =
        cited === null || cited.covers(id) || cited.covers(block.documentId);

      if (!keep || (id !== null && !haveText && cited !== null)) {
        continue;
      }
      if (id !== null && sentEarlier.has(id)) {
        continue;
      }
      if (id !== null && emitted.has(id)) {
        rendered.push(block.withBody(SHOWN_ABOVE));
        continue;
      }
      if (id !== null) {
        emitted.add(id);
        if (sent !== null) {
          sent.send(id);
        }
      }
      rendered.push(block.withBody(haveText && indexed !== undefined ? indexed : block.body));
    }

    if (rendered.length === 0) {
      continue;
    }
    out.push(parsed.preamble + rendered.join('\n\n') + parsed.suffix);
  }

  return out.join('\n\n');
}

const SPILL_PATH_REGEX = /(?:Full output saved to|were saved to):\s*([^\r\n]+)/;

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Resolves a tool result that the Claude Code CLI spilled to disk (`<persisted-output>...`).
 *
 * Security invariants (`.agents/AGENTS.md` § 2):
 * 1. Only inspects strings that start with `<persisted-output>` (after leading whitespace), so a
 *    `<persisted-output>` marker embedded inside an untrusted corpus chunk is never acted on.
 * 2. Refuses dotfiles (e.g. `.credentials.json`) and symlinks (`lstatSync().isSymbolicLink()`).
 * 3. Verifies via `fs.realpathSync` that the target file sits strictly inside `os.tmpdir()`,
 *    `~/.claude/projects`, or an explicit caller-supplied sandbox directory — never `~/.claude` root.
 */
export function resolveSpilledToolResult(
  raw: string,
  extraAllowedDirs: readonly string[] = [],
): string {
  if (!raw || !raw.trimStart().startsWith('<persisted-output>')) {
    return raw;
  }
  const match = SPILL_PATH_REGEX.exec(raw);
  if (!match) {
    return raw;
  }
  const candidatePath = match[1].trim();
  if (!candidatePath || path.basename(candidatePath).startsWith('.')) {
    return raw;
  }

  try {
    const stat = fs.lstatSync(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return raw;
    }
    const realFile = safeRealpath(candidatePath);
    if (!realFile || path.basename(realFile).startsWith('.')) {
      return raw;
    }

    const allowedRoots = [
      os.tmpdir(),
      path.join(os.homedir(), '.claude', 'projects'),
      ...extraAllowedDirs,
    ]
      .map(safeRealpath)
      .filter((r): r is string => r !== null);

    const isInsideAllowedRoot = allowedRoots.some(
      (root) => realFile.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`),
    );
    if (!isInsideAllowedRoot) {
      return raw;
    }

    const content = fs.readFileSync(realFile, 'utf8');
    if (realFile.endsWith('.json') || content.trimStart().startsWith('[')) {
      try {
        const parsed = JSON.parse(content) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              (item as { type?: unknown }).type === 'text' &&
              typeof (item as { text?: unknown }).text === 'string',
          )
        ) {
          return parsed.map((item) => (item as { text: string }).text).join('\n');
        }
      } catch {
        // Fall through to raw file content if not valid JSON block array.
      }
    }
    return content;
  } catch {
    return raw;
  }
}

function shortToolName(name: string): string {
  return name.replace(MCP_PREFIX_RE, '');
}

/**
 * Harvests raw tool outputs from specialist delegations in `toolCalls`, formatted as
 * `[<specialist> · <tool>]\n<content>` to match `OrchestrationService.collectEvidence` on web.
 */
export function harvestSpecialistEvidence(
  toolCalls: readonly ToolCallInfo[],
  extraAllowedDirs: readonly string[] = [],
): string[] {
  const harvested: string[] = [];
  for (const call of toolCalls) {
    if (
      (call.name !== 'Agent' && call.name !== 'Task') ||
      !call.subagentType ||
      call.subagentType === 'reviewer'
    ) {
      continue;
    }
    for (const block of call.subagentBlocks ?? []) {
      for (const inner of block.toolCalls ?? []) {
        if (isClarificationTool(inner.name)) {
          continue;
        }
        if (typeof inner.result !== 'string' || !inner.result.trim()) {
          continue;
        }
        const resolved = resolveSpilledToolResult(inner.result, extraAllowedDirs);
        harvested.push(`[${call.subagentType} · ${shortToolName(inner.name)}]\n${resolved}`);
      }
    }
  }
  return harvested;
}

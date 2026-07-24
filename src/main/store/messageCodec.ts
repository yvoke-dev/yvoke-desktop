import { randomUUID } from 'node:crypto';
import type { MessageBlock, ToolCallInfo } from '../../shared/types';

/**
 * Encode/decode for the marker format used to round-trip an assistant turn's thinking and
 * tool calls through the server's single `content` string field:
 *   `<think>…</think>` for reasoning, `🔧 *Calling tool:* name(<JSON>)` for a tool call.
 * Extracted from AppCore so the (fiddly, regex-heavy) logic is pure and unit-testable.
 */

/** Serialize an assistant message to the marker-annotated `content` string synced to the server. */
export function serializeAssistantContent(
  assistant: { content: string; thinking?: string; toolCalls?: ToolCallInfo[]; blocks?: MessageBlock[] },
  isOrchestrator: boolean,
): string {
  // Orchestrator turns sync the clean composed answer; the full multi-agent trace (specialists +
  // reviewer) goes to agent_runs/agent_steps instead of being inlined as tool markers.
  if (isOrchestrator && assistant.content.trim()) {
    return assistant.thinking
      ? `<think>\n${assistant.thinking}\n</think>\n\n${assistant.content}`
      : assistant.content;
  }

  let out = '';
  if (assistant.blocks && assistant.blocks.length > 0) {
    for (const block of assistant.blocks) {
      if (block.thinking) out += `<think>\n${block.thinking}\n</think>\n\n`;
      if (block.toolCalls) {
        for (const tc of block.toolCalls) {
          out += `🔧 *Calling tool:* ${tc.name}(${JSON.stringify(tc.input)})\n\n`;
        }
      }
      if (block.text) out += block.text + '\n\n';
    }
    return out.trim();
  }

  if (assistant.thinking) out += `<think>\n${assistant.thinking}\n</think>\n\n`;
  if (assistant.toolCalls) {
    for (const tc of assistant.toolCalls) {
      out += `🔧 *Calling tool:* ${tc.name}(${JSON.stringify(tc.input)})\n\n`;
    }
  }
  out += assistant.content;
  return out;
}

export interface ParsedContent {
  content: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  blocks?: MessageBlock[];
}

/** Parse a stored `content` string back into interleaved text/thinking/tool-call blocks. */
export function parseStoredContent(rawContent: string): ParsedContent {
  const blocks: MessageBlock[] = [];
  let remaining = rawContent;
  let currentText = '';

  const commitText = (): void => {
    if (currentText.trim()) {
      blocks.push({ text: currentText.trim() });
      currentText = '';
    }
  };

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (remaining.length === 0) break;

    const thinkMatch = remaining.match(/^<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      commitText();
      blocks.push({ thinking: thinkMatch[1].trim() });
      remaining = remaining.substring(thinkMatch[0].length);
      continue;
    }

    const toolPrefix = remaining.match(/^🔧 \*?Calling tool:\*? (\w+)\(/);
    if (toolPrefix) {
      commitText();
      const name = toolPrefix[1];
      const argsStart = toolPrefix[0].length; // first char after the opening '('
      // The serialized argument is JSON.stringify(input) and may itself contain ')'. Scan for the
      // balanced closing paren instead of stopping at the first (a non-greedy regex would truncate).
      const closeIdx = findArgsCloseParen(remaining, argsStart);

      let input: unknown = null;
      let consumed = -1;
      if (closeIdx >= 0) {
        try {
          input = JSON.parse(remaining.substring(argsStart, closeIdx));
          consumed = closeIdx + 1;
        } catch {
          // Balanced slice is not valid JSON — fall back to the legacy behavior.
        }
      }
      if (consumed < 0) {
        const legacy = remaining.match(/^🔧 \*?Calling tool:\*? (\w+)\(([\s\S]*?)\)/);
        if (legacy) {
          try {
            input = JSON.parse(legacy[2]);
          } catch {
            input = legacy[2];
          }
          consumed = legacy[0].length;
        }
      }
      if (consumed >= 0) {
        blocks.push({
          toolCalls: [{ id: randomUUID(), name, input, result: 'Completed (details logged locally)' }],
        });
        remaining = remaining.substring(consumed);
        continue;
      }
      // No closing paren anywhere: treat the marker prefix as plain text and keep parsing the
      // rest (guarantees forward progress — no infinite loop).
      currentText += remaining.substring(0, argsStart);
      remaining = remaining.substring(argsStart);
      continue;
    }

    const nextThink = remaining.indexOf('<think>');
    const nextTool = remaining.indexOf('🔧');
    let nextIndex = -1;
    if (nextThink >= 0 && nextTool >= 0) {
      nextIndex = Math.min(nextThink, nextTool);
    } else if (nextThink >= 0) {
      nextIndex = nextThink;
    } else if (nextTool >= 0) {
      nextIndex = nextTool;
    }

    if (nextIndex >= 0) {
      currentText += remaining.substring(0, nextIndex);
      remaining = remaining.substring(nextIndex);
    } else {
      currentText += remaining;
      remaining = '';
    }
  }
  commitText();

  let content = '';
  let thinking = '';
  const toolCalls: ToolCallInfo[] = [];
  for (const b of blocks) {
    if (b.text) content += (content ? '\n\n' : '') + b.text;
    if (b.thinking) thinking += (thinking ? '\n\n' : '') + b.thinking;
    if (b.toolCalls) toolCalls.push(...b.toolCalls);
  }

  return {
    content: content.trim(),
    thinking: thinking.trim() || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    blocks: blocks.length > 0 ? blocks : undefined,
  };
}

/**
 * Index of the balanced closing paren for a tool-marker argument list, scanning from `start`
 * (the first char after '('). Tracks JSON string/escape state and brace/bracket depth so a ')'
 * inside the JSON payload does not terminate early. Returns -1 if unbalanced.
 */
export function findArgsCloseParen(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ')' && depth === 0) {
      return i;
    }
  }
  return -1;
}

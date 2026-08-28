import fs from 'node:fs';
import {
  AbortError,
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { normalizeImageDescription, type ImageAttachment } from '../../shared/types';
import { log, logError } from '../log';
import { claudeBinaryPath, debugEnv } from './AgentService';
import { readSingleReply } from './singleTurn';

/**
 * Attachments reach the agent as real image blocks, but the sync payload is text — the server
 * transcript would otherwise record nothing but a filename. This turns each attachment into one
 * line of prose so a reader of the conversation on the web sees what was actually in the
 * screenshot.
 *
 * Same shape as `PlaybookValidator`: one user turn, no tools, no MCP, no thinking, on the cheapest
 * model, and it never rejects — an image with no description falls back to the bare filename note,
 * which is exactly what shipped before this existed.
 */

export const IMAGE_DESCRIPTOR_SYSTEM_PROMPT =
  'You are an assistant describing screenshots and images for a chat conversation transcript. ' +
  'Provide a concise 1-2 sentence description focusing on the application/tool, key UI elements, ' +
  'visible errors or text, and main visual data so that someone reading the conversation transcript understands what was in the screenshot. ' +
  'Do not use filler phrases like "This image shows". Be direct and descriptive.';

/**
 * Long enough for a small model to look at one screenshot, short enough that a stuck subprocess
 * cannot hold a turn's descriptions open for long. The whole batch runs alongside the agent turn,
 * so this is slack, not latency the user waits on.
 */
export const IMAGE_DESCRIPTION_TIMEOUT_MS = 10_000;

/**
 * Each description is a separate Claude Code subprocess (a whole node runtime), and a message may
 * carry up to `MAX_IMAGE_COUNT` attachments. Describing all of them at once spikes memory for no
 * wall-clock win worth having, so the batch runs two at a time.
 */
export const IMAGE_DESCRIBE_CONCURRENCY = 2;

/**
 * `tools: []` already leaves the model nothing to call — this is the second lock. `allowedTools`
 * deliberately is NOT that lock: it only auto-approves, it does not restrict the tool set.
 */
const DENY_ALL_TOOLS: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `The tool "${toolName}" is not available for image description.`,
});

export interface DescribeImageOptions {
  model?: string;
  sandboxDir: string;
  timeoutMs?: number;
}

/**
 * Describe one attachment in a sentence or two.
 *
 * Never rejects: every failure — transport, rate limit, timeout, empty reply — resolves to the
 * empty string, because a description that cannot be produced must not cost the message its
 * attachment note (or, since this is awaited before the turn is persisted, the turn itself).
 */
export async function describeImage(
  image: ImageAttachment,
  options: DescribeImageOptions,
): Promise<string> {
  if (!image.data || image.data.trim().length === 0) {
    return '';
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? IMAGE_DESCRIPTION_TIMEOUT_MS;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const binary = claudeBinaryPath();

  const sdkOptions: Options = {
    // A bare string replaces the Claude Code preset outright, which is what a captioner wants.
    systemPrompt: IMAGE_DESCRIPTOR_SYSTEM_PROMPT,
    // The actual no-tool lever: `[]` disables every built-in tool.
    tools: [],
    disallowedTools: ['Bash'],
    canUseTool: DENY_ALL_TOOLS,
    // No MCP from anywhere — not from here, not from a stray .mcp.json or user setting.
    mcpServers: {},
    strictMcpConfig: true,
    // No ~/.claude, no project settings, no CLAUDE.md.
    settingSources: [],
    // A throwaway caption has no business leaving a session on disk.
    persistSession: false,
    includePartialMessages: false,
    thinking: { type: 'disabled' },
    effort: 'low',
    // Exactly one assistant turn, which is safe only because there is nothing to call.
    maxTurns: 1,
    // The SDK has no timeout option; this controller is the only lever.
    abortController,
    // Deliberately not the conversation's model: this is a caption, not the answer, and it runs
    // once per attachment per turn.
    model: options.model ?? 'haiku',
    cwd: options.sandboxDir,
    env: debugEnv(),
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
  };

  // The SDK spawns the CLI with `cwd` set to this directory, and a missing one is an ENOENT the
  // SDK reports as "native binary … failed to launch". AgentService creates it too, but only when
  // the first turn starts, which on a fresh profile can be after this call.
  try {
    fs.mkdirSync(options.sandboxDir, { recursive: true });
  } catch {
    /* the spawn then fails and the description fails open below, which is the contract anyway */
  }

  const blocks = [
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType,
        data: image.data,
      },
    },
    {
      type: 'text' as const,
      text: 'Describe this screenshot or image concisely.',
    },
  ];

  async function* singlePrompt(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: blocks,
      },
      parent_tool_use_id: null,
    };
  }

  let q: Query | undefined;
  try {
    // Unlike `PlaybookValidator`, this cannot pass a plain string prompt — image content blocks
    // only go over the streaming input channel. That costs the string form's one guarantee: the
    // SDK no longer closes the subprocess's stdin when the first result lands, so the CLI would
    // sit waiting for a second turn. `readSingleReply` returning at the first result plus the
    // `q.close()` below is what reaps it; neither is optional here.
    q = query({ prompt: singlePrompt(), options: sdkOptions });
    const description = normalizeImageDescription(await readSingleReply(q, 'image description')) ?? '';
    log(
      'agent',
      `image description for "${image.name || image.id}" ` +
        `${description ? `in ${description.length} chars` : 'came back empty'} ` +
        `in ${Date.now() - startedAt}ms`,
    );
    return description;
  } catch (err) {
    const why =
      err instanceof AbortError
        ? `no description within ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    logError(
      'agent',
      `image description for "${image.name || image.id}" failed after ${Date.now() - startedAt}ms — ` +
        `syncing the filename alone: ${why}`,
    );
    return '';
  } finally {
    clearTimeout(timer);
    // Idempotent, and the only thing that reaps the CLI subprocess on the abort path.
    if (q) {
      try {
        q.close();
      } catch {
        /* already torn down */
      }
    }
  }
}

/**
 * Describe every attachment that does not already carry a description, at most
 * `IMAGE_DESCRIBE_CONCURRENCY` at a time.
 *
 * Returns a new array of new attachment objects: the caller's message may already be on screen and
 * in `AgentService`'s hands, so this never writes through to what it was given.
 */
export async function describeImages(
  images: ImageAttachment[],
  options: DescribeImageOptions,
): Promise<ImageAttachment[]> {
  if (!images || images.length === 0) {
    return [];
  }

  const out: ImageAttachment[] = images.slice();
  // Index cursor shared by the workers below — each takes the next undescribed image and no image
  // is taken twice.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= images.length) return;
      const image = images[i];
      const existing = normalizeImageDescription(image.description);
      if (existing) {
        out[i] = { ...image, description: existing };
        continue;
      }
      const description = normalizeImageDescription(await describeImage(image, options));
      out[i] = { ...image, description };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_DESCRIBE_CONCURRENCY, images.length) }, worker),
  );
  return out;
}

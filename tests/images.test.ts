import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, AppSettings, ChatMessage, ImageAttachment, SyncEvent, ThreadMeta } from '../src/shared/types';
import { MAX_IMAGE_DESCRIPTION_LENGTH, normalizeImageDescription } from '../src/shared/types';
import { ThreadStore } from '../src/main/store/ThreadStore';
import {
  AppCore,
  DESCRIPTION_PERSIST_GRACE_MS,
  formatSyncedUserContent,
  validateAndSanitizeImages,
} from '../src/main/AppCore';
import { AgentService } from '../src/main/agent/AgentService';
import {
  describeImage,
  describeImages,
  IMAGE_DESCRIBE_CONCURRENCY,
  IMAGE_DESCRIPTOR_SYSTEM_PROMPT,
} from '../src/main/agent/ImageDescriptor';

interface QueryCall {
  options: any;
  promptMessages: any[];
  /** Set by the mock's `close()` — the only thing that reaps the CLI on the abort path. */
  closed: boolean;
  /** In flight until its result settles; the concurrency test counts these. */
  settled: boolean;
}

const sdkMock = vi.hoisted(() => ({
  queryCalls: [] as any[],
  /**
   * Decides what one `query()` produces. Return a result message to yield it, reject to fail the
   * call, or never settle to leave it hanging (the abort path). Defaults to a canned success.
   */
  handler: null as null | ((call: any) => Promise<unknown>),
  /** Thrown synchronously from `query()` itself, i.e. the SDK failing to spawn at all. */
  throwError: null as Error | null,
  defaultDescription: 'A detailed diagram of cloud architecture.',
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: (params: { prompt: unknown; options: any }) => {
      if (sdkMock.throwError) {
        throw sdkMock.throwError;
      }
      const call = { options: params.options, promptMessages: [] as any[], closed: false, settled: false };
      sdkMock.queryCalls.push(call);

      return {
        [Symbol.asyncIterator]: async function* () {
          if (params.prompt && typeof (params.prompt as any)[Symbol.asyncIterator] === 'function') {
            for await (const msg of params.prompt as AsyncIterable<unknown>) {
              call.promptMessages.push(msg);
            }
          }
          try {
            const result = sdkMock.handler
              ? await sdkMock.handler(call)
              : { type: 'result', subtype: 'success', result: sdkMock.defaultDescription };
            yield result;
          } finally {
            call.settled = true;
          }
        },
        close: () => {
          call.closed = true;
        },
        interrupt: vi.fn(),
      };
    },
  };
});

/** A promise plus its settle functions, for driving the mock's timing from a test. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const successResult = (text: string) => ({ type: 'result', subtype: 'success', result: text });

describe('Image Attachments & Vision Support', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-images-test-'));
    sdkMock.queryCalls = [];
    sdkMock.handler = null;
    sdkMock.throwError = null;
    sdkMock.defaultDescription = 'A detailed diagram of cloud architecture.';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ThreadStore Persistence', () => {
    it('persists and rehydrates ChatMessage with images intact', async () => {
      const store = new ThreadStore(tmpDir);
      const threadId = 'test-thread-img-1';
      store.upsert({
        id: threadId,
        title: 'Image thread',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });

      const sampleImages: ImageAttachment[] = [
        {
          id: 'img-1',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          name: 'screenshot.png',
          size: 68,
        },
        {
          id: 'img-2',
          mediaType: 'image/jpeg',
          data: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
          name: 'photo.jpg',
          size: 120,
        },
      ];

      const userMessage: ChatMessage = {
        localId: 'msg-user-1',
        role: 'user',
        content: 'Look at these diagrams',
        images: sampleImages,
        createdAt: new Date().toISOString(),
      };

      const assistantMessage: ChatMessage = {
        localId: 'msg-asst-1',
        role: 'assistant',
        content: 'I see two images.',
        createdAt: new Date().toISOString(),
      };

      await store.appendMessages(threadId, [userMessage, assistantMessage]);

      const loaded = await store.readMessages(threadId);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].role).toBe('user');
      expect(loaded[0].content).toBe('Look at these diagrams');
      expect(loaded[0].images).toBeDefined();
      expect(loaded[0].images).toHaveLength(2);
      expect(loaded[0].images?.[0]).toEqual(sampleImages[0]);
      expect(loaded[0].images?.[1]).toEqual(sampleImages[1]);
    });

    it('keeps base64 out of the message log, writing blobs beside it', async () => {
      const store = new ThreadStore(tmpDir);
      const threadId = 'test-thread-img-blob';
      store.upsert({
        id: threadId,
        title: 'Blob thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });

      const data = Buffer.from('a'.repeat(4096)).toString('base64');
      await store.appendMessages(threadId, [
        {
          localId: 'm1',
          role: 'user',
          content: 'tiny prose',
          images: [{ id: 'img-1', mediaType: 'image/png', data, name: 'big.png', size: 4096 }],
          createdAt: new Date().toISOString(),
        },
      ]);

      const log = fs.readFileSync(path.join(tmpDir, `${threadId}.jsonl`), 'utf8');
      expect(log).toContain('tiny prose');
      expect(log).not.toContain(data);
      expect(log.length).toBeLessThan(500);

      const blobs = fs.readdirSync(path.join(tmpDir, 'images', threadId));
      expect(blobs).toHaveLength(1);
      expect(blobs[0].endsWith('.png')).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'images', threadId, blobs[0])).toString('base64')).toBe(data);

      // And it comes back whole.
      const loaded = await store.readMessages(threadId);
      expect(loaded[0].images?.[0].data).toBe(data);
    });

    it('reads logs written before the blob split, with data still inline', async () => {
      const store = new ThreadStore(tmpDir);
      const threadId = 'test-thread-img-legacy';
      const data = Buffer.from('legacy bytes').toString('base64');
      fs.writeFileSync(
        path.join(tmpDir, `${threadId}.jsonl`),
        JSON.stringify({
          localId: 'm1',
          role: 'user',
          content: 'old turn',
          images: [{ id: 'img-1', mediaType: 'image/png', data, name: 'old.png' }],
          createdAt: new Date().toISOString(),
        }) + '\n',
      );

      const loaded = await store.readMessages(threadId);
      expect(loaded[0].images?.[0].data).toBe(data);
    });

    it('drops blobs when the thread is deleted', async () => {
      const store = new ThreadStore(tmpDir);
      const threadId = 'test-thread-img-delete';
      store.upsert({
        id: threadId,
        title: 'Doomed thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });
      await store.appendMessages(threadId, [
        {
          localId: 'm1',
          role: 'user',
          content: 'bye',
          images: [{ id: 'img-1', mediaType: 'image/png', data: 'aGVsbG8=' }],
          createdAt: new Date().toISOString(),
        },
      ]);
      const dir = path.join(tmpDir, 'images', threadId);
      expect(fs.readdirSync(dir)).toHaveLength(1);

      store.delete(threadId);
      // delete() queues the removal on the thread's op chain; readMessages joins that chain.
      await store.readMessages(threadId);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('collects orphaned blobs when a server rehydrate replaces the log', async () => {
      const store = new ThreadStore(tmpDir);
      const threadId = 'test-thread-img-gc';
      store.upsert({
        id: threadId,
        title: 'GC thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });
      await store.appendMessages(threadId, [
        {
          localId: 'm1',
          role: 'user',
          content: 'with image',
          images: [{ id: 'img-1', mediaType: 'image/png', data: 'aGVsbG8=' }],
          createdAt: new Date().toISOString(),
        },
      ]);
      expect(fs.readdirSync(path.join(tmpDir, 'images', threadId))).toHaveLength(1);

      await store.replaceMessages(threadId, [
        { localId: 'm1', role: 'user', content: 'with image', createdAt: new Date().toISOString() },
      ]);
      expect(fs.readdirSync(path.join(tmpDir, 'images', threadId))).toHaveLength(0);
    });
  });

  describe('AppCore Validation & Sanitization', () => {
    let appCore: AppCore;
    let syncClientMock: any;
    let agentServiceSendMock: any;

    beforeEach(() => {
      syncClientMock = {
        listConversations: vi.fn().mockResolvedValue([]),
        createConversation: vi.fn().mockResolvedValue({ id: 't1', title: 'New', createdAt: new Date().toISOString() }),
        getSystemPrompt: vi.fn().mockResolvedValue('System prompt content'),
        getOrchestratorProfiles: vi.fn().mockResolvedValue([]),
      };

      appCore = new AppCore({
        userDataDir: tmpDir,
        emitAgentEvent: vi.fn(),
        emitSyncEvent: vi.fn(),
        openBrowser: vi.fn().mockResolvedValue(undefined),
        tokenCache: null,
      });

      // Insert thread
      appCore.threads.upsert({
        id: 'thread-valid-1',
        title: 'Validation Thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });

      agentServiceSendMock = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined);
    });

    afterEach(() => {
      appCore.dispose();
    });

    it('accepts valid images and passes them to agent.sendMessage', async () => {
      const validImages: ImageAttachment[] = [
        {
          id: 'img-1',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          name: 'test.png',
          size: 1024,
        },
      ];

      await appCore.sendMessage({
        threadId: 'thread-valid-1',
        text: 'Explain this screenshot',
        images: validImages,
      });

      expect(agentServiceSendMock).toHaveBeenCalledTimes(1);
      const callArgs = agentServiceSendMock.mock.calls[0];
      expect(callArgs[0].id).toBe('thread-valid-1');
      expect(callArgs[1]).toBe('Explain this screenshot');
      expect(callArgs[2].images).toHaveLength(1);
      expect(callArgs[2].images[0].data).toBe(validImages[0].data);
    });

    it('rejects more than 5 image attachments', async () => {
      const tooMany: ImageAttachment[] = Array.from({ length: 6 }, (_, i) => ({
        id: `img-${i}`,
        mediaType: 'image/png',
        data: 'aGVsbG8=',
        name: `test-${i}.png`,
        size: 100,
      }));

      await expect(
        appCore.sendMessage({
          threadId: 'thread-valid-1',
          text: 'Too many files',
          images: tooMany,
        }),
      ).rejects.toThrow(/Maximum 5 image attachments/i);
    });

    it('rejects images exceeding 5MB', async () => {
      const oversized: ImageAttachment[] = [
        {
          id: 'img-big',
          mediaType: 'image/jpeg',
          data: 'aGVsbG8=',
          name: 'huge.jpg',
          size: 5 * 1024 * 1024 + 1,
        },
      ];

      await expect(
        appCore.sendMessage({
          threadId: 'thread-valid-1',
          text: 'Big file',
          images: oversized,
        }),
      ).rejects.toThrow(/5MB/i);
    });

    it('rejects unsupported image media types', async () => {
      const invalidType: ImageAttachment[] = [
        {
          id: 'img-pdf',
          mediaType: 'application/pdf' as any,
          data: 'aGVsbG8=',
          name: 'doc.pdf',
        },
      ];

      await expect(
        appCore.sendMessage({
          threadId: 'thread-valid-1',
          text: 'PDF upload',
          images: invalidType,
        }),
      ).rejects.toThrow(/Unsupported image type/i);
    });

    it('rejects a batch whose attachments together overflow the request budget', async () => {
      // Four 4MB images: each under the 5MB per-image limit, 16MB together.
      const fourMb = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64');
      const batch: ImageAttachment[] = Array.from({ length: 4 }, (_, i) => ({
        id: `img-${i}`,
        mediaType: 'image/png',
        data: fourMb,
        name: `shot-${i}.png`,
        size: 4 * 1024 * 1024,
      }));

      await expect(
        appCore.sendMessage({ threadId: 'thread-valid-1', text: 'Four big shots', images: batch }),
      ).rejects.toThrow(/total .*over the 15MB limit/i);
    });

    it('rejects attachments with empty base64 data', async () => {
      const emptyData: ImageAttachment[] = [
        {
          id: 'img-empty',
          mediaType: 'image/png',
          data: '   ',
          name: 'empty.png',
        },
      ];

      await expect(
        appCore.sendMessage({
          threadId: 'thread-valid-1',
          text: 'Empty data',
          images: emptyData,
        }),
      ).rejects.toThrow(/non-empty/i);
    });

    it('folds a renderer-supplied description onto one line instead of rejecting it', () => {
      const [img] = validateAndSanitizeImages([
        {
          id: 'img-desc',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          description: '  Login screen.\n\nAn [error] banner.  ',
        },
      ])!;

      expect(img.description).toBe('Login screen. An error banner.');
    });

    it('drops a whitespace-only description', () => {
      const [img] = validateAndSanitizeImages([
        { id: 'img-blank', mediaType: 'image/png', data: 'aGVsbG8=', description: '  \n ' },
      ])!;

      expect(img.description).toBeUndefined();
    });

    it('caps an overlong renderer-supplied description', () => {
      const [img] = validateAndSanitizeImages([
        {
          id: 'img-long',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          description: 'word '.repeat(400),
        },
      ])!;

      expect(img.description!.length).toBeLessThanOrEqual(MAX_IMAGE_DESCRIPTION_LENGTH + 1);
      expect(img.description!.endsWith('\u2026')).toBe(true);
    });
  });

  describe('normalizeImageDescription', () => {
    it('returns undefined for nothing to describe', () => {
      expect(normalizeImageDescription(undefined)).toBeUndefined();
      expect(normalizeImageDescription('')).toBeUndefined();
      expect(normalizeImageDescription('   \n\t ')).toBeUndefined();
    });

    it('leaves a well-formed one-liner alone', () => {
      expect(normalizeImageDescription('A bar chart of monthly revenue.')).toBe(
        'A bar chart of monthly revenue.',
      );
    });

    it('collapses newlines and whitespace runs so the sync format stays one line per image', () => {
      expect(normalizeImageDescription('  Login screen.\n\n  An error banner.\t\tRetry shown. ')).toBe(
        'Login screen. An error banner. Retry shown.',
      );
    });

    it('strips the brackets that delimit an attachment note', () => {
      expect(normalizeImageDescription('A dialog reading [OK] / [Cancel]')).toBe(
        'A dialog reading OK / Cancel',
      );
    });

    it('truncates at a word boundary and marks the cut', () => {
      const flat = normalizeImageDescription('word '.repeat(400))!;
      expect(flat.length).toBeLessThanOrEqual(MAX_IMAGE_DESCRIPTION_LENGTH + 1);
      expect(flat.endsWith('\u2026')).toBe(true);
      expect(flat).not.toMatch(/wor\u2026$/);
    });

    it('truncates mid-word rather than gutting a description with no late word break', () => {
      const flat = normalizeImageDescription('x'.repeat(MAX_IMAGE_DESCRIPTION_LENGTH + 50))!;
      expect(flat).toBe('x'.repeat(MAX_IMAGE_DESCRIPTION_LENGTH) + '\u2026');
    });
  });

  describe('formatSyncedUserContent', () => {
    it('returns original content when images is undefined or empty', () => {
      expect(formatSyncedUserContent('Hello world')).toBe('Hello world');
      expect(formatSyncedUserContent('Hello world', [])).toBe('Hello world');
      expect(formatSyncedUserContent('', [])).toBe('');
    });

    it('formats a single image with name and description', () => {
      const images: ImageAttachment[] = [
        {
          id: '1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          name: 'chart.png',
          description: 'A bar chart of monthly revenue growth.',
        },
      ];
      const result = formatSyncedUserContent('Analyze this chart:', images);
      expect(result).toBe(
        'Analyze this chart:\n\n[Attached Image 1 (chart.png): A bar chart of monthly revenue growth.]',
      );
    });

    it('formats a single image without description and defaults missing name to image.png', () => {
      const images: ImageAttachment[] = [
        {
          id: '1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
        },
      ];
      const result = formatSyncedUserContent('Here is a screenshot', images);
      expect(result).toBe('Here is a screenshot\n\n[Attached Image 1 (image.png)]');
    });

    it('formats multiple images with 1-based indices and mixed metadata', () => {
      const images: ImageAttachment[] = [
        {
          id: '1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          name: 'screen1.png',
          description: 'Login page with error alert.',
        },
        {
          id: '2',
          mediaType: 'image/jpeg',
          data: 'd29ybGQ=',
        },
        {
          id: '3',
          mediaType: 'image/webp',
          data: 'dGVzdA==',
          name: 'dashboard.webp',
        },
      ];
      const result = formatSyncedUserContent('Multiple attachments', images);
      expect(result).toBe(
        'Multiple attachments\n\n' +
          '[Attached Image 1 (screen1.png): Login page with error alert.]\n' +
          '[Attached Image 2 (image.png)]\n' +
          '[Attached Image 3 (dashboard.webp)]',
      );
    });

    it('formats attachments correctly when content is empty', () => {
      const images: ImageAttachment[] = [
        {
          id: '1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          name: 'diagram.png',
          description: 'Entity relationship diagram.',
        },
      ];
      const result = formatSyncedUserContent('', images);
      expect(result).toBe('[Attached Image 1 (diagram.png): Entity relationship diagram.]');
    });
  });

  describe('ImageDescriptor Service', () => {
    const sandbox = () => path.join(tmpDir, 'sandbox');

    it('calls query() with correct options, haiku model, system prompt, and prompt blocks', async () => {
      sdkMock.handler = async () =>
        successResult('A dashboard showing server metrics and CPU usage graphs.');

      const image: ImageAttachment = {
        id: 'img-test-1',
        mediaType: 'image/png',
        data: 'aGVsbG8xMjM=',
        name: 'metrics.png',
      };

      const desc = await describeImage(image, { sandboxDir: sandbox() });

      expect(desc).toBe('A dashboard showing server metrics and CPU usage graphs.');
      expect(sdkMock.queryCalls).toHaveLength(1);

      const call = sdkMock.queryCalls[0];
      expect(call.options.model).toBe('haiku');
      expect(call.options.systemPrompt).toBe(IMAGE_DESCRIPTOR_SYSTEM_PROMPT);
      expect(call.options.tools).toEqual([]);
      expect(call.options.disallowedTools).toEqual(['Bash']);
      expect(call.options.strictMcpConfig).toBe(true);
      expect(call.options.mcpServers).toEqual({});
      expect(call.options.settingSources).toEqual([]);
      expect(call.options.persistSession).toBe(false);
      expect(call.options.thinking).toEqual({ type: 'disabled' });
      expect(call.options.effort).toBe('low');
      expect(call.options.maxTurns).toBe(1);
      expect(call.options.cwd).toBe(sandbox());

      // Verify prompt blocks
      expect(call.promptMessages).toHaveLength(1);
      expect(call.promptMessages[0].type).toBe('user');
      expect(call.promptMessages[0].message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aGVsbG8xMjM=',
          },
        },
        {
          type: 'text',
          text: 'Describe this screenshot or image concisely.',
        },
      ]);
    });

    it('denies any tool the model tries to reach for', async () => {
      sdkMock.handler = async () => successResult('Something.');
      await describeImage(
        { id: 'i', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox() },
      );
      await expect(sdkMock.queryCalls[0].options.canUseTool('Read', {})).resolves.toMatchObject({
        behavior: 'deny',
      });
    });

    it('creates the sandbox directory the SDK spawns the CLI in', async () => {
      const dir = path.join(tmpDir, 'not-yet', 'sandbox');
      expect(fs.existsSync(dir)).toBe(false);
      sdkMock.handler = async () => successResult('Something.');

      await describeImage({ id: 'i', mediaType: 'image/png', data: 'aGVsbG8=' }, { sandboxDir: dir });

      expect(fs.existsSync(dir)).toBe(true);
    });

    it('honors custom model override when provided', async () => {
      sdkMock.handler = async () => successResult('Described with sonnet.');

      const desc = await describeImage(
        { id: 'img-custom-model', mediaType: 'image/jpeg', data: 'aGVsbG8=' },
        { sandboxDir: sandbox(), model: 'claude-3-5-sonnet' },
      );

      expect(desc).toBe('Described with sonnet.');
      expect(sdkMock.queryCalls[0].options.model).toBe('claude-3-5-sonnet');
    });

    it('returns empty string without calling the model when the image has no data', async () => {
      const desc = await describeImage(
        { id: 'img-empty', mediaType: 'image/png', data: '   ' },
        { sandboxDir: sandbox() },
      );

      expect(desc).toBe('');
      expect(sdkMock.queryCalls).toHaveLength(0);
    });

    it('aborts on the timeout, returns empty, and closes the query to reap the subprocess', async () => {
      // Never settles on its own: the only way out is the timeout firing the abort controller,
      // which is what the real SDK turns into an AbortError mid-iteration.
      sdkMock.handler = (call) =>
        new Promise((_resolve, reject) => {
          call.options.abortController.signal.addEventListener('abort', () =>
            reject(new AbortError('The operation was aborted')),
          );
        });

      const startedAt = Date.now();
      const desc = await describeImage(
        { id: 'img-timeout', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox(), timeoutMs: 30 },
      );

      expect(desc).toBe('');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
      expect(sdkMock.queryCalls[0].options.abortController.signal.aborted).toBe(true);
      expect(sdkMock.queryCalls[0].closed).toBe(true);
    });

    it('closes the query on the success path too', async () => {
      sdkMock.handler = async () => successResult('Fine.');
      await describeImage({ id: 'i', mediaType: 'image/png', data: 'aGVsbG8=' }, { sandboxDir: sandbox() });
      expect(sdkMock.queryCalls[0].closed).toBe(true);
    });

    it('returns empty string on a non-success result without throwing', async () => {
      sdkMock.handler = async () => ({ type: 'result', subtype: 'error', errors: ['Overloaded'] });

      const desc = await describeImage(
        { id: 'img-err', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox() },
      );

      expect(desc).toBe('');
    });

    it('returns empty string when the SDK fails to spawn at all', async () => {
      sdkMock.throwError = new Error('native binary failed to launch');

      const desc = await describeImage(
        { id: 'img-spawn', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox() },
      );

      expect(desc).toBe('');
    });

    it('folds a multi-line reply onto the single line the sync format assumes', async () => {
      sdkMock.handler = async () =>
        successResult('  Login screen.\n\nAn [error] banner reads "invalid token".\t ');

      const desc = await describeImage(
        { id: 'img-multiline', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox() },
      );

      expect(desc).toBe('Login screen. An error banner reads "invalid token".');
      expect(desc).not.toContain('\n');
    });

    it('truncates a runaway reply to the description ceiling', async () => {
      sdkMock.handler = async () => successResult('word '.repeat(400));

      const desc = await describeImage(
        { id: 'img-long', mediaType: 'image/png', data: 'aGVsbG8=' },
        { sandboxDir: sandbox() },
      );

      expect(desc.length).toBeLessThanOrEqual(MAX_IMAGE_DESCRIPTION_LENGTH + 1);
      expect(desc.endsWith('…')).toBe(true);
    });

    it('treats a whitespace-only reply as no description at all', async () => {
      sdkMock.handler = async () => successResult('   \n  ');

      const [described] = await describeImages(
        [{ id: 'i1', mediaType: 'image/png', data: 'aGVsbG8=' }],
        { sandboxDir: sandbox() },
      );

      expect(described.description).toBeUndefined();
    });

    it('describeImages processes multiple images and attaches descriptions', async () => {
      const images: ImageAttachment[] = [
        { id: 'i1', mediaType: 'image/png', data: 'aGVsbG8=', name: 'first.png' },
        { id: 'i2', mediaType: 'image/jpeg', data: 'd29ybGQ=', name: 'second.jpg' },
      ];

      const described = await describeImages(images, { sandboxDir: sandbox() });

      expect(described).toHaveLength(2);
      expect(described[0].id).toBe('i1');
      expect(described[0].description).toBe('A detailed diagram of cloud architecture.');
      expect(described[1].id).toBe('i2');
      expect(described[1].description).toBe('A detailed diagram of cloud architecture.');
      expect(sdkMock.queryCalls).toHaveLength(2);
    });

    it('describeImages skips images that already have descriptions', async () => {
      const images: ImageAttachment[] = [
        {
          id: 'i1',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          name: 'already-described.png',
          description: 'Pre-existing description.',
        },
        { id: 'i2', mediaType: 'image/jpeg', data: 'd29ybGQ=', name: 'needs-desc.jpg' },
      ];

      const described = await describeImages(images, { sandboxDir: sandbox() });

      expect(described).toHaveLength(2);
      expect(described[0].description).toBe('Pre-existing description.');
      expect(described[1].description).toBe('A detailed diagram of cloud architecture.');
      // Only the second image should trigger a query call
      expect(sdkMock.queryCalls).toHaveLength(1);
    });

    it('describeImages returns empty array when given empty input', async () => {
      const result = await describeImages([], { sandboxDir: sandbox() });
      expect(result).toEqual([]);
      expect(sdkMock.queryCalls).toHaveLength(0);
    });

    it('never writes through to the attachments it was handed', async () => {
      const images: ImageAttachment[] = [{ id: 'i1', mediaType: 'image/png', data: 'aGVsbG8=' }];
      const snapshot = JSON.parse(JSON.stringify(images));

      const described = await describeImages(images, { sandboxDir: sandbox() });

      expect(images).toEqual(snapshot);
      expect(described).not.toBe(images);
      expect(described[0]).not.toBe(images[0]);
      expect(described[0].description).toBe('A detailed diagram of cloud architecture.');
    });

    it('keeps the other descriptions when one image fails', async () => {
      sdkMock.handler = async (call) => {
        const data = call.promptMessages[0].message.content[0].source.data;
        if (data === 'ZmFpbA==') throw new Error('rate limited');
        return successResult('Fine.');
      };

      const described = await describeImages(
        [
          { id: 'ok-1', mediaType: 'image/png', data: 'aGVsbG8=' },
          { id: 'bad', mediaType: 'image/png', data: 'ZmFpbA==' },
          { id: 'ok-2', mediaType: 'image/png', data: 'd29ybGQ=' },
        ],
        { sandboxDir: sandbox() },
      );

      expect(described.map((i) => i.description)).toEqual(['Fine.', undefined, 'Fine.']);
    });

    it('describes at most IMAGE_DESCRIBE_CONCURRENCY images at a time', async () => {
      let peak = 0;
      const gate = deferred<void>();
      let started = 0;
      sdkMock.handler = async () => {
        started += 1;
        peak = Math.max(peak, sdkMock.queryCalls.filter((c: QueryCall) => !c.settled).length);
        // Hold every call open until all the ones that got a slot have arrived, so the peak is
        // measured against genuinely concurrent work rather than a fast serial run.
        if (started >= IMAGE_DESCRIBE_CONCURRENCY) gate.resolve();
        await gate.promise;
        return successResult('Fine.');
      };

      const images: ImageAttachment[] = Array.from({ length: 5 }, (_, i) => ({
        id: `i${i}`,
        mediaType: 'image/png' as const,
        data: 'aGVsbG8=',
      }));

      const described = await describeImages(images, { sandboxDir: sandbox() });

      expect(described).toHaveLength(5);
      expect(described.every((i) => i.description === 'Fine.')).toBe(true);
      expect(sdkMock.queryCalls).toHaveLength(5);
      expect(peak).toBeLessThanOrEqual(IMAGE_DESCRIBE_CONCURRENCY);
    });
  });

  describe('Sync Payload Serialization & persistTurn Integration', () => {
    /** An AppCore whose agent turn is stubbed out, so only the persist path runs. */
    function harness(threadId: string) {
      const appCore = new AppCore({
        userDataDir: tmpDir,
        emitAgentEvent: vi.fn(),
        emitSyncEvent: vi.fn(),
        openBrowser: vi.fn().mockResolvedValue(undefined),
        tokenCache: null,
      });
      appCore.threads.upsert({
        id: threadId,
        title: 'Sync Thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      });
      const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as never);
      const enqueued: any[] = [];
      vi.spyOn(appCore.syncQueue, 'enqueue').mockImplementation((turn) => {
        enqueued.push(turn);
      });

      /**
       * The real send path: `AppCore.sendMessage` sanitizes the attachments and kicks off their
       * descriptions, then `AgentService` hangs that exact array off the user message, which is
       * what eventually reaches `persistTurn`.
       */
      const send = async (localId: string, content: string, images?: ImageAttachment[]) => {
        await appCore.sendMessage({ threadId, text: content, images });
        const opts = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][2] as { images?: ImageAttachment[] };
        const userMessage: ChatMessage = {
          localId,
          role: 'user',
          content,
          images: opts.images,
          createdAt: new Date().toISOString(),
        };
        const assistantMessage: ChatMessage = {
          localId: `${localId}-a`,
          role: 'assistant',
          content: `Reply to ${localId}`,
          createdAt: new Date().toISOString(),
        };
        (appCore as any).persistTurn(threadId, userMessage, assistantMessage);
        return userMessage;
      };

      return { appCore, send, enqueued };
    }

    const diagram = (): ImageAttachment[] => [
      {
        id: 'img-1',
        mediaType: 'image/png',
        data: 'dmVyeV9sb25nX2Jhc2U2NF9kYXRhX3N0cmluZw==',
        name: 'architecture.png',
      },
    ];

    it('describes images at send time and serializes them in syncQueue without base64 bloat', async () => {
      sdkMock.handler = async () => successResult('High-level cloud infrastructure architecture overview.');
      const { appCore, send, enqueued } = harness('sync-img-thread');

      await send('u1', 'Check the diagram below', diagram());
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));

      const userMsg = enqueued[0].messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).toBe(
        'Check the diagram below\n\n' +
          '[Attached Image 1 (architecture.png): High-level cloud infrastructure architecture overview.]',
      );
      expect(userMsg.content).not.toContain('very_long_base64_data_string');

      // The description is on the locally stored message too, not just the sync payload.
      const stored = await appCore.threads.readMessages('sync-img-thread');
      expect(stored).toHaveLength(2);
      expect(stored[0].images?.[0].description).toBe(
        'High-level cloud infrastructure architecture overview.',
      );

      appCore.dispose();
    });

    it('preserves pre-existing descriptions and does not call the model for them', async () => {
      const { appCore, send, enqueued } = harness('sync-img-thread-existing');

      await send('u2', 'Existing description test', [
        {
          id: 'img-2',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          name: 'existing.png',
          description: 'Manual user-provided description.',
        },
      ]);
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));

      const userMsg = enqueued[0].messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).toContain('[Attached Image 1 (existing.png): Manual user-provided description.]');
      expect(sdkMock.queryCalls).toHaveLength(0);

      appCore.dispose();
    });

    it('keeps turns in order when a slow description is followed by a plain text turn', async () => {
      const gate = deferred<unknown>();
      sdkMock.handler = () => gate.promise as Promise<unknown>;
      const { appCore, send, enqueued } = harness('sync-order-thread');

      await send('u1', 'Turn one with an image', diagram());
      // The image turn cannot have been written yet — its description is still hanging.
      expect(enqueued).toHaveLength(0);

      await send('u2', 'Turn two, no image at all');
      // ...and the text turn behind it must not overtake it, even though it has nothing to wait on.
      await new Promise((r) => setTimeout(r, 20));
      expect(enqueued).toHaveLength(0);

      gate.resolve(successResult('Architecture overview.'));
      await vi.waitFor(() => expect(enqueued).toHaveLength(2));

      expect(enqueued.map((t) => t.localIds[0])).toEqual(['u1', 'u2']);
      const stored = await appCore.threads.readMessages('sync-order-thread');
      expect(stored.map((m) => m.localId)).toEqual(['u1', 'u1-a', 'u2', 'u2-a']);

      appCore.dispose();
    });

    it('does not hold one thread up behind another thread’s slow description', async () => {
      const gate = deferred<unknown>();
      sdkMock.handler = () => gate.promise as Promise<unknown>;
      const slow = harness('sync-slow-thread');
      const fast = harness('sync-fast-thread');

      await slow.send('s1', 'Slow thread with an image', diagram());
      await fast.send('f1', 'Fast thread, text only');

      await vi.waitFor(() => expect(fast.enqueued).toHaveLength(1));
      expect(slow.enqueued).toHaveLength(0);

      gate.resolve(successResult('Architecture overview.'));
      await vi.waitFor(() => expect(slow.enqueued).toHaveLength(1));

      slow.appCore.dispose();
      fast.appCore.dispose();
    });

    it('still persists the turn when every description fails', async () => {
      sdkMock.handler = async () => {
        throw new Error('rate limited');
      };
      const { appCore, send, enqueued } = harness('sync-desc-fail-thread');

      await send('u1', 'Check the diagram below', diagram());
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));

      const userMsg = enqueued[0].messages.find((m: any) => m.role === 'user');
      // Falls back to exactly what shipped before descriptions existed.
      expect(userMsg.content).toBe('Check the diagram below\n\n[Attached Image 1 (architecture.png)]');
      const stored = await appCore.threads.readMessages('sync-desc-fail-thread');
      expect(stored).toHaveLength(2);

      appCore.dispose();
    });

    it('does not mutate the caller’s user message', async () => {
      sdkMock.handler = async () => successResult('Architecture overview.');
      const { appCore, send, enqueued } = harness('sync-nomutate-thread');

      const userMessage = await send('u1', 'Check the diagram below', diagram());
      const images = userMessage.images!;
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));

      // AgentService still holds this object as the session's pendingUser.
      expect(userMessage.images).toBe(images);
      expect(images[0].description).toBeUndefined();

      appCore.dispose();
    });

    it('persists the turn anyway when descriptions outrun the grace period', async () => {
      // Never settles: the grace period is the only way this turn ever reaches disk.
      sdkMock.handler = () => new Promise(() => {});
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { appCore, send, enqueued } = harness('sync-grace-thread');

        await send('u1', 'Check the diagram below', diagram());
        expect(enqueued).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(DESCRIPTION_PERSIST_GRACE_MS + 50);
        await vi.waitFor(() => expect(enqueued).toHaveLength(1));

        const userMsg = enqueued[0].messages.find((m: any) => m.role === 'user');
        expect(userMsg.content).toBe('Check the diagram below\n\n[Attached Image 1 (architecture.png)]');
        const stored = await appCore.threads.readMessages('sync-grace-thread');
        expect(stored).toHaveLength(2);

        appCore.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips description entirely when the setting is off', async () => {
      const { appCore, send, enqueued } = harness('sync-desc-off-thread');
      appCore.settings.set({ imageDescriptionsEnabled: false });

      await send('u1', 'Check the diagram below', diagram());
      await vi.waitFor(() => expect(enqueued).toHaveLength(1));

      expect(sdkMock.queryCalls).toHaveLength(0);
      const userMsg = enqueued[0].messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).toBe('Check the diagram below\n\n[Attached Image 1 (architecture.png)]');

      appCore.dispose();
    });
  });

  describe('AgentService Image Content Block Formation', () => {
    it('pushes image blocks ahead of text to Claude SDK queue', async () => {
      const pushedMessages: any[] = [];
      const fakeQuery = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
      };

      const agent = new AgentService({
        getSettings: () => ({
          serverBaseUrl: 'http://localhost:8080',
          mcpTransport: 'sse',
          serverAuthMode: 'dev',
          entra: { tenantId: '', clientId: '', scope: '' },
          models: ['sonnet'],
          defaultModel: 'sonnet',
          defaultThinkingLevel: 'medium',
          webSearch: { enabled: true, allowedDomains: [] },
          maxTurns: 30,
        }),
        mcpAuthProvider: { headers: () => Promise.resolve({}) },
        emit: vi.fn(),
        onSessionId: vi.fn(),
        onTurnPersist: vi.fn(),
        sandboxDir: path.join(tmpDir, 'sandbox'),
        syncClient: {
          getSystemPrompt: vi.fn().mockResolvedValue('Base system prompt'),
        } as any,
        mcpPrompts: {
          list: vi.fn().mockResolvedValue([]),
        } as any,
        getOrchestratorProfile: vi.fn().mockResolvedValue(undefined),
      });

      const thread: ThreadMeta = {
        id: 't-agent-img-1',
        title: 'Agent Image Thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      };

      // Mock ensureSession
      const fakeSession: any = {
        query: fakeQuery,
        queue: {
          push: (msg: any) => pushedMessages.push(msg),
          close: vi.fn(),
        },
        model: 'sonnet',
        thinkingLevel: 'medium',
        busy: false,
        interrupted: false,
        turn: { threadId: thread.id, isOrchestrator: false, agentCalls: new Map(), toolCalls: [], blocks: [] },
        lastActiveAt: Date.now(),
      };

      (agent as any).sessions.set(thread.id, fakeSession);

      const images: ImageAttachment[] = [
        {
          id: 'i-1',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          name: 'test.png',
        },
      ];

      await agent.sendMessage(thread, 'What is in this image?', { images });

      expect(fakeSession.pendingUser).toBeDefined();
      expect(fakeSession.pendingUser.images).toEqual(images);

      expect(pushedMessages).toHaveLength(1);
      const pushed = pushedMessages[0];
      expect(pushed.type).toBe('user');
      expect(Array.isArray(pushed.message.content)).toBe(true);
      expect(pushed.message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: images[0].data,
          },
        },
        {
          type: 'text',
          text: 'What is in this image?',
        },
      ]);
    });

    it('omits text block when image message text is empty or whitespace', async () => {
      const pushedMessages: any[] = [];
      const fakeQuery = {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
      };

      const agent = new AgentService({
        getSettings: () => ({
          serverBaseUrl: 'http://localhost:8080',
          mcpTransport: 'sse',
          serverAuthMode: 'dev',
          entra: { tenantId: '', clientId: '', scope: '' },
          models: ['sonnet'],
          defaultModel: 'sonnet',
          defaultThinkingLevel: 'medium',
          webSearch: { enabled: true, allowedDomains: [] },
          maxTurns: 30,
        }),
        mcpAuthProvider: { headers: () => Promise.resolve({}) },
        emit: vi.fn(),
        onSessionId: vi.fn(),
        onTurnPersist: vi.fn(),
        sandboxDir: path.join(tmpDir, 'sandbox'),
        syncClient: {
          getSystemPrompt: vi.fn().mockResolvedValue('Base system prompt'),
        } as any,
        mcpPrompts: {
          list: vi.fn().mockResolvedValue([]),
        } as any,
        getOrchestratorProfile: vi.fn().mockResolvedValue(undefined),
      });

      const thread: ThreadMeta = {
        id: 't-agent-img-2',
        title: 'Agent Image Thread Empty Text',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
      };

      const fakeSession: any = {
        query: fakeQuery,
        queue: {
          push: (msg: any) => pushedMessages.push(msg),
          close: vi.fn(),
        },
        model: 'sonnet',
        thinkingLevel: 'medium',
        busy: false,
        interrupted: false,
        turn: { threadId: thread.id, isOrchestrator: false, agentCalls: new Map(), toolCalls: [], blocks: [] },
        lastActiveAt: Date.now(),
      };

      (agent as any).sessions.set(thread.id, fakeSession);

      const images: ImageAttachment[] = [
        {
          id: 'i-2',
          mediaType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          name: 'test2.png',
        },
      ];

      await agent.sendMessage(thread, '   ', { images });

      expect(pushedMessages).toHaveLength(1);
      const pushed = pushedMessages[0];
      expect(pushed.type).toBe('user');
      expect(pushed.message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: images[0].data,
          },
        },
      ]);
    });
  });
});

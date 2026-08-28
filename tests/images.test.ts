import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppSettings, ChatMessage, ImageAttachment, SyncEvent, ThreadMeta } from '../src/shared/types';
import { ThreadStore } from '../src/main/store/ThreadStore';
import { AppCore } from '../src/main/AppCore';
import { AgentService } from '../src/main/agent/AgentService';

describe('Image Attachments & Vision Support', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-images-test-'));
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
  });

  describe('Sync Payload Serialization', () => {
    it('serializes user message with attached image references in syncQueue without base64 bloat', async () => {
      const appCore = new AppCore({
        userDataDir: tmpDir,
        emitAgentEvent: vi.fn(),
        emitSyncEvent: vi.fn(),
        openBrowser: vi.fn().mockResolvedValue(undefined),
        tokenCache: null,
      });

      const threadId = 'sync-img-thread';
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

      const enqueueSpy = vi.spyOn(appCore.syncQueue, 'enqueue').mockImplementation(() => {});

      const userMessage: ChatMessage = {
        localId: 'u1',
        role: 'user',
        content: 'Check the diagram below',
        images: [
          {
            id: 'img-1',
            mediaType: 'image/png',
            data: 'very_long_base64_data_string_that_should_not_be_synced_directly_to_the_rest_api_payload',
            name: 'architecture.png',
            size: 2048,
          },
        ],
        createdAt: new Date().toISOString(),
      };

      const assistantMessage: ChatMessage = {
        localId: 'a1',
        role: 'assistant',
        content: 'Architecture analyzed.',
        createdAt: new Date().toISOString(),
      };

      // Call private persistTurn
      (appCore as any).persistTurn(threadId, userMessage, assistantMessage);

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const enqueued = enqueueSpy.mock.calls[0][0];
      const enqueuedUserMsg = enqueued.messages.find((m: any) => m.role === 'user');
      expect(enqueuedUserMsg).toBeDefined();
      expect(enqueuedUserMsg!.content).toContain('Check the diagram below');
      expect(enqueuedUserMsg!.content).toContain('[Attached Image: architecture.png]');
      expect(enqueuedUserMsg!.content).not.toContain('very_long_base64_data_string');

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

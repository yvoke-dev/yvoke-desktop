import { describe, expect, it } from 'vitest';
import { parseStoredContent } from '../src/main/store/messageCodec';
import type { StoredChatMessage } from '../src/main/store/ThreadStore';
import type { MessageDto } from '../src/main/sync/SyncClient';
import type { QueuedTurn } from '../src/main/sync/SyncQueue';
import {
  buildAllTurnsForRecreation,
  countUnqueuedLocalTurns,
  groupLocalTurns,
  reconcileWithRemote,
  reconstructOrphanThreadMeta,
  toNewMessagePayload,
} from '../src/main/sync/reconcile';

function remoteDto(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  overrides: Partial<MessageDto> = {},
): MessageDto {
  return {
    id,
    role,
    content,
    playbook: null,
    playbookVersion: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cachedTokens: null,
    thoughtTokens: null,
    createdAt: '2026-06-10T10:00:00.000Z',
    feedbackRating: null,
    feedbackComment: null,
    ...overrides,
  };
}

describe('reconcile module (Wave 1)', () => {
  describe('toNewMessagePayload', () => {
    it('builds user and assistant payloads from StoredChatMessage without base64 blob hydration', () => {
      const userMsg: StoredChatMessage = {
        localId: 'u-1',
        role: 'user',
        content: 'Check this screenshot',
        playbook: 'oim-schema',
        playbookVersion: 3,
        createdAt: '2026-06-10T10:00:00Z',
        images: [
          {
            id: 'img-1',
            mediaType: 'image/png',
            file: 'abc.png',
            name: 'error.png',
            description: 'Stack trace showing ORA-00942',
          },
        ],
      };

      const assistantMsg: StoredChatMessage = {
        localId: 'a-1',
        role: 'assistant',
        content: 'The table is missing.',
        thinking: 'Checking schema tables',
        toolCalls: [{ id: 'tc-1', name: 'search_corpus', input: { query: 'ORA-00942' }, result: 'found' }],
        playbook: 'oim-schema',
        playbookVersion: 3,
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          thoughtTokens: 15,
        },
        createdAt: '2026-06-10T10:00:05Z',
      };

      expect(toNewMessagePayload(userMsg, false)).toEqual({
        role: 'user',
        content: 'Check this screenshot\n\n[Attached Image 1 (error.png): Stack trace showing ORA-00942]',
        playbook: 'oim-schema',
        playbookVersion: 3,
      });

      const assistantPayload = toNewMessagePayload(assistantMsg, false);
      expect(assistantPayload).toEqual({
        role: 'assistant',
        content:
          '<think>\nChecking schema tables\n</think>\n\n🔧 *Calling tool:* search_corpus({"query":"ORA-00942"})\n\nThe table is missing.',
        playbook: 'oim-schema',
        playbookVersion: 3,
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        cachedTokens: 30,
        thoughtTokens: 15,
      });

      // Orchestrator mode omits tool markers and keeps <think> + final composed answer
      const orchPayload = toNewMessagePayload(assistantMsg, true);
      expect(orchPayload.content).toBe('<think>\nChecking schema tables\n</think>\n\nThe table is missing.');
    });

    it('round-trips fromDto-rehydrated StoredChatMessages preserving thinking, toolCalls, blocks, playbook, playbookVersion, and usage', () => {
      const originalWire =
        '<think>\nStep 1 reasoning\n</think>\n\n🔧 *Calling tool:* get_section({"id":"uuid-1"})\n\nFinal answer text';
      const parsed = parseStoredContent(originalWire);
      const rehydratedAssistant: StoredChatMessage = {
        localId: 'srv-a-99',
        serverId: 'srv-a-99',
        role: 'assistant',
        content: parsed.content,
        thinking: parsed.thinking,
        toolCalls: parsed.toolCalls,
        blocks: parsed.blocks,
        playbook: 'oim-schema',
        playbookVersion: 2,
        usage: {
          inputTokens: 200,
          outputTokens: 80,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          thoughtTokens: 25,
        },
        createdAt: '2026-06-10T10:01:00Z',
      };

      expect(toNewMessagePayload(rehydratedAssistant, false)).toEqual({
        role: 'assistant',
        content: originalWire,
        playbook: 'oim-schema',
        playbookVersion: 2,
        promptTokens: 200,
        completionTokens: 80,
        totalTokens: 280,
        cachedTokens: 50,
        thoughtTokens: 25,
      });
    });
  });

  describe('reconcileWithRemote', () => {
    it('adopts serverIds for pre-crash committed turns, queues trailing unsynced turns reusing matching QueuedTurn payloads, and merges queueOnlyTurns', () => {
      const localMessages: StoredChatMessage[] = [
        // Turn 1: already synced locally
        { localId: 'u1', serverId: 'srv-1', role: 'user', content: 'Q1', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a1', serverId: 'srv-2', role: 'assistant', content: 'A1', createdAt: '2026-06-10T10:00:01Z' },
        // Turn 2: committed on server before crash, missing serverId locally and still sitting in SyncQueue
        { localId: 'u2', role: 'user', content: 'Q2', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'a2', role: 'assistant', content: 'A2', createdAt: '2026-06-10T10:01:01Z' },
        // Turn 3: trailing unsynced in both .jsonl and SyncQueue
        { localId: 'u3', role: 'user', content: 'Q3', playbook: 'oim-schema', playbookVersion: 2, createdAt: '2026-06-10T10:02:00Z' },
        { localId: 'a3', role: 'assistant', content: 'A3', createdAt: '2026-06-10T10:02:01Z' },
        // Turn 4: trailing unsynced in .jsonl ONLY (absent from SyncQueue)
        { localId: 'u4', role: 'user', content: 'Q4', createdAt: '2026-06-10T10:03:00Z' },
        { localId: 'a4', role: 'assistant', content: 'A4', createdAt: '2026-06-10T10:03:01Z' },
      ];

      const existingTurn3Payload: QueuedTurn = {
        threadId: 't-1',
        localIds: ['u3', 'a3'],
        messages: [
          { role: 'user', content: 'Q3', playbook: 'oim-schema', playbookVersion: 2 },
          { role: 'assistant', content: 'A3-exact-wire' },
        ],
        enqueuedAt: '2026-06-10T10:02:01Z',
        attempts: 1,
      };

      const queueOnlyAlreadyOnServer: QueuedTurn = {
        threadId: 't-1',
        localIds: ['u-qonly-synced', 'a-qonly-synced'],
        messages: [
          { role: 'user', content: 'Q-qonly-synced' },
          { role: 'assistant', content: 'A-qonly-synced' },
        ],
        enqueuedAt: '2026-06-10T10:04:00Z',
        attempts: 1,
      };

      const queueOnlyUnsynced: QueuedTurn = {
        threadId: 't-1',
        localIds: ['u5', 'a5'],
        messages: [
          { role: 'user', content: 'Q5-queue-only' },
          { role: 'assistant', content: 'A5-queue-only' },
        ],
        enqueuedAt: '2026-06-10T10:05:00Z',
        attempts: 0,
      };

      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 't-1',
          localIds: ['u2', 'a2'],
          messages: [
            { role: 'user', content: 'Q2' },
            { role: 'assistant', content: 'A2' },
          ],
          enqueuedAt: '2026-06-10T10:01:01Z',
          attempts: 0,
        },
        existingTurn3Payload,
        queueOnlyAlreadyOnServer,
        queueOnlyUnsynced,
      ];

      const remoteMessages: MessageDto[] = [
        remoteDto('srv-1', 'user', 'Q1'),
        remoteDto('srv-2', 'assistant', 'A1'),
        remoteDto('srv-3', 'user', 'Q2'),
        remoteDto('srv-4', 'assistant', 'A2'),
        remoteDto('srv-5', 'user', 'Q-qonly-synced'),
        remoteDto('srv-6', 'assistant', 'A-qonly-synced'),
      ];

      const result = reconcileWithRemote({
        threadId: 't-1',
        localMessages,
        queuedTurns,
        remoteMessages,
        isOrchestrator: false,
      });

      expect(result.adoptedServerIds).toEqual({
        u2: 'srv-3',
        a2: 'srv-4',
        'u-qonly-synced': 'srv-5',
        'a-qonly-synced': 'srv-6',
      });
      expect(result.skippedMidThreadTurns).toBe(0);
      expect(result.turnsToQueue.map((t) => t.localIds)).toEqual([
        ['u3', 'a3'],
        ['u4', 'a4'],
        ['u5', 'a5'],
      ]);
      // Reused existing QueuedTurn payload for ['u3', 'a3']
      expect(result.turnsToQueue[0].messages[1].content).toBe('A3-exact-wire');
    });

    it('advances i += 2 atomically on partial [user, assistant] mismatch so the assistant half NEVER singleton-matches a later remote message', () => {
      // Suppose local has an unsynced pair [u1: "Run sync", a1: "Done."] that NEVER reached the server,
      // while the server has a web-entered pair ["Different question", "Done."].
      // If a1 fell through to singleton matching, a1 would falsely claim 'srv-web-a', making a1 look
      // synced at index 1 and stranding u1 at index 0 as a skipped mid-thread gap!
      const localMessages: StoredChatMessage[] = [
        { localId: 'u1', role: 'user', content: 'Run sync', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a1', role: 'assistant', content: 'Done.', createdAt: '2026-06-10T10:00:01Z' },
      ];
      const remoteMessages: MessageDto[] = [
        remoteDto('srv-web-u', 'user', 'Different question'),
        remoteDto('srv-web-a', 'assistant', 'Done.'),
      ];

      const result = reconcileWithRemote({
        threadId: 't-atomic',
        localMessages,
        queuedTurns: [],
        remoteMessages,
        isOrchestrator: false,
      });

      expect(result.adoptedServerIds).toEqual({});
      expect(result.skippedMidThreadTurns).toBe(0);
      expect(result.turnsToQueue).toHaveLength(1);
      expect(result.turnsToQueue[0].localIds).toEqual(['u1', 'a1']);
    });

    it('skips stranded mid-thread gaps before a later synced turn and only queues trailing turns (index > lastSyncedLocalIndex)', () => {
      const localMessages: StoredChatMessage[] = [
        // Stranded mid-thread gap (never reached server)
        { localId: 'u-gap', role: 'user', content: 'Retry', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a-gap', role: 'assistant', content: 'Temp failure', createdAt: '2026-06-10T10:00:01Z' },
        // Later synced anchor turn
        { localId: 'u-sync', serverId: 'srv-10', role: 'user', content: 'Anchor Q', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'a-sync', serverId: 'srv-11', role: 'assistant', content: 'Anchor A', createdAt: '2026-06-10T10:01:01Z' },
        // Trailing turn committed pre-crash with same text as gap (must match Turn 3, NOT be stolen by gap!)
        { localId: 'u-precrash', role: 'user', content: 'Retry', createdAt: '2026-06-10T10:02:00Z' },
        { localId: 'a-precrash', role: 'assistant', content: 'Temp failure', createdAt: '2026-06-10T10:02:01Z' },
        // Genuine trailing unsynced turn after pre-crash turn
        { localId: 'u-trail', role: 'user', content: 'Final Q', createdAt: '2026-06-10T10:03:00Z' },
        { localId: 'a-trail', role: 'assistant', content: 'Final A', createdAt: '2026-06-10T10:03:01Z' },
      ];

      const remoteMessages: MessageDto[] = [
        remoteDto('srv-10', 'user', 'Anchor Q'),
        remoteDto('srv-11', 'assistant', 'Anchor A'),
        remoteDto('srv-12', 'user', 'Retry'),
        remoteDto('srv-13', 'assistant', 'Temp failure'),
      ];

      const result = reconcileWithRemote({
        threadId: 't-gap',
        localMessages,
        queuedTurns: [],
        remoteMessages,
        isOrchestrator: false,
      });

      expect(result.adoptedServerIds).toEqual({
        'u-precrash': 'srv-12',
        'a-precrash': 'srv-13',
      });
      expect(result.skippedMidThreadTurns).toBe(1);
      expect(result.skippedMidThreadLocalIds).toEqual(['u-gap', 'a-gap']);
      expect(result.turnsToQueue.map((t) => t.localIds)).toEqual([['u-trail', 'a-trail']]);
    });

    it('respects truncated: true (>10,000 messages) by skipping .jsonl synthesis and keeping only unmatched SyncQueue turns', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u-10001', role: 'user', content: 'May already be on page 21', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a-10001', role: 'assistant', content: 'Answer 10001', createdAt: '2026-06-10T10:00:01Z' },
      ];
      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 't-trunc',
          localIds: ['u-explicit', 'a-explicit'],
          messages: [
            { role: 'user', content: 'Explicitly queued' },
            { role: 'assistant', content: 'Explicitly queued answer' },
          ],
          enqueuedAt: '2026-06-10T10:05:00Z',
          attempts: 0,
        },
      ];

      const result = reconcileWithRemote({
        threadId: 't-trunc',
        localMessages,
        queuedTurns,
        remoteMessages: [remoteDto('srv-1', 'user', 'Old page 1 msg')],
        isOrchestrator: false,
        truncated: true,
      });

      expect(result.turnsToQueue.map((t) => t.localIds)).toEqual([['u-explicit', 'a-explicit']]);
    });

    it('suppresses turns whose localIds were already dropped in the current session (droppedLocalIds)', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u-drop', role: 'user', content: 'Bad turn', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a-drop', role: 'assistant', content: 'Bad answer', createdAt: '2026-06-10T10:00:01Z' },
        { localId: 'u-ok', role: 'user', content: 'Good turn', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'a-ok', role: 'assistant', content: 'Good answer', createdAt: '2026-06-10T10:01:01Z' },
      ];

      const result = reconcileWithRemote({
        threadId: 't-drop',
        localMessages,
        queuedTurns: [],
        remoteMessages: [],
        isOrchestrator: false,
        droppedLocalIds: new Set(['u-drop', 'a-drop']),
      });

      expect(result.turnsToQueue.map((t) => t.localIds)).toEqual([['u-ok', 'a-ok']]);
    });

    it('treats partially overlapping QueuedTurn (u1 in .jsonl, a1 truncated) as authoritative atomic turn when already server-committed (200 OK)', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u0', serverId: 'srv-0u', role: 'user', content: 'Q0', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a0', serverId: 'srv-0a', role: 'assistant', content: 'A0', createdAt: '2026-06-10T10:00:01Z' },
        // Crash truncated .jsonl after u1, before a1 was written
        { localId: 'u1', role: 'user', content: 'Q1-partial', createdAt: '2026-06-10T10:01:00Z' },
      ];
      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 't-partial-synced',
          localIds: ['u1', 'a1'],
          messages: [
            { role: 'user', content: 'Q1-partial' },
            { role: 'assistant', content: 'A1-from-queue' },
          ],
          enqueuedAt: '2026-06-10T10:01:02Z',
          attempts: 1,
        },
      ];
      const remoteMessages: MessageDto[] = [
        remoteDto('srv-0u', 'user', 'Q0'),
        remoteDto('srv-0a', 'assistant', 'A0'),
        remoteDto('srv-1u', 'user', 'Q1-partial'),
        remoteDto('srv-1a', 'assistant', 'A1-from-queue'),
      ];

      const result = reconcileWithRemote({
        threadId: 't-partial-synced',
        localMessages,
        queuedTurns,
        remoteMessages,
        isOrchestrator: false,
      });

      expect(result.adoptedServerIds).toEqual({
        u1: 'srv-1u',
        a1: 'srv-1a',
      });
      expect(result.turnsToQueue).toEqual([]);
      expect(result.skippedMidThreadTurns).toBe(0);
    });

    it('queues partially overlapping QueuedTurn (u1 in .jsonl, a1 truncated) once as [u1, a1] when trailing and unsynced (never both [u1] and [u1, a1])', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u0', serverId: 'srv-0u', role: 'user', content: 'Q0', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a0', serverId: 'srv-0a', role: 'assistant', content: 'A0', createdAt: '2026-06-10T10:00:01Z' },
        { localId: 'u1', role: 'user', content: 'Q1-partial', createdAt: '2026-06-10T10:01:00Z' },
      ];
      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 't-partial-unsynced',
          localIds: ['u1', 'a1'],
          messages: [
            { role: 'user', content: 'Q1-partial' },
            { role: 'assistant', content: 'A1-from-queue' },
          ],
          enqueuedAt: '2026-06-10T10:01:02Z',
          attempts: 0,
        },
      ];
      const remoteMessages: MessageDto[] = [
        remoteDto('srv-0u', 'user', 'Q0'),
        remoteDto('srv-0a', 'assistant', 'A0'),
      ];

      const result = reconcileWithRemote({
        threadId: 't-partial-unsynced',
        localMessages,
        queuedTurns,
        remoteMessages,
        isOrchestrator: false,
      });

      expect(result.adoptedServerIds).toEqual({});
      expect(result.turnsToQueue).toHaveLength(1);
      expect(result.turnsToQueue[0].localIds).toEqual(['u1', 'a1']);
      expect(result.turnsToQueue[0].messages).toEqual([
        { role: 'user', content: 'Q1-partial' },
        { role: 'assistant', content: 'A1-from-queue' },
      ]);
    });

    it('filters incomplete/malformed message objects (e.g. {"bad": true}) in reconcileWithRemote and buildAllTurnsForRecreation without throwing', () => {
      const malformed = { bad: true } as unknown as StoredChatMessage;
      const missingContent = { localId: 'u-bad', role: 'user' } as unknown as StoredChatMessage;
      const validUser: StoredChatMessage = {
        localId: 'u-good',
        role: 'user',
        content: 'Valid question',
        createdAt: '2026-06-10T10:00:00Z',
      };
      const validAsst: StoredChatMessage = {
        localId: 'a-good',
        role: 'assistant',
        content: 'Valid answer',
        createdAt: '2026-06-10T10:00:01Z',
      };

      const reconciled = reconcileWithRemote({
        threadId: 't-malformed',
        localMessages: [malformed, validUser, missingContent, validAsst],
        queuedTurns: [],
        remoteMessages: [],
        isOrchestrator: false,
      });
      expect(reconciled.turnsToQueue.map((t) => t.localIds)).toEqual([['u-good', 'a-good']]);

      const recreated = buildAllTurnsForRecreation({
        threadId: 'new-malformed',
        localMessages: [malformed, validUser, missingContent, validAsst],
        queuedTurns: [],
        isOrchestrator: false,
      });
      expect(recreated.map((t) => t.localIds)).toEqual([['u-good', 'a-good']]);
    });
  });

  describe('buildAllTurnsForRecreation', () => {
    it('preserves full QueuedTurn [u1, a1] when .jsonl crashed after writing only u1 (partial overlap)', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u0', serverId: 's0u', role: 'user', content: 'Q0', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a0', serverId: 's0a', role: 'assistant', content: 'A0', createdAt: '2026-06-10T10:00:01Z' },
        { localId: 'u1', role: 'user', content: 'Q1-partial', createdAt: '2026-06-10T10:01:00Z' },
      ];
      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 'old-id',
          localIds: ['u1', 'a1'],
          messages: [
            { role: 'user', content: 'Q1-partial' },
            { role: 'assistant', content: 'A1-preserved-from-queue' },
          ],
          enqueuedAt: '2026-06-10T10:01:02Z',
          attempts: 2,
        },
      ];

      const turns = buildAllTurnsForRecreation({
        threadId: 'new-id',
        localMessages,
        queuedTurns,
        isOrchestrator: false,
      });

      expect(turns.map((t) => t.localIds)).toEqual([
        ['u0', 'a0'],
        ['u1', 'a1'],
      ]);
      expect(turns[1].messages).toEqual([
        { role: 'user', content: 'Q1-partial' },
        { role: 'assistant', content: 'A1-preserved-from-queue' },
      ]);
      expect(turns[1].threadId).toBe('new-id');
      expect(turns[1].attempts).toBe(0);
    });
    it('rebuilds chronological [user, assistant] pairs and singletons across ALL messages (synced and unsynced), reusing matching QueuedTurns and appending queueOnlyTurns', () => {
      const localMessages: StoredChatMessage[] = [
        { localId: 'u1', serverId: 'old-s1', role: 'user', content: 'First Q', playbook: 'oim-schema', playbookVersion: 1, createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a1', serverId: 'old-s2', role: 'assistant', content: 'First A', createdAt: '2026-06-10T10:00:02Z' },
        { localId: 'u-solo', serverId: 'old-s3', role: 'user', content: 'Solo user prompt', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'u2', role: 'user', content: 'Second Q', createdAt: '2026-06-10T10:02:00Z' },
        { localId: 'a2', role: 'assistant', content: 'Second A', createdAt: '2026-06-10T10:02:02Z' },
      ];

      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 'old-thread',
          localIds: ['u2', 'a2'],
          messages: [
            { role: 'user', content: 'Second Q' },
            { role: 'assistant', content: 'Second A (preserved queued payload)' },
          ],
          enqueuedAt: '2026-06-10T10:02:02Z',
          attempts: 3,
        },
        {
          threadId: 'old-thread',
          localIds: ['u3-qonly', 'a3-qonly'],
          messages: [
            { role: 'user', content: 'Third Q (queue only)' },
            { role: 'assistant', content: 'Third A (queue only)' },
          ],
          enqueuedAt: '2026-06-10T10:03:00Z',
          attempts: 2,
        },
      ];

      const turns = buildAllTurnsForRecreation({
        threadId: 'new-thread',
        localMessages,
        queuedTurns,
        isOrchestrator: false,
      });

      expect(turns.map((t) => t.localIds)).toEqual([
        ['u1', 'a1'],
        ['u-solo'],
        ['u2', 'a2'],
        ['u3-qonly', 'a3-qonly'],
      ]);
      expect(turns.every((t) => t.threadId === 'new-thread' && t.attempts === 0)).toBe(true);
      expect(turns[2].messages[1].content).toBe('Second A (preserved queued payload)');
    });
  });

  describe('reconstructOrphanThreadMeta', () => {
    it('rebuilds ThreadMeta from message createdAt timestamps (never wall-clock now), usage totals, hasStarted, and initialPlaybook', () => {
      const messages: StoredChatMessage[] = [
        {
          localId: 'u1',
          serverId: 's1',
          role: 'user',
          content: 'Question 1',
          playbook: 'oim-getting-started',
          createdAt: '2026-01-15T08:00:00.000Z',
        },
        {
          localId: 'a1',
          serverId: 's2',
          role: 'assistant',
          content: 'Answer 1',
          usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5, thoughtTokens: 8 },
          createdAt: '2026-01-15T08:00:10.000Z',
        },
        {
          localId: 'u2',
          role: 'user',
          content: 'Question 2 (unsynced)',
          playbook: 'ignored-later-playbook',
          createdAt: '2026-01-15T08:05:00.000Z',
        },
        {
          localId: 'a2',
          role: 'assistant',
          content: 'Answer 2 (unsynced)',
          usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, thoughtTokens: 2 },
          createdAt: '2026-01-15T08:05:12.000Z',
        },
      ];

      const reconstructed = reconstructOrphanThreadMeta({
        threadId: 'orphan-1',
        messages,
        defaultModel: 'sonnet',
        defaultThinkingLevel: 'medium',
      });

      expect(reconstructed).toEqual({
        id: 'orphan-1',
        title: 'New Conversation',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: '2026-01-15T08:00:00.000Z',
        updatedAt: '2026-01-15T08:05:12.000Z',
        totals: {
          inputTokens: 150,
          outputTokens: 60,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          thoughtTokens: 10,
        },
        syncState: 'pending',
        hasStarted: true,
        initialPlaybook: 'oim-getting-started',
      });
    });

    it('returns undefined when orphan .jsonl has 0 valid messages', () => {
      expect(
        reconstructOrphanThreadMeta({
          threadId: 'empty-orphan',
          messages: [],
          defaultModel: 'sonnet',
          defaultThinkingLevel: 'medium',
        }),
      ).toBeUndefined();

      expect(
        reconstructOrphanThreadMeta({
          threadId: 'corrupt-orphan',
          messages: [null as unknown as StoredChatMessage, { bad: true } as unknown as StoredChatMessage],
          defaultModel: 'sonnet',
          defaultThinkingLevel: 'medium',
        }),
      ).toBeUndefined();
    });
  });

  describe('groupLocalTurns & countUnqueuedLocalTurns (Wave 1 Remediation)', () => {
    it('groupLocalTurns groups synced anchors, unsynced [user, assistant] pairs, singletons, and ignoreServerIds mode', () => {
      const msgs: StoredChatMessage[] = [
        { localId: 'u1', serverId: 's1', role: 'user', content: 'Q1', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a1', serverId: 's2', role: 'assistant', content: 'A1', createdAt: '2026-06-10T10:00:01Z' },
        { localId: 'u2', role: 'user', content: 'Q2', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'a2', role: 'assistant', content: 'A2', createdAt: '2026-06-10T10:01:01Z' },
        { localId: 'u3', role: 'user', content: 'Solo Q3', createdAt: '2026-06-10T10:02:00Z' },
      ];

      const defaultGroups = groupLocalTurns(msgs);
      expect(defaultGroups.map((g) => ({ kind: g.kind, ids: g.messages.map((m) => m.localId) }))).toEqual([
        { kind: 'synced', ids: ['u1'] },
        { kind: 'synced', ids: ['a1'] },
        { kind: 'pair', ids: ['u2', 'a2'] },
        { kind: 'singleton', ids: ['u3'] },
      ]);

      const recreationGroups = groupLocalTurns(msgs, { ignoreServerIds: true });
      expect(recreationGroups.map((g) => ({ kind: g.kind, ids: g.messages.map((m) => m.localId) }))).toEqual([
        { kind: 'pair', ids: ['u1', 'a1'] },
        { kind: 'pair', ids: ['u2', 'a2'] },
        { kind: 'singleton', ids: ['u3'] },
      ]);
    });

    it('countUnqueuedLocalTurns counts trailing unqueued turns, skips mid-thread gaps, handles partial queue overlaps, and excludes excludedLocalIds', () => {
      const msgs: StoredChatMessage[] = [
        // Mid-thread gap before synced anchor -> skipped (0)
        { localId: 'u-gap', role: 'user', content: 'Gap Q', createdAt: '2026-06-10T09:59:00Z' },
        { localId: 'a-gap', role: 'assistant', content: 'Gap A', createdAt: '2026-06-10T09:59:01Z' },
        // Synced anchor
        { localId: 'u-sync', serverId: 's1', role: 'user', content: 'Q1', createdAt: '2026-06-10T10:00:00Z' },
        { localId: 'a-sync', serverId: 's2', role: 'assistant', content: 'A1', createdAt: '2026-06-10T10:00:01Z' },
        // Standalone unsynced user message BEFORE a partial queue overlap [u-part, a-part] where only a-part is in .jsonl
        { localId: 'u-unq-solo', role: 'user', content: 'Solo before partial', createdAt: '2026-06-10T10:01:00Z' },
        { localId: 'a-part', role: 'assistant', content: 'Partial assistant in log', createdAt: '2026-06-10T10:01:05Z' },
        // Unqueued [user, assistant] pair -> counted (+1)
        { localId: 'u-unq', role: 'user', content: 'Unqueued Q', createdAt: '2026-06-10T10:02:00Z' },
        { localId: 'a-unq', role: 'assistant', content: 'Unqueued A', createdAt: '2026-06-10T10:02:01Z' },
        // Already queued pair -> excluded by queuedTurns
        { localId: 'u-queued', role: 'user', content: 'Queued Q', createdAt: '2026-06-10T10:03:00Z' },
        { localId: 'a-queued', role: 'assistant', content: 'Queued A', createdAt: '2026-06-10T10:03:01Z' },
        // Live session turn -> excluded by excludedLocalIds
        { localId: 'u-live', role: 'user', content: 'Live Q', createdAt: '2026-06-10T10:04:00Z' },
        { localId: 'a-live', role: 'assistant', content: 'Live A', createdAt: '2026-06-10T10:04:01Z' },
      ];

      const queuedTurns: QueuedTurn[] = [
        {
          threadId: 't1',
          localIds: ['u-part', 'a-part'],
          messages: [
            { role: 'user', content: 'Partial Q' },
            { role: 'assistant', content: 'Partial assistant in log' },
          ],
          enqueuedAt: '2026-06-10T10:01:05Z',
          attempts: 0,
        },
        {
          threadId: 't1',
          localIds: ['u-queued', 'a-queued'],
          messages: [
            { role: 'user', content: 'Queued Q' },
            { role: 'assistant', content: 'Queued A' },
          ],
          enqueuedAt: '2026-06-10T10:03:01Z',
          attempts: 0,
        },
      ];

      // Expect 2 unqueued turns: ['u-unq-solo'] (NOT falsely paired with 'a-part'!) + ['u-unq', 'a-unq']
      expect(
        countUnqueuedLocalTurns(msgs, queuedTurns, new Set(['u-live', 'a-live'])),
      ).toBe(2);
    });
  });
});

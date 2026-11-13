import {
  EMPTY_USAGE,
  type ChatMessage,
  type ThreadMeta,
  type ThinkingLevel,
  type UsageTotals,
} from '../../shared/types';
import { serializeAssistantContent } from '../store/messageCodec';
import { isValidStoredMessage, type StoredChatMessage } from '../store/ThreadStore';
import type { MessageDto, NewMessagePayload } from './SyncClient';
import type { QueuedTurn } from './SyncQueue';

/**
 * Format user message text for server sync, appending concise image attachment notes
 * using only stored attachment metadata (`name`, `description`) — never hydrating base64 blobs.
 */
export function formatSyncedUserContent(
  content: string,
  images?: ReadonlyArray<{ name?: string; description?: string }>,
): string {
  if (!images || images.length === 0) {
    return content;
  }
  const imageNotes = images
    .map(
      (img, i) =>
        `[Attached Image ${i + 1} (${img.name || 'image.png'})${img.description ? `: ${img.description}` : ''}]`,
    )
    .join('\n');
  return content ? `${content}\n\n${imageNotes}` : imageNotes;
}

/**
 * Single shared wire-payload builder for live `writeTurn`, `200 OK` trailing backfill,
 * and `404` full-transcript recreation. Works directly on `StoredChatMessage` (without
 * base64 blob hydration) as well as hydrated or `fromDto`-rehydrated `ChatMessage`s.
 */
export function toNewMessagePayload(
  msg: StoredChatMessage | ChatMessage,
  isOrchestrator: boolean,
): NewMessagePayload {
  const playbook =
    typeof msg.playbook === 'string' && msg.playbook.trim().length > 0
      ? msg.playbook.trim()
      : undefined;
  const playbookVersion =
    playbook !== undefined &&
    typeof msg.playbookVersion === 'number' &&
    Number.isInteger(msg.playbookVersion) &&
    msg.playbookVersion >= 1
      ? msg.playbookVersion
      : undefined;

  if (msg.role === 'user') {
    return {
      role: 'user',
      content: formatSyncedUserContent(msg.content, msg.images),
      ...(playbook !== undefined ? { playbook } : {}),
      ...(playbookVersion !== undefined ? { playbookVersion } : {}),
    };
  }

  const usage = msg.usage;
  return {
    role: 'assistant',
    content: serializeAssistantContent(msg, isOrchestrator),
    ...(playbook !== undefined ? { playbook } : {}),
    ...(playbookVersion !== undefined ? { playbookVersion } : {}),
    promptTokens: usage?.inputTokens ?? null,
    completionTokens: usage?.outputTokens ?? null,
    totalTokens: usage ? usage.inputTokens + usage.outputTokens : null,
    cachedTokens: usage?.cacheReadTokens ?? null,
    thoughtTokens: usage?.thoughtTokens ?? null,
  };
}

export interface ReconcileInput {
  threadId: string;
  localMessages: readonly (StoredChatMessage | ChatMessage)[];
  queuedTurns: readonly QueuedTurn[];
  remoteMessages: readonly MessageDto[];
  isOrchestrator: boolean;
  /** True when the server transcript hit the 10,000-message comparison ceiling. */
  truncated?: boolean;
  /** Local message IDs already dropped via 4xx/cap in the current app session. */
  droppedLocalIds?: ReadonlySet<string>;
}

export interface ReconcileResult {
  /** Newly matched localId -> serverId mappings discovered on the server. */
  adoptedServerIds: Record<string, string>;
  /** Complete ordered list of turns that should remain queued for this thread. */
  turnsToQueue: QueuedTurn[];
  /** Number of unsynced turns skipped because they sit before a later synced message. */
  skippedMidThreadTurns: number;
  /** Local IDs belonging to skipped mid-thread gap turns. */
  skippedMidThreadLocalIds: string[];
}

interface UnmatchedLocalTurn {
  startIndex: number;
  endIndex: number;
  messages: readonly (StoredChatMessage | ChatMessage)[];
  queuedTurn?: QueuedTurn;
}

export interface PartialQueuedOverlap {
  qt: QueuedTurn;
  firstIdx: number;
  lastIdx: number;
  presentIndices: number[];
}

export interface PartialOverlapOptions {
  partialQueuedByFirstIndex?: ReadonlyMap<number, PartialQueuedOverlap>;
  consumedByPartialQueue?: ReadonlySet<number>;
  ignoreServerIds?: boolean;
}

export type LocalTurnGroup =
  | {
      kind: 'synced';
      startIndex: number;
      endIndex: number;
      messages: readonly [StoredChatMessage | ChatMessage];
    }
  | {
      kind: 'partial-queued';
      startIndex: number;
      endIndex: number;
      messages: readonly (StoredChatMessage | ChatMessage)[];
      queuedTurn: QueuedTurn;
      presentIndices: readonly number[];
    }
  | {
      kind: 'pair';
      startIndex: number;
      endIndex: number;
      messages: readonly [StoredChatMessage | ChatMessage, StoredChatMessage | ChatMessage];
    }
  | {
      kind: 'singleton';
      startIndex: number;
      endIndex: number;
      messages: readonly [StoredChatMessage | ChatMessage];
    };

function collectPartialQueuedOverlaps(
  localMessages: readonly (StoredChatMessage | ChatMessage)[],
  queuedTurns: readonly QueuedTurn[],
  opts?: { ignoreServerIds?: boolean },
): {
  localIndexById: Map<string, number>;
  partialQueuedByFirstIndex: Map<number, PartialQueuedOverlap>;
  consumedByPartialQueue: Set<number>;
  handledPartialTurns: Set<QueuedTurn>;
  ignoreServerIds: boolean;
} {
  const ignoreServerIds = Boolean(opts?.ignoreServerIds);
  const localIndexById = new Map<string, number>();
  for (let idx = 0; idx < localMessages.length; idx += 1) {
    if (!localIndexById.has(localMessages[idx].localId)) {
      localIndexById.set(localMessages[idx].localId, idx);
    }
  }

  const partialQueuedByFirstIndex = new Map<number, PartialQueuedOverlap>();
  const consumedByPartialQueue = new Set<number>();
  const handledPartialTurns = new Set<QueuedTurn>();

  for (const qt of queuedTurns) {
    if (qt.messages.length === 0 || qt.localIds.length !== qt.messages.length) continue;
    const presentIndices = qt.localIds
      .map((id) => localIndexById.get(id))
      .filter((idx): idx is number => idx !== undefined);
    if (presentIndices.length === 0 || presentIndices.length === qt.localIds.length) {
      continue;
    }
    if (!ignoreServerIds && presentIndices.some((idx) => Boolean(localMessages[idx].serverId))) {
      continue;
    }
    const firstIdx = Math.min(...presentIndices);
    const lastIdx = Math.max(...presentIndices);
    if (partialQueuedByFirstIndex.has(firstIdx) || presentIndices.some((idx) => consumedByPartialQueue.has(idx))) {
      continue;
    }
    partialQueuedByFirstIndex.set(firstIdx, { qt, firstIdx, lastIdx, presentIndices });
    handledPartialTurns.add(qt);
    for (const idx of presentIndices) {
      if (idx !== firstIdx) {
        consumedByPartialQueue.add(idx);
      }
    }
  }

  return {
    localIndexById,
    partialQueuedByFirstIndex,
    consumedByPartialQueue,
    handledPartialTurns,
    ignoreServerIds,
  };
}

/**
 * Canonical `[user, assistant]` turn-grouping primitive shared across `reconcileWithRemote`,
 * `buildAllTurnsForRecreation`, and `countUnqueuedLocalTurns`.
 */
export function groupLocalTurns(
  rawMessages: readonly (StoredChatMessage | ChatMessage)[],
  partialOverlaps?: PartialOverlapOptions,
): LocalTurnGroup[] {
  const messages = rawMessages.filter(isValidStoredMessage);
  const partialByFirst = partialOverlaps?.partialQueuedByFirstIndex;
  const consumed = partialOverlaps?.consumedByPartialQueue;
  const ignoreServerIds = Boolean(partialOverlaps?.ignoreServerIds);

  const groups: LocalTurnGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    if (consumed?.has(i)) {
      i += 1;
      continue;
    }

    const partial = partialByFirst?.get(i);
    if (partial) {
      groups.push({
        kind: 'partial-queued',
        startIndex: i,
        endIndex: partial.lastIdx,
        messages: partial.presentIndices.map((idx) => messages[idx]),
        queuedTurn: partial.qt,
        presentIndices: partial.presentIndices,
      });
      i += 1;
      continue;
    }

    const current = messages[i];
    if (!ignoreServerIds && current.serverId) {
      groups.push({
        kind: 'synced',
        startIndex: i,
        endIndex: i,
        messages: [current],
      });
      i += 1;
      continue;
    }

    if (
      i + 1 < messages.length &&
      !consumed?.has(i + 1) &&
      !partialByFirst?.has(i + 1) &&
      current.role === 'user' &&
      messages[i + 1].role === 'assistant' &&
      (ignoreServerIds || !messages[i + 1].serverId)
    ) {
      groups.push({
        kind: 'pair',
        startIndex: i,
        endIndex: i + 1,
        messages: [current, messages[i + 1]],
      });
      i += 2;
      continue;
    }

    groups.push({
      kind: 'singleton',
      startIndex: i,
      endIndex: i,
      messages: [current],
    });
    i += 1;
  }

  return groups;
}

/**
 * Counts trailing unsynced turns in `rawMessages` that are not already covered by `queuedTurns`
 * or `excludedLocalIds` (live session turns / dropped turns).
 */
export function countUnqueuedLocalTurns(
  rawMessages: readonly (StoredChatMessage | ChatMessage)[],
  queuedTurns: readonly QueuedTurn[] = [],
  excludedLocalIds?: ReadonlySet<string>,
): number {
  const localMessages = rawMessages.filter(isValidStoredMessage);
  if (localMessages.length === 0) return 0;

  let lastSyncedIdx = -1;
  for (let i = 0; i < localMessages.length; i += 1) {
    if (localMessages[i].serverId) {
      lastSyncedIdx = i;
    }
  }

  const partialOverlaps = collectPartialQueuedOverlaps(localMessages, queuedTurns);
  const groups = groupLocalTurns(localMessages, partialOverlaps);
  const queuedIds = new Set(queuedTurns.flatMap((t) => t.localIds));

  let unqueuedCount = 0;
  for (const group of groups) {
    if (group.kind === 'synced' || group.kind === 'partial-queued') continue;
    if (group.startIndex <= lastSyncedIdx) continue;
    const turnIds = group.messages.map((m) => m.localId);
    if (!turnIds.some((id) => queuedIds.has(id) || excludedLocalIds?.has(id))) {
      unqueuedCount += 1;
    }
  }
  return unqueuedCount;
}

function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function matchesPayloadToRemote(
  expectedRole: 'user' | 'assistant',
  primaryContent: string,
  queuedContent: string | undefined,
  remote: MessageDto,
): boolean {
  if (remote.role !== expectedRole) return false;
  const remoteNorm = normalizeContent(remote.content);
  if (remoteNorm === normalizeContent(primaryContent)) return true;
  if (queuedContent !== undefined && remoteNorm === normalizeContent(queuedContent)) return true;
  return false;
}

/**
 * Reconciles cached `.jsonl` messages + `SyncQueue` turns against `GET /conversations/{id}/messages`.
 *
 * - Anchors `remoteCursor` on existing `serverId` positions and pre-claims known remote IDs.
 * - Matches adjacent unsynced `[user, assistant]` pairs atomically (`i += 2` whether matched or
 *   unmatched so an unmatched assistant half never falls through to singleton matching).
 * - Trailing-only backfill (`startIndex > lastSyncedLocalIndex`): stranded mid-thread gaps are
 *   reported and skipped rather than appended out of chronological order.
 * - When `truncated` is true (>10,000 server messages), skips `.jsonl` synthesis and keeps only
 *   unmatched `SyncQueue` turns.
 */
export function reconcileWithRemote(input: ReconcileInput): ReconcileResult {
  const {
    threadId,
    queuedTurns,
    remoteMessages,
    isOrchestrator,
    truncated = false,
    droppedLocalIds,
  } = input;
  const localMessages = input.localMessages.filter(isValidStoredMessage);

  const adoptedServerIds: Record<string, string> = {};
  const remoteIndexById = new Map<string, number>();
  for (let r = 0; r < remoteMessages.length; r += 1) {
    remoteIndexById.set(remoteMessages[r].id, r);
  }

  // Pre-claim remote IDs already bound to local serverIds so unsynced gaps cannot steal them.
  const claimedRemoteIds = new Set<string>();
  for (const m of localMessages) {
    if (m.serverId && remoteIndexById.has(m.serverId)) {
      claimedRemoteIds.add(m.serverId);
    }
  }

  // Index existing QueuedTurns by exact localIds tuple AND per-localId wire content.
  const queuedByKey = new Map<string, QueuedTurn>();
  const queuedContentByLocalId = new Map<string, string>();
  for (const qt of queuedTurns) {
    queuedByKey.set(qt.localIds.join('\0'), qt);
    qt.localIds.forEach((id, idx) => {
      const msg = qt.messages[idx];
      if (msg) {
        queuedContentByLocalId.set(id, msg.content);
      }
    });
  }

  const localIdSet = new Set(localMessages.map((m) => m.localId));
  let remoteCursor = 0;

  if (truncated) {
    for (const m of localMessages) {
      if (m.serverId && remoteIndexById.has(m.serverId)) {
        remoteCursor = Math.max(remoteCursor, remoteIndexById.get(m.serverId)! + 1);
      }
    }

    const turnsToQueue: QueuedTurn[] = [];
    for (const qt of queuedTurns) {
      if (qt.localIds.some((id) => droppedLocalIds?.has(id))) continue;
      const matchedAt = findContiguousQueuedMatch(qt, remoteMessages, remoteCursor, claimedRemoteIds);
      if (matchedAt >= 0) {
        for (let j = 0; j < qt.messages.length; j += 1) {
          const remoteId = remoteMessages[matchedAt + j].id;
          claimedRemoteIds.add(remoteId);
          if (qt.localIds[j]) {
            adoptedServerIds[qt.localIds[j]] = remoteId;
          }
        }
        remoteCursor = matchedAt + qt.messages.length;
      } else {
        turnsToQueue.push({ ...qt, threadId });
      }
    }

    return {
      adoptedServerIds,
      turnsToQueue,
      skippedMidThreadTurns: 0,
      skippedMidThreadLocalIds: [],
    };
  }

  // Precompute the next known remote anchor position after each local index `i` so a stranded
  // mid-thread gap before a synced anchor can never match a duplicate turn AFTER that anchor.
  const nextAnchorAfter = new Array<number>(localMessages.length).fill(remoteMessages.length);
  let runningMinAnchor = remoteMessages.length;
  for (let idx = localMessages.length - 1; idx >= 0; idx -= 1) {
    nextAnchorAfter[idx] = runningMinAnchor;
    const srvId = localMessages[idx].serverId;
    if (srvId && remoteIndexById.has(srvId)) {
      runningMinAnchor = Math.min(runningMinAnchor, remoteIndexById.get(srvId)!);
    }
  }

  const partialOverlaps = collectPartialQueuedOverlaps(localMessages, queuedTurns);
  const { handledPartialTurns } = partialOverlaps;
  const groups = groupLocalTurns(localMessages, partialOverlaps);

  const syncedLocalIndices = new Set<number>();
  const unmatchedLocalTurns: UnmatchedLocalTurn[] = [];

  for (const group of groups) {
    if (group.kind === 'partial-queued') {
      const { queuedTurn: qt, startIndex, endIndex, presentIndices } = group;
      const upperBound = nextAnchorAfter[endIndex];
      const matchedAt = findContiguousQueuedMatch(qt, remoteMessages, remoteCursor, claimedRemoteIds, upperBound);
      if (matchedAt >= 0) {
        for (let j = 0; j < qt.messages.length; j += 1) {
          const remoteId = remoteMessages[matchedAt + j].id;
          claimedRemoteIds.add(remoteId);
          if (qt.localIds[j]) {
            adoptedServerIds[qt.localIds[j]] = remoteId;
          }
        }
        for (const idx of presentIndices) {
          syncedLocalIndices.add(idx);
        }
        remoteCursor = matchedAt + qt.messages.length;
      } else {
        unmatchedLocalTurns.push({
          startIndex,
          endIndex,
          messages: group.messages,
          queuedTurn: qt,
        });
      }
      continue;
    }

    if (group.kind === 'synced') {
      const current = group.messages[0];
      syncedLocalIndices.add(group.startIndex);
      if (current.serverId && remoteIndexById.has(current.serverId)) {
        remoteCursor = Math.max(remoteCursor, remoteIndexById.get(current.serverId)! + 1);
      }
      continue;
    }

    if (group.kind === 'pair') {
      const [current, next] = group.messages;
      const uPrimary = toNewMessagePayload(current, isOrchestrator).content;
      const aPrimary = toNewMessagePayload(next, isOrchestrator).content;
      const uQueued = queuedContentByLocalId.get(current.localId);
      const aQueued = queuedContentByLocalId.get(next.localId);
      const upperBound = nextAnchorAfter[group.endIndex];

      let matchedPos = -1;
      for (let k = remoteCursor; k + 1 < upperBound; k += 1) {
        const rUser = remoteMessages[k];
        const rAsst = remoteMessages[k + 1];
        if (claimedRemoteIds.has(rUser.id) || claimedRemoteIds.has(rAsst.id)) continue;
        if (
          matchesPayloadToRemote('user', uPrimary, uQueued, rUser) &&
          matchesPayloadToRemote('assistant', aPrimary, aQueued, rAsst)
        ) {
          matchedPos = k;
          break;
        }
      }

      if (matchedPos >= 0) {
        const rUserId = remoteMessages[matchedPos].id;
        const rAsstId = remoteMessages[matchedPos + 1].id;
        claimedRemoteIds.add(rUserId);
        claimedRemoteIds.add(rAsstId);
        adoptedServerIds[current.localId] = rUserId;
        adoptedServerIds[next.localId] = rAsstId;
        syncedLocalIndices.add(group.startIndex);
        syncedLocalIndices.add(group.endIndex);
        remoteCursor = matchedPos + 2;
      } else {
        unmatchedLocalTurns.push({
          startIndex: group.startIndex,
          endIndex: group.endIndex,
          messages: [current, next],
        });
      }
      continue;
    }

    // Standalone unpaired singleton message
    const current = group.messages[0];
    const sPrimary = toNewMessagePayload(current, isOrchestrator).content;
    const sQueued = queuedContentByLocalId.get(current.localId);
    const upperBound = nextAnchorAfter[group.startIndex];

    let matchedSingleton = -1;
    for (let k = remoteCursor; k < upperBound; k += 1) {
      const rMsg = remoteMessages[k];
      if (claimedRemoteIds.has(rMsg.id)) continue;
      if (matchesPayloadToRemote(current.role, sPrimary, sQueued, rMsg)) {
        matchedSingleton = k;
        break;
      }
    }

    if (matchedSingleton >= 0) {
      const rId = remoteMessages[matchedSingleton].id;
      claimedRemoteIds.add(rId);
      adoptedServerIds[current.localId] = rId;
      syncedLocalIndices.add(group.startIndex);
      remoteCursor = matchedSingleton + 1;
    } else {
      unmatchedLocalTurns.push({
        startIndex: group.startIndex,
        endIndex: group.endIndex,
        messages: [current],
      });
    }
  }

  let lastSyncedLocalIndex = -1;
  for (const syncedIdx of syncedLocalIndices) {
    if (syncedIdx > lastSyncedLocalIndex) {
      lastSyncedLocalIndex = syncedIdx;
    }
  }

  const turnsToQueue: QueuedTurn[] = [];
  let skippedMidThreadTurns = 0;
  const skippedMidThreadLocalIds: string[] = [];

  for (const cand of unmatchedLocalTurns) {
    const turnLocalIds = cand.queuedTurn ? [...cand.queuedTurn.localIds] : cand.messages.map((m) => m.localId);
    if (cand.startIndex <= lastSyncedLocalIndex) {
      skippedMidThreadTurns += 1;
      skippedMidThreadLocalIds.push(...turnLocalIds);
      continue;
    }
    if (turnLocalIds.some((id) => droppedLocalIds?.has(id))) {
      continue;
    }
    if (cand.queuedTurn) {
      turnsToQueue.push({ ...cand.queuedTurn, threadId });
      continue;
    }
    const existingQueued = queuedByKey.get(turnLocalIds.join('\0'));
    if (existingQueued) {
      turnsToQueue.push({ ...existingQueued, threadId });
    } else {
      const lastMsg = cand.messages[cand.messages.length - 1];
      turnsToQueue.push({
        threadId,
        localIds: turnLocalIds,
        messages: cand.messages.map((m) => toNewMessagePayload(m, isOrchestrator)),
        enqueuedAt: lastMsg.createdAt || new Date().toISOString(),
        attempts: 0,
      });
    }
  }

  // Merge queue-only turns (present in SyncQueue, absent from .jsonl), deduplicating against remoteMessages.
  const queuedLocalIdsCovered = new Set<string>(turnsToQueue.flatMap((t) => t.localIds));
  for (const qt of queuedTurns) {
    if (qt.messages.length === 0 || handledPartialTurns.has(qt)) {
      continue;
    }
    if (qt.localIds.every((id) => localIdSet.has(id) || queuedLocalIdsCovered.has(id))) {
      continue;
    }
    if (qt.localIds.some((id) => droppedLocalIds?.has(id))) {
      continue;
    }
    const matchedAt = findContiguousQueuedMatch(qt, remoteMessages, remoteCursor, claimedRemoteIds);
    if (matchedAt >= 0) {
      for (let j = 0; j < qt.messages.length; j += 1) {
        const remoteId = remoteMessages[matchedAt + j].id;
        claimedRemoteIds.add(remoteId);
        if (qt.localIds[j]) {
          adoptedServerIds[qt.localIds[j]] = remoteId;
        }
      }
      remoteCursor = matchedAt + qt.messages.length;
    } else {
      turnsToQueue.push({ ...qt, threadId });
      for (const id of qt.localIds) {
        queuedLocalIdsCovered.add(id);
      }
    }
  }

  return {
    adoptedServerIds,
    turnsToQueue,
    skippedMidThreadTurns,
    skippedMidThreadLocalIds,
  };
}

function findContiguousQueuedMatch(
  qt: QueuedTurn,
  remoteMessages: readonly MessageDto[],
  remoteCursor: number,
  claimedRemoteIds: ReadonlySet<string>,
  upperBound = remoteMessages.length,
): number {
  const len = qt.messages.length;
  if (len === 0) return -1;
  const limit = Math.min(upperBound, remoteMessages.length);
  for (let k = remoteCursor; k + len <= limit; k += 1) {
    let allMatch = true;
    for (let j = 0; j < len; j += 1) {
      const rMsg = remoteMessages[k + j];
      const qMsg = qt.messages[j];
      if (
        claimedRemoteIds.has(rMsg.id) ||
        rMsg.role !== qMsg.role ||
        normalizeContent(rMsg.content) !== normalizeContent(qMsg.content)
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return k;
    }
  }
  return -1;
}

interface BuildRecreationTurnsBase {
  localMessages: readonly (StoredChatMessage | ChatMessage)[];
  queuedTurns?: readonly QueuedTurn[];
  isOrchestrator: boolean;
}

export type BuildRecreationTurnsInput =
  | (BuildRecreationTurnsBase & { threadId: string })
  | (BuildRecreationTurnsBase & { newThreadId: string });

/**
 * Groups ALL messages in a conversation (whether they previously carried `serverId` or not)
 * into chronological `[user, assistant]` pairs and standalone singletons under `threadId`,
 * reusing existing `QueuedTurn` payloads where `localIds` match and appending any `queueOnlyTurns`.
 */
export function buildAllTurnsForRecreation(input: BuildRecreationTurnsInput): QueuedTurn[] {
  const targetThreadId = 'threadId' in input ? input.threadId : input.newThreadId;
  const { queuedTurns = [], isOrchestrator } = input;
  const localMessages = input.localMessages.filter(isValidStoredMessage);
  const queuedByKey = new Map<string, QueuedTurn>();
  for (const qt of queuedTurns) {
    queuedByKey.set(qt.localIds.join('\0'), qt);
  }

  // For recreation, ALL turns (even if an overlapping local line carried a stale serverId from the
  // deleted conversation) must preserve the complete SyncQueue turn if .jsonl crashed mid-write.
  const partialOverlaps = collectPartialQueuedOverlaps(localMessages, queuedTurns, {
    ignoreServerIds: true,
  });
  const groups = groupLocalTurns(localMessages, partialOverlaps);

  const turns: QueuedTurn[] = [];
  const coveredLocalIds = new Set<string>();

  for (const group of groups) {
    if (group.kind === 'partial-queued') {
      const partialQt = group.queuedTurn;
      for (const id of partialQt.localIds) {
        coveredLocalIds.add(id);
      }
      turns.push({
        threadId: targetThreadId,
        localIds: [...partialQt.localIds],
        messages: partialQt.messages,
        enqueuedAt: partialQt.enqueuedAt,
        attempts: 0,
      });
      continue;
    }

    if (group.kind === 'pair') {
      const [current, next] = group.messages;
      const pairIds = [current.localId, next.localId];
      coveredLocalIds.add(current.localId);
      coveredLocalIds.add(next.localId);

      const existing = queuedByKey.get(pairIds.join('\0'));
      if (existing) {
        turns.push({
          threadId: targetThreadId,
          localIds: pairIds,
          messages: existing.messages,
          enqueuedAt: existing.enqueuedAt,
          attempts: 0,
        });
      } else {
        turns.push({
          threadId: targetThreadId,
          localIds: pairIds,
          messages: [
            toNewMessagePayload(current, isOrchestrator),
            toNewMessagePayload(next, isOrchestrator),
          ],
          enqueuedAt: next.createdAt || current.createdAt || '1970-01-01T00:00:00.000Z',
          attempts: 0,
        });
      }
      continue;
    }

    const current = group.messages[0];
    const singleIds = [current.localId];
    coveredLocalIds.add(current.localId);
    const existing = queuedByKey.get(singleIds.join('\0'));
    if (existing) {
      turns.push({
        threadId: targetThreadId,
        localIds: singleIds,
        messages: existing.messages,
        enqueuedAt: existing.enqueuedAt,
        attempts: 0,
      });
    } else {
      turns.push({
        threadId: targetThreadId,
        localIds: singleIds,
        messages: [toNewMessagePayload(current, isOrchestrator)],
        enqueuedAt: current.createdAt || '1970-01-01T00:00:00.000Z',
        attempts: 0,
      });
    }
  }

  for (const qt of queuedTurns) {
    if (qt.messages.length === 0) continue;
    if (qt.localIds.some((id) => coveredLocalIds.has(id))) continue;
    for (const id of qt.localIds) {
      coveredLocalIds.add(id);
    }
    turns.push({
      threadId: targetThreadId,
      localIds: [...qt.localIds],
      messages: qt.messages,
      enqueuedAt: qt.enqueuedAt,
      attempts: 0,
    });
  }

  return turns;
}

export interface ReconstructOrphanMetaInput {
  threadId: string;
  messages: readonly (StoredChatMessage | ChatMessage)[];
  defaultModel: string;
  defaultThinkingLevel: ThinkingLevel;
}

/**
 * Rebuilds missing `ThreadMeta` for a non-empty orphaned `<id>.jsonl` file using message
 * `createdAt` timestamps (never wall-clock `now`), token `totals`, `hasStarted`, and `initialPlaybook`.
 * Returns `undefined` when `messages` contains zero valid message records.
 */
export function reconstructOrphanThreadMeta(input: ReconstructOrphanMetaInput): ThreadMeta | undefined {
  const valid = input.messages.filter(isValidStoredMessage);
  if (valid.length === 0) {
    return undefined;
  }

  let minMs = Infinity;
  let maxMs = -Infinity;
  let minIso: string | undefined;
  let maxIso: string | undefined;
  let fallbackFirst: string | undefined;
  let fallbackLast: string | undefined;

  const totals: UsageTotals = { ...EMPTY_USAGE };
  for (const m of valid) {
    if (typeof m.createdAt === 'string' && m.createdAt.trim().length > 0) {
      const trimmed = m.createdAt.trim();
      if (!fallbackFirst) fallbackFirst = trimmed;
      fallbackLast = trimmed;
      const ms = Date.parse(trimmed);
      if (!Number.isNaN(ms)) {
        if (ms < minMs) {
          minMs = ms;
          minIso = trimmed;
        }
        if (ms >= maxMs) {
          maxMs = ms;
          maxIso = trimmed;
        }
      }
    }
    if (m.role === 'assistant' && m.usage) {
      totals.inputTokens += m.usage.inputTokens ?? 0;
      totals.outputTokens += m.usage.outputTokens ?? 0;
      totals.cacheReadTokens += m.usage.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += m.usage.cacheWriteTokens ?? 0;
      if (typeof m.usage.thoughtTokens === 'number') {
        totals.thoughtTokens = (totals.thoughtTokens ?? 0) + m.usage.thoughtTokens;
      }
    }
  }

  const createdAt = minIso ?? fallbackFirst ?? '1970-01-01T00:00:00.000Z';
  const updatedAt = maxIso ?? fallbackLast ?? createdAt;
  const firstPlaybook = valid
    .find((m) => m.role === 'user' && typeof m.playbook === 'string' && m.playbook.trim().length > 0)
    ?.playbook?.trim();
  const hasUnsynced = valid.some((m) => !m.serverId);

  return {
    id: input.threadId,
    title: 'New Conversation',
    model: input.defaultModel,
    thinkingLevel: input.defaultThinkingLevel,
    createdAt,
    updatedAt,
    totals,
    syncState: hasUnsynced ? 'pending' : 'synced',
    hasStarted: true,
    ...(firstPlaybook ? { initialPlaybook: firstPlaybook } : {}),
  };
}

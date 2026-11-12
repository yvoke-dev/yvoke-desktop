import {
  EMPTY_USAGE,
  type ChatMessage,
  type ThreadMeta,
  type ThinkingLevel,
  type UsageTotals,
} from '../../shared/types';
import { serializeAssistantContent } from '../store/messageCodec';
import type { StoredChatMessage } from '../store/ThreadStore';
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

interface PartialQueuedOverlap {
  qt: QueuedTurn;
  lastIdx: number;
  presentIndices: number[];
}

function isValidLocalMessage(msg: unknown): msg is StoredChatMessage | ChatMessage {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const rec = msg as Record<string, unknown>;
  return (
    typeof rec.localId === 'string' &&
    rec.localId.length > 0 &&
    (rec.role === 'user' || rec.role === 'assistant') &&
    typeof rec.content === 'string'
  );
}

function collectPartialQueuedOverlaps(
  localMessages: readonly (StoredChatMessage | ChatMessage)[],
  queuedTurns: readonly QueuedTurn[],
): {
  localIndexById: Map<string, number>;
  partialQueuedByFirstIndex: Map<number, PartialQueuedOverlap>;
  consumedByPartialQueue: Set<number>;
  handledPartialTurns: Set<QueuedTurn>;
} {
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
    if (presentIndices.some((idx) => Boolean(localMessages[idx].serverId))) {
      continue;
    }
    const firstIdx = Math.min(...presentIndices);
    const lastIdx = Math.max(...presentIndices);
    if (partialQueuedByFirstIndex.has(firstIdx) || presentIndices.some((idx) => consumedByPartialQueue.has(idx))) {
      continue;
    }
    partialQueuedByFirstIndex.set(firstIdx, { qt, lastIdx, presentIndices });
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
  };
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
  const localMessages = input.localMessages.filter(isValidLocalMessage);

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

  const {
    partialQueuedByFirstIndex,
    consumedByPartialQueue,
    handledPartialTurns,
  } = collectPartialQueuedOverlaps(localMessages, queuedTurns);

  const syncedLocalIndices = new Set<number>();
  const unmatchedLocalTurns: UnmatchedLocalTurn[] = [];

  let i = 0;
  while (i < localMessages.length) {
    if (consumedByPartialQueue.has(i)) {
      i += 1;
      continue;
    }

    const partialOverlap = partialQueuedByFirstIndex.get(i);
    if (partialOverlap) {
      const { qt, lastIdx, presentIndices } = partialOverlap;
      const upperBound = nextAnchorAfter[lastIdx];
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
          startIndex: i,
          endIndex: lastIdx,
          messages: presentIndices.map((idx) => localMessages[idx]),
          queuedTurn: qt,
        });
      }
      i += 1;
      continue;
    }

    const current = localMessages[i];
    if (current.serverId) {
      syncedLocalIndices.add(i);
      if (remoteIndexById.has(current.serverId)) {
        remoteCursor = Math.max(remoteCursor, remoteIndexById.get(current.serverId)! + 1);
      }
      i += 1;
      continue;
    }

    // Adjacent unsynced [user, assistant] pair: match atomically and ALWAYS advance i += 2.
    if (
      i + 1 < localMessages.length &&
      !consumedByPartialQueue.has(i + 1) &&
      !partialQueuedByFirstIndex.has(i + 1) &&
      current.role === 'user' &&
      localMessages[i + 1].role === 'assistant' &&
      !localMessages[i + 1].serverId
    ) {
      const next = localMessages[i + 1];
      const uPrimary = toNewMessagePayload(current, isOrchestrator).content;
      const aPrimary = toNewMessagePayload(next, isOrchestrator).content;
      const uQueued = queuedContentByLocalId.get(current.localId);
      const aQueued = queuedContentByLocalId.get(next.localId);
      const upperBound = nextAnchorAfter[i + 1];

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
        syncedLocalIndices.add(i);
        syncedLocalIndices.add(i + 1);
        remoteCursor = matchedPos + 2;
      } else {
        unmatchedLocalTurns.push({
          startIndex: i,
          endIndex: i + 1,
          messages: [current, next],
        });
      }

      i += 2;
      continue;
    }

    // Standalone unpaired singleton message
    const sPrimary = toNewMessagePayload(current, isOrchestrator).content;
    const sQueued = queuedContentByLocalId.get(current.localId);
    const upperBound = nextAnchorAfter[i];

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
      syncedLocalIndices.add(i);
      remoteCursor = matchedSingleton + 1;
    } else {
      unmatchedLocalTurns.push({
        startIndex: i,
        endIndex: i,
        messages: [current],
      });
    }

    i += 1;
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

export interface BuildRecreationTurnsInput {
  newThreadId: string;
  localMessages: readonly (StoredChatMessage | ChatMessage)[];
  queuedTurns?: readonly QueuedTurn[];
  isOrchestrator: boolean;
}

/**
 * Groups ALL messages in a conversation (whether they previously carried `serverId` or not)
 * into chronological `[user, assistant]` pairs and standalone singletons under `newThreadId`,
 * reusing existing `QueuedTurn` payloads where `localIds` match and appending any `queueOnlyTurns`.
 */
export function buildAllTurnsForRecreation(input: BuildRecreationTurnsInput): QueuedTurn[] {
  const { newThreadId, queuedTurns = [], isOrchestrator } = input;
  const localMessages = input.localMessages.filter(isValidLocalMessage);
  const queuedByKey = new Map<string, QueuedTurn>();
  for (const qt of queuedTurns) {
    queuedByKey.set(qt.localIds.join('\0'), qt);
  }

  // For recreation, ALL turns (even if an overlapping local line carried a stale serverId from the
  // deleted conversation) must preserve the complete SyncQueue turn if .jsonl crashed mid-write.
  const localIndexById = new Map<string, number>();
  for (let idx = 0; idx < localMessages.length; idx += 1) {
    if (!localIndexById.has(localMessages[idx].localId)) {
      localIndexById.set(localMessages[idx].localId, idx);
    }
  }
  const partialQueuedByFirstIndex = new Map<number, QueuedTurn>();
  const consumedByPartialQueue = new Set<number>();
  for (const qt of queuedTurns) {
    if (qt.messages.length === 0 || qt.localIds.length !== qt.messages.length) continue;
    const presentIndices = qt.localIds
      .map((id) => localIndexById.get(id))
      .filter((idx): idx is number => idx !== undefined);
    if (presentIndices.length === 0 || presentIndices.length === qt.localIds.length) {
      continue;
    }
    const firstIdx = Math.min(...presentIndices);
    if (partialQueuedByFirstIndex.has(firstIdx) || presentIndices.some((idx) => consumedByPartialQueue.has(idx))) {
      continue;
    }
    partialQueuedByFirstIndex.set(firstIdx, qt);
    for (const idx of presentIndices) {
      if (idx !== firstIdx) {
        consumedByPartialQueue.add(idx);
      }
    }
  }

  const turns: QueuedTurn[] = [];
  const coveredLocalIds = new Set<string>();

  let i = 0;
  while (i < localMessages.length) {
    if (consumedByPartialQueue.has(i)) {
      i += 1;
      continue;
    }

    const partialQt = partialQueuedByFirstIndex.get(i);
    if (partialQt) {
      for (const id of partialQt.localIds) {
        coveredLocalIds.add(id);
      }
      turns.push({
        threadId: newThreadId,
        localIds: [...partialQt.localIds],
        messages: partialQt.messages,
        enqueuedAt: partialQt.enqueuedAt,
        attempts: 0,
      });
      i += 1;
      continue;
    }

    const current = localMessages[i];
    if (
      i + 1 < localMessages.length &&
      !consumedByPartialQueue.has(i + 1) &&
      !partialQueuedByFirstIndex.has(i + 1) &&
      current.role === 'user' &&
      localMessages[i + 1].role === 'assistant'
    ) {
      const next = localMessages[i + 1];
      const pairIds = [current.localId, next.localId];
      coveredLocalIds.add(current.localId);
      coveredLocalIds.add(next.localId);

      const existing = queuedByKey.get(pairIds.join('\0'));
      if (existing) {
        turns.push({
          threadId: newThreadId,
          localIds: pairIds,
          messages: existing.messages,
          enqueuedAt: existing.enqueuedAt,
          attempts: 0,
        });
      } else {
        turns.push({
          threadId: newThreadId,
          localIds: pairIds,
          messages: [
            toNewMessagePayload(current, isOrchestrator),
            toNewMessagePayload(next, isOrchestrator),
          ],
          enqueuedAt: next.createdAt || current.createdAt || '1970-01-01T00:00:00.000Z',
          attempts: 0,
        });
      }
      i += 2;
      continue;
    }

    const singleIds = [current.localId];
    coveredLocalIds.add(current.localId);
    const existing = queuedByKey.get(singleIds.join('\0'));
    if (existing) {
      turns.push({
        threadId: newThreadId,
        localIds: singleIds,
        messages: existing.messages,
        enqueuedAt: existing.enqueuedAt,
        attempts: 0,
      });
    } else {
      turns.push({
        threadId: newThreadId,
        localIds: singleIds,
        messages: [toNewMessagePayload(current, isOrchestrator)],
        enqueuedAt: current.createdAt || '1970-01-01T00:00:00.000Z',
        attempts: 0,
      });
    }
    i += 1;
  }

  for (const qt of queuedTurns) {
    if (qt.messages.length === 0) continue;
    if (qt.localIds.some((id) => coveredLocalIds.has(id))) continue;
    for (const id of qt.localIds) {
      coveredLocalIds.add(id);
    }
    turns.push({
      threadId: newThreadId,
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
  const valid = input.messages.filter(isValidLocalMessage);
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

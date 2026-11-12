import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import { ThreadStore } from '../src/main/store/ThreadStore';
import { SyncApiError, type ConversationDto, type MessageDto } from '../src/main/sync/SyncClient';
import type { ChatMessage, McpPromptInfo, OrchestratorRunPayload, SyncEvent, ThreadMeta } from '../src/shared/types';
import * as PlaybookValidator from '../src/main/agent/PlaybookValidator';
import * as logger from '../src/main/log';
import { DEFAULT_SETTINGS } from '../src/main/settings/Settings';

describe('AppCore.sendMessage - Multi-Agent Playbook Isolation', () => {
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-playbook-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Test 1.7a: Main Process Isolation in AppCore.sendMessage passes playbook: undefined and omits injectBefore when orchestratorProfile is set', async () => {
    const thread: ThreadMeta = {
      id: 'thread-orch-1',
      title: 'Orchestrator Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi
      .spyOn(appCore.agent, 'sendMessage')
      .mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Run multi-agent investigation',
      promptName: 'some-playbook',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: thread.id, orchestratorProfile: 'OIM' }),
      'Run multi-agent investigation',
      expect.objectContaining({
        playbook: undefined,
      }),
    );
    expect(sendSpy.mock.calls[0][2]).not.toHaveProperty('injectBefore');
  });

  it('Test 1.7b: Adversarial Defense & Prompt Resolution Bypass - getText is never called in sendMessage', async () => {
    const orchThread: ThreadMeta = {
      id: 'thread-orch-2',
      title: 'Orchestrator Conversation 2',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    const singleThread: ThreadMeta = {
      id: 'thread-single-1',
      title: 'Single Agent Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(orchThread);
    appCore.threads.upsert(singleThread);

    const getTextSpy = vi.spyOn(appCore.mcpPrompts, 'getText');
    const sendSpy = vi
      .spyOn(appCore.agent, 'sendMessage')
      .mockResolvedValue(undefined as any);

    // Case 1: Orchestrator with explicit promptName
    await appCore.sendMessage({
      threadId: orchThread.id,
      text: 'Orchestrator message with prompt',
      promptName: 'oim-schema',
    });
    expect(getTextSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'Orchestrator message with prompt',
      expect.objectContaining({
        playbook: undefined,
      }),
    );

    // Case 2: Orchestrator with empty promptName ''
    await appCore.sendMessage({
      threadId: orchThread.id,
      text: 'Orchestrator message with empty prompt',
      promptName: '',
    });
    expect(getTextSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'Orchestrator message with empty prompt',
      expect.objectContaining({
        playbook: undefined,
      }),
    );

    // Case 3: Single agent thread with promptName: getText is NOT called in AppCore, agent receives playbook, thread is patched
    await appCore.sendMessage({
      threadId: singleThread.id,
      text: 'Single agent message with prompt',
      promptName: 'oim-schema',
    });
    expect(getTextSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: singleThread.id, initialPlaybook: 'oim-schema' }),
      'Single agent message with prompt',
      expect.objectContaining({
        playbook: 'oim-schema',
      }),
    );
    expect(sendSpy.mock.calls[2][2]).not.toHaveProperty('injectBefore');
  });

  it('Negative 1.2.1: authoritative lock on divergent promptName ignores divergent promptName and locks to initialPlaybook', async () => {
    const thread: ThreadMeta = {
      id: 'thread-locked-1',
      title: 'Locked Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      initialPlaybook: 'oim-getting-started',
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi
      .spyOn(appCore.agent, 'sendMessage')
      .mockResolvedValue(undefined as any);

    // Caller attempts to send message with a divergent promptName
    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Second question attempting divergent playbook',
      promptName: 'oim-divergent',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: thread.id, initialPlaybook: 'oim-getting-started' }),
      'Second question attempting divergent playbook',
      expect.objectContaining({
        playbook: 'oim-getting-started',
      }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-getting-started');
  });

  it('Negative 1.2.2: sync preservation in listThreads preserves initialPlaybook on upsert', async () => {
    const thread: ThreadMeta = {
      id: 'thread-sync-1',
      title: 'Local Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      initialPlaybook: 'oim-schema',
    };
    appCore.threads.upsert(thread);

    // Server returns conversation without initialPlaybook
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValue([
      {
        id: 'thread-sync-1',
        title: 'Server Conversation Title',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T11:00:00.000Z',
        settings: { model: 'opus' },
      } as any,
    ]);

    const result = await appCore.listThreads();
    expect(result.serverReachable).toBe(true);

    const stored = appCore.threads.get('thread-sync-1')!;
    expect(stored.title).toBe('Server Conversation Title');
    expect(stored.initialPlaybook).toBe('oim-schema');
  });

  it('Negative 1.2.3: sync failure resilience preserves local initialPlaybook when syncClient fails', async () => {
    const thread: ThreadMeta = {
      id: 'thread-fail-1',
      title: 'Local Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      initialPlaybook: 'oim-schema',
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore.syncClient, 'listConversations').mockRejectedValue(new Error('Network error'));

    const result = await appCore.listThreads();
    expect(result.serverReachable).toBe(false);

    const stored = appCore.threads.get('thread-fail-1')!;
    expect(stored.initialPlaybook).toBe('oim-schema');
  });

  it('Negative 1.2.4: patchThread tampering defense strips initialPlaybook and prevents unauthorized modification', () => {
    const thread: ThreadMeta = {
      id: 'thread-tamper-1',
      title: 'Tamper Test Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      initialPlaybook: 'oim-legitimate',
    };
    appCore.threads.upsert(thread);

    // Malicious caller tries to inject initialPlaybook or sessionId via patchThread
    const patched = appCore.patchThread(thread.id, {
      title: 'Updated Title',
      initialPlaybook: 'oim-hacked',
      sessionId: 'fake-session',
    } as any);

    expect(patched?.title).toBe('Updated Title');
    expect(patched?.initialPlaybook).toBe('oim-legitimate');
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-legitimate');
  });
});

describe('AppCore.patchThread - Mode Boundary Session Isolation', () => {
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-mode-boundary-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows mode change on unstarted thread when switching from single-agent to multi-agent', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-1',
      title: 'Switch Test',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });

    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(patched?.sessionId).toBeUndefined();
    expect(patched?.orchestratorProfile).toBe('OIM');
    expect(appCore.threads.get(thread.id)?.sessionId).toBeUndefined();
  });

  it('allows mode change on unstarted thread when switching from multi-agent to single-agent', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-2',
      title: 'Switch Test 2',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: undefined });

    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(patched?.sessionId).toBeUndefined();
    expect(patched?.orchestratorProfile).toBeUndefined();
    expect(appCore.threads.get(thread.id)?.sessionId).toBeUndefined();
  });

  it('allows mode change on unstarted thread when switching between different orchestrator profiles', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-3',
      title: 'Switch Test 3',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'Security' });

    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(patched?.sessionId).toBeUndefined();
    expect(patched?.orchestratorProfile).toBe('Security');
    expect(appCore.threads.get(thread.id)?.sessionId).toBeUndefined();
  });

  it('rejects mode change once conversation has started (started thread boundary)', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-started',
      sessionId: 'session-single-1',
      title: 'Started Switch Test',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    expect(() => appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );
    expect(closeSpy).not.toHaveBeenCalled();
    expect(appCore.threads.get(thread.id)?.orchestratorProfile).toBeUndefined();
  });

  it('preserves sessionId and does not close agent session when patching non-profile fields', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-4',
      sessionId: 'session-keep-1',
      title: 'Preserve Test',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { model: 'opus', title: 'Updated Title' });

    expect(closeSpy).not.toHaveBeenCalled();
    expect(patched?.sessionId).toBe('session-keep-1');
    expect(patched?.model).toBe('opus');
    expect(patched?.title).toBe('Updated Title');
    expect(appCore.threads.get(thread.id)?.sessionId).toBe('session-keep-1');
  });
});

describe('AppCore.patchThread - Concurrency Lockout & Mode Rejection', () => {
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-lockout-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Test 1.4 & 1.4d: patchThread throws when modeChanged and agent.isBusy is true; closeThread is NOT called and store is untouched', () => {
    const thread: ThreadMeta = {
      id: 'thread-busy-1',
      title: 'Busy Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);

    (appCore.agent as any).isBusy = vi.fn().mockReturnValue(true);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    expect(() => {
      appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    }).toThrow('Cannot change agent mode while a turn is in progress');

    expect(closeSpy).not.toHaveBeenCalled();
    expect(appCore.threads.get(thread.id)?.orchestratorProfile).toBeUndefined();
  });

  it('Test 1.4b (Negative control): Non-mode patch (e.g. title) allowed when agent is busy', () => {
    const thread: ThreadMeta = {
      id: 'thread-busy-2',
      title: 'Original Title',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);

    (appCore.agent as any).isBusy = vi.fn().mockReturnValue(true);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { title: 'Updated Title' });
    expect(patched?.title).toBe('Updated Title');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(appCore.threads.get(thread.id)?.title).toBe('Updated Title');
  });

  it('Test 1.4c (Boundary): Identical profile patch allowed when agent is busy', () => {
    const thread: ThreadMeta = {
      id: 'thread-busy-3',
      title: 'Same Profile Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);

    (appCore.agent as any).isBusy = vi.fn().mockReturnValue(true);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    expect(patched?.orchestratorProfile).toBe('OIM');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('Test 1.5: Mode change allowed on unstarted thread when idle (closes thread, updates store, clears sessionId/sessionProfile)', () => {
    const thread: ThreadMeta = {
      id: 'thread-idle-1',
      title: 'Idle Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);

    (appCore.agent as any).isBusy = vi.fn().mockReturnValue(false);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(patched?.orchestratorProfile).toBe('OIM');
    expect(patched?.sessionId).toBeUndefined();
    expect(patched?.sessionProfile).toBeUndefined();
    expect(appCore.threads.get(thread.id)?.orchestratorProfile).toBe('OIM');
  });

  it('Test 1.5b: Mode change rejected on started thread even when idle', () => {
    const thread: ThreadMeta = {
      id: 'thread-idle-started',
      title: 'Idle Started Thread',
      hasStarted: true,
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);

    (appCore.agent as any).isBusy = vi.fn().mockReturnValue(false);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    expect(() => appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('Test 1.6 & 1.6b: Profile divergence matrix in listThreads clears sessionId when server settings diverge', async () => {
    const thread2: ThreadMeta = {
      id: 'conv-diverge-2',
      title: 'Divergent Thread 2',
      sessionId: 'sess-diverge-2',
      sessionProfile: 'OIM',
      orchestratorProfile: undefined,
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    };
    appCore.threads.upsert(thread2);

    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 'conv-diverge-2',
        title: 'Divergent Thread 2',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:05:00.000Z',
        settings: {},
      } as any,
    ]);

    const res = await appCore.listThreads();
    const updated2 = res.threads.find((t) => t.id === 'conv-diverge-2');
    expect(updated2?.sessionId).toBeUndefined();
    expect(updated2?.sessionProfile).toBeUndefined();
  });
});

describe('AppCore.drain', () => {
  // Note: These tests use `(appCore as any).chainPersist` to directly enqueue asynchronous work
  // into private persistTails, verifying drain timing and while-loop cascading independently of full turns.
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-drain-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(async () => {
    await appCore.drain();
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flushes persistTails and awaits threads.drain()', async () => {
    const drainThreadsSpy = vi.spyOn(appCore.threads, 'drain');
    let persistWorkFinished = false;

    (appCore as any).chainPersist('t1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      persistWorkFinished = true;
    });

    await appCore.drain();

    expect(persistWorkFinished).toBe(true);
    expect(drainThreadsSpy).toHaveBeenCalledTimes(1);
    expect(drainThreadsSpy).toHaveBeenCalledWith();
  });

  it('flushes targeted thread persistTail and awaits threads.drain(threadId)', async () => {
    const drainThreadsSpy = vi.spyOn(appCore.threads, 'drain');
    let t1Finished = false;

    (appCore as any).chainPersist('t1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      t1Finished = true;
    });
    (appCore as any).chainPersist('t2', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await appCore.drain('t1');

    expect(t1Finished).toBe(true);
    expect(drainThreadsSpy).toHaveBeenCalledWith('t1');
  });

  it('handles chained persist tails queued during drainage via while-loop', async () => {
    const drainThreadsSpy = vi.spyOn(appCore.threads, 'drain');
    let firstTurnDone = false;
    let secondTurnDone = false;

    (appCore as any).chainPersist('t1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      firstTurnDone = true;
      (appCore as any).chainPersist('t2', async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        secondTurnDone = true;
      });
    });

    await appCore.drain();

    expect(firstTurnDone).toBe(true);
    expect(secondTurnDone).toBe(true);
    expect(drainThreadsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AppCore.validatePlaybook - Two-Stage Preflight Exclusion', () => {
  let tmpDir: string;
  let appCore: AppCore;
  const singleThreadId = 'thread-single-val';

  const mockPrompts: McpPromptInfo[] = [
    { name: 'general-chat', title: 'General Chat', description: 'Chat playbook', arguments: [] },
    { name: 'triage-slug', title: 'Triage Assistant', description: 'Triage playbook', arguments: [] },
    { name: 'oim-schema', title: 'Schema Explorer', description: 'Schema playbook', arguments: [] },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-val-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
    appCore.threads.upsert({
      id: singleThreadId,
      title: 'Validation Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    });
  });

  afterEach(async () => {
    await appCore.drain();
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Stage 1 Fast-Path bypass: returns PASSES without calling listPrompts or listOrchestratorProfiles', async () => {
    vi.spyOn(appCore.settings, 'get').mockReturnValue({
      ...DEFAULT_SETTINGS,
      playbookValidationExcludedPlaybooks: ['general-chat'],
    });

    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const listProfilesSpy = vi.spyOn(appCore, 'listOrchestratorProfiles');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({
      threadId: singleThreadId,
      text: 'How do I start?',
      promptName: 'general-chat',
    });

    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(listProfilesSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('Stage 2 Resolved Title Match: returns PASSES without calling validatePlaybookSelection when candidate matches by title', async () => {
    vi.spyOn(appCore.settings, 'get').mockReturnValue({
      ...DEFAULT_SETTINGS,
      playbookValidationExcludedPlaybooks: ['Triage Assistant'],
    });

    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts').mockResolvedValue(mockPrompts);
    const listProfilesSpy = vi.spyOn(appCore, 'listOrchestratorProfiles').mockResolvedValue([]);
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({
      threadId: singleThreadId,
      text: 'Incoming ticket issue',
      promptName: 'triage-slug',
    });

    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).toHaveBeenCalledTimes(1);
    expect(listProfilesSpy).toHaveBeenCalledTimes(1);
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('Stage 2 Negative Path: proceeds to validator when neither slug nor title is excluded', async () => {
    vi.spyOn(appCore.settings, 'get').mockReturnValue({
      ...DEFAULT_SETTINGS,
      playbookValidationExcludedPlaybooks: ['other-playbook'],
    });

    vi.spyOn(appCore, 'listPrompts').mockResolvedValue(mockPrompts);
    vi.spyOn(appCore, 'listOrchestratorProfiles').mockResolvedValue([]);
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection').mockResolvedValue({
      plausible: false,
      reason: 'Schema questions should use Schema Explorer',
      suggestedPlaybookName: 'oim-schema',
    });

    const result = await appCore.validatePlaybook({
      threadId: singleThreadId,
      text: 'Check column definitions in Person table',
      promptName: 'triage-slug',
    });

    expect(result).toEqual({
      plausible: false,
      reason: 'Schema questions should use Schema Explorer',
      suggestedPlaybookName: 'oim-schema',
    });
    expect(validatorSpy).toHaveBeenCalledTimes(1);
  });

  it('returns PASSES without calling prompts or validator when promptName is empty', async () => {
    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({ threadId: singleThreadId, text: 'Hello', promptName: '' });
    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('returns PASSES without calling prompts or validator when text is empty or whitespace', async () => {
    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const rEmpty = await appCore.validatePlaybook({ threadId: singleThreadId, text: '', promptName: 'oim-schema' });
    expect(rEmpty).toEqual({ plausible: true });

    const rWhitespace = await appCore.validatePlaybook({ threadId: singleThreadId, text: '   \n  ', promptName: 'oim-schema' });
    expect(rWhitespace).toEqual({ plausible: true });

    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('returns PASSES without calling prompts or validator when playbookValidationEnabled is false', async () => {
    vi.spyOn(appCore.settings, 'get').mockReturnValue({
      ...DEFAULT_SETTINGS,
      playbookValidationEnabled: false,
    });
    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({ threadId: singleThreadId, text: 'Hello', promptName: 'oim-schema' });
    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('returns PASSES without calling prompts or validator when thread is in orchestrator mode', async () => {
    const orchThreadId = 'thread-orch-val';
    appCore.threads.upsert({
      id: orchThreadId,
      title: 'Orchestrator Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    });
    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({ threadId: orchThreadId, text: 'Hello', promptName: 'oim-schema' });
    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });

  it('returns PASSES without calling prompts or validator when thread is unknown', async () => {
    const listPromptsSpy = vi.spyOn(appCore, 'listPrompts');
    const validatorSpy = vi.spyOn(PlaybookValidator, 'validatePlaybookSelection');

    const result = await appCore.validatePlaybook({ threadId: 'unknown-thread', text: 'Hello', promptName: 'oim-schema' });
    expect(result).toEqual({ plausible: true });
    expect(listPromptsSpy).not.toHaveBeenCalled();
    expect(validatorSpy).not.toHaveBeenCalled();
  });
});

describe('AppCore - Agent Mode & Playbook Locking (Wave 1)', () => {
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-lock-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(() => {
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Upfront Stamping: stamps hasStarted: true into ThreadStore for single-agent on first prompt', async () => {
    const thread: ThreadMeta = {
      id: 't-stamp-single',
      title: 'Single Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);
    expect(appCore.threads.get(thread.id)?.hasStarted).toBeUndefined();

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'First question',
      promptName: 'oim-query',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const stored = appCore.threads.get(thread.id)!;
    expect(stored.hasStarted).toBe(true);
    expect(stored.initialPlaybook).toBe('oim-query');
  });

  it('Upfront Stamping: stamps hasStarted: true into ThreadStore for multi-agent threads on first prompt', async () => {
    const thread: ThreadMeta = {
      id: 't-stamp-multi',
      title: 'Multi Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);
    expect(appCore.threads.get(thread.id)?.hasStarted).toBeUndefined();

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'First multi-agent question',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const stored = appCore.threads.get(thread.id)!;
    expect(stored.hasStarted).toBe(true);
    expect(stored.initialPlaybook).toBeUndefined();
  });

  it('Second Prompt Playbook Immutability: preserves initialPlaybook and ignores different promptName', async () => {
    const thread: ThreadMeta = {
      id: 't-immut-playbook',
      title: 'Playbook Immutability',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: 'oim-first',
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Second question with another prompt',
      promptName: 'oim-second',
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.anything(),
      'Second question with another prompt',
      expect.objectContaining({ playbook: 'oim-first' }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-first');
  });

  it('Legacy Thread Backfill: backfills initialPlaybook and stamps hasStarted on first promptName send', async () => {
    const thread: ThreadMeta = {
      id: 't-legacy-backfill',
      title: 'Legacy Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      sessionId: 'legacy-sess',
      totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cacheCreationTokens: 0 },
      syncState: 'synced',
      initialPlaybook: undefined,
      hasStarted: undefined,
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'First legacy prompt',
      promptName: 'oim-schema',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.anything(),
      'First legacy prompt',
      expect.objectContaining({ playbook: 'oim-schema' }),
    );
    const stored = appCore.threads.get(thread.id)!;
    expect(stored.initialPlaybook).toBe('oim-schema');
    expect(stored.hasStarted).toBe(true);
  });

  it('Second Prompt Immutability After Backfill: preserves backfilled playbook and ignores divergent promptName', async () => {
    const thread: ThreadMeta = {
      id: 't-legacy-second-send',
      title: 'Legacy Thread 2',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      sessionId: 'legacy-sess-2',
      totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cacheCreationTokens: 0 },
      syncState: 'synced',
      initialPlaybook: undefined,
      hasStarted: undefined,
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Initial send to backfill',
      promptName: 'oim-schema',
    });
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-schema');

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Second send with divergent prompt',
      promptName: 'divergent-playbook',
    });

    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'Second send with divergent prompt',
      expect.objectContaining({ playbook: 'oim-schema' }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-schema');
  });

  it('Late Playbook Assignment on Started Playbook-Less Thread: assigns initialPlaybook, closes warm session, clears sessionId, and locks initialPlaybook for subsequent turns', async () => {
    const thread: ThreadMeta = {
      id: 't-plain-chat',
      title: 'Started Playbook-Less Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      sessionId: 'warm-plain-session',
      sessionProfile: undefined,
      totals: { ...ThreadStore.emptyTotals(), inputTokens: 25, outputTokens: 30 },
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: undefined,
    };
    appCore.threads.upsert(thread);
    await appCore.threads.appendMessages(thread.id, [
      {
        localId: 'u-1',
        role: 'user',
        content: 'Turn 1 sent while catalogue was empty',
        playbook: undefined,
        createdAt: '2026-08-01T10:00:01.000Z',
      },
      {
        localId: 'a-1',
        role: 'assistant',
        content: 'Answer 1',
        createdAt: '2026-08-01T10:00:02.000Z',
      },
    ]);

    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');
    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    // Follow-up turn while catalogue is still empty (no promptName) stays playbook-less without closing session
    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Turn 2 still without playbook',
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: thread.id, sessionId: 'warm-plain-session' }),
      'Turn 2 still without playbook',
      expect.objectContaining({ playbook: undefined }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBeUndefined();

    // Once catalogue loads and user selects a playbook on follow-up turn, it assigns initialPlaybook, closes warm session, and clears sessionId
    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Turn 3 assigning playbook',
      promptName: 'oim-schema',
    });

    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: thread.id,
        initialPlaybook: 'oim-schema',
      }),
      'Turn 3 assigning playbook',
      expect.objectContaining({ playbook: 'oim-schema' }),
    );
    const passedThread = sendSpy.mock.calls.at(-1)![0];
    expect(passedThread.sessionId).toBeUndefined();
    expect(passedThread.sessionProfile).toBeUndefined();
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-schema');
    expect(appCore.threads.get(thread.id)?.sessionId).toBeUndefined();

    // Subsequent turn attempting a different playbook is locked to 'oim-schema'
    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Turn 4 attempting divergent playbook',
      promptName: 'divergent-playbook',
    });
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: thread.id, initialPlaybook: 'oim-schema' }),
      'Turn 4 attempting divergent playbook',
      expect.objectContaining({ playbook: 'oim-schema' }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBe('oim-schema');
  });

  it('Multi-Turn Stored Playbook Backfill: getMessages and sendMessage find playbook from Turn 2 when Turn 1 had playbook: undefined', async () => {
    const threadId = 't-multiturn-backfill';
    appCore.threads.upsert({
      id: threadId,
      title: 'Multi-Turn Backfill Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: undefined,
    });
    await appCore.threads.appendMessages(threadId, [
      { localId: 'u-1', role: 'user', content: 'Turn 1 no playbook', playbook: undefined, createdAt: '2026-08-01T10:00:01.000Z' },
      { localId: 'a-1', role: 'assistant', content: 'Answer 1', createdAt: '2026-08-01T10:00:02.000Z' },
      { localId: 'u-2', role: 'user', content: 'Turn 2 with playbook', playbook: 'oim-schema', playbookVersion: 2, createdAt: '2026-08-01T10:01:01.000Z' },
      { localId: 'a-2', role: 'assistant', content: 'Answer 2', playbook: 'oim-schema', playbookVersion: 2, createdAt: '2026-08-01T10:01:02.000Z' },
    ]);

    // Test sendMessage reading storedPlaybook before getMessages is called
    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);
    await appCore.sendMessage({
      threadId,
      text: 'Turn 3 with divergent prompt',
      promptName: 'other-playbook',
    });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: threadId, initialPlaybook: 'oim-schema' }),
      'Turn 3 with divergent prompt',
      expect.objectContaining({ playbook: 'oim-schema' }),
    );
    expect(appCore.threads.get(threadId)?.initialPlaybook).toBe('oim-schema');

    // Also test getMessages backfilling initialPlaybook when initialPlaybook is cleared
    appCore.threads.patch(threadId, { initialPlaybook: undefined, hasStarted: false });
    const msgs = await appCore.getMessages(threadId);
    expect(msgs).toHaveLength(4);
    expect(appCore.threads.get(threadId)?.initialPlaybook).toBe('oim-schema');
    expect(appCore.threads.get(threadId)?.hasStarted).toBe(true);
  });

  it('Busy Guard Pre-emption: sendMessage throws immediately when agent.isBusy(threadId) is true before reading messages', async () => {
    const thread: ThreadMeta = {
      id: 't-busy-guard',
      title: 'Busy Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: undefined,
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore.agent, 'isBusy').mockReturnValue(true);
    const readSpy = vi.spyOn(appCore.threads, 'readMessages');

    await expect(
      appCore.sendMessage({
        threadId: thread.id,
        text: 'Concurrent send while busy',
        promptName: 'oim-schema',
      }),
    ).rejects.toThrow('A turn is already running for this conversation.');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('Orchestrator Rogue Playbook Immunity Negative Test: orchestrator stamps hasStarted but ignores rogue playbook', async () => {
    const thread: ThreadMeta = {
      id: 't-orch-rogue',
      title: 'Orchestrator Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: undefined,
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Send with rogue playbook to orchestrator',
      promptName: 'rogue-playbook',
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.anything(),
      'Send with rogue playbook to orchestrator',
      expect.objectContaining({ playbook: undefined }),
    );
    const stored = appCore.threads.get(thread.id)!;
    expect(stored.hasStarted).toBe(true);
    expect(stored.initialPlaybook).toBeUndefined();
  });

  it('Whitespace Sanitization Boundary Test: whitespace promptName is sanitized to undefined', async () => {
    const thread: ThreadMeta = {
      id: 't-whitespace-prompt',
      title: 'Whitespace Prompt Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    };
    appCore.threads.upsert(thread);

    const sendSpy = vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    await appCore.sendMessage({
      threadId: thread.id,
      text: 'Send with whitespace prompt',
      promptName: '   ',
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.anything(),
      'Send with whitespace prompt',
      expect.objectContaining({ playbook: undefined }),
    );
    expect(appCore.threads.get(thread.id)?.initialPlaybook).toBeUndefined();
  });

  it('Unknown Thread Boundary: throws "Unknown thread" without writing hasStarted to store', async () => {
    const patchSpy = vi.spyOn(appCore.threads, 'patch');
    await expect(
      appCore.sendMessage({
        threadId: 'non-existent',
        text: 'Hello?',
      }),
    ).rejects.toThrow('Unknown thread: non-existent');
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('Failure Resilience: hasStarted: true remains set even if agent.sendMessage throws an error', async () => {
    const thread: ThreadMeta = {
      id: 't-fail-resilience',
      title: 'Resilience Test',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore.agent, 'sendMessage').mockRejectedValue(new Error('Network crash'));

    await expect(
      appCore.sendMessage({
        threadId: thread.id,
        text: 'Crash turn',
      }),
    ).rejects.toThrow('Network crash');

    expect(appCore.threads.get(thread.id)?.hasStarted).toBe(true);
  });

  it('Negative Error Boundary: throws when changing orchestratorProfile on started thread for all 4 start criteria', () => {
    // 1. hasStarted: true
    const t1: ThreadMeta = {
      id: 't-started-flag',
      title: 'Started Flag',
      hasStarted: true,
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(t1);
    expect(() => appCore.patchThread(t1.id, { orchestratorProfile: 'OIM' })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );

    // 2. initialPlaybook set
    const t2: ThreadMeta = {
      id: 't-started-playbook',
      title: 'Started Playbook',
      initialPlaybook: 'oim-getting-started',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(t2);
    expect(() => appCore.patchThread(t2.id, { orchestratorProfile: 'OIM' })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );

    // 3. sessionId set
    const t3: ThreadMeta = {
      id: 't-started-session',
      title: 'Started Session',
      sessionId: 'session-xyz',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(t3);
    expect(() => appCore.patchThread(t3.id, { orchestratorProfile: 'OIM' })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );

    // 4. non-zero tokens
    const t4: ThreadMeta = {
      id: 't-started-tokens',
      title: 'Started Tokens',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: { ...ThreadStore.emptyTotals(), outputTokens: 42 },
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(t4);
    expect(() => appCore.patchThread(t4.id, { orchestratorProfile: undefined })).toThrow(
      'Cannot change agent mode once a conversation has started',
    );
  });

  it('Positive Unstarted Switching: allows switching orchestratorProfile on unstarted thread', () => {
    const thread: ThreadMeta = {
      id: 't-unstarted',
      title: 'Fresh Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    expect(closeSpy).toHaveBeenCalledWith(thread.id);
    expect(patched?.orchestratorProfile).toBe('OIM');
    expect(appCore.threads.get(thread.id)?.orchestratorProfile).toBe('OIM');
  });

  it('Idempotent Mode Patch: identical orchestratorProfile on started thread succeeds and does not call closeThread', () => {
    const thread: ThreadMeta = {
      id: 't-idempotent',
      title: 'Started Orchestrator',
      hasStarted: true,
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(thread);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');

    const patched = appCore.patchThread(thread.id, { orchestratorProfile: 'OIM' });
    expect(patched?.orchestratorProfile).toBe('OIM');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('Non-mode Modifications: allows updating model, thinkingLevel, or title on started thread when idle', () => {
    const thread: ThreadMeta = {
      id: 't-started-nonmode',
      title: 'Original Title',
      hasStarted: true,
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    appCore.threads.upsert(thread);

    const patched = appCore.patchThread(thread.id, {
      model: 'opus',
      thinkingLevel: 'high',
      title: 'Updated Title',
    });

    expect(patched?.model).toBe('opus');
    expect(patched?.thinkingLevel).toBe('high');
    expect(patched?.title).toBe('Updated Title');
    expect(patched?.hasStarted).toBe(true);
  });

  it('Remote Sync Cache Reconciliation: listThreads preserves hasStarted: true', async () => {
    const localThread: ThreadMeta = {
      id: 't-sync-cache',
      title: 'Local Started Thread',
      hasStarted: true,
      initialPlaybook: 'oim-schema',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    };
    appCore.threads.upsert(localThread);

    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-sync-cache',
        title: 'Server Updated Title',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T11:00:00.000Z',
        settings: { model: 'sonnet', 'thinking-level': 'medium' },
      },
    ]);

    const result = await appCore.listThreads();
    expect(result.serverReachable).toBe(true);
    const reconciled = appCore.threads.get('t-sync-cache')!;
    expect(reconciled.hasStarted).toBe(true);
    expect(reconciled.initialPlaybook).toBe('oim-schema');
    expect(reconciled.title).toBe('Server Updated Title');
  });
});

describe('AppCore - Playbook Versioning (Sync, Rehydration, and Orchestrator Run Trace)', () => {
  let tmpDir: string;
  let appCore: AppCore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-pb-version-test-'));
    appCore = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
  });

  afterEach(async () => {
    await appCore.drain();
    appCore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writeTurn enqueues playbook and playbookVersion on both user and assistant messages for single-agent turns and leaves them undefined on orchestrator assistant messages', async () => {
    const threadId = 'thread-sync-ver';
    appCore.threads.upsert({
      id: threadId,
      title: 'Sync Version Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      initialPlaybook: 'oim-full',
      hasStarted: true,
    });

    const enqueueSpy = vi.spyOn(appCore.syncQueue, 'enqueue').mockImplementation(() => undefined);

    (appCore as any).writeTurn(
      threadId,
      {
        localId: 'u-ver-1',
        role: 'user',
        content: 'How does attestation work?',
        playbook: 'oim-full',
        playbookVersion: 2,
        createdAt: '2026-10-15T10:01:00.000Z',
      },
      {
        localId: 'a-ver-1',
        role: 'assistant',
        content: 'Here is how attestation works.',
        playbook: 'oim-full',
        playbookVersion: 2,
        createdAt: '2026-10-15T10:01:05.000Z',
      },
    );

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const turn = enqueueSpy.mock.calls[0][0];
    expect(turn.messages[0]).toEqual({
      role: 'user',
      content: 'How does attestation work?',
      playbook: 'oim-full',
      playbookVersion: 2,
    });
    expect(turn.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is how attestation works.',
      playbook: 'oim-full',
      playbookVersion: 2,
    });

    // Orchestrator turn leaves playbook and playbookVersion undefined on both messages
    const orchThreadId = 'thread-sync-orch';
    appCore.threads.upsert({
      id: orchThreadId,
      title: 'Orch Sync Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    });
    vi.spyOn(appCore as any, 'stashOrchestratorRun').mockResolvedValue(undefined);

    (appCore as any).writeTurn(
      orchThreadId,
      {
        localId: 'u-orch-sync',
        role: 'user',
        content: 'Orch question',
        createdAt: '2026-10-15T10:01:00.000Z',
      },
      {
        localId: 'a-orch-sync',
        role: 'assistant',
        content: 'Orch answer',
        createdAt: '2026-10-15T10:01:05.000Z',
      },
    );

    const orchTurn = enqueueSpy.mock.calls[1][0];
    expect(orchTurn.messages[0].playbook).toBeUndefined();
    expect(orchTurn.messages[0].playbookVersion).toBeUndefined();
    expect(orchTurn.messages[1].playbook).toBeUndefined();
    expect(orchTurn.messages[1].playbookVersion).toBeUndefined();
  });

  it('fromDto restores playbook and playbookVersion from remote MessageDto and maps null to undefined', async () => {
    const threadId = 'thread-rehydrate-ver';
    appCore.threads.upsert({
      id: threadId,
      title: 'Rehydrate Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    });

    vi.spyOn(appCore.syncClient, 'getMessages').mockResolvedValueOnce([
      {
        id: 'srv-u-1',
        role: 'user',
        content: 'Question with playbook v2',
        playbook: 'oim-full',
        playbookVersion: 2,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedTokens: null,
        thoughtTokens: null,
        createdAt: '2026-10-15T10:00:00.000Z',
        feedbackRating: null,
        feedbackComment: null,
      },
      {
        id: 'srv-a-1',
        role: 'assistant',
        content: 'Answer 1',
        playbook: null,
        playbookVersion: null,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 0,
        thoughtTokens: 0,
        createdAt: '2026-10-15T10:00:05.000Z',
        feedbackRating: null,
        feedbackComment: null,
      },
    ]);

    const messages = await appCore.getMessages(threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0].playbook).toBe('oim-full');
    expect(messages[0].playbookVersion).toBe(2);
    expect(messages[1].playbook).toBeUndefined();
    expect(messages[1].playbookVersion).toBeUndefined();
  });

  it('fromDto drops blank playbook, invalid playbookVersion (0, -1, 1.5, "2"), and orphaned playbookVersion when playbook is null or blank', async () => {
    const threadId = 'thread-rehydrate-tainted';
    appCore.threads.upsert({
      id: threadId,
      title: 'Tainted Rehydrate Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
    });

    const baseDto = {
      role: 'user' as const,
      content: 'Question',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      thoughtTokens: null,
      createdAt: '2026-10-15T10:00:00.000Z',
      feedbackRating: null,
      feedbackComment: null,
    };

    vi.spyOn(appCore.syncClient, 'getMessages').mockResolvedValueOnce([
      { ...baseDto, id: 'm-blank-pb', playbook: '   ', playbookVersion: 2 },
      { ...baseDto, id: 'm-null-pb-ver', playbook: null, playbookVersion: 3 },
      { ...baseDto, id: 'm-ver-0', playbook: 'oim-full', playbookVersion: 0 },
      { ...baseDto, id: 'm-ver-neg', playbook: 'oim-full', playbookVersion: -1 },
      { ...baseDto, id: 'm-ver-float', playbook: 'oim-full', playbookVersion: 1.5 },
      { ...baseDto, id: 'm-ver-str', playbook: 'oim-full', playbookVersion: '2' as unknown as number },
      { ...baseDto, id: 'm-trimmed', playbook: '  oim-full  ', playbookVersion: 4 },
    ]);

    const messages = await appCore.getMessages(threadId);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toMatchObject({ localId: 'm-blank-pb', playbook: undefined, playbookVersion: undefined });
    expect(messages[1]).toMatchObject({ localId: 'm-null-pb-ver', playbook: undefined, playbookVersion: undefined });
    expect(messages[2]).toMatchObject({ localId: 'm-ver-0', playbook: 'oim-full', playbookVersion: undefined });
    expect(messages[3]).toMatchObject({ localId: 'm-ver-neg', playbook: 'oim-full', playbookVersion: undefined });
    expect(messages[4]).toMatchObject({ localId: 'm-ver-float', playbook: 'oim-full', playbookVersion: undefined });
    expect(messages[5]).toMatchObject({ localId: 'm-ver-str', playbook: 'oim-full', playbookVersion: undefined });
    expect(messages[6]).toMatchObject({ localId: 'm-trimmed', playbook: 'oim-full', playbookVersion: 4 });
  });

  it('stashOrchestratorRun resolves mcpPrompts.list() versions into recorded orchestrator steps', async () => {
    const threadId = 'thread-orch-ver';
    const thread: ThreadMeta = {
      id: threadId,
      title: 'Orch Version Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore, 'resolveOrchestratorProfile').mockResolvedValue({
      name: 'OIM',
      orchestratorPlaybook: 'oim-orchestrator',
      reviewerPlaybook: 'oim-orchestrator-reviewer',
      specialistPlaybooks: ['oim-access-governance'],
    });
    vi.spyOn(appCore.mcpPrompts, 'list').mockResolvedValue([
      { name: 'oim-orchestrator', title: 'Orch', description: '', arguments: [], version: 2 },
      { name: 'oim-access-governance', title: 'AG', description: '', arguments: [], version: 4 },
      { name: 'oim-orchestrator-reviewer', title: 'Rev', description: '', arguments: [], version: 3 },
    ]);
    const recordRunSpy = vi.spyOn(appCore.syncClient, 'recordOrchestratorRun').mockResolvedValue({ id: 'run-1' });

    await (appCore as any).stashOrchestratorRun(
      thread,
      { localId: 'u-orch-1', role: 'user', content: 'Question', createdAt: 'now' },
      {
        localId: 'a-orch-1',
        role: 'assistant',
        content: 'Final answer',
        toolCalls: [
          { id: 'tc-1', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'sub-q' }, result: 'sub-a' },
          { id: 'tc-2', name: 'Agent', subagentType: 'reviewer', input: { prompt: 'rev-q' }, result: 'APPROVED\nok', verdict: { approved: true, feedback: 'ok' } },
        ],
        createdAt: 'now',
      },
    );

    (appCore as any).handleServerIds(threadId, { 'a-orch-1': 'srv-msg-1' });
    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const payload = recordRunSpy.mock.calls[0][0];
    expect(payload.steps).toHaveLength(3);
    expect(payload.steps[0]).toMatchObject({ role: 'orchestrator', playbookName: 'oim-orchestrator', playbookVersion: 2 });
    expect(payload.steps[1]).toMatchObject({ role: 'specialist', playbookName: 'oim-access-governance', playbookVersion: 4 });
    expect(payload.steps[2]).toMatchObject({ role: 'reviewer', playbookName: 'oim-orchestrator-reviewer', playbookVersion: 3 });
  });

  it('stashOrchestratorRun fails open, logs diagnostic under sync, and still records the run if mcpPrompts.list() rejects', async () => {
    const threadId = 'thread-orch-failopen';
    const thread: ThreadMeta = {
      id: threadId,
      title: 'Orch Fail-Open Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore, 'resolveOrchestratorProfile').mockResolvedValue({
      name: 'OIM',
      orchestratorPlaybook: 'oim-orchestrator',
      reviewerPlaybook: 'oim-orchestrator-reviewer',
      specialistPlaybooks: ['oim-access-governance'],
    });
    const listSpy = vi
      .spyOn(appCore.mcpPrompts, 'list')
      .mockRejectedValueOnce(new Error('MCP server temporarily unavailable'))
      .mockRejectedValueOnce('MCP offline');
    const logSpy = vi.spyOn(logger, 'log');
    const recordRunSpy = vi.spyOn(appCore.syncClient, 'recordOrchestratorRun').mockResolvedValue({ id: 'run-2' });

    await (appCore as any).stashOrchestratorRun(
      thread,
      { localId: 'u-orch-2', role: 'user', content: 'Question', createdAt: 'now' },
      {
        localId: 'a-orch-2',
        role: 'assistant',
        content: 'Final answer',
        toolCalls: [
          { id: 'tc-1', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'sub-q' }, result: 'sub-a' },
          { id: 'tc-2', name: 'Agent', subagentType: 'reviewer', input: { prompt: 'rev-q' }, result: 'APPROVED\nok', verdict: { approved: true, feedback: 'ok' } },
        ],
        createdAt: 'now',
      },
    );

    expect(logSpy).toHaveBeenCalledWith(
      'sync',
      'Failed to resolve playbook versions for orchestrator run trace: MCP server temporarily unavailable',
    );
    (appCore as any).handleServerIds(threadId, { 'a-orch-2': 'srv-msg-2' });
    expect(recordRunSpy).toHaveBeenCalledTimes(1);
    const payload = recordRunSpy.mock.calls[0][0];
    expect(payload.steps).toHaveLength(3);
    expect(payload.steps[0].playbookVersion).toBeUndefined();
    expect(payload.steps[1].playbookVersion).toBeUndefined();
    expect(payload.steps[2].playbookVersion).toBeUndefined();

    await (appCore as any).stashOrchestratorRun(
      thread,
      { localId: 'u-orch-3', role: 'user', content: 'Question 2', createdAt: 'now' },
      {
        localId: 'a-orch-3',
        role: 'assistant',
        content: 'Final answer 2',
        toolCalls: [
          { id: 'tc-3', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'sub-q' }, result: 'sub-a' },
        ],
        createdAt: 'now',
      },
    );

    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledWith(
      'sync',
      'Failed to resolve playbook versions for orchestrator run trace: MCP offline',
    );
    (appCore as any).handleServerIds(threadId, { 'a-orch-3': 'srv-msg-3' });
    expect(recordRunSpy).toHaveBeenCalledTimes(2);
    expect(recordRunSpy.mock.calls[1][0].steps[0].playbookVersion).toBeUndefined();
  });

  it('patchThread sends full buildThreadSettings payload and listThreads repairs missing server orchestrator-profile with negative controls', async () => {
    const thread: ThreadMeta = {
      id: 't-full-settings',
      title: 'Full Settings Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    };
    appCore.threads.upsert(thread);

    const updateSpy = vi.spyOn(appCore.syncClient, 'updateConversation').mockResolvedValue(undefined);

    // Patching only thinkingLevel sends the complete settings object preserving orchestrator-profile and model
    appCore.patchThread(thread.id, { thinkingLevel: 'high' });
    expect(updateSpy).toHaveBeenCalledWith(thread.id, undefined, {
      model: 'sonnet',
      thinkingLevel: 'high',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    updateSpy.mockClear();

    // listThreads repairs server conversation whose settings lost 'orchestrator-profile',
    // while NOT calling updateConversation when already matching or when single-agent
    const singleThread: ThreadMeta = {
      id: 't-single-no-repair',
      title: 'Single Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
    };
    const matchingOrchThread: ThreadMeta = {
      id: 't-matching-orch',
      title: 'Matching Orch',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
    };
    appCore.threads.upsert(singleThread);
    appCore.threads.upsert(matchingOrchThread);

    // Also verify listThreads survives a rejected repair call
    updateSpy.mockRejectedValueOnce(new Error('Repair failed'));
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-full-settings',
        title: 'Full Settings Thread',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:01:00.000Z',
        settings: { model: 'sonnet', 'thinking-level': 'high' }, // missing orchestrator-profile!
      },
      {
        id: 't-single-no-repair',
        title: 'Single Thread',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:01:00.000Z',
        settings: { model: 'sonnet' },
      },
      {
        id: 't-matching-orch',
        title: 'Matching Orch',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:01:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'OIM' },
      },
    ]);

    const res = await appCore.listThreads();
    expect(res.serverReachable).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('t-full-settings', undefined, {
      model: 'sonnet',
      thinkingLevel: 'high',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });
  });

  it('stashOrchestratorRun registers tracePromise synchronously before awaiting and bounds resolution to 5_000ms with zero dangling timers', async () => {
    vi.useFakeTimers();
    try {
      const threadId = 'thread-orch-timeout';
      const thread: ThreadMeta = {
        id: threadId,
        title: 'Orch Timeout Thread',
        model: 'sonnet',
        thinkingLevel: 'medium',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:00:00.000Z',
        totals: ThreadStore.emptyTotals(),
        syncState: 'synced',
        orchestratorProfile: 'OIM',
        hasStarted: true,
      };
      appCore.threads.upsert(thread);
      // Seed stale profilesCache so fallback has the profile if getOrchestratorProfiles hangs
      (appCore as any).profilesCache = {
        at: 0,
        profiles: [
          {
            name: 'OIM',
            orchestratorPlaybook: 'oim-orchestrator',
            reviewerPlaybook: 'oim-orchestrator-reviewer',
            specialistPlaybooks: ['oim-access-governance'],
          },
        ],
      };

      // Both network calls hang forever
      vi.spyOn(appCore, 'resolveOrchestratorProfile').mockImplementation(() => new Promise(() => {}));
      vi.spyOn(appCore.mcpPrompts, 'list').mockImplementation(() => new Promise(() => {}));
      const recordRunSpy = vi.spyOn(appCore.syncClient, 'recordOrchestratorRun').mockResolvedValue({ id: 'run-timeout-1' });

      const stashPromise = (appCore as any).stashOrchestratorRun(
        thread,
        { localId: 'u-to-1', role: 'user', content: 'Question', createdAt: 'now' },
        {
          localId: 'a-to-1',
          role: 'assistant',
          content: 'Final answer',
          toolCalls: [
            { id: 'tc-1', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'sub-q' }, result: 'sub-a' },
          ],
          createdAt: 'now',
        },
      );

      // Synchronously registered in pendingRuns BEFORE any await settles
      expect((appCore as any).pendingRuns.has('a-to-1')).toBe(true);

      // Server acks the message BEFORE stashOrchestratorRun finishes!
      (appCore as any).handleServerIds(threadId, { 'a-to-1': 'srv-to-msg-1' });
      expect(recordRunSpy).not.toHaveBeenCalled();

      // Advance 5,000ms to fire the timeout fallbacks
      await vi.advanceTimersByTimeAsync(5_000);
      await stashPromise;

      expect(recordRunSpy).toHaveBeenCalledTimes(1);
      expect(recordRunSpy.mock.calls[0][0]).toMatchObject({
        conversationId: threadId,
        messageId: 'srv-to-msg-1',
        profileName: 'OIM',
      });
      expect(recordRunSpy.mock.calls[0][0].steps[0]).toMatchObject({
        role: 'orchestrator',
        playbookName: 'oim-orchestrator',
        playbookVersion: undefined,
      });
      expect(vi.getTimerCount()).toBe(0);

      // Also verify that when both resolve fast (< 5s), the 5s timers are cleaned up in .finally()
      vi.spyOn(appCore, 'resolveOrchestratorProfile').mockResolvedValue({
        name: 'OIM',
        orchestratorPlaybook: 'oim-orchestrator',
        reviewerPlaybook: 'oim-orchestrator-reviewer',
        specialistPlaybooks: ['oim-access-governance'],
      });
      vi.spyOn(appCore.mcpPrompts, 'list').mockResolvedValue([
        { name: 'oim-orchestrator', title: 'Orch', description: '', arguments: [], version: 2 },
      ]);

      await (appCore as any).stashOrchestratorRun(
        thread,
        { localId: 'u-to-2', role: 'user', content: 'Fast question', createdAt: 'now' },
        {
          localId: 'a-to-2',
          role: 'assistant',
          content: 'Fast answer',
          toolCalls: [
            { id: 'tc-2', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'sub-q' }, result: 'sub-a' },
          ],
          createdAt: 'now',
        },
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stashOrchestratorRun deletes pendingRuns entry when buildRunTrace returns null and prevents evicted in-flight promises from resurrecting', async () => {
    const threadId = 'thread-orch-null-evict';
    const thread: ThreadMeta = {
      id: threadId,
      title: 'Orch Null & Eviction Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    };
    appCore.threads.upsert(thread);

    vi.spyOn(appCore, 'resolveOrchestratorProfile').mockResolvedValue({
      name: 'OIM',
      orchestratorPlaybook: 'oim-orchestrator',
      reviewerPlaybook: 'oim-orchestrator-reviewer',
      specialistPlaybooks: ['oim-access-governance'],
    });
    vi.spyOn(appCore.mcpPrompts, 'list').mockResolvedValue([]);

    // 1. Assistant message with empty content and no tool calls -> buildRunTrace returns null -> entry deleted
    await (appCore as any).stashOrchestratorRun(
      thread,
      { localId: 'u-null', role: 'user', content: 'Empty turn', createdAt: 'now' },
      { localId: 'a-null', role: 'assistant', content: '   ', toolCalls: [], createdAt: 'now' },
    );
    expect((appCore as any).pendingRuns.has('a-null')).toBe(false);

    // 2. Eviction race: first turn is slow; 50 subsequent turns evict 'a-evict-0' before it settles
    let resolveSlowProfile!: (p: any) => void;
    vi.spyOn(appCore, 'resolveOrchestratorProfile').mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSlowProfile = res;
        }),
    );

    const delegationCall = [
      { id: 'tc-evict', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'q' }, result: 'a' },
    ];

    const slowStash = (appCore as any).stashOrchestratorRun(
      thread,
      { localId: 'u-evict-0', role: 'user', content: 'Slow 0', createdAt: 'now' },
      { localId: 'a-evict-0', role: 'assistant', content: 'Ans 0', toolCalls: delegationCall, createdAt: 'now' },
    );
    expect((appCore as any).pendingRuns.has('a-evict-0')).toBe(true);

    for (let i = 1; i <= 50; i++) {
      await (appCore as any).stashOrchestratorRun(
        thread,
        { localId: `u-evict-${i}`, role: 'user', content: `Q ${i}`, createdAt: 'now' },
        { localId: `a-evict-${i}`, role: 'assistant', content: `Ans ${i}`, toolCalls: delegationCall, createdAt: 'now' },
      );
    }

    expect((appCore as any).pendingRuns.size).toBe(50);
    expect((appCore as any).pendingRuns.has('a-evict-0')).toBe(false);

    // Now the slow promise resolves — it must NOT re-insert 'a-evict-0' into pendingRuns
    resolveSlowProfile({
      name: 'OIM',
      orchestratorPlaybook: 'oim-orchestrator',
      reviewerPlaybook: 'oim-orchestrator-reviewer',
      specialistPlaybooks: ['oim-access-governance'],
    });
    await slowStash;
    expect((appCore as any).pendingRuns.has('a-evict-0')).toBe(false);
    expect((appCore as any).pendingRuns.size).toBe(50);
  });

  it('postOrchestratorRun only retries unambiguous pre-execution HTTP errors (401, 429, 502, 503), drops ambiguous (network, 500, 504, malformed 200 JSON) and 4xx (400, 403, 404) errors, enforces exponential backoff (5s->10s->20s->40s->60s) up to MAX_RUN_RETRY_ATTEMPTS = 5, caps failedRuns at 50, and drains atomically', async () => {
    const threadId = 'thread-orch-retry';
    const makeRun = (msgId: string): OrchestratorRunPayload => ({
      conversationId: threadId,
      messageId: msgId,
      profileName: 'OIM',
      status: 'completed',
      reviewRounds: 0,
      steps: [{ seq: 1, role: 'orchestrator', round: 0, playbookName: 'oim-orchestrator' }],
    });

    const recordSpy = vi.spyOn(appCore.syncClient, 'recordOrchestratorRun');

    // 1. Ambiguous errors (network TypeError, 500, 504, malformed 200 JSON) and 4xx client errors (400, 403, 404) are NOT pushed to failedRuns
    const nonRetriableErrors = [
      new TypeError('fetch failed'),
      new SyncApiError(500, 'Yvoke Backend: HTTP 500 Internal Server Error'),
      new SyncApiError(504, 'Yvoke Backend: HTTP 504 Gateway Timeout'),
      new Error('Yvoke Backend: Unexpected token < in JSON at position 0'),
      new SyncApiError(400, 'Yvoke Backend: HTTP 400'),
      new SyncApiError(403, 'Yvoke Backend: HTTP 403'),
      new SyncApiError(404, 'Yvoke Backend: HTTP 404'),
    ];
    for (let i = 0; i < nonRetriableErrors.length; i++) {
      recordSpy.mockRejectedValueOnce(nonRetriableErrors[i]);
      (appCore as any).postOrchestratorRun(makeRun(`msg-nonret-${i}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((appCore as any).failedRuns).toHaveLength(0);

    // 2. Unambiguous pre-execution HTTP errors (401, 429, 502, 503) ARE pushed to failedRuns as { run, attempts: 1, nextRetryAt }
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const retriableStatuses = [401, 429, 502, 503];
    for (let i = 0; i < retriableStatuses.length; i++) {
      const status = retriableStatuses[i];
      recordSpy.mockRejectedValueOnce(new SyncApiError(status, `Yvoke Backend: HTTP ${status}`));
      (appCore as any).postOrchestratorRun(makeRun(`msg-ret-${status}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((appCore as any).failedRuns).toHaveLength(4);
    for (let i = 0; i < retriableStatuses.length; i++) {
      expect((appCore as any).failedRuns[i]).toEqual({
        run: expect.objectContaining({ messageId: `msg-ret-${retriableStatuses[i]}` }),
        attempts: 1,
        nextRetryAt: now + 5_000,
      });
    }

    // 3. drainFailedRuns() does NOT retry an entry while Date.now() < entry.nextRetryAt
    recordSpy.mockClear();
    now += 4_999; // 1_004_999 < 1_005_000
    (appCore as any).drainFailedRuns();
    expect(recordSpy).not.toHaveBeenCalled();
    expect((appCore as any).failedRuns).toHaveLength(4);

    // 4. Atomic splice proof once Date.now() >= entry.nextRetryAt: concurrent handleServerIds + listThreads
    // while drain is in-flight must post each ready run exactly ONCE
    now += 1; // 1_005_000 >= 1_005_000
    let resolveInFlightPost!: (v: { id: string }) => void;
    recordSpy.mockImplementation(
      () =>
        new Promise((res) => {
          resolveInFlightPost = res;
        }),
    );
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValue([]);

    (appCore as any).handleServerIds(threadId, {});
    await appCore.listThreads();

    expect(recordSpy).toHaveBeenCalledTimes(4);
    expect((appCore as any).failedRuns).toHaveLength(0);
    resolveInFlightPost({ id: 'ok' });
    await new Promise((r) => setTimeout(r, 0));

    // 5. Exponential backoff (5_000 -> 10_000 -> 20_000 -> 40_000 -> 60_000) and drop after MAX_RUN_RETRY_ATTEMPTS = 5
    recordSpy.mockClear();
    recordSpy.mockRejectedValue(new SyncApiError(503, 'Service Unavailable'));
    const backoffRun = makeRun('msg-backoff');
    (appCore as any).postOrchestratorRun(backoffRun);
    await new Promise((r) => setTimeout(r, 0));

    const expectedDelays = [5_000, 10_000, 20_000, 40_000, 60_000];
    for (let attempt = 1; attempt <= expectedDelays.length; attempt++) {
      const delay = expectedDelays[attempt - 1];
      expect((appCore as any).failedRuns).toHaveLength(1);
      expect((appCore as any).failedRuns[0]).toEqual({
        run: backoffRun,
        attempts: attempt,
        nextRetryAt: now + delay,
      });

      // Before nextRetryAt: does not drain
      now += delay - 1;
      recordSpy.mockClear();
      (appCore as any).drainFailedRuns();
      expect(recordSpy).not.toHaveBeenCalled();
      expect((appCore as any).failedRuns).toHaveLength(1);

      // At nextRetryAt: drains and retries
      now += 1;
      (appCore as any).drainFailedRuns();
      expect(recordSpy).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 0));
    }

    // After the 5th retry fails (6 total attempts: 1 initial + 5 retries), entry is dropped!
    expect((appCore as any).failedRuns).toHaveLength(0);

    // 6. Verify failedRuns is capped at MAX_PENDING_RUNS = 50
    for (let i = 0; i < 60; i++) {
      (appCore as any).postOrchestratorRun(makeRun(`msg-cap-${i}`));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect((appCore as any).failedRuns).toHaveLength(50);
    expect((appCore as any).failedRuns[0].run.messageId).toBe('msg-cap-10');
    expect((appCore as any).failedRuns[49].run.messageId).toBe('msg-cap-59');
  });

  it('Finding 1: preserves web-owned remoteSettings across listThreads, createThread, patchThread (with single disk write), and blank-profile repair', async () => {
    const updateSpy = vi.spyOn(appCore.syncClient, 'updateConversation').mockResolvedValue(undefined);

    // 1. listThreads() captures web-owned keys from c.settings into remoteSettings
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-web-settings',
        title: 'Web Settings Thread',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:01:00.000Z',
        settings: {
          model: 'sonnet',
          'thinking-level': 'medium',
          'chat-prompt': 'custom',
          streaming: true,
          'show-thinking': true,
          'show-prototypes': false,
        },
      },
    ]);

    await appCore.listThreads();
    const loaded = appCore.threads.get('t-web-settings')!;
    expect(loaded.remoteSettings).toMatchObject({
      'chat-prompt': 'custom',
      streaming: true,
      'show-thinking': true,
      'show-prototypes': false,
    });

    // 2. Subsequent patchThread (changing model, thinkingLevel, or orchestratorProfile) sends all sibling keys intact
    // and calls threads.patch only ONCE per patchThread call
    const patchStoreSpy = vi.spyOn(appCore.threads, 'patch');

    appCore.patchThread('t-web-settings', { orchestratorProfile: 'OIM' });
    expect(patchStoreSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('t-web-settings', undefined, {
      'chat-prompt': 'custom',
      streaming: true,
      'show-thinking': true,
      'show-prototypes': false,
      model: 'sonnet',
      thinkingLevel: 'medium',
      'thinking-level': 'medium',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    patchStoreSpy.mockClear();
    appCore.patchThread('t-web-settings', { model: 'opus', thinkingLevel: 'high' });
    expect(patchStoreSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenLastCalledWith('t-web-settings', undefined, {
      'chat-prompt': 'custom',
      streaming: true,
      'show-thinking': true,
      'show-prototypes': false,
      model: 'opus',
      thinkingLevel: 'high',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // 3. listThreads() blank-profile repair also sends all sibling keys from c.settings intact in updateConversation
    updateSpy.mockClear();
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-web-settings',
        title: 'Web Settings Thread',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:02:00.000Z',
        settings: {
          model: 'opus',
          'thinking-level': 'high',
          'orchestrator-profile': '',
          'chat-prompt': 'custom-v2',
          streaming: false,
          'show-thinking': true,
          'show-prototypes': true,
        },
      },
    ]);

    await appCore.listThreads();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('t-web-settings', undefined, {
      'chat-prompt': 'custom-v2',
      streaming: false,
      'show-thinking': true,
      'show-prototypes': true,
      model: 'opus',
      thinkingLevel: 'high',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // 4. Server-authoritative remoteSettings key deletion: keys removed on the server are not resurrected
    updateSpy.mockClear();
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-web-settings',
        title: 'Web Settings Thread',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:03:00.000Z',
        settings: {
          model: 'opus',
          'thinking-level': 'high',
          'orchestrator-profile': 'OIM',
          streaming: false,
        },
      },
    ]);
    await appCore.listThreads();
    expect(appCore.threads.get('t-web-settings')?.remoteSettings).toEqual({
      model: 'opus',
      'thinking-level': 'high',
      'orchestrator-profile': 'OIM',
      streaming: false,
    });
    expect(appCore.threads.get('t-web-settings')?.remoteSettings).not.toHaveProperty('chat-prompt');

    updateSpy.mockClear();
    appCore.patchThread('t-web-settings', { thinkingLevel: 'low' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const afterDeleteSettings = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(afterDeleteSettings).not.toHaveProperty('chat-prompt');
    expect(afterDeleteSettings).not.toHaveProperty('show-thinking');

    // 5. createThread() captures conversation.settings into remoteSettings
    vi.spyOn(appCore.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 't-created-web',
      title: 'Created Thread',
      createdAt: '2026-10-15T10:05:00.000Z',
      updatedAt: '2026-10-15T10:05:00.000Z',
      settings: {
        model: 'sonnet',
        'thinking-level': 'medium',
        'chat-prompt': 'server-seeded',
      },
    });
    const created = await appCore.createThread();
    expect(created.remoteSettings).toEqual({
      model: 'sonnet',
      'thinking-level': 'medium',
      'chat-prompt': 'server-seeded',
    });
  });

  it('Finding 3: listThreads adopts remote orchestrator-profile only when unstarted and idle, locks started/busy threads, and repairs diverged server profiles', async () => {
    const updateSpy = vi.spyOn(appCore.syncClient, 'updateConversation').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(appCore.agent, 'closeThread');
    vi.spyOn(appCore.agent, 'isBusy').mockImplementation((id: string) => id === 't-busy-diverged');

    // Case 1 (unstarted): existing.orchestratorProfile is 'OIM' (truly unstarted: no sessionId/tokens/hasStarted) and server returns 'Security'
    appCore.threads.upsert({
      id: 't-adopt-diff-profile',
      title: 'Adopt Diff Profile',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      sessionId: undefined,
      sessionProfile: undefined,
    });

    // Case 2 (unstarted): existing.orchestratorProfile is undefined (truly unstarted single-agent) and server returns 'OIM'
    appCore.threads.upsert({
      id: 't-adopt-from-single',
      title: 'Adopt From Single',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: undefined,
      sessionId: undefined,
      sessionProfile: undefined,
    });

    // Case 3: existing.orchestratorProfile is 'OIM' and server returns '' (blank) -> keeps 'OIM' and repairs server
    appCore.threads.upsert({
      id: 't-repair-blank',
      title: 'Repair Blank Profile',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      sessionId: 'warm-keep',
      sessionProfile: 'OIM',
    });

    // Case 4 (started single-agent): hasStarted: true, initialPlaybook: 'oim-schema', warm session, server reports 'OIM'
    appCore.threads.upsert({
      id: 't-started-single-locked',
      title: 'Started Single Locked',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: 'oim-schema',
      orchestratorProfile: undefined,
      sessionId: 'warm-single-sess',
      sessionProfile: undefined,
    });

    // Case 5 (started multi-agent): hasStarted: true, orchestratorProfile: 'OIM', warm session, server reports 'Security'
    appCore.threads.upsert({
      id: 't-started-multi-locked',
      title: 'Started Multi Locked',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      orchestratorProfile: 'OIM',
      sessionId: 'warm-oim-sess',
      sessionProfile: 'OIM',
    });

    // Case 6 (started idle thread with mismatched sessionProfile): keeps 'OIM', closes stale session, clears sessionId/sessionProfile
    appCore.threads.upsert({
      id: 't-started-mismatch-session',
      title: 'Started Mismatch Session',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      hasStarted: true,
      orchestratorProfile: 'OIM',
      sessionId: 'stale-sess',
      sessionProfile: undefined,
    });

    // Case 7 (busy thread during listThreads when server reports differing profile): refuses adoption, does NOT close active session, repairs server
    appCore.threads.upsert({
      id: 't-busy-diverged',
      title: 'Busy Thread Diverged',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      sessionId: 'busy-sess',
      sessionProfile: undefined,
    });

    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-adopt-diff-profile',
        title: 'Adopt Diff Profile',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'Security' },
      },
      {
        id: 't-adopt-from-single',
        title: 'Adopt From Single',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'OIM' },
      },
      {
        id: 't-repair-blank',
        title: 'Repair Blank Profile',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': '' },
      },
      {
        id: 't-started-single-locked',
        title: 'Started Single Locked',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'OIM' },
      },
      {
        id: 't-started-multi-locked',
        title: 'Started Multi Locked',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'Security' },
      },
      {
        id: 't-started-mismatch-session',
        title: 'Started Mismatch Session',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'OIM' },
      },
      {
        id: 't-busy-diverged',
        title: 'Busy Thread Diverged',
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: '2026-10-15T10:05:00.000Z',
        settings: { model: 'sonnet', 'orchestrator-profile': 'Security' },
      },
    ]);

    await appCore.listThreads();

    // Case 1 assertions: unstarted thread adopted 'Security', called closeThread, did NOT call updateConversation
    const adoptedDiff = appCore.threads.get('t-adopt-diff-profile')!;
    expect(adoptedDiff.orchestratorProfile).toBe('Security');
    expect(adoptedDiff.sessionId).toBeUndefined();
    expect(adoptedDiff.sessionProfile).toBeUndefined();
    expect(closeSpy).toHaveBeenCalledWith('t-adopt-diff-profile');

    // Case 2 assertions: unstarted thread adopted 'OIM', called closeThread, did NOT call updateConversation
    const adoptedSingle = appCore.threads.get('t-adopt-from-single')!;
    expect(adoptedSingle.orchestratorProfile).toBe('OIM');
    expect(adoptedSingle.sessionId).toBeUndefined();
    expect(adoptedSingle.sessionProfile).toBeUndefined();
    expect(closeSpy).toHaveBeenCalledWith('t-adopt-from-single');

    // Case 3 assertions: kept 'OIM', preserved warm session, and repaired server
    const repaired = appCore.threads.get('t-repair-blank')!;
    expect(repaired.orchestratorProfile).toBe('OIM');
    expect(repaired.sessionId).toBe('warm-keep');
    expect(repaired.sessionProfile).toBe('OIM');
    expect(closeSpy).not.toHaveBeenCalledWith('t-repair-blank');
    expect(updateSpy).toHaveBeenCalledWith(
      't-repair-blank',
      undefined,
      expect.objectContaining({ 'orchestrator-profile': 'OIM' }),
    );

    // Case 4 assertions: started single-agent refused 'OIM', kept initialPlaybook + warm session, did NOT closeThread, repaired server to ''
    const startedSingle = appCore.threads.get('t-started-single-locked')!;
    expect(startedSingle.orchestratorProfile).toBeUndefined();
    expect(startedSingle.initialPlaybook).toBe('oim-schema');
    expect(startedSingle.sessionId).toBe('warm-single-sess');
    expect(closeSpy).not.toHaveBeenCalledWith('t-started-single-locked');
    expect(updateSpy).toHaveBeenCalledWith(
      't-started-single-locked',
      undefined,
      expect.objectContaining({ 'orchestrator-profile': '' }),
    );

    // Case 5 assertions: started multi-agent refused 'Security', kept 'OIM' + warm session, did NOT closeThread, repaired server to 'OIM'
    const startedMulti = appCore.threads.get('t-started-multi-locked')!;
    expect(startedMulti.orchestratorProfile).toBe('OIM');
    expect(startedMulti.sessionId).toBe('warm-oim-sess');
    expect(startedMulti.sessionProfile).toBe('OIM');
    expect(closeSpy).not.toHaveBeenCalledWith('t-started-multi-locked');
    expect(updateSpy).toHaveBeenCalledWith(
      't-started-multi-locked',
      undefined,
      expect.objectContaining({ 'orchestrator-profile': 'OIM' }),
    );

    // Case 6 assertions: started idle thread with mismatched sessionProfile kept 'OIM', closed stale session, cleared sessionId/sessionProfile
    const mismatchSession = appCore.threads.get('t-started-mismatch-session')!;
    expect(mismatchSession.orchestratorProfile).toBe('OIM');
    expect(mismatchSession.sessionId).toBeUndefined();
    expect(mismatchSession.sessionProfile).toBeUndefined();
    expect(closeSpy).toHaveBeenCalledWith('t-started-mismatch-session');

    // Case 7 assertions: busy thread refused 'Security', did NOT close active session, preserved sessionId, repaired server to 'OIM'
    const busyDiverged = appCore.threads.get('t-busy-diverged')!;
    expect(busyDiverged.orchestratorProfile).toBe('OIM');
    expect(busyDiverged.sessionId).toBe('busy-sess');
    expect(closeSpy).not.toHaveBeenCalledWith('t-busy-diverged');
    expect(updateSpy).toHaveBeenCalledWith(
      't-busy-diverged',
      undefined,
      expect.objectContaining({ 'orchestrator-profile': 'OIM' }),
    );

    // Total repairs: t-repair-blank, t-started-single-locked, t-started-multi-locked, t-busy-diverged
    expect(updateSpy).toHaveBeenCalledTimes(4);
  });

  it('Finding 8: playbookBackfillChecked memoizes transcript backfill across getMessages and sendMessage on started playbook-less threads', async () => {
    vi.spyOn(appCore.agent, 'sendMessage').mockResolvedValue(undefined as any);

    // Subcase A: getMessages(threadId) called at load time -> subsequent sendMessage makes 0 additional readMessages calls
    const threadLoaded = 't-memo-loaded';
    appCore.threads.upsert({
      id: threadLoaded,
      title: 'Loaded Playbook-Less Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: { ...ThreadStore.emptyTotals(), inputTokens: 10 },
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: undefined,
    });
    await appCore.threads.appendMessages(threadLoaded, [
      { localId: 'u-1', role: 'user', content: 'Turn 1 plain', createdAt: 'now' },
      { localId: 'a-1', role: 'assistant', content: 'Ans 1', createdAt: 'now' },
    ]);

    await appCore.getMessages(threadLoaded);

    const readSpy = vi.spyOn(appCore.threads, 'readMessages');
    await appCore.sendMessage({ threadId: threadLoaded, text: 'Turn 2 plain' });
    await appCore.sendMessage({ threadId: threadLoaded, text: 'Turn 3 plain' });
    expect(readSpy).toHaveBeenCalledTimes(0);

    // Subcase B: sendMessage called without prior getMessages -> first sendMessage calls readMessages once, second makes 0 additional calls
    const threadUnloaded = 't-memo-unloaded';
    appCore.threads.upsert({
      id: threadUnloaded,
      title: 'Unloaded Playbook-Less Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z',
      totals: { ...ThreadStore.emptyTotals(), inputTokens: 10 },
      syncState: 'synced',
      hasStarted: true,
      initialPlaybook: undefined,
    });
    await appCore.threads.appendMessages(threadUnloaded, [
      { localId: 'u-2', role: 'user', content: 'Turn 1 plain', createdAt: 'now' },
      { localId: 'a-2', role: 'assistant', content: 'Ans 1', createdAt: 'now' },
    ]);

    readSpy.mockClear();
    await appCore.sendMessage({ threadId: threadUnloaded, text: 'Turn 2 plain' });
    expect(readSpy).toHaveBeenCalledTimes(1);

    await appCore.sendMessage({ threadId: threadUnloaded, text: 'Turn 3 plain' });
    expect(readSpy).toHaveBeenCalledTimes(1); // 0 additional calls
  });
});

describe('AppCore - Creation-Time desktopVersion Stamping & Preservation', () => {
  let tmpDir: string;
  const activeCores: AppCore[] = [];

  function makeCore(appVersion?: string): AppCore {
    const core = new AppCore({
      userDataDir: tmpDir,
      emitAgentEvent: vi.fn(),
      emitSyncEvent: vi.fn(),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
      ...(appVersion !== undefined ? { appVersion } : {}),
    });
    activeCores.push(core);
    return core;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-desktop-version-test-'));
  });

  afterEach(async () => {
    while (activeCores.length > 0) {
      const core = activeCores.pop()!;
      await core.drain();
      core.dispose();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stamps desktopVersion from package.json fallback when appVersion is omitted and preserves trimmed appVersion verbatim (including v/V prefixes and 256-char boundary)', async () => {
    // 1. Default fallback to package.json version when appVersion is omitted
    const defaultCore = makeCore();
    const defaultSettings = defaultCore.settings.get();
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    ) as { version: string };
    const createSpyDefault = vi.spyOn(defaultCore.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 't-default-ver',
      title: 'Default Ver',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      settings: {
        model: defaultSettings.defaultModel,
        'thinking-level': defaultSettings.defaultThinkingLevel,
        client: 'desktop',
        desktopVersion: pkg.version,
      },
    });

    await defaultCore.createThread();
    expect(createSpyDefault).toHaveBeenCalledWith(null, {
      model: defaultSettings.defaultModel,
      thinkingLevel: defaultSettings.defaultThinkingLevel,
      'thinking-level': defaultSettings.defaultThinkingLevel,
      client: 'desktop',
      desktopVersion: pkg.version,
    });

    // 2. Preserves trimmed appVersion verbatim (no leading 'v'/'V' stripping) up to 256 trimmed chars
    const verbatimCases: Array<{ raw: string; expected: string }> = [
      { raw: '1.3.1', expected: '1.3.1' },
      { raw: ' 1.3.1 ', expected: '1.3.1' },
      { raw: 'v1.3.1', expected: 'v1.3.1' },
      { raw: ' V1.3.1 ', expected: 'V1.3.1' },
      { raw: 'Version 1.3.1', expected: 'Version 1.3.1' },
      { raw: 'v', expected: 'v' },
      { raw: '  ' + '1'.repeat(256) + '\t', expected: '1'.repeat(256) },
    ];
    for (let idx = 0; idx < verbatimCases.length; idx++) {
      const { raw, expected } = verbatimCases[idx];
      const core = makeCore(raw);
      const spy = vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
        id: `t-verbatim-${idx}`,
        title: 'Verbatim',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      } as unknown as ConversationDto);
      const created = await core.createThread();
      expect(spy).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          desktopVersion: expected,
        }),
      );
      expect(created.remoteSettings).toEqual({ client: 'desktop', desktopVersion: expected });
    }
  });

  it('omits desktopVersion on createThread and patchThread and seeds fallback remoteSettings with client: desktop when appVersion is blank, non-string, or > 256 trimmed chars', async () => {
    const omittedInputs: string[] = [
      '',
      '   ',
      '\t\n',
      123 as unknown as string,
      '1'.repeat(257),
      ' ' + '1'.repeat(257) + ' ',
    ];
    for (let idx = 0; idx < omittedInputs.length; idx++) {
      const core = makeCore(omittedInputs[idx]);
      const createSpy = vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
        id: `t-omitted-${idx}`,
        title: 'Omitted Ver',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      } as unknown as ConversationDto);
      const updateSpy = vi.spyOn(core.syncClient, 'updateConversation').mockResolvedValue(undefined);

      const created = await core.createThread();
      expect(createSpy).toHaveBeenCalledTimes(1);
      const sentSettings = createSpy.mock.calls[0][1] as Record<string, unknown>;
      expect('desktopVersion' in sentSettings).toBe(false);
      expect(created.remoteSettings).toEqual({ client: 'desktop' });

      core.patchThread(created.id, { title: 'Renamed' });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const patchedSettings = updateSpy.mock.calls[0][2] as Record<string, unknown>;
      expect('desktopVersion' in patchedSettings).toBe(false);
    }
  });

  it('createThread -> patchThread round-trip retains desktopVersion whether server omits or echoes settings', async () => {
    const core = makeCore('1.3.1');
    const updateSpy = vi.spyOn(core.syncClient, 'updateConversation').mockResolvedValue(undefined);

    // Case A: Server response omits settings (e.g. minimal mock) -> seeds remoteSettings: { client: 'desktop', desktopVersion: '1.3.1' }
    vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 't-no-echo',
      title: 'New Conversation',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      settings: undefined,
    } as unknown as ConversationDto);

    const createdNoEcho = await core.createThread();
    expect(createdNoEcho.remoteSettings).toEqual({ client: 'desktop', desktopVersion: '1.3.1' });

    core.patchThread(createdNoEcho.id, { title: 'Renamed' });
    expect(updateSpy).toHaveBeenLastCalledWith(
      't-no-echo',
      'Renamed',
      expect.objectContaining({
        desktopVersion: '1.3.1',
        client: 'desktop',
      }),
    );

    // Case B: Server response echoes settings -> copies authoritative server settings
    vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 't-echoed',
      title: 'New Conversation',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      settings: {
        model: 'sonnet',
        'thinking-level': 'medium',
        client: 'desktop',
        desktopVersion: '1.3.1',
        'chat-prompt': 'corp-default',
      },
    });

    const createdEchoed = await core.createThread();
    expect(createdEchoed.remoteSettings).toEqual({
      model: 'sonnet',
      'thinking-level': 'medium',
      client: 'desktop',
      desktopVersion: '1.3.1',
      'chat-prompt': 'corp-default',
    });

    core.patchThread(createdEchoed.id, { thinkingLevel: 'high' });
    expect(updateSpy).toHaveBeenLastCalledWith(
      't-echoed',
      undefined,
      expect.objectContaining({
        desktopVersion: '1.3.1',
        'chat-prompt': 'corp-default',
        'thinking-level': 'high',
      }),
    );
  });

  it('preserves original creation desktopVersion across app upgrades in patchThread and listThreads repair, and keeps legacy threads unversioned', async () => {
    const core = makeCore('1.3.1');
    const updateSpy = vi.spyOn(core.syncClient, 'updateConversation').mockResolvedValue(undefined);

    // 1. Existing thread created on 1.2.0: patchThread on 1.3.1 preserves 1.2.0 (never overwrites with 1.3.1)
    core.threads.upsert({
      id: 't-created-120',
      title: 'Created on 1.2.0',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      remoteSettings: { desktopVersion: '1.2.0', customFlag: true },
    });

    core.patchThread('t-created-120', { model: 'opus' });
    expect(updateSpy).toHaveBeenLastCalledWith('t-created-120', undefined, {
      desktopVersion: '1.2.0',
      customFlag: true,
      model: 'opus',
      thinkingLevel: 'medium',
      'thinking-level': 'medium',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // 2. listThreads() profile repair on thread with remote settings { desktopVersion: '1.2.0' } preserves 1.2.0
    updateSpy.mockClear();
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-created-120',
        title: 'Created on 1.2.0',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:05:00.000Z',
        settings: {
          desktopVersion: '1.2.0',
          model: 'opus',
          'thinking-level': 'medium',
          // missing orchestrator-profile triggers repair
        },
      },
    ]);

    await core.listThreads();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith('t-created-120', undefined, {
      desktopVersion: '1.2.0',
      model: 'opus',
      thinkingLevel: 'medium',
      'thinking-level': 'medium',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });

    // 3. Legacy conversation without desktopVersion stays unversioned on both patchThread and listThreads repair
    core.threads.upsert({
      id: 't-legacy-unversioned',
      title: 'Legacy Thread',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      remoteSettings: { customFlag: true },
    });

    updateSpy.mockClear();
    core.patchThread('t-legacy-unversioned', { thinkingLevel: 'high' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const patchedLegacySettings = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect('desktopVersion' in patchedLegacySettings).toBe(false);
    expect(patchedLegacySettings).toMatchObject({
      customFlag: true,
      thinkingLevel: 'high',
      'thinking-level': 'high',
    });

    updateSpy.mockClear();
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      {
        id: 't-legacy-unversioned',
        title: 'Legacy Thread',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:05:00.000Z',
        settings: {
          customFlag: true,
          model: 'sonnet',
          // missing orchestrator-profile triggers repair
        },
      },
    ]);

    await core.listThreads();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const repairedLegacySettings = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect('desktopVersion' in repairedLegacySettings).toBe(false);
    expect(repairedLegacySettings).toMatchObject({
      customFlag: true,
      'orchestrator-profile': 'OIM',
    });

    // 4. Local legacy conversation with remoteSettings: undefined stays unversioned on patchThread
    core.threads.upsert({
      id: 't-legacy-no-remote-settings',
      title: 'Legacy Without Remote Settings',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      remoteSettings: undefined,
    });

    updateSpy.mockClear();
    const patchedNoRemote = core.patchThread('t-legacy-no-remote-settings', { thinkingLevel: 'high' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const patchedNoRemoteSettings = updateSpy.mock.calls[0][2] as Record<string, unknown>;
    expect('desktopVersion' in patchedNoRemoteSettings).toBe(false);
    expect('desktopVersion' in (patchedNoRemote?.remoteSettings ?? {})).toBe(false);
    expect('desktopVersion' in (core.threads.get('t-legacy-no-remote-settings')?.remoteSettings ?? {})).toBe(false);
  });
});

describe('Wave 2: Startup Conversation & Message Sync Recovery', () => {
  let tmpDir: string;
  const activeCores: AppCore[] = [];

  function makeCore(opts?: {
    dir?: string;
    appVersion?: string;
    onSyncEvent?: (event: SyncEvent) => void;
  }): { core: AppCore; syncEvents: SyncEvent[] } {
    const syncEvents: SyncEvent[] = [];
    const core = new AppCore({
      userDataDir: opts?.dir ?? tmpDir,
      appVersion: opts?.appVersion ?? '1.3.1',
      emitAgentEvent: vi.fn(),
      emitSyncEvent: (ev) => {
        syncEvents.push(ev);
        opts?.onSyncEvent?.(ev);
      },
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
    activeCores.push(core);
    return { core, syncEvents };
  }

  function makeThreadMeta(overrides: Partial<ThreadMeta> & { id: string }): ThreadMeta {
    return {
      title: 'New Conversation',
      model: 'sonnet',
      thinkingLevel: 'medium',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
      totals: ThreadStore.emptyTotals(),
      syncState: 'synced',
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-wave2-test-'));
  });

  afterEach(async () => {
    while (activeCores.length > 0) {
      const core = activeCores.pop()!;
      await core.drain();
      core.dispose();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('performs zero network calls in new AppCore(), holds ONLY startup thread IDs, and hydrates offline pendingSyncCount without double-counting', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    // 1. Seed t-queued in both sync-queue.json AND t-queued.jsonl (must count as 1, not 2!)
    fs.writeFileSync(
      path.join(tmpDir, 'sync-queue.json'),
      JSON.stringify([
        {
          threadId: 't-queued',
          localIds: ['q-u1', 'q-a1'],
          messages: [
            { role: 'user', content: 'Queued question' },
            { role: 'assistant', content: 'Queued answer' },
          ],
          enqueuedAt: '2026-10-10T10:00:05.000Z',
          attempts: 0,
        },
      ]),
    );
    fs.writeFileSync(
      path.join(threadsDir, 't-queued.jsonl'),
      [
        JSON.stringify({ localId: 'q-u1', role: 'user', content: 'Queued question', createdAt: '2026-10-10T10:00:00.000Z' }),
        JSON.stringify({ localId: 'q-a1', role: 'assistant', content: 'Queued answer', createdAt: '2026-10-10T10:00:05.000Z' }),
      ].join('\n') + '\n',
    );

    // 2. Seed orphan t-orphan-unsynced.jsonl (absent from index.json and sync-queue.json: 1 pair + 1 singleton = 2 unqueued turns)
    fs.writeFileSync(
      path.join(threadsDir, 't-orphan-unsynced.jsonl'),
      [
        JSON.stringify({
          localId: 'o-u0',
          serverId: 'srv-0u',
          role: 'user',
          content: 'Synced turn',
          playbook: 'oim-schema',
          createdAt: '2026-10-10T09:00:00.000Z',
        }),
        JSON.stringify({
          localId: 'o-a0',
          serverId: 'srv-0a',
          role: 'assistant',
          content: 'Synced reply',
          createdAt: '2026-10-10T09:00:05.000Z',
        }),
        JSON.stringify({
          localId: 'o-u1',
          role: 'user',
          content: 'Unsynced pair user',
          createdAt: '2026-10-10T09:05:00.000Z',
        }),
        JSON.stringify({
          localId: 'o-a1',
          role: 'assistant',
          content: 'Unsynced pair assistant',
          createdAt: '2026-10-10T09:05:05.000Z',
        }),
        JSON.stringify({
          localId: 'o-u2',
          role: 'user',
          content: 'Unsynced singleton user',
          createdAt: '2026-10-10T09:06:00.000Z',
        }),
      ].join('\n') + '\n',
    );

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { core } = makeCore();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Scoped startup hold: t-queued and t-orphan-unsynced ARE held; arbitrary non-startup IDs are NOT held
    expect(core.syncQueue.isHeld('t-queued')).toBe(true);
    expect(core.syncQueue.isHeld('t-orphan-unsynced')).toBe(true);
    expect(core.syncQueue.isHeld('brand-new-id')).toBe(false);

    // Offline / signed-out Entra startup: listConversations rejects
    vi.spyOn(core.syncClient, 'listConversations').mockRejectedValueOnce(new Error('Entra: Sign-in required'));
    const offlineRes = await core.listThreads();
    expect(offlineRes.serverReachable).toBe(false);
    expect(offlineRes.pendingSyncCount).toBe(3); // 1 queued + 2 unqueued (zero double-counting!)
    expect(offlineRes.threads.map((t) => t.id)).toEqual(
      expect.arrayContaining(['t-queued', 't-orphan-unsynced']),
    );
    expect(core.threads.get('t-orphan-unsynced')?.initialPlaybook).toBe('oim-schema');

    // Newly created thread via createThread() is never held
    vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 't-fresh',
      title: 'New Conversation',
      createdAt: '2026-10-11T10:00:00.000Z',
      updatedAt: '2026-10-11T10:00:00.000Z',
      settings: { client: 'desktop' },
    });
    const created = await core.createThread();
    expect(core.syncQueue.isHeld(created.id)).toBe(false);
  });

  it('steady-state startup with 200 clean synced conversations makes 0 GET /messages calls, skips image blob hydration, and unholds immediately', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    const indexMap: Record<string, ThreadMeta> = {};
    const remoteList: ConversationDto[] = [];

    for (let i = 1; i <= 200; i += 1) {
      const id = `clean-${i}`;
      const meta = makeThreadMeta({
        id,
        title: `Clean Topic ${i}`,
        hasStarted: true,
        remoteSettings: { client: 'desktop' },
      });
      indexMap[id] = meta;
      remoteList.push({
        id,
        title: `Clean Topic ${i}`,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        settings: { client: 'desktop' },
      });
      // Write synced .jsonl referencing a non-existent blob file to prove zero image blob reads!
      fs.writeFileSync(
        path.join(threadsDir, `${id}.jsonl`),
        [
          JSON.stringify({
            localId: `${id}-u1`,
            serverId: `srv-${id}-u1`,
            role: 'user',
            content: `Question ${i}`,
            images: [{ id: 'img1', mediaType: 'image/png', name: 'missing.png', file: 'nonexistent.png' }],
            createdAt: meta.createdAt,
          }),
          JSON.stringify({
            localId: `${id}-a1`,
            serverId: `srv-${id}-a1`,
            role: 'assistant',
            content: `Answer ${i}`,
            createdAt: meta.updatedAt,
          }),
        ].join('\n') + '\n',
      );
    }
    fs.writeFileSync(path.join(threadsDir, 'index.json'), JSON.stringify(indexMap));

    const { core } = makeCore();
    expect(core.syncQueue.isHeld('clean-1')).toBe(true);
    expect(core.syncQueue.isHeld('clean-200')).toBe(true);

    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce(remoteList);
    const getMsgsSpy = vi.spyOn(core.syncClient, 'getMessages');
    const getAllMsgsSpy = vi.spyOn(core.syncClient, 'getAllMessages');

    const res = await core.listThreads();
    await core.waitForStartupTasks();

    expect(res.serverReachable).toBe(true);
    expect(res.pendingSyncCount).toBe(0);
    expect(res.threads).toHaveLength(200);
    expect(getMsgsSpy).not.toHaveBeenCalled();
    expect(getAllMsgsSpy).not.toHaveBeenCalled();
    expect(core.syncQueue.isHeld('clean-1')).toBe(false);
    expect(core.syncQueue.isHeld('clean-200')).toBe(false);
  });

  it('deduplicates pre-crash committed turns on 200 OK and backfills trailing unsynced .jsonl turns alongside ratings and multi-agent traces', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    const dedupMeta = makeThreadMeta({ id: 't-dedup', title: 'Dedup Topic', hasStarted: true });
    const backfillMeta = makeThreadMeta({
      id: 't-backfill',
      title: 'Backfill Orch Topic',
      orchestratorProfile: 'OIM',
      hasStarted: true,
    });
    fs.writeFileSync(
      path.join(threadsDir, 'index.json'),
      JSON.stringify({ 't-dedup': dedupMeta, 't-backfill': backfillMeta }),
    );

    // t-dedup: [d-u1, d-a1] in .jsonl without serverId AND in sync-queue.json, already committed on server
    fs.writeFileSync(
      path.join(threadsDir, 't-dedup.jsonl'),
      [
        JSON.stringify({ localId: 'd-u1', role: 'user', content: 'Pre-crash Q', createdAt: '2026-10-10T10:00:00.000Z' }),
        JSON.stringify({ localId: 'd-a1', role: 'assistant', content: 'Pre-crash A', createdAt: '2026-10-10T10:00:05.000Z' }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'sync-queue.json'),
      JSON.stringify([
        {
          threadId: 't-dedup',
          localIds: ['d-u1', 'd-a1'],
          messages: [
            { role: 'user', content: 'Pre-crash Q' },
            { role: 'assistant', content: 'Pre-crash A' },
          ],
          enqueuedAt: '2026-10-10T10:00:05.000Z',
          attempts: 0,
        },
      ]),
    );

    // t-backfill: synced [b-u0, b-a0] + trailing unsynced [b-u1, b-a1] with rating & Agent delegation
    fs.writeFileSync(
      path.join(threadsDir, 't-backfill.jsonl'),
      [
        JSON.stringify({ localId: 'b-u0', serverId: 'srv-b0u', role: 'user', content: 'Synced Q0', createdAt: '2026-10-10T09:00:00.000Z' }),
        JSON.stringify({ localId: 'b-a0', serverId: 'srv-b0a', role: 'assistant', content: 'Synced A0', createdAt: '2026-10-10T09:00:05.000Z' }),
        JSON.stringify({ localId: 'b-u1', role: 'user', content: 'Trailing Q1', createdAt: '2026-10-10T09:10:00.000Z' }),
        JSON.stringify({
          localId: 'b-a1',
          role: 'assistant',
          content: 'Trailing A1',
          feedback: { rating: 1, comment: 'Spot on' },
          toolCalls: [
            {
              id: 'tc-agent-1',
              name: 'Agent',
              subagentType: 'oim-access-governance',
              input: { prompt: 'Investigate Q1' },
              result: 'Specialist result',
            },
          ],
          createdAt: '2026-10-10T09:10:10.000Z',
        }),
      ].join('\n') + '\n',
    );

    const { core } = makeCore();
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      { id: 't-dedup', title: 'Dedup Topic', createdAt: dedupMeta.createdAt, updatedAt: dedupMeta.updatedAt, settings: {} },
      { id: 't-backfill', title: 'Backfill Orch Topic', createdAt: backfillMeta.createdAt, updatedAt: backfillMeta.updatedAt, settings: { 'orchestrator-profile': 'OIM' } },
    ]);
    vi.spyOn(core.syncClient, 'getOrchestratorProfiles').mockResolvedValue([
      { name: 'OIM', orchestratorPlaybook: 'oim-orch', reviewerPlaybook: 'oim-rev', specialistPlaybooks: ['oim-access-governance'] },
    ]);
    vi.spyOn(core.mcpPrompts, 'list').mockResolvedValue([
      { name: 'oim-orch', title: 'Orch', description: '', arguments: [], version: 2 },
      { name: 'oim-access-governance', title: 'Spec', description: '', arguments: [], version: 5 },
    ]);

    vi.spyOn(core.syncClient, 'getAllMessages').mockImplementation(async (convId) => {
      if (convId === 't-dedup') {
        return {
          truncated: false,
          messages: [
            {
              id: 'srv-du1',
              role: 'user',
              content: 'Pre-crash Q',
              playbook: null,
              playbookVersion: null,
              promptTokens: null,
              completionTokens: null,
              totalTokens: null,
              cachedTokens: null,
              thoughtTokens: null,
              feedbackRating: null,
              feedbackComment: null,
              createdAt: '2026-10-10T10:00:00.000Z',
            },
            {
              id: 'srv-da1',
              role: 'assistant',
              content: 'Pre-crash A',
              playbook: null,
              playbookVersion: null,
              promptTokens: null,
              completionTokens: null,
              totalTokens: null,
              cachedTokens: null,
              thoughtTokens: null,
              feedbackRating: null,
              feedbackComment: null,
              createdAt: '2026-10-10T10:00:05.000Z',
            },
          ],
        };
      }
      return {
        truncated: false,
        messages: [
          {
            id: 'srv-b0u',
            role: 'user',
            content: 'Synced Q0',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T09:00:00.000Z',
          },
          {
            id: 'srv-b0a',
            role: 'assistant',
            content: 'Synced A0',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T09:00:05.000Z',
          },
        ],
      };
    });

    const appendSpy = vi.spyOn(core.syncClient, 'appendMessages').mockResolvedValue({
      ids: ['srv-b1u', 'srv-b1a'],
    });
    const feedbackSpy = vi.spyOn(core.syncClient, 'submitFeedback').mockImplementation(async (messageId, rating, comment) => ({
      messageId,
      rating,
      comment: comment ?? null,
    }));
    const runSpy = vi.spyOn(core.syncClient, 'recordOrchestratorRun').mockResolvedValue({ id: 'run-backfill-1' });

    await core.listThreads();
    await core.waitForStartupTasks();
    // Wait for async trace assembly / feedback promises triggered on handleServerIds
    await vi.waitFor(() => {
      expect(feedbackSpy).toHaveBeenCalledWith('srv-b1a', 1, 'Spot on');
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    // t-dedup did NOT append duplicate messages, and adopted serverIds locally
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      't-backfill',
      expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'Trailing Q1' })]),
    );
    const dedupStored = await core.threads.readRawMessages('t-dedup');
    expect(dedupStored.map((m) => m.serverId)).toEqual(['srv-du1', 'srv-da1']);
    expect(core.syncQueue.pendingCount()).toBe(0);

    const postedRun = runSpy.mock.calls[0][0];
    expect(postedRun.conversationId).toBe('t-backfill');
    expect(postedRun.messageId).toBe('srv-b1a');
  });

  it('preserves off-page #201+ conversation (200 OK) with transcript, SearchIndex hits, and sessionId while pruning unopened header-only entries', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    const offPageMeta = makeThreadMeta({
      id: 't-201-cached',
      title: 'Deep History Conversation',
      sessionId: 'claude-sess-201',
      hasStarted: true,
    });
    const headerOnlyMeta = makeThreadMeta({
      id: 't-202-header-only',
      title: 'Unopened Old Header',
    });
    fs.writeFileSync(
      path.join(threadsDir, 'index.json'),
      JSON.stringify({ 't-201-cached': offPageMeta, 't-202-header-only': headerOnlyMeta }),
    );
    fs.writeFileSync(
      path.join(threadsDir, 't-201-cached.jsonl'),
      [
        JSON.stringify({
          localId: 'm201-u',
          serverId: 'srv-201-u',
          role: 'user',
          content: 'kerberos ticket delegation detail',
          createdAt: '2026-06-01T10:00:00.000Z',
        }),
        JSON.stringify({
          localId: 'm201-a',
          serverId: 'srv-201-a',
          role: 'assistant',
          content: 'Configured via SPN constrained delegation.',
          createdAt: '2026-06-01T10:00:05.000Z',
        }),
      ].join('\n') + '\n',
    );

    const { core } = makeCore();
    await core.searchIndex.refresh();

    // Server top-200 list omits both t-201-cached and t-202-header-only
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue([
      { id: 't-top-1', title: 'Recent 1', createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z', settings: {} },
    ]);
    const getAllMsgsSpy = vi.spyOn(core.syncClient, 'getAllMessages').mockResolvedValue({
      truncated: false,
      messages: [
        {
          id: 'srv-201-u',
          role: 'user',
          content: 'kerberos ticket delegation detail',
          playbook: null,
          playbookVersion: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cachedTokens: null,
          thoughtTokens: null,
          feedbackRating: null,
          feedbackComment: null,
          createdAt: '2026-06-01T10:00:00.000Z',
        },
        {
          id: 'srv-201-a',
          role: 'assistant',
          content: 'Configured via SPN constrained delegation.',
          playbook: null,
          playbookVersion: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cachedTokens: null,
          thoughtTokens: null,
          feedbackRating: null,
          feedbackComment: null,
          createdAt: '2026-06-01T10:00:05.000Z',
        },
      ],
    });

    await core.listThreads();
    await core.waitForStartupTasks();

    // Unopened header-only thread pruned; #201+ cached thread preserved!
    expect(core.threads.get('t-202-header-only')).toBeUndefined();
    expect(core.threads.get('t-201-cached')?.sessionId).toBe('claude-sess-201');
    expect(await core.threads.readMessages('t-201-cached')).toHaveLength(2);
    expect((await core.searchThreads('kerberos')).map((h) => h.threadId)).toEqual(['t-201-cached']);
    expect(getAllMsgsSpy).toHaveBeenCalledTimes(1);

    // Second listThreads() does NOT re-probe verifiedOffPageThreads
    await core.listThreads();
    await core.waitForStartupTasks();
    expect(getAllMsgsSpy).toHaveBeenCalledTimes(1);
    expect(core.threads.get('t-201-cached')?.sessionId).toBe('claude-sess-201');
  });

  it('always recreates missing 404 conversations (startup, mid-session, and runtime appendMessages 404), preserves/omits desktopVersion accurately, and resolves transitive oldId -> midId -> newId migrations', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    // Part A: Versioned orchestrator thread (v1.2.0) with placeholder title on upgraded 1.3.1 app
    const oldOrch = makeThreadMeta({
      id: 'old-orch',
      title: 'New Conversation',
      sessionId: 'warm-orch-sess',
      sessionProfile: 'OIM',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      remoteSettings: { desktopVersion: 'v1.2.0', 'chat-prompt': 'corp-default', client: 'desktop' },
    });
    // Part B: Legacy unversioned thread (no desktopVersion) with custom title
    const legacyOld = makeThreadMeta({
      id: 'legacy-old',
      title: 'OIM Sizing',
      sessionId: 'warm-legacy-sess',
      hasStarted: true,
      remoteSettings: { customLegacyKey: 'yes' },
    });
    fs.writeFileSync(
      path.join(threadsDir, 'index.json'),
      JSON.stringify({ 'old-orch': oldOrch, 'legacy-old': legacyOld }),
    );
    fs.writeFileSync(
      path.join(threadsDir, 'old-orch.jsonl'),
      [
        JSON.stringify({
          localId: 'ou-1',
          serverId: 'dead-srv-1',
          role: 'user',
          content: 'Analyze OIM roles',
          createdAt: '2026-10-01T10:00:00.000Z',
        }),
        JSON.stringify({
          localId: 'oa-1',
          serverId: 'dead-srv-2',
          role: 'assistant',
          content: 'Role analysis complete.',
          feedback: { rating: -1, comment: 'Needs more detail' },
          toolCalls: [
            { id: 'tc-1', name: 'Agent', subagentType: 'oim-access-governance', input: { prompt: 'roles' }, result: 'ok' },
          ],
          createdAt: '2026-10-01T10:00:10.000Z',
        }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(threadsDir, 'legacy-old.jsonl'),
      [
        JSON.stringify({
          localId: 'lu-1',
          serverId: 'dead-leg-1',
          role: 'user',
          content: 'Sizing question',
          createdAt: '2026-09-01T10:00:00.000Z',
        }),
        JSON.stringify({
          localId: 'la-1',
          serverId: 'dead-leg-2',
          role: 'assistant',
          content: 'Sizing answer',
          createdAt: '2026-09-01T10:00:05.000Z',
        }),
      ].join('\n') + '\n',
    );

    // Also seed a queue-only turn on old-orch (absent from old-orch.jsonl) to verify SearchIndex indexes extraMessages!
    fs.writeFileSync(
      path.join(tmpDir, 'sync-queue.json'),
      JSON.stringify([
        {
          threadId: 'old-orch',
          localIds: ['qo-u1', 'qo-a1'],
          messages: [
            { role: 'user', content: 'QueueOnlyUniqueTokenXyz question' },
            { role: 'assistant', content: 'QueueOnlyUniqueTokenXyz answer' },
          ],
          enqueuedAt: '2026-10-01T10:01:00.000Z',
          attempts: 0,
        },
      ]),
    );

    const { core, syncEvents } = makeCore({ appVersion: '1.3.1' });
    await core.searchIndex.refresh();

    const closeSpy = vi.spyOn(core.agent, 'closeThread');
    vi.spyOn(core.syncClient, 'getOrchestratorProfiles').mockResolvedValue([
      { name: 'OIM', orchestratorPlaybook: 'oim-orch', reviewerPlaybook: 'oim-rev', specialistPlaybooks: ['oim-access-governance'] },
    ]);
    vi.spyOn(core.mcpPrompts, 'list').mockResolvedValue([]);

    // Startup: server knows neither old-orch nor legacy-old -> both return 404 on getAllMessages
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue([]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockRejectedValue(new SyncApiError(404, 'Yvoke Backend: 404 Not Found'));

    let createSeq = 0;
    const createIds = ['new-orch', 'mid-leg', 'final-leg'];
    const createSpy = vi.spyOn(core.syncClient, 'createConversation').mockImplementation(async (title, settings) => {
      const id = createIds[createSeq++] ?? `gen-${createSeq}`;
      return {
        id,
        title: title ?? 'New Conversation',
        createdAt: '2026-10-12T10:00:00.000Z',
        updatedAt: '2026-10-12T10:00:00.000Z',
        settings: { ...settings },
      };
    });

    let appendSeq = 1;
    vi.spyOn(core.syncClient, 'appendMessages').mockImplementation(async (convId, msgs) => {
      // Simulate runtime 404 when sending a new turn onto mid-leg -> triggers chained mid-leg -> final-leg!
      if (convId === 'mid-leg' && msgs.some((m) => m.content === 'Follow-up on migrated thread')) {
        throw new SyncApiError(404, 'Yvoke Backend: 404 Not Found');
      }
      return { ids: msgs.map(() => `recreated-srv-${appendSeq++}`) };
    });
    const feedbackSpy = vi.spyOn(core.syncClient, 'submitFeedback').mockImplementation(async (messageId, rating, comment) => ({
      messageId,
      rating,
      comment: comment ?? null,
    }));
    const runSpy = vi.spyOn(core.syncClient, 'recordOrchestratorRun').mockResolvedValue({ id: 'rec-run-1' });

    await core.listThreads();
    await core.waitForStartupTasks();

    await vi.waitFor(() => {
      expect(feedbackSpy).toHaveBeenCalledTimes(1);
      expect(runSpy).toHaveBeenCalledTimes(1);
    });

    // Verify Part A (old-orch -> new-orch): placeholder title normalized to null, v1.2.0 preserved (NOT 1.3.1!)
    const orchCreateCall = createSpy.mock.calls.find((c) => c[0] === null)!;
    expect(orchCreateCall).toBeDefined();
    expect(orchCreateCall[1]).toMatchObject({
      desktopVersion: 'v1.2.0',
      'chat-prompt': 'corp-default',
      'orchestrator-profile': 'OIM',
      client: 'desktop',
    });
    expect(closeSpy).toHaveBeenCalledWith('old-orch');
    expect(core.threads.get('old-orch')).toBeUndefined();
    expect(core.threads.get('new-orch')?.sessionId).toBe('warm-orch-sess');
    expect((await core.searchThreads('Analyze')).map((h) => h.threadId)).toEqual(['new-orch']);
    // Queue-only extraMessages are searchable BOTH immediately after 404 migration AND after a SearchIndex refresh sweep!
    expect((await core.searchThreads('QueueOnlyUniqueTokenXyz')).map((h) => h.threadId)).toEqual(['new-orch']);
    await core.searchIndex.refresh();
    expect((await core.searchThreads('QueueOnlyUniqueTokenXyz')).map((h) => h.threadId)).toEqual(['new-orch']);
    expect(syncEvents.some((e) => e.kind === 'thread-migrated' && e.oldThreadId === 'old-orch' && e.thread.id === 'new-orch')).toBe(true);

    // Verify Part B (legacy-old -> mid-leg): custom title 'OIM Sizing' kept, desktopVersion OMITTED (never stamped with 1.3.1!)
    const legCreateCall = createSpy.mock.calls.find((c) => c[0] === 'OIM Sizing')!;
    expect(legCreateCall).toBeDefined();
    expect('desktopVersion' in (legCreateCall[1] ?? {})).toBe(false);
    expect(legCreateCall[1]).toMatchObject({ customLegacyKey: 'yes' });

    // Trigger runtime 404 on mid-leg -> chains legacy-old -> mid-leg -> final-leg!
    (core as any).persistTurn(
      'legacy-old',
      { localId: 'lu-2', role: 'user', content: 'Follow-up on migrated thread', createdAt: '2026-10-12T10:05:00.000Z' },
      { localId: 'la-2', role: 'assistant', content: 'Follow-up reply', createdAt: '2026-10-12T10:05:05.000Z' },
    );
    await core.drain();
    await core.syncQueue.flush();

    expect(core.threads.get('mid-leg')).toBeUndefined();
    expect(core.threads.get('final-leg')).toBeDefined();

    // Verify transitive resolution legacy-old -> mid-leg -> final-leg across ALL methods!
    const msgsViaOrigin = await core.getMessages('legacy-old');
    expect(msgsViaOrigin.map((m) => m.localId)).toEqual(['lu-1', 'la-1', 'lu-2', 'la-2']);

    vi.spyOn(core.syncClient, 'updateConversation').mockResolvedValue(undefined);
    const patchedViaOrigin = core.patchThread('legacy-old', { title: 'OIM Sizing v2' });
    expect(patchedViaOrigin?.id).toBe('final-leg');

    const agentSendSpy = vi.spyOn(core.agent, 'sendMessage').mockResolvedValue(undefined);
    await core.sendMessage({ threadId: 'legacy-old', text: 'Turn 3 via stale origin id' });
    expect(agentSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'final-leg' }),
      'Turn 3 via stale origin id',
      expect.anything(),
    );

    const agentInterruptSpy = vi.spyOn(core.agent, 'interrupt').mockResolvedValue(undefined);
    await core.interrupt('legacy-old');
    expect(agentInterruptSpy).toHaveBeenCalledWith('final-leg');

    await core.submitFeedback({ threadId: 'legacy-old', messageLocalId: 'la-2', rating: 1, comment: 'Great' });
    expect(feedbackSpy).toHaveBeenCalledTimes(2);

    vi.spyOn(core.syncClient, 'deleteConversation').mockResolvedValue(undefined);
    await core.deleteThread('legacy-old');
    expect(core.threads.get('final-leg')).toBeUndefined();
  });

  it('paces sequential mass 404 recovery by awaiting syncQueue.flush() per thread and halts early on transient backoff', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    const indexMap: Record<string, ThreadMeta> = {};
    for (const id of ['m1', 'm2', 'm3']) {
      indexMap[id] = makeThreadMeta({ id, title: `Mass ${id}`, hasStarted: true });
      fs.writeFileSync(
        path.join(threadsDir, `${id}.jsonl`),
        [
          JSON.stringify({ localId: `${id}-u`, role: 'user', content: `Q ${id}`, createdAt: '2026-10-01T10:00:00.000Z' }),
          JSON.stringify({ localId: `${id}-a`, role: 'assistant', content: `A ${id}`, createdAt: '2026-10-01T10:00:05.000Z' }),
        ].join('\n') + '\n',
      );
    }
    fs.writeFileSync(path.join(threadsDir, 'index.json'), JSON.stringify(indexMap));

    const { core } = makeCore();
    const callOrder: string[] = [];

    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue([]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockImplementation(async (id) => {
      callOrder.push(`probe:${id}`);
      throw new SyncApiError(404, 'Not found');
    });
    let seq = 1;
    vi.spyOn(core.syncClient, 'createConversation').mockImplementation(async (title, settings) => {
      const newId = `recreated-${seq++}`;
      callOrder.push(`create:${title}->${newId}`);
      return {
        id: newId,
        title: title ?? 'New Conversation',
        createdAt: '2026-10-12T10:00:00.000Z',
        updatedAt: '2026-10-12T10:00:00.000Z',
        settings: { ...settings },
      };
    });
    vi.spyOn(core.syncClient, 'appendMessages').mockImplementation(async (convId) => {
      callOrder.push(`append:${convId}`);
      if (convId === 'recreated-2') {
        throw new SyncApiError(503, 'Service unavailable');
      }
      return { ids: [`${convId}-u`, `${convId}-a`] };
    });

    await core.listThreads();
    await core.waitForStartupTasks();

    // m1 finished create + append BEFORE m2 was probed; m2 hit 503 backoff so m3 was NOT probed yet!
    expect(callOrder).toEqual([
      'probe:m1',
      'create:Mass m1->recreated-1',
      'append:recreated-1',
      'probe:m2',
      'create:Mass m2->recreated-2',
      'append:recreated-2',
    ]);
    expect(core.threads.get('m3')).toBeDefined();
  });

  it('runs once-per-launch startup empty-conversation sweep (after offline start recovers), deleting >= 5m confirmed-empty desktop conversations on server + desktop', async () => {
    const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    const staleIso = '2026-10-12T11:40:00.000Z'; // 20m old (>= 5m)

    const srvEmptyLocal = makeThreadMeta({
      id: 'empty-srv',
      title: 'New Conversation',
      createdAt: staleIso,
      updatedAt: staleIso,
      remoteSettings: { client: 'desktop' },
    });
    const localOnly404 = makeThreadMeta({
      id: 'empty-local-404',
      title: 'Untitled',
      createdAt: staleIso,
      updatedAt: staleIso,
      remoteSettings: { client: 'desktop' },
    });
    fs.writeFileSync(
      path.join(threadsDir, 'index.json'),
      JSON.stringify({ 'empty-srv': srvEmptyLocal, 'empty-local-404': localOnly404 }),
    );

    const { core, syncEvents } = makeCore();
    core.searchIndex.replaceMessages('empty-srv', [
      { localId: 'ghost', role: 'user', content: 'stale ghost index doc', createdAt: staleIso },
    ]);

    const listSpy = vi
      .spyOn(core.syncClient, 'listConversations')
      .mockRejectedValueOnce(new Error('Offline at cold boot'))
      .mockResolvedValue([
        {
          id: 'empty-srv',
          title: 'New Conversation',
          createdAt: staleIso,
          updatedAt: staleIso,
          settings: { client: 'desktop' },
        },
      ]);

    const getMsgsSpy = vi.spyOn(core.syncClient, 'getMessages').mockImplementation(async (id, limit, offset) => {
      expect(limit).toBe(1);
      expect(offset).toBe(0);
      if (id === 'empty-local-404') {
        throw new SyncApiError(404, 'Not found');
      }
      return [];
    });
    const deleteSpy = vi.spyOn(core.syncClient, 'deleteConversation').mockResolvedValue(undefined);

    // 1. Offline start: sweep does NOT latch
    const r1 = await core.listThreads();
    expect(r1.serverReachable).toBe(false);
    expect(getMsgsSpy).not.toHaveBeenCalled();

    // 2. Connectivity returns: sweep runs once and deletes both server-listed and local-only 404 empty desktop conversations!
    const r2 = await core.listThreads();
    expect(r2.serverReachable).toBe(true);
    await core.waitForStartupTasks();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('empty-srv');
    expect(core.threads.get('empty-srv')).toBeUndefined();
    expect(core.threads.get('empty-local-404')).toBeUndefined();
    expect(await core.searchThreads('ghost')).toEqual([]);
    expect(syncEvents.filter((e) => e.kind === 'thread-deleted').map((e) => (e as { threadId: string }).threadId).sort()).toEqual([
      'empty-local-404',
      'empty-srv',
    ]);

    // 3. Subsequent listThreads() calls do NOT run the sweep a second time!
    getMsgsSpy.mockClear();
    deleteSpy.mockClear();
    listSpy.mockResolvedValueOnce([
      {
        id: 'empty-later',
        title: 'New Conversation',
        createdAt: staleIso,
        updatedAt: staleIso,
        settings: { client: 'desktop' },
      },
    ]);
    await core.listThreads();
    await core.waitForStartupTasks();
    expect(getMsgsSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('enforces all 7 empty-sweep preservation guards (web-created, <5m recent, sessionTouched race, custom title, non-empty server, NaN timestamp, and silent fail-open on 500)', async () => {
    const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const staleIso = '2026-10-12T11:30:00.000Z'; // 30m old
    const recentIso = '2026-10-12T11:56:00.000Z'; // 4m old (< 5m)

    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    const localSeed: Record<string, ThreadMeta> = {
      'g1-web': makeThreadMeta({ id: 'g1-web', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'web' } }),
      'g2-recent': makeThreadMeta({ id: 'g2-recent', title: 'New Conversation', createdAt: recentIso, updatedAt: recentIso, remoteSettings: { client: 'desktop' } }),
      'g3-pre-touched': makeThreadMeta({ id: 'g3-pre-touched', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
      'g3-mid-race': makeThreadMeta({ id: 'g3-mid-race', title: 'New Chat', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
      'g4-titled': makeThreadMeta({ id: 'g4-titled', title: 'OIM Sizing', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
      'g5-has-msg': makeThreadMeta({ id: 'g5-has-msg', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
      'g6-nan-ts': makeThreadMeta({ id: 'g6-nan-ts', title: 'New Conversation', createdAt: 'not-a-date', updatedAt: '', remoteSettings: { client: 'desktop' } }),
      'g7-del-500': makeThreadMeta({ id: 'g7-del-500', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
      's-local-client-only': makeThreadMeta({ id: 's-local-client-only', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
    };
    fs.writeFileSync(path.join(threadsDir, 'index.json'), JSON.stringify(localSeed));

    const { core, syncEvents } = makeCore();
    vi.spyOn(core.syncClient, 'updateConversation').mockResolvedValue(undefined);

    // Touch g3-pre-touched BEFORE listThreads via validatePlaybook
    await core.validatePlaybook({ threadId: 'g3-pre-touched', text: '', promptName: '' });

    const listSpy = vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue(
      Object.values(localSeed).map((t) => ({
        id: t.id,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        // Simulate server omitting settings.client on s-local-client-only to test OR-fallback!
        settings: t.id === 's-local-client-only' ? {} : (t.remoteSettings ?? {}),
      })),
    );

    const probedIds: string[] = [];
    vi.spyOn(core.syncClient, 'getMessages').mockImplementation(async (id) => {
      probedIds.push(id);
      if (id === 'g5-has-msg') {
        return [
          {
            id: 'srv-m1',
            role: 'user',
            content: 'Web message on desktop conv',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: staleIso,
          },
        ];
      }
      return [];
    });

    const deletedServerIds: string[] = [];
    vi.spyOn(core.syncClient, 'deleteConversation').mockImplementation(async (id) => {
      if (id === 'g3-mid-race') {
        // User touches g3-mid-race WHILE deleteConversation is in flight!
        core.patchThread('g3-mid-race', { model: 'opus' });
        return;
      }
      if (id === 'g7-del-500') {
        throw new SyncApiError(500, 'Internal error');
      }
      deletedServerIds.push(id);
    });

    await core.listThreads();
    await core.waitForStartupTasks();

    // (1), (2), (3 pre-touched), (4), (6) were NEVER even probed via getMessages(id, 1, 0)!
    expect(probedIds).not.toContain('g1-web');
    expect(probedIds).not.toContain('g2-recent');
    expect(probedIds).not.toContain('g3-pre-touched');
    expect(probedIds).not.toContain('g4-titled');
    expect(probedIds).not.toContain('g6-nan-ts');

    // ONLY g3-mid-race, g5-has-msg, g7-del-500, and s-local-client-only were probed; ONLY s-local-client-only was swept!
    for (const id of Object.keys(localSeed)) {
      if (id === 's-local-client-only') {
        expect(core.threads.get(id)).toBeUndefined();
      } else {
        expect(core.threads.get(id)).toBeDefined();
      }
    }
    expect(deletedServerIds).toEqual(['s-local-client-only']);
    expect(syncEvents.filter((e) => e.kind === 'thread-deleted')).toEqual([
      { kind: 'thread-deleted', threadId: 's-local-client-only' },
    ]);
    // (7) Failed sweep did NOT emit any sync-state error banner!
    expect(syncEvents.filter((e) => e.kind === 'sync-state' && e.state === 'error')).toEqual([]);

    // Subsequent listThreads() when g3-mid-race is now absent on server MUST preserve sweep-spared g3-mid-race!
    listSpy.mockResolvedValueOnce(
      Object.values(localSeed)
        .filter((t) => t.id !== 'g3-mid-race' && t.id !== 's-local-client-only')
        .map((t) => ({
          id: t.id,
          title: t.title,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          settings: t.remoteSettings ?? {},
        })),
    );
    const secondList = await core.listThreads();
    await core.waitForStartupTasks();
    expect(core.threads.get('g3-mid-race')).toBeDefined();
    expect(secondList.threads.some((t) => t.id === 'g3-mid-race')).toBe(true);

    // And sending a turn on sweep-spared g3-mid-race auto-recreates cleanly on 404!
    vi.spyOn(core.syncClient, 'appendMessages')
      .mockRejectedValueOnce(new SyncApiError(404, 'Deleted by sweep'))
      .mockResolvedValueOnce({ ids: ['srv-spared-u', 'srv-spared-a'] });
    vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 'recreated-spared',
      title: 'New Chat',
      createdAt: staleIso,
      updatedAt: staleIso,
      settings: { client: 'desktop' },
    });
    (core as any).persistTurn(
      'g3-mid-race',
      { localId: 'sp-u1', role: 'user', content: 'First prompt after race', createdAt: recentIso },
      { localId: 'sp-a1', role: 'assistant', content: 'Reply after race', createdAt: recentIso },
    );
    await core.drain();
    await vi.waitFor(() => {
      expect(core.threads.get('recreated-spared')).toBeDefined();
    });
  });

  it('enforces strict typed error classification neighbor matrix (403, 429, 502 with "404" prose, 401, ECONNRESET, SSO HTML) without false 404 recreation or pruning', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    const ids = ['e-403', 'e-429', 'e-502-404prose', 'e-401-halt', 'e-never-reached'];
    const indexMap: Record<string, ThreadMeta> = {};
    for (const id of ids) {
      indexMap[id] = makeThreadMeta({ id, title: `Thread ${id}`, hasStarted: true });
      fs.writeFileSync(
        path.join(threadsDir, `${id}.jsonl`),
        JSON.stringify({ localId: `${id}-u`, role: 'user', content: `Hello ${id}`, createdAt: '2026-10-01T10:00:00.000Z' }) + '\n',
      );
    }
    fs.writeFileSync(path.join(threadsDir, 'index.json'), JSON.stringify(indexMap));

    const { core, syncEvents } = makeCore();
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue([]); // All off-page / absent from top-200

    const probed: string[] = [];
    const getAllSpy = vi.spyOn(core.syncClient, 'getAllMessages').mockImplementation(async (id) => {
      probed.push(id);
      if (id === 'e-403') throw new SyncApiError(403, 'Forbidden');
      if (id === 'e-429') throw new SyncApiError(429, 'Too many requests');
      if (id === 'e-502-404prose') throw new SyncApiError(502, 'Yvoke Backend: upstream 404 not found');
      if (id === 'e-401-halt') throw new SyncApiError(401, 'Unauthorized');
      return { messages: [], truncated: false };
    });
    const createSpy = vi.spyOn(core.syncClient, 'createConversation');

    await core.listThreads();
    await core.waitForStartupTasks();

    expect(createSpy).not.toHaveBeenCalled();
    // 401 halted sequential probes before e-never-reached
    expect(probed).toContain('e-401-halt');
    expect(probed).not.toContain('e-never-reached');
    for (const id of ids) {
      expect(core.threads.get(id)).toBeDefined();
    }
    expect(syncEvents.filter((e) => e.kind === 'sync-state' && e.dropped)).toEqual([]);

    // Also verify ECONNRESET and SSO HTML 200 OK error halt sequential probes without recreation or pruning
    probed.length = 0;
    getAllSpy.mockClear();
    getAllSpy.mockImplementationOnce(async (id) => {
      probed.push(id);
      throw new Error('read ECONNRESET');
    });
    await core.listThreads();
    await core.waitForStartupTasks();
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(probed).toHaveLength(1);
    expect(createSpy).not.toHaveBeenCalled();

    probed.length = 0;
    getAllSpy.mockClear();
    getAllSpy.mockImplementationOnce(async (id) => {
      probed.push(id);
      throw new Error('Yvoke Backend: unexpected non-array response (<!DOCTYPE html>Sign in)');
    });
    await core.listThreads();
    await core.waitForStartupTasks();
    expect(getAllSpy).toHaveBeenCalledTimes(1);
    expect(probed).toHaveLength(1);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('enforces deleteThread 3-way resolution: 500/offline rollback, 404 completion, and in-flight recovery self-resurrection prevention', async () => {
    const { core } = makeCore();

    // Seed t-rollback, t-404-ok, and t-race with local messages + SearchIndex
    for (const id of ['t-rollback', 't-404-ok', 't-race']) {
      core.threads.upsert(makeThreadMeta({ id, title: `Delete ${id}`, hasStarted: true }));
      await core.threads.appendMessages(id, [
        { localId: `${id}-u`, serverId: `srv-${id}-u`, role: 'user', content: `searchable ${id} term`, createdAt: '2026-10-01T10:00:00.000Z' },
        { localId: `${id}-a`, serverId: `srv-${id}-a`, role: 'assistant', content: `reply ${id}`, createdAt: '2026-10-01T10:00:05.000Z' },
      ]);
      core.searchIndex.addMessages(id, [
        { localId: `${id}-u`, serverId: `srv-${id}-u`, role: 'user', content: `searchable ${id} term`, createdAt: '2026-10-01T10:00:00.000Z' },
      ]);
    }

    // (a) 500 / offline failure rolls back deletingOrDeletedThreads and preserves all local data!
    const deleteSpy = vi
      .spyOn(core.syncClient, 'deleteConversation')
      .mockRejectedValueOnce(new SyncApiError(500, 'Server down'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(core.deleteThread('t-rollback')).rejects.toThrow('Server down');
    await expect(core.deleteThread('t-rollback')).rejects.toThrow('ECONNREFUSED');
    expect(core.threads.get('t-rollback')).toBeDefined();
    expect(await core.threads.readMessages('t-rollback')).toHaveLength(2);
    expect((await core.searchThreads('t-rollback')).map((h) => h.threadId)).toEqual(['t-rollback']);

    // Subsequent listThreads() still returns and updates t-rollback (deletingOrDeletedThreads was rolled back!)
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      { id: 't-rollback', title: 'Delete t-rollback (still live)', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
      { id: 't-404-ok', title: 'Delete t-404-ok', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
      { id: 't-race', title: 'Delete t-race', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
    ]);
    const listAfterRollback = await core.listThreads();
    await core.waitForStartupTasks();
    expect(listAfterRollback.threads.find((t) => t.id === 't-rollback')?.title).toBe('Delete t-rollback (still live)');

    // (b) SyncApiError(404) on deleteConversation completes local cleanup cleanly!
    deleteSpy.mockRejectedValueOnce(new SyncApiError(404, 'Already gone'));
    await expect(core.deleteThread('t-404-ok')).resolves.toBeUndefined();
    expect(core.threads.get('t-404-ok')).toBeUndefined();
    expect(await core.searchThreads('t-404-ok')).toEqual([]);

    // (c) In-flight recovery / listConversations race: deleteThread('t-race') runs while getAllMessages('t-race') is in flight before returning 404!
    let rejectProbe404!: (err: Error) => void;
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      { id: 't-rollback', title: 'Delete t-rollback', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
    ]); // t-race absent on server -> triggers probe for t-race
    vi.spyOn(core.syncClient, 'getAllMessages').mockImplementationOnce(
      () =>
        new Promise<{ messages: MessageDto[]; truncated: boolean }>((_res, rej) => {
          rejectProbe404 = rej;
        }),
    );
    const createSpy = vi.spyOn(core.syncClient, 'createConversation');
    deleteSpy.mockResolvedValueOnce(undefined);

    await core.listThreads();
    await vi.waitFor(() => {
      expect(rejectProbe404).toBeTypeOf('function');
    });
    // Delete t-race from desktop while probe is in flight
    await core.deleteThread('t-race');
    // Probe now rejects with 404 — must NOT self-resurrect t-race!
    rejectProbe404(new SyncApiError(404, 'Deleted'));
    await core.waitForStartupTasks();

    expect(createSpy).not.toHaveBeenCalled();
    expect(core.threads.get('t-race')).toBeUndefined();
  });

  it('recovers full transcript and pendingSyncCount when both threads/index.json and sync-queue.json are corrupt on disk', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, 'index.json'), '{corrupt-index-json');
    fs.writeFileSync(path.join(tmpDir, 'sync-queue.json'), '{corrupt-queue-json');
    fs.writeFileSync(
      path.join(threadsDir, 'surviving-conv.jsonl'),
      [
        JSON.stringify({ localId: 'su-1', role: 'user', content: 'Recovered question', createdAt: '2026-10-05T10:00:00.000Z' }),
        JSON.stringify({ localId: 'sa-1', role: 'assistant', content: 'Recovered answer', createdAt: '2026-10-05T10:00:05.000Z' }),
      ].join('\n') + '\n',
    );

    const { core } = makeCore();
    expect(fs.existsSync(path.join(threadsDir, 'index.json.corrupt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sync-queue.json.corrupt'))).toBe(true);

    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      { id: 'surviving-conv', title: 'Survived', createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:05.000Z', settings: {} },
    ]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockResolvedValueOnce({ messages: [], truncated: false });
    const appendSpy = vi.spyOn(core.syncClient, 'appendMessages').mockResolvedValueOnce({
      ids: ['srv-su-1', 'srv-sa-1'],
    });

    const res = await core.listThreads();
    expect(res.pendingSyncCount).toBe(1);
    await core.waitForStartupTasks();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(core.syncQueue.pendingCount()).toBe(0);
  });

  it('cancels mid-recovery and mid-sweep on dispose(), emits zero fake orchestrator traces on rehydrated/single-agent 404s, and tolerates side-effect failures', async () => {
    // Part A: dispose() while getAllMessages and empty-sweep getMessages are pending
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-dispose-a-'));
    try {
      const staleIso = '2026-01-01T10:00:00.000Z';
      const tDirA = path.join(dirA, 'threads');
      fs.mkdirSync(tDirA, { recursive: true });
      fs.writeFileSync(
        path.join(tDirA, 'index.json'),
        JSON.stringify({
          'rec-1': makeThreadMeta({ id: 'rec-1', title: 'Rec 1', hasStarted: true }),
          'emp-1': makeThreadMeta({ id: 'emp-1', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, remoteSettings: { client: 'desktop' } }),
        }),
      );
      fs.writeFileSync(
        path.join(tDirA, 'rec-1.jsonl'),
        JSON.stringify({ localId: 'ru-1', role: 'user', content: 'hi', createdAt: staleIso }) + '\n',
      );

      const { core: coreA } = makeCore({ dir: dirA });
      vi.spyOn(coreA.syncClient, 'listConversations').mockResolvedValueOnce([
        { id: 'emp-1', title: 'New Conversation', createdAt: staleIso, updatedAt: staleIso, settings: { client: 'desktop' } },
      ]);

      let rejectRec!: (e: Error) => void;
      let resolveEmp!: (m: MessageDto[]) => void;
      vi.spyOn(coreA.syncClient, 'getAllMessages').mockImplementationOnce(
        () => new Promise((_r, rej) => { rejectRec = rej; }),
      );
      vi.spyOn(coreA.syncClient, 'getMessages').mockImplementationOnce(
        () => new Promise((res) => { resolveEmp = res; }),
      );
      const createSpyA = vi.spyOn(coreA.syncClient, 'createConversation');
      const deleteSpyA = vi.spyOn(coreA.syncClient, 'deleteConversation');

      await coreA.listThreads();
      await vi.waitFor(() => {
        expect(rejectRec).toBeTypeOf('function');
        expect(resolveEmp).toBeTypeOf('function');
      });

      coreA.dispose();
      rejectRec(new SyncApiError(404, 'Gone'));
      resolveEmp([]);
      await Promise.resolve();
      await Promise.resolve();

      expect(createSpyA).not.toHaveBeenCalled();
      expect(deleteSpyA).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
    }

    // Part B & C: Zero fake orchestrator traces on single-agent & MessageDto-rehydrated orchestrator 404s; side-effect errors don't abort message recovery
    const { core } = makeCore();
    core.threads.upsert(makeThreadMeta({ id: 'single-404', title: 'Single 404', hasStarted: true }));
    await core.threads.appendMessages('single-404', [
      { localId: 's4-u', role: 'user', content: 'Q', createdAt: '2026-10-01T10:00:00.000Z' },
      { localId: 's4-a', role: 'assistant', content: 'A', feedback: { rating: 1, comment: 'Good' }, createdAt: '2026-10-01T10:00:05.000Z' },
    ]);
    // Rehydrated orchestrator thread has non-Agent toolCalls (0 local Agent delegations!)
    core.threads.upsert(
      makeThreadMeta({ id: 'rehyd-orch-404', title: 'Rehydrated Orch', orchestratorProfile: 'OIM', hasStarted: true }),
    );
    await core.threads.appendMessages('rehyd-orch-404', [
      { localId: 'ro-u', serverId: 'old-s1', role: 'user', content: 'Orch Q', createdAt: '2026-10-01T10:00:00.000Z' },
      {
        localId: 'ro-a',
        serverId: 'old-s2',
        role: 'assistant',
        content: 'Orch A',
        toolCalls: [{ id: 'tc-non-agent', name: 'mcp__yvoke__search', input: {}, result: 'ok' }],
        createdAt: '2026-10-01T10:00:05.000Z',
      },
    ]);

    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockRejectedValue(new SyncApiError(404, 'Not found'));
    let cSeq = 1;
    vi.spyOn(core.syncClient, 'createConversation').mockImplementation(async (title, settings) => ({
      id: `rebuilt-${cSeq++}`,
      title: title ?? 'New Conversation',
      createdAt: '2026-10-12T10:00:00.000Z',
      updatedAt: '2026-10-12T10:00:00.000Z',
      settings: { ...settings },
    }));
    vi.spyOn(core.syncClient, 'appendMessages').mockResolvedValue({ ids: ['ns-1', 'ns-2'] });
    // Simulate transient 500 on submitFeedback — must NOT abort message recovery!
    vi.spyOn(core.syncClient, 'submitFeedback').mockRejectedValue(new SyncApiError(500, 'Feedback service down'));
    const runSpy = vi.spyOn(core.syncClient, 'recordOrchestratorRun');

    await core.listThreads();
    await core.waitForStartupTasks();

    expect(runSpy).not.toHaveBeenCalled();
    expect(core.threads.get('rebuilt-1')).toBeDefined();
    expect(core.threads.get('rebuilt-2')).toBeDefined();
  });

  it('defers 404 migration while agent.isBusy(oldId) and wakes on turn completion, skips empty 404 recreation, and drops 422 once per session', async () => {
    let emitAgent!: (ev: any) => void;
    const syncEvents: SyncEvent[] = [];
    const core = new AppCore({
      userDataDir: tmpDir,
      appVersion: '1.3.1',
      emitAgentEvent: (ev) => emitAgent?.(ev),
      emitSyncEvent: (ev) => syncEvents.push(ev),
      openBrowser: vi.fn().mockResolvedValue(undefined),
      tokenCache: null,
    });
    activeCores.push(core);

    // 1. Empty 404 (0 local messages, 0 queued turns) -> pruned cleanly without createConversation
    core.threads.upsert(makeThreadMeta({ id: 'empty-404', title: 'Empty 404', hasStarted: true }));

    // 2. Busy 404 thread -> defers while isBusy === true, then migrates when turn-complete fires!
    core.threads.upsert(makeThreadMeta({ id: 'busy-404', title: 'Busy 404', hasStarted: true }));
    await core.threads.appendMessages('busy-404', [
      { localId: 'bu-1', role: 'user', content: 'Turn 1', createdAt: '2026-10-01T10:00:00.000Z' },
      { localId: 'ba-1', role: 'assistant', content: 'Ans 1', createdAt: '2026-10-01T10:00:05.000Z' },
    ]);

    let busyFlag = true;
    vi.spyOn(core.agent, 'isBusy').mockImplementation((id) => id === 'busy-404' && busyFlag);
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValue([]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockRejectedValue(new SyncApiError(404, 'Not found'));
    const createSpy = vi.spyOn(core.syncClient, 'createConversation').mockResolvedValue({
      id: 'migrated-after-busy',
      title: 'Busy 404',
      createdAt: '2026-10-12T10:00:00.000Z',
      updatedAt: '2026-10-12T10:00:00.000Z',
      settings: {},
    });
    const appendSpy = vi.spyOn(core.syncClient, 'appendMessages').mockResolvedValue({
      ids: ['srv-bu-1', 'srv-ba-1'],
    });

    await core.listThreads();
    await core.waitForStartupTasks();

    // empty-404 was NOT recreated; busy-404 was deferred while busyFlag === true!
    expect(core.threads.get('empty-404')).toBeUndefined();
    expect(createSpy).not.toHaveBeenCalled();
    expect(core.threads.get('busy-404')).toBeDefined();

    // Simulate AgentService emitting turn-complete BEFORE setting session.busy = false synchronously!
    (core.agent as any).deps.emit({
      kind: 'turn-complete',
      threadId: 'busy-404',
      message: { localId: 'ba-2', role: 'assistant', content: 'done', createdAt: 'now' },
      usage: ThreadStore.emptyTotals(),
      durationMs: 10,
      isError: false,
      aborted: false,
    });
    busyFlag = false;

    await vi.waitFor(() => {
      expect(core.threads.get('migrated-after-busy')).toBeDefined();
      expect(appendSpy).toHaveBeenCalledWith('migrated-after-busy', expect.anything());
    });

    // 3. Session 4xx (422) drop guard: drops for current session, does NOT re-enqueue on listThreads(), retries once on next AppCore launch!
    const dir422 = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-422-'));
    try {
      const { core: c1, syncEvents: ev1 } = makeCore({ dir: dir422 });
      c1.threads.upsert(makeThreadMeta({ id: 't-422', title: '422 Thread', hasStarted: true }));
      vi.spyOn(c1.syncClient, 'appendMessages').mockRejectedValue(new SyncApiError(422, 'Payload invalid'));
      vi.spyOn(c1.syncClient, 'listConversations').mockResolvedValue([
        { id: 't-422', title: '422 Thread', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
      ]);
      vi.spyOn(c1.syncClient, 'getAllMessages').mockResolvedValue({ messages: [], truncated: false });

      (c1 as any).persistTurn(
        't-422',
        { localId: 'u-422', role: 'user', content: 'Bad turn', createdAt: '2026-10-01T10:00:00.000Z' },
        { localId: 'a-422', role: 'assistant', content: 'Bad reply', createdAt: '2026-10-01T10:00:05.000Z' },
      );
      await c1.drain();
      await c1.syncQueue.flush();

      expect(ev1.some((e) => e.kind === 'sync-state' && e.dropped === true)).toBe(true);
      expect(c1.syncQueue.pendingCount()).toBe(0);

      // Subsequent listThreads() in the SAME session does NOT re-enqueue u-422/a-422!
      const appendSpySameSession = vi.spyOn(c1.syncClient, 'appendMessages');
      appendSpySameSession.mockClear();
      await c1.listThreads();
      await c1.waitForStartupTasks();
      expect(appendSpySameSession).not.toHaveBeenCalled();

      // Fresh AppCore launch on dir422 DOES retry once from .jsonl!
      await c1.drain();
      c1.dispose();
      const { core: c2 } = makeCore({ dir: dir422 });
      vi.spyOn(c2.syncClient, 'listConversations').mockResolvedValue([
        { id: 't-422', title: '422 Thread', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', settings: {} },
      ]);
      vi.spyOn(c2.syncClient, 'getAllMessages').mockResolvedValue({ messages: [], truncated: false });
      const appendSpyRelaunch = vi.spyOn(c2.syncClient, 'appendMessages').mockResolvedValue({
        ids: ['srv-u-422', 'srv-a-422'],
      });

      await c2.listThreads();
      await c2.waitForStartupTasks();
      expect(appendSpyRelaunch).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir422, { recursive: true, force: true });
    }
  });

  it('redacts secrets across SyncEvents and safely handles malformed / unknown threadIds across interrupt, deleteThread, getMessages, patchThread, and validatePlaybook', async () => {
    const { core, syncEvents } = makeCore();
    const rawJwt = 'eyJhbGciOiJIUzI1NiJ9.corpPayload.corpSig';
    const rawAnt = 'sk-ant-api03-superSecretKey123';

    core.threads.upsert(makeThreadMeta({ id: 't-sec', title: 'Sec', hasStarted: true }));
    vi.spyOn(core.syncClient, 'appendMessages').mockRejectedValueOnce(
      new SyncApiError(400, `Bad auth: Bearer ${rawJwt} and ${rawAnt}`),
    );
    (core as any).persistTurn(
      't-sec',
      { localId: 'sec-u', role: 'user', content: 'Hi', createdAt: '2026-10-01T10:00:00.000Z' },
      { localId: 'sec-a', role: 'assistant', content: 'Hello', createdAt: '2026-10-01T10:00:05.000Z' },
    );
    await core.drain();
    await core.syncQueue.flush();

    const serializedEvents = JSON.stringify(syncEvents);
    expect(serializedEvents).not.toContain(rawJwt);
    expect(serializedEvents).not.toContain(rawAnt);

    const badIds: unknown[] = ['', '   ', null, undefined, '../escape', 'a/b'];
    for (const bad of badIds) {
      // interrupt is a safe no-op on malformed/empty IDs
      await expect(core.interrupt(bad as string)).resolves.toBeUndefined();
      // validatePlaybook fails open with PASSES
      await expect(
        core.validatePlaybook({ threadId: bad as string, text: 'q', promptName: 'oim-schema' }),
      ).resolves.toEqual({ plausible: true });
      // Mutating / lookup methods reject with Invalid threadId without path traversal
      await expect(core.deleteThread(bad as string)).rejects.toThrow(/Invalid threadId/);
      await expect(core.getMessages(bad as string)).rejects.toThrow(/Invalid threadId/);
      expect(() => core.patchThread(bad as string, { title: 'x' })).toThrow(/Invalid threadId/);
      await expect(core.sendMessage({ threadId: bad as string, text: 'hi' })).rejects.toThrow(/Invalid threadId/);
      await expect(
        core.submitFeedback({ threadId: bad as string, messageLocalId: 'm1', rating: 1 }),
      ).rejects.toThrow(/Invalid threadId/);
    }

    // Unknown valid threadId on interrupt is also a safe no-op
    await expect(core.interrupt('unknown-valid-id')).resolves.toBeUndefined();
  });

  it('emits server-ids and sync-state (synced, pendingCount: 0) when 200 OK reconciliation resolves sole pending thread without queueing (deduplication, truncated, or skipped mid-thread gap)', async () => {
    // Sub-case A: Sole pending thread resolved via adoptedServerIds deduplication (0 turnsToQueue)
    const dirDedup = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-sole-dedup-'));
    try {
      const tDir = path.join(dirDedup, 'threads');
      fs.mkdirSync(tDir, { recursive: true });
      const meta = makeThreadMeta({ id: 't-dedup-sole', title: 'Sole Dedup', hasStarted: true, syncState: 'pending' });
      fs.writeFileSync(path.join(tDir, 'index.json'), JSON.stringify({ 't-dedup-sole': meta }));
      fs.writeFileSync(
        path.join(tDir, 't-dedup-sole.jsonl'),
        [
          JSON.stringify({ localId: 'sd-u1', role: 'user', content: 'Sole Q', createdAt: '2026-10-10T10:00:00.000Z' }),
          JSON.stringify({ localId: 'sd-a1', role: 'assistant', content: 'Sole A', createdAt: '2026-10-10T10:00:05.000Z' }),
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(dirDedup, 'sync-queue.json'),
        JSON.stringify([
          {
            threadId: 't-dedup-sole',
            localIds: ['sd-u1', 'sd-a1'],
            messages: [
              { role: 'user', content: 'Sole Q' },
              { role: 'assistant', content: 'Sole A' },
            ],
            enqueuedAt: '2026-10-10T10:00:05.000Z',
            attempts: 0,
          },
        ]),
      );

      const { core, syncEvents } = makeCore({ dir: dirDedup });
      vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
        { id: 't-dedup-sole', title: 'Sole Dedup', createdAt: meta.createdAt, updatedAt: meta.updatedAt, settings: {} },
      ]);
      vi.spyOn(core.syncClient, 'getAllMessages').mockResolvedValueOnce({
        truncated: false,
        messages: [
          {
            id: 'srv-sdu1',
            role: 'user',
            content: 'Sole Q',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T10:00:00.000Z',
          },
          {
            id: 'srv-sda1',
            role: 'assistant',
            content: 'Sole A',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T10:00:05.000Z',
          },
        ],
      });
      const appendSpy = vi.spyOn(core.syncClient, 'appendMessages');

      const res = await core.listThreads();
      expect(res.pendingSyncCount).toBe(1);
      await core.waitForStartupTasks();

      expect(appendSpy).not.toHaveBeenCalled();
      expect(syncEvents).toContainEqual({
        kind: 'server-ids',
        threadId: 't-dedup-sole',
        mapping: { 'sd-u1': 'srv-sdu1', 'sd-a1': 'srv-sda1' },
      });
      expect(syncEvents).toContainEqual({
        kind: 'sync-state',
        threadId: 't-dedup-sole',
        state: 'synced',
        pendingCount: 0,
      });
    } finally {
      fs.rmSync(dirDedup, { recursive: true, force: true });
    }

    // Sub-case B: Sole pending thread resolved with truncated: true (0 turnsToQueue)
    const dirTrunc = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-sole-trunc-'));
    try {
      const tDir = path.join(dirTrunc, 'threads');
      fs.mkdirSync(tDir, { recursive: true });
      const meta = makeThreadMeta({ id: 't-trunc-sole', title: 'Sole Trunc', hasStarted: true });
      fs.writeFileSync(path.join(tDir, 'index.json'), JSON.stringify({ 't-trunc-sole': meta }));
      fs.writeFileSync(
        path.join(tDir, 't-trunc-sole.jsonl'),
        [
          JSON.stringify({ localId: 'tu-1', role: 'user', content: 'Trunc Q', createdAt: '2026-10-10T10:00:00.000Z' }),
          JSON.stringify({ localId: 'ta-1', role: 'assistant', content: 'Trunc A', createdAt: '2026-10-10T10:00:05.000Z' }),
        ].join('\n') + '\n',
      );

      const { core, syncEvents } = makeCore({ dir: dirTrunc });
      vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
        { id: 't-trunc-sole', title: 'Sole Trunc', createdAt: meta.createdAt, updatedAt: meta.updatedAt, settings: {} },
      ]);
      vi.spyOn(core.syncClient, 'getAllMessages').mockResolvedValueOnce({
        truncated: true,
        messages: [],
      });

      const res = await core.listThreads();
      expect(res.pendingSyncCount).toBe(1);
      await core.waitForStartupTasks();

      expect(syncEvents).toContainEqual({
        kind: 'sync-state',
        threadId: 't-trunc-sole',
        state: 'synced',
        pendingCount: 0,
      });
    } finally {
      fs.rmSync(dirTrunc, { recursive: true, force: true });
    }

    // Sub-case C: Sole pending thread with only a skipped mid-thread gap (0 trailing turnsToQueue)
    const dirGap = fs.mkdtempSync(path.join(os.tmpdir(), 'appcore-sole-gap-'));
    try {
      const tDir = path.join(dirGap, 'threads');
      fs.mkdirSync(tDir, { recursive: true });
      const meta = makeThreadMeta({ id: 't-gap-sole', title: 'Sole Gap', hasStarted: true, syncState: 'pending' });
      fs.writeFileSync(path.join(tDir, 'index.json'), JSON.stringify({ 't-gap-sole': meta }));
      fs.writeFileSync(
        path.join(dirGap, 'sync-queue.json'),
        JSON.stringify([
          {
            threadId: 't-gap-sole',
            localIds: ['gu-0', 'ga-0'],
            messages: [
              { role: 'user', content: 'Mid Gap Q' },
              { role: 'assistant', content: 'Mid Gap A' },
            ],
            enqueuedAt: '2026-10-10T09:50:05.000Z',
            attempts: 0,
          },
        ]),
      );
      fs.writeFileSync(
        path.join(tDir, 't-gap-sole.jsonl'),
        [
          JSON.stringify({ localId: 'gu-0', role: 'user', content: 'Mid Gap Q', createdAt: '2026-10-10T09:50:00.000Z' }),
          JSON.stringify({ localId: 'ga-0', role: 'assistant', content: 'Mid Gap A', createdAt: '2026-10-10T09:50:05.000Z' }),
          JSON.stringify({ localId: 'gu-1', serverId: 'srv-gu1', role: 'user', content: 'Later Synced Q', createdAt: '2026-10-10T10:00:00.000Z' }),
          JSON.stringify({ localId: 'ga-1', serverId: 'srv-ga1', role: 'assistant', content: 'Later Synced A', createdAt: '2026-10-10T10:00:05.000Z' }),
        ].join('\n') + '\n',
      );

      const { core, syncEvents } = makeCore({ dir: dirGap });
      vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
        { id: 't-gap-sole', title: 'Sole Gap', createdAt: meta.createdAt, updatedAt: meta.updatedAt, settings: {} },
      ]);
      vi.spyOn(core.syncClient, 'getAllMessages').mockResolvedValueOnce({
        truncated: false,
        messages: [
          {
            id: 'srv-gu1',
            role: 'user',
            content: 'Later Synced Q',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T10:00:00.000Z',
          },
          {
            id: 'srv-ga1',
            role: 'assistant',
            content: 'Later Synced A',
            playbook: null,
            playbookVersion: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            cachedTokens: null,
            thoughtTokens: null,
            feedbackRating: null,
            feedbackComment: null,
            createdAt: '2026-10-10T10:00:05.000Z',
          },
        ],
      });

      const res = await core.listThreads();
      expect(res.pendingSyncCount).toBe(1);
      await core.waitForStartupTasks();

      expect(syncEvents).toContainEqual({
        kind: 'sync-state',
        threadId: 't-gap-sole',
        state: 'synced',
        pendingCount: 0,
      });
    } finally {
      fs.rmSync(dirGap, { recursive: true, force: true });
    }
  });

  it('prunes pendingFeedback, deferredRecoveryTraces, pendingRuns (resolved and in-flight Promise), and failedRuns across deleteThread, onTurnDropped (422), 404 migration, and dispose()', async () => {
    const threadsDir = path.join(tmpDir, 'threads');
    fs.mkdirSync(threadsDir, { recursive: true });

    const delOld = makeThreadMeta({
      id: 'del-old',
      title: 'To Migrate Then Delete',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      updatedAt: '2026-10-10T10:00:00.000Z',
    });
    const dropThread = makeThreadMeta({
      id: 'drop-t',
      title: 'Drop 422',
      orchestratorProfile: 'OIM',
      hasStarted: true,
      updatedAt: '2026-10-11T10:00:00.000Z',
    });
    const liveThread = makeThreadMeta({ id: 'keep-live', title: 'Keep Live', orchestratorProfile: 'OIM', hasStarted: true });

    fs.writeFileSync(
      path.join(threadsDir, 'index.json'),
      JSON.stringify({ 'del-old': delOld, 'drop-t': dropThread, 'keep-live': liveThread }),
    );
    fs.writeFileSync(
      path.join(threadsDir, 'del-old.jsonl'),
      [
        JSON.stringify({ localId: 'do-u1', role: 'user', content: 'Q1', createdAt: '2026-10-10T10:00:00.000Z' }),
        JSON.stringify({
          localId: 'do-a1',
          role: 'assistant',
          content: 'A1',
          feedback: { rating: 1, comment: 'Good' },
          toolCalls: [{ id: 'tc1', name: 'Agent', subagentType: 'spec', input: { prompt: 'p' }, result: 'r' }],
          createdAt: '2026-10-10T10:00:05.000Z',
        }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(threadsDir, 'drop-t.jsonl'),
      [
        JSON.stringify({ localId: 'dr-u1', role: 'user', content: 'Drop Q', createdAt: '2026-10-10T10:00:00.000Z' }),
        JSON.stringify({
          localId: 'dr-a1',
          role: 'assistant',
          content: 'Drop A',
          feedback: { rating: -1, comment: 'Bad' },
          toolCalls: [{ id: 'tc2', name: 'Agent', subagentType: 'spec', input: { prompt: 'p' }, result: 'r' }],
          createdAt: '2026-10-10T10:00:05.000Z',
        }),
      ].join('\n') + '\n',
    );

    const { core } = makeCore();
    vi.spyOn(core.syncClient, 'listConversations').mockResolvedValueOnce([
      { id: 'drop-t', title: 'Drop 422', createdAt: dropThread.createdAt, updatedAt: dropThread.updatedAt, settings: { 'orchestrator-profile': 'OIM' } },
      { id: 'keep-live', title: 'Keep Live', createdAt: liveThread.createdAt, updatedAt: liveThread.updatedAt, settings: { 'orchestrator-profile': 'OIM' } },
    ]);
    vi.spyOn(core.syncClient, 'getAllMessages').mockImplementation(async (id) => {
      if (id === 'del-old') throw new SyncApiError(404, 'Missing');
      return { messages: [], truncated: false };
    });
    vi.spyOn(core.syncClient, 'createConversation').mockResolvedValueOnce({
      id: 'del-new',
      title: 'To Migrate Then Delete',
      createdAt: '2026-10-12T10:00:00.000Z',
      updatedAt: '2026-10-12T10:00:00.000Z',
      settings: { 'orchestrator-profile': 'OIM', client: 'desktop' },
    });
    // Hold appendMessages for del-new on 503 backoff so pendingFeedback & deferredRecoveryTraces stay populated; reject drop-t with 422!
    let sawDropPopulatedBefore422 = false;
    vi.spyOn(core.syncClient, 'appendMessages').mockImplementation(async (id) => {
      if (id === 'drop-t') {
        sawDropPopulatedBefore422 =
          (core as any).pendingFeedback.has('dr-a1') &&
          (core as any).deferredRecoveryTraces.has('dr-a1') &&
          (core as any).pendingRuns.has('dr-u1');
        throw new SyncApiError(422, 'Permanent 422');
      }
      throw new SyncApiError(503, 'Hold in queue');
    });

    // Seed pendingRuns (resolved + in-flight Promise) and failedRuns on del-old, drop-t, and keep-live
    let resolveInFlightDel!: (val: any) => void;
    let resolveInFlightLive!: (val: any) => void;
    (core as any).pendingRuns.set('pr-resolved-del', { conversationId: 'del-old', profileName: 'OIM', steps: [] });
    (core as any).pendingRuns.set(
      'pr-inflight-del',
      new Promise((res) => {
        resolveInFlightDel = res;
      }),
    );
    (core as any).pendingRuns.set('dr-u1', { conversationId: 'drop-t', profileName: 'OIM', steps: [] });
    (core as any).pendingRuns.set(
      'pr-inflight-live',
      new Promise((res) => {
        resolveInFlightLive = res;
      }),
    );
    (core as any).failedRuns.push(
      { run: { conversationId: 'del-old', profileName: 'OIM', steps: [] }, attempts: 1, nextRetryAt: Date.now() + 60_000 },
      { run: { conversationId: 'keep-live', profileName: 'OIM', steps: [] }, attempts: 1, nextRetryAt: Date.now() + 60_000 },
    );

    await core.listThreads();
    await core.waitForStartupTasks();

    // 1. 422 onTurnDropped genuinely saw populated entries and pruned dr-a1 / dr-u1 from pendingFeedback, deferredRecoveryTraces, and pendingRuns!
    expect(sawDropPopulatedBefore422).toBe(true);
    expect((core as any).pendingFeedback.has('dr-a1')).toBe(false);
    expect((core as any).deferredRecoveryTraces.has('dr-a1')).toBe(false);
    expect((core as any).pendingRuns.has('dr-u1')).toBe(false);

    // 2. 404 migration rewrote conversationId -> 'del-new' on pendingFeedback, deferredRecoveryTraces, pendingRuns, and failedRuns!
    expect((core as any).pendingFeedback.get('do-a1')?.conversationId).toBe('del-new');
    expect((core as any).deferredRecoveryTraces.get('do-a1')?.conversationId).toBe('del-new');

    // 3. deleteThread('del-old') resolves -> 'del-new' and prunes all 4 collections for 'del-new' (including in-flight Promise on resolve)!
    vi.spyOn(core.syncClient, 'deleteConversation').mockResolvedValueOnce(undefined);
    await core.deleteThread('del-old');

    expect((core as any).pendingFeedback.has('do-a1')).toBe(false);
    expect((core as any).deferredRecoveryTraces.has('do-a1')).toBe(false);
    expect((core as any).pendingRuns.has('pr-resolved-del')).toBe(false);
    expect((core as any).failedRuns.map((f: any) => f.run.conversationId)).toEqual(['keep-live']);

    // Resolve both in-flight pendingRuns promises after deleteThread
    resolveInFlightDel({ conversationId: 'del-old', profileName: 'OIM', steps: [] });
    resolveInFlightLive({ conversationId: 'keep-live', profileName: 'OIM', steps: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect((core as any).pendingRuns.has('pr-inflight-del')).toBe(false);
    expect((core as any).pendingRuns.has('pr-inflight-live')).toBe(true);

    // 4. dispose() clears all 4 collections completely!
    (core as any).pendingFeedback.set('live-fb', { conversationId: 'keep-live', rating: 1 });
    (core as any).deferredRecoveryTraces.set('live-tr', {
      conversationId: 'keep-live',
      profileName: 'OIM',
      userText: 'u',
      assistant: { localId: 'live-tr', role: 'assistant', content: 'a', createdAt: 'now' },
    });
    core.dispose();
    expect((core as any).pendingFeedback.size).toBe(0);
    expect((core as any).deferredRecoveryTraces.size).toBe(0);
    expect((core as any).pendingRuns.size).toBe(0);
    expect((core as any).failedRuns).toHaveLength(0);
  });
});

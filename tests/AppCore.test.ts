import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import { ThreadStore } from '../src/main/store/ThreadStore';
import { SyncApiError } from '../src/main/sync/SyncClient';
import type { McpPromptInfo, OrchestratorRunPayload, ThreadMeta } from '../src/shared/types';
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

  it('postOrchestratorRun buffers retriable failures (network, 401, 429, 502), drops non-retriable 4xx (400, 403, 404), caps failedRuns at 50, and drains atomically without double-POSTing', async () => {
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

    // Non-retriable 400, 403, 404 are dropped and NOT added to failedRuns
    for (const status of [400, 403, 404]) {
      recordSpy.mockRejectedValueOnce(new SyncApiError(status, `Yvoke Backend: HTTP ${status}`));
      (appCore as any).postOrchestratorRun(makeRun(`msg-${status}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((appCore as any).failedRuns).toHaveLength(0);

    // Retriable errors: network TypeError, 401, 429, 502 ARE buffered in failedRuns
    const retriableErrors = [
      new TypeError('fetch failed'),
      new SyncApiError(401, 'Yvoke Backend: HTTP 401'),
      new SyncApiError(429, 'Yvoke Backend: HTTP 429'),
      new SyncApiError(502, 'Yvoke Backend: HTTP 502'),
    ];
    for (let i = 0; i < retriableErrors.length; i++) {
      recordSpy.mockRejectedValueOnce(retriableErrors[i]);
      (appCore as any).postOrchestratorRun(makeRun(`msg-ret-${i}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect((appCore as any).failedRuns).toHaveLength(4);

    // Atomic splice proof: concurrent handleServerIds + listThreads while drain is in-flight
    // must post each buffered run exactly ONCE
    recordSpy.mockClear();
    let resolveInFlightPost!: (v: { id: string }) => void;
    recordSpy.mockImplementation(
      () =>
        new Promise((res) => {
          resolveInFlightPost = res;
        }),
    );
    vi.spyOn(appCore.syncClient, 'listConversations').mockResolvedValue([]);

    // Trigger first drain via handleServerIds
    (appCore as any).handleServerIds(threadId, {});
    // Immediately trigger second drain via listThreads while first drain's POSTs are still in flight
    await appCore.listThreads();

    // Even with two concurrent drain triggers, recordOrchestratorRun was only called 4 times (not 8)
    expect(recordSpy).toHaveBeenCalledTimes(4);
    expect((appCore as any).failedRuns).toHaveLength(0);
    resolveInFlightPost({ id: 'ok' });

    // Verify failedRuns is capped at MAX_PENDING_RUNS = 50
    recordSpy.mockRejectedValue(new SyncApiError(503, 'Service Unavailable'));
    for (let i = 0; i < 60; i++) {
      (appCore as any).postOrchestratorRun(makeRun(`msg-cap-${i}`));
    }
    await new Promise((r) => setTimeout(r, 0));
    expect((appCore as any).failedRuns).toHaveLength(50);
    expect((appCore as any).failedRuns[0].messageId).toBe('msg-cap-10');
    expect((appCore as any).failedRuns[49].messageId).toBe('msg-cap-59');
  });
});

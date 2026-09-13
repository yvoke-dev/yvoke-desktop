import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppCore } from '../src/main/AppCore';
import { ThreadStore } from '../src/main/store/ThreadStore';
import type { ThreadMeta } from '../src/shared/types';

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

  it('Test 1.7a: Main Process Isolation in AppCore.sendMessage passes playbookName: undefined and injectBefore: undefined when orchestratorProfile is set', async () => {
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
        playbookName: undefined,
        playbook: undefined,
        injectBefore: undefined,
      }),
    );
  });

  it('Test 1.7b: Adversarial Defense & Prompt Resolution Bypass - getText is not called in orchestrator mode, but is called in single-agent mode', async () => {
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

    const getTextSpy = vi
      .spyOn(appCore.mcpPrompts, 'getText')
      .mockResolvedValue('playbook system instructions content');
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
        playbookName: undefined,
        playbook: undefined,
        injectBefore: undefined,
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
        playbookName: undefined,
        playbook: undefined,
        injectBefore: undefined,
      }),
    );

    // Case 3: Single agent thread with promptName
    await appCore.sendMessage({
      threadId: singleThread.id,
      text: 'Single agent message with prompt',
      promptName: 'oim-schema',
    });
    expect(getTextSpy).toHaveBeenCalledTimes(1);
    expect(getTextSpy).toHaveBeenCalledWith('oim-schema');
    expect(sendSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      'Single agent message with prompt',
      expect.objectContaining({
        playbookName: 'oim-schema',
        playbook: 'oim-schema',
        injectBefore: 'playbook system instructions content',
      }),
    );
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

  it('clears sessionId and closes agent session when switching from single-agent to multi-agent', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-1',
      sessionId: 'session-single-1',
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

  it('clears sessionId and closes agent session when switching from multi-agent to single-agent', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-2',
      sessionId: 'session-orch-1',
      sessionProfile: 'OIM',
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

  it('clears sessionId and closes agent session when switching between different orchestrator profiles', () => {
    const thread: ThreadMeta = {
      id: 'thread-switch-3',
      sessionId: 'session-orch-oim',
      sessionProfile: 'OIM',
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

  it('Test 1.5: Mode change allowed when idle (closes thread, updates store, clears sessionId/sessionProfile)', () => {
    const thread: ThreadMeta = {
      id: 'thread-idle-1',
      title: 'Idle Thread',
      sessionId: 'session-idle-1',
      sessionProfile: undefined,
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
    await (appCore as any).drain?.();
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

    await (appCore as any).drain();

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

    await (appCore as any).drain('t1');

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

    await (appCore as any).drain();

    expect(firstTurnDone).toBe(true);
    expect(secondTurnDone).toBe(true);
    expect(drainThreadsSpy).toHaveBeenCalledTimes(1);
  });
});


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

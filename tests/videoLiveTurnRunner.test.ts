import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import {
  typeInComposer,
  selectPlaybook,
  selectAgentMode,
  dispatchTurn,
  waitForTurnCompletion,
  ComposerNotFoundError,
  TurnTimeoutError,
  PlaybookNotFoundError,
} from '../scripts/video/liveTurnRunner';

describe('videoLiveTurnRunner', () => {
  let mockPage: Partial<Page>;
  let mockKeyboard: {
    type: ReturnType<typeof vi.fn>;
    press: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockKeyboard = {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    };

    mockPage = {
      keyboard: mockKeyboard as any,
      locator: vi.fn(),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('typeInComposer', () => {
    it('successfully locates composer textarea, focuses, and types text with default delay', async () => {
      const mockTextarea: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        focus: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      };

      (mockPage.locator as any).mockReturnValue(mockTextarea);

      await typeInComposer(mockPage as Page, 'Hello world');

      expect(mockPage.locator).toHaveBeenCalledWith(
        expect.stringContaining('textarea'),
      );
      expect(mockTextarea.focus).toHaveBeenCalled();
      expect(mockKeyboard.type).toHaveBeenCalledWith('Hello world', { delay: 20 });
    });

    it('respects custom delayPerCharMs option', async () => {
      const mockTextarea: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        focus: vi.fn().mockResolvedValue(undefined),
      };
      (mockPage.locator as any).mockReturnValue(mockTextarea);

      await typeInComposer(mockPage as Page, 'Query', { delayPerCharMs: 50 });

      expect(mockKeyboard.type).toHaveBeenCalledWith('Query', { delay: 50 });
    });

    it('throws ComposerNotFoundError when composer textarea count is 0', async () => {
      const mockTextarea: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(0),
      };
      (mockPage.locator as any).mockReturnValue(mockTextarea);

      await expect(typeInComposer(mockPage as Page, 'Test')).rejects.toThrow(
        ComposerNotFoundError,
      );
    });
  });

  describe('selectPlaybook', () => {
    it('successfully locates matching playbook row and clicks it', async () => {
      const mockRow: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        click: vi.fn().mockResolvedValue(undefined),
      };

      const mockPickerRows: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(3),
        filter: vi.fn().mockReturnValue({
          first: vi.fn().mockReturnValue(mockRow),
        } as any),
      };

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('picker-row')) return mockPickerRows;
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await selectPlaybook(mockPage as Page, 'oim-getting-started');

      expect(mockRow.click).toHaveBeenCalled();
    });

    it('opens playbook picker if rows are not initially visible', async () => {
      const mockRow: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        click: vi.fn().mockResolvedValue(undefined),
      };

      let openPickerCalled = false;
      const mockOpenButton: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        click: vi.fn().mockImplementation(async () => {
          openPickerCalled = true;
        }),
      };

      const mockPickerRows: Partial<Locator> = {
        count: vi.fn().mockImplementation(async () => (openPickerCalled ? 2 : 0)),
        filter: vi.fn().mockReturnValue({
          first: vi.fn().mockReturnValue(mockRow),
        } as any),
      };

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('picker-row')) return mockPickerRows;
        if (selector.includes('picker') || selector.includes('playbook')) return mockOpenButton;
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await selectPlaybook(mockPage as Page, 'oim-db-history');

      expect(mockRow.click).toHaveBeenCalled();
    });

    it('throws PlaybookNotFoundError if requested playbook cannot be found', async () => {
      const mockEmptyFilter: Partial<Locator> = {
        first: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
        }),
      };

      const mockPickerRows: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        filter: vi.fn().mockReturnValue(mockEmptyFilter as any),
      };

      (mockPage.locator as any).mockReturnValue(mockPickerRows);

      await expect(
        selectPlaybook(mockPage as Page, 'non-existent-playbook'),
      ).rejects.toThrow(PlaybookNotFoundError);
    });
  });

  describe('selectAgentMode', () => {
    it('selects single agent mode via composer select', async () => {
      const mockSelect: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        selectOption: vi.fn().mockResolvedValue(['']),
      };

      (mockPage.locator as any).mockReturnValue(mockSelect);

      await selectAgentMode(mockPage as Page, 'single');

      expect(mockSelect.selectOption).toHaveBeenCalledWith({ value: '' });
    });

    it('selects orchestrator multi-agent mode via composer select', async () => {
      const mockSelect: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        selectOption: vi.fn().mockResolvedValue(['oim-mas']),
        locator: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue([
            { getAttribute: vi.fn().mockResolvedValue('') },
            { getAttribute: vi.fn().mockResolvedValue('oim-mas') },
          ]),
        }),
      };

      (mockPage.locator as any).mockReturnValue(mockSelect);

      await selectAgentMode(mockPage as Page, 'orchestrator');

      expect(mockSelect.selectOption).toHaveBeenCalled();
    });
  });

  describe('dispatchTurn', () => {
    it('clicks composer send button when button is visible and enabled', async () => {
      const mockSendBtn: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(1),
        isVisible: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockResolvedValue(true),
        click: vi.fn().mockResolvedValue(undefined),
      };

      (mockPage.locator as any).mockReturnValue({
        first: vi.fn().mockReturnValue(mockSendBtn),
      });

      await dispatchTurn(mockPage as Page);

      expect(mockSendBtn.click).toHaveBeenCalled();
    });

    it('falls back to keyboard Meta+Enter when send button is not directly clickable', async () => {
      const mockSendBtn: Partial<Locator> = {
        count: vi.fn().mockResolvedValue(0),
      };

      (mockPage.locator as any).mockReturnValue({
        first: vi.fn().mockReturnValue(mockSendBtn),
      });

      await dispatchTurn(mockPage as Page);

      expect(mockKeyboard.press).toHaveBeenCalledWith(
        expect.stringMatching(/Enter/),
      );
    });
  });

  describe('waitForTurnCompletion', () => {
    it('resolves with durationMs when turn completes successfully (stop button gone, send enabled)', async () => {
      let pollCount = 0;
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('preflight-card')) return { count: vi.fn().mockResolvedValue(0) };
        if (selector.includes('clarifying-question-card')) return { count: vi.fn().mockResolvedValue(0) };
        if (selector.includes('danger')) {
          // Stop button present on poll 0, gone on poll 1
          return {
            count: vi.fn().mockImplementation(async () => (pollCount++ === 0 ? 1 : 0)),
            isVisible: vi.fn().mockImplementation(async () => pollCount <= 1),
          };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isEnabled: vi.fn().mockResolvedValue(true),
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('resolves early when preflight recommendation card appears', async () => {
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('preflight-card')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('resolves early when clarifying question card appears', async () => {
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('clarifying-question-card')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws TurnTimeoutError when turn does not complete within timeoutMs', async () => {
      // Turn stays running (stop button always visible)
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('preflight-card')) return { count: vi.fn().mockResolvedValue(0) };
        if (selector.includes('clarifying-question-card')) return { count: vi.fn().mockResolvedValue(0) };
        if (selector.includes('danger')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await expect(
        waitForTurnCompletion(mockPage as Page, {
          timeoutMs: 50,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow(TurnTimeoutError);
    });
  });
});

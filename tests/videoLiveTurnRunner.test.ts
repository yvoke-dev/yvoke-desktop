import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Page, Locator } from '@playwright/test';
import {
  typeInComposer,
  selectPlaybook,
  selectAgentMode,
  dispatchTurn,
  waitForTurnCompletion,
  buildPlaybookTitlePattern,
  collapseExpandedTraceBars,
  type TraceBarContainer,
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

    it('does not resolve early when clarifying question card is already answered', async () => {
      let pollCount = 0;
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector === '.clarifying-question-card:not(.answered)') {
          return { count: vi.fn().mockResolvedValue(0) };
        }
        if (selector.includes('.clarifying-question-card')) {
          // Broader selector incorrectly matches answered card in DOM
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
          };
        }
        if (selector.includes('danger')) {
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
      expect(pollCount).toBeGreaterThanOrEqual(1);
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

    it('automatically collapses expanded trace bar when visible', async () => {
      let pollCount = 0;
      const mockTraceClick = vi.fn().mockResolvedValue(undefined);

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('trace-bar[aria-expanded="true"]')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
            click: mockTraceClick,
          };
        }
        if (selector.includes('danger')) {
          return {
            count: vi.fn().mockImplementation(async () => (pollCount++ === 0 ? 1 : 0)),
            isVisible: vi.fn().mockImplementation(async () => pollCount <= 1),
          };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
      });

      expect(mockTraceClick).toHaveBeenCalled();
    });

    it('periodically scrolls to the bottom while waiting for turn', async () => {
      let pollCount = 0;
      const mockEvaluate = vi.fn().mockResolvedValue(undefined);
      mockPage.evaluate = mockEvaluate;

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('danger')) {
          return {
            count: vi.fn().mockImplementation(async () => (pollCount++ === 0 ? 1 : 0)),
            isVisible: vi.fn().mockImplementation(async () => pollCount <= 1),
          };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
        autoScrollIntervalMs: 5,
      });

      expect(mockEvaluate).toHaveBeenCalled();
    });

    it('waits until reviewer card is mounted when requireReviewer is true', async () => {
      let pollCount = 0;
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        if (selector.includes('verdict-badge') || selector.includes('Reviewer') || selector.includes('reviewer')) {
          // Reviewer card only mounts after 3 polls
          return {
            count: vi.fn().mockImplementation(async () => (pollCount++ >= 3 ? 1 : 0)),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
        requireReviewer: true,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(pollCount).toBeGreaterThanOrEqual(3);
    });

    it('waits until custom selector is mounted when requireSelector is provided', async () => {
      let pollCount = 0;
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        if (selector === '.custom-complete-table') {
          return {
            count: vi.fn().mockImplementation(async () => (pollCount++ >= 2 ? 1 : 0)),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
        requireSelector: '.custom-complete-table',
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });

    it('requires debounced stability across consecutive polls before resolving', async () => {
      let pollCount = 0;
      // Poll 0: stopBtn visible
      // Poll 1: stopBtn not visible (flicker)
      // Poll 2: stopBtn visible again!
      // Poll 3: stopBtn not visible
      // Poll 4: stopBtn not visible (stable)
      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('danger')) {
          const isStop = pollCount === 0 || pollCount === 2;
          return {
            count: vi.fn().mockImplementation(async () => {
              pollCount++;
              return isStop ? 1 : 0;
            }),
            isVisible: vi.fn().mockImplementation(async () => isStop),
          };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 10,
        minConsecutiveDone: 2,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(pollCount).toBeGreaterThanOrEqual(4);
    });

    it('collapses expanded trace bars via page.evaluate ONLY without falling through to locator click', async () => {
      let expanded = true;
      const domBtnClick = vi.fn(() => {
        expanded = false;
      });
      const fakeDocument = {
        querySelectorAll: vi.fn((selector: string) => {
          if (selector === 'button.trace-bar[aria-expanded="true"]') {
            return expanded ? [{ click: domBtnClick }] : [];
          }
          return [];
        }),
      };

      const mockLocatorTraceClick = vi.fn().mockResolvedValue(undefined);
      mockPage.evaluate = vi.fn().mockImplementation(async (fn: () => unknown) => {
        const g = globalThis as Record<string, unknown>;
        const prevDoc = g.document;
        g.document = fakeDocument;
        try {
          return fn();
        } finally {
          if (prevDoc === undefined) {
            delete g.document;
          } else {
            g.document = prevDoc;
          }
        }
      }) as any;

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('trace-bar[aria-expanded="true"]')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
            click: mockLocatorTraceClick,
          };
        }
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 5,
        autoScrollIntervalMs: 0,
        minConsecutiveDone: 2,
      });

      expect(domBtnClick).toHaveBeenCalledTimes(1);
      expect(mockLocatorTraceClick).toHaveBeenCalledTimes(0);
    });

    it('swallows page.evaluate rejection without falling through to locator click', async () => {
      const mockLocatorTraceClick = vi.fn().mockResolvedValue(undefined);
      mockPage.evaluate = vi.fn().mockRejectedValue(new Error('Execution context destroyed')) as any;

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('trace-bar[aria-expanded="true"]')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
            click: mockLocatorTraceClick,
          };
        }
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      const res = await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 5,
        autoScrollIntervalMs: 0,
        minConsecutiveDone: 1,
      });

      expect(res.durationMs).toBeGreaterThanOrEqual(0);
      expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
      expect(mockLocatorTraceClick).toHaveBeenCalledTimes(0);
    });

    it('falls back to locator click strictly when page.evaluate is absent', async () => {
      delete mockPage.evaluate;
      const mockLocatorTraceClick = vi.fn().mockResolvedValue(undefined);

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('trace-bar[aria-expanded="true"]')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
            click: mockLocatorTraceClick,
          };
        }
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 5,
        autoScrollIntervalMs: 0,
        minConsecutiveDone: 1,
      });

      expect(mockLocatorTraceClick).toHaveBeenCalledTimes(1);
    });

    it('skips both evaluate and locator trace collapsing when autoCollapseTrace is false', async () => {
      const mockEvaluate = vi.fn().mockResolvedValue(undefined);
      const mockLocatorTraceClick = vi.fn().mockResolvedValue(undefined);
      mockPage.evaluate = mockEvaluate as any;

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('trace-bar[aria-expanded="true"]')) {
          return {
            count: vi.fn().mockResolvedValue(1),
            isVisible: vi.fn().mockResolvedValue(true),
            click: mockLocatorTraceClick,
          };
        }
        if (selector.includes('danger') || selector.includes('live')) {
          return { count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) };
        }
        if (selector.includes('composer-send')) {
          return {
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(true),
            }),
          };
        }
        return { count: vi.fn().mockResolvedValue(0) };
      });

      await waitForTurnCompletion(mockPage as Page, {
        timeoutMs: 2000,
        pollIntervalMs: 5,
        autoCollapseTrace: false,
        autoScrollIntervalMs: 0,
        minConsecutiveDone: 1,
      });

      expect(mockEvaluate).toHaveBeenCalledTimes(0);
      expect(mockLocatorTraceClick).toHaveBeenCalledTimes(0);
    });
  });

  describe('buildPlaybookTitlePattern', () => {
    it('throws RangeError for empty or whitespace-only playbook names', () => {
      expect(() => buildPlaybookTitlePattern('')).toThrow(RangeError);
      expect(() => buildPlaybookTitlePattern('   ')).toThrow(RangeError);
      expect(() => buildPlaybookTitlePattern('\t\n')).toThrow(RangeError);
    });

    it('matches exact name and optional version suffix while rejecting prefix, suffix, and descriptions', () => {
      const pattern = buildPlaybookTitlePattern('oim-db-history');

      expect(pattern.test('oim-db-history')).toBe(true);
      expect(pattern.test('  oim-db-history  ')).toBe(true);
      expect(pattern.test('oim-db-history v1')).toBe(true);
      expect(pattern.test('oim-db-history   v42')).toBe(true);

      // Prefix, suffix, and description rejections
      expect(pattern.test('my-oim-db-history')).toBe(false);
      expect(pattern.test('oim-db-history-extended')).toBe(false);
      expect(pattern.test('oim-db-history-extended v1')).toBe(false);
      expect(pattern.test('Use oim-db-history for database history')).toBe(false);
      expect(pattern.test('oim-db-history v2 Inspect database history Use')).toBe(false);
    });

    it('escapes all regex metacharacters in playbook names', () => {
      const trickyName = 'oim.db+history(v1)[prod]^$?*|\\';
      const pattern = buildPlaybookTitlePattern(trickyName);

      expect(pattern.test(trickyName)).toBe(true);
      expect(pattern.test(`${trickyName} v3`)).toBe(true);
      expect(pattern.test('oimXdb+history(v1)[prod]^$?*|\\')).toBe(false);
      expect(pattern.test('oim.dbhistory(v1)[prod]^$?*|\\')).toBe(false);
    });
  });

  describe('selectPlaybook precision and fallback', () => {
    interface FakePickerRow {
      titleText: string;
      fullText: string;
      click: ReturnType<typeof vi.fn<() => Promise<void>>>;
    }

    interface TitleMatcherToken {
      __kind: 'title-matcher';
      hasText: RegExp | string;
    }

    function createStatefulPickerPage(
      rows: FakePickerRow[],
      fallbackChips: { text: string; click: ReturnType<typeof vi.fn<() => Promise<void>>> }[] = [],
    ): Page {
      const matchesText = (text: string, matcher: RegExp | string): boolean =>
        matcher instanceof RegExp ? matcher.test(text) : text.includes(matcher);

      const makeRowLocator = (items: FakePickerRow[]): Locator => ({
        count: vi.fn().mockImplementation(async () => items.length),
        first: vi.fn().mockImplementation(() => makeRowLocator(items.slice(0, 1))),
        click: vi.fn().mockImplementation(async () => {
          if (items.length === 0) throw new Error('No row to click');
          await items[0].click();
        }),
        filter: vi.fn().mockImplementation((opts: { has?: TitleMatcherToken; hasText?: RegExp | string }) => {
          let filtered = items;
          if (opts.has && opts.has.__kind === 'title-matcher') {
            filtered = filtered.filter((r) => matchesText(r.titleText, opts.has!.hasText));
          }
          if (opts.hasText !== undefined) {
            filtered = filtered.filter((r) => matchesText(r.fullText, opts.hasText!));
          }
          return makeRowLocator(filtered);
        }),
      }) as unknown as Locator;

      const makeChipLocator = (
        items: { text: string; click: ReturnType<typeof vi.fn<() => Promise<void>>> }[],
      ): Locator => ({
        count: vi.fn().mockImplementation(async () => items.length),
        first: vi.fn().mockImplementation(() => makeChipLocator(items.slice(0, 1))),
        click: vi.fn().mockImplementation(async () => {
          if (items.length === 0) throw new Error('No chip to click');
          await items[0].click();
        }),
        filter: vi.fn().mockImplementation((opts: { hasText?: RegExp | string }) => {
          const filtered =
            opts.hasText !== undefined
              ? items.filter((c) => matchesText(c.text, opts.hasText!))
              : items;
          return makeChipLocator(filtered);
        }),
      }) as unknown as Locator;

      return {
        locator: vi.fn().mockImplementation((selector: string, opts?: { hasText?: RegExp | string }) => {
          if (selector === '.picker-row-title' && opts?.hasText !== undefined) {
            return { __kind: 'title-matcher', hasText: opts.hasText } as unknown as Locator;
          }
          if (selector === 'button.picker-row, .picker-row') {
            return makeRowLocator(rows);
          }
          if (selector === '.picker-row, .picker-list button') {
            return {
              count: vi.fn().mockResolvedValue(rows.length + fallbackChips.length),
            } as unknown as Locator;
          }
          if (selector === '.chip, [role="option"], .picker-list button') {
            return makeChipLocator(fallbackChips);
          }
          return { count: vi.fn().mockResolvedValue(0) } as unknown as Locator;
        }),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as unknown as Page;
    }

    it('clicks ONLY the exact .picker-row-title match across 3 rows with description and suffix decoys', async () => {
      const row1: FakePickerRow = {
        titleText: 'oim-getting-started v1',
        fullText: 'oim-getting-started v1 Mentions oim-db-history in description Use',
        click: vi.fn().mockResolvedValue(undefined),
      };
      const row2: FakePickerRow = {
        titleText: 'oim-db-history-extended v1',
        fullText: 'oim-db-history-extended v1 Deep audit trail Use',
        click: vi.fn().mockResolvedValue(undefined),
      };
      const row3: FakePickerRow = {
        titleText: 'oim-db-history v2',
        fullText: 'oim-db-history v2 Inspect database change history Use',
        click: vi.fn().mockResolvedValue(undefined),
      };

      const page = createStatefulPickerPage([row1, row2, row3]);
      await selectPlaybook(page, 'oim-db-history');

      expect(row1.click).toHaveBeenCalledTimes(0);
      expect(row2.click).toHaveBeenCalledTimes(0);
      expect(row3.click).toHaveBeenCalledTimes(1);
    });

    it('uses anchored fallback strictly when primary .picker-row match count is 0', async () => {
      const extendedChip = {
        text: 'oim-db-history-extended',
        click: vi.fn().mockResolvedValue(undefined),
      };
      const exactChip = {
        text: 'oim-db-history v1',
        click: vi.fn().mockResolvedValue(undefined),
      };

      const page = createStatefulPickerPage([], [extendedChip, exactChip]);
      await selectPlaybook(page, 'oim-db-history');

      expect(extendedChip.click).toHaveBeenCalledTimes(0);
      expect(exactChip.click).toHaveBeenCalledTimes(1);
    });

    it('throws PlaybookNotFoundError when only description or suffix decoys exist', async () => {
      const row1: FakePickerRow = {
        titleText: 'oim-getting-started v1',
        fullText: 'oim-getting-started v1 Related to oim-db-history Use',
        click: vi.fn().mockResolvedValue(undefined),
      };
      const row2: FakePickerRow = {
        titleText: 'oim-db-history-extended v1',
        fullText: 'oim-db-history-extended v1 Extended history Use',
        click: vi.fn().mockResolvedValue(undefined),
      };

      const page = createStatefulPickerPage([row1, row2]);
      await expect(selectPlaybook(page, 'oim-db-history')).rejects.toThrow(PlaybookNotFoundError);
      expect(row1.click).toHaveBeenCalledTimes(0);
      expect(row2.click).toHaveBeenCalledTimes(0);
    });

    it('throws RangeError when playbookName is empty or whitespace', async () => {
      const page = createStatefulPickerPage([]);
      await expect(selectPlaybook(page, '   ')).rejects.toThrow(RangeError);
    });
  });

  describe('selectAgentMode selector isolation and fallbacks', () => {
    it('targets ONLY Agent mode select and never touches Model or Thinking composer-selects', async () => {
      const modelSelectOption = vi.fn().mockResolvedValue(['claude-sonnet']);
      const agentSelectOption = vi.fn().mockResolvedValue(['oim-mas']);

      // Simulate DOM with Model select preceding Agent mode select
      (mockPage.locator as any).mockImplementation((selector: string) => {
        const isBroadComposerSelect = selector
          .split(',')
          .some((part) => part.trim() === 'select.composer-select');
        if (isBroadComposerSelect) {
          // Broad selector would erroneously return the first composer-select (Model)!
          return {
            first: vi.fn().mockReturnValue({
              count: vi.fn().mockResolvedValue(1),
              selectOption: modelSelectOption,
              locator: vi.fn().mockReturnValue({
                all: vi.fn().mockResolvedValue([
                  { getAttribute: vi.fn().mockResolvedValue('claude-sonnet') },
                ]),
              }),
            }),
          };
        }
        if (selector.includes('aria-label="Agent mode"')) {
          return {
            first: vi.fn().mockReturnValue({
              count: vi.fn().mockResolvedValue(1),
              selectOption: agentSelectOption,
              locator: vi.fn().mockReturnValue({
                all: vi.fn().mockResolvedValue([
                  { getAttribute: vi.fn().mockResolvedValue('') },
                  { getAttribute: vi.fn().mockResolvedValue('oim-mas') },
                ]),
              }),
            }),
          };
        }
        return { first: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) };
      });

      await selectAgentMode(mockPage as Page, 'orchestrator');
      expect(modelSelectOption).toHaveBeenCalledTimes(0);
      expect(agentSelectOption).toHaveBeenCalledWith({ value: 'oim-mas' });

      await selectAgentMode(mockPage as Page, 'single');
      expect(modelSelectOption).toHaveBeenCalledTimes(0);
      expect(agentSelectOption).toHaveBeenCalledWith({ value: '' });
    });

    it('makes 0 selectOption calls on Model/Thinking selects when Agent mode select is absent', async () => {
      const modelSelectOption = vi.fn().mockResolvedValue(['claude-sonnet']);

      (mockPage.locator as any).mockImplementation((selector: string) => {
        const isBroadComposerSelect = selector
          .split(',')
          .some((part) => part.trim() === 'select.composer-select');
        if (isBroadComposerSelect) {
          return {
            first: vi.fn().mockReturnValue({
              count: vi.fn().mockResolvedValue(1),
              selectOption: modelSelectOption,
            }),
          };
        }
        return {
          first: vi.fn().mockReturnValue({
            count: vi.fn().mockResolvedValue(0),
            selectOption: vi.fn(),
          }),
        };
      });

      await selectAgentMode(mockPage as Page, 'orchestrator');
      await selectAgentMode(mockPage as Page, 'single');
      expect(modelSelectOption).toHaveBeenCalledTimes(0);
    });

    it('falls back from { value: "oim-mas" } to { index: 1 } when option enumeration returns empty', async () => {
      const selectOption = vi
        .fn()
        .mockRejectedValueOnce(new Error('Option oim-mas not found'))
        .mockResolvedValueOnce(['custom-mas']);

      (mockPage.locator as any).mockImplementation((selector: string) => {
        if (selector.includes('aria-label="Agent mode"')) {
          return {
            first: vi.fn().mockReturnValue({
              count: vi.fn().mockResolvedValue(1),
              selectOption,
              locator: vi.fn().mockReturnValue({
                all: vi.fn().mockResolvedValue([]),
              }),
            }),
          };
        }
        return { first: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) };
      });

      await selectAgentMode(mockPage as Page, 'orchestrator');

      expect(selectOption).toHaveBeenNthCalledWith(1, { value: 'oim-mas' });
      expect(selectOption).toHaveBeenNthCalledWith(2, { index: 1 });
    });
  });

  describe('collapseExpandedTraceBars', () => {
    it('clicks each expanded trace bar once and returns clicked count', () => {
      const click1 = vi.fn();
      const click2 = vi.fn();
      const querySelectorAll = vi.fn().mockReturnValue([{ click: click1 }, { click: click2 }]);
      const root: TraceBarContainer = { querySelectorAll };

      const count = collapseExpandedTraceBars(root);

      expect(querySelectorAll).toHaveBeenCalledWith('button.trace-bar[aria-expanded="true"]');
      expect(click1).toHaveBeenCalledTimes(1);
      expect(click2).toHaveBeenCalledTimes(1);
      expect(count).toBe(2);
    });

    it('returns 0 when no expanded trace bars exist', () => {
      const root: TraceBarContainer = {
        querySelectorAll: vi.fn().mockReturnValue([]),
      };

      expect(collapseExpandedTraceBars(root)).toBe(0);
    });

    it('handles ArrayLike containers and elements missing .click safely', () => {
      const clickValid = vi.fn();
      const arrayLike: ArrayLike<{ click?: () => void }> = {
        length: 3,
        0: {},
        1: { click: clickValid },
        2: { click: undefined },
      };
      const root: TraceBarContainer = {
        querySelectorAll: vi.fn().mockReturnValue(arrayLike),
      };

      const count = collapseExpandedTraceBars(root);

      expect(clickValid).toHaveBeenCalledTimes(1);
      expect(count).toBe(1);
    });
  });
});


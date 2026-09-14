// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { injectDemoCursor, glideMouse } from '../scripts/video/cursor';
import type { Page, Locator } from '@playwright/test';

// Ambient declarations for jsdom-backed environment
declare const document: any;
declare const window: any;
declare class MouseEvent {
  constructor(type: string, eventInitDict?: any);
}
type HTMLElement = any;

describe('videoCursor', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('injectDemoCursor', () => {
    it('injects #demo-cursor into DOM and is idempotent on multiple calls', async () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => {
          if (typeof fn === 'function') {
            return fn(...args);
          }
          return undefined;
        }),
      } as unknown as Page;

      // First call: element should be created and listener attached
      await injectDemoCursor(mockPage);

      const cursors = document.querySelectorAll('#demo-cursor');
      expect(cursors.length).toBe(1);
      const cursorEl = cursors[0];
      expect(cursorEl).toBeTruthy();
      expect(cursorEl.id).toBe('demo-cursor');

      const initialListenerCount = addEventListenerSpy.mock.calls.filter(
        (call: any) => call[0] === 'mousemove',
      ).length;
      expect(initialListenerCount).toBe(1);

      // Second call: must not create duplicate elements or duplicate listeners
      await injectDemoCursor(mockPage);

      const cursorsAfterSecond = document.querySelectorAll('#demo-cursor');
      expect(cursorsAfterSecond.length).toBe(1);

      const secondListenerCount = addEventListenerSpy.mock.calls.filter(
        (call: any) => call[0] === 'mousemove',
      ).length;
      expect(secondListenerCount).toBe(1);

      // Third call: still idempotent
      await injectDemoCursor(mockPage);
      expect(document.querySelectorAll('#demo-cursor').length).toBe(1);
      expect(
        addEventListenerSpy.mock.calls.filter((call: any) => call[0] === 'mousemove').length,
      ).toBe(1);
    });

    it('updates cursor position when mousemove event is dispatched', async () => {
      const mockPage = {
        evaluate: vi.fn(async (fn: any, ...args: any[]) => fn(...args)),
      } as unknown as Page;

      await injectDemoCursor(mockPage);
      const cursor = document.getElementById('demo-cursor') as HTMLElement;
      expect(cursor).toBeTruthy();

      // Dispatch mousemove
      const mouseEvent = new MouseEvent('mousemove', {
        clientX: 340,
        clientY: 520,
      });
      window.dispatchEvent(mouseEvent);

      expect(cursor.style.transform).toContain('340px');
      expect(cursor.style.transform).toContain('520px');
    });
  });

  describe('glideMouse', () => {
    it('glides mouse smoothly to center of target element bounding box', async () => {
      const moveSpy = vi.fn();
      const mockPage = {
        mouse: {
          move: moveSpy,
        },
      } as unknown as Page;

      const mockLocator = {
        boundingBox: vi.fn().mockResolvedValue({
          x: 100,
          y: 200,
          width: 80,
          height: 40,
        }),
        toString: () => 'locator("button.submit")',
      } as unknown as Locator;

      await glideMouse(mockPage, mockLocator, 30);

      // Center should be x: 100 + 80/2 = 140, y: 200 + 40/2 = 220
      expect(moveSpy).toHaveBeenCalledWith(140, 220, { steps: 30 });
    });

    it('supports string selector and clicks if requested', async () => {
      const moveSpy = vi.fn();
      const clickSpy = vi.fn();
      const mockLocator = {
        boundingBox: vi.fn().mockResolvedValue({
          x: 50,
          y: 60,
          width: 20,
          height: 20,
        }),
        click: clickSpy,
        toString: () => '.my-selector',
      };

      const mockPage = {
        mouse: {
          move: moveSpy,
        },
        locator: vi.fn().mockReturnValue(mockLocator),
      } as unknown as Page;

      await glideMouse(mockPage, '.my-selector', 15, { click: true });

      expect(mockPage.locator).toHaveBeenCalledWith('.my-selector');
      expect(moveSpy).toHaveBeenCalledWith(60, 70, { steps: 15 });
      expect(clickSpy).toHaveBeenCalled();
    });

    it('throws descriptive error with element selector context when bounding box is null', async () => {
      const mockPage = {
        mouse: {
          move: vi.fn(),
        },
      } as unknown as Page;

      const mockLocator = {
        boundingBox: vi.fn().mockResolvedValue(null),
        toString: () => 'locator("button#missing")',
      } as unknown as Locator;

      await expect(glideMouse(mockPage, mockLocator, 20)).rejects.toThrow(
        /locator\("button#missing"\)|not visible|no bounding box/i,
      );

      // Test with string selector
      const mockPageWithString = {
        locator: vi.fn().mockReturnValue({
          boundingBox: vi.fn().mockResolvedValue(null),
          toString: () => '.hidden-card',
        }),
        mouse: {
          move: vi.fn(),
        },
      } as unknown as Page;

      await expect(glideMouse(mockPageWithString, '.hidden-card', 20)).rejects.toThrow(
        /.hidden-card|not visible|no bounding box/i,
      );
    });
  });
});

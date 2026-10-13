// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  focusOnElement,
  resetFocus,
  ElementNotFoundError,
  type CameraFocusOptions,
} from '../scripts/video/camera';
import type { Page, Locator } from '@playwright/test';

// Ambient declarations for jsdom-backed environment
declare const document: any;
declare const window: any;

describe('videoCamera', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.style.zoom = '';
    delete (window as any).__setZoomFactor;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.style.zoom = '';
    delete (window as any).__setZoomFactor;
    vi.restoreAllMocks();
  });

  describe('ElementNotFoundError', () => {
    it('is an instance of Error with name ElementNotFoundError', () => {
      const err = new ElementNotFoundError('Target element not found');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ElementNotFoundError');
      expect(err.message).toBe('Target element not found');
    });
  });

  describe('focusOnElement', () => {
    it('throws ElementNotFoundError when element count is 0', async () => {
      const mockLocator = {
        count: vi.fn().mockResolvedValue(0),
        toString: () => 'locator(".missing-element")',
      } as unknown as Locator;

      const mockPage = {
        locator: vi.fn().mockReturnValue(mockLocator),
        evaluate: vi.fn(),
      } as unknown as Page;

      await expect(
        focusOnElement(mockPage, '.missing-element'),
      ).rejects.toThrow(ElementNotFoundError);

      await expect(
        focusOnElement(mockPage, mockLocator),
      ).rejects.toThrow(/missing-element/);
    });

    it('clamps zoomFactor to [0.5, 3.0] and uses default 1.25 when omitted', async () => {
      let evaluatedZoom: number | null = null;
      const mockPage = {
        locator: vi.fn(),
        evaluate: vi.fn(async (fn: any, arg: any) => {
          if (typeof fn === 'function') {
            evaluatedZoom = arg;
            return fn(arg);
          }
          return undefined;
        }),
      } as unknown as Page;

      const createMockLocator = () =>
        ({
          count: vi.fn().mockResolvedValue(1),
          boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 100, height: 50 }),
          scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
        }) as unknown as Locator;

      // Case 1: default zoomFactor (1.25)
      await focusOnElement(mockPage, createMockLocator());
      expect(evaluatedZoom).toBe(1.25);
      expect(document.body.style.zoom).toBe('1.25');

      // Case 2: lower bound clamping (< 0.5 clamped to 0.5)
      await focusOnElement(mockPage, createMockLocator(), { zoomFactor: 0.1 });
      expect(evaluatedZoom).toBe(0.5);
      expect(document.body.style.zoom).toBe('0.5');

      // Case 3: upper bound clamping (> 3.0 clamped to 3.0)
      await focusOnElement(mockPage, createMockLocator(), { zoomFactor: 5.0 });
      expect(evaluatedZoom).toBe(3.0);
      expect(document.body.style.zoom).toBe('3');

      // Case 4: valid in-range factor (2.0)
      await focusOnElement(mockPage, createMockLocator(), { zoomFactor: 2.0 });
      expect(evaluatedZoom).toBe(2.0);
      expect(document.body.style.zoom).toBe('2');
    });

    it('falls back gracefully without NaN zoom when boundingBox is null or has 0 dimensions', async () => {
      let evaluatedZoom: number | null = null;
      const mockPage = {
        locator: vi.fn(),
        evaluate: vi.fn(async (fn: any, arg: any) => {
          if (typeof fn === 'function') {
            evaluatedZoom = arg;
            return fn(arg);
          }
          return undefined;
        }),
      } as unknown as Page;

      // Null boundingBox
      const nullBoxLocator = {
        count: vi.fn().mockResolvedValue(1),
        boundingBox: vi.fn().mockResolvedValue(null),
        scrollIntoViewIfNeeded: vi.fn(),
      } as unknown as Locator;

      await expect(focusOnElement(mockPage, nullBoxLocator)).resolves.not.toThrow();
      expect(evaluatedZoom).not.toBeNaN();
      expect(evaluatedZoom).toBe(1.25);
      expect(nullBoxLocator.scrollIntoViewIfNeeded).not.toHaveBeenCalled();

      // Zero-width boundingBox
      const zeroDimLocator = {
        count: vi.fn().mockResolvedValue(1),
        boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 0, height: 100 }),
        scrollIntoViewIfNeeded: vi.fn(),
      } as unknown as Locator;

      await expect(focusOnElement(mockPage, zeroDimLocator, { zoomFactor: 1.5 })).resolves.not.toThrow();
      expect(evaluatedZoom).toBe(1.5);
      expect(zeroDimLocator.scrollIntoViewIfNeeded).not.toHaveBeenCalled();
    });

    it('uses window.__setZoomFactor if available', async () => {
      const customSetZoomFactor = vi.fn();
      (window as any).__setZoomFactor = customSetZoomFactor;

      const mockPage = {
        locator: vi.fn(),
        evaluate: vi.fn(async (fn: any, arg: any) => {
          if (typeof fn === 'function') {
            return fn(arg);
          }
          return undefined;
        }),
      } as unknown as Page;

      const locator = {
        count: vi.fn().mockResolvedValue(1),
        boundingBox: vi.fn().mockResolvedValue({ x: 10, y: 10, width: 200, height: 100 }),
        scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
      } as unknown as Locator;

      await focusOnElement(mockPage, locator, { zoomFactor: 1.8 });
      expect(customSetZoomFactor).toHaveBeenCalledWith(1.8);
    });

    it('awaits transition settlement when durationMs is provided', async () => {
      const mockPage = {
        locator: vi.fn(),
        evaluate: vi.fn(),
      } as unknown as Page;

      const locator = {
        count: vi.fn().mockResolvedValue(1),
        boundingBox: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 100 }),
        scrollIntoViewIfNeeded: vi.fn(),
      } as unknown as Locator;

      const start = Date.now();
      await focusOnElement(mockPage, locator, { durationMs: 50 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe('resetFocus', () => {
    it('cleanly resets zoom to 1.0', async () => {
      document.body.style.zoom = '2.5';

      let evaluatedZoom: number | null = null;
      const mockPage = {
        evaluate: vi.fn(async (fn: any, arg: any) => {
          if (typeof fn === 'function') {
            evaluatedZoom = arg;
            return fn(arg);
          }
          return undefined;
        }),
      } as unknown as Page;

      await resetFocus(mockPage);

      expect(evaluatedZoom).toBe(1.0);
      expect(document.body.style.zoom).toBe('1');
    });

    it('uses window.__setZoomFactor when resetting if present', async () => {
      const customSetZoom = vi.fn();
      (window as any).__setZoomFactor = customSetZoom;

      const mockPage = {
        evaluate: vi.fn(async (fn: any, arg: any) => {
          if (typeof fn === 'function') {
            return fn(arg);
          }
          return undefined;
        }),
      } as unknown as Page;

      await resetFocus(mockPage);

      expect(customSetZoom).toHaveBeenCalledWith(1.0);
    });

    it('awaits transition settlement on reset when durationMs is provided', async () => {
      const mockPage = {
        evaluate: vi.fn(),
      } as unknown as Page;

      const start = Date.now();
      await resetFocus(mockPage, { durationMs: 50 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });
});

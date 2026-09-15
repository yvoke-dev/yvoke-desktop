/**
 * Camera focus and zoom utilities for automated demo video recording.
 */
import type { Page, Locator } from '@playwright/test';

// Ambient types for browser-context function executed inside page.evaluate()
declare const document: any;
declare const window: any;

export class ElementNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElementNotFoundError';
  }
}

export interface CameraFocusOptions {
  zoomFactor?: number;
  durationMs?: number;
}

/**
 * Focuses camera on target locator by scrolling it into view and adjusting Chromium zoom.
 * Clamps zoomFactor to [0.5, 3.0] with default 1.25.
 * Throws ElementNotFoundError if element does not exist in DOM.
 * Falls back gracefully without NaN if element has 0 dimensions.
 */
export async function focusOnElement(
  page: Page,
  targetLocator: Locator | string,
  options?: CameraFocusOptions,
): Promise<void> {
  const locator =
    typeof targetLocator === 'string' ? page.locator(targetLocator) : targetLocator;

  const count = typeof locator.count === 'function' ? await locator.count() : 1;
  if (count === 0) {
    const selectorDesc =
      typeof targetLocator === 'string'
        ? targetLocator
        : locator.toString?.() ?? 'Target locator';
    throw new ElementNotFoundError(`Cannot focus camera: Element "${selectorDesc}" not found`);
  }

  const rawZoom = options?.zoomFactor ?? 1.25;
  const clampedZoom = Math.min(3.0, Math.max(0.5, rawZoom));

  const box = typeof locator.boundingBox === 'function' ? await locator.boundingBox() : null;
  if (box && box.width > 0 && box.height > 0) {
    if (typeof locator.scrollIntoViewIfNeeded === 'function') {
      try {
        await locator.scrollIntoViewIfNeeded();
      } catch {
        // Fall back gracefully if locator cannot be scrolled
      }
    }
  }

  await page.evaluate((factor: number) => {
    const win = window as any;
    win.__name = win.__name || function (t: any) { return t; };
    if (typeof win.__setZoomFactor === 'function') {
      win.__setZoomFactor(factor);
    } else if (typeof document !== 'undefined' && document.body) {
      document.body.style.zoom = String(factor);
    }
  }, clampedZoom);

  const durationMs = options?.durationMs ?? 0;
  if (durationMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}

/**
 * Resets the zoom back to standard 1.0.
 */
export async function resetFocus(
  page: Page,
  options?: { durationMs?: number },
): Promise<void> {
  await page.evaluate((factor: number) => {
    const win = window as any;
    win.__name = win.__name || function (t: any) { return t; };
    if (typeof win.__setZoomFactor === 'function') {
      win.__setZoomFactor(factor);
    } else if (typeof document !== 'undefined' && document.body) {
      document.body.style.zoom = String(factor);
    }
  }, 1.0);

  const durationMs = options?.durationMs ?? 0;
  if (durationMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
}

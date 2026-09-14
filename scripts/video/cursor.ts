/**
 * Visual cursor overlay and smooth mouse gliding for automated demo video recording.
 */
import type { Page, Locator } from '@playwright/test';

// Ambient types for browser-context function executed inside page.evaluate()
declare const document: any;
declare const window: any;
type MouseEvent = any;

/**
 * Injects a visible mock cursor into the DOM that tracks mouse movements.
 * Safe to call multiple times (strictly idempotent).
 */
export async function injectDemoCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) {
      return;
    }

    if (window.__demoCursorMoveListener) {
      window.removeEventListener('mousemove', window.__demoCursorMoveListener);
    }

    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 24px;
      height: 24px;
      z-index: 9999999;
      pointer-events: none;
      transform: translate(-100px, -100px);
      transition: transform 0.04s ease-out;
    `;

    cursor.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.35));">
        <path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.5 3.21z" fill="#ffffff" stroke="#1e1e1e" stroke-width="1.5"/>
      </svg>
    `;

    document.body.appendChild(cursor);

    const listener = (e: MouseEvent): void => {
      cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    };

    window.__demoCursorMoveListener = listener;
    window.__demoCursorInjected = true;
    window.addEventListener('mousemove', listener);
  });
}

export interface GlideOptions {
  click?: boolean;
  delayMs?: number;
}

/**
 * Glides the mouse cursor smoothly from its current position to the center of the target element.
 * Throws a descriptive error with selector context if the element has no bounding box.
 */
export async function glideMouse(
  page: Page,
  targetLocator: Locator | string,
  steps = 25,
  options: GlideOptions = {},
): Promise<void> {
  const locator =
    typeof targetLocator === 'string' ? page.locator(targetLocator) : targetLocator;

  const box = await locator.boundingBox();
  if (!box) {
    const selectorDesc =
      typeof targetLocator === 'string'
        ? targetLocator
        : locator.toString?.() ?? 'Target element';
    throw new Error(
      `Cannot glide mouse: Element "${selectorDesc}" is not visible or has no bounding box`,
    );
  }

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;

  await page.mouse.move(targetX, targetY, { steps });

  if (options.delayMs && options.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }

  if (options.click) {
    if (typeof locator.click === 'function') {
      await locator.click();
    } else if (typeof (page.mouse as any).click === 'function') {
      await (page.mouse as any).click(targetX, targetY);
    }
  }
}

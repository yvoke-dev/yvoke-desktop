/**
 * Real App Live Turn Runner.
 * Provides programmatic Playwright interactions for orchestrating live model turns,
 * playbook selection, composer typing, and turn lifecycle monitoring.
 */
import type { Page, Locator } from '@playwright/test';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;

export class ComposerNotFoundError extends Error {
  constructor(message = 'Composer textarea not found in page DOM.') {
    super(message);
    this.name = 'ComposerNotFoundError';
  }
}

export class TurnTimeoutError extends Error {
  constructor(message = 'Turn execution timed out before completion.') {
    super(message);
    this.name = 'TurnTimeoutError';
  }
}

export class PlaybookNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookNotFoundError';
  }
}

export interface TypeComposerOptions {
  delayPerCharMs?: number;
}

function asFirst(loc: Locator): Locator {
  return typeof loc.first === 'function' ? loc.first() : loc;
}

async function asCount(loc: Locator): Promise<number> {
  return typeof loc.count === 'function' ? await loc.count() : 1;
}

/**
 * Focuses and types query text into the composer textarea character-by-character.
 */
export async function typeInComposer(
  page: Page,
  text: string,
  options?: TypeComposerOptions,
): Promise<void> {
  const textarea = asFirst(
    page.locator(
      '.composer-input textarea, .composer textarea, textarea[placeholder*="question"], textarea',
    ),
  );

  const count = await asCount(textarea);
  if (count === 0) {
    throw new ComposerNotFoundError(
      'Composer textarea not found. Ensure the main conversation view is loaded.',
    );
  }

  if (typeof textarea.focus === 'function') {
    await textarea.focus();
  } else if (typeof textarea.click === 'function') {
    await textarea.click();
  }

  const delay = options?.delayPerCharMs ?? 20;
  await page.keyboard.type(text, { delay });
}

/**
 * Selects a specified playbook in the UI, opening the picker if necessary.
 */
export async function selectPlaybook(page: Page, playbookName: string): Promise<void> {
  // Check if picker rows are already visible
  let pickerRows = page.locator('.picker-row, .picker-list button');
  let rowCount = await pickerRows.count();

  if (rowCount === 0) {
    // Attempt to open the playbook picker
    const openTrigger = asFirst(
      page.locator(
        '.active-playbook, button[data-tip*="playbook"], .picker-button, button[aria-label*="playbook"]',
      ),
    );

    if ((await openTrigger.count()) > 0 && typeof openTrigger.click === 'function') {
      await openTrigger.click();
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(200);
      }
    }
    pickerRows = page.locator('.picker-row, .picker-list button');
    rowCount = await pickerRows.count();
  }

  // Find matching playbook row
  const matchingRow = asFirst(
    page
      .locator('.picker-row, .chip, [role="option"], .picker-list button')
      .filter({ hasText: playbookName }),
  );

  const matchCount = await matchingRow.count();
  if (matchCount === 0) {
    throw new PlaybookNotFoundError(
      `Playbook "${playbookName}" not found in picker list. Available count: ${rowCount}.`,
    );
  }

  await matchingRow.click();
}

/**
 * Switches the composer agent mode between 'single' and 'orchestrator' (Multi-agent).
 */
export async function selectAgentMode(
  page: Page,
  mode: 'single' | 'orchestrator',
): Promise<void> {
  const selectLocator = asFirst(
    page.locator('select.composer-select, select[aria-label="Agent mode"]'),
  );

  const count = await selectLocator.count();
  if (count === 0) {
    return;
  }

  if (mode === 'single') {
    await selectLocator.selectOption({ value: '' });
    return;
  }

  // mode === 'orchestrator': find first non-empty option or matching value
  if (typeof selectLocator.locator === 'function') {
    const options = selectLocator.locator('option');
    if (typeof options.all === 'function') {
      const allOpts = await options.all();
      for (const opt of allOpts) {
        const val = await opt.getAttribute('value');
        if (val && val.trim().length > 0) {
          await selectLocator.selectOption({ value: val });
          return;
        }
      }
    }
  }

  // Fallback: select by index or standard profile
  await selectLocator.selectOption({ value: 'oim-mas' }).catch(async () => {
    await selectLocator.selectOption({ index: 1 });
  });
}

/**
 * Dispatches the current draft turn via send button click or keyboard shortcut.
 */
export async function dispatchTurn(page: Page): Promise<void> {
  const sendBtn = asFirst(
    page.locator('button.composer-send, button:has-text("Send")'),
  );

  const count = await sendBtn.count();
  if (count > 0 && typeof sendBtn.isVisible === 'function' && (await sendBtn.isVisible())) {
    if (typeof sendBtn.isEnabled === 'function' && !(await sendBtn.isEnabled())) {
      // Button disabled, fall through to keyboard shortcut
    } else {
      await sendBtn.click();
      return;
    }
  }

  const modifier = process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
  await page.keyboard.press(modifier);
}

export interface WaitForTurnOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  autoCollapseTrace?: boolean;
  autoScrollIntervalMs?: number;
  requireReviewer?: boolean;
  requireSelector?: string;
  minConsecutiveDone?: number;
}

/**
 * Polls until the running turn finishes or displays an interactive decision card.
 * Throws TurnTimeoutError if execution time exceeds timeoutMs.
 */
export async function waitForTurnCompletion(
  page: Page,
  options?: WaitForTurnOptions,
): Promise<{ durationMs: number }> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 200;
  const autoCollapseTrace = options?.autoCollapseTrace ?? true;
  const autoScrollIntervalMs = options?.autoScrollIntervalMs ?? 1000;
  const requireReviewer = options?.requireReviewer ?? false;
  const requireSelector = options?.requireSelector;
  const minConsecutiveDone =
    options?.minConsecutiveDone ?? (requireReviewer || requireSelector ? 3 : 2);
  const startTime = Date.now();
  let lastScrollTime = 0;
  let consecutiveDone = 0;

  while (true) {
    // 0a. Auto-collapse any visible expanded trace bar
    if (autoCollapseTrace) {
      if (typeof (page as any).evaluate === 'function') {
        await (page as any).evaluate(() => {
          const expanded = document.querySelectorAll('button.trace-bar[aria-expanded="true"]');
          expanded.forEach((btn: any) => btn?.click?.());
        }).catch(() => {});
      }
      const expandedTrace = asFirst(
        page.locator('button.trace-bar[aria-expanded="true"]'),
      );
      if ((await asCount(expandedTrace)) > 0) {
        const isTraceVis =
          typeof expandedTrace.isVisible === 'function' ? await expandedTrace.isVisible() : true;
        if (isTraceVis && typeof expandedTrace.click === 'function') {
          await expandedTrace.click().catch(() => {});
        }
      }
    }

    // 0b. Auto-scroll to the bottom periodically while waiting for answers
    const now = Date.now();
    if (autoScrollIntervalMs > 0 && now - lastScrollTime >= autoScrollIntervalMs) {
      lastScrollTime = now;
      if (typeof (page as any).evaluate === 'function') {
        await (page as any).evaluate(() => {
          const el = document.querySelector('.messages');
          if (el) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          } else {
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          }
        }).catch(() => {});
      }
    }

    // 1. Check if an interactive preflight recommendation card is displayed
    const preflightCard = asFirst(
      page.locator('.preflight-card, #demo-preflight-recommendation'),
    );
    if ((await asCount(preflightCard)) > 0) {
      const isVis =
        typeof preflightCard.isVisible === 'function' ? await preflightCard.isVisible() : true;
      if (isVis) {
        return { durationMs: Date.now() - startTime };
      }
    }

    // 2. Check if an interactive clarifying question card is displayed (unanswered)
    const clarifCard = asFirst(page.locator('.clarifying-question-card:not(.answered)'));
    if ((await asCount(clarifCard)) > 0) {
      const isVis =
        typeof clarifCard.isVisible === 'function' ? await clarifCard.isVisible() : true;
      if (isVis) {
        return { durationMs: Date.now() - startTime };
      }
    }

    // 3. Check if turn is still running (stop button visible or live message present)
    const stopBtn = asFirst(
      page.locator('button.danger.composer-send, button:has-text("Stop")'),
    );
    const stopCount = await asCount(stopBtn);
    const isStopVis =
      stopCount > 0 && typeof stopBtn.isVisible === 'function' ? await stopBtn.isVisible() : false;

    const liveMsg = asFirst(page.locator('.message.assistant.live'));
    const liveMsgCount = await asCount(liveMsg);
    const isLiveVis =
      liveMsgCount > 0 && typeof liveMsg.isVisible === 'function'
        ? await liveMsg.isVisible()
        : liveMsgCount > 0;

    const isRunning = isStopVis || isLiveVis;

    if (!isRunning) {
      // Stop button and live message not present; check if send button is mounted / visible
      const sendBtn = asFirst(
        page.locator('button.primary.composer-send, button:has-text("Send")'),
      );
      const sendCount = await asCount(sendBtn);
      const isSendVis =
        sendCount > 0 && typeof sendBtn.isVisible === 'function' ? await sendBtn.isVisible() : true;

      if (isSendVis) {
        let requirementsMet = true;

        if (requireReviewer) {
          const reviewerLoc = asFirst(
            page.locator(
              '.subagent-card .verdict-badge, .subagent-card .subagent-title:has-text("Reviewer"), .subagent-card:has-text("Reviewer"), .subagent-card:has-text("reviewer")',
            ),
          );
          const reviewerCount = await asCount(reviewerLoc);
          if (reviewerCount === 0) {
            requirementsMet = false;
          }
        }

        if (requireSelector) {
          const reqLoc = asFirst(page.locator(requireSelector));
          const reqCount = await asCount(reqLoc);
          if (reqCount === 0) {
            requirementsMet = false;
          }
        }

        if (requirementsMet) {
          consecutiveDone++;
          if (consecutiveDone >= minConsecutiveDone) {
            return { durationMs: Date.now() - startTime };
          }
        } else {
          consecutiveDone = 0;
        }
      } else {
        consecutiveDone = 0;
      }
    } else {
      consecutiveDone = 0;
    }

    // 4. Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      throw new TurnTimeoutError(
        `Turn execution timed out after ${elapsed}ms (limit was ${timeoutMs}ms).`,
      );
    }

    if (typeof page.waitForTimeout === 'function') {
      await page
        .waitForTimeout(pollIntervalMs)
        .catch(() => new Promise((resolve) => setTimeout(resolve, pollIntervalMs)));
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

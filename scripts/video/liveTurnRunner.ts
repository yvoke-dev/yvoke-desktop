/**
 * Real App Live Turn Runner.
 * Provides programmatic Playwright interactions for orchestrating live model turns,
 * playbook selection, composer typing, and turn lifecycle monitoring.
 */
import type { Page, Locator } from '@playwright/test';

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
  const startTime = Date.now();

  while (true) {
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

    // 2. Check if an interactive clarifying question card is displayed
    const clarifCard = asFirst(
      page.locator('.clarifying-question-card:not(.answered), .clarifying-question-card'),
    );
    if ((await asCount(clarifCard)) > 0) {
      const isVis =
        typeof clarifCard.isVisible === 'function' ? await clarifCard.isVisible() : true;
      if (isVis) {
        return { durationMs: Date.now() - startTime };
      }
    }

    // 3. Check if turn is still running (stop button visible)
    const stopBtn = asFirst(
      page.locator('button.danger.composer-send, button:has-text("Stop")'),
    );
    const stopCount = await asCount(stopBtn);
    const isStopVis =
      stopCount > 0 && typeof stopBtn.isVisible === 'function' ? await stopBtn.isVisible() : false;

    if (!isStopVis) {
      // Stop button not visible; check if send button or composer textarea is ready
      const sendBtn = asFirst(
        page.locator('button.primary.composer-send, button:has-text("Send")'),
      );
      const sendCount = await asCount(sendBtn);
      if (sendCount > 0) {
        const isSendVis =
          typeof sendBtn.isVisible === 'function' ? await sendBtn.isVisible() : true;
        const isSendEnabled =
          typeof sendBtn.isEnabled === 'function' ? await sendBtn.isEnabled() : true;

        if (isSendVis && isSendEnabled) {
          return { durationMs: Date.now() - startTime };
        }
      }
    }

    // 4. Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      throw new TurnTimeoutError(
        `Turn execution timed out after ${elapsed}ms (limit was ${timeoutMs}ms).`,
      );
    }

    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(pollIntervalMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, test as baseTest } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

export interface ElectronFixture {
  electronApp: ElectronApplication;
  appPage: Page;
  userDataDir: string;
}

/**
 * Asserts that the built main entry point exists.
 * Throws an immediate descriptive error if the build output is missing.
 */
export function assertBuildArtifactsExist(rootPath: string = process.cwd()): void {
  const mainEntry = path.resolve(rootPath, 'out/main/index.js');
  if (!fs.existsSync(mainEntry)) {
    throw new Error('Build artifacts missing. Run "npm run build" before running E2E tests.');
  }
}

export interface LaunchOptions {
  headless?: boolean;
  seedSettings?: Record<string, unknown>;
  projectRoot?: string;
}

/**
 * Launches the Electron app inside a dedicated temp userData directory with seeded dev settings.
 */
export async function launchTestApp(options: LaunchOptions = {}): Promise<ElectronFixture> {
  const projectRoot = options.projectRoot ?? process.cwd();
  assertBuildArtifactsExist(projectRoot);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-e2e-'));
  const initialSettings = {
    serverAuthMode: 'dev',
    serverBaseUrl: 'http://127.0.0.1:0',
    ...(options.seedSettings ?? {}),
  };
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(initialSettings, null, 2),
    'utf8',
  );

  const threadsDir = path.join(userDataDir, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });
  const seedThread = {
    'e2e-thread-1': {
      id: 'e2e-thread-1',
      title: 'E2E Test Conversation',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'off',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        thoughtTokens: 0,
      },
      syncState: 'synced',
    },
  };
  fs.writeFileSync(
    path.join(threadsDir, 'index.json'),
    JSON.stringify(seedThread, null, 2),
    'utf8',
  );
  const seedMsg = JSON.stringify({
    localId: 'seed-msg-1',
    role: 'assistant',
    content: 'Hello! I am ready.',
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(threadsDir, 'e2e-thread-1.jsonl'), `${seedMsg}\n`, 'utf8');

  // Runs headless by default unless --headed is passed or YVOKE_HEADLESS=0 is set
  const isHeadless =
    options.headless ??
    (!process.argv.includes('--headed') && process.env.YVOKE_HEADLESS !== '0');

  const mainEntry = path.resolve(projectRoot, 'out/main/index.js');
  const electronApp = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      YVOKE_USER_DATA_DIR: userDataDir,
      YVOKE_HEADLESS: isHeadless ? '1' : '0',
    },
  });

  const appPage = await electronApp.firstWindow();

  // Wait for .app-loading to detach and the main interface to be ready
  const loading = appPage.locator('.app-loading');
  if ((await loading.count()) > 0) {
    await loading.waitFor({ state: 'detached', timeout: 15_000 });
  }

  await appPage.waitForLoadState('domcontentloaded');

  return { electronApp, appPage, userDataDir };
}

/**
 * Closes the Electron app with timeout fallback to SIGKILL, then deletes the temporary directory.
 */
export async function closeTestApp(fixture: {
  electronApp?: ElectronApplication | null;
  userDataDir?: string;
}): Promise<void> {
  if (fixture.electronApp) {
    try {
      await fixture.electronApp.evaluate(({ app }) => {
        app.quit();
      }).catch(() => {});
      const closePromise = fixture.electronApp.close();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 5000);
      });
      const result = await Promise.race([closePromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (result === 'timeout') {
        const proc = fixture.electronApp.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }
    } catch {
      try {
        const proc = fixture.electronApp.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill errors during fallback
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (fixture.userDataDir && fs.existsSync(fixture.userDataDir)) {
    try {
      fs.rmSync(fixture.userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort directory removal
    }
  }
}

/**
 * Playwright test fixture providing an isolated Electron test instance per test.
 */
export const test = baseTest.extend<{ app: ElectronFixture }>({
  app: async ({}, use) => {
    const fixture = await launchTestApp();
    try {
      await use(fixture);
    } finally {
      await closeTestApp(fixture);
    }
  },
});

export { expect } from '@playwright/test';

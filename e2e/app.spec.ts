import fs from 'node:fs';
import path from 'node:path';
import { assertBuildArtifactsExist, expect, test } from './support/electronFixture';

test.describe('Yvoke Desktop Application E2E', () => {
  test('launches application and renders essential layout elements', async ({ app }) => {
    const { appPage } = app;

    await expect(appPage.locator('.app')).toBeVisible();
    await expect(appPage.locator('.titlebar')).toBeVisible();
    await expect(appPage.locator('.thread-list')).toBeVisible();
    await expect(appPage.locator('.main-pane')).toBeVisible();
  });

  test('displays dev auth chip and dev account-mode badge', async ({ app }) => {
    const { appPage } = app;

    const accountChip = appPage.locator('.account-chip');
    await expect(accountChip).toBeVisible();

    const accountMode = appPage.locator('.account-mode');
    await expect(accountMode).toBeVisible();
    await expect(accountMode).toContainText('dev');
  });

  test('controls composer send button availability based on draft content', async ({ app }) => {
    const { appPage } = app;

    // Open the seeded conversation
    const threadItem = appPage.locator('.thread-item', { hasText: 'E2E Test Conversation' });
    await expect(threadItem).toBeVisible();
    await threadItem.click();

    // Verify ChatView and composer are present
    const composerTextarea = appPage.locator('.composer-input textarea');
    const sendButton = appPage.locator('button.composer-send');

    await expect(composerTextarea).toBeVisible();
    await expect(sendButton).toBeVisible();

    // Initially empty draft -> disabled
    await expect(sendButton).toBeDisabled();

    // Whitespace only -> disabled
    await composerTextarea.fill('    ');
    await expect(sendButton).toBeDisabled();

    // Text entered -> enabled
    await composerTextarea.fill('What is the latest system update?');
    await expect(sendButton).toBeEnabled();

    // Cleared -> disabled again
    await composerTextarea.fill('');
    await expect(sendButton).toBeDisabled();
  });

  test('saves settings and persists theme preference to disk', async ({ app }) => {
    const { appPage, userDataDir } = app;

    // Open settings view
    const settingsButton = appPage.locator('button[data-tip="Settings"]');
    await settingsButton.click();

    const settingsView = appPage.locator('.settings-view');
    await expect(settingsView).toBeVisible();

    // Switch to Appearance tab
    const appearanceTab = settingsView.locator('.settings-nav button', { hasText: 'Appearance' });
    await appearanceTab.click();

    // Select Dark theme
    const darkThemeChoice = settingsView.locator('.theme-choice', { hasText: 'Dark' });
    await darkThemeChoice.click();

    // Save changes
    const saveButton = settingsView.locator('.dialog-actions button.primary', { hasText: 'Save' });
    await saveButton.click();

    // Modal closes
    await expect(settingsView).not.toBeVisible();

    // Verify persisted theme on disk
    const settingsDiskPath = path.join(userDataDir, 'settings.json');
    expect(fs.existsSync(settingsDiskPath)).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(settingsDiskPath, 'utf8'));
    expect(persisted.appearance?.theme).toBe('dark');
  });

  test('cancels and closes settings view without changes', async ({ app }) => {
    const { appPage } = app;

    // Open settings view
    const settingsButton = appPage.locator('button[data-tip="Settings"]');
    await settingsButton.click();

    const settingsView = appPage.locator('.settings-view');
    await expect(settingsView).toBeVisible();

    // Cancel
    const cancelButton = settingsView.locator('.dialog-actions button', { hasText: 'Cancel' });
    await cancelButton.click();

    await expect(settingsView).not.toBeVisible();
  });

  test('negative: rejects preflight when build artifacts are missing', () => {
    const nonExistentPath = path.join(process.cwd(), 'non-existent-build-directory');
    expect(() => assertBuildArtifactsExist(nonExistentPath)).toThrow(
      'Build artifacts missing. Run "npm run build" before running E2E tests.',
    );
  });

  test('negative: enforces loopback containment and rejects insecure remote serverBaseUrl', async ({ app }) => {
    const { appPage, userDataDir } = app;

    // Verify initial loopback containment on disk
    const settingsDiskPath = path.join(userDataDir, 'settings.json');
    const initialSettings = JSON.parse(fs.readFileSync(settingsDiskPath, 'utf8'));
    expect(initialSettings.serverBaseUrl).toBe('http://127.0.0.1:0');

    // Open settings view
    const settingsButton = appPage.locator('button[data-tip="Settings"]');
    await settingsButton.click();

    const settingsView = appPage.locator('.settings-view');
    await expect(settingsView).toBeVisible();

    // Input insecure remote HTTP url in Server tab
    const serverUrlInput = settingsView.locator('input[aria-label="Server base URL"]');
    await serverUrlInput.fill('http://insecure-remote.example.com');

    // Attempt to save
    const saveButton = settingsView.locator('.dialog-actions button.primary', { hasText: 'Save' });
    await saveButton.click();

    // Surface error banner
    const errorBanner = settingsView.locator('.banner.error');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(
      'serverBaseUrl must use https (http allowed only for localhost)',
    );

    // Verify disk settings remain untouched (loopback contained)
    const diskSettingsAfterFailure = JSON.parse(fs.readFileSync(settingsDiskPath, 'utf8'));
    expect(diskSettingsAfterFailure.serverBaseUrl).toBe('http://127.0.0.1:0');
  });
});

import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Resolves the directory to be used for Electron userData.
 * Relative paths are resolved to absolute paths against the working directory.
 * If envVal is empty or omitted, falls back to defaultPath.
 * Recursively ensures the directory exists before returning.
 */
export function resolveUserDataDir(envVal?: string, defaultPath?: string): string {
  const candidate = envVal && envVal.trim().length > 0 ? envVal.trim() : defaultPath && defaultPath.trim().length > 0 ? defaultPath.trim() : undefined;
  if (!candidate) {
    throw new Error('No valid userData directory path specified.');
  }

  const resolved = path.resolve(candidate);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Checks whether headless mode is active. Strictly returns true when envVal is '1'.
 */
export function isHeadless(envVal?: string): boolean {
  return envVal === '1';
}

/**
 * Merges window constructor options for headless execution.
 * When headless, show is set to false and webPreferences.backgroundThrottling is set to false.
 */
export function getMainWindowOptions(
  headless: boolean,
  baseOptions: BrowserWindowConstructorOptions = {},
): BrowserWindowConstructorOptions {
  if (!headless) {
    return { ...baseOptions };
  }

  return {
    ...baseOptions,
    show: false,
    webPreferences: {
      ...baseOptions.webPreferences,
      backgroundThrottling: false,
    },
  };
}

/**
 * Recovers from a corrupted settings.json in the userData directory.
 * If the file exists but contains invalid JSON, it is backed up to settings.json.bak
 * and removed so that SettingsStore can safely load default configuration.
 * Returns true if recovery was performed, false otherwise.
 */
export function recoverCorruptedSettings(userDataDir: string): boolean {
  const settingsPath = path.join(userDataDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    JSON.parse(raw);
    return false;
  } catch {
    const backupPath = `${settingsPath}.bak`;
    try {
      fs.copyFileSync(settingsPath, backupPath);
    } catch {
      // Ignore backup copy failures if source cannot be read
    }
    fs.rmSync(settingsPath, { force: true });
    return true;
  }
}

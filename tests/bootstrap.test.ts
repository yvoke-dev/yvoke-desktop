import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';
import {
  getMainWindowOptions,
  isHeadless,
  resolveUserDataDir,
} from '../src/main/bootstrap';
import { CURRENT_SETTINGS_VERSION, SettingsStore } from '../src/main/settings/Settings';

describe('bootstrap helpers', () => {
  const tempDirsToClean: string[] = [];

  const createTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirsToClean.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirsToClean.length > 0) {
      const dir = tempDirsToClean.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  describe('resolveUserDataDir', () => {
    it('resolves relative path to absolute and creates directory recursively', () => {
      const tmpTarget = path.join(os.tmpdir(), `tmp-test-bootstrap-${Date.now()}`);
      const relPath = path.relative(process.cwd(), tmpTarget);
      const resolved = resolveUserDataDir(relPath);
      tempDirsToClean.push(resolved);

      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved).toBe(path.resolve(tmpTarget));
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it('ensures an absolute path directory exists recursively and returns it', () => {
      const parent = createTempDir('yvoke-bootstrap-');
      const target = path.join(parent, 'nested', 'deep', 'profile');
      const resolved = resolveUserDataDir(target);

      expect(resolved).toBe(target);
      expect(fs.existsSync(resolved)).toBe(true);
      expect(fs.statSync(resolved).isDirectory()).toBe(true);
    });

    it('falls back to defaultPath when envVal is undefined', () => {
      const parent = createTempDir('yvoke-fallback-');
      const fallback = path.join(parent, 'default-userData');
      const resolved = resolveUserDataDir(undefined, fallback);

      expect(resolved).toBe(fallback);
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it('falls back to defaultPath when envVal is empty string or only whitespace', () => {
      const parent = createTempDir('yvoke-fallback-empty-');
      const fallback = path.join(parent, 'default-userData');
      const resolved = resolveUserDataDir('   ', fallback);

      expect(resolved).toBe(fallback);
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it('throws when neither envVal nor defaultPath is provided', () => {
      expect(() => resolveUserDataDir(undefined, undefined)).toThrow(
        /userData directory/i,
      );
      expect(() => resolveUserDataDir('', '  ')).toThrow(
        /userData directory/i,
      );
    });
  });

  describe('isHeadless', () => {
    it('returns true strictly when value is "1"', () => {
      expect(isHeadless('1')).toBe(true);
    });

    it('returns false for other truthy or falsy strings and undefined', () => {
      expect(isHeadless('0')).toBe(false);
      expect(isHeadless('true')).toBe(false);
      expect(isHeadless('false')).toBe(false);
      expect(isHeadless('yes')).toBe(false);
      expect(isHeadless('')).toBe(false);
      expect(isHeadless(undefined)).toBe(false);
    });
  });

  describe('getMainWindowOptions', () => {
    const baseOptions: BrowserWindowConstructorOptions = {
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      title: 'Yvoke - Desktop',
      webPreferences: {
        preload: '/path/to/preload.js',
        contextIsolation: true,
      },
    };

    it('leaves base options unmodified and show/backgroundThrottling unforced when not headless', () => {
      const options = getMainWindowOptions(false, baseOptions);
      expect(options.width).toBe(1200);
      expect(options.height).toBe(800);
      expect(options.show).toBeUndefined();
      expect(options.webPreferences?.backgroundThrottling).toBeUndefined();
      expect(options.webPreferences?.preload).toBe('/path/to/preload.js');
    });

    it('sets show: false and webPreferences.backgroundThrottling: false when headless', () => {
      const options = getMainWindowOptions(true, baseOptions);
      expect(options.show).toBe(false);
      expect(options.webPreferences?.backgroundThrottling).toBe(false);
      expect(options.webPreferences?.preload).toBe('/path/to/preload.js');
      expect(options.width).toBe(1200);
      expect(options.height).toBe(800);
    });

    it('handles omitted baseOptions cleanly', () => {
      const headlessOpts = getMainWindowOptions(true);
      expect(headlessOpts.show).toBe(false);
      expect(headlessOpts.webPreferences?.backgroundThrottling).toBe(false);

      const headedOpts = getMainWindowOptions(false);
      expect(headedOpts.show).toBeUndefined();
      expect(headedOpts.webPreferences?.backgroundThrottling).toBeUndefined();
    });
  });

  describe('SettingsStore corrupt JSON tolerance', () => {
    it('safely recovers to project defaults when settings.json contains corrupt syntax', () => {
      const dir = createTempDir('yvoke-corrupt-settings-');
      const settingsFile = path.join(dir, 'settings.json');
      fs.writeFileSync(settingsFile, '{ "serverAuthMode": "dev", CORRUPTED SYNTAX !!!');

      const store = new SettingsStore(dir);
      expect(store.get().settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
      expect(store.get().serverAuthMode).toBeDefined();
    });
  });
});

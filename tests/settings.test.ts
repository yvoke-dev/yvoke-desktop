import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_KEYS, CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS, SettingsStore } from '../src/main/settings/Settings';

/**
 * The store merges the user's profile OVER the bundled defaults and `set()` writes the whole merged
 * object back — so the first time anyone pressed Save, every value then current was frozen into
 * their profile and a later release could never change a default for them again. Two mechanisms
 * fix that, and these are the tests for both:
 *
 *  - `allowedDomains` is deployment configuration, so it is always taken from the bundle;
 *  - `enabled` stays a user preference, reconciled with the bundle exactly once per version bump.
 *
 * The bundle here is the repository's own `settings.json`, which `loadProjectDefaults` finds via
 * `process.cwd()`. Assertions are written against whatever it says rather than against literals,
 * so the tests describe the mechanism and do not break when the shipped defaults change.
 */
describe('SettingsStore — versioned defaults', () => {
  let dir: string;
  const bundled = DEFAULT_SETTINGS;

  /** What a fresh profile resolves to: the bundle, with no user file involved. */
  const bundle = (): ReturnType<SettingsStore['get']> => new SettingsStore(dir).get();

  const writeProfile = (raw: Record<string, unknown>): void =>
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw));

  /**
   * A profile as the previous `set()` wrote them: a full snapshot with NO version field. Built by
   * removing the stamp from the defaults, because `DEFAULT_SETTINGS` now carries it — spreading it
   * unmodified would produce an already-reconciled profile and quietly test nothing.
   */
  const unstamped = (webSearch: { enabled: boolean; allowedDomains: string[] }): Record<string, unknown> => {
    const { settingsVersion: _drop, ...rest } = bundled;
    return { ...rest, webSearch };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-settings-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps a fresh profile with the current version', () => {
    expect(bundle().settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('applies a changed default to a profile that predates the stamp', () => {
    const shipped = bundle().webSearch.enabled;
    // An old profile: a full snapshot, exactly as the previous `set()` would have written it,
    // carrying the opposite of whatever the bundle now ships and no version field at all.
    writeProfile(unstamped({ enabled: !shipped, allowedDomains: [] }));
    expect(new SettingsStore(dir).get().webSearch.enabled).toBe(shipped);
  });

  it('respects a deliberate choice once the profile is stamped', () => {
    const shipped = bundle().webSearch.enabled;
    writeProfile({
      ...bundled,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      webSearch: { enabled: !shipped, allowedDomains: [] },
    });
    // Already reconciled, so the stored preference wins — in both directions.
    expect(new SettingsStore(dir).get().webSearch.enabled).toBe(!shipped);
  });

  it('takes allowedDomains from the bundle even when the profile stored its own', () => {
    writeProfile({
      ...bundled,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      webSearch: { enabled: true, allowedDomains: ['stale.example.com'] },
    });
    const loaded = new SettingsStore(dir).get();
    expect(loaded.webSearch.allowedDomains).toEqual(bundle().webSearch.allowedDomains);
    expect(loaded.webSearch.allowedDomains).not.toContain('stale.example.com');
  });

  it('never persists a renderer-supplied domain list', () => {
    const store = new SettingsStore(dir);
    const shipped = store.get().webSearch.allowedDomains;
    store.set({ webSearch: { enabled: true, allowedDomains: ['injected.example.com'] } });
    expect(store.get().webSearch.allowedDomains).toEqual(shipped);
    // And nothing else on disk claims otherwise.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.webSearch.allowedDomains).toEqual(shipped);
  });

  it('keeps the enable switch a real preference through a save', () => {
    const store = new SettingsStore(dir);
    store.set({ webSearch: { enabled: false, allowedDomains: [] } });
    expect(store.get().webSearch.enabled).toBe(false);
    // Reloading must not undo it: the save stamped the profile, so no reconciliation runs.
    expect(new SettingsStore(dir).get().webSearch.enabled).toBe(false);
  });

  it('writes the version stamp on save, which is what ends the reconciliation', () => {
    writeProfile(unstamped({ enabled: false, allowedDomains: [] }));
    const store = new SettingsStore(dir);
    store.set({ defaultThinkingLevel: 'low' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it('treats a garbage version field as never reconciled rather than as current', () => {
    const shipped = bundle().webSearch.enabled;
    writeProfile({
      ...bundled,
      settingsVersion: 'yesterday',
      webSearch: { enabled: !shipped, allowedDomains: [] },
    });
    expect(new SettingsStore(dir).get().webSearch.enabled).toBe(shipped);
  });
});

describe('SettingsStore — playbookValidationExcludedPlaybooks deployment configuration', () => {
  let dir: string;
  const bundle = (): ReturnType<SettingsStore['get']> => new SettingsStore(dir).get();
  const writeProfile = (raw: Record<string, unknown>): void =>
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-settings-excl-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reflects bundle defaults on a fresh profile', () => {
    const loaded = bundle();
    expect(Array.isArray(loaded.playbookValidationExcludedPlaybooks)).toBe(true);
    expect(loaded.playbookValidationExcludedPlaybooks).toEqual(DEFAULT_SETTINGS.playbookValidationExcludedPlaybooks);
  });

  it('overwrites stale or injected stored profile values with bundle defaults on load', () => {
    writeProfile({
      ...DEFAULT_SETTINGS,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      playbookValidationExcludedPlaybooks: ['injected-playbook', 'stale-playbook'],
    });
    const loaded = new SettingsStore(dir).get();
    expect(loaded.playbookValidationExcludedPlaybooks).toEqual(bundle().playbookValidationExcludedPlaybooks);
    expect(loaded.playbookValidationExcludedPlaybooks).not.toContain('injected-playbook');
  });

  it('preserves bundle defaults upon corrupt JSON recovery', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ invalid json string');
    const loaded = new SettingsStore(dir).get();
    expect(Array.isArray(loaded.playbookValidationExcludedPlaybooks)).toBe(true);
    expect(loaded.playbookValidationExcludedPlaybooks).toEqual(DEFAULT_SETTINGS.playbookValidationExcludedPlaybooks);
  });

  it('sanitizes non-array stored value to an array on load', () => {
    writeProfile({
      ...DEFAULT_SETTINGS,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      playbookValidationExcludedPlaybooks: 'not-an-array',
    });
    const loaded = new SettingsStore(dir).get();
    expect(Array.isArray(loaded.playbookValidationExcludedPlaybooks)).toBe(true);
    expect(loaded.playbookValidationExcludedPlaybooks).toEqual(bundle().playbookValidationExcludedPlaybooks);
  });

  it('does NOT contain playbookValidationExcludedPlaybooks in ALLOWED_KEYS', () => {
    expect(ALLOWED_KEYS).not.toContain('playbookValidationExcludedPlaybooks');
  });

  it('preserves bundle defaults on disk and drops injected values during store.set', () => {
    const store = new SettingsStore(dir);
    const shipped = store.get().playbookValidationExcludedPlaybooks;
    store.set({ playbookValidationExcludedPlaybooks: ['hacked-playbook'] } as any);
    expect(store.get().playbookValidationExcludedPlaybooks).toEqual(shipped);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.playbookValidationExcludedPlaybooks).toEqual(shipped);
    expect(onDisk.playbookValidationExcludedPlaybooks).not.toContain('hacked-playbook');
  });
});


import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_APPEARANCE, DEFAULT_ORCHESTRATOR_SETTINGS } from '../../shared/types';
import type { AppSettings } from '../../shared/types';

/**
 * Bumped whenever a *changed default* must reach profiles that already exist.
 *
 * Version 1 exists because turning web search on by default reaches nobody otherwise: the store
 * merges the user's file over the bundled defaults and `set()` writes the whole merged object, so
 * the first time anyone pressed Save their then-current `webSearch.enabled: false` was frozen in.
 */
export const CURRENT_SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  serverBaseUrl: '',
  mcpTransport: 'http',
  // Fail closed: an unconfigured build defaults to Entra so it never silently emits
  // the static dev token. The bundled settings.json sets the real values.
  serverAuthMode: 'entra',
  entra: {
    clientId: '',
    tenantId: '',
    scope: '',
  },
  models: [],
  defaultModel: '',
  defaultThinkingLevel: 'off',
  webSearch: {
    enabled: false,
    allowedDomains: [],
  },
  maxTurns: 0,
  playbookValidationEnabled: true,
  imageDescriptionsEnabled: true,
  showPrototypePlaybooks: false,
  orchestrator: DEFAULT_ORCHESTRATOR_SETTINGS,
  appearance: DEFAULT_APPEARANCE,
};

function loadProjectDefaults(): AppSettings {
  try {
    // Packaged app: settings.json is copied into resources (see electron-builder.yml
    // extraResources). A Finder/Explorer-launched app has an unrelated process.cwd(),
    // so resolve resourcesPath first and fall back to cwd for dev runs.
    const candidates: string[] = [];
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'settings.json'));
    }
    candidates.push(path.join(process.cwd(), 'settings.json'));
    const localFile = candidates.find((f) => fs.existsSync(f));
    if (localFile) {
      const raw = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        entra: { ...DEFAULT_SETTINGS.entra, ...(raw.entra ?? {}) },
        webSearch: { ...DEFAULT_SETTINGS.webSearch, ...(raw.webSearch ?? {}) },
        orchestrator: raw.orchestrator
          ? { ...DEFAULT_SETTINGS.orchestrator, ...raw.orchestrator }
          : DEFAULT_SETTINGS.orchestrator,
        appearance: { ...DEFAULT_APPEARANCE, ...(raw.appearance ?? {}) },
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

/**
 * Merge the stored `webSearch` block over the bundled one, with two deliberate overrides.
 *
 * `allowedDomains` is **deployment configuration, not a user preference** — the domains worth
 * searching belong to whichever knowledge base is loaded, so they ship with the app. Always taking
 * the bundle's list is what lets a release add a domain without a migration, and it is safe to do
 * retroactively because an empty list is refused at runtime anyway: `[]` was never a working user
 * choice, only an unconfigured state.
 *
 * `enabled` is a real preference and stays the user's, except once — when their profile predates
 * `CURRENT_SETTINGS_VERSION`, the bundle's value is applied so a changed default lands. After
 * their next Save the stamp is persisted and their choice is final in both directions.
 */
function reconcileWebSearch(
  projectDefaults: AppSettings,
  raw: { webSearch?: Partial<AppSettings['webSearch']>; settingsVersion?: unknown },
): AppSettings['webSearch'] {
  const stored = Number(raw.settingsVersion ?? 0);
  const merged = {
    ...projectDefaults.webSearch,
    ...(raw.webSearch ?? {}),
    allowedDomains: projectDefaults.webSearch.allowedDomains,
  };
  if (!Number.isFinite(stored) || stored < CURRENT_SETTINGS_VERSION) {
    merged.enabled = projectDefaults.webSearch.enabled;
  }
  return merged;
}

/**
 * Top-level keys a renderer is allowed to persist; anything else is dropped.
 *
 * `settingsVersion` is deliberately absent: `set()` stamps it from `CURRENT_SETTINGS_VERSION` after
 * the update is merged, so a renderer-supplied value could never survive anyway — listing it would
 * imply a control that does not exist.
 */
const ALLOWED_KEYS: ReadonlyArray<keyof AppSettings> = [
  'serverBaseUrl',
  'mcpTransport',
  'serverAuthMode',
  'entra',
  'models',
  'defaultModel',
  'defaultThinkingLevel',
  'webSearch',
  'maxTurns',
  'playbookValidationEnabled',
  'imageDescriptionsEnabled',
  'showPrototypePlaybooks',
  'orchestrator',
  'appearance',
];

/**
 * Reject a serverBaseUrl that would send an Entra bearer over plaintext: require https,
 * allowing http only for a localhost/loopback origin.
 */
function assertValidServerBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid serverBaseUrl: ${value}`);
  }
  if (url.protocol === 'https:') return;
  if (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    return;
  }
  throw new Error(
    `serverBaseUrl must use https (http allowed only for localhost): ${value}`,
  );
}

/** Keep only whitelisted top-level keys, dropping anything a compromised renderer injects. */
function sanitizeUpdate(update: Partial<AppSettings>): Partial<AppSettings> {
  const clean: Partial<AppSettings> = {};
  for (const key of ALLOWED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      (clean as Record<string, unknown>)[key] = update[key];
    }
  }
  return clean;
}

/** JSON-file-backed settings store; the directory is injected so tests can use a tmp dir. */
export class SettingsStore {
  private readonly file: string;
  private cache: AppSettings;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    this.cache = this.load();
  }

  private load(): AppSettings {
    const projectDefaults = loadProjectDefaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw.mcpTransport === 'sse') {
        raw.mcpTransport = 'http';
      }
      return {
        ...projectDefaults,
        ...raw,
        // Stamped current in memory whether or not the stored file said so, so a profile that is
        // reconciled here is not reconciled again after the next Save persists it.
        settingsVersion: CURRENT_SETTINGS_VERSION,
        entra: { ...projectDefaults.entra, ...(raw.entra ?? {}) },
        webSearch: reconcileWebSearch(projectDefaults, raw),
        orchestrator: raw.orchestrator
          ? { ...projectDefaults.orchestrator, ...raw.orchestrator }
          : projectDefaults.orchestrator,
        appearance: { ...DEFAULT_APPEARANCE, ...(projectDefaults.appearance ?? {}), ...(raw.appearance ?? {}) },
      };
    } catch {
      return { ...projectDefaults };
    }
  }

  get(): AppSettings {
    return this.cache;
  }

  set(rawUpdate: Partial<AppSettings>): AppSettings {
    const update = sanitizeUpdate(rawUpdate);
    if (typeof update.serverBaseUrl === 'string' && update.serverBaseUrl !== '') {
      assertValidServerBaseUrl(update.serverBaseUrl);
    }
    this.cache = {
      ...this.cache,
      ...update,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      entra: { ...this.cache.entra, ...(update.entra ?? {}) },
      webSearch: {
        ...this.cache.webSearch,
        ...(update.webSearch ?? {}),
        // Never persisted from the renderer: the list is deployment config, and letting a Save
        // freeze a copy of it into the profile is the exact mechanism this change removes.
        allowedDomains: this.cache.webSearch.allowedDomains,
      },
      orchestrator: update.orchestrator
        ? { ...this.cache.orchestrator, ...update.orchestrator }
        : this.cache.orchestrator,
      appearance: { ...DEFAULT_APPEARANCE, ...this.cache.appearance, ...(update.appearance ?? {}) },
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    return this.cache;
  }
}

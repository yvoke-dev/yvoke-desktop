/**
 * Orchestrator runner for automated Yvoke Desktop demo video generation.
 *
 * Automates:
 * 1. Preflight checks for build artifacts, backend connectivity, Claude CLI, and GEMINI_API_KEY.
 * 2. Seeding an isolated ephemeral userDataDir (`yvoke-demo-video-*`) with local dev settings
 *    and optional read-only cloning of local conversation threads (or synthetic background threads).
 * 3. Headed Playwright Electron launch at 1280x720 (720p HD) with video recording and demo cursor injection.
 * 4. 7-scene live walkthrough calibrated to measured Gemini TTS (`Puck`) durations (`00:00 -> 04:10`, 250s):
 *    - Scene 1: App & Sidebar Overview (dual Yvoke & Claude account footer, instant search)
 *    - Scene 2: Settings Walkthrough (Server, Accounts, Models, Agents, Web search, Appearance, About)
 *    - Scene 3: Main Window, Inline Playbook Picker & Composer
 *    - Scene 4: Live Query 1 — Playbook Validation Recommendation
 *    - Scene 5: Live Query 2 — Follow-Up, Citations & Search Hints (`oim-full`)
 *    - Scene 6: Live Query 3 — Clarifying Questions & Trace Inspection
 *    - Scene 7: Live Query 4 — Multi-Agent System (MAS) & Reviewer Gate
 * 5. Wall-clock-anchored, sample-exact audio/video/subtitle synchronization via `createTimelineSyncController`.
 * 6. FFmpeg MP4 stitching with optional sidechain ducking, 10x live-turn acceleration, and sidecar SRT output.
 * 7. Resilient teardown with signal traps and a 5-second SIGKILL fallback.
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env not present or unreadable
  }
}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  runAllPreflightChecks,
  checkBuildArtifacts,
  checkGeminiApiKey,
} from './video/preflight';
import { injectDemoCursor, glideMouse } from './video/cursor';
import {
  stitchVideoAndAudio,
  FfmpegNotFoundError,
  type AccelerationInterval,
} from './video/stitch';
import {
  STORYBOARD_BEATS,
  parseTimeRange,
  getSceneSegments,
  getSegmentNarration,
  getSegmentDuration,
  type SceneSegment,
} from './video/storyboard';
import {
  typeInComposer,
  selectPlaybook,
  selectAgentMode,
  dispatchTurn,
  waitForTurnCompletion,
  buildPlaybookTitlePattern,
} from './video/liveTurnRunner';
import {
  synthesizeSpeech,
  pcmToWav,
  combineSynthesizeResults,
  createSilencePcm,
  createTimelineSyncController,
  type SynthesizeResult,
} from './video/tts';
import { generateSrt, remapTimestamp } from './video/subtitles';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;
declare const MutationObserver: any;

export interface AutoCollapseTraceWindow {
  __autoCollapseTrace?: boolean;
  __stopAutoCollapseTrace?: () => void;
}

export interface AutoCollapseTraceDocument {
  body: unknown;
  querySelectorAll(
    selector: string,
  ): Iterable<{ click?: () => void }> | ArrayLike<{ click?: () => void }>;
}

export interface AutoCollapseTraceObserverLike {
  observe(target: unknown, options: Record<string, unknown>): void;
  disconnect(): void;
}

export interface AutoCollapseTraceEnv {
  win?: AutoCollapseTraceWindow;
  doc?: AutoCollapseTraceDocument;
  MutationObserverCtor?: new (callback: () => void) => AutoCollapseTraceObserverLike;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
}

/**
 * Self-contained browser-context installer for the global auto-collapse trace observer.
 * Zero outer-scope references so Playwright `appPage.evaluate(installAutoCollapseTraceObserver)`
 * serializes cleanly. Single-clicks expanded trace bars and exposes idempotent `__stopAutoCollapseTrace()`.
 */
export function installAutoCollapseTraceObserver(env?: AutoCollapseTraceEnv): void {
  const w: AutoCollapseTraceWindow = env?.win ?? window;
  const doc: AutoCollapseTraceDocument = env?.doc ?? document;
  const MO = env?.MutationObserverCtor ?? MutationObserver;
  const setInt: (fn: () => void, ms: number) => unknown =
    env?.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clrInt: (id: unknown) => void =
    env?.clearIntervalFn ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  const setTo: (fn: () => void, ms: number) => unknown =
    env?.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clrTo: (id: unknown) => void =
    env?.clearTimeoutFn ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  if (typeof w.__stopAutoCollapseTrace === 'function') {
    w.__stopAutoCollapseTrace();
  }

  w.__autoCollapseTrace = true;
  let isCollapsing = false;
  let stopped = false;
  let resetTimer: unknown = null;

  const collapse = (): void => {
    if (stopped || !w.__autoCollapseTrace || isCollapsing) return;
    const expandedButtons = Array.from(
      doc.querySelectorAll('button.trace-bar[aria-expanded="true"]'),
    );
    if (expandedButtons.length > 0) {
      isCollapsing = true;
      for (const btn of expandedButtons) {
        if (typeof btn?.click === 'function') {
          btn.click();
        }
      }
      resetTimer = setTo(() => {
        resetTimer = null;
        isCollapsing = false;
      }, 30);
    }
  };

  const observer = new MO(collapse);
  if (doc.body) {
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    });
  }
  const intervalId = setInt(collapse, 100);

  w.__stopAutoCollapseTrace = (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clrInt(intervalId);
    if (resetTimer !== null) {
      clrTo(resetTimer);
      resetTimer = null;
    }
    isCollapsing = false;
  };
}

function parseEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

parseEnvFile(path.resolve(process.cwd(), '.env.local'));
parseEnvFile(path.resolve(process.cwd(), '.env'));

export const SCENE_PRESETS: Record<string, number[]> = {
  all: [1, 2, 3, 4, 5, 6, 7],
  'without-settings': [1, 3, 4, 5, 6, 7],
  'no-settings': [1, 3, 4, 5, 6, 7],
  'all-without-settings': [1, 3, 4, 5, 6, 7],
  'without-scene-2': [1, 3, 4, 5, 6, 7],
  'without-settings-and-clarification': [1, 3, 4, 5, 7],
  'no-settings-no-clarification': [1, 3, 4, 5, 7],
  'without-clarification': [1, 2, 3, 4, 5, 7],
  'no-clarification': [1, 3, 4, 5, 7],
};

export const VALID_DEMO_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export type DemoModel = (typeof VALID_DEMO_MODELS)[number];

export const VALID_DEMO_THINKING = ['low', 'medium', 'high', 'off'] as const;
export type DemoThinking = (typeof VALID_DEMO_THINKING)[number];

export const DEMO_MODEL_DEFAULTS = {
  model: 'haiku',
  thinking: 'high',
  orchestratorModel: 'sonnet',
  orchestratorThinking: 'medium',
  specialistModel: 'haiku',
  specialistThinking: 'high',
  reviewerModel: 'sonnet',
  reviewerThinking: 'medium',
} as const;

export function formatTimestampSuffix(date: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid date provided to formatTimestampSuffix');
  }
  const year = date.getFullYear();
  if (year < 0 || year > 9999) {
    throw new Error('Invalid date provided to formatTimestampSuffix');
  }
  const yyyy = String(year).padStart(4, '0');
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const HH = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

export interface DemoOptions {
  skipTts: boolean;
  skipBackend: boolean;
  backendUrl: string;
  outputPath: string;
  maxScenes?: number;
  singleScene?: number;
  scenes?: number[];
  model: DemoModel;
  thinking: DemoThinking;
  orchestratorModel: DemoModel;
  orchestratorThinking: DemoThinking;
  specialistModel: DemoModel;
  specialistThinking: DemoThinking;
  reviewerModel: DemoModel;
  reviewerThinking: DemoThinking;
}

function isValidModel(val: string | undefined): val is DemoModel {
  return val !== undefined && (VALID_DEMO_MODELS as readonly string[]).includes(val);
}

function isValidThinking(val: string | undefined): val is DemoThinking {
  return val !== undefined && (VALID_DEMO_THINKING as readonly string[]).includes(val);
}

export function parseArgs(rawArgs: string[] = process.argv.slice(2)): DemoOptions {
  const args = rawArgs;
  const skipTts = args.includes('--skip-tts');
  const skipBackend = args.includes('--skip-backend') || args.includes('--offline');
  const backendIdx = args.indexOf('--backend-url');
  const backendUrl =
    backendIdx !== -1 && args[backendIdx + 1]
      ? args[backendIdx + 1]
      : (process.env.YVOKE_SERVER ?? process.env.YVOKE_SERVER_URL ?? 'http://localhost:8080');
  const outIdx = args.indexOf('--output');
  const rawOutVal = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const outputPath =
    rawOutVal && rawOutVal.trim().length > 0 && !rawOutVal.trim().startsWith('-')
      ? path.resolve(process.cwd(), rawOutVal.trim())
      : path.resolve(process.cwd(), `artifacts/yvoke-desktop-demo-${formatTimestampSuffix()}.mp4`);

  const maxScenesIdx = args.indexOf('--max-scenes');
  let maxScenes: number | undefined;
  if (maxScenesIdx !== -1 && args[maxScenesIdx + 1]) {
    const parsed = parseInt(args[maxScenesIdx + 1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      maxScenes = parsed;
    }
  }

  const scenesIdx = args.indexOf('--scenes');
  let scenes: number[] | undefined;
  if (scenesIdx !== -1 && args[scenesIdx + 1]) {
    const rawVal = args[scenesIdx + 1].trim().toLowerCase();
    if (SCENE_PRESETS[rawVal]) {
      scenes = [...SCENE_PRESETS[rawVal]];
    } else {
      const parts = args[scenesIdx + 1]
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n) && n >= 1);
      if (parts.length > 0) {
        scenes = parts;
      }
    }
    if (scenes && !maxScenes) {
      maxScenes = Math.max(...scenes);
    }
  }

  const skipSceneIdx = args.indexOf('--skip-scene');
  const skipScenesIdx = args.indexOf('--skip-scenes');
  const skipArg =
    skipSceneIdx !== -1
      ? args[skipSceneIdx + 1]
      : skipScenesIdx !== -1
        ? args[skipScenesIdx + 1]
        : undefined;
  if (skipArg) {
    const skipped = skipArg
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    if (!scenes) {
      scenes = [1, 2, 3, 4, 5, 6, 7].filter((n) => !skipped.includes(n));
    } else {
      scenes = scenes.filter((n) => !skipped.includes(n));
    }
  }

  const singleSceneIdx = args.indexOf('--scene');
  let singleScene: number | undefined;
  if (singleSceneIdx !== -1 && args[singleSceneIdx + 1]) {
    const parsed = parseInt(args[singleSceneIdx + 1], 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      singleScene = parsed;
    }
  }

  const modelIdx = args.indexOf('--model');
  const modelVal = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const model: DemoModel = isValidModel(modelVal) ? modelVal : DEMO_MODEL_DEFAULTS.model;

  const masModelIdx = args.indexOf('--mas-model');
  const masModelVal = masModelIdx !== -1 ? args[masModelIdx + 1] : undefined;
  const masModelFallback: DemoModel | undefined = isValidModel(masModelVal)
    ? masModelVal
    : undefined;

  const thinkingIdx = args.indexOf('--thinking');
  const thinkingVal = thinkingIdx !== -1 ? args[thinkingIdx + 1] : undefined;
  const thinking: DemoThinking = isValidThinking(thinkingVal)
    ? thinkingVal
    : DEMO_MODEL_DEFAULTS.thinking;

  const orchModelIdx = args.indexOf('--orchestrator-model');
  const orchModelVal = orchModelIdx !== -1 ? args[orchModelIdx + 1] : undefined;
  const orchestratorModel: DemoModel = isValidModel(orchModelVal)
    ? orchModelVal
    : (masModelFallback ?? DEMO_MODEL_DEFAULTS.orchestratorModel);

  const orchThinkingIdx = args.indexOf('--orchestrator-thinking');
  const orchThinkingVal = orchThinkingIdx !== -1 ? args[orchThinkingIdx + 1] : undefined;
  const orchestratorThinking: DemoThinking = isValidThinking(orchThinkingVal)
    ? orchThinkingVal
    : DEMO_MODEL_DEFAULTS.orchestratorThinking;

  const specModelIdx =
    args.indexOf('--specialist-model') !== -1
      ? args.indexOf('--specialist-model')
      : args.indexOf('--worker-model');
  const specModelVal = specModelIdx !== -1 ? args[specModelIdx + 1] : undefined;
  const specialistModel: DemoModel = isValidModel(specModelVal)
    ? specModelVal
    : (masModelFallback ?? DEMO_MODEL_DEFAULTS.specialistModel);

  const specThinkingIdx =
    args.indexOf('--specialist-thinking') !== -1
      ? args.indexOf('--specialist-thinking')
      : args.indexOf('--worker-thinking');
  const specThinkingVal = specThinkingIdx !== -1 ? args[specThinkingIdx + 1] : undefined;
  const specialistThinking: DemoThinking = isValidThinking(specThinkingVal)
    ? specThinkingVal
    : DEMO_MODEL_DEFAULTS.specialistThinking;

  const revModelIdx = args.indexOf('--reviewer-model');
  const revModelVal = revModelIdx !== -1 ? args[revModelIdx + 1] : undefined;
  const reviewerModel: DemoModel = isValidModel(revModelVal)
    ? revModelVal
    : (masModelFallback ?? DEMO_MODEL_DEFAULTS.reviewerModel);

  const revThinkingIdx = args.indexOf('--reviewer-thinking');
  const revThinkingVal = revThinkingIdx !== -1 ? args[revThinkingIdx + 1] : undefined;
  const reviewerThinking: DemoThinking = isValidThinking(revThinkingVal)
    ? revThinkingVal
    : DEMO_MODEL_DEFAULTS.reviewerThinking;

  return {
    skipTts,
    skipBackend,
    backendUrl,
    outputPath,
    maxScenes,
    singleScene,
    scenes,
    model,
    thinking,
    orchestratorModel,
    orchestratorThinking,
    specialistModel,
    specialistThinking,
    reviewerModel,
    reviewerThinking,
  };
}

export const SCENE_1_SEGMENTS: SceneSegment[] = getSceneSegments('scene-1');
export const SCENE_2_SEGMENTS: SceneSegment[] = getSceneSegments('scene-2');
export const SCENE_3_SEGMENTS: SceneSegment[] = getSceneSegments('scene-3');
export const SCENE_4_SEGMENTS: SceneSegment[] = getSceneSegments('scene-4');
export const SCENE_5_SEGMENTS: SceneSegment[] = getSceneSegments('scene-5');
export const SCENE_6_SEGMENTS: SceneSegment[] = getSceneSegments('scene-6');
export const SCENE_7_SEGMENTS: SceneSegment[] = getSceneSegments('scene-7');

export const SCENE_NARRATIONS: string[] = STORYBOARD_BEATS.map((b) => b.narration);

/**
 * Calculates an acceleration interval if the turn execution time exceeds thresholdSec (default: 4s).
 * Accelerates the waiting period (starting 1s after turn initiation until turn completion) by speedFactor (default: 4x).
 */
export function calculateAccelerationInterval(
  tTurnStartSec: number,
  tTurnEndSec: number,
  thresholdSec = 4,
  speedFactor = 4,
): AccelerationInterval | null {
  const elapsed = tTurnEndSec - tTurnStartSec;
  if (elapsed <= thresholdSec) {
    return null;
  }
  const startSec = tTurnStartSec + 1;
  const endSec = tTurnEndSec;
  if (startSec >= endSec) {
    return null;
  }
  return { startSec, endSec, speedFactor };
}

export async function runPreflight(options: DemoOptions): Promise<void> {
  const mainEntry = path.resolve(process.cwd(), 'out/main/index.js');
  checkBuildArtifacts(mainEntry);

  if (!options.skipTts) {
    checkGeminiApiKey();
  }

  if (!options.skipBackend) {
    console.log('Probing Docker backend and Claude CLI credentials...');
    await runAllPreflightChecks({
      backendUrl: options.backendUrl,
      skipTts: options.skipTts,
      mainEntry,
    });
    console.log('Preflight checks passed: backend and Claude CLI are online.');
  } else {
    console.log('Skipping backend probe (--skip-backend / --offline mode).');
  }
}

export function seedUserData(
  backendUrl = 'http://localhost:8080',
  options?: {
    cloneRealThreads?: boolean;
    model?: DemoModel;
    thinking?: DemoThinking;
    orchestratorModel?: DemoModel;
    orchestratorThinking?: DemoThinking;
    specialistModel?: DemoModel;
    specialistThinking?: DemoThinking;
    reviewerModel?: DemoModel;
    reviewerThinking?: DemoThinking;
  },
): string {
  const model = options?.model ?? DEMO_MODEL_DEFAULTS.model;
  const thinkingLevel = options?.thinking ?? DEMO_MODEL_DEFAULTS.thinking;
  const orchModel = options?.orchestratorModel ?? DEMO_MODEL_DEFAULTS.orchestratorModel;
  const orchThinking = options?.orchestratorThinking ?? DEMO_MODEL_DEFAULTS.orchestratorThinking;
  const specModel = options?.specialistModel ?? DEMO_MODEL_DEFAULTS.specialistModel;
  const specThinking = options?.specialistThinking ?? DEMO_MODEL_DEFAULTS.specialistThinking;
  const revModel = options?.reviewerModel ?? DEMO_MODEL_DEFAULTS.reviewerModel;
  const revThinking = options?.reviewerThinking ?? DEMO_MODEL_DEFAULTS.reviewerThinking;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-demo-video-'));

  // 1. Settings strictly configured for local dev environment (Streamable HTTP + Dev token)
  const settings = {
    settingsVersion: 1,
    serverAuthMode: 'dev',
    serverBaseUrl: backendUrl,
    mcpTransport: 'http',
    defaultModel: model,
    defaultThinkingLevel: thinkingLevel,
    playbookValidationEnabled: true,
    playbookValidationExcludedPlaybooks: ['oim-full'],
    showPrototypePlaybooks: false,
    imageDescriptionsEnabled: true,
    webSearch: {
      enabled: true,
      allowedDomains: ['support.oneidentity.com', 'www.oneidentity.com/community/'],
    },
    appearance: {
      theme: 'dark',
      density: 'comfortable',
      answerTextSize: 14,
      traceExpanded: false,
    },
    orchestrator: {
      orchestrator: {
        model: orchModel,
        thinkingLevel: orchThinking,
      },
      reviewer: {
        model: revModel,
        thinkingLevel: revThinking,
      },
      specialist: {
        model: specModel,
        thinkingLevel: specThinking,
      },
      maxReviewRounds: 2,
      maxSpecialistCalls: 8,
      orchestratorMaxTurns: 60,
      specialistMaxTurns: 20,
    },
  };
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );

  // 2. Thread history: optionally clone real past conversation threads
  const realDir = path.join(
    process.env.HOME || os.homedir(),
    'Library/Application Support/Yvoke - Desktop',
  );
  if (options?.cloneRealThreads && fs.existsSync(realDir)) {
    try {
      const searchIndex = path.join(realDir, 'search-index.json');
      if (fs.existsSync(searchIndex)) {
        fs.copyFileSync(searchIndex, path.join(userDataDir, 'search-index.json'));
      }

      const threadsDir = path.join(realDir, 'threads');
      if (fs.existsSync(threadsDir)) {
        fs.cpSync(threadsDir, path.join(userDataDir, 'threads'), { recursive: true });
        return userDataDir;
      }
    } catch (e) {
      console.warn('Could not copy real user threads, falling back to synthetic:', e);
    }
  }

  // 3. Fallback: Pre-seed background threads if no real threads were cloned
  const threadsDir = path.join(userDataDir, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });

  const now = Date.now();
  const threadIndex = {
    'bg-thread-1': {
      id: 'bg-thread-1',
      title: 'Identity Manager 9.3 Architecture',
      model: 'sonnet',
      thinkingLevel: 'low',
      createdAt: new Date(now - 86400000).toISOString(),
      updatedAt: new Date(now - 80000000).toISOString(),
      totals: {
        inputTokens: 1850,
        outputTokens: 720,
        cacheReadTokens: 3500,
        cacheWriteTokens: 110,
        thoughtTokens: 600,
      },
      syncState: 'synced',
    },
    'bg-thread-2': {
      id: 'bg-thread-2',
      title: 'Active Directory & Entra Sync Notes',
      model: 'sonnet',
      thinkingLevel: 'low',
      createdAt: new Date(now - 172800000).toISOString(),
      updatedAt: new Date(now - 165000000).toISOString(),
      totals: {
        inputTokens: 2400,
        outputTokens: 980,
        cacheReadTokens: 4900,
        cacheWriteTokens: 180,
        thoughtTokens: 850,
      },
      syncState: 'synced',
    },
  };
  fs.writeFileSync(
    path.join(threadsDir, 'index.json'),
    JSON.stringify(threadIndex, null, 2),
    'utf8',
  );

  // Thread 1 JSONL: Identity Manager 9.3 Architecture
  const t1Messages = [
    {
      localId: 'msg-bg-1u',
      role: 'user',
      content: 'Explain the high-level architecture of One Identity Manager 9.3',
      createdAt: new Date(now - 86400000).toISOString(),
    },
    {
      localId: 'msg-bg-1a',
      role: 'assistant',
      content:
        'One Identity Manager 9.3 architecture is organized around three foundational tiers:\n\n1. **Database Layer:** Microsoft SQL Server or Azure SQL hosting the centralized transactional store, identity entities (`Person`, `Department`), and job queues (`JobQueue`).\n2. **Service Layer (One Identity Manager Service):** Distributed processing nodes handling asynchronous execution queues, system synchronization, and scheduled event processing.\n3. **Application & Web Tier:** Web Portal, Operations Support Web Portal, and Desktop Tools (Manager, Designer, Object Browser) communicating through standard ADO.NET and REST APIs.\n\nKey enhancements in 9.3 include improved SCIM 2.0 connectors and cloud synchronization resilience.',
      thinking:
        'Synthesizing architecture overview for One Identity Manager 9.3 covering database, service, and web application tiers.',
      usage: {
        inputTokens: 1850,
        outputTokens: 720,
        cacheReadTokens: 3500,
        cacheWriteTokens: 110,
        thoughtTokens: 600,
      },
      createdAt: new Date(now - 86350000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'bg-thread-1.jsonl'),
    t1Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );

  // Thread 2 JSONL: Active Directory & Entra Sync Notes
  const t2Messages = [
    {
      localId: 'msg-bg-2u',
      role: 'user',
      content: 'How should hybrid Active Directory and Entra ID synchronization be configured?',
      createdAt: new Date(now - 172800000).toISOString(),
    },
    {
      localId: 'msg-bg-2a',
      role: 'assistant',
      content:
        'For hybrid Active Directory and Microsoft Entra ID deployments in One Identity Manager:\n\n1. **Authoritative Source Mapping:** Keep on-premises AD as the primary provisioning target for employee identities via the standard Active Directory connector.\n2. **Entra ID Target System:** Configure the Microsoft Entra ID connector with delta-sync enabled to ingest cloud-only properties and licenses.\n3. **Account Correlation:** Use `UserPrincipalName` and `mail` as correlation rules to link `AADUser` records with existing `ADAccount` instances.\n4. **Conflict Handling:** Ensure password hash synchronization or pass-through authentication via Microsoft Entra Connect is properly aligned with OIM password policies.',
      thinking:
        'Providing best practices for hybrid AD and Entra ID identity synchronization and correlation rules.',
      usage: {
        inputTokens: 2400,
        outputTokens: 980,
        cacheReadTokens: 4900,
        cacheWriteTokens: 180,
        thoughtTokens: 850,
      },
      createdAt: new Date(now - 172750000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'bg-thread-2.jsonl'),
    t2Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );

  return userDataDir;
}

export async function closeAppResilient(
  electronApp: ElectronApplication | null,
  userDataDir: string,
): Promise<void> {
  if (electronApp) {
    try {
      await electronApp
        .evaluate(({ app }) => {
          app.quit();
        })
        .catch(() => {});

      const closePromise = electronApp.close();
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 5000);
      });

      const res = await Promise.race([closePromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (res === 'timeout') {
        const proc = electronApp.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      }
    } catch {
      try {
        const proc = electronApp.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore fallback errors
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (userDataDir && fs.existsSync(userDataDir)) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort removal
    }
  }
}

export async function runDemoVideoGenerator(): Promise<void> {
  const options = parseArgs();
  await runPreflight(options);

  const isSingle = options.singleScene !== undefined;
  const singleIdx = isSingle ? options.singleScene! - 1 : -1;
  const shouldRunScene = (idx: number): boolean => {
    if (options.scenes && options.scenes.length > 0) {
      return options.scenes.includes(idx + 1);
    }
    if (isSingle) return idx === singleIdx;
    return idx < totalScenes;
  };

  const totalScenes = options.scenes
    ? options.scenes.length
    : options.maxScenes
      ? Math.min(options.maxScenes, SCENE_NARRATIONS.length)
      : SCENE_NARRATIONS.length;

  console.log('--- Yvoke Demo Video Orchestrator ---');
  console.log(`Mode: ${options.skipTts ? 'Video Only (--skip-tts)' : 'Full (Voice + Video)'}`);
  console.log(`Resolution: 1280x720 (720p HD)`);
  console.log(
    `Scenes: ${
      isSingle
        ? `Scene ${options.singleScene} only`
        : options.scenes
          ? `Scenes ${options.scenes.join(', ')} (${options.scenes.length} total)`
          : `${totalScenes}/${SCENE_NARRATIONS.length}`
    }`,
  );
  console.log(`Output: ${options.outputPath}`);

  // Synthesize TTS if enabled
  const sceneAudios: SynthesizeResult[] = [];
  const scene1SegmentAudios = new Map<string, SynthesizeResult>();
  const scene2SegmentAudios = new Map<string, SynthesizeResult>();
  const scene3SegmentAudios = new Map<string, SynthesizeResult>();
  const scene4SegmentAudios = new Map<string, SynthesizeResult>();
  const scene5SegmentAudios = new Map<string, SynthesizeResult>();
  const scene6SegmentAudios = new Map<string, SynthesizeResult>();
  const scene7SegmentAudios = new Map<string, SynthesizeResult>();

  if (!options.skipTts) {
    if (isSingle) {
      console.log(`\n[1/4] Synthesizing TTS voice narrations for Scene ${options.singleScene}...`);
      if (singleIdx === 0) {
        const s1Results: SynthesizeResult[] = [];
        for (const seg of SCENE_1_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene1SegmentAudios.set(seg.key, res);
          s1Results.push(res);
        }
        sceneAudios[0] = combineSynthesizeResults(s1Results);
      } else if (singleIdx === 1) {
        const s2Results: SynthesizeResult[] = [];
        for (const seg of SCENE_2_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene2SegmentAudios.set(seg.key, res);
          s2Results.push(res);
        }
        sceneAudios[1] = combineSynthesizeResults(s2Results);
      } else if (singleIdx === 2) {
        const s3Results: SynthesizeResult[] = [];
        for (const seg of SCENE_3_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene3SegmentAudios.set(seg.key, res);
          s3Results.push(res);
        }
        sceneAudios[2] = combineSynthesizeResults(s3Results);
      } else if (singleIdx === 3) {
        const s4Results: SynthesizeResult[] = [];
        for (const seg of SCENE_4_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene4SegmentAudios.set(seg.key, res);
          s4Results.push(res);
        }
        sceneAudios[3] = combineSynthesizeResults(s4Results);
      } else if (singleIdx === 4) {
        const s5Results: SynthesizeResult[] = [];
        for (const seg of SCENE_5_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene5SegmentAudios.set(seg.key, res);
          s5Results.push(res);
        }
        sceneAudios[4] = combineSynthesizeResults(s5Results);
      } else if (singleIdx === 5) {
        const s6Results: SynthesizeResult[] = [];
        for (const seg of SCENE_6_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene6SegmentAudios.set(seg.key, res);
          s6Results.push(res);
        }
        sceneAudios[5] = combineSynthesizeResults(s6Results);
      } else if (singleIdx === 6) {
        const s7Results: SynthesizeResult[] = [];
        for (const seg of SCENE_7_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene7SegmentAudios.set(seg.key, res);
          s7Results.push(res);
        }
        sceneAudios[6] = combineSynthesizeResults(s7Results);
      } else if (singleIdx >= 7) {
        const res = await synthesizeSpeech(SCENE_NARRATIONS[singleIdx]);
        sceneAudios[singleIdx] = res;
      }
      console.log('  Voice narration synthesized successfully.');
    } else {
      console.log(`\n[1/4] Synthesizing TTS voice narrations via Gemini (${totalScenes} scenes)...`);

      // Scene 1: Segmented
      if (shouldRunScene(0)) {
        console.log(`  Scene 1/${totalScenes} (App & Sidebar Overview, ${SCENE_1_SEGMENTS.length} segments)...`);
        const s1Results: SynthesizeResult[] = [];
        for (const seg of SCENE_1_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene1SegmentAudios.set(seg.key, res);
          s1Results.push(res);
        }
        sceneAudios[0] = combineSynthesizeResults(s1Results);
      }

      // Scene 2: Segmented
      if (shouldRunScene(1)) {
        console.log(`  Scene 2/${totalScenes} (Settings Walkthrough, ${SCENE_2_SEGMENTS.length} segments)...`);
        const s2Results: SynthesizeResult[] = [];
        for (const seg of SCENE_2_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene2SegmentAudios.set(seg.key, res);
          s2Results.push(res);
        }
        sceneAudios[1] = combineSynthesizeResults(s2Results);
      }

      // Scene 3: Segmented
      if (shouldRunScene(2)) {
        console.log(`  Scene 3/${totalScenes} (New Conversation & Composer, ${SCENE_3_SEGMENTS.length} segments)...`);
        const s3Results: SynthesizeResult[] = [];
        for (const seg of SCENE_3_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene3SegmentAudios.set(seg.key, res);
          s3Results.push(res);
        }
        sceneAudios[2] = combineSynthesizeResults(s3Results);
      }

      // Scene 4: Segmented
      if (shouldRunScene(3)) {
        console.log(`  Scene 4/${totalScenes} (Playbook Validation Catch, ${SCENE_4_SEGMENTS.length} segments)...`);
        const s4Results: SynthesizeResult[] = [];
        for (const seg of SCENE_4_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene4SegmentAudios.set(seg.key, res);
          s4Results.push(res);
        }
        sceneAudios[3] = combineSynthesizeResults(s4Results);
      }

      // Scene 5: Segmented
      if (shouldRunScene(4)) {
        console.log(`  Scene 5/${totalScenes} (Follow-Up, Citations & Search Hints, ${SCENE_5_SEGMENTS.length} segments)...`);
        const s5Results: SynthesizeResult[] = [];
        for (const seg of SCENE_5_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene5SegmentAudios.set(seg.key, res);
          s5Results.push(res);
        }
        sceneAudios[4] = combineSynthesizeResults(s5Results);
      }

      // Scene 6: Segmented
      if (shouldRunScene(5)) {
        console.log(`  Scene 6/${totalScenes} (Clarifying Questions & Disambiguation, ${SCENE_6_SEGMENTS.length} segments)...`);
        const s6Results: SynthesizeResult[] = [];
        for (const seg of SCENE_6_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene6SegmentAudios.set(seg.key, res);
          s6Results.push(res);
        }
        sceneAudios[5] = combineSynthesizeResults(s6Results);
      }

      // Scene 7: Segmented
      if (shouldRunScene(6)) {
        console.log(`  Scene 7/${totalScenes} (Multi-Agent System MAS, ${SCENE_7_SEGMENTS.length} segments)...`);
        const s7Results: SynthesizeResult[] = [];
        for (const seg of SCENE_7_SEGMENTS) {
          const res = await synthesizeSpeech(seg.narration);
          scene7SegmentAudios.set(seg.key, res);
          s7Results.push(res);
        }
        sceneAudios[6] = combineSynthesizeResults(s7Results);
      }

      // Scenes 8 to N: Direct synthesis
      for (let i = 7; i < totalScenes; i++) {
        if (shouldRunScene(i)) {
          console.log(`  Scene ${i + 1}/${totalScenes}...`);
          const res = await synthesizeSpeech(SCENE_NARRATIONS[i]);
          sceneAudios[i] = res;
        }
      }
      console.log('  Voice narrations synthesized successfully.');
    }
  } else {
    console.log('\n[1/4] Skipping TTS voice narration (--skip-tts).');
  }

  // Seed temp directory
  console.log('\n[2/4] Initializing isolated profile environment...');
  const userDataDir = seedUserData(options.backendUrl, {
    cloneRealThreads: true,
    model: options.model,
    thinking: options.thinking,
    orchestratorModel: options.orchestratorModel,
    orchestratorThinking: options.orchestratorThinking,
    specialistModel: options.specialistModel,
    specialistThinking: options.specialistThinking,
    reviewerModel: options.reviewerModel,
    reviewerThinking: options.reviewerThinking,
  });
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-recordings-'));

  let electronApp: ElectronApplication | null = null;
  let cleaningUp = false;

  const teardown = async (signal?: string): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log(
      signal ? `\nSignal ${signal} received. Terminating...` : '\nClosing application...',
    );
    await closeAppResilient(electronApp, userDataDir);
    if (recordingsDir && fs.existsSync(recordingsDir)) {
      try {
        fs.rmSync(recordingsDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  };

  process.on('SIGINT', async () => {
    await teardown('SIGINT');
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await teardown('SIGTERM');
    process.exit(143);
  });

  try {
    console.log('\n[3/4] Launching Electron in headed 720p HD mode (1280x720)...');
    const appDir = path.resolve(process.cwd());
    electronApp = await electron.launch({
      args: [
        appDir,
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      env: {
        ...process.env,
        YVOKE_USER_DATA_DIR: userDataDir,
        YVOKE_HEADLESS: '0',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=4096`,
      },
      recordVideo: {
        dir: recordingsDir,
        size: { width: 1280, height: 720 },
      },
    });

    const proc = electronApp.process();
    proc?.stdout?.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.log(`[App stdout] ${line}`);
    });
    proc?.stderr?.on('data', (d) => {
      const line = d.toString().trim();
      if (line) console.error(`[App stderr] ${line}`);
    });
    proc?.on('exit', (code, sig) => {
      console.log(`[App proc exit] code=${code} sig=${sig}`);
    });

    const tVideoStart = Date.now();
    let initialDelaySec = 0;

    const appPage: Page = await electronApp.firstWindow();

    // Set exact 720p HD window size and position
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1280, 720);
        win.center();
      }
    });

    // Wait for app ready
    const loading = appPage.locator('.app-loading');
    if ((await loading.count()) > 0) {
      await loading.waitFor({ state: 'detached', timeout: 15000 });
    }
    await appPage.waitForLoadState('domcontentloaded');
    await appPage.waitForTimeout(600);

    // Safeguard browser context against esbuild/tsx __name injection
    await appPage.addInitScript(`
      window.__name = window.__name || function(t) { return t; };
    `);
    await appPage.evaluate('window.__name = window.__name || function(t) { return t; };');

    // Inject visible demo cursor
    await injectDemoCursor(appPage);

    // Global auto-collapse trace observer: collapses any live expanded trace bar
    // immediately upon appearance, ensuring traces stay compact until explicitly inspected.
    await appPage.evaluate(installAutoCollapseTraceObserver, undefined);

    console.log(`\n[4/4] Executing ${totalScenes}-scene choreographies...`);

    const sceneTimings: { startMs: number; endMs: number }[] = [];
    const accelerationIntervals: AccelerationInterval[] = [];

    const selectSidebarThread = async (text?: string): Promise<void> => {
      let thread = text
        ? appPage.locator('.thread-item').filter({ hasText: text }).first()
        : appPage.locator('.thread-item').first();
      if ((await thread.count()) === 0) {
        thread = appPage.locator('.thread-item').first();
      }
      if ((await thread.count()) > 0) {
        if (!(await thread.isVisible())) {
          await appPage.evaluate(`
            document.querySelectorAll('.thread-group-label[aria-expanded="false"]').forEach(function(el) {
              if (typeof el.click === 'function') el.click();
            });
          `);
          await appPage.waitForTimeout(200);
        }
        await glideMouse(appPage, thread, 25, { click: true, delayMs: 200 });
      }
    };

    // Pre-select the first conversation so the video opens showing the live, rich AI assistant workspace
    await selectSidebarThread();
    await appPage.waitForTimeout(600);

    initialDelaySec = (Date.now() - tVideoStart) / 1000;
    console.log(`  Initial workspace settle delay: ${initialDelaySec.toFixed(2)}s`);

    const initialSilence = createSilencePcm(initialDelaySec);
    const timelineSync = createTimelineSyncController({
      initialSilencePcm: initialSilence,
      skipTts: options.skipTts,
      nowSec: () => (Date.now() - tVideoStart) / 1000,
      waitSec: async (sec: number) => {
        await appPage.waitForTimeout(sec * 1000);
      },
      remapSec: (rawSec: number) => remapTimestamp(rawSec, accelerationIntervals),
    });

    const rebuildSceneAudio = (sceneIdx: number): void => {
      const pairs: Array<[SceneSegment[], Map<string, SynthesizeResult>]> = [
        [SCENE_1_SEGMENTS, scene1SegmentAudios],
        [SCENE_2_SEGMENTS, scene2SegmentAudios],
        [SCENE_3_SEGMENTS, scene3SegmentAudios],
        [SCENE_4_SEGMENTS, scene4SegmentAudios],
        [SCENE_5_SEGMENTS, scene5SegmentAudios],
        [SCENE_6_SEGMENTS, scene6SegmentAudios],
        [SCENE_7_SEGMENTS, scene7SegmentAudios],
      ];
      const pair = pairs[sceneIdx];
      if (!pair) return;
      const [segments, audioMap] = pair;
      if (audioMap.size === 0) return;
      const segs = segments
        .map((s) => audioMap.get(s.key))
        .filter((s): s is SynthesizeResult => Boolean(s));
      if (segs.length > 0) {
        sceneAudios[sceneIdx] = combineSynthesizeResults(segs);
      }
    };

    const runSceneWithPadding = async (
      sceneIdx: number,
      name: string,
      actionFn: () => Promise<void>,
    ): Promise<void> => {
      console.log(`  Running Scene ${sceneIdx + 1}/${totalScenes}: ${name}`);
      const beat = STORYBOARD_BEATS[sceneIdx];
      const targetDurationSec = beat
        ? parseTimeRange(beat.timeRange).endSec - parseTimeRange(beat.timeRange).startSec
        : 0;
      const timing = await timelineSync.runSceneWithPadding({
        sceneIdx,
        targetDurationSec,
        sceneNarration: SCENE_NARRATIONS[sceneIdx],
        actionFn,
        buildSceneAudio: () => rebuildSceneAudio(sceneIdx),
        getSceneAudio: () => sceneAudios[sceneIdx],
        setSceneAudio: (audio) => {
          sceneAudios[sceneIdx] = audio;
        },
      });
      sceneTimings.push(timing);
    };

    const runSegment = async (
      segAudioMap: Map<string, SynthesizeResult>,
      key: string,
      defaultDurationSec: number,
      actionFn: () => Promise<void>,
      narrationText?: string,
    ): Promise<void> => {
      await timelineSync.runSegment({
        segAudioMap,
        key,
        defaultDurationSec,
        actionFn,
        narrationText,
      });
    };

    // =========================================================================
    // Scene 1: App & Sidebar Overview
    // =========================================================================
    if (shouldRunScene(0)) {
      await runSceneWithPadding(0, 'App & Sidebar Overview', async () => {
        // 1. Welcome - Show active live desktop app
        await runSegment(
          scene1SegmentAudios,
          'welcome',
          getSegmentDuration(SCENE_1_SEGMENTS, 'welcome'),
          async () => {
            // App is already displaying an active conversation with full chat view!
            // Smoothly glide mouse across active message response and trace bar
            const traceBar = appPage.locator('.trace-bar, .message').first();
            if ((await traceBar.count()) > 0) {
              await glideMouse(appPage, traceBar, 25, { delayMs: 400 });
            }
          },
          getSegmentNarration(SCENE_1_SEGMENTS, 'welcome'),
        );

        // 2. Sidebar & Threads
        await runSegment(
          scene1SegmentAudios,
          'sidebar',
          getSegmentDuration(SCENE_1_SEGMENTS, 'sidebar'),
          async () => {
            // Hover over the header app title "YVOKE"
            const appTitle = appPage.locator('.thread-list-header .app-title').first();
            if ((await appTitle.count()) > 0) {
              await glideMouse(appPage, appTitle, 20, { delayMs: 300 });
            }

            // Expand any collapsed timeline groups so threads are visible
            await appPage.evaluate(`
              document.querySelectorAll('.thread-group-label[aria-expanded="false"]').forEach(function(el) {
                if (typeof el.click === 'function') el.click();
              });
            `);
            await appPage.waitForTimeout(150);

            // Glide across visible past conversation threads
            const threadItems = appPage.locator('.thread-item:visible');
            const count = await threadItems.count();
            if (count > 0) {
              await glideMouse(appPage, threadItems.first(), 20, { delayMs: 350, optional: true });
              if (count > 1) {
                await glideMouse(appPage, threadItems.nth(1), 20, { delayMs: 350, optional: true });
              }
            }
          },
          getSegmentNarration(SCENE_1_SEGMENTS, 'sidebar'),
        );

        // 3. Instant Search
        await runSegment(
          scene1SegmentAudios,
          'search',
          getSegmentDuration(SCENE_1_SEGMENTS, 'search'),
          async () => {
            const searchInput = appPage
              .locator('.thread-search input, input[placeholder*="Search"]')
              .first();
            if ((await searchInput.count()) > 0) {
              await glideMouse(appPage, searchInput, 20, { click: true, delayMs: 200 });
              await searchInput.fill('template');
              await appPage.waitForTimeout(600);
              const searchClear = appPage.locator('.search-clear').first();
              if ((await searchClear.count()) > 0) {
                await glideMouse(appPage, searchClear, 20, { click: true, delayMs: 200 });
              } else {
                await searchInput.fill('');
              }
              await appPage.waitForTimeout(200);
            }
          },
          getSegmentNarration(SCENE_1_SEGMENTS, 'search'),
        );

        // 4. Dual-Account Footer & Settings
        await runSegment(
          scene1SegmentAudios,
          'profile',
          getSegmentDuration(SCENE_1_SEGMENTS, 'profile'),
          async () => {
            const accountRows = appPage.locator('.thread-list-footer .account-status-row');
            const rowCount = await accountRows.count();
            if (rowCount > 0) {
              await glideMouse(appPage, accountRows.first(), 20, { delayMs: 350, optional: true });
              if (rowCount > 1) {
                await glideMouse(appPage, accountRows.nth(1), 20, { delayMs: 350, optional: true });
              }
            } else {
              const footerAccountBtn = appPage
                .locator('.thread-list-footer button.footer-account-btn')
                .first();
              if ((await footerAccountBtn.count()) > 0) {
                await glideMouse(appPage, footerAccountBtn, 20, { delayMs: 400, optional: true });
              }
            }

            const appVersion = appPage.locator('.footer-sub-meta .app-version').first();
            if ((await appVersion.count()) > 0) {
              await glideMouse(appPage, appVersion, 20, { delayMs: 300, optional: true });
            }

            const settingsBtn = appPage
              .locator('button[data-tip="Settings"], .settings-button')
              .first();
            if ((await settingsBtn.count()) > 0) {
              await glideMouse(appPage, settingsBtn, 20, { delayMs: 400 });
            }
          },
          getSegmentNarration(SCENE_1_SEGMENTS, 'profile'),
        );
      });
    }

    // =========================================================================
    // Scene 2: Settings Walkthrough
    // =========================================================================
    if (shouldRunScene(1)) {
      await runSceneWithPadding(1, 'Settings Walkthrough', async () => {
        // Helper to click pane and hover over its main content
        const visitPane = async (name: string, contentSelector?: string) => {
          const paneBtn = appPage
            .locator('.settings-nav button.nav-pane')
            .filter({ hasText: name })
            .first();
          if ((await paneBtn.count()) > 0) {
            await glideMouse(appPage, paneBtn, 20, { click: true, delayMs: 200 });
            await appPage.waitForTimeout(200);
            if (contentSelector) {
              const target = appPage.locator(contentSelector).first();
              if ((await target.count()) > 0) {
                await glideMouse(appPage, target, 20, { delayMs: 200, optional: true });
              }
            }
          }
        };

        // 1. Intro: "Opening Settings reveals full control over your environment."
        await runSegment(
          scene2SegmentAudios,
          'intro',
          getSegmentDuration(SCENE_2_SEGMENTS, 'intro'),
          async () => {
            const settingsBtn = appPage
              .locator('button[data-tip="Settings"], .settings-button')
              .first();
            if ((await settingsBtn.count()) > 0) {
              await glideMouse(appPage, settingsBtn, 20, { click: true, delayMs: 250 });
            }
            await appPage
              .locator('.settings-view')
              .waitFor({ state: 'visible', timeout: 3000 })
              .catch(() => {});
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'intro'),
        );

        // 2. Server: "Under Server, configure backend endpoints, transport, and authentication."
        await runSegment(
          scene2SegmentAudios,
          'server',
          getSegmentDuration(SCENE_2_SEGMENTS, 'server'),
          async () => {
            await visitPane('Server', '.settings-field input, .seg');
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'server'),
        );

        // 3. Accounts: "Under Accounts, manage your Yvoke and Claude sign-ins and verify active credentials on demand."
        await runSegment(
          scene2SegmentAudios,
          'accounts',
          getSegmentDuration(SCENE_2_SEGMENTS, 'accounts'),
          async () => {
            await visitPane('Accounts', '.about-grid');
            const credBtn = appPage.locator('.check-credentials-btn').first();
            if ((await credBtn.count()) > 0) {
              await glideMouse(appPage, credBtn, 15, { click: true, delayMs: 200 });
              await appPage
                .locator('.about-grid .cred-badge, .settings-pane .banner.error')
                .first()
                .waitFor({
                  state: 'visible',
                  timeout: options.skipBackend ? 5000 : 45000,
                })
                .catch(() => {});
              if (!options.skipBackend) {
                await appPage
                  .locator('.about-grid .cred-badge')
                  .nth(1)
                  .waitFor({ state: 'visible', timeout: 5000 })
                  .catch(() => {});
              }
              await appPage.waitForTimeout(700);
            }
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'accounts'),
        );

        // 4. Models: "Models lets you define Claude model versions and default thinking effort."
        await runSegment(
          scene2SegmentAudios,
          'models',
          getSegmentDuration(SCENE_2_SEGMENTS, 'models'),
          async () => {
            await visitPane('Models', '.chip-list, .seg');
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'models'),
        );

        // 5. Agents: "Agents configures multi-agent roles, turns, and automatic playbook validation."
        await runSegment(
          scene2SegmentAudios,
          'agents',
          getSegmentDuration(SCENE_2_SEGMENTS, 'agents'),
          async () => {
            await visitPane('Agents', '.check-field input');
            const excludedList = appPage.locator('.settings-domain-list').first();
            if ((await excludedList.count()) > 0) {
              await excludedList.scrollIntoViewIfNeeded().catch(() => {});
              await glideMouse(appPage, excludedList, 20, { delayMs: 250, optional: true });
            }
            const roleCard = appPage.locator('.role-card').first();
            if ((await roleCard.count()) > 0) {
              await roleCard.scrollIntoViewIfNeeded().catch(() => {});
              await glideMouse(appPage, roleCard, 20, { delayMs: 250, optional: true });
            }
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'agents'),
        );

        // 6. Web search: "Web Search toggles web access while displaying the allowed domains,"
        await runSegment(
          scene2SegmentAudios,
          'webSearch',
          getSegmentDuration(SCENE_2_SEGMENTS, 'webSearch'),
          async () => {
            await visitPane('Web search', '.settings-domain-list li, .settings-field');
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'webSearch'),
        );

        // 7. Appearance: "Appearance customizes themes and density,"
        await runSegment(
          scene2SegmentAudios,
          'appearance',
          getSegmentDuration(SCENE_2_SEGMENTS, 'appearance'),
          async () => {
            await visitPane('Appearance', '.theme-choices, .seg');
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'appearance'),
        );

        // 8. About: "while About lets you check for updates and access diagnostic logs."
        await runSegment(
          scene2SegmentAudios,
          'about',
          getSegmentDuration(SCENE_2_SEGMENTS, 'about'),
          async () => {
            await visitPane('About', '.about-version-row');
            await appPage.waitForTimeout(300);

            // 1. Click Check for Updates and wait for response badge or error banner
            const updateBtn = appPage.locator('.check-updates-btn').first();
            if ((await updateBtn.count()) > 0) {
              await glideMouse(appPage, updateBtn, 15, { click: true, delayMs: 200 });
              await appPage
                .locator('.about-version-row .cred-badge, .settings-pane .banner.error')
                .first()
                .waitFor({
                  state: 'visible',
                  timeout: options.skipBackend ? 4000 : 15000,
                })
                .catch(() => {});
              await appPage.waitForTimeout(350);
            }

            // 2. Hover Open Logs Folder (NEVER click — avoids opening OS file manager popup)
            const openLogsBtn = appPage.locator('.open-logs-btn').first();
            if ((await openLogsBtn.count()) > 0) {
              await glideMouse(appPage, openLogsBtn, 15, { delayMs: 350, optional: true });
            }

            // 3. Close Settings and return to main workspace
            const closeBtn = appPage
              .locator('.settings-footer .dialog-actions button')
              .filter({ hasText: /^(Close|Cancel)$/ })
              .first();
            if ((await closeBtn.count()) > 0) {
              await glideMouse(appPage, closeBtn, 20, { click: true, delayMs: 200 });
              await appPage
                .locator('.settings-view')
                .waitFor({ state: 'detached', timeout: 3000 })
                .catch(() => {});
              await appPage.waitForTimeout(400);
            }
          },
          getSegmentNarration(SCENE_2_SEGMENTS, 'about'),
        );
      });
    }

    // =========================================================================
    // Scene 3: New Conversation, Playbooks & Composer
    // =========================================================================
    if (shouldRunScene(2)) {
      await runSceneWithPadding(2, 'New Conversation, Playbooks & Composer', async () => {
        // 1. New conversation
        await runSegment(
          scene3SegmentAudios,
          'newConv',
          getSegmentDuration(SCENE_3_SEGMENTS, 'newConv'),
          async () => {
            const newBtn = appPage
              .locator(
                'aside.thread-list button[data-tip="New conversation"], aside.thread-list .thread-list-header button.primary',
              )
              .first();
            if ((await newBtn.count()) > 0) {
              await glideMouse(appPage, newBtn, 20, { click: true, delayMs: 200 });
              await appPage
                .locator('.picker')
                .waitFor({ state: 'visible', timeout: 3000 })
                .catch(() => {});
            }
            await appPage.waitForTimeout(400);
          },
          getSegmentNarration(SCENE_3_SEGMENTS, 'newConv'),
        );

        // 2. Playbook picker
        await runSegment(
          scene3SegmentAudios,
          'playbooks',
          getSegmentDuration(SCENE_3_SEGMENTS, 'playbooks'),
          async () => {
            const picker = appPage.locator('.picker, .picker-list').first();
            if ((await picker.count()) > 0) {
              const filterInput = appPage.locator('.picker-filter input').first();
              if ((await filterInput.count()) > 0) {
                await glideMouse(appPage, filterInput, 20, { delayMs: 250 });
              }
              const rows = appPage.locator('.picker-row');
              const rowCount = await rows.count();
              const gettingStartedRow = appPage
                .locator('.picker-row')
                .filter({ hasText: /getting-started|manual/i })
                .first();
              const dbHistoryRow = appPage
                .locator('.picker-row')
                .filter({ hasText: /db-history|database/i })
                .first();

              if ((await gettingStartedRow.count()) > 0) {
                await glideMouse(appPage, gettingStartedRow, 20, { delayMs: 400 });
              } else if (rowCount > 0) {
                await glideMouse(appPage, rows.first(), 20, { delayMs: 350 });
              }

              if ((await dbHistoryRow.count()) > 0) {
                await glideMouse(appPage, dbHistoryRow, 20, { delayMs: 400 });
              } else if (rowCount > 1) {
                await glideMouse(appPage, rows.nth(1), 20, { delayMs: 350 });
              }
            }
          },
          getSegmentNarration(SCENE_3_SEGMENTS, 'playbooks'),
        );

        // 3. Composer
        await runSegment(
          scene3SegmentAudios,
          'composer',
          getSegmentDuration(SCENE_3_SEGMENTS, 'composer'),
          async () => {
            const composer = appPage.locator('.composer').first();
            if ((await composer.count()) > 0) {
              const textarea = appPage.locator('.composer textarea').first();
              if ((await textarea.count()) > 0) {
                await glideMouse(appPage, textarea, 20, { delayMs: 300 });
              }

              const attachBtn = appPage.locator('.composer-attach-btn').first();
              if ((await attachBtn.count()) > 0) {
                await glideMouse(appPage, attachBtn, 20, { delayMs: 300 });
              }

              const modeSelect = appPage
                .locator('select.composer-select[aria-label="Agent mode"]')
                .first();
              if ((await modeSelect.count()) > 0) {
                await glideMouse(appPage, modeSelect, 20, { delayMs: 350 });
              }

              const modelSelect = appPage
                .locator(
                  'select.composer-select[data-tip="Model"], select.composer-select[aria-label="Model"]',
                )
                .first();
              if ((await modelSelect.count()) > 0) {
                await glideMouse(appPage, modelSelect, 20, { delayMs: 350 });
              }

              const thinkingSelect = appPage
                .locator(
                  'select.composer-select[data-tip="Thinking effort"], select.composer-select[aria-label="Thinking effort"]',
                )
                .first();
              if ((await thinkingSelect.count()) > 0) {
                await glideMouse(appPage, thinkingSelect, 20, { delayMs: 350 });
              }

              const sendBtn = appPage.locator('button.composer-send').first();
              if ((await sendBtn.count()) > 0) {
                await glideMouse(appPage, sendBtn, 20, { delayMs: 400 });
              }
            }
          },
          getSegmentNarration(SCENE_3_SEGMENTS, 'composer'),
        );
      });
    }


    const startNewConversation = async (): Promise<void> => {
      await appPage.evaluate(() => {
        document.querySelectorAll('#demo-clarifying-card, #demo-citation-modal').forEach((e: { remove(): void }) => e.remove());
      }).catch(() => {});
      const newBtn = appPage
        .locator(
          'aside.thread-list button[data-tip="New conversation"], aside.thread-list .thread-list-header button.primary',
        )
        .first();
      if ((await newBtn.count()) > 0) {
        await glideMouse(appPage, newBtn, 20, { click: true, delayMs: 200 });
        await appPage.waitForTimeout(300);
      }
    };

    // =========================================================================
    // Scene 4: Live Query 1 (Playbook Validation Catch)
    // =========================================================================
    if (shouldRunScene(3)) {
      await runSceneWithPadding(3, 'Playbook Validation Catch', async () => {
        // 1. Consultant query input: select oim-getting-started, type prompt, click Send
        await runSegment(
          scene4SegmentAudios,
          'ask',
          getSegmentDuration(SCENE_4_SEGMENTS, 'ask'),
          async () => {
            const picker = appPage.locator('.picker');
            if ((await picker.count()) === 0 || !(await picker.isVisible())) {
              await startNewConversation();
            }

            // Select oim-getting-started in the playbook picker via filter
            const filterInput = appPage.locator('.picker-filter input').first();
            if ((await filterInput.count()) > 0 && (await filterInput.isVisible())) {
              await glideMouse(appPage, filterInput, 15, { click: true, delayMs: 150 });
              await filterInput.fill('oim-getting-started');
              await appPage.waitForTimeout(200);
            }
            const gettingStartedRow = appPage
              .locator('button.picker-row, .picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', {
                  hasText: buildPlaybookTitlePattern('oim-getting-started'),
                }),
              })
              .first();
            if ((await gettingStartedRow.count()) > 0) {
              await glideMouse(appPage, gettingStartedRow, 20, { click: true, delayMs: 250 });
            } else {
              await selectPlaybook(appPage, 'oim-getting-started').catch(() => {});
            }
            await appPage
              .locator('.active-playbook')
              .waitFor({ state: 'visible', timeout: 3000 })
              .catch(() => {});
            await appPage.waitForTimeout(250);

            // Focus textarea and type question character-by-character
            await typeInComposer(appPage, 'When was the table POLPlaybook introduced?', {
              delayPerCharMs: 25,
            });
            await appPage.waitForTimeout(300);

            // Click primary Send button to trigger preflight validation
            const sendBtn = appPage
              .locator('button.composer-send.primary, button.composer-send')
              .first();
            if ((await sendBtn.count()) > 0) {
              await glideMouse(appPage, sendBtn, 20, { click: true, delayMs: 200 });
            }
          },
          getSegmentNarration(SCENE_4_SEGMENTS, 'ask'),
        );

        // 2. Preflight validation detection: wait for card to appear FIRST, then speak 4.2
        const preflightCard = appPage
          .locator('.preflight-card, #demo-preflight-recommendation')
          .first();
        try {
          await preflightCard.waitFor({ state: 'visible', timeout: 10000 });
        } catch {
          // Offline simulation fallback if backend check timed out
          await appPage.evaluate(() => {
            const container =
              document.querySelector('.chat-view') || document.querySelector('.main-content');
            if (container && !document.getElementById('demo-preflight-recommendation')) {
              const card = document.createElement('div');
              card.className = 'preflight-card';
              card.id = 'demo-preflight-recommendation';
              card.innerHTML = `
                <div class="preflight-card-head">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  Playbook recommendation
                </div>
                <div class="preflight-card-reason">Question queries table migration history. We recommend switching from oim-getting-started to oim-db-history.</div>
                <div class="preflight-card-actions">
                  <button class="primary demo-switch-btn">Switch to oim-db-history</button>
                  <button class="demo-send-anyway-btn">Send anyway</button>
                </div>
              `;
              container.insertBefore(card, container.firstChild);
            }
          });
        }

        // Now that the preflight card is visible on screen, speak 4.2 while the viewer inspects it
        await runSegment(
          scene4SegmentAudios,
          'catch',
          getSegmentDuration(SCENE_4_SEGMENTS, 'catch'),
          async () => {
            const cardElement = appPage
              .locator('.preflight-card, #demo-preflight-recommendation')
              .first();
            if ((await cardElement.count()) > 0) {
              await glideMouse(appPage, cardElement, 20, { delayMs: 400 });
            }
            await appPage.waitForTimeout(400);
          },
          getSegmentNarration(SCENE_4_SEGMENTS, 'catch'),
        );

        // 3. Recommendation & acceptance: cursor clicks "Switch to oim-db-history"
        await runSegment(
          scene4SegmentAudios,
          'recommend',
          getSegmentDuration(SCENE_4_SEGMENTS, 'recommend'),
          async () => {
            const activeCard = appPage
              .locator('.preflight-card, #demo-preflight-recommendation')
              .first();
            const switchBtn = activeCard
              .locator('button.primary, button:has-text("Switch"), .demo-switch-btn')
              .first();
            if ((await switchBtn.count()) > 0) {
              await glideMouse(appPage, switchBtn, 20, { click: true, delayMs: 250 });
            }
            await appPage.evaluate(() =>
              document.getElementById('demo-preflight-recommendation')?.remove(),
            );
            await appPage.waitForTimeout(300);
          },
          getSegmentNarration(SCENE_4_SEGMENTS, 'recommend'),
        );

        // 4. Response waiting & streaming: speak 4.4, wait until response is finished (Send button reappears from Stop)
        await runSegment(
          scene4SegmentAudios,
          'response',
          getSegmentDuration(SCENE_4_SEGMENTS, 'response'),
          async () => {
            // Ensure turn start is registered
            await appPage
              .locator('button.danger.composer-send, button:has-text("Stop"), .thinking-indicator')
              .first()
              .waitFor({ state: 'visible', timeout: 5000 })
              .catch(() => {});

            // Wait for response to finish: Stop button disappears and Send button reappears
            await waitForTurnCompletion(appPage, {
              timeoutMs: options.skipBackend ? 4000 : 90000,
            }).catch(() => {});

            // Cursor inspects TraceBar and final answer
            const traceBar = appPage.locator('.trace-bar, .thinking-trace').first();
            if ((await traceBar.count()) > 0) {
              await glideMouse(appPage, traceBar, 20, { delayMs: 400 });
            }

            const assistantMsg = appPage.locator('.message.assistant').last();
            if ((await assistantMsg.count()) > 0) {
              await glideMouse(appPage, assistantMsg, 20, { delayMs: 600 });
            }
            await appPage.waitForTimeout(800);
          },
          getSegmentNarration(SCENE_4_SEGMENTS, 'response'),
        );
      });
    }

    // =========================================================================
    // Scene 5: Live Query 2 (Multi-Turn Follow-Up, Citations & Search Hints)
    // =========================================================================
    if (shouldRunScene(4)) {
      await runSceneWithPadding(4, 'Multi-Turn Follow-Up, Citations & Search Hints', async () => {
        // 1. Initial Query Input
        await runSegment(
          scene5SegmentAudios,
          'ask',
          getSegmentDuration(SCENE_5_SEGMENTS, 'ask'),
          async () => {
            await startNewConversation();

            // Select playbook oim-full (has teams & confluence knowledge) via filter
            const filterInput = appPage.locator('.picker-filter input').first();
            if ((await filterInput.count()) > 0 && (await filterInput.isVisible())) {
              await glideMouse(appPage, filterInput, 15, { click: true, delayMs: 150 });
              await filterInput.fill('oim-full');
              await appPage.waitForTimeout(200);
            }
            const fullRow = appPage
              .locator('button.picker-row, .picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', {
                  hasText: buildPlaybookTitlePattern('oim-full'),
                }),
              })
              .first();
            if ((await fullRow.count()) > 0) {
              await glideMouse(appPage, fullRow, 20, { click: true, delayMs: 250 });
            } else {
              await selectPlaybook(appPage, 'oim-full').catch(() => {});
            }
            await appPage
              .locator('.active-playbook')
              .waitFor({ state: 'visible', timeout: 3000 })
              .catch(() => {});
            await appPage.waitForTimeout(250);

            // Type prompt and click Send
            await typeInComposer(appPage, 'what is a value template?', {
              delayPerCharMs: 25,
            });
            await appPage.waitForTimeout(300);

            const sendBtn = appPage
              .locator('button.composer-send.primary, button.composer-send')
              .first();
            if ((await sendBtn.count()) > 0) {
              await glideMouse(appPage, sendBtn, 20, { click: true, delayMs: 200 });
            }

            // Preflight validation runs: if a playbook recommendation card appears,
            // click "Send anyway" to proceed with oim-full as instructed by user
            const preflightCard = appPage.locator('.preflight-card').first();
            const turnStart = appPage
              .locator('button.danger.composer-send, button:has-text("Stop")')
              .first();

            const preflightPollStart = Date.now();
            let recommendationAppeared = false;
            while (Date.now() - preflightPollStart < 6000) {
              if ((await preflightCard.count()) > 0 && (await preflightCard.isVisible())) {
                recommendationAppeared = true;
                break;
              }
              if ((await turnStart.count()) > 0 && (await turnStart.isVisible())) {
                break;
              }
              await appPage.waitForTimeout(200);
            }

            if (recommendationAppeared) {
              const sendAnywayBtn = appPage
                .locator('.preflight-card button')
                .filter({ hasText: /send anyway/i })
                .first();
              if ((await sendAnywayBtn.count()) > 0) {
                await glideMouse(appPage, sendAnywayBtn, 20, { click: true, delayMs: 250 });
                await preflightCard.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
              }
            }
          },
          getSegmentNarration(SCENE_5_SEGMENTS, 'ask'),
        );

        // 2. Response 1 Streaming & Waiting for Completion
        await runSegment(
          scene5SegmentAudios,
          'response1',
          getSegmentDuration(SCENE_5_SEGMENTS, 'response1'),
          async () => {
            // Safety check: if preflight card is still visible, click "Send anyway"
            const preflightCard = appPage.locator('.preflight-card').first();
            if ((await preflightCard.count()) > 0 && (await preflightCard.isVisible())) {
              const sendAnywayBtn = appPage
                .locator('.preflight-card button')
                .filter({ hasText: /send anyway/i })
                .first();
              if ((await sendAnywayBtn.count()) > 0) {
                await glideMouse(appPage, sendAnywayBtn, 20, { click: true, delayMs: 200 });
                await preflightCard.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
              }
            }

            // Wait for turn start (Stop button appears)
            await appPage
              .locator('button.danger.composer-send, button:has-text("Stop")')
              .first()
              .waitFor({ state: 'visible', timeout: 8000 })
              .catch(() => {});

            // Wait for response to finish: Stop button disappears and Send button reappears
            await waitForTurnCompletion(appPage, {
              timeoutMs: options.skipBackend ? 4000 : 90000,
            }).catch(() => {});

            // Hover over the streamed assistant answer
            const firstMsg = appPage.locator('.message.assistant').first();
            if ((await firstMsg.count()) > 0) {
              await glideMouse(appPage, firstMsg, 20, { delayMs: 400 });
            }
          },
          getSegmentNarration(SCENE_5_SEGMENTS, 'response1'),
        );

        // 3. Citations Modal Inspection
        await runSegment(
          scene5SegmentAudios,
          'citations',
          getSegmentDuration(SCENE_5_SEGMENTS, 'citations'),
          async () => {
            // Locate citation link in assistant message
            const citationLink = appPage
              .locator('button.citation-link, .citation-pill, a[href^="citation:"]')
              .first();
            if ((await citationLink.count()) > 0) {
              await glideMouse(appPage, citationLink, 20, { click: true, delayMs: 250 });
            } else {
              // Synthetic/visual fallback if model answered without explicit citation tags
              await appPage.evaluate(() => {
                if (!document.querySelector('.citation-overlay')) {
                  const modal = document.createElement('div');
                  modal.className = 'citation-overlay';
                  modal.id = 'demo-citation-modal';
                  modal.innerHTML = `
                    <div class="citation-modal">
                      <div class="citation-modal-header">
                        <span class="citation-modal-title">Citation source · oim_v10_operations_config.pdf</span>
                        <button class="icon-button close-btn" data-tip="Close">✕</button>
                      </div>
                      <div class="citation-modal-body">
                        <div class="citation-section-heading">Section 3.1 · Defining Value Templates</div>
                        <div class="citation-passage">
                          <p>A value template defines dynamic calculations, formatting rules, and column dependencies for property synchronization across identity schema entities.</p>
                        </div>
                      </div>
                    </div>
                  `;
                  document.body.appendChild(modal);
                }
              });
            }

            // Inspect the citation modal body
            const modalBody = appPage.locator('.citation-modal, .citation-modal-body').first();
            try {
              await modalBody.waitFor({ state: 'visible', timeout: 4000 });
              await glideMouse(appPage, modalBody, 20, { delayMs: 400 });
              // Hold on the citation source passage for at least 5 seconds for viewer inspection
              await appPage.waitForTimeout(5000);
            } catch {
              // Continue if already rendered
            }

            // Click close button on the citation modal and wait for clean React unmount
            const closeBtn = appPage.locator('.citation-modal-header button').first();
            if ((await closeBtn.count()) > 0) {
              await glideMouse(appPage, closeBtn, 20, { click: true, delayMs: 250 });
            }
            const citationOverlay = appPage.locator('.citation-overlay').first();
            await citationOverlay
              .waitFor({ state: 'detached', timeout: 2000 })
              .catch(() => {});
            if (
              (await citationOverlay.count()) > 0 &&
              (await citationOverlay.isVisible().catch(() => false))
            ) {
              await appPage.keyboard.press('Escape').catch(() => {});
              await citationOverlay
                .waitFor({ state: 'detached', timeout: 1000 })
                .catch(() => {});
            }
            // Only remove synthetic fallback modal — never detach React-managed .citation-overlay
            await appPage
              .evaluate(() => {
                document.getElementById('demo-citation-modal')?.remove();
              })
              .catch(() => {});
            await appPage.waitForTimeout(400);
          },
          getSegmentNarration(SCENE_5_SEGMENTS, 'citations'),
        );

        // 4. Follow-up Query with Teams/Confluence Search Hints
        await runSegment(
          scene5SegmentAudios,
          'followup',
          getSegmentDuration(SCENE_5_SEGMENTS, 'followup'),
          async () => {
            // Scroll to the bottom before asking follow-up question
            const messagesArea = appPage.locator('.messages').first();
            if ((await messagesArea.count()) > 0) {
              await glideMouse(appPage, messagesArea, 15, { delayMs: 150 });
              await appPage.evaluate(() => {
                const el = document.querySelector('.messages');
                if (el) {
                  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                }
              });
              await appPage.mouse.wheel(0, 400);
              await appPage.waitForTimeout(400);
            }

            // Ensure composer is cleared before typing follow-up
            const composerArea = appPage.locator('.composer textarea').first();
            if ((await composerArea.count()) > 0) {
              await composerArea.fill('');
            }
            await typeInComposer(
              appPage,
              'check if you find any practical info in teams or confluence',
              { delayPerCharMs: 20 },
            );
            await appPage.waitForTimeout(250);

            const sendBtn = appPage
              .locator('button.composer-send.primary, button.composer-send')
              .first();
            if ((await sendBtn.count()) > 0) {
              await glideMouse(appPage, sendBtn, 20, { click: true, delayMs: 200 });
            }
          },
          getSegmentNarration(SCENE_5_SEGMENTS, 'followup'),
        );

        // 5. Response 2 Streaming & Waiting for Completion
        await runSegment(
          scene5SegmentAudios,
          'response2',
          getSegmentDuration(SCENE_5_SEGMENTS, 'response2'),
          async () => {
            // Ensure turn start is registered
            await appPage
              .locator('button.danger.composer-send, button:has-text("Stop"), .thinking-indicator')
              .first()
              .waitFor({ state: 'visible', timeout: 8000 })
              .catch(() => {});

            // Wait for response to finish: Stop button disappears and Send button reappears
            await waitForTurnCompletion(appPage, {
              timeoutMs: options.skipBackend ? 4000 : 150000,
            }).catch(() => {});

            // Hover over the final synthesized multi-turn answer
            const lastMsg = appPage.locator('.message.assistant').last();
            if ((await lastMsg.count()) > 0) {
              await glideMouse(appPage, lastMsg, 20, { delayMs: 600 });
            }
            await appPage.waitForTimeout(600);
          },
          getSegmentNarration(SCENE_5_SEGMENTS, 'response2'),
        );
      });
    }

    // =========================================================================
    // Scene 6: Live Query 3 (Clarifying Questions & Disambiguation)
    // =========================================================================
    if (shouldRunScene(5)) {
      await runSceneWithPadding(5, 'Clarifying Questions & Disambiguation', async () => {
        // 1. Clarification Required card prompt
        await runSegment(
          scene6SegmentAudios,
          'ask',
          getSegmentDuration(SCENE_6_SEGMENTS, 'ask'),
          async () => {
            await startNewConversation();

            // Select playbook oim-db-history via filter or direct select
            const filterInput = appPage.locator('.picker-filter input').first();
            if ((await filterInput.count()) > 0 && (await filterInput.isVisible())) {
              await glideMouse(appPage, filterInput, 15, { click: true, delayMs: 150 });
              await filterInput.fill('oim-db-history');
              await appPage.waitForTimeout(200);
            }
            const dbHistoryRow = appPage
              .locator('button.picker-row, .picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', {
                  hasText: buildPlaybookTitlePattern('oim-db-history'),
                }),
              })
              .first();
            if ((await dbHistoryRow.count()) > 0) {
              await glideMouse(appPage, dbHistoryRow, 20, { click: true, delayMs: 250 });
            } else {
              await selectPlaybook(appPage, 'oim-db-history').catch(() => {});
            }
            await appPage
              .locator('.active-playbook')
              .waitFor({ state: 'visible', timeout: 3000 })
              .catch(() => {});
            await appPage.waitForTimeout(250);

            // Switch thinking effort to configured level
            const thinkingSelect = appPage
              .locator(
                'select.composer-select[aria-label="Thinking effort"], select.composer-select[data-tip="Thinking effort"]',
              )
              .first();
            if ((await thinkingSelect.count()) > 0) {
              await glideMouse(appPage, thinkingSelect, 15, { delayMs: 150, optional: true });
              await thinkingSelect.selectOption(options.thinking).catch(() => {});
              await appPage.waitForTimeout(200);
            }

            // Type question and dispatch
            await typeInComposer(appPage, 'what database changes were done for the AOB module between 9.3.1 and 10.0?', {
              delayPerCharMs: 25,
            });
            await appPage.waitForTimeout(300);

            const sendBtn = appPage
              .locator('button.composer-send.primary, button.composer-send')
              .first();
            await glideMouse(appPage, sendBtn, 20, { click: true, delayMs: 200 });

            // Wait for real clarifying question card or inject fallback
            const clarifCard = appPage
              .locator('.clarifying-question-card:not(.answered)')
              .first();
            const pollStart = Date.now();
            let cardVisible = false;
            const clarifTimeout = options.skipBackend ? 4000 : 120000;
            while (Date.now() - pollStart < clarifTimeout) {
              // As soon as the trace block appears, collapse it immediately
              const expandedTrace = appPage
                .locator('button.trace-bar[aria-expanded="true"]')
                .first();
              if ((await expandedTrace.count()) > 0) {
                const isVis = await expandedTrace.isVisible().catch(() => false);
                if (isVis) {
                  await expandedTrace.click().catch(() => {});
                }
              }

              if ((await clarifCard.count()) > 0 && (await clarifCard.isVisible().catch(() => false))) {
                cardVisible = true;
                break;
              }
              await appPage.waitForTimeout(150);
            }

            // Post-check: ensure trace stays collapsed once card is displayed
            const expandedTracePost = appPage
              .locator('button.trace-bar[aria-expanded="true"]')
              .first();
            if ((await expandedTracePost.count()) > 0) {
              const isVis = await expandedTracePost.isVisible().catch(() => false);
              if (isVis) {
                await expandedTracePost.click().catch(() => {});
              }
            }

            if (!cardVisible && options.skipBackend) {
              await appPage.evaluate(() => {
                const container =
                  document.querySelector('.messages') ||
                  document.querySelector('.chat-view') ||
                  document.querySelector('.main-content');
                if (container && !document.getElementById('demo-clarifying-card')) {
                  const card = document.createElement('div');
                  card.className = 'clarifying-question-card';
                  card.id = 'demo-clarifying-card';
                  card.innerHTML = `
                    <div class="card-header">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span class="card-title">Clarification required</span>
                    </div>
                    <div class="card-question">
                      <p>Did you mean 'content' changes or 'schema' changes for the AOB module between 9.3.1 and 10.0?</p>
                    </div>
                    <div class="card-options">
                      <button type="button" class="option-button">
                        <span class="option-button-label">Schema changes in release 10.0</span>
                        <span class="option-button-desc">Tables and columns added, dropped, or retyped</span>
                      </button>
                      <button type="button" class="option-button">
                        <span class="option-button-label">Content changes (9.3.1 → 10.0)</span>
                        <span class="option-button-desc">Service queues, schedules, and process chain tables</span>
                      </button>
                    </div>
                  `;
                  container.appendChild(card);
                }
              });
            }

            // Glide mouse to clarify card
            const activeCard = appPage
              .locator('.clarifying-question-card, #demo-clarifying-card')
              .first();
            if ((await activeCard.count()) > 0) {
              await glideMouse(appPage, activeCard, 20, { delayMs: 400 });
            }
            await appPage.waitForTimeout(400);
          },
          getSegmentNarration(SCENE_6_SEGMENTS, 'ask'),
        );

        // 2. Select option and stream answer
        await runSegment(
          scene6SegmentAudios,
          'option',
          getSegmentDuration(SCENE_6_SEGMENTS, 'option'),
          async () => {
            const card = appPage
              .locator('.clarifying-question-card:not(.answered), .clarifying-question-card, #demo-clarifying-card')
              .first();
            const optBtn = card
              .locator('button.option-button, button')
              .filter({ hasText: /Schema changes|Identity/i })
              .first();
            const targetBtn =
              (await optBtn.count()) > 0
                ? optBtn
                : card.locator('button.option-button, button').first();

            if ((await targetBtn.count()) > 0) {
              await glideMouse(appPage, targetBtn, 20, { click: true, delayMs: 250 });
            }

            // Wait for clarification card to be registered as answered in DOM
            await appPage
              .locator('.clarifying-question-card.answered, .clarified-badge')
              .first()
              .waitFor({ state: 'visible', timeout: 8000 })
              .catch(() => {});

            // If demo card was injected, convert to answered state
            if (options.skipBackend) {
              await appPage.evaluate(() => {
                const demoCard = document.getElementById('demo-clarifying-card');
                if (demoCard) {
                  demoCard.className = 'clarifying-question-card answered';
                  demoCard.innerHTML = `
                    <div class="card-header">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <span class="card-title">Clarification provided</span>
                    </div>
                    <div class="card-question">
                      <p>Did you mean 'content' changes or 'schema' changes for the AOB module between 9.3.1 and 10.0?</p>
                    </div>
                    <div class="clarified-badge">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                      “Schema changes in release 10.0”
                    </div>
                  `;
                }
              });
            }

            // Wait for turn start (Stop button appears)
            await appPage
              .locator('button.danger.composer-send, button:has-text("Stop")')
              .first()
              .waitFor({ state: 'visible', timeout: 10000 })
              .catch(() => {});

            // Wait for completed answer with auto-trace-collapse and 1s auto-scroll
            await waitForTurnCompletion(appPage, {
              timeoutMs: options.skipBackend ? 4000 : 240000,
            }).catch(() => {});

            // Ensure smooth scroll to bottom
            await appPage.evaluate(() => {
              const el = document.querySelector('.messages');
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
              else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            }).catch(() => {});
            await appPage.waitForTimeout(600);
          },
          getSegmentNarration(SCENE_6_SEGMENTS, 'option'),
        );

        // 3. Trace inspection
        await runSegment(
          scene6SegmentAudios,
          'trace',
          getSegmentDuration(SCENE_6_SEGMENTS, 'trace'),
          async () => {
            // Pause global auto-collapse during trace inspection and always restore in finally
            await appPage.evaluate(() => {
              (window as any).__autoCollapseTrace = false;
            }).catch(() => {});

            try {
              // Find TraceBar button of the final response (currently collapsed)
              const traceBar = appPage.locator('button.trace-bar').last();
              if ((await traceBar.count()) > 0) {
                await traceBar.scrollIntoViewIfNeeded().catch(() => {});
                await glideMouse(appPage, traceBar, 20, { click: true, delayMs: 400 });
                await appPage.waitForTimeout(600);

                // Expand tool step to show queries / tool calls (specifically the database query tool, not ToolSearch)
                const toolStep = appPage
                  .locator('button.trace-step')
                  .filter({ hasText: /query_json|json_objects|get_json_schema/i })
                  .last();
                const fallbackStep = appPage
                  .locator('button.trace-step')
                  .filter({ hasNotText: /ToolSearch/i })
                  .filter({ hasText: /mcp|query|fetch|search|get/i })
                  .first();
                const targetStep =
                  (await toolStep.count()) > 0
                    ? toolStep
                    : (await fallbackStep.count()) > 0
                      ? fallbackStep
                      : appPage.locator('button.trace-step').nth(1);

                const stepToClick =
                  (await targetStep.count()) > 0
                    ? targetStep
                    : appPage.locator('button.trace-step').first();

                if ((await stepToClick.count()) > 0) {
                  await stepToClick.scrollIntoViewIfNeeded().catch(() => {});
                  await glideMouse(appPage, stepToClick, 20, { click: true, delayMs: 400 });
                  await appPage.waitForTimeout(800);

                  // Hover gently over trace step body showing transparent queries
                  const stepBody = appPage.locator('.trace-step-body').last();
                  if ((await stepBody.count()) > 0) {
                    await stepBody.scrollIntoViewIfNeeded().catch(() => {});
                    await glideMouse(appPage, stepBody, 20, { delayMs: 600 });
                  }
                }
              }
              await appPage.waitForTimeout(1500);
            } finally {
              await appPage.evaluate(() => {
                (window as any).__autoCollapseTrace = true;
              }).catch(() => {});
            }
          },
          getSegmentNarration(SCENE_6_SEGMENTS, 'trace'),
        );
      });
    }

    // =========================================================================
    // Scene 7: Live Query 4 (Multi-Agent System MAS)
    // =========================================================================
    if (shouldRunScene(6)) {
      await runSceneWithPadding(6, 'Multi-Agent System MAS', async () => {
        let tTurnStart = 0;

        // 7.1: Mode switch to Multi-Agent Orchestrator
        await runSegment(
          scene7SegmentAudios,
          'mode',
          getSegmentDuration(SCENE_7_SEGMENTS, 'mode'),
          async () => {
            await startNewConversation();

            const modeSelect = appPage
              .locator(
                'select.composer-select[aria-label="Agent mode"], select[aria-label="Agent mode"]',
              )
              .first();
            await modeSelect.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
            if ((await modeSelect.count()) > 0) {
              await glideMouse(appPage, modeSelect, 20, { delayMs: 250 });
              await selectAgentMode(appPage, 'orchestrator');
              await appPage.waitForTimeout(400);

              // Hover briefly over the orchestrator hint "specialists + reviewer"
              const hint = appPage.locator('.orchestrator-hint').first();
              if ((await hint.count()) > 0) {
                await glideMouse(appPage, hint, 15, { delayMs: 400 });
              }
            } else {
              await selectAgentMode(appPage, 'orchestrator');
            }
            await appPage.waitForTimeout(600);
          },
          getSegmentNarration(SCENE_7_SEGMENTS, 'mode'),
        );

        // 7.2: Type prompt & dispatch turn
        await runSegment(
          scene7SegmentAudios,
          'prompt',
          getSegmentDuration(SCENE_7_SEGMENTS, 'prompt'),
          async () => {
            await typeInComposer(
              appPage,
              'Compare standard connector vs csv connector vs custom connector via PowerShell considering also teams/confluence.',
              { delayPerCharMs: 20 },
            );
            await appPage.waitForTimeout(300);

            const sendBtn = appPage
              .locator('button.composer-send.primary, button.composer-send')
              .first();
            if ((await sendBtn.count()) > 0) {
              await glideMouse(appPage, sendBtn, 20, { click: true, delayMs: 200 });
            } else {
              await dispatchTurn(appPage);
            }
            tTurnStart = (Date.now() - tVideoStart) / 1000;

            // Wait for turn to start (subagent cards or live status banner)
            const subagents = appPage.locator('.subagent-card');
            const turnLive = appPage.locator('.message.assistant.live, button:has-text("Stop")');
            const pollStart = Date.now();
            while (Date.now() - pollStart < 8000) {
              if ((await subagents.count()) > 0 || (await turnLive.count()) > 0) {
                break;
              }
              await appPage.waitForTimeout(200);
            }
            await appPage.waitForTimeout(500);
          },
          getSegmentNarration(SCENE_7_SEGMENTS, 'prompt'),
        );

        // 7.3: Specialist parallel execution & Reviewer gate validation
        await runSegment(
          scene7SegmentAudios,
          'review',
          getSegmentDuration(SCENE_7_SEGMENTS, 'review'),
          async () => {
            const subagents = appPage.locator('.subagent-card');
            // Wait up to 20s for subagents to be rendered
            await subagents.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

            const count = await subagents.count();
            if (count > 0) {
              // Glide across the first specialist card
              const firstHeader = subagents.first().locator('.subagent-card-header');
              if ((await firstHeader.count()) > 0) {
                await glideMouse(appPage, firstHeader, 20, { delayMs: 400 });
                await appPage.waitForTimeout(800);
              }

              // Glide across the second specialist card if present
              if (count > 1) {
                const secondHeader = subagents.nth(1).locator('.subagent-card-header');
                if ((await secondHeader.count()) > 0) {
                  await glideMouse(appPage, secondHeader, 20, { delayMs: 400 });
                  await appPage.waitForTimeout(800);
                }
              }
            }

            const tWaitStart = (Date.now() - tVideoStart) / 1000;

            // Wait for full turn completion (specialists finish, Reviewer validates, answer synthesized)
            await waitForTurnCompletion(appPage, {
              timeoutMs: options.skipBackend ? 5000 : 1200000,
              requireReviewer: !options.skipBackend,
            });

            const tWaitEnd = (Date.now() - tVideoStart) / 1000;
            const interval = calculateAccelerationInterval(tWaitStart, tWaitEnd, 4, 10);
            if (interval) {
              accelerationIntervals.push(interval);
              console.log(
                `  Applied 10x video acceleration during multi-agent execution: [${interval.startSec.toFixed(1)}s -> ${interval.endSec.toFixed(1)}s] (saving ${((interval.endSec - interval.startSec) * 0.9).toFixed(1)}s)`,
              );
            }
            await appPage.waitForTimeout(500);
          },
          getSegmentNarration(SCENE_7_SEGMENTS, 'review'),
        );

        // 7.4: Reviewer approval & markdown comparison table
        await runSegment(
          scene7SegmentAudios,
          'approval',
          getSegmentDuration(SCENE_7_SEGMENTS, 'approval'),
          async () => {
            // Inspect the approved verdict badge on Reviewer card
            const verdictBadge = appPage
              .locator(
                '.subagent-card .verdict-badge.approved, .verdict-badge.approved, .verdict-badge',
              )
              .first();
            if ((await verdictBadge.count()) > 0) {
              await verdictBadge.scrollIntoViewIfNeeded().catch(() => {});
              await glideMouse(appPage, verdictBadge, 20, { delayMs: 400 });
              await appPage.waitForTimeout(600);
            }

            // Scroll down to and inspect the synthesized markdown comparison table
            const table = appPage.locator('.message.assistant .markdown table').last();
            if ((await table.count()) > 0) {
              await table.scrollIntoViewIfNeeded().catch(() => {});
              await glideMouse(appPage, table, 20, { delayMs: 600 });
            } else {
              const lastMsg = appPage.locator('.message.assistant').last();
              if ((await lastMsg.count()) > 0) {
                await lastMsg.scrollIntoViewIfNeeded().catch(() => {});
                await glideMouse(appPage, lastMsg, 20, { delayMs: 600 });
              }
            }
            await appPage.waitForTimeout(800);
          },
          getSegmentNarration(SCENE_7_SEGMENTS, 'approval'),
        );

        // 7.5: Outro resting glide & conclusion
        await runSegment(
          scene7SegmentAudios,
          'outro',
          getSegmentDuration(SCENE_7_SEGMENTS, 'outro'),
          async () => {
            // Glide smoothly to center resting position
            await appPage.mouse.move(640, 360, { steps: 25 });
            await appPage.waitForTimeout(1500);
          },
          getSegmentNarration(SCENE_7_SEGMENTS, 'outro'),
        );
      });
    }

    // Buffer pause to ensure final scene frames settle and are not truncated
    await appPage.waitForTimeout(1000);

    // Stop global auto-collapse observer cleanly before closing page
    await appPage
      .evaluate(() => (window as any).__stopAutoCollapseTrace?.())
      .catch(() => {});

    // Retrieve recorded video path
    const video = appPage.video();
    await appPage.close();
    const recordedVideoPath = await video?.path();

    if (!recordedVideoPath || !fs.existsSync(recordedVideoPath)) {
      throw new Error('Recorded video file was not found after page close.');
    }

    console.log(`\nVideo capture finished: ${recordedVideoPath}`);

    // Multiplex and stitch video with audio, subtitles, and background music
    let combinedAudioPath: string | undefined;
    if (!options.skipTts && sceneAudios.length > 0) {
      combinedAudioPath = path.join(recordingsDir, 'narration.wav');
      // Append 1.0s silence buffer to match the final appPage.waitForTimeout(1000)
      const silenceEnd = createSilencePcm(1.0);
      const activeAudios = (options.scenes
        ? options.scenes.map((s) => sceneAudios[s - 1])
        : SCENE_NARRATIONS.map((_, idx) => (shouldRunScene(idx) ? sceneAudios[idx] : undefined))
      ).filter(Boolean) as SynthesizeResult[];
      // Reuse exact quantized initialSilence passed into createTimelineSyncController
      const combinedPcm = Buffer.concat([
        initialSilence,
        ...activeAudios.map((a) => a.pcmBuffer),
        silenceEnd,
      ]);
      const combinedWav = pcmToWav(combinedPcm);
      fs.writeFileSync(combinedAudioPath, combinedWav);
    }

    // Generate SRT subtitles directly from effective-coordinate cues tracked by timelineSync
    const srtContent = generateSrt(timelineSync.getSubtitleCues());
    const srtPath = path.join(recordingsDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, srtContent, 'utf8');

    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

    // Also write sidecar subtitles next to destination MP4
    const sidecarSrt = options.outputPath.replace(/\.mp4$/, '.srt');
    fs.writeFileSync(sidecarSrt, srtContent, 'utf8');
    console.log(`Saved sidecar subtitles to: ${sidecarSrt}`);

    // Optional background music: only mix if an ambient audio file exists on disk
    let backgroundMusicPath: string | null = null;
    const defaultAmbientPath = path.resolve(process.cwd(), 'scripts/video/assets/ambient.mp3');
    if (fs.existsSync(defaultAmbientPath)) {
      backgroundMusicPath = defaultAmbientPath;
    }

    console.log(`Stitching output with universal MP4 flags to ${options.outputPath}...`);
    try {
      await stitchVideoAndAudio({
        videoPath: recordedVideoPath,
        audioPath: combinedAudioPath,
        backgroundMusicPath,
        subtitlesPath: srtPath,
        enableDucking: true,
        duckingDb: -14,
        outputPath: options.outputPath,
        skipTts: options.skipTts,
        accelerationIntervals:
          accelerationIntervals.length > 0 ? accelerationIntervals : undefined,
      });
      console.log(`\nDemo video generated successfully at: ${options.outputPath}`);
    } catch (err) {
      if (err instanceof FfmpegNotFoundError) {
        const fallbackWebm = options.outputPath.replace(/\.mp4$/, '.webm');
        fs.copyFileSync(recordedVideoPath, fallbackWebm);
        console.warn(`\n⚠️  FFmpeg is not installed. Saved raw WebM video to: ${fallbackWebm}`);
        if (combinedAudioPath && fs.existsSync(combinedAudioPath)) {
          const fallbackWav = options.outputPath.replace(/\.mp4$/, '.wav');
          fs.copyFileSync(combinedAudioPath, fallbackWav);
          console.warn(`Saved narration audio to: ${fallbackWav}`);
        }
        console.warn(
          'You can open and view the .webm video directly in Chrome, Edge, Safari, or VLC.',
        );
        console.warn('To convert to MP4: install FFmpeg via "brew install ffmpeg".');
      } else {
        throw err;
      }
    }
  } finally {
    await teardown();
  }
}

// Execute directly if run via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemoVideoGenerator().catch((err) => {
    console.error('Fatal demo video error:', err);
    process.exit(1);
  });
}

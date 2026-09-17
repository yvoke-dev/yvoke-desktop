/**
 * Orchestrator runner for automated Yvoke demo video generation.
 *
 * Automates:
 * 1. Preflight checks for build artifacts, backend connectivity, Claude CLI, and API key.
 * 2. Pre-seeding a temporary isolated userDataDir with 4 rich threads (Playbook validation, Search hints, Clarifications/Citations, MAS Orchestrator).
 * 3. Headed Playwright Electron launch at 1920x1080 (Full HD) with video recording.
 * 4. 6-scene choreography matching approved ASDD plan:
 *    - Part I: Educational Architecture Intro (3 cards: Playbooks & Source Scoping, Single vs Multi-Agent OIM MAS, Prompting Best Practices)
 *    - Part II: Live Conversations:
 *      - Scene 2: Playbook Validation Catch
 *      - Scene 3: Multi-Turn Follow-Up & Search Hints
 *      - Scene 4: Clarifying Questions & Citations
 *      - Scene 5: Multi-Agent System (MAS) with Reviewer Gate
 *      - Scene 6: Sub-10ms Instant Search & Dark/Light Theme Toggle
 * 5. Dynamic pacing, audio synthesis via Gemini TTS, and SRT subtitles generation.
 * 6. Video stitching with sidechain audio ducking and ambient background music.
 * 7. Resilient teardown with 5s SIGKILL fallback and signal traps.
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
  createProceduralAmbientWav,
} from './video/preflight';
import {
  injectPresentationOverlay,
  showPresentationSlide,
  unmountPresentationOverlay,
} from './video/presentation';
import { injectDemoCursor, glideMouse } from './video/cursor';
import {
  stitchVideoAndAudio,
  FfmpegNotFoundError,
  type AccelerationInterval,
} from './video/stitch';
import { STORYBOARD_BEATS } from './video/storyboard';
import {
  typeInComposer,
  selectPlaybook,
  selectAgentMode,
  dispatchTurn,
  waitForTurnCompletion,
} from './video/liveTurnRunner';
import {
  synthesizeSpeech,
  pcmToWav,
  combineSynthesizeResults,
  type SynthesizeResult,
} from './video/tts';
import { generateSrt, type SubtitleCue } from './video/subtitles';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;

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

export interface DemoOptions {
  skipTts: boolean;
  skipBackend: boolean;
  backendUrl: string;
  outputPath: string;
}

export function parseArgs(): DemoOptions {
  const args = process.argv.slice(2);
  const skipTts = args.includes('--skip-tts');
  const skipBackend = args.includes('--skip-backend') || args.includes('--offline');
  const backendIdx = args.indexOf('--backend-url');
  const backendUrl =
    backendIdx !== -1 && args[backendIdx + 1]
      ? args[backendIdx + 1]
      : (process.env.YVOKE_SERVER ?? process.env.YVOKE_SERVER_URL ?? 'http://localhost:8080');
  const outIdx = args.indexOf('--output');
  const outputPath =
    outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.resolve(process.cwd(), 'artifacts/yvoke-desktop-demo.mp4');

  return { skipTts, skipBackend, backendUrl, outputPath };
}

export const SCENE_1_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'welcome',
    narration: 'Welcome to Yvoke Desktop, the native AI assistant for deep enterprise engineering.',
  },
  {
    key: 'sidebar',
    narration:
      'On the left, the sidebar organizes your conversation history into clear timeframes, with instant search across past discussions.',
  },
  {
    key: 'profile',
    narration:
      'At the bottom, view your authenticated profile, security mode, and access application settings.',
  },
];

export const SCENE_2_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'intro',
    narration: 'Opening Settings reveals full control over your environment.',
  },
  {
    key: 'server',
    narration: 'Under Server, configure backend endpoints, transport, and authentication.',
  },
  {
    key: 'models',
    narration: 'Models lets you define Claude model versions and default thinking effort.',
  },
  {
    key: 'agents',
    narration: 'Agents configures multi-agent roles, turns, and automatic playbook validation.',
  },
  {
    key: 'webSearch',
    narration: 'Web Search manages enterprise domain allowlists,',
  },
  {
    key: 'appearance',
    narration: 'Appearance customizes themes and density,',
  },
  {
    key: 'advanced',
    narration: 'while Advanced and About display identity registration and version details.',
  },
];

export const SCENE_3_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'newConv',
    narration: 'Starting a new conversation opens the main workspace.',
  },
  {
    key: 'playbooks',
    narration:
      'The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history.',
  },
  {
    key: 'composer',
    narration:
      'Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls.',
  },
];

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
  options?: { cloneRealThreads?: boolean },
): string {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-demo-video-'));

  // 1. Settings strictly configured for local dev environment (Streamable HTTP + Dev token)
  const settings = {
    settingsVersion: 1,
    serverAuthMode: 'dev',
    authMode: 'dev',
    serverBaseUrl: backendUrl,
    devToken: 'dev-demo-token',
    mcpTransport: 'http',
    defaultModel: 'sonnet',
    defaultThinkingLevel: 'medium',
    playbookValidationEnabled: true,
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
        model: 'sonnet',
        thinkingLevel: 'medium',
      },
      reviewer: {
        model: 'sonnet',
        thinkingLevel: 'medium',
      },
      specialist: {
        model: 'sonnet',
        thinkingLevel: 'medium',
      },
      maxReviewRounds: 2,
      maxSpecialistCalls: 8,
      requireReview: true,
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
      thinkingLevel: 'medium',
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
      thinkingLevel: 'medium',
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

  console.log('--- Yvoke Demo Video Orchestrator ---');
  console.log(`Mode: ${options.skipTts ? 'Video Only (--skip-tts)' : 'Full (Voice + Video)'}`);
  console.log(`Resolution: 1920x1080 (Full HD)`);
  console.log(`Output: ${options.outputPath}`);

  // Synthesize TTS if enabled
  const sceneAudios: SynthesizeResult[] = [];
  const scene1SegmentAudios = new Map<string, SynthesizeResult>();
  const scene2SegmentAudios = new Map<string, SynthesizeResult>();
  const scene3SegmentAudios = new Map<string, SynthesizeResult>();

  if (!options.skipTts) {
    console.log('\n[1/4] Synthesizing TTS voice narrations via Gemini...');

    // Scene 1: Segmented
    console.log(`  Scene 1/${SCENE_NARRATIONS.length} (App & Sidebar Overview, ${SCENE_1_SEGMENTS.length} segments)...`);
    const s1Results: SynthesizeResult[] = [];
    for (const seg of SCENE_1_SEGMENTS) {
      const res = await synthesizeSpeech(seg.narration);
      scene1SegmentAudios.set(seg.key, res);
      s1Results.push(res);
    }
    sceneAudios.push(combineSynthesizeResults(s1Results));

    // Scene 2: Segmented
    console.log(`  Scene 2/${SCENE_NARRATIONS.length} (Settings Walkthrough, ${SCENE_2_SEGMENTS.length} segments)...`);
    const s2Results: SynthesizeResult[] = [];
    for (const seg of SCENE_2_SEGMENTS) {
      const res = await synthesizeSpeech(seg.narration);
      scene2SegmentAudios.set(seg.key, res);
      s2Results.push(res);
    }
    sceneAudios.push(combineSynthesizeResults(s2Results));

    // Scene 3: Segmented
    console.log(`  Scene 3/${SCENE_NARRATIONS.length} (New Conversation & Composer, ${SCENE_3_SEGMENTS.length} segments)...`);
    const s3Results: SynthesizeResult[] = [];
    for (const seg of SCENE_3_SEGMENTS) {
      const res = await synthesizeSpeech(seg.narration);
      scene3SegmentAudios.set(seg.key, res);
      s3Results.push(res);
    }
    sceneAudios.push(combineSynthesizeResults(s3Results));

    // Scenes 4 to 8: Direct synthesis
    for (let i = 3; i < SCENE_NARRATIONS.length; i++) {
      console.log(`  Scene ${i + 1}/${SCENE_NARRATIONS.length}...`);
      const res = await synthesizeSpeech(SCENE_NARRATIONS[i]);
      sceneAudios.push(res);
    }
    console.log('  Voice narrations synthesized successfully.');
  } else {
    console.log('\n[1/4] Skipping TTS voice narration (--skip-tts).');
  }

  // Seed temp directory
  console.log('\n[2/4] Initializing isolated profile environment...');
  const userDataDir = seedUserData(options.backendUrl, { cloneRealThreads: true });
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
    console.log('\n[3/4] Launching Electron in headed Full HD mode (1920x1080)...');
    const mainEntry = path.resolve(process.cwd(), 'out/main/index.js');
    electronApp = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        YVOKE_USER_DATA_DIR: userDataDir,
        YVOKE_HEADLESS: '0',
      },
      recordVideo: {
        dir: recordingsDir,
        size: { width: 1920, height: 1080 },
      },
    });

    const appPage: Page = await electronApp.firstWindow();

    // Set exact Full HD window size and position
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1920, 1080);
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

    console.log('\n[4/4] Executing 6-scene choreographies...');

    const sceneTimings: { startMs: number; endMs: number }[] = [];
    const accelerationIntervals: AccelerationInterval[] = [];
    const tVideoStart = Date.now();

    const runSceneWithPadding = async (
      sceneIdx: number,
      name: string,
      actionFn: () => Promise<void>,
    ): Promise<void> => {
      console.log(`  Running Scene ${sceneIdx + 1}/${SCENE_NARRATIONS.length}: ${name}`);
      const sceneStartMs = Date.now() - tVideoStart;
      await actionFn();
      const actionElapsedSec = (Date.now() - tVideoStart - sceneStartMs) / 1000;
      const audioDuration = sceneAudios[sceneIdx]?.durationSeconds ?? 0;
      const minPadding = options.skipTts ? (sceneIdx === 0 ? 5.5 : 4.0) : 0;
      const paddingWaitSec = Math.max(minPadding, Math.max(0, audioDuration - actionElapsedSec));

      if (paddingWaitSec > 0) {
        await appPage.waitForTimeout(paddingWaitSec * 1000);
      }
      const sceneEndMs = Date.now() - tVideoStart;
      sceneTimings.push({ startMs: sceneStartMs, endMs: sceneEndMs });
    };

    const runSegment = async (
      segAudioMap: Map<string, SynthesizeResult>,
      key: string,
      defaultDurationSec: number,
      actionFn: () => Promise<void>,
    ): Promise<void> => {
      const tStart = Date.now();
      await actionFn();
      const segSec = segAudioMap.get(key)?.durationSeconds ?? defaultDurationSec;
      const elapsedSec = (Date.now() - tStart) / 1000;
      const remainingSec = segSec - elapsedSec;
      if (remainingSec > 0) {
        await appPage.waitForTimeout(remainingSec * 1000);
      }
    };

    const selectSidebarThread = async (text?: string): Promise<void> => {
      let thread = text
        ? appPage.locator('.thread-item').filter({ hasText: text }).first()
        : appPage.locator('.thread-item').first();
      if ((await thread.count()) === 0) {
        thread = appPage.locator('.thread-item').first();
      }
      if ((await thread.count()) > 0) {
        if (!(await thread.isVisible())) {
          const shutGroups = appPage.locator('.thread-group-label[aria-expanded="false"]');
          const shutCount = await shutGroups.count();
          for (let i = 0; i < shutCount; i++) {
            await shutGroups.nth(i).click().catch(() => {});
          }
          await appPage.waitForTimeout(200);
        }
        await glideMouse(appPage, thread, 25, { click: true, delayMs: 200 });
      }
    };

    // Pre-select the first conversation so the video opens showing the live, rich AI assistant workspace
    await selectSidebarThread();
    await appPage.waitForTimeout(600);

    // =========================================================================
    // Scene 1: App & Sidebar Overview
    // =========================================================================
    await runSceneWithPadding(0, 'App & Sidebar Overview', async () => {
      // 1. Welcome - Show active live desktop app
      await runSegment(scene1SegmentAudios, 'welcome', 4.0, async () => {
        // App is already displaying an active conversation with full chat view!
        // Smoothly glide mouse across active message response and trace bar
        const traceBar = appPage.locator('.trace-bar, .message').first();
        if ((await traceBar.count()) > 0) {
          await glideMouse(appPage, traceBar, 25, { delayMs: 400 });
        }
      });

      // 2. Sidebar & Threads & Search
      await runSegment(scene1SegmentAudios, 'sidebar', 6.5, async () => {
        // Hover over the header app title "YVOKE"
        const appTitle = appPage.locator('.thread-list-header .app-title').first();
        if ((await appTitle.count()) > 0) {
          await glideMouse(appPage, appTitle, 20, { delayMs: 300 });
        }

        // Glide across past conversation threads
        const threadItems = appPage.locator('.thread-item');
        const count = await threadItems.count();
        if (count > 0) {
          await glideMouse(appPage, threadItems.first(), 20, { delayMs: 350 });
          if (count > 1) {
            await glideMouse(appPage, threadItems.nth(1), 20, { delayMs: 350 });
          }
        }

        // Search input
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
      });

      // 3. Profile & Settings
      await runSegment(scene1SegmentAudios, 'profile', 5.0, async () => {
        const accountChip = appPage.locator('.thread-list-footer .account-chip, .account-mode').first();
        if ((await accountChip.count()) > 0) {
          await glideMouse(appPage, accountChip, 20, { delayMs: 400 });
        }

        const logoutBtn = appPage
          .locator('button[data-tip*="Sign out"], .footer-actions button')
          .first();
        if ((await logoutBtn.count()) > 0) {
          await glideMouse(appPage, logoutBtn, 20, { delayMs: 350 });
        }

        const settingsBtn = appPage
          .locator('button[data-tip="Settings"], .settings-button')
          .first();
        if ((await settingsBtn.count()) > 0) {
          await glideMouse(appPage, settingsBtn, 20, { delayMs: 400 });
        }
      });
    });

    // =========================================================================
    // Scene 2: Settings Walkthrough
    // =========================================================================
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
              await glideMouse(appPage, target, 20, { delayMs: 200 });
            }
          }
        }
      };

      // 1. Intro: "Opening Settings reveals full control over your environment."
      await runSegment(scene2SegmentAudios, 'intro', 3.2, async () => {
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
      });

      // 2. Server: "Under Server, configure backend endpoints, transport, and authentication."
      await runSegment(scene2SegmentAudios, 'server', 3.5, async () => {
        await visitPane('Server', '.settings-field input');
      });

      // 3. Models: "Models lets you define Claude model versions and default thinking effort."
      await runSegment(scene2SegmentAudios, 'models', 4.2, async () => {
        await visitPane('Models', '.chip-list, .seg');
      });

      // 4. Agents: "Agents configures multi-agent roles, turns, and automatic playbook validation."
      await runSegment(scene2SegmentAudios, 'agents', 4.0, async () => {
        await visitPane('Agents', '.check-field input, .role-card');
      });

      // 5. Web search: "Web Search manages enterprise domain allowlists,"
      await runSegment(scene2SegmentAudios, 'webSearch', 2.8, async () => {
        await visitPane('Web search', '.domain-row, .settings-field');
      });

      // 6. Appearance: "Appearance customizes themes and density,"
      await runSegment(scene2SegmentAudios, 'appearance', 2.8, async () => {
        await visitPane('Appearance', '.theme-choices, .density-choice');
      });

      // 7. Advanced: "while Advanced and About display identity registration and version details."
      await runSegment(scene2SegmentAudios, 'advanced', 3.5, async () => {
        await visitPane('Advanced', '.settings-field input, .settings-note');
        await appPage.waitForTimeout(400);
        await visitPane('About', '.about-version-row');
        await appPage.waitForTimeout(400);

        // Close Settings
        const cancelBtn = appPage
          .locator('.dialog-actions button')
          .filter({ hasText: 'Cancel' })
          .first();
        if ((await cancelBtn.count()) > 0) {
          await glideMouse(appPage, cancelBtn, 20, { click: true, delayMs: 200 });
        }
      });
    });

    // =========================================================================
    // Scene 3: New Conversation, Playbooks & Composer
    // =========================================================================
    await runSceneWithPadding(2, 'New Conversation, Playbooks & Composer', async () => {
      // 1. New conversation
      await runSegment(scene3SegmentAudios, 'newConv', 3.0, async () => {
        const newBtn = appPage
          .locator(
            'aside.thread-list button[data-tip="New conversation"], aside.thread-list .thread-list-header button.primary',
          )
          .first();
        if ((await newBtn.count()) > 0) {
          await glideMouse(appPage, newBtn, 20, { click: true, delayMs: 200 });
        }
        await appPage.waitForTimeout(400);
      });

      // 2. Playbook picker
      await runSegment(scene3SegmentAudios, 'playbooks', 6.0, async () => {
        const picker = appPage.locator('.picker, .picker-list').first();
        if ((await picker.count()) > 0) {
          const filterInput = appPage.locator('.picker-filter input').first();
          if ((await filterInput.count()) > 0) {
            await glideMouse(appPage, filterInput, 20, { delayMs: 250 });
          }
          const rows = appPage.locator('.picker-row');
          const rowCount = await rows.count();
          if (rowCount > 0) {
            await glideMouse(appPage, rows.first(), 20, { delayMs: 350 });
            if (rowCount > 1) {
              await glideMouse(appPage, rows.nth(1), 20, { delayMs: 350 });
            }
          }
        }
      });

      // 3. Composer
      await runSegment(scene3SegmentAudios, 'composer', 8.0, async () => {
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
            .locator('select.composer-select[data-tip*="Multi-agent"]')
            .first();
          if ((await modeSelect.count()) > 0) {
            await glideMouse(appPage, modeSelect, 20, { delayMs: 350 });
          }

          const modelSelect = appPage.locator('select.composer-select[data-tip="Model"]').first();
          if ((await modelSelect.count()) > 0) {
            await glideMouse(appPage, modelSelect, 20, { delayMs: 350 });
          }

          const thinkingSelect = appPage
            .locator('select.composer-select[data-tip="Thinking effort"]')
            .first();
          if ((await thinkingSelect.count()) > 0) {
            await glideMouse(appPage, thinkingSelect, 20, { delayMs: 350 });
          }

          const sendBtn = appPage.locator('button.composer-send').first();
          if ((await sendBtn.count()) > 0) {
            await glideMouse(appPage, sendBtn, 20, { delayMs: 400 });
          }
        }
      });
    });


    const startNewConversation = async (): Promise<void> => {
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
    await runSceneWithPadding(3, 'Playbook Validation Catch', async () => {
      await startNewConversation();

      // 1. Select initial playbook oim-getting-started
      await selectPlaybook(appPage, 'oim-getting-started').catch(() => {});
      await appPage.waitForTimeout(300);

      // 2. Type user question
      await typeInComposer(appPage, 'When was the table POLPlaybook introduced?');
      await appPage.waitForTimeout(200);

      // 3. Dispatch turn
      const tTurnStart = (Date.now() - tVideoStart) / 1000;
      await dispatchTurn(appPage);

      // 4. Handle preflight recommendation card
      const preflightCard = appPage
        .locator('.preflight-card, #demo-preflight-recommendation')
        .first();
      let cardFound = false;
      try {
        await preflightCard.waitFor({ state: 'visible', timeout: 5000 });
        cardFound = true;
      } catch {
        // Fallback for offline simulation if backend is not active
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
        cardFound = true;
      }

      if (cardFound) {
        const activeCard = appPage
          .locator('.preflight-card, #demo-preflight-recommendation')
          .first();
        const switchBtn = activeCard.locator('.demo-switch-btn, button.primary').first();
        if ((await switchBtn.count()) > 0) {
          await glideMouse(appPage, switchBtn, 20, { click: true, delayMs: 250 });
        }
        await appPage.evaluate(() =>
          document.getElementById('demo-preflight-recommendation')?.remove(),
        );
      }

      // 5. Wait for turn completion
      await waitForTurnCompletion(appPage, {
        timeoutMs: options.skipBackend ? 4000 : 60000,
      }).catch(() => {});
      const tTurnEnd = (Date.now() - tVideoStart) / 1000;
      const accel = calculateAccelerationInterval(tTurnStart, tTurnEnd);
      if (accel) {
        accelerationIntervals.push(accel);
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 5: Live Query 2 (Multi-Turn Follow-Up & Search Hints)
    // =========================================================================
    await runSceneWithPadding(4, 'Multi-Turn Follow-Up & Search Hints', async () => {
      await startNewConversation();

      // 1. Select playbook oim-getting-started
      await selectPlaybook(appPage, 'oim-getting-started').catch(() => {});
      await appPage.waitForTimeout(300);

      // 2. First turn
      await typeInComposer(appPage, 'what is a value template?');
      const tTurn1Start = (Date.now() - tVideoStart) / 1000;
      await dispatchTurn(appPage);
      await waitForTurnCompletion(appPage, {
        timeoutMs: options.skipBackend ? 4000 : 60000,
      }).catch(() => {});
      const tTurn1End = (Date.now() - tVideoStart) / 1000;
      const accel1 = calculateAccelerationInterval(tTurn1Start, tTurn1End);
      if (accel1) {
        accelerationIntervals.push(accel1);
      }
      await appPage.waitForTimeout(600);

      // 3. Multi-turn follow-up with search hints
      await typeInComposer(
        appPage,
        'check if you find any practical info in teams or confluence',
      );
      const tTurn2Start = (Date.now() - tVideoStart) / 1000;
      await dispatchTurn(appPage);
      await waitForTurnCompletion(appPage, {
        timeoutMs: options.skipBackend ? 4000 : 60000,
      }).catch(() => {});
      const tTurn2End = (Date.now() - tVideoStart) / 1000;
      const accel2 = calculateAccelerationInterval(tTurn2Start, tTurn2End);
      if (accel2) {
        accelerationIntervals.push(accel2);
      }

      // 4. Hover over response content & citations
      const msgs = appPage.locator('.message');
      if ((await msgs.count()) > 0) {
        const lastMsg = msgs.last();
        await glideMouse(appPage, lastMsg, 20, { delayMs: 400 });
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 6: Live Query 3 (Clarifying Questions & Citations)
    // =========================================================================
    await runSceneWithPadding(5, 'Clarifying Questions & Citations', async () => {
      await startNewConversation();

      // 1. Select playbook oim-db-history
      await selectPlaybook(appPage, 'oim-db-history').catch(() => {});
      await appPage.waitForTimeout(300);

      // 2. Type question
      await typeInComposer(appPage, 'what database changes were done between 9.3.1 and 10.0?');
      const tTurnStart = (Date.now() - tVideoStart) / 1000;
      await dispatchTurn(appPage);

      // 3. Clarifying questions interactive card handling
      const clarifCard = appPage
        .locator('.clarifying-question-card, .clarified-badge')
        .first();
      try {
        await clarifCard.waitFor({ state: 'visible', timeout: 8000 });
        const optBtn = clarifCard
          .locator('button, .clarifying-option')
          .filter({ hasText: /Identity/i })
          .first();
        if ((await optBtn.count()) > 0) {
          await glideMouse(appPage, optBtn, 20, { click: true, delayMs: 250 });
        }
      } catch {
        // Model answered directly without clarification
      }

      // 4. Wait for turn completion
      await waitForTurnCompletion(appPage, {
        timeoutMs: options.skipBackend ? 4000 : 60000,
      }).catch(() => {});
      const tTurnEnd = (Date.now() - tVideoStart) / 1000;
      const accel = calculateAccelerationInterval(tTurnStart, tTurnEnd);
      if (accel) {
        accelerationIntervals.push(accel);
      }

      // 5. Open verified citation modal (real or visual preview)
      const citationPill = appPage
        .locator('.citation-pill, .citation-badge, a[href*="pdf"]')
        .first();
      if ((await citationPill.count()) > 0) {
        await glideMouse(appPage, citationPill, 20, { click: true, delayMs: 250 });
        await appPage.waitForTimeout(1200);
        const closeBtn = appPage.locator('.citation-overlay .close-btn, .modal-close').first();
        if ((await closeBtn.count()) > 0) {
          await glideMouse(appPage, closeBtn, 20, { click: true, delayMs: 200 });
        }
      } else {
        await appPage.evaluate(() => {
          if (!document.querySelector('.citation-overlay')) {
            const modal = document.createElement('div');
            modal.className = 'citation-overlay';
            modal.id = 'demo-citation-modal';
            modal.innerHTML = `
              <div class="citation-modal">
                <div class="citation-modal-header">
                  <span class="citation-modal-title">Citation source · oim_v10_release_notes.pdf</span>
                  <button class="icon-button close-btn" data-tip="Close">✕</button>
                </div>
                <div class="citation-modal-body">
                  <div class="citation-section-heading">Section 4.2 · Identity Schema Migration</div>
                  <div class="citation-passage">
                    <p>In version 10.0, the <code>Person</code> table schema includes multi-tenant attributes <code>UID_Tenant</code> and <code>ExternalIdentityId</code> to support hybrid cloud topologies.</p>
                  </div>
                </div>
              </div>
            `;
            document.body.appendChild(modal);
          }
        });
        await appPage.waitForTimeout(1400);
        await appPage.evaluate(() => document.getElementById('demo-citation-modal')?.remove());
      }

      // 6. Inspect TraceBar
      const traceBar = appPage.locator('.trace-bar').first();
      if ((await traceBar.count()) > 0) {
        await glideMouse(appPage, traceBar, 20, { click: true, delayMs: 200 });
        await appPage.waitForTimeout(400);
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 7: Live Query 4 (Multi-Agent System MAS)
    // =========================================================================
    await runSceneWithPadding(6, 'Multi-Agent System MAS', async () => {
      await startNewConversation();

      // 1. Switch composer agent mode dropdown to Multi-agent (orchestrator)
      await selectAgentMode(appPage, 'orchestrator');
      await appPage.waitForTimeout(300);

      // 2. Type multi-agent comparison prompt
      await typeInComposer(
        appPage,
        'Compare standard connector vs csv connector vs custom connector via PowerShell considering teams/confluence',
      );
      const tTurnStart = (Date.now() - tVideoStart) / 1000;
      await dispatchTurn(appPage);

      // 3. Wait for multi-agent completion
      await waitForTurnCompletion(appPage, {
        timeoutMs: options.skipBackend ? 5000 : 90000,
      }).catch(() => {});
      const tTurnEnd = (Date.now() - tVideoStart) / 1000;
      const accel = calculateAccelerationInterval(tTurnStart, tTurnEnd);
      if (accel) {
        accelerationIntervals.push(accel);
      }

      // 4. Inspect subagent cards and reviewer badge
      const subagents = appPage.locator('.subagent-card');
      if ((await subagents.count()) > 0) {
        const firstHeader = subagents.first().locator('.subagent-card-header');
        if ((await firstHeader.count()) > 0) {
          await glideMouse(appPage, firstHeader, 20, { click: true, delayMs: 200 });
          await appPage.waitForTimeout(400);
        }

        const reviewerHeader = subagents.last().locator('.subagent-card-header');
        if ((await reviewerHeader.count()) > 0) {
          await glideMouse(appPage, reviewerHeader, 20, { click: true, delayMs: 200 });
          await appPage.waitForTimeout(400);
        }
      }

      const reviewBadge = appPage.locator('.review-badge').first();
      if ((await reviewBadge.count()) > 0) {
        await glideMouse(appPage, reviewBadge, 20, { delayMs: 300 });
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 8: Speed, Instant Search (<10ms) & Dark/Light Theme Toggle
    // =========================================================================
    await runSceneWithPadding(7, 'Instant Search & Theme Toggle', async () => {
      const searchInput = appPage
        .locator('.thread-search input, input[placeholder*="Search"]')
        .first();
      if ((await searchInput.count()) > 0) {
        await glideMouse(appPage, searchInput, 20, { click: true, delayMs: 150 });
        await searchInput.fill('Identity');
        await appPage.waitForTimeout(700);

        const searchClear = appPage.locator('.search-clear').first();
        if ((await searchClear.count()) > 0) {
          await glideMouse(appPage, searchClear, 20, { click: true, delayMs: 150 });
        } else {
          await searchInput.fill('');
        }
        await appPage.waitForTimeout(300);
      }

      const settingsBtn = appPage
        .locator('button[data-tip="Settings"], .settings-button')
        .first();
      if ((await settingsBtn.count()) > 0) {
        await glideMouse(appPage, settingsBtn, 20, { delayMs: 150 });
      }

      // Smoothly toggle theme
      await appPage.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
      });
      await appPage.waitForTimeout(1400);
      await appPage.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
      });
      await appPage.waitForTimeout(800);
    });

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
      const combinedPcm = Buffer.concat(sceneAudios.map((a) => a.pcmBuffer));
      const combinedWav = pcmToWav(combinedPcm);
      fs.writeFileSync(combinedAudioPath, combinedWav);
    }

    // Generate SRT subtitles
    const subtitleCues: SubtitleCue[] = sceneTimings.map((timing, idx) => ({
      startTimeMs: timing.startMs,
      endTimeMs: timing.endMs,
      text: SCENE_NARRATIONS[idx] || '',
    }));
    const srtContent = generateSrt(subtitleCues);
    const srtPath = path.join(recordingsDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, srtContent, 'utf8');

    // Ambient background music with procedural fallback
    let backgroundMusicPath: string | null = path.resolve(
      process.cwd(),
      'scripts/video/assets/ambient.mp3',
    );
    if (!fs.existsSync(backgroundMusicPath)) {
      const synthWavPath = path.join(recordingsDir, 'ambient.wav');
      if (!fs.existsSync(synthWavPath)) {
        fs.writeFileSync(synthWavPath, createProceduralAmbientWav(300));
      }
      backgroundMusicPath = synthWavPath;
    }

    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

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

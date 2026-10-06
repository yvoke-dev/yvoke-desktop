/**
 * Orchestrator runner for automated Yvoke demo video generation.
 *
 * Automates:
 * 1. Preflight checks for build artifacts, backend connectivity, Claude CLI, and API key.
 * 2. Pre-seeding a temporary isolated userDataDir with 4 rich threads (Playbook validation, Search hints, Clarifications/Citations, MAS Orchestrator).
 * 3. Headed Playwright Electron launch at 1280x720 (720p HD) with video recording.
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
import { STORYBOARD_BEATS, parseTimeRange } from './video/storyboard';
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
  padSynthesizeResult,
  createSilencePcm,
  type SynthesizeResult,
} from './video/tts';
import {
  generateSrt,
  remapTimestamp,
  remapSubtitleCues,
  type SubtitleCue,
} from './video/subtitles';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;
declare const MutationObserver: any;
declare const MouseEvent: any;

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

export interface DemoOptions {
  skipTts: boolean;
  skipBackend: boolean;
  backendUrl: string;
  outputPath: string;
  maxScenes?: number;
  singleScene?: number;
  scenes?: number[];
  model: 'opus' | 'sonnet' | 'haiku';
  thinking: 'low' | 'medium' | 'high' | 'off';
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
  const outputPath =
    outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.resolve(process.cwd(), 'artifacts/yvoke-desktop-demo.mp4');

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
  const masModelIdx = args.indexOf('--mas-model');
  const modelVal =
    modelIdx !== -1
      ? args[modelIdx + 1]
      : masModelIdx !== -1
        ? args[masModelIdx + 1]
        : undefined;
  const model: 'opus' | 'sonnet' | 'haiku' =
    modelVal === 'opus' || modelVal === 'sonnet' || modelVal === 'haiku'
      ? modelVal
      : 'opus';

  const thinkingIdx = args.indexOf('--thinking');
  const thinkingVal = thinkingIdx !== -1 ? args[thinkingIdx + 1] : undefined;
  const thinking: 'low' | 'medium' | 'high' | 'off' =
    thinkingVal === 'low' || thinkingVal === 'medium' || thinkingVal === 'high' || thinkingVal === 'off'
      ? thinkingVal
      : 'low';

  return { skipTts, skipBackend, backendUrl, outputPath, maxScenes, singleScene, scenes, model, thinking };
}

export const SCENE_1_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'welcome',
    narration:
      'Welcome to Yvoke Desktop, the local AI workspace grounded in your enterprise knowledge base.',
  },
  {
    key: 'sidebar',
    narration:
      'On the left, the sidebar organizes your conversation history into clear timeframes,',
  },
  {
    key: 'search',
    narration: 'with instant search across past discussions.',
  },
  {
    key: 'profile',
    narration:
      'Along the bottom, check your active account, with quick access to Settings.',
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
    narration: 'Web Search toggles web access while displaying the allowed domains,',
  },
  {
    key: 'appearance',
    narration: 'Appearance customizes themes and density,',
  },
  {
    key: 'about',
    narration: 'while About lets you verify your credentials and check for updates.',
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

export const SCENE_4_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'ask',
    narration:
      'Here, a consultant asks when the table POLPlaybook was introduced under the getting-started playbook.',
  },
  {
    key: 'catch',
    narration:
      'Yvoke determines that the selected playbook should not be used for this question, and',
  },
  {
    key: 'recommend',
    narration: 'it recommends using the oim-db-history playbook instead.',
  },
  {
    key: 'response',
    narration:
      'Now, we wait for the response as Yvoke queries the database history and streams the answer.',
  },
];

export const SCENE_5_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'ask',
    narration:
      'In this conversation, we explore iterative follow-ups and search hints.',
  },
  {
    key: 'response1',
    narration:
      'Now, we wait for the response as Yvoke queries the manuals and streams the explanation.',
  },
  {
    key: 'citations',
    narration:
      'Notice that every statement that comes from documentation is cited. Clicking a citation link reveals the exact source passage from the manual.',
  },
  {
    key: 'followup',
    narration:
      'Next, we prompt the assistant to search Teams and Confluence knowledge,',
  },
  {
    key: 'response2',
    narration:
      'effortlessly combining official documentation with real-world operational experience as Yvoke completes the answer.',
  },
];

export const SCENE_6_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'ask',
    narration:
      'When an ambiguous query is made, Yvoke surfaces an interactive clarification card to confirm scope.',
  },
  {
    key: 'option',
    narration:
      'Selecting an option narrows the query to the chosen domain, streaming the relevant table and column modifications.',
  },
  {
    key: 'trace',
    narration:
      'Opening the trace reveals the underlying tool calls and database queries executed to retrieve the schema history.',
  },
];

export const SCENE_7_SEGMENTS: { key: string; narration: string }[] = [
  {
    key: 'mode',
    narration:
      'When queries span multiple knowledge areas and rigorous review is essential, Multi-Agent mode coordinates specialized roles.',
  },
  {
    key: 'prompt',
    narration: 'Specialists investigate each connector architecture in parallel,',
  },
  {
    key: 'review',
    narration: 'while an independent Reviewer gate guards against hallucinations',
  },
  {
    key: 'approval',
    narration: 'and approves the synthesized response.',
  },
  {
    key: 'outro',
    narration:
      'Thank you for watching this overview of Yvoke Desktop. Experience grounded, verifiable intelligence across your knowledge base.',
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
  options?: {
    cloneRealThreads?: boolean;
    model?: 'opus' | 'sonnet' | 'haiku';
    thinking?: 'low' | 'medium' | 'high' | 'off';
  },
): string {
  const model = options?.model ?? 'opus';
  const thinkingLevel = options?.thinking ?? 'low';
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-demo-video-'));

  // 1. Settings strictly configured for local dev environment (Streamable HTTP + Dev token)
  const settings = {
    settingsVersion: 1,
    serverAuthMode: 'dev',
    authMode: 'dev',
    serverBaseUrl: backendUrl,
    devToken: 'dev-demo-token',
    mcpTransport: 'http',
    defaultModel: model,
    defaultThinkingLevel: thinkingLevel,
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
        model,
        thinkingLevel,
      },
      reviewer: {
        model,
        thinkingLevel,
      },
      specialist: {
        model,
        thinkingLevel,
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
    const mainEntry = path.resolve(process.cwd(), 'out/main/index.js');
    electronApp = await electron.launch({
      args: [
        mainEntry,
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
    await appPage.evaluate(() => {
      (window as any).__autoCollapseTrace = true;
      let isCollapsing = false;
      const collapse = () => {
        if (!(window as any).__autoCollapseTrace || isCollapsing) return;
        const expandedButtons = document.querySelectorAll('button.trace-bar[aria-expanded="true"]');
        if (expandedButtons.length > 0) {
          isCollapsing = true;
          expandedButtons.forEach((btn: any) => {
            btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            btn?.click?.();
          });
          setTimeout(() => {
            isCollapsing = false;
          }, 30);
        }
      };
      const observer = new MutationObserver(collapse);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-expanded'],
      });
      setInterval(collapse, 100);
    });

    console.log(`\n[4/4] Executing ${totalScenes}-scene choreographies...`);

    const sceneTimings: { startMs: number; endMs: number }[] = [];
    const subtitleCues: SubtitleCue[] = [];
    const accelerationIntervals: AccelerationInterval[] = [];

    const runSceneWithPadding = async (
      sceneIdx: number,
      name: string,
      actionFn: () => Promise<void>,
    ): Promise<void> => {
      console.log(`  Running Scene ${sceneIdx + 1}/${totalScenes}: ${name}`);
      const initialCueCount = subtitleCues.length;
      const sceneStartMs = Date.now() - tVideoStart;
      await actionFn();

      // If this scene used segments, rebuild sceneAudios[sceneIdx] from updated/padded segments
      if (sceneIdx === 0 && scene1SegmentAudios.size > 0) {
        const segs = SCENE_1_SEGMENTS.map((s) => scene1SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[0] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 1 && scene2SegmentAudios.size > 0) {
        const segs = SCENE_2_SEGMENTS.map((s) => scene2SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[1] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 2 && scene3SegmentAudios.size > 0) {
        const segs = SCENE_3_SEGMENTS.map((s) => scene3SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[2] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 3 && scene4SegmentAudios.size > 0) {
        const segs = SCENE_4_SEGMENTS.map((s) => scene4SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[3] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 4 && scene5SegmentAudios.size > 0) {
        const segs = SCENE_5_SEGMENTS.map((s) => scene5SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[4] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 5 && scene6SegmentAudios.size > 0) {
        const segs = SCENE_6_SEGMENTS.map((s) => scene6SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[5] = combineSynthesizeResults(segs);
      } else if (sceneIdx === 6 && scene7SegmentAudios.size > 0) {
        const segs = SCENE_7_SEGMENTS.map((s) => scene7SegmentAudios.get(s.key)).filter(
          Boolean,
        ) as SynthesizeResult[];
        if (segs.length > 0) sceneAudios[6] = combineSynthesizeResults(segs);
      }

      const sceneStartSec = sceneStartMs / 1000;
      const sceneEndSec = (Date.now() - tVideoStart) / 1000;
      const effectiveSceneElapsedSec =
        remapTimestamp(sceneEndSec, accelerationIntervals) -
        remapTimestamp(sceneStartSec, accelerationIntervals);
      const audioDuration = sceneAudios[sceneIdx]?.durationSeconds ?? 0;
      const beat = STORYBOARD_BEATS[sceneIdx];
      const targetDurationSec = beat
        ? parseTimeRange(beat.timeRange).endSec - parseTimeRange(beat.timeRange).startSec
        : 0;
      const minPadding = options.skipTts ? (sceneIdx === 0 ? 5.5 : 4.0) : 0;
      const minRequiredSec = options.skipTts ? targetDurationSec : audioDuration;
      const paddingWaitSec = Math.max(
        minPadding,
        Math.max(0, minRequiredSec - effectiveSceneElapsedSec),
      );

      if (paddingWaitSec > 0) {
        await appPage.waitForTimeout(paddingWaitSec * 1000);
      }

      // Ensure scene audio buffer duration matches total video time spent in this scene
      if (sceneAudios[sceneIdx]) {
        const totalEffectiveSceneTimeSec = effectiveSceneElapsedSec + paddingWaitSec;
        if (totalEffectiveSceneTimeSec > sceneAudios[sceneIdx].durationSeconds) {
          sceneAudios[sceneIdx] = padSynthesizeResult(
            sceneAudios[sceneIdx],
            totalEffectiveSceneTimeSec,
          );
        }
      }

      const sceneEndMs = Date.now() - tVideoStart;
      sceneTimings.push({ startMs: sceneStartMs, endMs: sceneEndMs });
      if (subtitleCues.length === initialCueCount && SCENE_NARRATIONS[sceneIdx]) {
        subtitleCues.push({
          startTimeMs: sceneStartMs,
          endTimeMs: sceneEndMs,
          text: SCENE_NARRATIONS[sceneIdx],
        });
      }
    };

    const runSegment = async (
      segAudioMap: Map<string, SynthesizeResult>,
      key: string,
      defaultDurationSec: number,
      actionFn: () => Promise<void>,
      narrationText?: string,
    ): Promise<void> => {
      const segStartMs = Date.now() - tVideoStart;
      const tStart = Date.now();
      await actionFn();
      const existingAudio = segAudioMap.get(key);
      const segSec = existingAudio?.durationSeconds ?? defaultDurationSec;
      const segStartSec = segStartMs / 1000;
      const segEndSec = (Date.now() - tVideoStart) / 1000;
      const effectiveElapsedSec =
        remapTimestamp(segEndSec, accelerationIntervals) -
        remapTimestamp(segStartSec, accelerationIntervals);
      const remainingSec = segSec - effectiveElapsedSec;
      if (remainingSec > 0) {
        await appPage.waitForTimeout(remainingSec * 1000);
      } else if (existingAudio && effectiveElapsedSec > segSec) {
        // Visual action took longer than spoken narration!
        // Pad the segment audio buffer with silence matching effective video duration
        const padded = padSynthesizeResult(existingAudio, effectiveElapsedSec);
        segAudioMap.set(key, padded);
      }
      const segEndMs = Date.now() - tVideoStart;
      if (narrationText) {
        const speechSec = existingAudio?.durationSeconds ?? defaultDurationSec;
        subtitleCues.push({
          startTimeMs: segStartMs,
          endTimeMs: segStartMs + Math.round(speechSec * 1000),
          text: narrationText,
        });
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

    // =========================================================================
    // Scene 1: App & Sidebar Overview
    // =========================================================================
    if (shouldRunScene(0)) {
      await runSceneWithPadding(0, 'App & Sidebar Overview', async () => {
        // 1. Welcome - Show active live desktop app
        await runSegment(
          scene1SegmentAudios,
          'welcome',
          6.0,
          async () => {
            // App is already displaying an active conversation with full chat view!
            // Smoothly glide mouse across active message response and trace bar
            const traceBar = appPage.locator('.trace-bar, .message').first();
            if ((await traceBar.count()) > 0) {
              await glideMouse(appPage, traceBar, 25, { delayMs: 400 });
            }
          },
          SCENE_1_SEGMENTS[0].narration,
        );

        // 2. Sidebar & Threads
        await runSegment(
          scene1SegmentAudios,
          'sidebar',
          5.3,
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
          SCENE_1_SEGMENTS[1].narration,
        );

        // 3. Instant Search
        await runSegment(
          scene1SegmentAudios,
          'search',
          3.4,
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
          SCENE_1_SEGMENTS[2].narration,
        );

        // 4. Profile & Settings
        await runSegment(
          scene1SegmentAudios,
          'profile',
          5.0,
          async () => {
            const accountChip = appPage
              .locator('.thread-list-footer .account-chip, .account-mode')
              .first();
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
          },
          SCENE_1_SEGMENTS[3].narration,
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
                await glideMouse(appPage, target, 20, { delayMs: 200 });
              }
            }
          }
        };

        // 1. Intro: "Opening Settings reveals full control over your environment."
        await runSegment(
          scene2SegmentAudios,
          'intro',
          3.2,
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
          SCENE_2_SEGMENTS[0].narration,
        );

        // 2. Server: "Under Server, configure backend endpoints, transport, and authentication."
        await runSegment(
          scene2SegmentAudios,
          'server',
          3.5,
          async () => {
            await visitPane('Server', '.settings-field input');
          },
          SCENE_2_SEGMENTS[1].narration,
        );

        // 3. Models: "Models lets you define Claude model versions and default thinking effort."
        await runSegment(
          scene2SegmentAudios,
          'models',
          4.2,
          async () => {
            await visitPane('Models', '.chip-list, .seg');
          },
          SCENE_2_SEGMENTS[2].narration,
        );

        // 4. Agents: "Agents configures multi-agent roles, turns, and automatic playbook validation."
        await runSegment(
          scene2SegmentAudios,
          'agents',
          4.0,
          async () => {
            await visitPane('Agents', '.check-field input, .role-card');
          },
          SCENE_2_SEGMENTS[3].narration,
        );

        // 5. Web search: "Web Search toggles web access while displaying the allowed domains,"
        await runSegment(
          scene2SegmentAudios,
          'webSearch',
          2.8,
          async () => {
            await visitPane('Web search', '.domain-row, .settings-field');
          },
          SCENE_2_SEGMENTS[4].narration,
        );

        // 6. Appearance: "Appearance customizes themes and density,"
        await runSegment(
          scene2SegmentAudios,
          'appearance',
          2.8,
          async () => {
            await visitPane('Appearance', '.theme-choices, .density-choice');
          },
          SCENE_2_SEGMENTS[5].narration,
        );

        // 7. About: "while About lets you verify your credentials and check for updates."
        await runSegment(
          scene2SegmentAudios,
          'about',
          6.0,
          async () => {
            await visitPane('About', '.about-version-row');
            await appPage.waitForTimeout(300);

            // 1. Click Check for Updates and wait for response badge
            const updateBtn = appPage.locator('.check-updates-btn').first();
            if ((await updateBtn.count()) > 0) {
              await glideMouse(appPage, updateBtn, 15, { click: true, delayMs: 200 });
              // Wait for update check to complete and status badge or re-enabled button
              await appPage
                .locator('.about-version-row .cred-badge, .check-updates-btn:not([disabled])')
                .first()
                .waitFor({ state: 'visible', timeout: 6000 })
                .catch(() => {});
              await appPage.waitForTimeout(350);
            }

            // 2. Click Check Credentials and wait for verification response
            const credBtn = appPage.locator('.check-credentials-btn').first();
            if ((await credBtn.count()) > 0) {
              await glideMouse(appPage, credBtn, 15, { click: true, delayMs: 200 });
              // Wait for credential verification to finish and verified badges to appear
              await appPage
                .locator('.check-credentials-btn:not([disabled])')
                .waitFor({ state: 'attached', timeout: 6000 })
                .catch(() => {});
              const verifiedBadges = appPage.locator('.cred-badge.verified').first();
              if ((await verifiedBadges.count()) > 0) {
                await verifiedBadges.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
              }
              // Visual pause: let the viewer clearly see both successful results on screen
              await appPage.waitForTimeout(700);
            }

            // 3. Close Settings and return to main workspace
            const cancelBtn = appPage
              .locator('.dialog-actions button')
              .filter({ hasText: 'Cancel' })
              .first();
            if ((await cancelBtn.count()) > 0) {
              await glideMouse(appPage, cancelBtn, 20, { click: true, delayMs: 200 });
              await appPage
                .locator('.settings-view')
                .waitFor({ state: 'detached', timeout: 3000 })
                .catch(() => {});
              await appPage.waitForTimeout(600);
            }
          },
          SCENE_2_SEGMENTS[6].narration,
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
          3.0,
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
          SCENE_3_SEGMENTS[0].narration,
        );

        // 2. Playbook picker
        await runSegment(
          scene3SegmentAudios,
          'playbooks',
          6.0,
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
          SCENE_3_SEGMENTS[1].narration,
        );

        // 3. Composer
        await runSegment(
          scene3SegmentAudios,
          'composer',
          8.0,
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
                .locator(
                  'select.composer-select[data-tip*="Multi-agent"], select.composer-select[aria-label="Agent mode"]',
                )
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
          SCENE_3_SEGMENTS[2].narration,
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
          6.5,
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
              .locator('button.picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', { hasText: /^oim-getting-started$/ }),
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
          SCENE_4_SEGMENTS[0].narration,
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
                  <button class="primary demo-switch-btn">Switch to Database History</button>
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
          5.0,
          async () => {
            const cardElement = appPage
              .locator('.preflight-card, #demo-preflight-recommendation')
              .first();
            if ((await cardElement.count()) > 0) {
              await glideMouse(appPage, cardElement, 20, { delayMs: 400 });
            }
            await appPage.waitForTimeout(400);
          },
          SCENE_4_SEGMENTS[1].narration,
        );

        // 3. Recommendation & acceptance: cursor clicks "Switch to Database History"
        await runSegment(
          scene4SegmentAudios,
          'recommend',
          4.0,
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
          SCENE_4_SEGMENTS[2].narration,
        );

        // 4. Response waiting & streaming: speak 4.4, wait until response is finished (Send button reappears from Stop)
        await runSegment(
          scene4SegmentAudios,
          'response',
          5.5,
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
          SCENE_4_SEGMENTS[3].narration,
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
          6.0,
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
              .locator('button.picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', { hasText: /^oim-full$/ }),
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
          SCENE_5_SEGMENTS[0].narration,
        );

        // 2. Response 1 Streaming & Waiting for Completion
        await runSegment(
          scene5SegmentAudios,
          'response1',
          7.0,
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
          SCENE_5_SEGMENTS[1].narration,
        );

        // 3. Citations Modal Inspection
        await runSegment(
          scene5SegmentAudios,
          'citations',
          7.0,
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

            // Click close button on the citation modal
            const closeBtn = appPage
              .locator('.citation-overlay .close-btn, .citation-modal-header button, .modal-close')
              .first();
            if ((await closeBtn.count()) > 0) {
              await glideMouse(appPage, closeBtn, 20, { click: true, delayMs: 250 });
            }
            await appPage.evaluate(() => {
              const overlay = document.querySelector('.citation-overlay');
              if (overlay) {
                (overlay.querySelector('.close-btn, button') as any)?.click?.();
                overlay.remove();
              }
            });
            await appPage.waitForTimeout(400);
          },
          SCENE_5_SEGMENTS[2].narration,
        );

        // 4. Follow-up Query with Teams/Confluence Search Hints
        await runSegment(
          scene5SegmentAudios,
          'followup',
          7.5,
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
          SCENE_5_SEGMENTS[3].narration,
        );

        // 5. Response 2 Streaming & Waiting for Completion
        await runSegment(
          scene5SegmentAudios,
          'response2',
          7.0,
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
          SCENE_5_SEGMENTS[4].narration,
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
          9.0,
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
              .locator('button.picker-row')
              .filter({
                has: appPage.locator('.picker-row-title', { hasText: /^oim-db-history$/ }),
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

            // Switch thinking effort to 'low' so Claude reasons concisely with large schema/DB results
            const thinkingSelect = appPage
              .locator(
                'select.composer-select[aria-label="Thinking effort"], select.composer-select[data-tip="Thinking effort"]',
              )
              .first();
            if ((await thinkingSelect.count()) > 0) {
              await glideMouse(appPage, thinkingSelect, 15, { delayMs: 150, optional: true });
              await thinkingSelect.selectOption('low').catch(() => {});
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
          SCENE_6_SEGMENTS[0].narration,
        );

        // 2. Select option and stream answer
        await runSegment(
          scene6SegmentAudios,
          'option',
          14.0,
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
          SCENE_6_SEGMENTS[1].narration,
        );

        // 3. Trace inspection
        await runSegment(
          scene6SegmentAudios,
          'trace',
          12.0,
          async () => {
            // Disable global auto-collapse so the opened trace stays open for viewer inspection
            await appPage.evaluate(() => {
              (window as any).__autoCollapseTrace = false;
            }).catch(() => {});

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
          },
          SCENE_6_SEGMENTS[2].narration,
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
          9.0,
          async () => {
            await startNewConversation();

            const modeSelect = appPage
              .locator('select.composer-select, select[aria-label="Agent mode"]')
              .first();
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
          SCENE_7_SEGMENTS[0].narration,
        );

        // 7.2: Type prompt & dispatch turn
        await runSegment(
          scene7SegmentAudios,
          'prompt',
          11.0,
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
          SCENE_7_SEGMENTS[1].narration,
        );

        // 7.3: Specialist parallel execution & Reviewer gate validation
        await runSegment(
          scene7SegmentAudios,
          'review',
          13.0,
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
          SCENE_7_SEGMENTS[2].narration,
        );

        // 7.4: Reviewer approval & markdown comparison table
        await runSegment(
          scene7SegmentAudios,
          'approval',
          12.0,
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
            const table = appPage.locator('.message.assistant .markdown-body table').last();
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
          SCENE_7_SEGMENTS[3].narration,
        );

        // 7.5: Outro resting glide & conclusion
        await runSegment(
          scene7SegmentAudios,
          'outro',
          10.0,
          async () => {
            // Glide smoothly to center resting position
            await appPage.mouse.move(640, 360, { steps: 25 });
            await appPage.waitForTimeout(1500);
          },
          SCENE_7_SEGMENTS[4].narration,
        );
      });
    }

    // Buffer pause to ensure final scene frames settle and are not truncated
    await appPage.waitForTimeout(1000);

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
      // Prepend initial delay silence so speech matches visual action start
      const initialSilence = createSilencePcm(initialDelaySec);
      // Append 1.0s silence buffer to match the final appPage.waitForTimeout(1000)
      const silenceEnd = createSilencePcm(1.0);
      const activeAudios = (options.scenes
        ? options.scenes.map((s) => sceneAudios[s - 1])
        : SCENE_NARRATIONS.map((_, idx) => (shouldRunScene(idx) ? sceneAudios[idx] : undefined))
      ).filter(Boolean) as SynthesizeResult[];
      const combinedPcm = Buffer.concat([
        initialSilence,
        ...activeAudios.map((a) => a.pcmBuffer),
        silenceEnd,
      ]);
      const combinedWav = pcmToWav(combinedPcm);
      fs.writeFileSync(combinedAudioPath, combinedWav);
    }

    // Generate SRT subtitles from recorded segment/scene cues remapped to accelerated timeline
    const finalSubtitleCues =
      accelerationIntervals.length > 0
        ? remapSubtitleCues(subtitleCues, accelerationIntervals)
        : subtitleCues;
    const srtContent = generateSrt(finalSubtitleCues);
    const srtPath = path.join(recordingsDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, srtContent, 'utf8');

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

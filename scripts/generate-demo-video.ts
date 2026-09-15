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
import { focusOnElement, resetFocus } from './video/camera';
import { injectDemoCursor, glideMouse } from './video/cursor';
import { stitchVideoAndAudio, FfmpegNotFoundError } from './video/stitch';
import { synthesizeSpeech, pcmToWav, type SynthesizeResult } from './video/tts';
import { generateSrt, type SubtitleCue } from './video/subtitles';

// Ambient types for browser-context functions executed inside page.evaluate()
declare const document: any;
declare const window: any;

// Automatically pick up configuration from .env.local or .env if present
for (const envFile of ['.env.local', '.env']) {
  const envPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1];
        let val = match[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

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
      : (process.env.YVOKE_SERVER_URL ?? 'http://127.0.0.1:8000');
  const outIdx = args.indexOf('--output');
  const outputPath =
    outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.resolve(process.cwd(), 'artifacts/yvoke-desktop-demo.mp4');

  return { skipTts, skipBackend, backendUrl, outputPath };
}

export const SCENE_NARRATIONS = [
  // Scene 1 (Part I: Architecture Intro with 3 presentation cards)
  'Welcome to Yvoke Desktop, the native AI assistant built for deep engineering and multi-agent investigation. Choosing the right source scoping is vital: playbooks scope authoritative vendor manuals versus internal incident triage. If unsure, use oim-full. For complex tasks, the Multi-Agent System pairs specialized agents with an Automatic Reviewer gate to prevent hallucinations. Follow proven prompting practices: establish explicit context, provide targeted search hints, and continue conversations iteratively.',

  // Scene 2 (Part II: Live Conversation 1: Playbook Validation Catch)
  'Here, an engineer asks when the table POLPlaybook was introduced under the getting-started playbook. Yvoke immediately catches that table migration history belongs in database records, recommending oim-db-history before dispatching.',

  // Scene 3 (Live Conversation 2: Multi-Turn Follow-Up & Search Hints)
  'In this conversation, we explore iterative follow-ups and search hints. After defining a value template, we prompt the assistant to search Teams and Confluence knowledge, effortlessly combining official documentation with real-world operational experience.',

  // Scene 4 (Live Conversation 3: Clarifying Questions & Citations)
  'When querying complex database schema changes, Yvoke surfaces an interactive clarification card to confirm scope. Selecting an option produces grounded answers with verified citation pills and complete reasoning traces.',

  // Scene 5 (Live Conversation 4: Multi-Agent System MAS)
  'For multi-faceted trade-offs, switching to Multi-Agent mode activates specialized roles. Autonomous specialists query parallel corpuses to compare connector options, while the Reviewer gate validates consistency and approves the response.',

  // Scene 6: Speed, Instant Search (<10ms) & Dark/Light Theme toggle
  'Yvoke delivers sub-ten-millisecond instant search across your entire conversation history, coupled with a responsive, polished UI supporting dark and light themes.',
];

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

export function seedUserData(): string {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-demo-video-'));

  // 1. Settings with full orchestrator and appearance profiles
  const settings = {
    serverAuthMode: 'dev',
    serverBaseUrl: 'http://127.0.0.1:0',
    appearance: {
      theme: 'dark',
      density: 'comfortable',
      answerTextSize: 14,
      traceExpanded: false,
    },
    playbookValidationEnabled: true,
    showPrototypePlaybooks: true,
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

  // 2. Pre-seed threads
  const threadsDir = path.join(userDataDir, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });

  const now = Date.now();
  const threadIndex = {
    'demo-thread-1': {
      id: 'demo-thread-1',
      title: 'POLPlaybook Introduction History',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'medium',
      createdAt: new Date(now - 14400000).toISOString(),
      updatedAt: new Date(now - 10800000).toISOString(),
      totals: {
        inputTokens: 2150,
        outputTokens: 840,
        cacheReadTokens: 4200,
        cacheWriteTokens: 120,
        thoughtTokens: 950,
      },
      syncState: 'synced',
    },
    'demo-thread-2': {
      id: 'demo-thread-2',
      title: 'Value Templates & Search Hints',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'medium',
      createdAt: new Date(now - 7200000).toISOString(),
      updatedAt: new Date(now - 5400000).toISOString(),
      totals: {
        inputTokens: 3820,
        outputTokens: 1420,
        cacheReadTokens: 8400,
        cacheWriteTokens: 320,
        thoughtTokens: 1250,
      },
      syncState: 'synced',
    },
    'demo-thread-3': {
      id: 'demo-thread-3',
      title: 'Database Schema Changes: 9.3.1 to 10.0',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'medium',
      createdAt: new Date(now - 3600000).toISOString(),
      updatedAt: new Date(now - 1800000).toISOString(),
      totals: {
        inputTokens: 4900,
        outputTokens: 1850,
        cacheReadTokens: 12000,
        cacheWriteTokens: 450,
        thoughtTokens: 1800,
      },
      syncState: 'synced',
    },
    'demo-thread-4': {
      id: 'demo-thread-4',
      title: 'Connector Comparison: Standard vs CSV vs PowerShell',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'medium',
      orchestratorProfile: 'oim-mas',
      createdAt: new Date(now - 900000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      totals: {
        inputTokens: 7100,
        outputTokens: 2600,
        cacheReadTokens: 22000,
        cacheWriteTokens: 890,
        thoughtTokens: 3100,
      },
      syncState: 'synced',
    },
  };
  fs.writeFileSync(
    path.join(threadsDir, 'index.json'),
    JSON.stringify(threadIndex, null, 2),
    'utf8',
  );

  // Thread 1 JSONL
  const t1Messages = [
    {
      localId: 'msg-u-1',
      role: 'user',
      content: 'When was the table POLPlaybook introduced?',
      playbook: 'oim-getting-started',
      createdAt: new Date(now - 14400000).toISOString(),
    },
    {
      localId: 'msg-a-1',
      role: 'assistant',
      content:
        'The table `POLPlaybook` was introduced in **OIM version 8.2.0** as part of the unified policy orchestration schema migration [file=oim_db_schema_v8.pdf]. It replaced the legacy `POL_RULES_LEGACY` structure to support multi-tenant role definitions.',
      playbook: 'oim-db-history',
      thinking:
        'Scanning database schema migration logs for POLPlaybook. Located introduction in v8.2 migration scripts under table creation definitions.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'search_corpus',
          input: { query: 'POLPlaybook table introduction version 8.2' },
          result: 'Found migration record: Schema V8.2 introduced POLPlaybook.',
        },
      ],
      usage: {
        inputTokens: 2150,
        outputTokens: 840,
        cacheReadTokens: 4200,
        cacheWriteTokens: 120,
        thoughtTokens: 950,
      },
      createdAt: new Date(now - 14350000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'demo-thread-1.jsonl'),
    t1Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );

  // Thread 2 JSONL
  const t2Messages = [
    {
      localId: 'msg-u-2a',
      role: 'user',
      content: 'what is a value template?',
      playbook: 'oim-getting-started',
      createdAt: new Date(now - 7200000).toISOString(),
    },
    {
      localId: 'msg-a-2a',
      role: 'assistant',
      content:
        'A **Value Template** in One Identity Manager defines dynamic column calculations evaluated automatically upon object insertion or update [file=object_layer_guide.pdf]. Templates are expressed in VB.Net or C# and compile directly into the runtime object layer.',
      playbook: 'oim-getting-started',
      thinking: 'Explaining OIM Value Templates: purpose, evaluation trigger, and language syntax.',
      usage: {
        inputTokens: 1400,
        outputTokens: 420,
        cacheReadTokens: 3000,
        cacheWriteTokens: 100,
        thoughtTokens: 400,
      },
      createdAt: new Date(now - 7150000).toISOString(),
    },
    {
      localId: 'msg-u-2b',
      role: 'user',
      content: 'check if you find any practical info in teams or confluence',
      playbook: 'oim-getting-started',
      createdAt: new Date(now - 5500000).toISOString(),
    },
    {
      localId: 'msg-a-2b',
      role: 'assistant',
      content:
        'Practical operational guidance retrieved from internal Teams and Confluence knowledge bases:\n\n1. **[Teams #oim-dev] Circular Reference Warning:** Chained value templates across foreign key relations can trigger recursion; always guard with `InResult` checks.\n2. **[Confluence Architecture] Overrides Flag:** Complex templates querying external tables should set the `Overrides` attribute to prevent redundant recalculation cycles.\n3. **[Support KB-4412] Bulk Import Null Handling:** Templates on `Person.CentralAccount` must handle null references during CSV bulk onboarding.',
      playbook: 'oim-getting-started',
      thinking:
        'Searching operational corpus (Teams channels and Confluence spaces) for real-world value template gotchas and edge cases.',
      toolCalls: [
        {
          id: 'call-2',
          name: 'search_corpus',
          input: { query: 'value template circular reference overrides teams confluence' },
          result: 'Retrieved 3 matching operational knowledge chunks.',
        },
      ],
      usage: {
        inputTokens: 2420,
        outputTokens: 1000,
        cacheReadTokens: 5400,
        cacheWriteTokens: 220,
        thoughtTokens: 850,
      },
      createdAt: new Date(now - 5400000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'demo-thread-2.jsonl'),
    t2Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );

  // Thread 3 JSONL
  const t3Messages = [
    {
      localId: 'msg-u-3',
      role: 'user',
      content: 'what database changes were done between 9.3.1 and 10.0?',
      playbook: 'oim-db-history',
      createdAt: new Date(now - 3600000).toISOString(),
    },
    {
      localId: 'msg-a-3',
      role: 'assistant',
      content:
        'Major database schema revisions between OIM 9.3.1 and 10.0 for **Identity & Authentication Tables**:\n\n1. **Person Table Migration:** Added `UID_Tenant` and `ExternalIdentityId` columns for multi-forest Entra ID federation [file=oim_v10_release_notes.pdf].\n2. **DialogUser Security:** Upgraded password hashing algorithm to Argon2id and deprecated legacy SHA-256 columns.\n3. **Audit Trails:** Added high-throughput temporal tracking tables with partitioned change logs.',
      playbook: 'oim-db-history',
      thinking:
        'User selected Identity & Authentication Tables. Cross-referencing 9.3.1 and 10.0 schema diffs. Highlighting Person, DialogUser, and audit table changes.',
      toolCalls: [
        {
          id: 'call-clarif-1',
          name: 'AskUserQuestion',
          input: {
            question: 'Which subsystem schema changes would you like to inspect?',
            options: [
              {
                label: 'Identity & Authentication Tables',
                description: 'Changes to Person, DialogUser, and auth tokens',
              },
              {
                label: 'Workflow & Attestation Tables',
                description: 'Changes to PWOHelper, AttestationCase, and Approval policies',
              },
            ],
          },
          result: 'User answered: Identity & Authentication Tables',
        },
        {
          id: 'call-db-diff',
          name: 'search_corpus',
          input: { query: 'database schema diff 9.3.1 10.0 Person DialogUser' },
          result: 'Found 4 matching sections in schema migration documentation.',
        },
      ],
      usage: {
        inputTokens: 4900,
        outputTokens: 1850,
        cacheReadTokens: 12000,
        cacheWriteTokens: 450,
        thoughtTokens: 1800,
      },
      createdAt: new Date(now - 3550000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'demo-thread-3.jsonl'),
    t3Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );

  // Thread 4 JSONL
  const t4Messages = [
    {
      localId: 'msg-u-4',
      role: 'user',
      content: 'compare standard vs csv vs PowerShell connector considering teams/confluence',
      createdAt: new Date(now - 900000).toISOString(),
    },
    {
      localId: 'msg-a-4',
      role: 'assistant',
      content:
        '### Connector Architecture Evaluation & Trade-offs\n\n| Connector Type | Sync Mechanism | Throughput | Flexibility | Operational Fit |\n| :--- | :--- | :--- | :--- | :--- |\n| **Standard DB** | Native DB driver, delta tracking | Very High (<5s/batch) | Schema-bound | Core SQL/Oracle HR systems |\n| **CSV / Flat File** | Scheduled file batch ingest | Moderate (full scan) | Universal format | Legacy batch feeds |\n| **PowerShell** | REST / Graph API scripting | Latency-bound | Unlimited custom logic | Cloud apps (Entra, Slack, Jira) |\n\n#### Operational Insights from Teams & Confluence\n- **PowerShell Connector:** Confluence runbook specifies exponential backoff for HTTP 429 rate limits.\n- **CSV Ingestion:** Teams #oim-ops warns that BOM encoding mismatch can corrupt European character sets.\n\n*All recommendations verified against connector documentation and internal incident logs.*',
      thinking:
        'Orchestrating multi-agent analysis: Delegating standard and CSV evaluation to DB specialist, PowerShell and operational gotchas to Cloud specialist, and submitting synthesized draft to Reviewer for consistency validation.',
      review: {
        outcome: 'approved',
        feedback:
          'Verified: All connector throughput claims and operational caveats from Teams/Confluence are factually accurate.',
        enforced: true,
      },
      toolCalls: [
        {
          id: 'call-mas-1',
          name: 'Agent',
          subagentType: 'specialist',
          input: {
            prompt: 'Analyze standard database connector and CSV synchronization performance',
          },
          result:
            'Standard connector offers change-tracking via delta sync; CSV requires full table re-read.',
        },
        {
          id: 'call-mas-2',
          name: 'Agent',
          subagentType: 'specialist',
          input: {
            prompt:
              'Analyze PowerShell connector flexibility and security considerations from Teams discussions',
          },
          result:
            'PowerShell connector supports custom REST/Graph endpoints but requires strict execution policy signing.',
        },
        {
          id: 'call-mas-3',
          name: 'Agent',
          subagentType: 'reviewer',
          input: { prompt: 'Verify connector architectural trade-offs for consistency' },
          result: 'All connector comparison claims are accurate and properly contextualized.',
          verdict: {
            approved: true,
            feedback:
              'Approved: Factual consistency verified against vendor specs and Teams incidents.',
          },
        },
      ],
      usage: {
        inputTokens: 7100,
        outputTokens: 2600,
        cacheReadTokens: 22000,
        cacheWriteTokens: 890,
        thoughtTokens: 3100,
      },
      createdAt: new Date(now - 850000).toISOString(),
    },
  ];
  fs.writeFileSync(
    path.join(threadsDir, 'demo-thread-4.jsonl'),
    t4Messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
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
  if (!options.skipTts) {
    console.log('\n[1/4] Synthesizing TTS voice narrations via Gemini...');
    for (let i = 0; i < SCENE_NARRATIONS.length; i++) {
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
  const userDataDir = seedUserData();
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

    // Safeguard browser context against esbuild/tsx __name injection & provide fallback prompts
    await appPage.addInitScript(`
      window.__name = window.__name || function(t) { return t; };
      if (window.api) {
        const origListProfiles = window.api.listOrchestratorProfiles;
        window.api.listOrchestratorProfiles = async () => {
          try {
            const res = await origListProfiles();
            if (res && res.length > 0) return res;
          } catch {}
          return [{ name: 'oim-mas', description: 'OIM Multi-Agent System' }];
        };
        const origListPrompts = window.api.listPrompts;
        window.api.listPrompts = async () => {
          try {
            const res = await origListPrompts();
            if (res && res.length > 0) return res;
          } catch {}
          return [
            { name: 'oim-getting-started', title: 'oim-getting-started', description: 'Getting Started' },
            { name: 'oim-db-history', title: 'oim-db-history', description: 'Database History' },
            { name: 'oim-full', title: 'oim-full', description: 'Full OIM Corpus' }
          ];
        };
      }
    `);
    await appPage.evaluate('window.__name = window.__name || function(t) { return t; };');

    // Inject visible demo cursor
    await injectDemoCursor(appPage);

    console.log('\n[4/4] Executing 6-scene choreographies...');

    const sceneTimings: { startMs: number; endMs: number }[] = [];
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

    // =========================================================================
    // Scene 1: Part I: Educational Architecture Intro (3 Cards)
    // =========================================================================
    await runSceneWithPadding(0, 'Architecture Intro (3 Cards)', async () => {
      await injectPresentationOverlay(appPage);

      // Slide 0: Playbooks & Source Scoping
      await showPresentationSlide(appPage, 0);
      const highlight0 = appPage.locator('.yvoke-card-highlight').first();
      if ((await highlight0.count()) > 0) {
        await glideMouse(appPage, highlight0, 20, { delayMs: 200 });
      }
      await appPage.waitForTimeout(2200);

      // Slide 1: Single Agent vs Multi-Agent (OIM MAS)
      await showPresentationSlide(appPage, 1);
      const highlight1 = appPage.locator('.yvoke-card-highlight').first();
      if ((await highlight1.count()) > 0) {
        await glideMouse(appPage, highlight1, 20, { delayMs: 200 });
      }
      await appPage.waitForTimeout(2200);

      // Slide 2: LLM Prompting & Collaboration Best Practices
      await showPresentationSlide(appPage, 2);
      const highlight2 = appPage.locator('.yvoke-card-highlight').first();
      if ((await highlight2.count()) > 0) {
        await glideMouse(appPage, highlight2, 20, { delayMs: 200 });
      }
      await appPage.waitForTimeout(2200);

      await unmountPresentationOverlay(appPage);
      await appPage.waitForTimeout(400);
    });

    // =========================================================================
    // Scene 2: Live Conversation 1 (Playbook Validation Catch)
    // =========================================================================
    await runSceneWithPadding(1, 'Playbook Validation Catch', async () => {
      const thread1 = appPage.locator('.thread-item').filter({ hasText: 'POLPlaybook' }).first();
      if ((await thread1.count()) > 0) {
        await glideMouse(appPage, thread1, 25, { click: true, delayMs: 200 });
      }
      await appPage.waitForTimeout(600);

      // Mount recommendation card
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

      const card = appPage.locator('#demo-preflight-recommendation');
      if ((await card.count()) > 0) {
        await focusOnElement(appPage, card, { zoomFactor: 1.15 });
        const switchBtn = card.locator('.demo-switch-btn');
        await glideMouse(appPage, switchBtn, 20, { click: true, delayMs: 250 });
        await appPage.evaluate(() => document.getElementById('demo-preflight-recommendation')?.remove());
        await resetFocus(appPage);
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 3: Live Conversation 2 (Multi-Turn Follow-Up & Search Hints)
    // =========================================================================
    await runSceneWithPadding(2, 'Multi-Turn Follow-Up & Search Hints', async () => {
      const thread2 = appPage
        .locator('.thread-item')
        .filter({ hasText: 'Value Templates' })
        .first();
      if ((await thread2.count()) > 0) {
        await glideMouse(appPage, thread2, 25, { click: true, delayMs: 200 });
      }
      await appPage.waitForTimeout(600);

      const msgs = appPage.locator('.message');
      if ((await msgs.count()) >= 2) {
        const turn2 = msgs.nth(1);
        await glideMouse(appPage, turn2, 20, { delayMs: 200 });
        const lastAnswer = msgs.last();
        await focusOnElement(appPage, lastAnswer, { zoomFactor: 1.1 });
        await appPage.waitForTimeout(1400);
        await resetFocus(appPage);
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 4: Live Conversation 3 (Clarifying Questions & Citations)
    // =========================================================================
    await runSceneWithPadding(3, 'Clarifying Questions & Citations', async () => {
      const thread3 = appPage
        .locator('.thread-item')
        .filter({ hasText: 'Database Schema Changes' })
        .first();
      if ((await thread3.count()) > 0) {
        await glideMouse(appPage, thread3, 25, { click: true, delayMs: 200 });
      }
      await appPage.waitForTimeout(600);

      const clarifCard = appPage.locator('.clarifying-question-card, .clarified-badge').first();
      if ((await clarifCard.count()) > 0) {
        await focusOnElement(appPage, clarifCard, { zoomFactor: 1.15 });
        await glideMouse(appPage, clarifCard, 20, { delayMs: 300 });
        await resetFocus(appPage);
      }

      // Open citation modal
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

      // Expand TraceBar
      const traceBar = appPage.locator('.trace-bar').first();
      if ((await traceBar.count()) > 0) {
        await glideMouse(appPage, traceBar, 20, { click: true, delayMs: 200 });
        await appPage.waitForTimeout(400);
      }
      await appPage.waitForTimeout(600);
    });

    // =========================================================================
    // Scene 5: Live Conversation 4 (Multi-Agent System MAS)
    // =========================================================================
    await runSceneWithPadding(4, 'Multi-Agent System MAS', async () => {
      const thread4 = appPage
        .locator('.thread-item')
        .filter({ hasText: 'Connector Comparison' })
        .first();
      if ((await thread4.count()) > 0) {
        await glideMouse(appPage, thread4, 25, { click: true, delayMs: 200 });
      }
      await appPage.waitForTimeout(600);

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
    // Scene 6: Speed, Instant Search (<10ms) & Dark/Light Theme Toggle
    // =========================================================================
    await runSceneWithPadding(5, 'Instant Search & Theme Toggle', async () => {
      const searchInput = appPage
        .locator('.thread-search input, input[placeholder*="Search"]')
        .first();
      if ((await searchInput.count()) > 0) {
        await glideMouse(appPage, searchInput, 20, { click: true, delayMs: 150 });
        await searchInput.fill('POLPlaybook');
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
      const assetsDir = path.resolve(process.cwd(), 'scripts/video/assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      const synthWavPath = path.join(assetsDir, 'ambient.wav');
      if (!fs.existsSync(synthWavPath)) {
        fs.writeFileSync(synthWavPath, createProceduralAmbientWav(180));
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

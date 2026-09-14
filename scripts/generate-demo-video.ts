/**
 * Orchestrator runner for automated Yvoke demo video generation.
 *
 * Automates:
 * 1. Preflight checks for build artifacts and API key.
 * 2. Pre-seeding a temporary isolated userDataDir with rich conversation (LaTeX, Citations, TraceBar).
 * 3. Headed Playwright Electron launch at 1280x860 with video recording.
 * 4. 4-scene choreography with visual cursor injection and dynamic audio padding.
 * 5. Resilient teardown with 5s SIGKILL fallback and signal traps.
 * 6. Audio synthesis via Gemini TTS and MP4 transcoding via FFmpeg.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { synthesizeSpeech, pcmToWav, type SynthesizeResult } from './video/tts';
import { injectDemoCursor, glideMouse } from './video/cursor';
import { stitchVideoAndAudio, FfmpegNotFoundError } from './video/stitch';

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

interface DemoOptions {
  skipTts: boolean;
  outputPath: string;
}

function parseArgs(): DemoOptions {
  const args = process.argv.slice(2);
  const skipTts = args.includes('--skip-tts');
  const outIdx = args.indexOf('--output');
  const outputPath =
    outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.resolve(process.cwd(), 'artifacts/yvoke-desktop-demo.mp4');

  return { skipTts, outputPath };
}

function runPreflightChecks(skipTts: boolean): void {
  const mainEntry = path.resolve(process.cwd(), 'out/main/index.js');
  if (!fs.existsSync(mainEntry)) {
    console.error(
      'Error: Build artifacts missing (out/main/index.js not found).\nPlease run "npm run build" first before recording demo video.',
    );
    process.exit(1);
  }

  const hasValidKey =
    !!process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';

  if (!skipTts && !hasValidKey) {
    console.error(
      'Error: GEMINI_API_KEY is required for voice narration.\nPlease add your key to .env (or export GEMINI_API_KEY), or pass --skip-tts to record video without audio.',
    );
    process.exit(1);
  }
}

function seedUserData(): string {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-demo-video-'));

  // 1. Settings with loopback containment
  const settings = {
    serverAuthMode: 'dev',
    serverBaseUrl: 'http://127.0.0.1:0',
    appearance: {
      theme: 'dark',
      density: 'comfortable',
      answerTextSize: 14,
      traceExpanded: false,
    },
  };
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
    'utf8',
  );

  // 2. Rich thread with LaTeX, citations, and TraceBar tool evidence
  const threadsDir = path.join(userDataDir, 'threads');
  fs.mkdirSync(threadsDir, { recursive: true });

  const threadIndex = {
    'demo-thread-1': {
      id: 'demo-thread-1',
      title: 'Quantum Error Correction & Surface Codes',
      model: 'claude-3-7-sonnet-20250219',
      thinkingLevel: 'high',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date().toISOString(),
      totals: {
        inputTokens: 3420,
        outputTokens: 1680,
        cacheReadTokens: 14200,
        cacheWriteTokens: 520,
        thoughtTokens: 2450,
      },
      syncState: 'synced',
    },
  };
  fs.writeFileSync(
    path.join(threadsDir, 'index.json'),
    JSON.stringify(threadIndex, null, 2),
    'utf8',
  );

  const userMessage = {
    localId: 'msg-user-1',
    role: 'user',
    content:
      'Can you analyze the threshold theorem for 2D surface codes and explain syndrome extraction with stabilizer measurements?',
    createdAt: new Date(Date.now() - 3500000).toISOString(),
  };

  const assistantMessage = {
    localId: 'msg-assistant-1',
    role: 'assistant',
    content: `### Surface Code Threshold & Syndrome Extraction

Surface codes are a leading architecture for fault-tolerant quantum computation on a 2D planar lattice [file=qec_intro.pdf].

#### The Fault-Tolerant Threshold
Under circuit-level depolarizing noise, the logical error rate $P_L$ scales exponentially with code distance $d$:

$$P_L \\approx A \\left(\\frac{p}{p_{\\text{th}}}\\right)^{\\frac{d+1}{2}}$$

where $p_{\\text{th}} \\approx 1.1\\%$ denotes the fault-tolerant threshold [file=threshold_bounds.md].

#### Stabilizer Measurements
Syndrome extraction performs repeated stabilizer checks to detect error chains:
- **Star operators ($X$-stabilizers):** $A_s = \\prod_{j \\in \\text{star}(s)} X_j$
- **Plaquette operators ($Z$-stabilizers):** $B_p = \\prod_{j \\in \\text{boundary}(p)} Z_j$

Endpoints of error strings form defects matched via minimum-weight perfect matching (MWPM).`,
    thinking:
      'Analyzing the 2D planar surface code stabilizer cycle. First reference the circuit-level fault tolerance threshold equation. Highlight the distinction between star (X) and plaquette (Z) operators, and explain decoding via minimum-weight perfect matching.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'search_corpus',
        input: { query: 'surface code threshold stabilizer extraction' },
        result: 'Found 4 matching sections in physics corpus (qec_intro.pdf, threshold_bounds.md).',
      },
      {
        id: 'call-2',
        name: 'read_document_chunk',
        input: { file: 'threshold_bounds.md', chunkIndex: 2 },
        result: 'Circuit-level threshold p_th = 1.05% with MWPM decoder on square lattice.',
      },
    ],
    usage: {
      inputTokens: 3420,
      outputTokens: 1680,
      cacheReadTokens: 14200,
      cacheWriteTokens: 520,
      thoughtTokens: 2450,
    },
    createdAt: new Date(Date.now() - 3400000).toISOString(),
  };

  const jsonlContent = `${JSON.stringify(userMessage)}\n${JSON.stringify(assistantMessage)}\n`;
  fs.writeFileSync(path.join(threadsDir, 'demo-thread-1.jsonl'), jsonlContent, 'utf8');

  return userDataDir;
}

const SCENE_NARRATIONS = [
  // Scene 1
  'Welcome to Yvoke Desktop, the native AI assistant built for deep engineering and multi-agent investigation.',
  // Scene 2
  'Every turn captures full execution evidence. Expand the Trace Bar to inspect reasoning steps, corpus queries, and live token usage.',
  // Scene 3
  'Complex answers render beautifully with full LaTeX mathematics and verified source citations embedded directly in the text.',
  // Scene 4
  'Fast, private, and customizable, Yvoke brings powerful AI workflows right to your desktop.',
];

async function closeAppResilient(
  electronApp: ElectronApplication | null,
  userDataDir: string,
): Promise<void> {
  if (electronApp) {
    try {
      await electronApp.evaluate(({ app }) => {
        app.quit();
      }).catch(() => {});

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
  runPreflightChecks(options.skipTts);

  console.log('--- Yvoke Demo Video Orchestrator ---');
  console.log(`Mode: ${options.skipTts ? 'Video Only (--skip-tts)' : 'Full (Voice + Video)'}`);
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
    console.log(signal ? `\nSignal ${signal} received. Terminating...` : '\nClosing application...');
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
    console.log('\n[3/4] Launching Electron in headed recording mode (1280x860)...');
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
        size: { width: 1280, height: 860 },
      },
    });

    const appPage: Page = await electronApp.firstWindow();

    // Set exact window size
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1280, 860);
        win.center();
      }
    });

    // Wait for app ready
    const loading = appPage.locator('.app-loading');
    if ((await loading.count()) > 0) {
      await loading.waitFor({ state: 'detached', timeout: 15000 });
    }
    await appPage.waitForLoadState('domcontentloaded');
    await appPage.waitForTimeout(500);

    // Safeguard browser context against esbuild/tsx __name injection
    await appPage.addInitScript('window.__name = window.__name || function(t) { return t; };');
    await appPage.evaluate('window.__name = window.__name || function(t) { return t; };');

    // Inject visible demo cursor
    await injectDemoCursor(appPage);

    console.log('\n[4/4] Executing 4-scene choreographies...');

    // Helper for scene timing and dynamic padding
    const runSceneWithPadding = async (
      sceneIdx: number,
      name: string,
      actionFn: () => Promise<void>,
    ): Promise<void> => {
      console.log(`  Running Scene ${sceneIdx + 1}: ${name}`);
      const t0 = Date.now();
      await actionFn();
      const actionElapsedSec = (Date.now() - t0) / 1000;
      const audioDuration = sceneAudios[sceneIdx]?.durationSeconds ?? 0;
      const minPadding = options.skipTts ? (sceneIdx === 0 ? 3.5 : 2.8) : 0;
      const paddingWaitSec = Math.max(minPadding, Math.max(0, audioDuration - actionElapsedSec));

      if (paddingWaitSec > 0) {
        await appPage.waitForTimeout(paddingWaitSec * 1000);
      }
    };

    // Scene 1: App Launch & Thread Selection
    await runSceneWithPadding(0, 'Overview & Thread Selection', async () => {
      const threadLocator = appPage.locator('.thread-item').first();
      if ((await threadLocator.count()) > 0) {
        await glideMouse(appPage, threadLocator, 25, { click: true, delayMs: 200 });
      }
      await appPage.waitForTimeout(600);
    });

    // Scene 2: TraceBar & Multi-Step Reasoning
    await runSceneWithPadding(1, 'TraceBar & Reasoning Inspection', async () => {
      const traceBar = appPage.locator('.trace-bar').first();
      if ((await traceBar.count()) > 0) {
        await glideMouse(appPage, traceBar, 25, { click: true, delayMs: 300 });
        await appPage.waitForTimeout(400);

        const firstStep = appPage.locator('.trace-step').first();
        if ((await firstStep.count()) > 0) {
          await glideMouse(appPage, firstStep, 20, { click: true, delayMs: 200 });
        }
      }
      await appPage.waitForTimeout(600);
    });

    // Scene 3: LaTeX Math & Citations
    await runSceneWithPadding(2, 'LaTeX Math & Citations', async () => {
      const katexBlock = appPage.locator('.katex-display').first();
      if ((await katexBlock.count()) > 0) {
        await glideMouse(appPage, katexBlock, 25, { delayMs: 300 });
      }

      const citationLink = appPage.locator('.citation-link').first();
      if ((await citationLink.count()) > 0) {
        await glideMouse(appPage, citationLink, 25, { delayMs: 400 });
      }
      await appPage.waitForTimeout(600);
    });

    // Scene 4: Native Experience & Settings Overview
    await runSceneWithPadding(3, 'Native Polish & Settings Overview', async () => {
      const settingsBtn = appPage.locator('button[data-tip="Settings"], .settings-button').first();
      if ((await settingsBtn.count()) > 0) {
        await glideMouse(appPage, settingsBtn, 25, { delayMs: 400 });
      }
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

    // Multiplex and stitch video with audio
    let combinedAudioPath: string | undefined;
    if (!options.skipTts && sceneAudios.length > 0) {
      combinedAudioPath = path.join(recordingsDir, 'narration.wav');
      const combinedPcm = Buffer.concat(sceneAudios.map((a) => a.pcmBuffer));
      const combinedWav = pcmToWav(combinedPcm);
      fs.writeFileSync(combinedAudioPath, combinedWav);
    }

    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });

    console.log(`Stitching output with universal MP4 flags to ${options.outputPath}...`);
    try {
      await stitchVideoAndAudio({
        videoPath: recordedVideoPath,
        audioPath: combinedAudioPath,
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
        console.warn('You can open and view the .webm video directly in Chrome, Edge, Safari, or VLC.');
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

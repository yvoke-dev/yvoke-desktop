/**
 * Independent Multi-Scene Video Recording and Stitching Pipeline.
 *
 * Runs each scene (1 to 7) in its own completely fresh, isolated Electron process.
 * Then calculates precise time offsets, merges subtitles (.srt), and losslessly
 * concatenates all scenes into the final deliverable MP4 via FFmpeg concat demuxer.
 *
 * Usage:
 *   npx tsx scripts/record-all-scenes-independently.ts [--output artifacts/yvoke-desktop-demo-1.mp4]
 *   npx tsx scripts/record-all-scenes-independently.ts --scenes 1,2,3,4,5,6,7
 *   npx tsx scripts/record-all-scenes-independently.ts --reuse-existing
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  concatVideos,
  getVideoDurationSec,
  mergeSrtContents,
} from './video/batchMerge';

interface PipelineOptions {
  scenes: number[];
  outputPath: string;
  backendUrl: string;
  skipBackend: boolean;
  reuseExisting: boolean;
}

export function parsePipelineArgs(
  rawArgs: string[] = process.argv.slice(2),
): PipelineOptions {
  const args = rawArgs;
  const outIdx = args.indexOf('--output');
  const outputPath =
    outIdx !== -1 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1])
      : path.resolve(process.cwd(), 'artifacts/yvoke-desktop-demo-1.mp4');

  const backendIdx = args.indexOf('--backend-url');
  const backendUrl =
    backendIdx !== -1 && args[backendIdx + 1]
      ? args[backendIdx + 1]
      : (process.env.YVOKE_SERVER ?? process.env.YVOKE_SERVER_URL ?? 'http://localhost:8080');

  const skipBackend = args.includes('--skip-backend') || args.includes('--offline');
  const reuseExisting = args.includes('--reuse-existing');

  let scenes: number[] = [1, 2, 3, 4, 5, 6, 7];
  const scenesIdx = args.indexOf('--scenes');
  const startIdx = args.indexOf('--start');
  const endIdx = args.indexOf('--end');

  if (scenesIdx !== -1 && args[scenesIdx + 1]) {
    scenes = args[scenesIdx + 1]
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 7);
  } else if (startIdx !== -1 || endIdx !== -1) {
    const start = startIdx !== -1 ? parseInt(args[startIdx + 1], 10) : 1;
    const end = endIdx !== -1 ? parseInt(args[endIdx + 1], 10) : 7;
    scenes = [];
    for (let i = start; i <= end; i++) {
      if (i >= 1 && i <= 7) scenes.push(i);
    }
  }

  return { scenes, outputPath, backendUrl, skipBackend, reuseExisting };
}

function runCommandInherit(
  cmd: string,
  args: string[],
  prefix: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> [${prefix}] Starting: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env },
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      console.log(`<<< [${prefix}] Exited with code ${code}`);
      resolve(code ?? 0);
    });
  });
}

export async function runIndependentRecordingPipeline(
  options: PipelineOptions = parsePipelineArgs(),
): Promise<void> {
  console.log('========================================================');
  console.log('  Yvoke Desktop - Independent Scene Recording Pipeline');
  console.log('========================================================');
  console.log(`Target Output:  ${options.outputPath}`);
  console.log(`Scenes to run:  ${options.scenes.join(', ')}`);
  console.log(`Backend URL:    ${options.backendUrl}`);
  console.log(`Reuse existing: ${options.reuseExisting}`);
  console.log('========================================================\n');

  const artifactsDir = path.dirname(options.outputPath);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const sceneVideoPaths: { scene: number; videoPath: string; srtPath: string }[] = [];

  for (const sceneNum of options.scenes) {
    const sceneVideoPath = path.join(artifactsDir, `scene${sceneNum}-demo.mp4`);
    const sceneSrtPath = path.join(artifactsDir, `scene${sceneNum}-demo.srt`);

    if (
      options.reuseExisting &&
      fs.existsSync(sceneVideoPath) &&
      fs.statSync(sceneVideoPath).size > 10000
    ) {
      console.log(
        `[Scene ${sceneNum}] Existing video found (${(fs.statSync(sceneVideoPath).size / 1024 / 1024).toFixed(2)} MB), reusing (--reuse-existing).`,
      );
      sceneVideoPaths.push({
        scene: sceneNum,
        videoPath: sceneVideoPath,
        srtPath: sceneSrtPath,
      });
      continue;
    }

    const generatorScript = path.resolve(process.cwd(), 'scripts/generate-demo-video.ts');
    const childArgs = [
      'tsx',
      generatorScript,
      '--scene',
      String(sceneNum),
      '--output',
      sceneVideoPath,
      '--backend-url',
      options.backendUrl,
    ];
    if (options.skipBackend) {
      childArgs.push('--skip-backend');
    }

    const code = await runCommandInherit('npx', childArgs, `Scene ${sceneNum}`);
    if (code !== 0) {
      throw new Error(`Scene ${sceneNum} recording failed with exit code ${code}`);
    }

    if (!fs.existsSync(sceneVideoPath) || fs.statSync(sceneVideoPath).size === 0) {
      throw new Error(`Scene ${sceneNum} video was not created at: ${sceneVideoPath}`);
    }

    console.log(
      `✓ [Scene ${sceneNum}] Recorded successfully: ${sceneVideoPath} (${(fs.statSync(sceneVideoPath).size / 1024 / 1024).toFixed(2)} MB)\n`,
    );

    sceneVideoPaths.push({
      scene: sceneNum,
      videoPath: sceneVideoPath,
      srtPath: sceneSrtPath,
    });
  }

  // Phase 2: Compute exact durations and merge subtitles
  console.log('\n--------------------------------------------------------');
  console.log('  Merging Scenes & Subtitles...');
  console.log('--------------------------------------------------------');

  const srtSections: { srtContent: string; offsetSec: number }[] = [];
  let cumulativeOffsetSec = 0;
  const orderedVideoPaths: string[] = [];

  for (const item of sceneVideoPaths) {
    orderedVideoPaths.push(item.videoPath);
    const durationSec = await getVideoDurationSec(item.videoPath);
    console.log(
      `  Scene ${item.scene}: duration = ${durationSec.toFixed(3)}s | time offset = ${cumulativeOffsetSec.toFixed(3)}s`,
    );

    let srtContent = '';
    if (fs.existsSync(item.srtPath)) {
      srtContent = fs.readFileSync(item.srtPath, 'utf8');
    }

    srtSections.push({
      srtContent,
      offsetSec: cumulativeOffsetSec,
    });

    cumulativeOffsetSec += durationSec;
  }

  console.log(
    `\nTotal concatenated duration: ${cumulativeOffsetSec.toFixed(2)}s (~${(cumulativeOffsetSec / 60).toFixed(2)} min)`,
  );

  // Write merged SRT
  const mergedSrtContent = mergeSrtContents(srtSections);
  const finalSrtPath = options.outputPath.replace(/\.mp4$/, '.srt');
  fs.writeFileSync(finalSrtPath, mergedSrtContent, 'utf8');
  console.log(`✓ Merged subtitles written to: ${finalSrtPath}`);

  // Concat all MP4 files
  console.log(`\nConcatenating ${orderedVideoPaths.length} scene videos into: ${options.outputPath}...`);
  await concatVideos(orderedVideoPaths, options.outputPath);

  const finalSizeBytes = fs.statSync(options.outputPath).size;
  console.log('========================================================');
  console.log('  Demo Video Production COMPLETE!');
  console.log('========================================================');
  console.log(`Output Video:     ${options.outputPath}`);
  console.log(`Output Subtitles: ${finalSrtPath}`);
  console.log(`File Size:        ${(finalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Total Duration:   ${cumulativeOffsetSec.toFixed(2)}s`);
  console.log('========================================================\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndependentRecordingPipeline().catch((err) => {
    console.error('\n❌ Fatal error in independent recording pipeline:', err);
    process.exit(1);
  });
}

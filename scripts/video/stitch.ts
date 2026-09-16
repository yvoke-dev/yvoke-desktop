/**
 * Video and Audio Stitching pipeline using FFmpeg.
 * Concurrently multiplexes recorded Playwright video streams with Gemini TTS audio,
 * optional background music, and subtitles
 * using universal web/desktop MP4 flags (-pix_fmt yuv420p, -c:v libx264, -movflags +faststart).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { escapeFfmpegSubtitlePath } from './subtitles';

export class FfmpegNotFoundError extends Error {
  constructor(
    message = 'FFmpeg is required to process and stitch demo videos, but was not found in PATH. Please install it using "brew install ffmpeg" (macOS) or refer to https://ffmpeg.org/download.html.',
  ) {
    super(message);
    this.name = 'FfmpegNotFoundError';
  }
}

export class FfmpegExecutionError extends Error {
  public stderr: string;
  public code?: number;

  constructor(message: string, stderr: string, code?: number) {
    super(message);
    this.name = 'FfmpegExecutionError';
    this.stderr = stderr;
    this.code = code;
  }
}

export type RunnerFn = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Default child process runner using Node spawn.
 */
export async function defaultSpawnRunner(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Checks whether ffmpeg is available in PATH.
 */
export async function checkFfmpegInstalled(runner: RunnerFn = defaultSpawnRunner): Promise<boolean> {
  try {
    const res = await runner('ffmpeg', ['-version']);
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Checks whether an FFmpeg filter is available in the current FFmpeg build.
 * Fails open (returns true) if -filters cannot be queried or returns empty stdout
 * so mock test runners and restricted environments can still proceed.
 */
export async function checkFfmpegFilter(
  filterName: string,
  runner: RunnerFn = defaultSpawnRunner,
): Promise<boolean> {
  try {
    const res = await runner('ffmpeg', ['-filters']);
    if (res.code !== 0 || !res.stdout || !res.stdout.trim()) {
      return true; // fail open
    }
    return new RegExp(`^\\s*\\S+\\s+${filterName}\\b`, 'm').test(res.stdout);
  } catch {
    return true; // fail open
  }
}

export function isSubtitlesError(stderr: string): boolean {
  return (
    stderr.includes("No such filter: 'subtitles'") ||
    stderr.includes("Error parsing filterchain 'subtitles=") ||
    (stderr.includes('subtitles') &&
      (stderr.includes('No option name near') ||
        stderr.includes('Error parsing a filter description') ||
        stderr.includes('Error opening output files')))
  );
}

export function isSidechainError(stderr: string): boolean {
  return (
    stderr.includes("No such filter: 'sidechaincompress'") ||
    stderr.includes("Error parsing filterchain 'sidechaincompress") ||
    (stderr.includes('sidechaincompress') && stderr.includes('No option name near'))
  );
}

/**
 * Escapes file path for FFmpeg concat demuxer format: file 'path'
 */
export function escapeConcatPath(filePath: string): string {
  const escaped = filePath.replace(/'/g, "'\\''");
  return `file '${escaped}'`;
}

/**
 * Generates the contents of a concat demuxer file for FFmpeg.
 */
export function generateConcatDemuxer(filePaths: string[]): string {
  return filePaths.map(escapeConcatPath).join('\n');
}

export interface StitchOptions {
  videoPath: string | string[];
  audioPath?: string | null;
  backgroundMusicPath?: string | null;
  subtitlesPath?: string | null;
  enableDucking?: boolean;
  duckingDb?: number; // default -14
  outputPath: string;
  skipTts?: boolean;
  runner?: RunnerFn;
}

/**
 * Stitches recorded video with optional TTS audio narration into a universally playable MP4.
 */
export async function stitchVideoAndAudio(options: StitchOptions): Promise<void> {
  // Preflight checks: audioPath and backgroundMusicPath
  const hasAudio = !options.skipTts && !!options.audioPath;
  if (hasAudio && options.audioPath) {
    if (!fs.existsSync(options.audioPath)) {
      throw new Error(`Audio file does not exist: ${options.audioPath}`);
    }
    const stat = fs.statSync(options.audioPath);
    if (stat.size === 0) {
      throw new Error(`Audio file is empty (0 bytes): ${options.audioPath}`);
    }
  }

  const hasBgMusic = !!options.backgroundMusicPath;
  if (hasBgMusic && options.backgroundMusicPath) {
    if (!fs.existsSync(options.backgroundMusicPath)) {
      throw new Error(`Background music file does not exist: ${options.backgroundMusicPath}`);
    }
    const stat = fs.statSync(options.backgroundMusicPath);
    if (stat.size === 0) {
      throw new Error(`Background music file is empty (0 bytes): ${options.backgroundMusicPath}`);
    }
  }

  let currentSubtitlesPath = options.subtitlesPath;
  if (options.subtitlesPath) {
    if (!fs.existsSync(options.subtitlesPath)) {
      throw new Error(`Subtitles file does not exist: ${options.subtitlesPath}`);
    }
    const stat = fs.statSync(options.subtitlesPath);
    if (stat.size === 0) {
      console.warn(
        `Warning: Subtitles file is empty (0 bytes): ${options.subtitlesPath}. Skipping subtitle burning.`,
      );
      currentSubtitlesPath = null;
    }
  }

  const runner = options.runner ?? defaultSpawnRunner;

  const isInstalled = await checkFfmpegInstalled(runner);
  if (!isInstalled) {
    throw new FfmpegNotFoundError();
  }

  // Smoothly map duckingDb (e.g. -14 dB) to sidechain compression ratio (typically 2:1 to 20:1)
  const duckRatio = options.duckingDb
    ? Math.max(2, Math.min(20, Math.round(Math.abs(options.duckingDb) / 2.3)))
    : 6;

  let tempDemuxerFile: string | undefined;
  let currentEnableDucking = options.enableDucking !== false;

  try {
    while (true) {
      const args: string[] = ['-y'];

      // Video input (Input 0: [0:v])
      if (Array.isArray(options.videoPath)) {
        if (options.videoPath.length === 1) {
          args.push('-i', options.videoPath[0]);
        } else {
          if (!tempDemuxerFile) {
            tempDemuxerFile = path.join(
              path.dirname(options.outputPath),
              `concat-${Date.now()}.txt`,
            );
            fs.writeFileSync(tempDemuxerFile, generateConcatDemuxer(options.videoPath), 'utf8');
          }
          args.push('-f', 'concat', '-safe', '0', '-i', tempDemuxerFile);
        }
      } else {
        args.push('-i', options.videoPath);
      }

      // Audio inputs & filter complex
      if (hasAudio && options.audioPath && hasBgMusic && options.backgroundMusicPath) {
        args.push('-i', options.audioPath);
        args.push('-i', options.backgroundMusicPath);

        if (currentEnableDucking) {
          args.push(
            '-filter_complex',
            `[1:a]asplit[sc][voice];[2:a][sc]sidechaincompress=threshold=0.05:ratio=${duckRatio}:attack=20:release=300[bg];[voice][bg]amix=inputs=2:duration=longest:dropout_transition=2[aout]`,
          );
        } else {
          args.push(
            '-filter_complex',
            '[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]',
          );
        }
        args.push('-map', '0:v', '-map', '[aout]');
      } else if (hasAudio && options.audioPath) {
        args.push('-i', options.audioPath);
      } else if (hasBgMusic && options.backgroundMusicPath) {
        args.push('-i', options.backgroundMusicPath);
      }

      // Subtitles burning
      if (currentSubtitlesPath) {
        const escaped = escapeFfmpegSubtitlePath(currentSubtitlesPath);
        args.push('-vf', `subtitles='${escaped}'`);
      }

      // Universal MP4 flags
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');

      // Audio encoding flags
      if (hasAudio || hasBgMusic) {
        args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
      }

      args.push(options.outputPath);

      let result: { code: number; stdout: string; stderr: string };
      try {
        result = await runner('ffmpeg', args);
      } catch (err: any) {
        if (err instanceof FfmpegNotFoundError || err instanceof FfmpegExecutionError) {
          throw err;
        }
        const errText = (err.stderr || err.message || '') as string;
        if (currentSubtitlesPath && isSubtitlesError(errText)) {
          console.warn("Warning: FFmpeg filter 'subtitles' not found or failed. Retrying stitch without subtitles.");
          currentSubtitlesPath = null;
          continue;
        }
        if (currentEnableDucking && isSidechainError(errText)) {
          console.warn("Warning: FFmpeg filter 'sidechaincompress' not found. Retrying stitch with simple amix without ducking.");
          currentEnableDucking = false;
          continue;
        }
        throw err;
      }

      if (result.code !== 0) {
        if (currentSubtitlesPath && isSubtitlesError(result.stderr)) {
          console.warn("Warning: FFmpeg filter 'subtitles' not found or failed. Retrying stitch without subtitles.");
          currentSubtitlesPath = null;
          continue;
        }
        if (currentEnableDucking && isSidechainError(result.stderr)) {
          console.warn("Warning: FFmpeg filter 'sidechaincompress' not found. Retrying stitch with simple amix without ducking.");
          currentEnableDucking = false;
          continue;
        }
        throw new FfmpegExecutionError(
          `FFmpeg exited with non-zero code ${result.code}: ${result.stderr}`,
          result.stderr,
          result.code,
        );
      }

      // Successfully finished
      break;
    }
  } finally {
    if (tempDemuxerFile && fs.existsSync(tempDemuxerFile)) {
      try {
        fs.unlinkSync(tempDemuxerFile);
      } catch {
        // Best effort cleanup
      }
    }
  }
}

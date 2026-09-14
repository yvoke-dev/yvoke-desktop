/**
 * Video and Audio Stitching pipeline using FFmpeg.
 * Concurrently multiplexes recorded Playwright video streams with Gemini TTS audio
 * using universal web/desktop MP4 flags (-pix_fmt yuv420p, -c:v libx264, -movflags +faststart).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  outputPath: string;
  skipTts?: boolean;
  runner?: RunnerFn;
}

/**
 * Stitches recorded video with optional TTS audio narration into a universally playable MP4.
 */
export async function stitchVideoAndAudio(options: StitchOptions): Promise<void> {
  const runner = options.runner ?? defaultSpawnRunner;

  const isInstalled = await checkFfmpegInstalled(runner);
  if (!isInstalled) {
    throw new FfmpegNotFoundError();
  }

  const args: string[] = ['-y'];
  let tempDemuxerFile: string | undefined;

  try {
    if (Array.isArray(options.videoPath)) {
      if (options.videoPath.length === 1) {
        args.push('-i', options.videoPath[0]);
      } else {
        tempDemuxerFile = path.join(
          path.dirname(options.outputPath),
          `concat-${Date.now()}.txt`,
        );
        fs.writeFileSync(tempDemuxerFile, generateConcatDemuxer(options.videoPath), 'utf8');
        args.push('-f', 'concat', '-safe', '0', '-i', tempDemuxerFile);
      }
    } else {
      args.push('-i', options.videoPath);
    }

    const hasAudio = !options.skipTts && !!options.audioPath;
    if (hasAudio && options.audioPath) {
      args.push('-i', options.audioPath);
    }

    // Video encoding flags
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');

    // Audio encoding flags
    if (hasAudio) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    }

    args.push(options.outputPath);

    const result = await runner('ffmpeg', args);
    if (result.code !== 0) {
      throw new FfmpegExecutionError(
        `FFmpeg exited with non-zero code ${result.code}: ${result.stderr}`,
        result.stderr,
        result.code,
      );
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

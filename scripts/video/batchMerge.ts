import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateSrt, type SubtitleCue } from './subtitles';

const execFileAsync = promisify(execFile);

/**
 * Parses an SRT timestamp HH:MM:SS,mmm into milliseconds.
 */
export function parseSrtTimestampToMs(timestamp: string): number {
  const match = timestamp.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const millis = parseInt(match[4], 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

/**
 * Parses an SRT formatted string into structured subtitle cues.
 */
export function parseSrt(srtContent: string): SubtitleCue[] {
  if (!srtContent || !srtContent.trim()) return [];

  const blocks = srtContent.trim().split(/\r?\n\r?\n/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // Line 0 is usually index (e.g. "1"), Line 1 is timing ("00:00:01,000 --> 00:00:05,000")
    // Or Line 0 is timing if index omitted
    let timingLine = lines[0].includes('-->') ? lines[0] : lines[1];
    let textLines = lines[0].includes('-->') ? lines.slice(1) : lines.slice(2);

    if (!timingLine || !timingLine.includes('-->')) continue;

    const [startStr, endStr] = timingLine.split('-->');
    const startTimeMs = parseSrtTimestampToMs(startStr);
    const endTimeMs = parseSrtTimestampToMs(endStr);
    const text = textLines.join('\n').trim();

    if (text && endTimeMs > startTimeMs) {
      cues.push({ startTimeMs, endTimeMs, text });
    }
  }

  return cues;
}

/**
 * Merges multiple SRT file contents into a single unified SRT string,
 * offsetting each section's cues by its specified offsetSec.
 */
export function mergeSrtContents(
  sections: { srtContent: string; offsetSec: number }[],
): string {
  const allCues: SubtitleCue[] = [];

  for (const section of sections) {
    const cues = parseSrt(section.srtContent);
    const offsetMs = Math.round(section.offsetSec * 1000);

    for (const cue of cues) {
      allCues.push({
        startTimeMs: cue.startTimeMs + offsetMs,
        endTimeMs: cue.endTimeMs + offsetMs,
        text: cue.text,
      });
    }
  }

  return generateSrt(allCues);
}

/**
 * Obtains the exact duration in seconds of a media file via ffprobe.
 */
export async function getVideoDurationSec(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const parsed = parseFloat(stdout.trim());
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Failed to read valid duration from: ${videoPath} (got: "${stdout}")`);
  }
  return parsed;
}

/**
 * Losslessly concatenates an ordered list of compatible MP4 files using FFmpeg's concat demuxer.
 */
export async function concatVideos(
  videoPaths: string[],
  outputPath: string,
): Promise<void> {
  if (videoPaths.length === 0) {
    throw new Error('concatVideos requires at least one input video path.');
  }

  if (videoPaths.length === 1) {
    fs.copyFileSync(videoPaths[0], outputPath);
    return;
  }

  // Verify all input files exist
  for (const p of videoPaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`Input video not found: ${p}`);
    }
  }

  const tmpListFile = path.join(
    os.tmpdir(),
    `concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  const fileEntries = videoPaths
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(tmpListFile, fileEntries, 'utf8');

  try {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        tmpListFile,
        '-c',
        'copy',
        outputPath,
      ]);
    } catch {
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        tmpListFile,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        outputPath,
      ]);
    }
  } finally {
    try {
      if (fs.existsSync(tmpListFile)) fs.unlinkSync(tmpListFile);
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * SRT subtitle generation and FFmpeg path escaping for automated demo videos.
 */

export interface SubtitleCue {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
}

export class InvalidCueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCueError';
  }
}

/**
 * Formats a millisecond duration into SRT timestamp format: HH:MM:SS,mmm
 * Throws InvalidCueError if ms is negative or not a finite number.
 */
export function formatSrtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new InvalidCueError(
      `Invalid timestamp: ${ms}. Timestamp must be a finite non-negative number.`,
    );
  }

  const totalMs = Math.floor(ms);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Generates an SRT formatted string from a list of subtitle cues.
 * - Numbers sequential blocks 1..N
 * - Filters out cues with empty or whitespace-only text
 * - Throws InvalidCueError if startTimeMs < 0 or startTimeMs >= endTimeMs or non-finite
 */
export function generateSrt(cues: SubtitleCue[]): string {
  const validCues: SubtitleCue[] = [];

  for (const cue of cues) {
    if (!Number.isFinite(cue.startTimeMs) || !Number.isFinite(cue.endTimeMs)) {
      throw new InvalidCueError(
        `Invalid cue timestamps: start=${cue.startTimeMs}, end=${cue.endTimeMs}. Must be finite numbers.`,
      );
    }

    if (cue.startTimeMs < 0) {
      throw new InvalidCueError(
        `Invalid cue startTimeMs: ${cue.startTimeMs}. Must be >= 0.`,
      );
    }

    if (cue.startTimeMs >= cue.endTimeMs) {
      throw new InvalidCueError(
        `Invalid cue timestamps: startTimeMs (${cue.startTimeMs}) must be strictly less than endTimeMs (${cue.endTimeMs}).`,
      );
    }

    const trimmed = (cue.text ?? '').trim();
    if (trimmed.length > 0) {
      validCues.push({
        startTimeMs: cue.startTimeMs,
        endTimeMs: cue.endTimeMs,
        text: trimmed,
      });
    }
  }

  if (validCues.length === 0) {
    return '';
  }

  const blocks: string[] = [];
  for (let i = 0; i < validCues.length; i++) {
    const cue = validCues[i];
    const index = i + 1;
    const timeRange = `${formatSrtTimestamp(cue.startTimeMs)} --> ${formatSrtTimestamp(cue.endTimeMs)}`;
    blocks.push(`${index}\n${timeRange}\n${cue.text}\n`);
  }

  return blocks.join('\n');
}

/**
 * Escapes a file path for use in FFmpeg subtitle filters (-vf subtitles='...').
 * Escapes backslashes (\\), colons (\:), single quotes (\'), and spaces (\ ).
 */
export function escapeFfmpegSubtitlePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

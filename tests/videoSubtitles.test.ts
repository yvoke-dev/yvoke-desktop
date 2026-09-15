import { describe, it, expect } from 'vitest';
import {
  formatSrtTimestamp,
  generateSrt,
  escapeFfmpegSubtitlePath,
  InvalidCueError,
  type SubtitleCue,
} from '../scripts/video/subtitles';

describe('videoSubtitles', () => {
  describe('formatSrtTimestamp', () => {
    it('formats 0 ms as 00:00:00,000', () => {
      expect(formatSrtTimestamp(0)).toBe('00:00:00,000');
    });

    it('formats milliseconds, seconds, minutes, and hours correctly', () => {
      expect(formatSrtTimestamp(500)).toBe('00:00:00,500');
      expect(formatSrtTimestamp(1234)).toBe('00:00:01,234');
      expect(formatSrtTimestamp(65432)).toBe('00:01:05,432');
      expect(formatSrtTimestamp(3661005)).toBe('01:01:01,005');
      expect(formatSrtTimestamp(36000000)).toBe('10:00:00,000');
    });

    it('throws InvalidCueError for negative timestamp', () => {
      expect(() => formatSrtTimestamp(-1)).toThrow(InvalidCueError);
      expect(() => formatSrtTimestamp(-500)).toThrow(InvalidCueError);
    });

    it('throws InvalidCueError for non-finite timestamp', () => {
      expect(() => formatSrtTimestamp(NaN)).toThrow(InvalidCueError);
      expect(() => formatSrtTimestamp(Infinity)).toThrow(InvalidCueError);
      expect(() => formatSrtTimestamp(-Infinity)).toThrow(InvalidCueError);
    });
  });

  describe('generateSrt', () => {
    it('generates valid SRT text for a single cue', () => {
      const cues: SubtitleCue[] = [
        {
          startTimeMs: 1000,
          endTimeMs: 4500,
          text: 'Welcome to Yvoke Desktop',
        },
      ];

      const srt = generateSrt(cues);
      const expected = '1\n00:00:01,000 --> 00:00:04,500\nWelcome to Yvoke Desktop\n';
      expect(srt).toBe(expected);
    });

    it('generates valid SRT text with sequential 1..N indices for multiple cues', () => {
      const cues: SubtitleCue[] = [
        {
          startTimeMs: 0,
          endTimeMs: 2500,
          text: 'First scene narration',
        },
        {
          startTimeMs: 3000,
          endTimeMs: 6500,
          text: 'Second scene narration',
        },
        {
          startTimeMs: 7000,
          endTimeMs: 10200,
          text: 'Third scene narration',
        },
      ];

      const srt = generateSrt(cues);
      const expected = [
        '1',
        '00:00:00,000 --> 00:00:02,500',
        'First scene narration',
        '',
        '2',
        '00:00:03,000 --> 00:00:06,500',
        'Second scene narration',
        '',
        '3',
        '00:00:07,000 --> 00:00:10,200',
        'Third scene narration',
        '',
      ].join('\n');

      expect(srt).toBe(expected);
    });

    it('filters out empty or whitespace-only cues and re-indexes remaining cues', () => {
      const cues: SubtitleCue[] = [
        {
          startTimeMs: 0,
          endTimeMs: 2000,
          text: '   ',
        },
        {
          startTimeMs: 2500,
          endTimeMs: 5000,
          text: 'Valid cue one',
        },
        {
          startTimeMs: 5100,
          endTimeMs: 6000,
          text: '',
        },
        {
          startTimeMs: 6100,
          endTimeMs: 7000,
          text: '\t\n  \n',
        },
        {
          startTimeMs: 7500,
          endTimeMs: 9000,
          text: 'Valid cue two',
        },
      ];

      const srt = generateSrt(cues);
      const expected = [
        '1',
        '00:00:02,500 --> 00:00:05,000',
        'Valid cue one',
        '',
        '2',
        '00:00:07,500 --> 00:00:09,000',
        'Valid cue two',
        '',
      ].join('\n');

      expect(srt).toBe(expected);
    });

    it('returns empty string when given an empty array or only empty cues', () => {
      expect(generateSrt([])).toBe('');
      expect(
        generateSrt([
          { startTimeMs: 100, endTimeMs: 500, text: '' },
          { startTimeMs: 600, endTimeMs: 1000, text: '   ' },
        ]),
      ).toBe('');
    });

    it('throws InvalidCueError if startTimeMs < 0', () => {
      const cues: SubtitleCue[] = [
        {
          startTimeMs: -10,
          endTimeMs: 2000,
          text: 'Invalid start',
        },
      ];
      expect(() => generateSrt(cues)).toThrow(InvalidCueError);
    });

    it('throws InvalidCueError if startTimeMs >= endTimeMs', () => {
      const invertedCues: SubtitleCue[] = [
        {
          startTimeMs: 5000,
          endTimeMs: 2000,
          text: 'Inverted cue',
        },
      ];
      expect(() => generateSrt(invertedCues)).toThrow(InvalidCueError);

      const equalCues: SubtitleCue[] = [
        {
          startTimeMs: 3000,
          endTimeMs: 3000,
          text: 'Equal timestamps',
        },
      ];
      expect(() => generateSrt(equalCues)).toThrow(InvalidCueError);
    });

    it('throws InvalidCueError if timestamps are not finite numbers', () => {
      expect(() =>
        generateSrt([
          { startTimeMs: NaN, endTimeMs: 2000, text: 'NaN start' },
        ]),
      ).toThrow(InvalidCueError);

      expect(() =>
        generateSrt([
          { startTimeMs: 1000, endTimeMs: Infinity, text: 'Infinity end' },
        ]),
      ).toThrow(InvalidCueError);
    });
  });

  describe('escapeFfmpegSubtitlePath', () => {
    it('leaves clean alphanumeric paths untouched', () => {
      expect(escapeFfmpegSubtitlePath('subtitles/output.srt')).toBe('subtitles/output.srt');
      expect(escapeFfmpegSubtitlePath('video.srt')).toBe('video.srt');
    });

    it('escapes colons with backslash', () => {
      expect(escapeFfmpegSubtitlePath('C:/subtitles.srt')).toBe('C\\:/subtitles.srt');
      expect(escapeFfmpegSubtitlePath('path:demo:file.srt')).toBe('path\\:demo\\:file.srt');
    });

    it('escapes backslashes with double backslash', () => {
      expect(escapeFfmpegSubtitlePath('C:\\path\\to\\sub.srt')).toBe('C\\:\\\\path\\\\to\\\\sub.srt');
    });

    it('escapes single quotes with backslash', () => {
      expect(escapeFfmpegSubtitlePath("John's_subs.srt")).toBe("John\\'s_subs.srt");
    });

    it('escapes spaces with backslash', () => {
      expect(escapeFfmpegSubtitlePath('my subtitles file.srt')).toBe('my\\ subtitles\\ file.srt');
    });

    it('escapes complex paths containing colons, backslashes, single quotes, and spaces', () => {
      const complexPath = "C:\\Users\\John Doe's Desktop\\demo:presentation final.srt";
      const escaped = escapeFfmpegSubtitlePath(complexPath);
      expect(escaped).toBe(
        "C\\:\\\\Users\\\\John\\ Doe\\'s\\ Desktop\\\\demo\\:presentation\\ final.srt",
      );
    });
  });
});

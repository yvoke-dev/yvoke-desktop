import { describe, it, expect } from 'vitest';
import { mergeSrtContents } from '../scripts/video/batchMerge';

describe('mergeSrtContents', () => {
  it('combines two SRT contents with the second offset by the first scene duration', () => {
    const srt1 = `1
00:00:01,000 --> 00:00:05,000
Welcome to Scene 1.
`;

    const srt2 = `1
00:00:00,500 --> 00:00:04,000
Now starting Scene 2.
`;

    const result = mergeSrtContents([
      { srtContent: srt1, offsetSec: 0 },
      { srtContent: srt2, offsetSec: 10.0 },
    ]);

    expect(result).toContain('Welcome to Scene 1.');
    expect(result).toContain('Now starting Scene 2.');
    // First cue: 00:00:01,000 --> 00:00:05,000
    expect(result).toContain('00:00:01,000 --> 00:00:05,000');
    // Second cue: offset by 10s => 00:00:10,500 --> 00:00:14,000
    expect(result).toContain('00:00:10,500 --> 00:00:14,000');
    // Numbering should be continuous: 1, 2
    expect(result).toMatch(/^1\n/m);
    expect(result).toMatch(/\n2\n/m);
  });

  it('handles empty SRT contents gracefully', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
Only cue.
`;
    const result = mergeSrtContents([
      { srtContent: '', offsetSec: 0 },
      { srtContent: srt, offsetSec: 5.0 },
    ]);

    expect(result).toContain('Only cue.');
    expect(result).toContain('00:00:06,000 --> 00:00:08,000');
    expect(result).toMatch(/^1\n/m);
  });
});

describe('concatVideos', () => {
  it('throws an error if videoPaths is empty', async () => {
    const { concatVideos } = await import('../scripts/video/batchMerge');
    await expect(concatVideos([], 'output.mp4')).rejects.toThrow(
      'concatVideos requires at least one input video path.',
    );
  });

  it('throws an error if any input file does not exist', async () => {
    const { concatVideos } = await import('../scripts/video/batchMerge');
    await expect(
      concatVideos(['/tmp/nonexistent-1.mp4', '/tmp/nonexistent-2.mp4'], 'output.mp4'),
    ).rejects.toThrow('Input video not found: /tmp/nonexistent-1.mp4');
  });
});


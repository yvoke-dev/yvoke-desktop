import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stitchVideoAndAudio,
  checkFfmpegInstalled,
  escapeConcatPath,
  generateConcatDemuxer,
  FfmpegNotFoundError,
  FfmpegExecutionError,
} from '../scripts/video/stitch';

describe('videoStitch', () => {
  let tempDir: string;
  let dummyNarration: string;
  let dummyBgMusic: string;
  let dummySubtitles: string;
  let dummySubtitlesSpecialChars: string;
  let dummyEmptyFile: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-test-'));
    dummyNarration = path.join(tempDir, 'narration.wav');
    fs.writeFileSync(dummyNarration, Buffer.from('RIFF mock wav audio data'));

    dummyBgMusic = path.join(tempDir, 'background.mp3');
    fs.writeFileSync(dummyBgMusic, Buffer.from('mock mp3 background music'));

    dummySubtitles = path.join(tempDir, 'captions.srt');
    fs.writeFileSync(dummySubtitles, '1\n00:00:01,000 --> 00:00:03,000\nHello world\n');

    dummySubtitlesSpecialChars = path.join(tempDir, "user's demo:subs file.srt");
    fs.writeFileSync(dummySubtitlesSpecialChars, '1\n00:00:01,000 --> 00:00:03,000\nSpecial\n');

    dummyEmptyFile = path.join(tempDir, 'empty.wav');
    fs.writeFileSync(dummyEmptyFile, Buffer.alloc(0));
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('FFmpeg preflight', () => {
    it('checkFfmpegInstalled returns true when ffmpeg executes with code 0', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: 'ffmpeg version 6.0', stderr: '' });
      const installed = await checkFfmpegInstalled(mockRunner);
      expect(installed).toBe(true);
      expect(mockRunner).toHaveBeenCalledWith('ffmpeg', ['-version']);
    });

    it('checkFfmpegInstalled returns false when ffmpeg fails or is not found', async () => {
      const mockRunner = vi.fn().mockRejectedValue(new Error('ENOENT: ffmpeg not found'));
      const installed = await checkFfmpegInstalled(mockRunner);
      expect(installed).toBe(false);
    });

    it('stitchVideoAndAudio throws FfmpegNotFoundError with install guidance if ffmpeg is missing', async () => {
      const mockRunner = vi.fn().mockRejectedValue(new Error('ENOENT: ffmpeg not found'));

      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(FfmpegNotFoundError);

      try {
        await stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(FfmpegNotFoundError);
        expect(err.message).toMatch(/brew install ffmpeg|install ffmpeg/i);
      }
    });

    it('throws descriptive Error if audioPath is specified but does not exist', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          audioPath: '/non/existent/narration.wav',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(/audio file not found|does not exist/i);
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('throws descriptive Error if audioPath is specified but is 0 bytes', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          audioPath: dummyEmptyFile,
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(/empty|0 byte/i);
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('throws descriptive Error if backgroundMusicPath is specified but does not exist', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          backgroundMusicPath: '/non/existent/bg.mp3',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(/background music file not found|does not exist/i);
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('throws descriptive Error if backgroundMusicPath is specified but is 0 bytes', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          backgroundMusicPath: dummyEmptyFile,
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(/empty|0 byte/i);
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('throws descriptive Error if subtitlesPath is specified but does not exist', async () => {
      const mockRunner = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          subtitlesPath: '/non/existent/subs.srt',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow('Subtitles file does not exist: /non/existent/subs.srt');
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('warns and skips subtitle filter if subtitlesPath is specified but is 0 bytes', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let capturedArgs: string[] = [];
      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        subtitlesPath: dummyEmptyFile,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        `Warning: Subtitles file is empty (0 bytes): ${dummyEmptyFile}. Skipping subtitle burning.`,
      );
      expect(capturedArgs).not.toContain('-vf');
      warnSpy.mockRestore();
    });
  });

  describe('Universal MP4 encoding flags', () => {
    it('verifies arguments include -pix_fmt yuv420p, -c:v libx264, -movflags +faststart', async () => {
      let capturedCmd = '';
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedCmd = cmd;
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(capturedCmd).toBe('ffmpeg');

      // Verify universal MP4 flags
      const pixFmtIdx = capturedArgs.indexOf('-pix_fmt');
      expect(pixFmtIdx).toBeGreaterThan(-1);
      expect(capturedArgs[pixFmtIdx + 1]).toBe('yuv420p');

      const codecIdx = capturedArgs.indexOf('-c:v');
      expect(codecIdx).toBeGreaterThan(-1);
      expect(capturedArgs[codecIdx + 1]).toBe('libx264');

      const movflagsIdx = capturedArgs.indexOf('-movflags');
      expect(movflagsIdx).toBeGreaterThan(-1);
      expect(capturedArgs[movflagsIdx + 1]).toBe('+faststart');

      // Audio mapping
      const audioCodecIdx = capturedArgs.indexOf('-c:a');
      expect(audioCodecIdx).toBeGreaterThan(-1);
      expect(capturedArgs[audioCodecIdx + 1]).toBe('aac');

      expect(capturedArgs).toContain('/tmp/output.mp4');
    });
  });

  describe('Demuxer path escaping', () => {
    it('escapes paths with spaces and single quotes for ffmpeg concat demuxer', () => {
      const normalPath = '/tmp/recordings/scene_1.mp4';
      expect(escapeConcatPath(normalPath)).toBe("file '/tmp/recordings/scene_1.mp4'");

      const spacePath = '/Users/john doe/my videos/scene 1.webm';
      expect(escapeConcatPath(spacePath)).toBe("file '/Users/john doe/my videos/scene 1.webm'");

      const quotePath = "/tmp/user's video/scene's.mp4";
      expect(escapeConcatPath(quotePath)).toBe("file '/tmp/user'\\''s video/scene'\\''s.mp4'");
    });

    it('generates multiline concat demuxer content for multiple video files', () => {
      const files = ['/path/scene 1.webm', '/path/scene 2.webm'];
      const demuxerText = generateConcatDemuxer(files);

      expect(demuxerText).toBe("file '/path/scene 1.webm'\nfile '/path/scene 2.webm'");
    });
  });

  describe('Zero audio tracks mode (--skip-tts)', () => {
    it('transmuxes/encodes video cleanly without audio flags or failure when skipTts is true', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        outputPath: '/tmp/output.mp4',
        skipTts: true,
        runner: mockRunner,
      });

      // Video encoding flags must still be present
      expect(capturedArgs).toContain('-c:v');
      expect(capturedArgs).toContain('libx264');
      expect(capturedArgs).toContain('-pix_fmt');
      expect(capturedArgs).toContain('yuv420p');
      expect(capturedArgs).toContain('-movflags');
      expect(capturedArgs).toContain('+faststart');

      // Audio flags must NOT be present
      expect(capturedArgs).not.toContain('-c:a');
      expect(capturedArgs).not.toContain(dummyNarration);
      expect(capturedArgs).not.toContain('-shortest');
    });

    it('transmuxes cleanly when audioPath is omitted', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(capturedArgs).not.toContain('-c:a');
      expect(capturedArgs).toContain('-c:v');
    });
  });

  describe('Background music and audio ducking', () => {
    it('applies sidechaincompress ducking filter graph when enableDucking is not false', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        backgroundMusicPath: dummyBgMusic,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      // Both audio inputs present in order: narration [1:a], bg music [2:a]
      expect(capturedArgs).toContain(dummyNarration);
      expect(capturedArgs).toContain(dummyBgMusic);

      // Filter complex ducking graph
      const filterComplexIdx = capturedArgs.indexOf('-filter_complex');
      expect(filterComplexIdx).toBeGreaterThan(-1);
      const filterGraph = capturedArgs[filterComplexIdx + 1];
      expect(filterGraph).toBe(
        '[1:a]asplit[sc][voice];[2:a][sc]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=300[bg];[voice][bg]amix=inputs=2:duration=longest:dropout_transition=2[aout]',
      );

      // Stream mapping
      expect(capturedArgs).toContain('-map');
      expect(capturedArgs).toContain('0:v');
      expect(capturedArgs).toContain('[aout]');
    });

    it('calculates duckRatio from duckingDb option in sidechaincompress filter', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        backgroundMusicPath: dummyBgMusic,
        duckingDb: -20,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      const filterComplexIdx = capturedArgs.indexOf('-filter_complex');
      expect(filterComplexIdx).toBeGreaterThan(-1);
      const filterGraph = capturedArgs[filterComplexIdx + 1];
      expect(filterGraph).toContain('ratio=9');
    });

    it('applies simple amix filter graph when enableDucking is false', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        backgroundMusicPath: dummyBgMusic,
        enableDucking: false,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      const filterComplexIdx = capturedArgs.indexOf('-filter_complex');
      expect(filterComplexIdx).toBeGreaterThan(-1);
      const filterGraph = capturedArgs[filterComplexIdx + 1];
      expect(filterGraph).toBe('[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]');

      expect(capturedArgs).toContain('-map');
      expect(capturedArgs).toContain('0:v');
      expect(capturedArgs).toContain('[aout]');
    });

    it('mixes only background music when narration is absent', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        backgroundMusicPath: dummyBgMusic,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(capturedArgs).toContain(dummyBgMusic);
      expect(capturedArgs).not.toContain('-filter_complex');
      expect(capturedArgs).toContain('-c:a');
      expect(capturedArgs).toContain('aac');
    });
  });

  describe('Subtitles burning', () => {
    it('applies video filter -vf subtitles=<escapedPath> when subtitlesPath is provided', async () => {
      let capturedArgs: string[] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        capturedArgs = args;
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        subtitlesPath: dummySubtitlesSpecialChars,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      const vfIdx = capturedArgs.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(-1);
      const vfArg = capturedArgs[vfIdx + 1];
      expect(vfArg).toMatch(/^subtitles='/);
      expect(vfArg).toContain("user\\'s\\ demo\\:subs\\ file.srt");
    });
  });

  describe('Resilient Fallbacks', () => {
    it('retries stitch without subtitles when runner returns No such filter: subtitles error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let attempts = 0;
      const capturedCalls: string[][] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        attempts++;
        capturedCalls.push(args);
        if (attempts === 1) {
          return {
            code: 1,
            stdout: '',
            stderr: "Error initializing filter 'subtitles': No such filter: 'subtitles'",
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        subtitlesPath: dummySubtitles,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(attempts).toBe(2);
      expect(capturedCalls[0]).toContain('-vf');
      expect(capturedCalls[1]).not.toContain('-vf');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/subtitles.*not found|retrying.*without subtitles/i),
      );

      warnSpy.mockRestore();
    });

    it('retries stitch with simple amix when runner returns No such filter: sidechaincompress error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let attempts = 0;
      const capturedCalls: string[][] = [];

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        attempts++;
        capturedCalls.push(args);
        if (attempts === 1) {
          return {
            code: 1,
            stdout: '',
            stderr: "Error initializing filter 'sidechaincompress': No such filter: 'sidechaincompress'",
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await stitchVideoAndAudio({
        videoPath: '/tmp/input.webm',
        audioPath: dummyNarration,
        backgroundMusicPath: dummyBgMusic,
        outputPath: '/tmp/output.mp4',
        runner: mockRunner,
      });

      expect(attempts).toBe(2);
      expect(capturedCalls[0].join(' ')).toContain('sidechaincompress');
      expect(capturedCalls[1].join(' ')).not.toContain('sidechaincompress');
      expect(capturedCalls[1].join(' ')).toContain('[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/sidechaincompress.*not found|retrying.*without ducking|simple amix/i),
      );

      warnSpy.mockRestore();
    });

    it('does not retry and throws FfmpegExecutionError immediately on non-recoverable error', async () => {
      let attempts = 0;

      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        attempts++;
        return {
          code: 1,
          stdout: '',
          stderr: 'Unknown encoder libx264: fatal error',
        };
      });

      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(FfmpegExecutionError);

      expect(attempts).toBe(1);
    });
  });

  describe('Error handling', () => {
    it('captures ffmpeg stderr in FfmpegExecutionError upon non-zero exit', async () => {
      const mockRunner = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('-version')) {
          return { code: 0, stdout: 'ffmpeg version 6.0', stderr: '' };
        }
        return {
          code: 1,
          stdout: '',
          stderr: 'Error while opening encoder: Unknown encoder libx264',
        };
      });

      await expect(
        stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        }),
      ).rejects.toThrow(FfmpegExecutionError);

      try {
        await stitchVideoAndAudio({
          videoPath: '/tmp/input.webm',
          outputPath: '/tmp/output.mp4',
          runner: mockRunner,
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(FfmpegExecutionError);
        expect(err.stderr).toContain('Unknown encoder libx264');
        expect(err.message).toContain('Unknown encoder libx264');
        expect(err.code).toBe(1);
      }
    });
  });
});

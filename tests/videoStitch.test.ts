import { describe, it, expect, vi } from 'vitest';
import {
  stitchVideoAndAudio,
  checkFfmpegInstalled,
  escapeConcatPath,
  generateConcatDemuxer,
  FfmpegNotFoundError,
  FfmpegExecutionError,
} from '../scripts/video/stitch';

describe('videoStitch', () => {
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
        audioPath: '/tmp/narration.wav',
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
        audioPath: '/tmp/narration.wav', // Even if audioPath is passed, skipTts should ignore it
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
      expect(capturedArgs).not.toContain('/tmp/narration.wav');
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

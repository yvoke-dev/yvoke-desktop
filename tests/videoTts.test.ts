import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWavHeader,
  calculateAudioDuration,
  pcmToWav,
  synthesizeSpeech,
  redactApiKey,
  InvalidPcmDataError,
  TtsSynthesisError,
  TtsQuotaExceededError,
  TtsAuthenticationError,
} from '../scripts/video/tts';

describe('videoTts', () => {
  describe('RIFF/WAVE header creation', () => {
    it('creates an exact 44-byte RIFF/WAVE header for 24kHz, 16-bit, Mono PCM', () => {
      const dataSize = 48000; // 1 second of audio
      const header = createWavHeader(dataSize);

      expect(header).toBeInstanceOf(Buffer);
      expect(header.length).toBe(44);

      // RIFF chunk descriptor
      expect(header.toString('ascii', 0, 4)).toBe('RIFF');
      // ChunkSize = 36 + dataSize
      expect(header.readUInt32LE(4)).toBe(36 + dataSize);
      expect(header.toString('ascii', 8, 12)).toBe('WAVE');

      // "fmt " subchunk
      expect(header.toString('ascii', 12, 16)).toBe('fmt ');
      expect(header.readUInt32LE(16)).toBe(16); // Subchunk1Size (16 for PCM)
      expect(header.readUInt16LE(20)).toBe(1); // AudioFormat (1 for PCM)
      expect(header.readUInt16LE(22)).toBe(1); // NumChannels (1 = Mono)
      expect(header.readUInt32LE(24)).toBe(24000); // SampleRate (24kHz)
      // ByteRate = SampleRate * NumChannels * BitsPerSample / 8 = 24000 * 1 * 2 = 48000
      expect(header.readUInt32LE(28)).toBe(48000);
      // BlockAlign = NumChannels * BitsPerSample / 8 = 2
      expect(header.readUInt16LE(32)).toBe(2);
      // BitsPerSample = 16
      expect(header.readUInt16LE(34)).toBe(16);

      // "data" subchunk
      expect(header.toString('ascii', 36, 40)).toBe('data');
      // Subchunk2Size = dataSize
      expect(header.readUInt32LE(40)).toBe(dataSize);
    });

    it('returns a valid 44-byte header with 0 data size for zero-byte buffer', () => {
      const header = createWavHeader(0);

      expect(header.length).toBe(44);
      expect(header.readUInt32LE(4)).toBe(36); // ChunkSize = 36 + 0
      expect(header.readUInt32LE(40)).toBe(0); // Subchunk2Size = 0

      const emptyWav = pcmToWav(Buffer.alloc(0));
      expect(emptyWav.length).toBe(44);
      expect(emptyWav.readUInt32LE(40)).toBe(0);
    });

    it('throws InvalidPcmDataError for odd-byte buffer', () => {
      expect(() => createWavHeader(3)).toThrow(InvalidPcmDataError);
      expect(() => createWavHeader(101)).toThrow(InvalidPcmDataError);
      expect(() => pcmToWav(Buffer.alloc(7))).toThrow(InvalidPcmDataError);
      expect(() => calculateAudioDuration(15)).toThrow(InvalidPcmDataError);
    });
  });

  describe('Duration calculation', () => {
    it('calculates accurate duration for 24kHz 16-bit mono PCM (byteLength / 48000)', () => {
      expect(calculateAudioDuration(0)).toBe(0);
      expect(calculateAudioDuration(48000)).toBe(1.0);
      expect(calculateAudioDuration(96000)).toBe(2.0);
      expect(calculateAudioDuration(24000)).toBe(0.5);
      expect(calculateAudioDuration(72000)).toBe(1.5);
    });
  });

  describe('pcmToWav helper', () => {
    it('prepends 44-byte WAV header to PCM buffer', () => {
      const pcm = Buffer.alloc(100, 0x12);
      const wav = pcmToWav(pcm);

      expect(wav.length).toBe(44 + 100);
      expect(wav.readUInt32LE(40)).toBe(100);
      expect(wav.subarray(44)).toEqual(pcm);
    });
  });

  describe('Redaction of API keys', () => {
    it('redacts ?key= and &key= parameters from URLs and error messages', () => {
      const secret = 'AIzaSySecretApiKey1234567890';
      const input = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${secret}&other=val`;
      const redacted = redactApiKey(input);

      expect(redacted).not.toContain(secret);
      expect(redacted).toContain('?key=[REDACTED]');
      expect(redacted).toContain('&other=val');

      const msg = `Request failed: 400 at https://example.com/api?foo=1&key=${secret}`;
      expect(redactApiKey(msg)).not.toContain(secret);
      expect(redactApiKey(msg)).toContain('&key=[REDACTED]');
    });
  });

  describe('synthesizeSpeech negative test cases', () => {
    let originalConsoleLog: typeof console.log;
    let originalConsoleError: typeof console.error;
    let originalConsoleWarn: typeof console.warn;
    let logOutput: string[] = [];

    beforeEach(() => {
      logOutput = [];
      originalConsoleLog = console.log;
      originalConsoleError = console.error;
      originalConsoleWarn = console.warn;

      console.log = vi.fn((...args: unknown[]) => {
        logOutput.push(args.map(String).join(' '));
      });
      console.error = vi.fn((...args: unknown[]) => {
        logOutput.push(args.map(String).join(' '));
      });
      console.warn = vi.fn((...args: unknown[]) => {
        logOutput.push(args.map(String).join(' '));
      });
    });

    afterEach(() => {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
      vi.restoreAllMocks();
    });

    it('redacts GEMINI_API_KEY from error message if request fails with key in url', async () => {
      const apiKey = 'AIzaSySecretKey999';
      const mockFetch = vi.fn().mockRejectedValue(new Error(`Failed to fetch https://generativelanguage.googleapis.com/test?key=${apiKey}`));

      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch })
      ).rejects.toThrow(TtsSynthesisError);

      try {
        await synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch });
      } catch (err: any) {
        expect(err.message).not.toContain(apiKey);
        expect(err.message).toContain('[REDACTED]');
      }
    });

    it('classifies HTTP 429 rate limit as TtsQuotaExceededError (prioritized before auth regexes)', async () => {
      const apiKey = 'AIzaSyTestKey';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: vi.fn().mockResolvedValue('{"error":{"message":"Resource has been exhausted (e.g. check quota or unauthorized access)"}}'),
      });

      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch })
      ).rejects.toThrow(TtsQuotaExceededError);
    });

    it('classifies HTTP 401 and HTTP 403 as TtsAuthenticationError', async () => {
      const apiKey = 'AIzaSyTestKey';
      const mockFetch401 = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: vi.fn().mockResolvedValue('{"error":{"message":"API key not valid"}}'),
      });

      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch401 })
      ).rejects.toThrow(TtsAuthenticationError);

      const mockFetch403 = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: vi.fn().mockResolvedValue('{"error":{"message":"Permission denied"}}'),
      });

      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch403 })
      ).rejects.toThrow(TtsAuthenticationError);
    });

    it('throws TtsSynthesisError on blocked prompt or empty candidates', async () => {
      const apiKey = 'AIzaSyTestKey';

      // Empty candidates array
      const mockFetchEmpty = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ candidates: [] }),
      });
      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetchEmpty })
      ).rejects.toThrow(TtsSynthesisError);

      // Blocked promptFeedback
      const mockFetchBlocked = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          candidates: [],
          promptFeedback: { blockReason: 'SAFETY' },
        }),
      });
      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetchBlocked })
      ).rejects.toThrow(TtsSynthesisError);

      // Missing inlineData
      const mockFetchMissingData = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          candidates: [{ content: { parts: [{ text: 'No audio here' }] } }],
        }),
      });
      await expect(
        synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetchMissingData })
      ).rejects.toThrow(TtsSynthesisError);
    });

    it('ensures safe logging: audio buffers and base64 strings are never logged to stdout/stderr', async () => {
      const apiKey = 'AIzaSyTestKey';
      const fakePcmBase64 = Buffer.from('1234567812345678').toString('base64');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/pcm;rate=24000',
                      data: fakePcmBase64,
                    },
                  },
                ],
              },
            },
          ],
        }),
      });

      const res = await synthesizeSpeech('Hello world', { apiKey, fetchFn: mockFetch });
      expect(res.durationSeconds).toBeGreaterThan(0);
      expect(res.wavBuffer.length).toBe(44 + 16);

      // Check all logged output
      for (const log of logOutput) {
        expect(log).not.toContain(fakePcmBase64);
        expect(log).not.toContain('1234567812345678');
      }
    });
  });
});

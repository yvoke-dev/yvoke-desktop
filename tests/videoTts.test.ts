import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createWavHeader,
  calculateAudioDuration,
  pcmToWav,
  synthesizeSpeech,
  redactApiKey,
  createSilencePcm,
  createSilenceResult,
  padSynthesizeResult,
  extractPcmFromAudioBuffer,
  applyMicroFade,
  combineSynthesizeResults,
  alignSegmentAudioToTimeline,
  createTimelineSyncController,
  type SynthesizeResult,
  type AlignSegmentAudioParams,
  type AlignSegmentAudioResult,
  type TimelineSyncControllerOptions,
  type TimelineSubtitleCue,
  type TimelineSyncController,
  InvalidPcmDataError,
  TtsSynthesisError,
  TtsQuotaExceededError,
  TtsAuthenticationError,
} from '../scripts/video/tts';
import { generateSrt, remapTimestamp } from '../scripts/video/subtitles';
import type { AccelerationInterval } from '../scripts/video/stitch';

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

    it('caches synthesized audio on disk and avoids redundant network calls', async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-test-tts-cache-'));

      try {
        const apiKey = 'AIzaSyTestKey';
        const fakePcmBase64 = Buffer.alloc(48000, 0x11).toString('base64');
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: fakePcmBase64 } }],
                },
              },
            ],
          }),
        });

        // First call hits network
        const res1 = await synthesizeSpeech('Cache test text', {
          apiKey,
          fetchFn: mockFetch,
          cacheDir: tempCacheDir,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(res1.durationSeconds).toBe(1.0);

        // Second call with identical text reads from disk cache
        const res2 = await synthesizeSpeech('Cache test text', {
          apiKey,
          fetchFn: mockFetch,
          cacheDir: tempCacheDir,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1); // not called again!
        expect(res2.durationSeconds).toBe(1.0);
        expect(res2.pcmBuffer.equals(res1.pcmBuffer)).toBe(true);
      } finally {
        fs.rmSync(tempCacheDir, { recursive: true, force: true });
      }
    });

    it('retries on HTTP 429 when retryDelay is specified before succeeding', async () => {
      const apiKey = 'AIzaSyTestKey';
      const fakePcmBase64 = Buffer.alloc(48000, 0x22).toString('base64');
      let callCount = 0;
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => JSON.stringify({
              error: {
                code: 429,
                message: 'Quota exceeded',
                details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }],
              },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: fakePcmBase64 } }],
                },
              },
            ],
          }),
        };
      });

      const res = await synthesizeSpeech('Retry 429 test', {
        apiKey,
        fetchFn: mockFetch,
        cacheDir: null,
        maxRetries: 2,
        sleepFn: sleepMock,
      });

      expect(callCount).toBe(2);
      expect(sleepMock).toHaveBeenCalledWith(1000);
      expect(res.durationSeconds).toBe(1.0);
    });
  });

  describe('combineSynthesizeResults', () => {
    it('returns empty audio and zero duration for empty input array', async () => {
      const { combineSynthesizeResults } = await import('../scripts/video/tts');
      const combined = combineSynthesizeResults([]);
      expect(combined.durationSeconds).toBe(0);
      expect(combined.pcmBuffer.length).toBe(0);
      expect(combined.wavBuffer.length).toBe(44); // just header
    });

    it('sequentially combines multiple SynthesizeResults summing durations and concatenating PCM', async () => {
      const { combineSynthesizeResults } = await import('../scripts/video/tts');
      const pcm1 = Buffer.alloc(48000, 1); // 1.0s
      const pcm2 = Buffer.alloc(24000, 2); // 0.5s
      const pcm3 = Buffer.alloc(72000, 3); // 1.5s

      const r1 = { pcmBuffer: pcm1, wavBuffer: pcmToWav(pcm1), durationSeconds: 1.0 };
      const r2 = { pcmBuffer: pcm2, wavBuffer: pcmToWav(pcm2), durationSeconds: 0.5 };
      const r3 = { pcmBuffer: pcm3, wavBuffer: pcmToWav(pcm3), durationSeconds: 1.5 };

      const combined = combineSynthesizeResults([r1, r2, r3]);
      expect(combined.durationSeconds).toBe(3.0);
      expect(combined.pcmBuffer.length).toBe(144000);
      expect(combined.wavBuffer.length).toBe(44 + 144000);

      // Verify sequential byte content
      expect(combined.pcmBuffer[0]).toBe(1);
      expect(combined.pcmBuffer[47999]).toBe(1);
      expect(combined.pcmBuffer[48000]).toBe(2);
      expect(combined.pcmBuffer[71999]).toBe(2);
      expect(combined.pcmBuffer[72000]).toBe(3);
      expect(combined.pcmBuffer[143999]).toBe(3);
    });
  });

  describe('createSilencePcm and createSilenceResult', () => {
    it('returns empty buffer for non-positive duration', () => {
      expect(createSilencePcm(0).length).toBe(0);
      expect(createSilencePcm(-1).length).toBe(0);
    });

    it('generates zero-filled PCM buffer with even byte length corresponding to duration', () => {
      const pcm1s = createSilencePcm(1.0);
      expect(pcm1s.length).toBe(48000);
      expect(pcm1s.every((b) => b === 0)).toBe(true);

      const pcmHalf = createSilencePcm(0.5);
      expect(pcmHalf.length).toBe(24000);
      expect(pcmHalf.length % 2).toBe(0);
    });

    it('creates a complete SynthesizeResult with WAV header for silence', () => {
      const res = createSilenceResult(1.5);
      expect(res.durationSeconds).toBe(1.5);
      expect(res.pcmBuffer.length).toBe(72000);
      expect(res.wavBuffer.length).toBe(44 + 72000);
    });
  });

  describe('padSynthesizeResult', () => {
    it('returns original result if duration is already >= target', () => {
      const pcm = Buffer.alloc(48000, 1);
      const original: SynthesizeResult = {
        pcmBuffer: pcm,
        wavBuffer: pcmToWav(pcm),
        durationSeconds: 1.0,
      };

      const padded = padSynthesizeResult(original, 0.8);
      expect(padded).toBe(original);
      expect(padded.durationSeconds).toBe(1.0);
    });

    it('appends silence PCM and updates duration to target when target > duration', () => {
      const pcm = Buffer.alloc(48000, 5); // 1.0s of data
      const original: SynthesizeResult = {
        pcmBuffer: pcm,
        wavBuffer: pcmToWav(pcm),
        durationSeconds: 1.0,
      };

      const padded = padSynthesizeResult(original, 2.5); // Pad to 2.5s
      expect(padded.durationSeconds).toBe(2.5);
      expect(padded.pcmBuffer.length).toBe(120000); // 2.5 * 48000
      expect(padded.wavBuffer.length).toBe(44 + 120000);

      // Verify original content preserved at beginning, zero silence at end
      expect(padded.pcmBuffer[0]).toBe(5);
      expect(padded.pcmBuffer[47999]).toBe(5);
      expect(padded.pcmBuffer[48000]).toBe(0);
      expect(padded.pcmBuffer[119999]).toBe(0);
    });
  });

  describe('extractPcmFromAudioBuffer', () => {
    it('returns raw buffer directly if it does not contain RIFF/WAVE header', () => {
      const raw = Buffer.alloc(100, 42);
      const res = extractPcmFromAudioBuffer(raw);
      expect(res.pcmBuffer).toBe(raw);
      expect(res.sampleRate).toBe(24000);
    });

    it('strips RIFF/WAVE 44-byte header and trailing C2PA metadata chunk', () => {
      // Build a synthetic RIFF container with fmt, data, and C2PA metadata chunks
      const pcmData = Buffer.alloc(480, 0x55); // Pure audio PCM
      const c2paMetadata = Buffer.from('C2PA provenance digitalSourceType watermark data 123456');

      // fmt chunk
      const fmtChunk = Buffer.alloc(24);
      fmtChunk.write('fmt ', 0, 4, 'ascii');
      fmtChunk.writeUInt32LE(16, 4); // Subchunk1Size = 16
      fmtChunk.writeUInt16LE(1, 8); // AudioFormat = 1 (PCM)
      fmtChunk.writeUInt16LE(1, 10); // NumChannels = 1
      fmtChunk.writeUInt32LE(24000, 12); // SampleRate = 24000
      fmtChunk.writeUInt32LE(48000, 16); // ByteRate = 48000
      fmtChunk.writeUInt16LE(2, 20); // BlockAlign = 2
      fmtChunk.writeUInt16LE(16, 22); // BitsPerSample = 16

      // data chunk
      const dataHeader = Buffer.alloc(8);
      dataHeader.write('data', 0, 4, 'ascii');
      dataHeader.writeUInt32LE(pcmData.length, 4);

      // C2PA chunk
      const c2paHeader = Buffer.alloc(8);
      c2paHeader.write('C2PA', 0, 4, 'ascii');
      c2paHeader.writeUInt32LE(c2paMetadata.length, 4);

      const body = Buffer.concat([fmtChunk, dataHeader, pcmData, c2paHeader, c2paMetadata]);

      // RIFF header
      const riffHeader = Buffer.alloc(12);
      riffHeader.write('RIFF', 0, 4, 'ascii');
      riffHeader.writeUInt32LE(body.length + 4, 4);
      riffHeader.write('WAVE', 8, 4, 'ascii');

      const fullWavWithMetadata = Buffer.concat([riffHeader, body]);

      const extracted = extractPcmFromAudioBuffer(fullWavWithMetadata);
      expect(extracted.sampleRate).toBe(24000);
      expect(extracted.pcmBuffer.length).toBe(pcmData.length);
      expect(extracted.pcmBuffer).toEqual(pcmData);
      expect(extracted.pcmBuffer.includes(Buffer.from('C2PA'))).toBe(false);
      expect(extracted.pcmBuffer.includes(Buffer.from('RIFF'))).toBe(false);
    });
  });

  describe('applyMicroFade', () => {
    it('smooths boundaries by fading in first samples and fading out last samples', () => {
      // 100 samples of constant non-zero value (3000)
      const buffer = Buffer.alloc(200);
      for (let i = 0; i < 100; i++) {
        buffer.writeInt16LE(3000, i * 2);
      }

      const faded = applyMicroFade(buffer, 1, 24000); // 1ms fade = 24 samples
      // First sample should be 0
      expect(faded.readInt16LE(0)).toBe(0);
      // Intermediate sample should be full volume (3000)
      expect(faded.readInt16LE(50 * 2)).toBe(3000);
      // Last sample should be 0
      expect(faded.readInt16LE(99 * 2)).toBe(0);
    });
  });

  describe('alignSegmentAudioToTimeline', () => {
    const makeAudio = (durationSec: number, fillByte: number, sampleRate = 24000): SynthesizeResult => {
      const byteLength = Math.round(durationSec * sampleRate * 2);
      const pcmBuffer = Buffer.alloc(byteLength, fillByte);
      return {
        pcmBuffer,
        wavBuffer: pcmToWav(pcmBuffer, sampleRate),
        durationSeconds: calculateAudioDuration(pcmBuffer.length, sampleRate),
      };
    };

    it('throws RangeError across invalid numeric validation matrix', () => {
      const audio = makeAudio(1.0, 0x11);
      const base: AlignSegmentAudioParams = {
        audio,
        audioCursorSec: 1.0,
        segStartEffectiveSec: 1.5,
        segEndEffectiveSec: 2.5,
        sampleRate: 24000,
      };

      // Invalid sampleRate
      for (const badRate of [0, -24000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => alignSegmentAudioToTimeline({ ...base, sampleRate: badRate })).toThrow(RangeError);
      }

      // Invalid audioCursorSec
      for (const badCursor of [-0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() => alignSegmentAudioToTimeline({ ...base, audioCursorSec: badCursor })).toThrow(RangeError);
      }

      // Invalid segStartEffectiveSec
      for (const badStart of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => alignSegmentAudioToTimeline({ ...base, segStartEffectiveSec: badStart })).toThrow(RangeError);
      }

      // Invalid segEndEffectiveSec
      for (const badEnd of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => alignSegmentAudioToTimeline({ ...base, segEndEffectiveSec: badEnd })).toThrow(RangeError);
      }

      // Inverted window: segEndEffectiveSec < segStartEffectiveSec
      expect(() =>
        alignSegmentAudioToTimeline({
          ...base,
          segStartEffectiveSec: 3.0,
          segEndEffectiveSec: 2.5,
        }),
      ).toThrow(RangeError);
    });

    it('throws InvalidPcmDataError when audio.pcmBuffer has odd byte length', () => {
      const oddBuffer = Buffer.alloc(101, 0x22);
      const malformed: SynthesizeResult = {
        pcmBuffer: oddBuffer,
        wavBuffer: Buffer.alloc(44),
        durationSeconds: 0.002,
      };

      expect(() =>
        alignSegmentAudioToTimeline({
          audio: malformed,
          audioCursorSec: 0,
          segStartEffectiveSec: 0,
          segEndEffectiveSec: 1,
        }),
      ).toThrow(InvalidPcmDataError);
    });

    it('computes speech duration strictly from pcmBuffer.length, ignoring stale audio.durationSeconds metadata', () => {
      const pcmBuffer = Buffer.alloc(48000, 0x33); // Exactly 1.0s at 24kHz
      const staleAudio: SynthesizeResult = {
        pcmBuffer,
        wavBuffer: pcmToWav(pcmBuffer, 24000),
        durationSeconds: 99.5, // Wildly stale/wrong metadata
      };

      const res: AlignSegmentAudioResult = alignSegmentAudioToTimeline({
        audio: staleAudio,
        audioCursorSec: 0,
        segStartEffectiveSec: 0,
        segEndEffectiveSec: 1.5,
      });

      expect(res.speechStartEffectiveSec).toBe(0);
      expect(res.speechEndEffectiveSec).toBe(1.0);
      expect(res.alignedAudio.durationSeconds).toBe(1.5);
      expect(res.nextAudioCursorSec).toBe(1.5);
      expect(res.alignedAudio.pcmBuffer.length).toBe(72000); // 1.0s speech + 0.5s trailing silence
    });

    it('clamps cleanly on clock jitter when segStartEffectiveSec < audioCursorSec without dropping audio or moving subtitle earlier', () => {
      const audio = makeAudio(1.0, 0x44);

      const res = alignSegmentAudioToTimeline({
        audio,
        audioCursorSec: 5.2,
        segStartEffectiveSec: 5.0, // Earlier than audioCursorSec due to jitter
        segEndEffectiveSec: 6.5,
      });

      // Speech starts at audioCursorSec (5.2), never earlier; zero leading silence, no audio dropped
      expect(res.speechStartEffectiveSec).toBeCloseTo(5.2, 10);
      expect(res.speechEndEffectiveSec).toBeCloseTo(6.2, 10);
      expect(res.nextAudioCursorSec).toBeCloseTo(6.5, 10);
      expect(res.alignedAudio.pcmBuffer.subarray(0, 48000).equals(audio.pcmBuffer)).toBe(true);
      // Trailing silence covers 6.5 - 6.2 = 0.3s (14400 bytes)
      expect(res.alignedAudio.pcmBuffer.length).toBe(48000 + 14400);
      expect(res.alignedAudio.pcmBuffer.subarray(48000).every((b) => b === 0)).toBe(true);
    });

    it('preserves full speech without truncating when speech is longer than the segment window', () => {
      const audio = makeAudio(1.2, 0x55); // 57600 bytes

      const res = alignSegmentAudioToTimeline({
        audio,
        audioCursorSec: 1.0,
        segStartEffectiveSec: 1.5,
        segEndEffectiveSec: 2.0, // Window ends at 2.0, but speech ends at 2.7
      });

      expect(res.speechStartEffectiveSec).toBeCloseTo(1.5, 10);
      expect(res.speechEndEffectiveSec).toBeCloseTo(2.7, 10);
      expect(res.nextAudioCursorSec).toBeCloseTo(2.7, 10);
      // 0.5s leading silence (24000 bytes) + full 1.2s speech (57600 bytes) + 0 trailing
      expect(res.alignedAudio.pcmBuffer.length).toBe(24000 + 57600);
      expect(res.alignedAudio.pcmBuffer.subarray(24000).equals(audio.pcmBuffer)).toBe(true);
    });

    it('produces exact byte-level PCM layout and WAV header for custom sampleRate = 16000', () => {
      const sampleRate = 16000;
      const audio = makeAudio(0.5, 0x7a, sampleRate); // 16000 bytes

      const res = alignSegmentAudioToTimeline({
        audio,
        audioCursorSec: 1.0,
        segStartEffectiveSec: 1.25, // +0.25s leading = 8000 bytes
        segEndEffectiveSec: 2.25,   // +0.5s trailing = 16000 bytes
        sampleRate,
      });

      expect(res.speechStartEffectiveSec).toBe(1.25);
      expect(res.speechEndEffectiveSec).toBe(1.75);
      expect(res.nextAudioCursorSec).toBe(2.25);
      expect(res.alignedAudio.durationSeconds).toBe(1.25);

      const pcm = res.alignedAudio.pcmBuffer;
      expect(pcm.length).toBe(8000 + 16000 + 16000);
      expect(pcm.subarray(0, 8000).every((b) => b === 0)).toBe(true);
      expect(pcm.subarray(8000, 24000).every((b) => b === 0x7a)).toBe(true);
      expect(pcm.subarray(24000, 40000).every((b) => b === 0)).toBe(true);

      const wav = res.alignedAudio.wavBuffer;
      expect(wav.length).toBe(44 + pcm.length);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
      expect(wav.readUInt32LE(24)).toBe(16000); // SampleRate
      expect(wav.readUInt32LE(28)).toBe(32000); // ByteRate = 16000 * 1 * 2
      expect(wav.readUInt32LE(40)).toBe(pcm.length);
      expect(wav.subarray(44).equals(pcm)).toBe(true);
    });

    it('handles zero-duration and empty PCM boundaries cleanly', () => {
      const emptyAudio: SynthesizeResult = {
        pcmBuffer: Buffer.alloc(0),
        wavBuffer: pcmToWav(Buffer.alloc(0)),
        durationSeconds: 0,
      };

      const zeroWin = alignSegmentAudioToTimeline({
        audio: emptyAudio,
        audioCursorSec: 2.0,
        segStartEffectiveSec: 2.0,
        segEndEffectiveSec: 2.0,
      });

      expect(zeroWin.alignedAudio.pcmBuffer.length).toBe(0);
      expect(zeroWin.alignedAudio.wavBuffer.length).toBe(44);
      expect(zeroWin.alignedAudio.durationSeconds).toBe(0);
      expect(zeroWin.speechStartEffectiveSec).toBe(2.0);
      expect(zeroWin.speechEndEffectiveSec).toBe(2.0);
      expect(zeroWin.nextAudioCursorSec).toBe(2.0);

      const silenceWin = alignSegmentAudioToTimeline({
        audio: emptyAudio,
        audioCursorSec: 1.0,
        segStartEffectiveSec: 1.5,
        segEndEffectiveSec: 2.0,
      });

      expect(silenceWin.alignedAudio.pcmBuffer.length).toBe(48000); // 0.5s leading + 0.5s trailing
      expect(silenceWin.alignedAudio.durationSeconds).toBe(1.0);
      expect(silenceWin.nextAudioCursorSec).toBe(2.0);
    });
  });

  describe('createTimelineSyncController', () => {
    const makeAudio = (durationSec: number, fillByte: number, sampleRate = 24000): SynthesizeResult => {
      const pcmBuffer = Buffer.alloc(Math.round(durationSec * sampleRate * 2), fillByte);
      return {
        pcmBuffer,
        wavBuffer: pcmToWav(pcmBuffer, sampleRate),
        durationSeconds: calculateAudioDuration(pcmBuffer.length, sampleRate),
      };
    };

    it('validates sampleRate and initialSilencePcm byte alignment on creation', () => {
      const baseOpts: TimelineSyncControllerOptions = {
        initialSilencePcm: createSilencePcm(0.5),
        skipTts: false,
        nowSec: () => 0.5,
        waitSec: async () => {},
        remapSec: (s) => s,
      };

      expect(() => createTimelineSyncController({ ...baseOpts, sampleRate: 0 })).toThrow(RangeError);
      expect(() => createTimelineSyncController({ ...baseOpts, sampleRate: -16000 })).toThrow(RangeError);
      expect(() => createTimelineSyncController({ ...baseOpts, sampleRate: Number.NaN })).toThrow(RangeError);
      expect(() =>
        createTimelineSyncController({ ...baseOpts, initialSilencePcm: Buffer.alloc(5) }),
      ).toThrow(InvalidPcmDataError);
    });

    it('maintains sample-accurate A/V sync across multi-scene drift, jitter, gaps, 10x acceleration, and fallback narration', async () => {
      // Quantized initial silence
      const initialSilencePcm = createSilencePcm(1.2345);
      let rawClockSec = 1.2345;
      const accelerationIntervals: AccelerationInterval[] = [];
      const remapSec = (raw: number) => remapTimestamp(raw, accelerationIntervals);

      // Scripted wait jitter sequence:
      // wait 1 (Scene 1 seg1): overshoot +45ms
      // wait 2 (Scene 1 seg2): early wakeup -15ms
      // wait 3 (Scene 1 scene padding after early wakeup): exact 0ms
      // wait 4 (Scene 2 seg1 after 10x acceleration): exact 0ms
      const waitJitterSec = [0.045, -0.015, 0, 0];
      const waitCalls: number[] = [];

      const controller: TimelineSyncController = createTimelineSyncController({
        initialSilencePcm,
        sampleRate: 24000,
        skipTts: false,
        nowSec: () => rawClockSec,
        waitSec: async (sec: number) => {
          waitCalls.push(sec);
          const jitter = waitJitterSec.shift() ?? 0;
          rawClockSec += Math.max(0, sec + jitter);
        },
        remapSec,
      });

      expect(controller.getAudioCursorSec()).toBe(calculateAudioDuration(initialSilencePcm.length, 24000));

      const scene1Map = new Map<string, SynthesizeResult>([
        ['s1_a', makeAudio(2.0, 0x11)],
        ['s1_b', makeAudio(1.5, 0x22)],
      ]);
      const scene2Map = new Map<string, SynthesizeResult>([
        ['s2_turn', makeAudio(2.5, 0x33)],
      ]);
      const sceneAudios: (SynthesizeResult | undefined)[] = [undefined, undefined, undefined];

      // --- Scene 1: 2 segments with overshoot (+45ms), inter-segment gap (+320ms), early wakeup (-15ms), and trailing scene gap ---
      const scene1Timing = await controller.runSceneWithPadding({
        sceneIdx: 0,
        targetDurationSec: 5.0,
        sceneNarration: 'Scene 1 fallback (unused)',
        actionFn: async () => {
          await controller.runSegment({
            segAudioMap: scene1Map,
            key: 's1_a',
            defaultDurationSec: 2.0,
            actionFn: async () => {
              rawClockSec += 0.4; // Visual action takes 0.4s -> waits 1.6s, overshoots +45ms
            },
            narrationText: 'Scene one part A.',
          });

          // Inter-segment un-narrated gap (+320ms)
          rawClockSec += 0.32;

          await controller.runSegment({
            segAudioMap: scene1Map,
            key: 's1_b',
            defaultDurationSec: 1.5,
            actionFn: async () => {
              rawClockSec += 0.3; // Visual action takes 0.3s -> waits 1.2s, wakes early -15ms
            },
            narrationText: 'Scene one part B.',
          });

          // Note: after early wakeup (-15ms), audioCursorSec > nowEffectiveSec!
          // runSceneWithPadding will wait out the remaining 15ms so speech isn't cut off.
        },
        buildSceneAudio: () => {
          sceneAudios[0] = combineSynthesizeResults([
            scene1Map.get('s1_a')!,
            scene1Map.get('s1_b')!,
          ]);
        },
        getSceneAudio: () => sceneAudios[0],
        setSceneAudio: (a) => {
          sceneAudios[0] = a;
        },
      });

      expect(scene1Timing.endMs).toBeGreaterThan(scene1Timing.startMs);
      // Verify scene 1 waited for the remaining ~15ms after early wakeup
      expect(waitCalls[2]).toBeCloseTo(0.015, 3);

      // Inter-scene visual transition pause (+250ms)
      rawClockSec += 0.25;

      // --- Scene 2: Mid-segment 10x acceleration (10s raw -> 1.0s effective) with 2.5s 1x speech ---
      await controller.runSceneWithPadding({
        sceneIdx: 1,
        targetDurationSec: 4.0,
        sceneNarration: 'Scene 2 fallback (unused)',
        actionFn: async () => {
          await controller.runSegment({
            segAudioMap: scene2Map,
            key: 's2_turn',
            defaultDurationSec: 2.5,
            actionFn: async () => {
              const accelStart = rawClockSec;
              rawClockSec += 10.0; // 10s live turn wait
              accelerationIntervals.push({
                startSec: accelStart,
                endSec: rawClockSec,
                speedFactor: 10,
              });
            },
            narrationText: 'Running multi-agent analysis.',
          });

          // Post-segment visual settle (+180ms) before scene end -> absorbed by scene trailing gapSilence
          rawClockSec += 0.18;
        },
        buildSceneAudio: () => {
          sceneAudios[1] = combineSynthesizeResults([scene2Map.get('s2_turn')!]);
        },
        getSceneAudio: () => sceneAudios[1],
        setSceneAudio: (a) => {
          sceneAudios[1] = a;
        },
      });

      // --- Scene 3: No segments, fallback scene-level narration cue must be remapped to effective coordinates ---
      const scene3StartRaw = rawClockSec;
      await controller.runSceneWithPadding({
        sceneIdx: 2,
        targetDurationSec: 2.0,
        sceneNarration: 'Closing summary.',
        actionFn: async () => {
          rawClockSec += 1.0;
        },
        buildSceneAudio: () => {
          // No audio for scene 3 -> uses scene fallback cue path
        },
        getSceneAudio: () => sceneAudios[2],
        setSceneAudio: (a) => {
          sceneAudios[2] = a;
        },
      });

      // 1. Verify total PCM duration matches final effective video duration at end of Scene 2 (last TTS scene)
      const totalTtsPcm = Buffer.concat([
        initialSilencePcm,
        sceneAudios[0]!.pcmBuffer,
        sceneAudios[1]!.pcmBuffer,
      ]);
      const totalTtsDurationSec = calculateAudioDuration(totalTtsPcm.length, 24000);
      const effectiveAtScene2End = remapSec(scene3StartRaw);
      expect(totalTtsDurationSec).toBe(controller.getAudioCursorSec());
      expect(Math.abs(totalTtsDurationSec - effectiveAtScene2End)).toBeLessThanOrEqual(1 / 24000);

      // 2. Verify 1x subtitle duration preserved on Scene 2 despite 10x acceleration
      const cues: TimelineSubtitleCue[] = controller.getSubtitleCues();
      expect(cues).toHaveLength(4);
      const s2Cue = cues[2];
      expect(s2Cue.text).toBe('Running multi-agent analysis.');
      expect(s2Cue.endTimeMs - s2Cue.startTimeMs).toBe(2500);

      // 3. Verify fallback cue for Scene 3 is in effective (remapped) coordinates, NOT raw coordinates
      const s3Cue = cues[3];
      expect(s3Cue.text).toBe('Closing summary.');
      expect(s3Cue.startTimeMs).toBe(Math.round(remapSec(scene3StartRaw) * 1000));
      expect(s3Cue.startTimeMs).toBeLessThan(Math.round(scene3StartRaw * 1000) - 8000); // 9s saved by 10x accel

      // 4. Verify SRT generation succeeds and returned array is defensively copied
      const srt = generateSrt(cues);
      expect(srt).toContain('Scene one part A.');
      expect(srt).toContain('Running multi-agent analysis.');
      expect(srt).toContain('Closing summary.');
      cues.push({ startTimeMs: 0, endTimeMs: 1, text: 'mutated' });
      expect(controller.getSubtitleCues()).toHaveLength(4);
    });

    it('handles --skip-tts with 0ms action so cues pass generateSrt without InvalidCueError and applies minPadding', async () => {
      let rawClockSec = 0;
      const waitCalls: number[] = [];

      const controller = createTimelineSyncController({
        initialSilencePcm: Buffer.alloc(0),
        skipTts: true,
        nowSec: () => rawClockSec,
        waitSec: async (sec: number) => {
          waitCalls.push(sec);
          rawClockSec += sec;
        },
        remapSec: (s) => s,
      });

      const emptyMap = new Map<string, SynthesizeResult>();

      await controller.runSceneWithPadding({
        sceneIdx: 0,
        targetDurationSec: 3.0,
        sceneNarration: 'Scene 0 fallback',
        actionFn: async () => {
          // 0ms action with defaultDurationSec = 0 -> start === end before 100ms floor
          await controller.runSegment({
            segAudioMap: emptyMap,
            key: 'zero_ms',
            defaultDurationSec: 0,
            actionFn: async () => {},
            narrationText: 'Instant step.',
          });
        },
        buildSceneAudio: () => {},
        getSceneAudio: () => undefined,
        setSceneAudio: () => {},
      });

      // Scene 0 in skipTts uses minPadding = 5.5
      expect(waitCalls).toContain(5.5);

      await controller.runSceneWithPadding({
        sceneIdx: 1,
        targetDurationSec: 2.0,
        sceneNarration: 'Scene 1 fallback narration.',
        actionFn: async () => {},
        buildSceneAudio: () => {},
        getSceneAudio: () => undefined,
        setSceneAudio: () => {},
      });

      // Scene > 0 in skipTts uses minPadding = 4.0
      expect(waitCalls).toContain(4.0);

      const cues = controller.getSubtitleCues();
      expect(cues).toHaveLength(2);
      expect(cues[0].endTimeMs - cues[0].startTimeMs).toBeGreaterThanOrEqual(100);
      expect(cues[1].text).toBe('Scene 1 fallback narration.');

      const srt = generateSrt(cues);
      expect(srt).toContain('Instant step.');
      expect(srt).toContain('Scene 1 fallback narration.');
    });

    it('aligns non-segmented monolithic sceneAudio and syncs seamlessly with a subsequent segmented scene', async () => {
      const initialSilencePcm = createSilencePcm(0.5);
      let rawClockSec = 0.5;
      const waitCalls: number[] = [];

      const controller = createTimelineSyncController({
        initialSilencePcm,
        sampleRate: 24000,
        skipTts: false,
        nowSec: () => rawClockSec,
        waitSec: async (sec: number) => {
          waitCalls.push(sec);
          // Inject +30ms wait overshoot on the monolithic scene wait
          const overshoot = waitCalls.length === 1 ? 0.03 : 0;
          rawClockSec += sec + overshoot;
        },
        remapSec: (s) => s,
      });

      // Inter-scene pause before monolithic scene 1 (+250ms)
      rawClockSec += 0.25;

      const sceneAudios: (SynthesizeResult | undefined)[] = [
        makeAudio(2.0, 0x61), // Monolithic 2.0s audio for Scene 1 (no runSegment calls)
        undefined,
      ];
      const scene2Map = new Map<string, SynthesizeResult>([
        ['s2_seg1', makeAudio(1.5, 0x62)],
      ]);

      // Scene 1: monolithic sceneAudio (no runSegment called)
      await controller.runSceneWithPadding({
        sceneIdx: 0,
        targetDurationSec: 3.0,
        sceneNarration: 'Monolithic intro narration.',
        actionFn: async () => {
          rawClockSec += 0.4; // Visual action takes 0.4s < 2.0s audio -> must wait 1.6s
        },
        buildSceneAudio: () => {},
        getSceneAudio: () => sceneAudios[0],
        setSceneAudio: (a) => {
          sceneAudios[0] = a;
        },
      });

      // Should have waited 1.6s for the monolithic audio to finish
      expect(waitCalls[0]).toBeCloseTo(1.6, 5);

      // Inter-scene gap (+200ms) before segmented Scene 2
      rawClockSec += 0.2;

      // Scene 2: segmented scene following the monolithic scene
      await controller.runSceneWithPadding({
        sceneIdx: 1,
        targetDurationSec: 2.0,
        sceneNarration: 'Scene 2 fallback (unused)',
        actionFn: async () => {
          await controller.runSegment({
            segAudioMap: scene2Map,
            key: 's2_seg1',
            defaultDurationSec: 1.5,
            actionFn: async () => {
              rawClockSec += 0.5;
            },
            narrationText: 'Segmented follow-up.',
          });
        },
        buildSceneAudio: () => {
          sceneAudios[1] = combineSynthesizeResults([scene2Map.get('s2_seg1')!]);
        },
        getSceneAudio: () => sceneAudios[1],
        setSceneAudio: (a) => {
          sceneAudios[1] = a;
        },
      });

      // Total PCM across initialSilence + monolithic scene 1 + segmented scene 2 matches rawClockSec within 1/24000s
      const totalPcm = Buffer.concat([
        initialSilencePcm,
        sceneAudios[0]!.pcmBuffer,
        sceneAudios[1]!.pcmBuffer,
      ]);
      const totalPcmDurationSec = calculateAudioDuration(totalPcm.length, 24000);
      expect(totalPcmDurationSec).toBeCloseTo(controller.getAudioCursorSec(), 12);
      expect(Math.abs(totalPcmDurationSec - rawClockSec)).toBeLessThanOrEqual(1 / 24000);

      // Fallback cue for Scene 1 matches the aligned speech window [0.75s, 2.75s] (2000ms), NOT stretched by overshoot
      const cues = controller.getSubtitleCues();
      expect(cues).toHaveLength(2);
      expect(cues[0]).toEqual({
        startTimeMs: 750,
        endTimeMs: 2750,
        text: 'Monolithic intro narration.',
      });
      expect(cues[1].text).toBe('Segmented follow-up.');
      expect(cues[1].endTimeMs - cues[1].startTimeMs).toBe(1500);
    });

    it('honors skipTts: true inside runSegment without mutating a populated segAudioMap or advancing audioCursorSec', async () => {
      let rawClockSec = 1.0;
      const waitCalls: number[] = [];
      const initialSilencePcm = createSilencePcm(1.0);

      const controller = createTimelineSyncController({
        initialSilencePcm,
        sampleRate: 24000,
        skipTts: true,
        nowSec: () => rawClockSec,
        waitSec: async (sec: number) => {
          waitCalls.push(sec);
          rawClockSec += sec;
        },
        remapSec: (s) => s,
      });

      const originalAudio = makeAudio(3.0, 0x77);
      const populatedMap = new Map<string, SynthesizeResult>([['seg_a', originalAudio]]);

      await controller.runSegment({
        segAudioMap: populatedMap,
        key: 'seg_a',
        defaultDurationSec: 0.5,
        actionFn: async () => {
          rawClockSec += 0.1;
        },
        narrationText: 'Skip TTS segment.',
      });

      // Must ignore segAudioMap entry (3.0s) and wait only defaultDurationSec - elapsed (0.4s)
      expect(waitCalls).toEqual([expect.closeTo(0.4, 5)]);
      expect(populatedMap.get('seg_a')).toBe(originalAudio);
      expect(controller.getAudioCursorSec()).toBe(1.0);
      expect(controller.getSubtitleCues()).toEqual([
        { startTimeMs: 1000, endTimeMs: 1500, text: 'Skip TTS segment.' },
      ]);
    });

    it('accounts for prior-segment audioCursorSec overrun in runSegment wait target after early wakeup', async () => {
      let rawClockSec = 0;
      const waitCalls: number[] = [];
      let firstWait = true;

      const controller = createTimelineSyncController({
        initialSilencePcm: Buffer.alloc(0),
        sampleRate: 24000,
        skipTts: false,
        nowSec: () => rawClockSec,
        waitSec: async (sec: number) => {
          waitCalls.push(sec);
          if (firstWait) {
            firstWait = false;
            // Wake up 400ms early so audioCursorSec (2.0s) outruns rawClockSec (1.6s)
            rawClockSec += Math.max(0, sec - 0.4);
          } else {
            rawClockSec += sec;
          }
        },
        remapSec: (s) => s,
      });

      const segMap = new Map<string, SynthesizeResult>([
        ['seg_1', makeAudio(2.0, 0x11)],
        ['seg_2', makeAudio(1.0, 0x22)],
      ]);

      // Seg 1: starts at 0.0s, action 0.5s, waits 1.5s -> wakes early at 1.6s; audioCursorSec = 2.0s
      await controller.runSegment({
        segAudioMap: segMap,
        key: 'seg_1',
        defaultDurationSec: 2.0,
        actionFn: async () => {
          rawClockSec += 0.5;
        },
        narrationText: 'First segment.',
      });

      expect(rawClockSec).toBeCloseTo(1.6, 5);
      expect(controller.getAudioCursorSec()).toBeCloseTo(2.0, 5);

      // Seg 2: starts at 1.6s (< audioCursorSec 2.0s), action 0.1s -> nowSec = 1.7s
      // Speech starts at 2.0s and lasts 1.0s (ends 3.0s) -> must wait 3.0 - 1.7 = 1.3s!
      await controller.runSegment({
        segAudioMap: segMap,
        key: 'seg_2',
        defaultDurationSec: 1.0,
        actionFn: async () => {
          rawClockSec += 0.1;
        },
        narrationText: 'Second segment.',
      });

      expect(waitCalls[1]).toBeCloseTo(1.3, 5);
      expect(rawClockSec).toBeCloseTo(3.0, 5);
      expect(controller.getAudioCursorSec()).toBeCloseTo(3.0, 5);
      expect(controller.getSubtitleCues()[1]).toEqual({
        startTimeMs: 2000,
        endTimeMs: 3000,
        text: 'Second segment.',
      });
    });
  });
});




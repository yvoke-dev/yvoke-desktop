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
  type SynthesizeResult,
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
});




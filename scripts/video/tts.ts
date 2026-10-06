/**
 * Audio & TTS pipeline for demo video generation.
 * Generates WAV headers and synthesizes speech using Gemini Multimodal Audio API.
 */

export class InvalidPcmDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPcmDataError';
  }
}

export class TtsSynthesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsSynthesisError';
  }
}

export class TtsQuotaExceededError extends TtsSynthesisError {
  constructor(message: string) {
    super(message);
    this.name = 'TtsQuotaExceededError';
  }
}

export class TtsAuthenticationError extends TtsSynthesisError {
  constructor(message: string) {
    super(message);
    this.name = 'TtsAuthenticationError';
  }
}

/**
 * Redacts ?key=... or &key=... from URLs and error strings.
 */
export function redactApiKey(str: string): string {
  return str.replace(/([?&]key=)[^&\s]+/g, '$1[REDACTED]');
}

/**
 * Creates an exact 44-byte RIFF/WAVE header for PCM audio.
 * Default format: 24kHz, 16-bit, Mono PCM.
 */
export function createWavHeader(
  pcmByteLength: number,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16,
): Buffer {
  if (pcmByteLength % 2 !== 0) {
    throw new InvalidPcmDataError(
      `PCM byte length must be an even number for 16-bit audio, got ${pcmByteLength}`,
    );
  }

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(36 + pcmByteLength, 4); // ChunkSize
  header.write('WAVE', 8, 4, 'ascii');

  // "fmt " subchunk
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  header.writeUInt16LE(numChannels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // "data" subchunk
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(pcmByteLength, 40); // Subchunk2Size

  return header;
}

/**
 * Calculates audio duration in seconds for 24kHz 16-bit Mono PCM.
 */
export function calculateAudioDuration(
  pcmByteLength: number,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16,
): number {
  if (pcmByteLength % 2 !== 0) {
    throw new InvalidPcmDataError(
      `PCM byte length must be an even number for 16-bit audio, got ${pcmByteLength}`,
    );
  }
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  return pcmByteLength / byteRate;
}

/**
 * Prepends a 44-byte WAV header to raw PCM buffer.
 */
export function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000): Buffer {
  if (pcmBuffer.length % 2 !== 0) {
    throw new InvalidPcmDataError(
      `PCM buffer length must be an even number for 16-bit audio, got ${pcmBuffer.length}`,
    );
  }
  const header = createWavHeader(pcmBuffer.length, sampleRate);
  return Buffer.concat([header, pcmBuffer]);
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SynthesizeOptions {
  apiKey?: string;
  voiceName?: string;
  model?: string;
  fetchFn?: typeof fetch;
  cacheDir?: string | null;
  maxRetries?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface SynthesizeResult {
  pcmBuffer: Buffer;
  wavBuffer: Buffer;
  durationSeconds: number;
}

/**
 * Synthesizes speech from text using the Gemini Multimodal Audio API.
 * Never logs raw audio buffers or base64 data to stdout/stderr.
 * Automatically caches synthesized audio to disk and retries on HTTP 429.
 */
export async function synthesizeSpeech(
  text: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TtsAuthenticationError('GEMINI_API_KEY is required for speech synthesis');
  }

  const model =
    options.model ??
    process.env.GEMINI_TTS_MODEL ??
    'gemini-3.8-flash-tts';
  const voiceName = options.voiceName ?? 'Puck';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const fetcher = options.fetchFn ?? fetch;

  // 1. Disk caching check: default to temp dir for production, null when fetchFn is mocked
  const cacheDir =
    options.cacheDir !== undefined
      ? options.cacheDir
      : options.fetchFn
        ? null
        : path.join(os.tmpdir(), 'yvoke-tts-cache');

  let cacheFilePath: string | null = null;
  if (cacheDir) {
    try {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const hash = crypto
        .createHash('sha256')
        .update(`${model}_${voiceName}_${text}`)
        .digest('hex');
      cacheFilePath = path.join(cacheDir, `${hash}.pcm`);
      if (fs.existsSync(cacheFilePath)) {
        const fileBuffer = fs.readFileSync(cacheFilePath);
        const { pcmBuffer: purePcm, sampleRate } = extractPcmFromAudioBuffer(fileBuffer);
        const pcmBuffer = applyMicroFade(purePcm, 5, sampleRate);
        const durationSeconds = calculateAudioDuration(pcmBuffer.length, sampleRate);
        const wavBuffer = pcmToWav(pcmBuffer, sampleRate);
        return { pcmBuffer, wavBuffer, durationSeconds };
      }
    } catch {
      cacheFilePath = null;
    }
  }

  const payload = {
    contents: [
      {
        parts: [{ text }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName,
          },
        },
      },
    },
  };

  const maxRetries = options.maxRetries ?? (options.fetchFn ? 0 : 3);
  const sleep =
    options.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      const safeMsg = redactApiKey(err?.message ?? 'Network error');
      throw new TtsSynthesisError(`TTS synthesis request failed: ${safeMsg}`);
    }

    if (!response.ok) {
      let errBody = '';
      try {
        errBody = await response.text();
      } catch {
        errBody = response.statusText;
      }
      const safeErrBody = redactApiKey(errBody);

      // Prioritize 429 quota before any auth checks
      if (response.status === 429) {
        if (attempt < maxRetries) {
          let delayMs = 15000;
          const matchDetails = safeErrBody.match(/"retryDelay":\s*"(\d+)s"/i);
          const matchMsg = safeErrBody.match(/retry in ([\d\.]+)s/i);
          if (matchDetails) {
            delayMs = parseInt(matchDetails[1], 10) * 1000;
          } else if (matchMsg) {
            delayMs = Math.ceil(parseFloat(matchMsg[1])) * 1000;
          }
          await sleep(delayMs);
          continue;
        }
        throw new TtsQuotaExceededError(
          `TTS rate limit exceeded (HTTP 429): ${safeErrBody}`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new TtsAuthenticationError(
          `TTS authentication failed (HTTP ${response.status}): ${safeErrBody}`,
        );
      }
      throw new TtsSynthesisError(
        `TTS request failed with status ${response.status}: ${safeErrBody}`,
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      throw new TtsSynthesisError(`Failed to parse TTS JSON response: ${err.message}`);
    }

    if (!data?.candidates || data.candidates.length === 0) {
      const reason = data?.promptFeedback?.blockReason ?? 'Empty candidates array';
      throw new TtsSynthesisError(`TTS synthesis blocked or empty response: ${reason}`);
    }

    const part = data.candidates[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
    if (!part?.inlineData?.data) {
      const partsSummary = JSON.stringify(
        data.candidates[0]?.content?.parts?.map((p: any) => ({
          keys: Object.keys(p),
          textSample: p.text ? p.text.slice(0, 80) : undefined,
        })),
      );
      throw new TtsSynthesisError(
        `TTS synthesis response did not contain audio inlineData. Received parts: ${partsSummary}`,
      );
    }

    const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
    const { pcmBuffer: purePcm, sampleRate } = extractPcmFromAudioBuffer(rawBuffer);

    // Save pure PCM to disk cache if path is valid
    if (cacheFilePath) {
      try {
        fs.writeFileSync(cacheFilePath, purePcm);
      } catch {
        // Ignore cache write failure
      }
    }

    const pcmBuffer = applyMicroFade(purePcm, 5, sampleRate);
    const durationSeconds = calculateAudioDuration(pcmBuffer.length, sampleRate);
    const wavBuffer = pcmToWav(pcmBuffer, sampleRate);

    return {
      pcmBuffer,
      wavBuffer,
      durationSeconds,
    };
  }

  throw new TtsSynthesisError('TTS synthesis failed after all retries');
}

/**
 * Linearly concatenates multiple SynthesizeResult items into a unified SynthesizeResult.
 */
export function combineSynthesizeResults(results: SynthesizeResult[]): SynthesizeResult {
  if (results.length === 0) {
    const emptyPcm = Buffer.alloc(0);
    return {
      pcmBuffer: emptyPcm,
      wavBuffer: pcmToWav(emptyPcm),
      durationSeconds: 0,
    };
  }

  const pcmBuffer = Buffer.concat(results.map((r) => r.pcmBuffer));
  const wavBuffer = pcmToWav(pcmBuffer);
  const durationSeconds = calculateAudioDuration(pcmBuffer.length);

  return {
    pcmBuffer,
    wavBuffer,
    durationSeconds,
  };
}

/**
 * Generates a zero-filled PCM buffer corresponding to a given duration.
 * Ensures the buffer length is an even number for 16-bit audio.
 */
export function createSilencePcm(
  durationSec: number,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16,
): Buffer {
  if (durationSec <= 0) {
    return Buffer.alloc(0);
  }
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  let byteLength = Math.round(durationSec * byteRate);
  if (byteLength % 2 !== 0) {
    byteLength += 1;
  }
  return Buffer.alloc(byteLength, 0);
}

/**
 * Creates a SynthesizeResult containing pure silence of the specified duration.
 */
export function createSilenceResult(durationSec: number, sampleRate = 24000): SynthesizeResult {
  const pcmBuffer = createSilencePcm(durationSec, sampleRate);
  const wavBuffer = pcmToWav(pcmBuffer, sampleRate);
  const durationSeconds = calculateAudioDuration(pcmBuffer.length, sampleRate);
  return {
    pcmBuffer,
    wavBuffer,
    durationSeconds,
  };
}

/**
 * Extends a SynthesizeResult with trailing silence up to targetDurationSec.
 * If current duration is already >= targetDurationSec, returns original unchanged.
 */
export function padSynthesizeResult(
  result: SynthesizeResult,
  targetDurationSec: number,
  sampleRate = 24000,
): SynthesizeResult {
  if (result.durationSeconds >= targetDurationSec) {
    return result;
  }
  const neededSec = targetDurationSec - result.durationSeconds;
  const silencePcm = createSilencePcm(neededSec, sampleRate);
  const pcmBuffer = Buffer.concat([result.pcmBuffer, silencePcm]);
  const wavBuffer = pcmToWav(pcmBuffer, sampleRate);
  const durationSeconds = calculateAudioDuration(pcmBuffer.length, sampleRate);
  return {
    pcmBuffer,
    wavBuffer,
    durationSeconds,
  };
}

/**
 * Extracts pure raw PCM audio samples from an audio buffer.
 * If the buffer contains a RIFF/WAVE container (as returned by Gemini Multimodal Audio API),
 * this locates the 'data' chunk and returns only the genuine PCM audio bytes,
 * stripping the 44-byte RIFF/WAVE header and any trailing metadata chunks
 * (such as C2PA provenance / SynthID digital source type metadata).
 * If the buffer is already raw PCM, it returns the buffer intact.
 */
export function extractPcmFromAudioBuffer(
  buffer: Buffer,
): { pcmBuffer: Buffer; sampleRate: number } {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return { pcmBuffer: buffer, sampleRate: 24000 };
  }

  let offset = 12;
  let sampleRate = 24000;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      if (offset + 16 <= buffer.length) {
        sampleRate = buffer.readUInt32LE(offset + 12);
      }
    } else if (chunkId === 'data') {
      const dataStart = offset + 8;
      const dataEnd = Math.min(buffer.length, dataStart + chunkSize);
      const pcmBuffer = buffer.subarray(dataStart, dataEnd);
      return { pcmBuffer, sampleRate };
    }

    offset += 8 + chunkSize;
    // Word align per RIFF standard
    if (chunkSize % 2 !== 0) {
      offset++;
    }
  }

  return { pcmBuffer: buffer, sampleRate };
}

/**
 * Applies a short linear fade-in and fade-out to a 16-bit mono PCM buffer
 * to eliminate pops, clicks, and boundary discontinuities.
 */
export function applyMicroFade(
  pcmBuffer: Buffer,
  fadeMs = 5,
  sampleRate = 24000,
): Buffer {
  if (pcmBuffer.length < 4) return pcmBuffer;
  const numSamples = Math.floor(pcmBuffer.length / 2);
  const fadeSamples = Math.min(
    Math.floor(numSamples / 2),
    Math.round((fadeMs / 1000) * sampleRate),
  );
  if (fadeSamples <= 0) return pcmBuffer;

  const result = Buffer.from(pcmBuffer);

  // Fade in
  for (let i = 0; i < fadeSamples; i++) {
    const factor = i / fadeSamples;
    const sample = result.readInt16LE(i * 2);
    result.writeInt16LE(Math.round(sample * factor), i * 2);
  }

  // Fade out
  for (let i = 0; i < fadeSamples; i++) {
    const factor = i / fadeSamples;
    const sampleIndex = numSamples - 1 - i;
    const sample = result.readInt16LE(sampleIndex * 2);
    result.writeInt16LE(Math.round(sample * factor), sampleIndex * 2);
  }

  return result;
}




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

export interface SynthesizeOptions {
  apiKey?: string;
  voiceName?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export interface SynthesizeResult {
  pcmBuffer: Buffer;
  wavBuffer: Buffer;
  durationSeconds: number;
}

/**
 * Synthesizes speech from text using the Gemini Multimodal Audio API.
 * Never logs raw audio buffers or base64 data to stdout/stderr.
 */
export async function synthesizeSpeech(
  text: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TtsAuthenticationError('GEMINI_API_KEY is required for speech synthesis');
  }

  const model = options.model ?? 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const fetcher = options.fetchFn ?? fetch;

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
            voiceName: options.voiceName ?? 'Puck',
          },
        },
      },
    },
  };

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
    throw new TtsSynthesisError('TTS synthesis response did not contain audio inlineData');
  }

  const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
  const durationSeconds = calculateAudioDuration(pcmBuffer.length);
  const wavBuffer = pcmToWav(pcmBuffer);

  return {
    pcmBuffer,
    wavBuffer,
    durationSeconds,
  };
}

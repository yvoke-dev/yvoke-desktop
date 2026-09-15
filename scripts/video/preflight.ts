/**
 * Preflight verification checks for automated Yvoke demo video generation.
 * Validates build artifacts, backend connectivity, Claude CLI auth, and Gemini TTS API key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultSpawnRunner, type RunnerFn } from './stitch';

export interface PreflightOptions {
  backendUrl?: string;
  skipTts?: boolean;
  fetchFn?: typeof fetch;
  runner?: RunnerFn;
  mainEntry?: string;
  apiKey?: string;
}

/**
 * Checks whether backend is running and serving expected API JSON rather than HTML SSO captive portal.
 */
export async function probeBackend(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const normalizedUrl = url.replace(/\/+$/, '');
  const endpoint = `${normalizedUrl}/api/chat/v1/prompts/default-chat`;

  let res: Response;
  let bodyText: string;

  try {
    res = await fetchFn(endpoint, { method: 'GET' });
    bodyText = await res.text();
  } catch (err: any) {
    const isConnRefused =
      err?.code === 'ECONNREFUSED' ||
      err?.cause?.code === 'ECONNREFUSED' ||
      (typeof err?.message === 'string' && err.message.includes('ECONNREFUSED'));

    if (isConnRefused) {
      throw new Error(
        `Docker backend is not running at ${normalizedUrl}. Please start it with docker compose up -d`,
      );
    }
    throw err;
  }

  const contentType = res.headers?.get?.('content-type') ?? '';
  const trimmed = bodyText.trim().toLowerCase();
  const isHtml =
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype html>') ||
    trimmed.startsWith('<html');

  if (isHtml) {
    throw new Error(
      `Received HTML response (possible SSO login or captive portal) instead of expected Yvoke API JSON from ${endpoint}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Backend returned HTTP status ${res.status} (${res.statusText}) from ${endpoint}`,
    );
  }
}

/**
 * Validates whether Claude CLI is installed and has active credentials.
 */
export async function probeClaudeCli(runner: RunnerFn = defaultSpawnRunner): Promise<void> {
  const guidance = "Claude CLI credentials not found or expired. Please run 'claude /login'";
  try {
    const res = await runner('claude', ['--version']);
    const output = `${res.stdout} ${res.stderr}`.toLowerCase();
    const hasAuthError =
      output.includes('not logged in') ||
      output.includes('expired') ||
      output.includes('invalid') ||
      output.includes('unauthorized') ||
      output.includes('login required');

    if (res.code !== 0 || hasAuthError) {
      throw new Error(guidance);
    }
  } catch {
    throw new Error(guidance);
  }
}

/**
 * Verifies that Electron main process build artifact exists before launching video recording.
 */
export function checkBuildArtifacts(mainPath: string = path.resolve(process.cwd(), 'out/main/index.js')): void {
  if (!fs.existsSync(mainPath)) {
    throw new Error(
      "Build artifacts missing (out/main/index.js not found). Please run 'npm run build'",
    );
  }
}

/**
 * Validates presence of Gemini API key when TTS voice narration is requested.
 */
export function checkGeminiApiKey(apiKey?: string): string {
  const candidate = apiKey ?? process.env.GEMINI_API_KEY;
  if (!candidate || candidate.trim() === '' || candidate === 'your_gemini_api_key_here') {
    throw new Error(
      'GEMINI_API_KEY is required for voice narration.\nPlease add your key to .env (or export GEMINI_API_KEY), or pass --skip-tts to record video without audio.',
    );
  }
  return candidate;
}

/**
 * Generates a soft procedural ambient synth WAV buffer as a music fallback.
 */
export function createProceduralAmbientWav(durationSeconds = 60, sampleRate = 44100): Buffer {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF chunk descriptor
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');

  // "fmt " sub-chunk
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20);  // AudioFormat 1 = PCM
  buffer.writeUInt16LE(1, 22);  // NumChannels 1 = Mono
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32);  // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  // Gentle ambient progression (A minor 9 / A suspended: 110Hz, 164.81Hz, 220Hz, 261.63Hz)
  const f1 = 110.0;
  const f2 = 164.81;
  const f3 = 220.0;
  const f4 = 261.63;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const lfo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.08 * t);
    const val =
      (0.35 * Math.sin(2 * Math.PI * f1 * t) +
       0.25 * Math.sin(2 * Math.PI * f2 * t) +
       0.25 * Math.sin(2 * Math.PI * f3 * t) +
       0.15 * Math.sin(2 * Math.PI * f4 * t)) * lfo;

    const sample = Math.floor(val * 2400); // Soft -22dB volume
    const clamped = Math.max(-32768, Math.min(32767, sample));
    buffer.writeInt16LE(clamped, 44 + i * 2);
  }

  return buffer;
}

/**
 * Executes all video orchestrator preflight checks concurrently or sequentially before launching.
 */
export async function runAllPreflightChecks(options: PreflightOptions = {}): Promise<void> {
  const mainEntry = options.mainEntry ?? path.resolve(process.cwd(), 'out/main/index.js');
  checkBuildArtifacts(mainEntry);

  if (!options.skipTts) {
    checkGeminiApiKey(options.apiKey);
  }

  const backendUrl = options.backendUrl ?? process.env.YVOKE_SERVER_URL ?? 'http://127.0.0.1:8000';
  await probeBackend(backendUrl, options.fetchFn);

  await probeClaudeCli(options.runner);
}

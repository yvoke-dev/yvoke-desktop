import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  probeBackend,
  probeClaudeCli,
  checkBuildArtifacts,
  checkGeminiApiKey,
  createProceduralAmbientWav,
  runAllPreflightChecks,
} from '../scripts/video/preflight';
import type { RunnerFn } from '../scripts/video/stitch';

describe('videoOrchestratorPreflight', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('probeBackend', () => {
    it('succeeds when backend returns 200 with application/json', async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: vi.fn().mockResolvedValue('{"status":"ok"}'),
      } as unknown as Response);

      await expect(probeBackend('http://localhost:8080', mockFetch)).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/api/chat/v1/prompts/system/default-chat',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer dev-local-token',
          }),
        }),
      );
    });

    it('strips trailing slash from backend url correctly', async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: vi.fn().mockResolvedValue('{}'),
      } as unknown as Response);

      await probeBackend('http://127.0.0.1:8080/', mockFetch);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/api/chat/v1/prompts/system/default-chat',
        expect.any(Object),
      );
    });

    it('throws actionable startup guidance when connection is ECONNREFUSED', async () => {
      const connRefusedErr = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      (connRefusedErr as any).code = 'ECONNREFUSED';

      const mockFetch: typeof fetch = vi.fn().mockRejectedValue(connRefusedErr);

      await expect(probeBackend('http://127.0.0.1:8000', mockFetch)).rejects.toThrow(
        /Docker backend is not running at http:\/\/127\.0\.0\.1:8000.*docker compose up -d/i,
      );
    });

    it('throws actionable startup guidance when fetch failed with cause ECONNREFUSED', async () => {
      const cause = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      (cause as any).code = 'ECONNREFUSED';
      const fetchFailedErr = new TypeError('fetch failed');
      (fetchFailedErr as any).cause = cause;

      const mockFetch: typeof fetch = vi.fn().mockRejectedValue(fetchFailedErr);

      await expect(probeBackend('http://127.0.0.1:8000', mockFetch)).rejects.toThrow(
        /Docker backend is not running at http:\/\/127\.0\.0\.1:8000.*docker compose up -d/i,
      );
    });

    it('throws descriptive error when HTTP 200 returns HTML content-type (SSO / captive portal)', async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: vi.fn().mockResolvedValue('<!DOCTYPE html><html><body>SSO Login</body></html>'),
      } as unknown as Response);

      await expect(probeBackend('http://127.0.0.1:8000', mockFetch)).rejects.toThrow(
        /Received HTML response \(possible SSO login or captive portal\) instead of expected Yvoke API JSON/i,
      );
    });

    it('throws descriptive error when body starts with HTML doctype even without header', async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: vi.fn().mockResolvedValue('<!DOCTYPE html>\n<html><head><title>Login</title></head></html>'),
      } as unknown as Response);

      await expect(probeBackend('http://127.0.0.1:8000', mockFetch)).rejects.toThrow(
        /Received HTML response \(possible SSO login or captive portal\) instead of expected Yvoke API JSON/i,
      );
    });

    it('throws descriptive error with status when status is not 200 (e.g. 500)', async () => {
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: vi.fn().mockResolvedValue('{"error":"Internal Error"}'),
      } as unknown as Response);

      await expect(probeBackend('http://127.0.0.1:8000', mockFetch)).rejects.toThrow(
        /Backend returned HTTP status 500 \(Internal Server Error\)/i,
      );
    });
  });

  describe('probeClaudeCli', () => {
    it('succeeds when claude runner exits with code 0', async () => {
      const mockRunner: RunnerFn = vi.fn().mockResolvedValue({
        code: 0,
        stdout: 'claude-cli 1.0.0\n',
        stderr: '',
      });

      await expect(probeClaudeCli(mockRunner)).resolves.toBeUndefined();
      expect(mockRunner).toHaveBeenCalledWith('claude', ['--version']);
    });

    it('throws actionable guidance when claude runner returns non-zero code', async () => {
      const mockRunner: RunnerFn = vi.fn().mockResolvedValue({
        code: 1,
        stdout: '',
        stderr: 'Error: not logged in',
      });

      await expect(probeClaudeCli(mockRunner)).rejects.toThrow(
        /Claude CLI credentials not found or expired\. Please run 'claude \/login'/i,
      );
    });

    it('throws actionable guidance when claude runner process fails to spawn', async () => {
      const mockRunner: RunnerFn = vi.fn().mockRejectedValue(new Error('spawn claude ENOENT'));

      await expect(probeClaudeCli(mockRunner)).rejects.toThrow(
        /Claude CLI credentials not found or expired\. Please run 'claude \/login'/i,
      );
    });

    it('throws actionable guidance when output indicates expired session token', async () => {
      const mockRunner: RunnerFn = vi.fn().mockResolvedValue({
        code: 0,
        stdout: 'Session expired or token invalid',
        stderr: '',
      });

      await expect(probeClaudeCli(mockRunner)).rejects.toThrow(
        /Claude CLI credentials not found or expired\. Please run 'claude \/login'/i,
      );
    });
  });

  describe('checkBuildArtifacts', () => {
    it('succeeds when main entry file exists', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      expect(() => checkBuildArtifacts('/mock/out/main/index.js')).not.toThrow();
    });

    it('throws actionable build instructions when build artifacts are missing', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(() => checkBuildArtifacts('/mock/out/main/index.js')).toThrow(
        /Build artifacts missing \(out\/main\/index\.js not found\)\. Please run 'npm run build'/i,
      );
    });
  });

  describe('checkGeminiApiKey', () => {
    it('returns the valid API key provided via argument', () => {
      const key = checkGeminiApiKey('valid-gemini-key-123');
      expect(key).toBe('valid-gemini-key-123');
    });

    it('returns the valid API key from process.env.GEMINI_API_KEY when no argument provided', () => {
      process.env.GEMINI_API_KEY = 'env-gemini-key-456';
      const key = checkGeminiApiKey();
      expect(key).toBe('env-gemini-key-456');
    });

    it('throws actionable guidance when API key is undefined or empty', () => {
      delete process.env.GEMINI_API_KEY;
      expect(() => checkGeminiApiKey()).toThrow(
        /GEMINI_API_KEY is required for voice narration[\s\S]*Please add your key to \.env[\s\S]*--skip-tts/i,
      );
    });

    it('throws actionable guidance when API key is default placeholder value', () => {
      process.env.GEMINI_API_KEY = 'your_gemini_api_key_here';
      expect(() => checkGeminiApiKey()).toThrow(
        /GEMINI_API_KEY is required for voice narration[\s\S]*Please add your key to \.env[\s\S]*--skip-tts/i,
      );
    });
  });

  describe('createProceduralAmbientWav', () => {
    it('creates a valid RIFF/WAVE header and PCM data with expected byte size', () => {
      const duration = 2;
      const sampleRate = 8000;
      const buf = createProceduralAmbientWav(duration, sampleRate);

      expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
      expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
      expect(buf.toString('ascii', 36, 40)).toBe('data');

      const expectedDataSize = duration * sampleRate * 2;
      expect(buf.length).toBe(44 + expectedDataSize);
      expect(buf.readUInt32LE(40)).toBe(expectedDataSize);
    });
  });

  describe('runAllPreflightChecks', () => {
    it('successfully runs all preflight checks when everything is valid', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: vi.fn().mockResolvedValue('{}'),
      } as unknown as Response);

      const mockRunner: RunnerFn = vi.fn().mockResolvedValue({
        code: 0,
        stdout: 'claude-cli 1.0.0',
        stderr: '',
      });

      await expect(
        runAllPreflightChecks({
          backendUrl: 'http://127.0.0.1:8000',
          skipTts: false,
          fetchFn: mockFetch,
          runner: mockRunner,
          mainEntry: '/mock/out/main/index.js',
          apiKey: 'test-api-key',
        }),
      ).resolves.toBeUndefined();
    });

    it('skips Gemini API key check when skipTts is true', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      delete process.env.GEMINI_API_KEY;

      const mockFetch: typeof fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: vi.fn().mockResolvedValue('{}'),
      } as unknown as Response);

      const mockRunner: RunnerFn = vi.fn().mockResolvedValue({
        code: 0,
        stdout: 'claude-cli 1.0.0',
        stderr: '',
      });

      await expect(
        runAllPreflightChecks({
          backendUrl: 'http://127.0.0.1:8080',
          skipTts: true,
          fetchFn: mockFetch,
          runner: mockRunner,
          mainEntry: '/mock/out/main/index.js',
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects if backend is down during runAllPreflightChecks', async () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      const connRefusedErr = new Error('ECONNREFUSED');
      (connRefusedErr as any).code = 'ECONNREFUSED';
      const mockFetch: typeof fetch = vi.fn().mockRejectedValue(connRefusedErr);

      await expect(
        runAllPreflightChecks({
          backendUrl: 'http://127.0.0.1:8080',
          skipTts: true,
          fetchFn: mockFetch,
          mainEntry: '/mock/out/main/index.js',
        }),
      ).rejects.toThrow(/Docker backend is not running at http:\/\/127\.0\.0\.1:8080/);
    });
  });

  describe('SCENE_NARRATIONS', () => {
    it('defines 8 dedicated scenes with correlated app and settings tours', async () => {
      const { SCENE_NARRATIONS } = await import('../scripts/generate-demo-video');
      expect(SCENE_NARRATIONS).toHaveLength(8);

      // Scene 1: App & Sidebar Overview
      expect(SCENE_NARRATIONS[0]).toMatch(/sidebar/i);
      expect(SCENE_NARRATIONS[0]).toMatch(/conversation/i);
      expect(SCENE_NARRATIONS[0]).toMatch(/search/i);
      expect(SCENE_NARRATIONS[0]).toMatch(/settings/i);

      // Scene 2: Settings Walkthrough
      expect(SCENE_NARRATIONS[1]).toMatch(/settings/i);
      expect(SCENE_NARRATIONS[1]).toMatch(/server/i);
      expect(SCENE_NARRATIONS[1]).toMatch(/models/i);
      expect(SCENE_NARRATIONS[1]).toMatch(/agents/i);
      expect(SCENE_NARRATIONS[1]).toMatch(/appearance/i);

      // Scene 3: New Conversation, Playbooks & Composer
      expect(SCENE_NARRATIONS[2]).toMatch(/new conversation/i);
      expect(SCENE_NARRATIONS[2]).toMatch(/playbook/i);
      expect(SCENE_NARRATIONS[2]).toMatch(/composer/i);

      // All scenes must be non-empty and well-formed
      for (const narration of SCENE_NARRATIONS) {
        expect(typeof narration).toBe('string');
        expect(narration.trim().length).toBeGreaterThan(20);
      }
    });
  });
});


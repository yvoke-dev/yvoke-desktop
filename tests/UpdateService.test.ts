import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateService } from '../src/main/UpdateService';
import type { UpdateCheckResult } from '../src/shared/types';

describe('UpdateService', () => {
  const currentVersion = '1.2.0';
  let updateService: UpdateService;

  beforeEach(() => {
    vi.restoreAllMocks();
    updateService = new UpdateService(() => currentVersion);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects when an update is available', async () => {
    const mockResponse = {
      tag_name: 'v1.3.0',
      html_url: 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.0',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result).toEqual({
      status: 'update_available',
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      releaseUrl: 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.0',
    });
  });

  it('detects when the current version is up to date', async () => {
    const mockResponse = {
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.2.0',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result).toEqual({
      status: 'latest',
      currentVersion: '1.2.0',
      latestVersion: '1.2.0',
    });
  });

  it('returns status: error for captive portal mock (HTML 200)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>Login to WiFi</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result.status).toBe('error');
    expect(result.currentVersion).toBe('1.2.0');
    expect(result.message).toMatch(/invalid response/i);
  });

  it('returns status: error for malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{ broken json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result.status).toBe('error');
    expect(result.currentVersion).toBe('1.2.0');
  });

  it('returns status: error when tag_name is missing from payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'v1.3.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result.status).toBe('error');
    expect(result.currentVersion).toBe('1.2.0');
    expect(result.message).toMatch(/invalid release payload/i);
  });

  describe('rate limit matrix', () => {
    it('returns rate_limited on 429', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Too Many Requests', {
          status: 429,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const result = await updateService.checkForUpdates();
      expect(result.status).toBe('rate_limited');
      expect(result.currentVersion).toBe('1.2.0');
      expect(result.message).toMatch(/rate limit reached/i);
    });

    it('returns rate_limited on 403 with x-ratelimit-remaining: 0', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('API rate limit exceeded', {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '0',
          },
        }),
      );

      const result = await updateService.checkForUpdates();
      expect(result.status).toBe('rate_limited');
      expect(result.currentVersion).toBe('1.2.0');
      expect(result.message).toMatch(/rate limit reached/i);
    });

    it('returns error on 403 with x-ratelimit-remaining: 60', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Forbidden', {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'x-ratelimit-remaining': '60',
          },
        }),
      );

      const result = await updateService.checkForUpdates();
      expect(result.status).toBe('error');
      expect(result.currentVersion).toBe('1.2.0');
    });

    it('returns error on 500 containing "429" in body text', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error with code 429', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );

      const result = await updateService.checkForUpdates();
      expect(result.status).toBe('error');
      expect(result.currentVersion).toBe('1.2.0');
    });
  });

  it('handles AbortError with timed out message', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortErr);

    const result = await updateService.checkForUpdates();
    expect(result.status).toBe('error');
    expect(result.currentVersion).toBe('1.2.0');
    expect(result.message).toMatch(/timed out/i);
  });

  it('coalesces concurrent in-flight calls and allows new calls after completion', async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => fetchPromise);

    const call1 = updateService.checkForUpdates();
    const call2 = updateService.checkForUpdates();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const [res1, res2] = await Promise.all([call1, call2]);
    expect(res1).toEqual(res2);
    expect(res1.status).toBe('update_available');

    // Subsequent call after resolution triggers a fresh fetch
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await updateService.checkForUpdates();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not leak headers, tokens, or extraneous fields in result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: 'v1.5.0',
          html_url: 'https://github.com/yvoke-dev/yvoke-desktop/releases/latest',
          secret_token: 'should_not_leak',
          author: { login: 'admin' },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Secret-Internal-Header': 'super-secret',
          },
        },
      ),
    );

    const result = await updateService.checkForUpdates();
    const allowedKeys: (keyof UpdateCheckResult)[] = [
      'status',
      'currentVersion',
      'latestVersion',
      'releaseUrl',
      'message',
    ];
    for (const key of Object.keys(result)) {
      expect(allowedKeys).toContain(key);
    }
    expect((result as any).secret_token).toBeUndefined();
    expect((result as any).author).toBeUndefined();
  });

  it('returns error when currentVersion is unparseable and does not call fetch', async () => {
    const invalidService = new UpdateService('invalid-version');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await invalidService.checkForUpdates();
    expect(result).toEqual({
      status: 'error',
      currentVersion: 'invalid-version',
      message: 'Invalid current version format',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns error when release tag is unparseable and status is not latest', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'nightly' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result.status).not.toBe('latest');
    expect(result).toEqual({
      status: 'error',
      currentVersion: '1.2.0',
      message: 'Invalid release version format',
    });
  });

  it('resolves with error when getCurrentVersion provider throws', async () => {
    const throwingService = new UpdateService(() => {
      throw new Error('Version lookup crashed');
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await throwingService.checkForUpdates();
    expect(result).toEqual({
      status: 'error',
      currentVersion: '',
      message: 'Version lookup crashed',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns error on general HTTP 500 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const result = await updateService.checkForUpdates();
    expect(result).toEqual({
      status: 'error',
      currentVersion: '1.2.0',
      message: 'Server returned HTTP 500',
    });
  });

  it('falls back to default release page when html_url is empty string or missing, and preserves valid html_url', async () => {
    const defaultUrl = 'https://github.com/yvoke-dev/yvoke-desktop/releases/latest';

    // 1. Empty string html_url
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.3.0', html_url: '' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resEmpty = await updateService.checkForUpdates();
    expect(resEmpty.status).toBe('update_available');
    if (resEmpty.status === 'update_available') {
      expect(resEmpty.releaseUrl).toBe(defaultUrl);
    }

    // 2. Missing/undefined html_url
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.3.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resMissing = await updateService.checkForUpdates();
    expect(resMissing.status).toBe('update_available');
    if (resMissing.status === 'update_available') {
      expect(resMissing.releaseUrl).toBe(defaultUrl);
    }

    // 3. Valid html_url preserved
    const customUrl = 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.0';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.3.0', html_url: customUrl }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resValid = await updateService.checkForUpdates();
    expect(resValid.status).toBe('update_available');
    if (resValid.status === 'update_available') {
      expect(resValid.releaseUrl).toBe(customUrl);
    }
  });

  it('normalizes uppercase V in release tag', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: 'V1.3.0',
          html_url: 'https://github.com/yvoke-dev/yvoke-desktop/releases/tag/v1.3.0',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const result = await updateService.checkForUpdates();
    expect(result.status).toBe('update_available');
    if (result.status === 'update_available') {
      expect(result.latestVersion).toBe('1.3.0');
    }
  });
});

import { compareSemver } from '../shared/semver';
import type { UpdateCheckResult } from '../shared/types';

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/yvoke-dev/yvoke-desktop/releases/latest';

export class UpdateService {
  private activeCheck: Promise<UpdateCheckResult> | null = null;

  constructor(private readonly getCurrentVersion: string | (() => string)) {}

  checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.activeCheck) {
      return this.activeCheck;
    }
    this.activeCheck = this.executeCheck().finally(() => {
      this.activeCheck = null;
    });
    return this.activeCheck;
  }

  private async executeCheck(): Promise<UpdateCheckResult> {
    const currentVersion =
      typeof this.getCurrentVersion === 'function'
        ? this.getCurrentVersion()
        : this.getCurrentVersion;

    try {
      const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
        headers: {
          'User-Agent': `Yvoke-Desktop/${currentVersion}`,
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (
        res.status === 429 ||
        (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
      ) {
        return {
          status: 'rate_limited',
          currentVersion,
          message: 'Update check rate limit reached. Try again later.',
        };
      }

      if (res.status !== 200) {
        return {
          status: 'error',
          currentVersion,
          message: `Server returned HTTP ${res.status}`,
        };
      }

      const contentType = res.headers.get('content-type');
      if (!contentType?.includes('json')) {
        return {
          status: 'error',
          currentVersion,
          message: 'Invalid response from update server',
        };
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        return {
          status: 'error',
          currentVersion,
          message: 'Invalid response from update server',
        };
      }

      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { tag_name?: unknown }).tag_name !== 'string'
      ) {
        return {
          status: 'error',
          currentVersion,
          message: 'Invalid release payload',
        };
      }

      const latestTag = (payload as { tag_name: string; html_url?: unknown }).tag_name;
      const htmlUrl = (payload as { html_url?: unknown }).html_url;
      const cleanLatest = latestTag.replace(/^v/, '');
      const cmp = compareSemver(latestTag, currentVersion);

      if (cmp > 0) {
        return {
          status: 'update_available',
          currentVersion,
          latestVersion: cleanLatest,
          releaseUrl:
            typeof htmlUrl === 'string' && htmlUrl.length > 0
              ? htmlUrl
              : 'https://github.com/yvoke-dev/yvoke-desktop/releases/latest',
        };
      }

      return {
        status: 'latest',
        currentVersion,
        latestVersion: cleanLatest,
      };
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        return {
          status: 'error',
          currentVersion,
          message: 'Update check timed out',
        };
      }
      return {
        status: 'error',
        currentVersion,
        message: err instanceof Error ? err.message : 'Failed to check for updates',
      };
    }
  }
}

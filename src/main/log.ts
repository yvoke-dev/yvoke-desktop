import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal timestamped logger for the main process. Output goes to stdout/stderr,
 * which is visible in `npm run dev` and captured in the packaged app's logs.
 */
function ts(): string {
  return new Date().toISOString();
}

export function log(scope: string, ...args: unknown[]): void {
  console.log(`[${ts()}] [${scope}]`, ...args);
}

export function logError(scope: string, ...args: unknown[]): void {
  console.error(`[${ts()}] [${scope}]`, ...args);
}

/**
 * Best-effort version of an installed dependency. `spec` must be require-resolvable
 * (a bare name, or a subpath for packages that only export subpaths, e.g.
 * `@modelcontextprotocol/sdk/client/index.js`). Walks up from the resolved file to the
 * nearest real package.json, skipping the `type`-only stubs some packages drop in dist/.
 */
export function packageVersion(spec: string): string {
  try {
    let dir = path.dirname(require.resolve(spec));
    for (let i = 0; i < 10; i++) {
      const pj = path.join(dir, 'package.json');
      if (fs.existsSync(pj)) {
        const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (meta.version && meta.name) return meta.version as string;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

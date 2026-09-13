/**
 * Semver parsing and comparison utilities for update checks.
 * Shared between main, preload, and renderer.
 */

export function parseSemver(version: string): [number, number, number] | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!trimmed) return null;

  // Strip leading 'v' or 'V'
  const withoutV = trimmed.replace(/^[vV]/, '');

  // Strip prerelease and build metadata suffixes: everything starting at '-' or '+'
  const baseVersion = withoutV.split(/[-+]/)[0];

  const parts = baseVersion.split('.');
  if (parts.length !== 3) return null;

  const numbers: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const part = parts[i];
    if (!/^\d+$/.test(part)) return null;
    const num = Number(part);
    if (!Number.isSafeInteger(num) || num < 0) return null;
    numbers[i] = num;
  }

  return numbers;
}

export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return 0;

  for (let i = 0; i < 3; i++) {
    if (parsedA[i] > parsedB[i]) return 1;
    if (parsedA[i] < parsedB[i]) return -1;
  }

  return 0;
}

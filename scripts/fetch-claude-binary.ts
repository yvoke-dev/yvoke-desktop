/**
 * Stages the Agent SDK's native `claude` binary for one or more build targets.
 *   npm run fetch:claude -- mac-arm64 mac-x64
 *   npm run fetch:claude -- win-x64
 *
 * Why this exists: the SDK resolves its binary by interpolating the RUNNING host into a package
 * name — `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude` — and npm
 * honours the os/cpu gates on those optional deps, so only the build machine's own platform is
 * ever on disk. Cross-arch and cross-platform packaging would silently ship an app that throws
 * "Native CLI binary for <plat>-<arch> not found" on first use.
 *
 * `npm pack` fetches a tarball directly and ignores those gates, so it can retrieve any target's
 * binary from any host. Each one is staged under build/claude/<target>/ where electron-builder
 * picks it up via `extraResources` (see electron-builder.yml), and the packaged app is pointed at
 * it explicitly with `pathToClaudeCodeExecutable` (see src/main/agent/AgentService.ts).
 *
 * Target directory names use electron-builder's macro vocabulary (`mac`/`win` + `${arch}`) so the
 * config can interpolate them; the npm package names use Node's (`darwin`/`win32`).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SDK_DIR = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const OUT_ROOT = path.join(process.cwd(), 'build', 'claude');

/** electron-builder's `${os}` value -> Node's process.platform. */
const NODE_PLATFORM: Record<string, string> = { mac: 'darwin', win: 'win32', linux: 'linux' };

type Target = { name: string; pkg: string; binary: string; checksum: string; dest: string };

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Streams the file so a 220MB binary never lands in memory in one piece. */
function sha256(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function resolveTarget(name: string): Target {
  const match = /^(mac|win|linux)-(arm64|x64)$/.exec(name);
  if (!match) {
    throw new Error(`invalid target "${name}" — expected <mac|win|linux>-<arm64|x64>`);
  }
  const [, osKey, arch] = match;
  const platform = NODE_PLATFORM[osKey];

  // The manifest ships the authoritative binary name + checksum for all platforms, and it is
  // versioned alongside the SDK, so it can never drift from the installed sdk.mjs that will
  // eventually spawn the binary.
  const manifest = readJson(path.join(SDK_DIR, 'manifest.json'));
  const entry = manifest.platforms?.[`${platform}-${arch}`];
  if (!entry) {
    throw new Error(`no manifest entry for ${platform}-${arch} (SDK ships: ${Object.keys(manifest.platforms ?? {}).join(', ')})`);
  }

  return {
    name,
    pkg: `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    binary: entry.binary,
    checksum: entry.checksum,
    dest: path.join(OUT_ROOT, name, entry.binary),
  };
}

/**
 * How to invoke npm. Windows ships `npm` as a .cmd shim, and Node has refused to spawnSync a
 * .cmd/.bat without `shell: true` since the CVE-2024-27980 fix: bare `npm` fails with ENOENT and
 * `npm.cmd` fails with EINVAL, which is how the win-x64 CI job failed twice. npm sets
 * `npm_execpath` to npm-cli.js for every `npm run` script — the documented entry point here, and
 * what CI uses — so run that with the current Node and skip the shim on every platform. The
 * fallback only covers a direct `tsx scripts/…` invocation, where on Windows a shell is the sole
 * way to reach the shim.
 */
const NPM: { file: string; prefix: string[]; shell: boolean } = (() => {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith('.js')) return { file: process.execPath, prefix: [cli], shell: false };
  return { file: 'npm', prefix: [], shell: process.platform === 'win32' };
})();

function fetch(target: Target, version: string): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
  try {
    const spec = `${target.pkg}@${version}`;
    console.log(`  fetching ${spec} …`);
    execFileSync(NPM.file, [...NPM.prefix, 'pack', spec, '--pack-destination', tmp], {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: NPM.shell,
    });

    const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`npm pack produced no tarball for ${spec}`);

    // Extract only the binary; the rest of the tarball is a README and a licence.
    execFileSync('tar', ['-xzf', path.join(tmp, tgz), '-C', tmp, `package/${target.binary}`], { stdio: 'inherit' });

    const extracted = path.join(tmp, 'package', target.binary);
    const actual = sha256(extracted);
    if (actual !== target.checksum) {
      throw new Error(`checksum mismatch for ${spec}\n  expected ${target.checksum}\n  actual   ${actual}`);
    }

    fs.mkdirSync(path.dirname(target.dest), { recursive: true });
    fs.copyFileSync(extracted, target.dest);
    // The tarball carries the mode, but copyFileSync does not, and the SDK spawns this directly.
    fs.chmodSync(target.dest, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): void {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('usage: tsx scripts/fetch-claude-binary.ts <mac-arm64|mac-x64|win-x64|linux-x64> …');
    process.exit(1);
  }

  // Pinning to the installed SDK's own version keeps the staged binary and the sdk.mjs that
  // spawns it on the same release.
  const version = readJson(path.join(SDK_DIR, 'package.json')).version;
  console.log(`claude-agent-sdk ${version}`);

  for (const name of names) {
    const target = resolveTarget(name);
    if (fs.existsSync(target.dest) && sha256(target.dest) === target.checksum) {
      console.log(`  ${name}: up to date`);
      continue;
    }
    fetch(target, version);
    console.log(`  ${name}: staged ${path.relative(process.cwd(), target.dest)}`);
  }
}

main();

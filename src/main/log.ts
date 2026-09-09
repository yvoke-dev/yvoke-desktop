import fs from 'node:fs';
import path from 'node:path';
import { sanitizeLogContent } from '../shared/error';

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export const MAX_BUFFERED_LOGS = 1000;

/** Upper bound on how long a single stream close may hold up rotation or quit. */
export const STREAM_CLOSE_TIMEOUT_MS = 2000;

let currentStream: fs.WriteStream | null = null;
let currentBytes = 0;
let logFilePath = '';
let rotatedFilePath = '';
let isRotating = false;
let rotationPromise: Promise<void> | null = null;
const logBuffer: string[] = [];

/**
 * Minimal timestamped logger for the main process. Output goes to stdout/stderr,
 * which is visible in `npm run dev` and captured in the packaged app's logs.
 */
function ts(): string {
  return new Date().toISOString();
}

function formatArgs(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

function attachStreamHandlers(stream: fs.WriteStream): void {
  stream.on('error', (err) => {
    console.error('[log] File logging stream error:', err);
    if (currentStream === stream) {
      currentStream = null;
    }
  });
}

function openStream(filePath: string): fs.WriteStream {
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  attachStreamHandlers(stream);
  return stream;
}

/**
 * Ends a WriteStream and resolves once its file descriptor has actually been released.
 *
 * Only 'close' reports that. 'finish' fires while the descriptor is still open — it means
 * the buffered writes reached write(2), nothing more — so resolving on it hands control
 * back while the handle is still live, and the callers here immediately rename the file
 * (rotation) or tear the process down (quit). An errored stream is destroyed and emits
 * 'close' too, so it needs no separate listener.
 *
 * The wait is bounded because a wedged descriptor must not be able to stall rotation
 * (which would strand every later line in the buffer) or keep the app from quitting.
 */
export function safeEndStream(stream: fs.WriteStream | null): Promise<void> {
  if (!stream || stream.destroyed || stream.closed) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stream.removeListener('close', cleanup);
      resolve();
    };

    stream.once('close', cleanup);
    timer = setTimeout(cleanup, STREAM_CLOSE_TIMEOUT_MS);

    try {
      stream.end();
    } catch {
      cleanup();
    }
  });
}

function pushToBuffer(entry: string): void {
  if (logBuffer.length >= MAX_BUFFERED_LOGS) {
    logBuffer.shift();
  }
  logBuffer.push(entry);
}

function startRotation(): Promise<void> {
  if (rotationPromise) {
    return rotationPromise;
  }

  isRotating = true;
  rotationPromise = (async () => {
    const oldStream = currentStream;
    currentStream = null;

    await safeEndStream(oldStream);

    try {
      if (fs.existsSync(rotatedFilePath)) {
        fs.unlinkSync(rotatedFilePath);
      }
    } catch (err) {
      console.error('[log] Failed to unlink rotated log:', err);
    }

    let rotatedSuccessfully = false;
    try {
      if (fs.existsSync(logFilePath)) {
        fs.renameSync(logFilePath, rotatedFilePath);
        rotatedSuccessfully = true;
      } else {
        rotatedSuccessfully = true;
      }
    } catch (err) {
      console.error('[log] Failed to rename log for rotation:', err);
    }

    if (rotatedSuccessfully) {
      currentBytes = 0;
    } else {
      try {
        currentBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : currentBytes;
      } catch {
        // keep currentBytes as-is
      }
    }

    try {
      currentStream = openStream(logFilePath);
    } catch (err) {
      console.error('[log] Failed to open new log stream after rotation:', err);
    }

    if (currentStream) {
      while (logBuffer.length > 0) {
        const next = logBuffer.shift()!;
        const bytes = Buffer.byteLength(next, 'utf8');
        currentBytes += bytes;
        currentStream.write(next);
      }
    } else {
      logBuffer.length = 0;
    }
  })().finally(() => {
    isRotating = false;
    rotationPromise = null;
  });

  return rotationPromise;
}

function writeToLogFile(entry: string): void {
  if (!currentStream && !isRotating) {
    return;
  }

  if (isRotating) {
    pushToBuffer(entry);
    return;
  }

  if (currentBytes >= MAX_LOG_SIZE_BYTES) {
    pushToBuffer(entry);
    startRotation();
    return;
  }

  const entryBytes = Buffer.byteLength(entry, 'utf8');
  if (currentStream && !currentStream.destroyed) {
    currentBytes += entryBytes;
    currentStream.write(entry);
  }
}

/**
 * Initializes file-based persistent logging in `userDataDir/logs/app.log`.
 * Configures secret scrubbing and 5MB rotation to `app.log.1`.
 *
 * Closes whatever was already running first, so calling this twice is safe.
 */
export async function initFileLogging(userDataDir: string): Promise<void> {
  // Any in-flight rotation and any live stream have to finish first. Rotation reads the log
  // paths only after it resumes, and the size below is read from disk, so re-pointing either
  // underneath them loses the rotation and leaks the stream it left behind.
  await closeFileLogging();

  const logsDir = path.join(userDataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  logFilePath = path.join(logsDir, 'app.log');
  rotatedFilePath = path.join(logsDir, 'app.log.1');

  try {
    currentBytes = fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
  } catch {
    currentBytes = 0;
  }

  currentStream = openStream(logFilePath);
}

/**
 * Flushes active stream and safely closes file logging.
 * Idempotent: safe to call multiple times.
 */
export async function closeFileLogging(): Promise<void> {
  if (rotationPromise) {
    await rotationPromise;
  }

  const streamToClose = currentStream;
  currentStream = null;

  await safeEndStream(streamToClose);
  logBuffer.length = 0;
}

/**
 * Returns active stream reference for unit testing stream error resilience.
 */
export function getLogStreamForTesting(): fs.WriteStream | null {
  return currentStream;
}

/**
 * Returns buffered logs reference for unit testing log buffer limits.
 */
export function getLogBufferForTesting(): readonly string[] {
  return logBuffer;
}

export function log(scope: string, ...args: unknown[]): void {
  const line = `[${ts()}] [${scope}] ${formatArgs(args)}`;
  const sanitized = sanitizeLogContent(line);
  console.log(sanitized);
  writeToLogFile(`${sanitized}\n`);
}

export function logError(scope: string, ...args: unknown[]): void {
  const line = `[${ts()}] [${scope}] ${formatArgs(args)}`;
  const sanitized = sanitizeLogContent(line);
  console.error(sanitized);
  writeToLogFile(`${sanitized}\n`);
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

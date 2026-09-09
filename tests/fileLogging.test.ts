import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initFileLogging,
  closeFileLogging,
  log,
  logError,
  getLogStreamForTesting,
  safeEndStream,
  MAX_BUFFERED_LOGS,
  getLogBufferForTesting,
} from '../src/main/log';

describe('fileLogging', () => {
  let tmpDir: string;
  let logsDir: string;
  let appLogPath: string;
  let rotatedLogPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yvoke-test-logging-'));
    logsDir = path.join(tmpDir, 'logs');
    appLogPath = path.join(logsDir, 'app.log');
    rotatedLogPath = path.join(logsDir, 'app.log.1');
  });

  afterEach(async () => {
    await closeFileLogging();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates logs directory and app.log upon initialization and logging', async () => {
    initFileLogging(tmpDir);
    expect(fs.existsSync(logsDir)).toBe(true);

    log('testScope', 'Hello file logging');
    await closeFileLogging();

    expect(fs.existsSync(appLogPath)).toBe(true);
    const content = fs.readFileSync(appLogPath, 'utf8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[testScope\] Hello file logging/);
  });

  it('formats multiple arguments, objects, and errors properly in log output', async () => {
    initFileLogging(tmpDir);

    log('multiArg', 'User ID:', 42, { role: 'admin' });
    logError('errorScope', new Error('Something failed in subsystem'));
    await closeFileLogging();

    const content = fs.readFileSync(appLogPath, 'utf8');
    expect(content).toContain('[multiArg] User ID: 42 {"role":"admin"}');
    expect(content).toContain('[errorScope] Error: Something failed in subsystem');
  });

  it('sanitizes secrets (Bearer tokens, sk-ant keys) before writing to app.log', async () => {
    initFileLogging(tmpDir);

    log('auth', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123');
    log('agent', 'Connecting with sk-ant-api03-abcdef987654321');
    await closeFileLogging();

    const content = fs.readFileSync(appLogPath, 'utf8');
    expect(content).toContain('[auth] Bearer [REDACTED]');
    expect(content).not.toContain('eyJhbGci');
    expect(content).toContain('[agent] Connecting with sk-ant-[REDACTED]');
    expect(content).not.toContain('abcdef987654321');
  });

  it('scrubs raw secrets from console.log and console.error outputs', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      log('auth', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123');
      expect(logSpy).toHaveBeenCalled();
      const logCall = logSpy.mock.calls[0].join(' ');
      expect(logCall).toContain('Bearer [REDACTED]');
      expect(logCall).not.toContain('eyJhbGci');

      logError('agent', 'Failed with sk-ant-api03-abcdef987654321');
      expect(errorSpy).toHaveBeenCalled();
      const errorCall = errorSpy.mock.calls[0].join(' ');
      expect(errorCall).toContain('sk-ant-[REDACTED]');
      expect(errorCall).not.toContain('abcdef987654321');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  describe('rotation at 5MB boundary', () => {
    it('rotates app.log to app.log.1 when the 5MB boundary is crossed', async () => {
      initFileLogging(tmpDir);

      // Write a 5MB payload (5 * 1024 * 1024 bytes)
      const bigPayload = 'x'.repeat(5 * 1024 * 1024);
      log('bulk', bigPayload);

      // Subsequent log crosses 5MB boundary and triggers rotation
      log('boundary', 'Crossing message');
      await closeFileLogging();

      expect(fs.existsSync(rotatedLogPath)).toBe(true);
      expect(fs.existsSync(appLogPath)).toBe(true);

      const rotatedStat = fs.statSync(rotatedLogPath);
      expect(rotatedStat.size).toBeGreaterThanOrEqual(5 * 1024 * 1024);

      const currentContent = fs.readFileSync(appLogPath, 'utf8');
      expect(currentContent).toContain('Crossing message');
      expect(currentContent).not.toContain(bigPayload);
    });

    it('cleanly overwrites prior app.log.1 on subsequent rotations without errors', async () => {
      initFileLogging(tmpDir);

      // First rotation
      const chunk1 = 'A'.repeat(5 * 1024 * 1024);
      log('rot1', chunk1);
      log('rot1', 'After first rotation');
      await closeFileLogging();

      expect(fs.existsSync(rotatedLogPath)).toBe(true);
      const rot1Content = fs.readFileSync(rotatedLogPath, 'utf8');
      expect(rot1Content).toContain('AAAA');

      // Reopen file logging and trigger second rotation
      initFileLogging(tmpDir);
      const chunk2 = 'B'.repeat(5 * 1024 * 1024);
      log('rot2', chunk2);
      log('rot2', 'After second rotation');
      await closeFileLogging();

      expect(fs.existsSync(rotatedLogPath)).toBe(true);
      const rot2Content = fs.readFileSync(rotatedLogPath, 'utf8');
      expect(rot2Content).toContain('BBBB');
      expect(rot2Content).not.toContain('AAAA');

      const appLogContent = fs.readFileSync(appLogPath, 'utf8');
      expect(appLogContent).toContain('After second rotation');
    });

    it('buffers logs while rotation is in flight so nothing is lost', async () => {
      initFileLogging(tmpDir);

      // Cross 5MB
      log('bulk', 'M'.repeat(5 * 1024 * 1024));
      log('buffered1', 'Message buffered 1');
      log('buffered2', 'Message buffered 2');
      log('buffered3', 'Message buffered 3');

      await closeFileLogging();

      expect(fs.existsSync(appLogPath)).toBe(true);
      const currentContent = fs.readFileSync(appLogPath, 'utf8');
      expect(currentContent).toContain('Message buffered 1');
      expect(currentContent).toContain('Message buffered 2');
      expect(currentContent).toContain('Message buffered 3');
    });

    it('caps logBuffer to MAX_BUFFERED_LOGS if rotation stalls', async () => {
      initFileLogging(tmpDir);

      const stream = getLogStreamForTesting()!;
      let finishRotation: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        finishRotation = resolve;
      });

      // Override stream.end to stall rotation
      const originalEnd = stream.end.bind(stream);
      stream.end = function (...args: any[]) {
        pendingPromise.then(() => {
          originalEnd(...args);
        });
        return stream;
      } as any;

      try {
        // Write enough to trigger rotation
        log('bulk', 'X'.repeat(5 * 1024 * 1024));

        // Now rotation is in flight (isRotating = true). Write 1200 logs
        for (let i = 0; i < 1200; i++) {
          log('spam', `Stalled message ${i}`);
        }

        const buffer = getLogBufferForTesting();
        expect(buffer).toBeDefined();
        expect(buffer.length).toBe(MAX_BUFFERED_LOGS);
        expect(buffer.length).toBe(1000);
        // Newest message should be preserved in buffer (FIFO ring behavior)
        expect(buffer[buffer.length - 1]).toContain('Stalled message 1199');
      } finally {
        finishRotation();
        await closeFileLogging();
      }
    });

    it('re-checks file size on renameSync failure so rotation can be re-attempted', async () => {
      initFileLogging(tmpDir);

      // Write 5MB to set up rotation
      log('bulk', 'Y'.repeat(5 * 1024 * 1024));

      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EPERM: operation not permitted, rename');
      });

      try {
        // This log triggers rotation which will fail at renameSync
        log('trigger', 'Trigger rotation that fails');
        await closeFileLogging();

        // The log file should still exist and not be renamed to rotatedLogPath
        expect(fs.existsSync(appLogPath)).toBe(true);
        expect(fs.existsSync(rotatedLogPath)).toBe(false);

        // Next time file logging is initialized, size should not be reset to 0
        initFileLogging(tmpDir);
        const stream = getLogStreamForTesting();
        expect(stream).not.toBeNull();
      } finally {
        renameSpy.mockRestore();
        await closeFileLogging();
      }
    });
  });

  describe('stream error resilience', () => {
    it('handles stream error events gracefully without uncaught exceptions or crashes', async () => {
      initFileLogging(tmpDir);
      const stream = getLogStreamForTesting();
      expect(stream).not.toBeNull();

      const enospcError = new Error('ENOSPC: no space left on device');
      Object.assign(enospcError, { code: 'ENOSPC' });

      // Emitting error event on the stream should be handled gracefully by attached error handler
      expect(() => {
        stream!.emit('error', enospcError);
      }).not.toThrow();

      // Subsequent logging after stream error should safely fallback without throwing
      expect(() => {
        log('test', 'Message after stream error');
        logError('test', 'Error message after stream error');
      }).not.toThrow();

      await expect(closeFileLogging()).resolves.toBeUndefined();
    });

    it('closeFileLogging resolves cleanly even when a stream error occurs', async () => {
      initFileLogging(tmpDir);
      const stream = getLogStreamForTesting();
      expect(stream).not.toBeNull();

      // Emit error before closing
      stream!.emit('error', new Error('EIO: I/O error on file stream'));

      // closeFileLogging should resolve cleanly without hanging or throwing
      await expect(closeFileLogging()).resolves.toBeUndefined();
    });

    it('safeEndStream handles stream error without hanging or throwing', async () => {
      const EventEmitter = (await import('node:events')).EventEmitter;
      const mockStream = new EventEmitter() as any;
      mockStream.destroyed = false;
      mockStream.closed = false;
      mockStream.end = (cb?: () => void) => {
        mockStream.emit('error', new Error('Failed to end stream'));
        if (cb) cb();
      };

      await expect(safeEndStream(mockStream)).resolves.toBeUndefined();
    });
  });

  describe('idempotent lifecycle', () => {
    it('calling closeFileLogging multiple times does not throw', async () => {
      initFileLogging(tmpDir);
      log('test', 'active write');

      await closeFileLogging();
      await expect(closeFileLogging()).resolves.toBeUndefined();
      await expect(closeFileLogging()).resolves.toBeUndefined();
    });

    it('writing after closeFileLogging does not throw', async () => {
      initFileLogging(tmpDir);
      log('test', 'initial write');
      await closeFileLogging();

      expect(() => {
        log('test', 'write after close');
        logError('test', 'error after close');
      }).not.toThrow();
    });

    it('re-initializing file logging after close works cleanly', async () => {
      initFileLogging(tmpDir);
      log('phase1', 'First session');
      await closeFileLogging();

      initFileLogging(tmpDir);
      log('phase2', 'Second session');
      await closeFileLogging();

      const content = fs.readFileSync(appLogPath, 'utf8');
      expect(content).toContain('First session');
      expect(content).toContain('Second session');
    });
  });
});

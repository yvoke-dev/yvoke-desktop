import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ignoreBrokenPipe, log, logError, MAX_CONSOLE_LINE_LENGTH } from '../src/main/log';

describe('log — EPIPE stream guard and plain console output', () => {
  describe('ignoreBrokenPipe', () => {
    it('ignores EPIPE errors emitted by a stream without throwing', () => {
      const stream = new EventEmitter();
      ignoreBrokenPipe(stream as unknown as NodeJS.WritableStream);

      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      expect(() => {
        stream.emit('error', epipe);
      }).not.toThrow();
    });

    it('re-throws non-EPIPE errors emitted by a stream', () => {
      const stream = new EventEmitter();
      ignoreBrokenPipe(stream as unknown as NodeJS.WritableStream);

      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      expect(() => {
        stream.emit('error', eacces);
      }).toThrow('permission denied');
    });

    it('re-throws errors with no error code', () => {
      const stream = new EventEmitter();
      ignoreBrokenPipe(stream as unknown as NodeJS.WritableStream);

      const generic = new Error('unexpected error');
      expect(() => {
        stream.emit('error', generic);
      }).toThrow('unexpected error');
    });

    it('installs broken pipe guard on process.stdout and process.stderr', () => {
      const stdoutListeners = process.stdout.listeners('error');
      const stderrListeners = process.stderr.listeners('error');
      expect(stdoutListeners.length).toBeGreaterThan(0);
      expect(stderrListeners.length).toBeGreaterThan(0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('printToConsole plain truncate-and-print (no try/catch swallowing)', () => {
    it('truncates lines exceeding MAX_CONSOLE_LINE_LENGTH', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const longMessage = 'A'.repeat(MAX_CONSOLE_LINE_LENGTH + 100);
      log('test-scope', longMessage);

      expect(spy).toHaveBeenCalledTimes(1);
      const printed = spy.mock.calls[0][0];
      expect(printed).toContain('… [truncated ');
      expect(printed.length).toBeLessThanOrEqual(MAX_CONSOLE_LINE_LENGTH + 200);
    });

    it('does not truncate lines within MAX_CONSOLE_LINE_LENGTH', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      log('test-scope', 'short message');

      expect(spy).toHaveBeenCalledTimes(1);
      const printed = spy.mock.calls[0][0];
      expect(printed).toContain('short message');
      expect(printed).not.toContain('[truncated');
    });

    it('re-throws when printer throws, proving try/catch was reverted', () => {
      const boom = new Error('Console failed');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {
        throw boom;
      });

      expect(() => {
        logError('test-scope', 'critical error');
      }).toThrow(boom);

      spy.mockRestore();
    });
  });
});

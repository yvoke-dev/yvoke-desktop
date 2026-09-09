import { describe, it, expect } from 'vitest';
import {
  tagAttributedError,
  stripErrorPrefix,
  sanitizeLogContent,
  hasErrorSourcePrefix,
  isAttributedError,
  type ErrorSource,
} from '../src/shared/error';

describe('errorAttribution', () => {
  describe('tagAttributedError', () => {
    it('tags plain string errors with the specified source', () => {
      expect(tagAttributedError('Claude', 'Overloaded')).toBe('Claude: Overloaded');
      expect(tagAttributedError('Entra', 'Interactive auth required')).toBe('Entra: Interactive auth required');
      expect(tagAttributedError('Yvoke Backend', 'Database connection timeout')).toBe('Yvoke Backend: Database connection timeout');
    });

    it('extracts message from Error instances', () => {
      const err = new Error('Rate limit exceeded');
      expect(tagAttributedError('Claude', err)).toBe('Claude: Rate limit exceeded');
    });

    it('extracts message from plain objects with a message property', () => {
      expect(tagAttributedError('Entra', { message: 'Token expired' })).toBe('Entra: Token expired');
    });

    describe('double-tagging idempotency', () => {
      it('replaces or normalizes already-prefixed messages without creating nested prefixes', () => {
        // Tagging with same source
        expect(tagAttributedError('Claude', 'Claude: Overloaded')).toBe('Claude: Overloaded');
        expect(tagAttributedError('Entra', 'Entra: Session expired')).toBe('Entra: Session expired');
        expect(tagAttributedError('Yvoke Backend', 'Yvoke Backend: Internal error')).toBe('Yvoke Backend: Internal error');

        // Tagging with different source must NOT produce nested prefixes like "Yvoke Backend: Entra: ..."
        const entraMsg = 'Entra: User cancelled login';
        const tagged = tagAttributedError('Yvoke Backend', entraMsg);
        expect(tagged).toBe('Yvoke Backend: User cancelled login');
        expect(tagged).not.toContain('Yvoke Backend: Entra:');

        const claudeMsg = 'Claude: Context window exceeded';
        const reTagged = tagAttributedError('Claude', claudeMsg);
        expect(reTagged).toBe('Claude: Context window exceeded');
        expect(reTagged).not.toContain('Claude: Claude:');
      });

      it('is idempotent across repeated calls to tagAttributedError', () => {
        const step1 = tagAttributedError('Claude', 'Timeout');
        const step2 = tagAttributedError('Claude', step1);
        expect(step2).toBe('Claude: Timeout');

        const step3 = tagAttributedError('Yvoke Backend', step2);
        expect(step3).toBe('Yvoke Backend: Timeout');
        expect(step3).not.toContain('Claude');
      });
    });

    describe('malformed inputs resilience', () => {
      it('handles null and undefined gracefully', () => {
        expect(tagAttributedError('Claude', null)).toBe('Claude: Unknown error');
        expect(tagAttributedError('Claude', undefined)).toBe('Claude: Unknown error');
      });

      it('handles empty string and whitespace-only string', () => {
        expect(tagAttributedError('Claude', '')).toBe('Claude: Unknown error');
        expect(tagAttributedError('Claude', '   ')).toBe('Claude: Unknown error');
      });

      it('handles numbers and booleans', () => {
        expect(tagAttributedError('Claude', 500)).toBe('Claude: 500');
        expect(tagAttributedError('Claude', 404)).toBe('Claude: 404');
        expect(tagAttributedError('Claude', false)).toBe('Claude: false');
        expect(tagAttributedError('Claude', true)).toBe('Claude: true');
      });

      it('handles circular objects without throwing', () => {
        const circular: Record<string, unknown> = { name: 'circular' };
        circular.self = circular;

        expect(() => tagAttributedError('Claude', circular)).not.toThrow();
        expect(tagAttributedError('Claude', circular)).toBe('Claude: Unknown error');
      });

      it('handles objects without a message property', () => {
        expect(tagAttributedError('Claude', {})).toBe('Claude: Unknown error');
        expect(tagAttributedError('Claude', { code: 503, status: 'unavailable' })).toBe('Claude: {"code":503,"status":"unavailable"}');
        expect(tagAttributedError('Claude', { message: '' })).toBe('Claude: Unknown error');
        expect(tagAttributedError('Claude', { message: '   ' })).toBe('Claude: Unknown error');
      });

      it('handles Error with empty message', () => {
        expect(tagAttributedError('Claude', new Error(''))).toBe('Claude: Error');
      });

      it('serializes an object whose message property is not a string', () => {
        // An object carrying a non-string `message` must not fare worse than one carrying
        // no `message` at all — the details are the whole point of reporting the error.
        expect(tagAttributedError('Yvoke Backend', { message: { code: 500, details: 'Timeout' } })).toBe(
          'Yvoke Backend: {"message":{"code":500,"details":"Timeout"}}',
        );
        expect(tagAttributedError('Entra', { message: ['first', 'second'] })).toBe(
          'Entra: {"message":["first","second"]}',
        );
        expect(tagAttributedError('Claude', { message: null, code: 42 })).toBe(
          'Claude: {"message":null,"code":42}',
        );
      });

      it('falls back to Unknown error when a non-string message cannot be serialized', () => {
        const circular: Record<string, unknown> = { message: { nested: true } };
        circular.self = circular;
        expect(tagAttributedError('Claude', circular)).toBe('Claude: Unknown error');
      });
    });
  });

  describe('stripErrorPrefix', () => {
    it('strips known prefixes from error strings', () => {
      expect(stripErrorPrefix('Claude: Something failed')).toBe('Something failed');
      expect(stripErrorPrefix('Entra: Invalid grant')).toBe('Invalid grant');
      expect(stripErrorPrefix('Yvoke Backend: Gateway timeout')).toBe('Gateway timeout');
    });

    it('strips prefixes without space after colon', () => {
      expect(stripErrorPrefix('Claude:Something failed')).toBe('Something failed');
      expect(stripErrorPrefix('Entra:Invalid grant')).toBe('Invalid grant');
    });

    it('preserves internal colons precisely', () => {
      const complexMsg = 'Claude: Server error: HTTP 500 at https://api.yvoke.ai:8080';
      expect(stripErrorPrefix(complexMsg)).toBe('Server error: HTTP 500 at https://api.yvoke.ai:8080');

      const urlWithPort = 'Entra: Connection failed to https://login.microsoftonline.com:443/common';
      expect(stripErrorPrefix(urlWithPort)).toBe('Connection failed to https://login.microsoftonline.com:443/common');
    });

    it('leaves messages without known prefixes unchanged', () => {
      expect(stripErrorPrefix('Custom: Server error: HTTP 500')).toBe('Custom: Server error: HTTP 500');
      expect(stripErrorPrefix('Network disconnected')).toBe('Network disconnected');
    });

    it('handles repeated known prefixes cleanly', () => {
      expect(stripErrorPrefix('Claude: Entra: Internal error')).toBe('Internal error');
      expect(stripErrorPrefix('Yvoke Backend: Claude: Failed')).toBe('Failed');
    });

    it('handles non-string or empty inputs safely', () => {
      expect(stripErrorPrefix('')).toBe('');
      expect(stripErrorPrefix('   ')).toBe('');
      expect(stripErrorPrefix(null as unknown as string)).toBe('');
      expect(stripErrorPrefix(undefined as unknown as string)).toBe('');
    });
  });

  describe('source prefix detection', () => {
    it('matches a source prefix whether or not a space follows the colon', () => {
      expect(hasErrorSourcePrefix('Entra: Session expired', 'Entra')).toBe(true);
      expect(hasErrorSourcePrefix('Entra:Session expired', 'Entra')).toBe(true);
      expect(hasErrorSourcePrefix('Yvoke Backend: 502 Bad Gateway', 'Yvoke Backend')).toBe(true);
      expect(hasErrorSourcePrefix('Claude: Overloaded', 'Claude')).toBe(true);
    });

    it('does not match another source, a bare mention, or a different case', () => {
      expect(hasErrorSourcePrefix('Claude: Overloaded', 'Entra')).toBe(false);
      expect(hasErrorSourcePrefix('Network disconnected', 'Entra')).toBe(false);
      // Only a prefix is an attribution; the same word mid-message is not.
      expect(hasErrorSourcePrefix('Failed to reach Entra: timeout', 'Entra')).toBe(false);
      expect(hasErrorSourcePrefix('entra: lowercase', 'Entra')).toBe(false);
      expect(hasErrorSourcePrefix('', 'Entra')).toBe(false);
      // The colon is what makes it an attribution; merely starting with the source's
      // name does not, or ordinary prose would be mistaken for an attributed message.
      expect(hasErrorSourcePrefix('Entra sign-in was cancelled', 'Entra')).toBe(false);
    });

    it('isAttributedError matches any known source and nothing else', () => {
      expect(isAttributedError('Claude: Overloaded')).toBe(true);
      expect(isAttributedError('Entra:no space')).toBe(true);
      expect(isAttributedError('Yvoke Backend: 502 Bad Gateway')).toBe(true);
      expect(isAttributedError('Custom: Server error')).toBe(false);
      expect(isAttributedError('Network disconnected')).toBe(false);
      expect(isAttributedError('Claude was unreachable')).toBe(false);
      expect(isAttributedError('')).toBe(false);
    });
  });

  describe('sanitizeLogContent', () => {
    it('redacts Bearer JWT tokens', () => {
      const logLine = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const sanitized = sanitizeLogContent(logLine);
      expect(sanitized).toBe('Authorization: Bearer [REDACTED]');
      expect(sanitized).not.toContain('eyJhbGci');
    });

    it('redacts simple and mock Bearer tokens', () => {
      expect(sanitizeLogContent('Authorization: Bearer dev-local-token')).toBe('Authorization: Bearer [REDACTED]');
      expect(sanitizeLogContent('Bearer ey12345.abcde')).toBe('Bearer [REDACTED]');
    });

    it('redacts Anthropic API keys (sk-ant-...)', () => {
      const logLine = 'Using anthropic key sk-ant-api03-abcdef1234567890_XYZ for session';
      const sanitized = sanitizeLogContent(logLine);
      expect(sanitized).toBe('Using anthropic key sk-ant-[REDACTED] for session');
      expect(sanitized).not.toContain('abcdef1234567890');
    });

    it('redacts multiple different tokens in the same text', () => {
      const logLine = 'Headers: { Authorization: "Bearer eyJ123.456.789" }, Claude: sk-ant-admin01-secret999';
      const sanitized = sanitizeLogContent(logLine);
      expect(sanitized).toBe('Headers: { Authorization: "Bearer [REDACTED]" }, Claude: sk-ant-[REDACTED]');
      expect(sanitized).not.toContain('eyJ123.456.789');
      expect(sanitized).not.toContain('secret999');
    });

    it('leaves text without tokens unchanged', () => {
      const normalLine = '[2026-09-09T12:00:00.000Z] [sync] Synchronized 5 items successfully';
      expect(sanitizeLogContent(normalLine)).toBe(normalLine);
    });

    it('handles empty or non-string inputs safely', () => {
      expect(sanitizeLogContent('')).toBe('');
      expect(sanitizeLogContent(null as unknown as string)).toBe('');
      expect(sanitizeLogContent(undefined as unknown as string)).toBe('');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { parseSemver, compareSemver } from '../src/shared/semver';

describe('semver utilities', () => {
  describe('parseSemver', () => {
    it('parses standard semver strings', () => {
      expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
      expect(parseSemver('0.0.0')).toEqual([0, 0, 0]);
      expect(parseSemver('10.20.30')).toEqual([10, 20, 30]);
    });

    it('normalizes leading v, V, and whitespace', () => {
      expect(parseSemver('v1.2.3')).toEqual([1, 2, 3]);
      expect(parseSemver('V1.2.3')).toEqual([1, 2, 3]);
      expect(parseSemver('  v1.2.3  ')).toEqual([1, 2, 3]);
      expect(parseSemver('\tv1.2.3\n')).toEqual([1, 2, 3]);
    });

    it('ignores prerelease and build metadata suffixes', () => {
      expect(parseSemver('1.2.3-beta.1')).toEqual([1, 2, 3]);
      expect(parseSemver('1.2.3-alpha+001')).toEqual([1, 2, 3]);
      expect(parseSemver('1.2.3+20130313144700')).toEqual([1, 2, 3]);
      expect(parseSemver('1.2.3-beta.1+build.42')).toEqual([1, 2, 3]);
      expect(parseSemver('v1.2.3-rc.1')).toEqual([1, 2, 3]);
    });

    it('returns null for malformed inputs', () => {
      expect(parseSemver('')).toBeNull();
      expect(parseSemver('   ')).toBeNull();
      expect(parseSemver('invalid')).toBeNull();
      expect(parseSemver('1.2')).toBeNull();
      expect(parseSemver('1.2.3.4')).toBeNull();
      expect(parseSemver('v')).toBeNull();
      expect(parseSemver('1.-2.3')).toBeNull();
      expect(parseSemver('a.b.c')).toBeNull();
      expect(parseSemver('1.2.foo')).toBeNull();
    });
  });

  describe('compareSemver', () => {
    it('performs numeric rather than lexical comparison', () => {
      expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
      expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
      expect(compareSemver('1.2.10', '1.2.9')).toBe(1);
    });

    it('handles leading v and whitespace normalization in comparison', () => {
      expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
      expect(compareSemver('  v1.2.4  ', '1.2.3')).toBe(1);
      expect(compareSemver('V1.2.3', 'v1.2.4')).toBe(-1);
    });

    it('handles prerelease and build metadata in comparison', () => {
      expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBe(0);
      expect(compareSemver('1.2.3-beta.1+build.42', '1.2.3')).toBe(0);
      expect(compareSemver('1.2.4-alpha', '1.2.3')).toBe(1);
    });

    it('returns 0 when either version is unparseable', () => {
      expect(compareSemver('invalid', '1.2.3')).toBe(0);
      expect(compareSemver('1.2.3', 'invalid')).toBe(0);
      expect(compareSemver('', '1.2.3')).toBe(0);
      expect(compareSemver('1.2.3.4', '1.2.3')).toBe(0);
      expect(compareSemver('invalid', 'also-invalid')).toBe(0);
    });

    it('returns 0 when versions are equal', () => {
      expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
      expect(compareSemver('0.0.1', '0.0.1')).toBe(0);
    });
  });
});

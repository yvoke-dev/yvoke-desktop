import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MODELS,
  formatModelDisplayName,
  MODEL_DISPLAY_NAMES,
  resolveCanonicalModel,
} from '../src/shared/types';

describe('modelMapping', () => {
  describe('resolveCanonicalModel', () => {
    it('maps sonnet alias to claude-sonnet-5-5', () => {
      expect(resolveCanonicalModel('sonnet')).toBe('claude-sonnet-5-5');
    });

    it('maps opus alias to claude-opus-5-5', () => {
      expect(resolveCanonicalModel('opus')).toBe('claude-opus-5-5');
    });

    it('maps haiku alias to claude-haiku-5-5', () => {
      expect(resolveCanonicalModel('haiku')).toBe('claude-haiku-5-5');
    });

    it('maps claude-* family aliases to canonical 5.5 wire IDs', () => {
      expect(resolveCanonicalModel('claude-sonnet')).toBe('claude-sonnet-5-5');
      expect(resolveCanonicalModel('claude-opus')).toBe('claude-opus-5-5');
      expect(resolveCanonicalModel('claude-haiku')).toBe('claude-haiku-5-5');
    });

    it('returns empty string for undefined or empty input without defaulting', () => {
      expect(resolveCanonicalModel('')).toBe('');
      expect(resolveCanonicalModel(undefined)).toBe('');
    });

    it('guards against prototype-chain lookup returning non-strings', () => {
      expect(resolveCanonicalModel('constructor')).toBe('constructor');
      expect(typeof resolveCanonicalModel('constructor')).toBe('string');
      expect(resolveCanonicalModel('__proto__')).toBe('__proto__');
      expect(typeof resolveCanonicalModel('__proto__')).toBe('string');
      expect(resolveCanonicalModel('toString')).toBe('toString');
      expect(typeof resolveCanonicalModel('toString')).toBe('string');
    });

    it('preserves canonical 5.5 wire IDs unchanged', () => {
      expect(resolveCanonicalModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveCanonicalModel('claude-opus-5-5')).toBe('claude-opus-5-5');
      expect(resolveCanonicalModel('claude-haiku-5-5')).toBe('claude-haiku-5-5');
    });

    it('passes through custom or unknown model IDs unchanged', () => {
      expect(resolveCanonicalModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
      expect(resolveCanonicalModel('custom-model-id')).toBe('custom-model-id');
    });
  });

  describe('formatModelDisplayName', () => {
    it('formats sonnet alias, claude-sonnet, and canonical ID as Sonnet 5.5', () => {
      expect(formatModelDisplayName('sonnet')).toBe('Sonnet 5.5');
      expect(formatModelDisplayName('claude-sonnet')).toBe('Sonnet 5.5');
      expect(formatModelDisplayName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    });

    it('formats opus alias, claude-opus, and canonical ID as Opus 5.5', () => {
      expect(formatModelDisplayName('opus')).toBe('Opus 5.5');
      expect(formatModelDisplayName('claude-opus')).toBe('Opus 5.5');
      expect(formatModelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    });

    it('formats haiku alias, claude-haiku, and canonical ID as Haiku 5.5', () => {
      expect(formatModelDisplayName('haiku')).toBe('Haiku 5.5');
      expect(formatModelDisplayName('claude-haiku')).toBe('Haiku 5.5');
      expect(formatModelDisplayName('claude-haiku-5-5')).toBe('Haiku 5.5');
    });

    it('guards against prototype-chain lookup in display names', () => {
      expect(formatModelDisplayName('constructor')).toBe('constructor');
      expect(typeof formatModelDisplayName('constructor')).toBe('string');
      expect(formatModelDisplayName('__proto__')).toBe('__proto__');
      expect(typeof formatModelDisplayName('__proto__')).toBe('string');
      expect(formatModelDisplayName('toString')).toBe('toString');
      expect(typeof formatModelDisplayName('toString')).toBe('string');
    });

    it('formats previous generation models cleanly', () => {
      expect(formatModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
      expect(formatModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
      expect(formatModelDisplayName('claude-opus-5')).toBe('Opus 5');
    });

    it('returns raw string for unknown models and empty string for empty input', () => {
      expect(formatModelDisplayName('custom-llm')).toBe('custom-llm');
      expect(formatModelDisplayName('')).toBe('');
    });
  });
});

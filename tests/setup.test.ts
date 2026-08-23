// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

/**
 * Guards the fix in tests/setup.ts. Without the stub these are undefined in jsdom and the failure
 * that follows is a timing-dependent unhandled error from inside a rAF callback — green locally,
 * red on CI, and nowhere near the line that caused it. Failing here instead says what happened.
 */
describe('jsdom scroll stubs', () => {
  it('gives elements the scroll methods jsdom omits', () => {
    const el = document.createElement('div');
    expect(typeof el.scrollTo).toBe('function');
    expect(typeof el.scrollIntoView).toBe('function');
  });
});

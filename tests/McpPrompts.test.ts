import { describe, expect, it } from 'vitest';
import { toPromptInfo } from '../src/main/agent/McpPrompts';

describe('McpPrompts.toPromptInfo version extraction', () => {
  it('parses positive integer _meta.version onto McpPromptInfo.version', () => {
    const info1 = toPromptInfo({ name: 'oim-full', _meta: { version: 1 } });
    expect(info1.version).toBe(1);

    const info2 = toPromptInfo({ name: 'oim-full', _meta: { version: 2 } });
    expect(info2.version).toBe(2);

    const infoMeta = toPromptInfo({ name: 'oim-full', meta: { version: 5 } });
    expect(infoMeta.version).toBe(5);
  });

  it.each([
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['"2"', '2'],
    ['true', true],
    ['false', false],
    ['null', null],
    ['undefined', undefined],
  ])('ignores boundary/malformed version %s, leaving version undefined', (_label, rawVersion) => {
    const info = toPromptInfo({ name: 'oim-full', _meta: { version: rawVersion } });
    expect(info.version).toBeUndefined();
  });
});

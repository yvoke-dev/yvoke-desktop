import { describe, it, expect } from 'vitest';
import { parsePipelineArgs } from '../scripts/record-all-scenes-independently';

describe('parsePipelineArgs', () => {
  it('provides sensible defaults when no arguments are passed', () => {
    const opts = parsePipelineArgs([]);
    expect(opts.scenes).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(opts.outputPath).toContain('artifacts/yvoke-desktop-demo-1.mp4');
    expect(opts.reuseExisting).toBe(false);
    expect(opts.skipBackend).toBe(false);
  });

  it('correctly parses custom --output and --reuse-existing', () => {
    const opts = parsePipelineArgs([
      '--output',
      'artifacts/custom-output.mp4',
      '--reuse-existing',
    ]);
    expect(opts.outputPath).toContain('artifacts/custom-output.mp4');
    expect(opts.reuseExisting).toBe(true);
  });

  it('correctly parses explicit comma-separated --scenes', () => {
    const opts = parsePipelineArgs(['--scenes', '1,4,7']);
    expect(opts.scenes).toEqual([1, 4, 7]);
  });

  it('filters out invalid scene numbers outside 1..7', () => {
    const opts = parsePipelineArgs(['--scenes', '0,1,2,99,-5']);
    expect(opts.scenes).toEqual([1, 2]);
  });

  it('parses --start and --end range', () => {
    const opts = parsePipelineArgs(['--start', '3', '--end', '5']);
    expect(opts.scenes).toEqual([3, 4, 5]);
  });

  it('parses --backend-url and --offline flags', () => {
    const opts = parsePipelineArgs([
      '--backend-url',
      'http://127.0.0.1:9999',
      '--offline',
    ]);
    expect(opts.backendUrl).toBe('http://127.0.0.1:9999');
    expect(opts.skipBackend).toBe(true);
  });
});

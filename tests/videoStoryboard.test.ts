import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  STORYBOARD_BEATS,
  parseTimeRange,
  renderStoryboardMarkdown,
  generateStoryboardSrt,
  MalformedTimeRangeError,
  type StoryboardBeat,
} from '../scripts/video/storyboard';

describe('videoStoryboard', () => {
  describe('STORYBOARD_BEATS definition', () => {
    it('defines exactly 8 storyboard beats', () => {
      expect(STORYBOARD_BEATS).toHaveLength(8);
    });

    it('defines correct sequential beats with IDs scene-1 through scene-8', () => {
      const ids = STORYBOARD_BEATS.map((b) => b.id);
      expect(ids).toEqual([
        'scene-1',
        'scene-2',
        'scene-3',
        'scene-4',
        'scene-5',
        'scene-6',
        'scene-7',
        'scene-8',
      ]);
    });

    it('configures execution modes correctly across all scenes', () => {
      expect(STORYBOARD_BEATS[0].execution).toBe('real_app_ui');
      expect(STORYBOARD_BEATS[1].execution).toBe('real_app_ui');
      expect(STORYBOARD_BEATS[2].execution).toBe('real_app_ui');
      expect(STORYBOARD_BEATS[3].execution).toBe('real_live_turn');
      expect(STORYBOARD_BEATS[4].execution).toBe('real_live_turn');
      expect(STORYBOARD_BEATS[5].execution).toBe('real_live_turn');
      expect(STORYBOARD_BEATS[6].execution).toBe('real_live_turn');
      expect(STORYBOARD_BEATS[7].execution).toBe('real_app_ui');
    });

    it('configures Scene 4 with Playbook validation turnConfig', () => {
      const beat = STORYBOARD_BEATS[3];
      expect(beat.turnConfig).toBeDefined();
      expect(beat.turnConfig?.playbook).toBe('oim-getting-started');
      expect(beat.turnConfig?.prompt).toBe('When was the table POLPlaybook introduced?');
      expect(beat.turnConfig?.expectValidationWarning).toBe(true);
    });

    it('configures Scene 5 with follow-up & search hints turnConfig', () => {
      const beat = STORYBOARD_BEATS[4];
      expect(beat.turnConfig).toBeDefined();
      expect(beat.turnConfig?.playbook).toBe('oim-getting-started');
      expect(beat.turnConfig?.prompt).toBe('what is a value template?');
      expect(beat.turnConfig?.followUp).toBe(
        'check if you find any practical info in teams or confluence',
      );
    });

    it('configures Scene 6 with clarifying questions & citations turnConfig', () => {
      const beat = STORYBOARD_BEATS[5];
      expect(beat.turnConfig).toBeDefined();
      expect(beat.turnConfig?.playbook).toBe('oim-db-history');
      expect(beat.turnConfig?.prompt).toBe(
        'what database changes were done between 9.3.1 and 10.0?',
      );
      expect(beat.turnConfig?.expectClarification).toBe(true);
    });

    it('configures Scene 7 with Multi-Agent System (MAS) orchestrator turnConfig', () => {
      const beat = STORYBOARD_BEATS[6];
      expect(beat.turnConfig).toBeDefined();
      expect(beat.turnConfig?.mode).toBe('orchestrator');
      expect(beat.turnConfig?.prompt).toContain('Compare standard connector');
      expect(beat.turnConfig?.prompt).toContain('PowerShell');
      expect(beat.turnConfig?.prompt).toContain('teams/confluence');
    });

    it('has continuous, unbroken timeline from 00:00 to 04:00 (240s total)', () => {
      let expectedStart = 0;
      for (const beat of STORYBOARD_BEATS) {
        const { startSec, endSec } = parseTimeRange(beat.timeRange);
        expect(startSec).toBe(expectedStart);
        expect(endSec).toBeGreaterThan(startSec);
        expectedStart = endSec;
      }
      expect(expectedStart).toBe(240); // 4 minutes
    });
  });

  describe('parseTimeRange', () => {
    it('parses valid time range "00:00 -> 00:20" into seconds', () => {
      const res = parseTimeRange('00:00 -> 00:20');
      expect(res).toEqual({ startSec: 0, endSec: 20 });
    });

    it('parses minutes and seconds correctly "01:10 -> 01:45"', () => {
      const res = parseTimeRange('01:10 -> 01:45');
      expect(res).toEqual({ startSec: 70, endSec: 105 });
    });

    it('throws MalformedTimeRangeError for missing separator', () => {
      expect(() => parseTimeRange('00:00 00:20')).toThrow(MalformedTimeRangeError);
    });

    it('throws MalformedTimeRangeError for non-numeric characters', () => {
      expect(() => parseTimeRange('ab:cd -> ef:gh')).toThrow(MalformedTimeRangeError);
    });

    it('throws MalformedTimeRangeError when startSec is equal to endSec', () => {
      expect(() => parseTimeRange('00:20 -> 00:20')).toThrow(MalformedTimeRangeError);
    });

    it('throws MalformedTimeRangeError when startSec is greater than endSec', () => {
      expect(() => parseTimeRange('00:30 -> 00:20')).toThrow(MalformedTimeRangeError);
    });

    it('throws MalformedTimeRangeError when seconds component is >= 60', () => {
      expect(() => parseTimeRange('00:60 -> 01:00')).toThrow(MalformedTimeRangeError);
    });
  });

  describe('renderStoryboardMarkdown', () => {
    it('generates a markdown table with all required 5 columns', () => {
      const md = renderStoryboardMarkdown(STORYBOARD_BEATS);
      expect(md).toContain('| Time Range | Scene / ID | Spoken Narration | Visual UI Action | Execution Mode |');
      expect(md).toContain('| :--- | :--- | :--- | :--- | :--- |');
    });

    it('includes all 8 beats in the table rows', () => {
      const md = renderStoryboardMarkdown(STORYBOARD_BEATS);
      for (const beat of STORYBOARD_BEATS) {
        expect(md).toContain(beat.timeRange);
        expect(md).toContain(beat.id);
        expect(md).toContain(beat.execution);
      }
    });
  });

  describe('generateStoryboardSrt', () => {
    it('generates sequential valid SRT subtitles from storyboard beats', () => {
      const srt = generateStoryboardSrt(STORYBOARD_BEATS);
      expect(srt).toContain('1\n00:00:00,000 --> 00:00:20,000');
      expect(srt).toContain('2\n00:00:20,000 --> 00:00:48,000');
      expect(srt).toContain('3\n00:00:48,000 --> 00:01:10,000');
      expect(srt).toContain('4\n00:01:10,000 --> 00:01:45,000');
      expect(srt).toContain('5\n00:01:45,000 --> 00:02:20,000');
      expect(srt).toContain('6\n00:02:20,000 --> 00:02:55,000');
      expect(srt).toContain('7\n00:02:55,000 --> 00:03:40,000');
      expect(srt).toContain('8\n00:03:40,000 --> 00:04:00,000');
    });

    it('matches spoken narration in SRT cues', () => {
      const srt = generateStoryboardSrt(STORYBOARD_BEATS);
      expect(srt).toContain(STORYBOARD_BEATS[0].narration);
      expect(srt).toContain(STORYBOARD_BEATS[7].narration);
    });
  });

  describe('STORYBOARD.md file on disk', () => {
    it('verifies scripts/video/STORYBOARD.md exists and matches rendered markdown', () => {
      const filePath = path.resolve(process.cwd(), 'scripts/video/STORYBOARD.md');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toBe(renderStoryboardMarkdown(STORYBOARD_BEATS));
    });
  });
});

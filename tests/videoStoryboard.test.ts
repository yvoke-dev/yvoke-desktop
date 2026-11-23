import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  STORYBOARD_BEATS,
  parseTimeRange,
  renderStoryboardMarkdown,
  generateStoryboardSrt,
  getSceneSegments,
  getSegmentNarration,
  getSegmentDuration,
  MalformedTimeRangeError,
  type StoryboardBeat,
  type SceneSegment,
} from '../scripts/video/storyboard';

describe('videoStoryboard', () => {
  describe('STORYBOARD_BEATS definition', () => {
    it('defines exactly 7 storyboard beats', () => {
      expect(STORYBOARD_BEATS).toHaveLength(7);
    });

    it('defines correct sequential beats with IDs scene-1 through scene-7', () => {
      const ids = STORYBOARD_BEATS.map((b) => b.id);
      expect(ids).toEqual([
        'scene-1',
        'scene-2',
        'scene-3',
        'scene-4',
        'scene-5',
        'scene-6',
        'scene-7',
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
      expect(beat.turnConfig?.playbook).toBe('oim-full');
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
        'what database changes were done for the AOB module between 9.3.1 and 10.0?',
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

    it('has continuous, unbroken timeline from 00:00 to 04:10 (250s total across 32 sub-beats)', () => {
      let expectedStart = 0;
      let totalSubBeats = 0;
      for (const beat of STORYBOARD_BEATS) {
        const { startSec, endSec } = parseTimeRange(beat.timeRange);
        expect(startSec).toBe(expectedStart);
        expect(endSec).toBeGreaterThan(startSec);
        expectedStart = endSec;
        totalSubBeats += beat.subBeats?.length ?? 0;
      }
      expect(expectedStart).toBe(250); // 4 minutes 10 seconds
      expect(totalSubBeats).toBe(32);
    });

    it('defines rich subBeats with unique non-empty keys and narration parity for every beat', () => {
      for (const beat of STORYBOARD_BEATS) {
        expect(beat.subBeats).toBeDefined();
        expect(beat.subBeats!.length).toBeGreaterThanOrEqual(3);
        const seenKeys = new Set<string>();
        for (const sub of beat.subBeats!) {
          expect(sub.subId).toMatch(new RegExp(`^${beat.id}\\.\\d+$`));
          expect(typeof sub.key).toBe('string');
          expect(sub.key.trim().length).toBeGreaterThan(0);
          expect(seenKeys.has(sub.key)).toBe(false);
          seenKeys.add(sub.key);
          expect(sub.narration.length).toBeGreaterThan(0);
          expect(sub.visualAction.length).toBeGreaterThan(0);
          expect(sub.uiTarget).toBeDefined();
          expect(sub.visualState).toBeDefined();
        }
        expect(beat.narration).toBe(beat.subBeats!.map((s) => s.narration).join(' '));
      }
    });

    it('matches current UI architecture in Scene 1.4, Scene 2 (8 sub-beats), Scene 3, Scene 4.3, Scene 5.1, and Scene 7', () => {
      const scene1 = STORYBOARD_BEATS[0];
      expect(scene1.visualAction).toContain('Today, This Week, Last Week, Earlier');
      const s1_2 = scene1.subBeats![1];
      expect(s1_2.visualAction).toContain('Today, This Week, Last Week, Earlier');
      const s1_4 = scene1.subBeats![3];
      expect(s1_4.key).toBe('profile');
      expect(s1_4.narration).toContain('Yvoke and Claude accounts');
      expect(s1_4.uiTarget).toBe(
        '.thread-list-footer, button.footer-account-btn, .account-status-row, .app-version, button[data-tip="Settings"]',
      );

      const scene2 = STORYBOARD_BEATS[1];
      expect(scene2.subBeats).toHaveLength(8);
      expect(scene2.subBeats!.map((s) => s.key)).toEqual([
        'intro',
        'server',
        'accounts',
        'models',
        'agents',
        'webSearch',
        'appearance',
        'about',
      ]);
      const s2Accounts = scene2.subBeats![2];
      expect(s2Accounts.uiTarget).toContain('.check-credentials-btn');
      expect(s2Accounts.uiTarget).toContain('.cred-badge.verified');
      const s2Models = scene2.subBeats![3];
      expect(s2Models.visualState).toContain('Haiku 5.5');
      expect(s2Models.visualState).not.toMatch(/Sonnet selected/i);
      const s2Agents = scene2.subBeats![4];
      expect(s2Agents.uiTarget).toContain('.settings-domain-list');
      expect(s2Agents.visualAction).toContain('oim-full');
      const s2WebSearch = scene2.subBeats![5];
      expect(s2WebSearch.uiTarget).toContain('.settings-domain-list li');
      const s2Appearance = scene2.subBeats![6];
      expect(s2Appearance.uiTarget).toContain('.theme-choices, .seg');
      const s2About = scene2.subBeats![7];
      expect(s2About.uiTarget).toContain('.check-updates-btn');
      expect(s2About.uiTarget).toContain('.open-logs-btn');
      expect(s2About.uiTarget).toContain('Close');
      expect(s2About.uiTarget).not.toContain('.check-credentials-btn');
      expect(s2About.uiTarget).not.toContain('Cancel');

      const scene4 = STORYBOARD_BEATS[3];
      expect(scene4.subBeats![2].visualAction).toContain('Switch to oim-db-history');

      const scene7 = STORYBOARD_BEATS[6];
      expect(scene7.subBeats![0].uiTarget).toBe('select.composer-select[aria-label="Agent mode"]');
      expect(scene7.subBeats![3].uiTarget).toBe(
        '.subagent-card .verdict-badge.approved, .message.assistant .markdown table',
      );
      expect(scene7.subBeats![3].visualState).toContain('"Approved"');
    });

    it('contains zero stale selectors or outdated UI copy across all beats and sub-beats', () => {
      const bannedTokens = [
        '.account-chip',
        '.account-mode',
        'v1.2.2',
        'Previous 7 days',
        '.domain-row',
        '.density-choice',
        '.markdown-body',
        'Switch to Database History',
        'Approved by Reviewer',
        'data-tip*="agent"',
        'data-tip*="Multi-agent"',
      ];
      const serialized = JSON.stringify(STORYBOARD_BEATS);
      for (const token of bannedTokens) {
        expect(serialized).not.toContain(token);
      }
    });

    it('ensures subBeats form a continuous timeline spanning the entire beat', () => {
      for (const beat of STORYBOARD_BEATS) {
        const beatRange = parseTimeRange(beat.timeRange);
        let currentSec = beatRange.startSec;
        for (const sub of beat.subBeats!) {
          const subRange = parseTimeRange(sub.timeRange);
          expect(subRange.startSec).toBe(currentSec);
          expect(subRange.endSec).toBeGreaterThan(subRange.startSec);
          currentSec = subRange.endSec;
        }
        expect(currentSec).toBe(beatRange.endSec);
      }
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

    it('includes all 7 beats in the table rows', () => {
      const md = renderStoryboardMarkdown(STORYBOARD_BEATS);
      for (const beat of STORYBOARD_BEATS) {
        expect(md).toContain(beat.timeRange);
        expect(md).toContain(beat.id);
        expect(md).toContain(beat.execution);
      }
    });

    it('renders the detailed planned storyboard breakdown section', () => {
      const md = renderStoryboardMarkdown(STORYBOARD_BEATS);
      expect(md).toContain('## Detailed Planned Storyboard Breakdown');
      expect(md).toContain(
        '| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |',
      );
      for (const beat of STORYBOARD_BEATS) {
        expect(md).toContain(`### ${beat.id.toUpperCase()}: ${beat.title}`);
        for (const sub of beat.subBeats!) {
          expect(md).toContain(sub.timeRange);
          expect(md).toContain(sub.narration);
        }
      }
    });
  });

  describe('generateStoryboardSrt', () => {
    it('generates sequential valid SRT subtitles from storyboard beats', () => {
      const srt = generateStoryboardSrt(STORYBOARD_BEATS);
      expect(srt).toContain('1\n00:00:00,000 --> 00:00:22,000');
      expect(srt).toContain('2\n00:00:22,000 --> 00:01:03,000');
      expect(srt).toContain('3\n00:01:03,000 --> 00:01:27,000');
      expect(srt).toContain('4\n00:01:27,000 --> 00:02:01,000');
      expect(srt).toContain('5\n00:02:01,000 --> 00:02:40,000');
      expect(srt).toContain('6\n00:02:40,000 --> 00:03:15,000');
      expect(srt).toContain('7\n00:03:15,000 --> 00:04:10,000');
    });

    it('matches spoken narration in SRT cues', () => {
      const srt = generateStoryboardSrt(STORYBOARD_BEATS);
      expect(srt).toContain(STORYBOARD_BEATS[0].narration);
      expect(srt).toContain(STORYBOARD_BEATS[6].narration);
    });
  });

  describe('getSceneSegments, getSegmentNarration, getSegmentDuration', () => {
    it('derives SceneSegment arrays for all 7 scenes summing to 250s total', () => {
      let totalSec = 0;
      for (const beat of STORYBOARD_BEATS) {
        const segs: SceneSegment[] = getSceneSegments(beat.id);
        expect(segs).toHaveLength(beat.subBeats!.length);
        for (const seg of segs) {
          expect(getSegmentNarration(segs, seg.key)).toBe(seg.narration);
          expect(getSegmentDuration(segs, seg.key)).toBe(seg.durationSec);
          expect(seg.durationSec).toBeGreaterThan(0);
          totalSec += seg.durationSec;
        }
      }
      expect(totalSec).toBe(250);
    });

    it('throws descriptive errors for unknown sceneId, empty/missing subBeats, duplicate/empty keys, and unknown segment keys', () => {
      expect(() => getSceneSegments('scene-999')).toThrow(/scene-999/);

      const noSubBeats: StoryboardBeat[] = [
        {
          id: 'empty-scene',
          timeRange: '00:00 -> 00:05',
          title: 'Empty',
          narration: 'None',
          visualAction: 'None',
          execution: 'real_app_ui',
        },
      ];
      expect(() => getSceneSegments('empty-scene', noSubBeats)).toThrow(/no subBeats/i);

      const dupKeys: StoryboardBeat[] = [
        {
          id: 'dup-scene',
          timeRange: '00:00 -> 00:06',
          title: 'Dup',
          narration: 'A B',
          visualAction: 'Test',
          execution: 'real_app_ui',
          subBeats: [
            { subId: 'dup-scene.1', key: 'same', timeRange: '00:00 -> 00:03', narration: 'A', visualAction: 'A' },
            { subId: 'dup-scene.2', key: 'same', timeRange: '00:03 -> 00:06', narration: 'B', visualAction: 'B' },
          ],
        },
      ];
      expect(() => getSceneSegments('dup-scene', dupKeys)).toThrow(/duplicate.*same/i);

      const emptyKey: StoryboardBeat[] = [
        {
          id: 'blank-key-scene',
          timeRange: '00:00 -> 00:03',
          title: 'Blank',
          narration: 'A',
          visualAction: 'Test',
          execution: 'real_app_ui',
          subBeats: [
            { subId: 'blank-key-scene.1', key: '   ', timeRange: '00:00 -> 00:03', narration: 'A', visualAction: 'A' },
          ],
        },
      ];
      expect(() => getSceneSegments('blank-key-scene', emptyKey)).toThrow(/empty.*key/i);

      const s1 = getSceneSegments('scene-1');
      expect(() => getSegmentNarration(s1, 'nonexistent')).toThrow(/nonexistent/);
      expect(() => getSegmentDuration(s1, 'nonexistent')).toThrow(/nonexistent/);
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

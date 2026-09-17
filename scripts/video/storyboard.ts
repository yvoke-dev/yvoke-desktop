/**
 * Storyboard definitions and subtitle synchronizer for automated Yvoke demo video generation.
 * Maps narrative timeline beats to visual UI interactions, spoken voiceover, and live model turns.
 */
import { generateSrt, type SubtitleCue } from './subtitles';

export class MalformedTimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTimeRangeError';
  }
}

export interface StoryboardBeat {
  id: string;
  timeRange: string; // e.g. "00:00 -> 00:20"
  title: string;
  narration: string;
  visualAction: string;
  execution: 'real_app_ui' | 'real_live_turn';
  turnConfig?: {
    playbook?: string;
    prompt?: string;
    followUp?: string;
    mode?: 'single' | 'orchestrator';
    expectValidationWarning?: boolean;
    expectClarification?: boolean;
  };
}

/**
 * Parses a time range string in the format "MM:SS -> MM:SS" into start and end seconds.
 * Throws MalformedTimeRangeError if the format is invalid or if startSec >= endSec.
 */
export function parseTimeRange(timeRange: string): { startSec: number; endSec: number } {
  const match = timeRange.match(/^\s*(\d{1,2}):(\d{2})\s*->\s*(\d{1,2}):(\d{2})\s*$/);
  if (!match) {
    throw new MalformedTimeRangeError(
      `Invalid time range format: "${timeRange}". Expected format "MM:SS -> MM:SS".`,
    );
  }

  const min1 = parseInt(match[1], 10);
  const sec1 = parseInt(match[2], 10);
  const min2 = parseInt(match[3], 10);
  const sec2 = parseInt(match[4], 10);

  if (sec1 >= 60 || sec2 >= 60) {
    throw new MalformedTimeRangeError(
      `Seconds component out of range (>= 60) in time range: "${timeRange}".`,
    );
  }

  const startSec = min1 * 60 + sec1;
  const endSec = min2 * 60 + sec2;

  if (startSec >= endSec) {
    throw new MalformedTimeRangeError(
      `startSec (${startSec}) must be strictly less than endSec (${endSec}) in time range: "${timeRange}".`,
    );
  }

  return { startSec, endSec };
}

export const STORYBOARD_BEATS: StoryboardBeat[] = [
  {
    id: 'scene-1',
    timeRange: '00:00 -> 00:20',
    title: 'App & Sidebar Overview',
    narration:
      'Welcome to Yvoke Desktop, the native AI assistant for deep enterprise engineering. On the left, the sidebar organizes your conversation history into clear timeframes, with instant search across past discussions. At the bottom, view your authenticated profile, security mode, and access application settings.',
    visualAction:
      'Launch application, highlight sidebar timeline buckets (Today, Previous 7 days), glide over authenticated profile indicator and server connection status.',
    execution: 'real_app_ui',
  },
  {
    id: 'scene-2',
    timeRange: '00:20 -> 00:48',
    title: 'Settings Walkthrough',
    narration:
      'Opening Settings reveals full control over your environment. Under Server, configure backend endpoints, transport, and authentication. Models lets you define Claude model versions and default thinking effort. Agents configures multi-agent roles, turns, and automatic playbook validation. Web Search manages enterprise domain allowlists, Appearance customizes themes and density, while Advanced and About display identity registration and version details.',
    visualAction:
      'Click Settings gear icon, systematically tab through navigation sections (Server, Models, Agents, Web Search, Appearance, Advanced, About) highlighting critical configuration controls, return to main chat view.',
    execution: 'real_app_ui',
  },
  {
    id: 'scene-3',
    timeRange: '00:48 -> 01:10',
    title: 'Main Window & Composer',
    narration:
      'Starting a new conversation opens the main workspace. The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history. Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls.',
    visualAction:
      'Click New Conversation (+), open Playbook picker dropdown (/), highlight domain playbooks, focus composer textarea, inspect model selector and thinking slider.',
    execution: 'real_app_ui',
  },
  {
    id: 'scene-4',
    timeRange: '01:10 -> 01:45',
    title: 'Live Query 1 — Playbook Validation',
    narration:
      'Here, an engineer asks when the table POLPlaybook was introduced under the getting-started playbook. Yvoke immediately catches that table migration history belongs in database records, recommending oim-db-history before dispatching.',
    visualAction:
      'Select oim-getting-started playbook, enter prompt "When was the table POLPlaybook introduced?", submit query, trigger preflight recommendation card, accept recommendation switching to oim-db-history, stream response.',
    execution: 'real_live_turn',
    turnConfig: {
      playbook: 'oim-getting-started',
      prompt: 'When was the table POLPlaybook introduced?',
      expectValidationWarning: true,
    },
  },
  {
    id: 'scene-5',
    timeRange: '01:45 -> 02:20',
    title: 'Live Query 2 — Follow-Up & Search Hints',
    narration:
      'In this conversation, we explore iterative follow-ups and search hints. After defining a value template, we prompt the assistant to search Teams and Confluence knowledge, effortlessly combining official documentation with real-world operational experience.',
    visualAction:
      'Submit initial question "what is a value template?", await answer, submit multi-turn follow-up with search hints for Teams and Confluence, inspect citations and operational knowledge synthesis.',
    execution: 'real_live_turn',
    turnConfig: {
      playbook: 'oim-getting-started',
      prompt: 'what is a value template?',
      followUp: 'check if you find any practical info in teams or confluence',
    },
  },
  {
    id: 'scene-6',
    timeRange: '02:20 -> 02:55',
    title: 'Live Query 3 — Clarifying Questions & Citations',
    narration:
      'When querying complex database schema changes, Yvoke surfaces an interactive clarification card to confirm scope. Selecting an option produces grounded answers with verified citation pills and complete reasoning traces.',
    visualAction:
      'Submit query "what database changes were done between 9.3.1 and 10.0?" under oim-db-history, observe Clarification Required interactive card, click "Identity & Authentication Tables" option, inspect verified citation pill, open citation modal, view TraceBar reasoning steps.',
    execution: 'real_live_turn',
    turnConfig: {
      playbook: 'oim-db-history',
      prompt: 'what database changes were done between 9.3.1 and 10.0?',
      expectClarification: true,
    },
  },
  {
    id: 'scene-7',
    timeRange: '02:55 -> 03:40',
    title: 'Live Query 4 — Multi-Agent System (MAS)',
    narration:
      'For multi-faceted trade-offs, switching to Multi-Agent mode activates specialized roles. Autonomous specialists query parallel corpuses to compare connector options, while the Reviewer gate validates consistency and approves the response.',
    visualAction:
      'Start fresh thread with isolated session, switch composer agent mode dropdown to Multi-agent (orchestrator), submit connector comparison query, observe Specialist subagent cards execute concurrently, view Reviewer validation pass and approved review badge.',
    execution: 'real_live_turn',
    turnConfig: {
      mode: 'orchestrator',
      prompt:
        'Compare standard connector vs csv connector vs custom connector via PowerShell considering teams/confluence',
    },
  },
  {
    id: 'scene-8',
    timeRange: '03:40 -> 04:00',
    title: 'Instant Search & Theme Toggle',
    narration:
      'Yvoke delivers sub-ten-millisecond instant search across your entire conversation history, coupled with a responsive, polished UI supporting dark and light themes.',
    visualAction:
      'Focus sidebar search box, type instant query ("POLPlaybook" / "connector"), verify instant search hit highlight (<10ms), clear search, toggle theme between dark and light, conclude video.',
    execution: 'real_app_ui',
  },
];

/**
 * Renders the storyboard beats as a formatted markdown document with synchronized table.
 */
export function renderStoryboardMarkdown(beats: StoryboardBeat[] = STORYBOARD_BEATS): string {
  const lines: string[] = [
    '# Yvoke Desktop Demo Video Storyboard',
    '',
    'Comprehensive 8-scene walkthrough synchronized between spoken voiceover narration, visual UI actions, and live agent execution modes.',
    '',
    '| Time Range | Scene / ID | Spoken Narration | Visual UI Action | Execution Mode |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const beat of beats) {
    const sceneIdTitle = `${beat.id}: ${beat.title}`;
    const cleanNarration = beat.narration.replace(/\|/g, '\\|');
    const cleanVisual = beat.visualAction.replace(/\|/g, '\\|');
    lines.push(
      `| ${beat.timeRange} | ${sceneIdTitle} | ${cleanNarration} | ${cleanVisual} | ${beat.execution} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generates an SRT subtitle file from storyboard beats using timeRange intervals.
 */
export function generateStoryboardSrt(beats: StoryboardBeat[] = STORYBOARD_BEATS): string {
  const cues: SubtitleCue[] = beats.map((beat) => {
    const { startSec, endSec } = parseTimeRange(beat.timeRange);
    return {
      startTimeMs: startSec * 1000,
      endTimeMs: endSec * 1000,
      text: beat.narration,
    };
  });

  return generateSrt(cues);
}

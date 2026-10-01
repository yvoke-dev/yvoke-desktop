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

export interface StoryboardSubBeat {
  subId: string;
  timeRange: string; // e.g. "00:00 -> 00:05"
  narration: string;
  visualAction: string;
  uiTarget?: string;
  visualState?: string;
}

export interface StoryboardBeat {
  id: string;
  timeRange: string; // e.g. "00:00 -> 00:20"
  title: string;
  narration: string;
  visualAction: string;
  execution: 'real_app_ui' | 'real_live_turn';
  subBeats?: StoryboardSubBeat[];
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
    subBeats: [
      {
        subId: 'scene-1.1',
        timeRange: '00:00 -> 00:05',
        narration:
          'Welcome to Yvoke Desktop, the native AI assistant for deep enterprise engineering.',
        visualAction:
          'Launch application in Full HD displaying active conversation. Glide demo cursor across active message response and thought trace pill.',
        uiTarget: '.chat-view, .message.assistant, .trace-bar',
        visualState:
          'Main workspace active in dark mode with pre-loaded conversation thread and model response visible.',
      },
      {
        subId: 'scene-1.2',
        timeRange: '00:05 -> 00:10',
        narration:
          'On the left, the sidebar organizes your conversation history into clear timeframes,',
        visualAction:
          'Glide mouse over sidebar thread list, hovering across Today and Previous 7 days group headers and thread items.',
        uiTarget: 'aside.thread-list, .thread-group-label, .thread-item',
        visualState:
          'Sidebar visible showing conversation history categorized by relative dates with thread titles and timestamps.',
      },
      {
        subId: 'scene-1.3',
        timeRange: '00:10 -> 00:15',
        narration: 'with instant search across past discussions.',
        visualAction:
          'Focus sidebar search input, type query "template", observe instant filtering across threads, then click clear.',
        uiTarget: '.thread-search input, .search-clear',
        visualState:
          'Search input focused, matching threads filtered in real-time (<10ms), then restored to full list.',
      },
      {
        subId: 'scene-1.4',
        timeRange: '00:15 -> 00:20',
        narration:
          'At the bottom, view your authenticated profile, security mode, and access application settings.',
        visualAction:
          'Glide down to sidebar footer, hovering over authenticated user email, security chip (🔒 dev · v1.2.2), sign-out icon, and Settings gear button.',
        uiTarget: '.thread-list-footer, .account-chip, button[data-tip="Settings"]',
        visualState:
          'User email, local dev security chip, and Settings button clearly in view.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-2.1',
        timeRange: '00:20 -> 00:24',
        narration: 'Opening Settings reveals full control over your environment.',
        visualAction:
          'Click Settings gear button in sidebar footer. Settings modal opens with smooth fade-in.',
        uiTarget: 'button[data-tip="Settings"], .settings-view',
        visualState:
          'Settings modal dialog open displaying sidebar navigation tabs and Server pane.',
      },
      {
        subId: 'scene-2.2',
        timeRange: '00:24 -> 00:28',
        narration:
          'Under Server, configure backend endpoints, transport, and authentication.',
        visualAction:
          'Inspect Server pane showing backend endpoint (http://localhost:8080), Streamable HTTP transport, and dev token field.',
        uiTarget: '.settings-nav button.nav-pane:has-text("Server"), .settings-field input',
        visualState: 'Server pane active showing local development configuration.',
      },
      {
        subId: 'scene-2.3',
        timeRange: '00:28 -> 00:32',
        narration:
          'Models lets you define Claude model versions and default thinking effort.',
        visualAction:
          'Click Models tab. Cursor glides over Claude 3.5 Sonnet / Opus selector chips and thinking effort radio options.',
        uiTarget: '.settings-nav button.nav-pane:has-text("Models"), .chip-list, .seg',
        visualState:
          'Models configuration active showing Sonnet selected and thinking effort controls.',
      },
      {
        subId: 'scene-2.4',
        timeRange: '00:32 -> 00:36',
        narration:
          'Agents configures multi-agent roles, turns, and automatic playbook validation.',
        visualAction:
          'Click Agents tab. Hover over playbook validation toggle checkbox and multi-agent system role cards.',
        uiTarget: '.settings-nav button.nav-pane:has-text("Agents"), .check-field input, .role-card',
        visualState:
          'Agents pane displaying validation toggle enabled and orchestrator/specialist/reviewer settings.',
      },
      {
        subId: 'scene-2.5',
        timeRange: '00:36 -> 00:40',
        narration: 'Web Search manages enterprise domain allowlists,',
        visualAction:
          'Click Web search tab. Inspect enterprise domain allowlist rows (support.oneidentity.com).',
        uiTarget: '.settings-nav button.nav-pane:has-text("Web search"), .domain-row',
        visualState: 'Web search pane showing enterprise domain allowlist entries.',
      },
      {
        subId: 'scene-2.6',
        timeRange: '00:40 -> 00:44',
        narration: 'Appearance customizes themes and density,',
        visualAction:
          'Click Appearance tab. Glide across Dark, Light, System theme choices and layout density controls.',
        uiTarget:
          '.settings-nav button.nav-pane:has-text("Appearance"), .theme-choices, .density-choice',
        visualState:
          'Appearance pane showing dark theme and comfortable density selected.',
      },
      {
        subId: 'scene-2.7',
        timeRange: '00:44 -> 00:48',
        narration:
          'while Advanced and About display identity registration and version details.',
        visualAction:
          'Click Advanced tab (inspecting dev token notes), click About tab (verifying version 1.2.2), then click Cancel button to exit.',
        uiTarget:
          '.settings-nav button.nav-pane:has-text("Advanced"), .about-version-row, .dialog-actions button:has-text("Cancel")',
        visualState:
          'True version v1.2.2 displayed; modal closes returning to main workspace.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-3.1',
        timeRange: '00:48 -> 00:52',
        narration: 'Starting a new conversation opens the main workspace.',
        visualAction:
          'Click "+ New Conversation" button in sidebar header. Workspace resets to empty thread with centered greeting.',
        uiTarget: 'button[data-tip="New conversation"], .chat-view',
        visualState:
          'Pristine new thread view showing empty composer and quick-start suggestions.',
      },
      {
        subId: 'scene-3.2',
        timeRange: '00:52 -> 01:00',
        narration:
          'The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history.',
        visualAction:
          'Open Playbook picker dropdown (/), focus search filter, glide over domain playbooks (oim-getting-started, oim-db-history).',
        uiTarget: '.picker, .picker-filter input, .picker-row',
        visualState:
          'Playbook picker grid open, displaying curated domain playbooks with scoped source descriptions.',
      },
      {
        subId: 'scene-3.3',
        timeRange: '01:00 -> 01:10',
        narration:
          'Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls.',
        visualAction:
          'Cursor inspects composer textarea, file/image attach button, agent mode dropdown (Single/Multi-agent), model selector, and thinking effort selector.',
        uiTarget:
          '.composer textarea, .composer-attach-btn, select.composer-select, button.composer-send',
        visualState:
          'Full composer control toolbar visible with active dropdowns and input capabilities.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-4.1',
        timeRange: '01:10 -> 01:18',
        narration:
          'Here, an engineer asks when the table POLPlaybook was introduced under the getting-started playbook.',
        visualAction:
          'Select oim-getting-started playbook. Type query "When was the table POLPlaybook introduced?" into composer.',
        uiTarget: '.composer textarea, .playbook-pill',
        visualState:
          'Composer contains user query with oim-getting-started playbook active.',
      },
      {
        subId: 'scene-4.2',
        timeRange: '01:18 -> 01:26',
        narration:
          'Yvoke immediately catches that table migration history belongs in database records,',
        visualAction:
          'Click Send (or ⌘↵). Playbook validation preflight detects mismatch and renders amber recommendation banner.',
        uiTarget: 'button.composer-send, .preflight-card',
        visualState:
          'Preflight recommendation card appears: "Question queries table migration history. We recommend switching from oim-getting-started to oim-db-history."',
      },
      {
        subId: 'scene-4.3',
        timeRange: '01:26 -> 01:34',
        narration: 'recommending oim-db-history before dispatching.',
        visualAction:
          'Glide cursor to recommendation card and click "Switch to oim-db-history" button. Card dismisses and query dispatches with corrected playbook.',
        uiTarget: '.preflight-card button.primary, .demo-switch-btn',
        visualState:
          'Playbook automatically switches to oim-db-history; live turn execution starts.',
      },
      {
        subId: 'scene-4.4',
        timeRange: '01:34 -> 01:45',
        narration:
          '[Turn Processing & Response Streaming]',
        visualAction:
          'Live query executes against Claude SDK. Thinking trace streams, and authoritative response details the schema migration version where POLPlaybook was added.',
        uiTarget: '.message.assistant, .trace-bar, .markdown-body',
        visualState:
          'Assistant response rendered with schema version details and TraceBar showing tool calls.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-5.1',
        timeRange: '01:45 -> 01:52',
        narration:
          'In this conversation, we explore iterative follow-ups and search hints.',
        visualAction:
          'Start new conversation, select oim-getting-started. Type prompt "what is a value template?" into composer.',
        uiTarget: 'button[data-tip="New conversation"], .composer textarea',
        visualState:
          'Composer filled with initial technical inquiry in getting-started domain.',
      },
      {
        subId: 'scene-5.2',
        timeRange: '01:52 -> 02:02',
        narration: 'After defining a value template,',
        visualAction:
          'Click Send. Model streams architectural explanation of Value Templates, calculation formulas, and column dependencies.',
        uiTarget: 'button.composer-send, .message.assistant',
        visualState:
          'Assistant message displays formal value template documentation and code examples.',
      },
      {
        subId: 'scene-5.3',
        timeRange: '02:02 -> 02:11',
        narration: 'we prompt the assistant to search Teams and Confluence knowledge,',
        visualAction:
          'Type follow-up query: "check if you find any practical info in teams or confluence". Click Send.',
        uiTarget: '.composer textarea, button.composer-send',
        visualState: 'Follow-up question dispatched in multi-turn conversation thread.',
      },
      {
        subId: 'scene-5.4',
        timeRange: '02:11 -> 02:20',
        narration:
          'effortlessly combining official documentation with real-world operational experience.',
        visualAction:
          'Model invokes enterprise search tools, synthesizing internal team discussions, known caveats, and deployment tips.',
        uiTarget: '.message.assistant:last-child, .citation-pill',
        visualState:
          'Comprehensive response synthesizing official documentation and real-world operational insights.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-6.1',
        timeRange: '02:20 -> 02:28',
        narration:
          'When querying complex database schema changes, Yvoke surfaces an interactive clarification card to confirm scope.',
        visualAction:
          'Start new thread under oim-db-history. Type "what database changes were done between 9.3.1 and 10.0?" and send. Clarifying question card renders.',
        uiTarget: '.composer textarea, .clarifying-question-card',
        visualState:
          'Interactive Clarification Required card displays domain options to narrow down schema scope.',
      },
      {
        subId: 'scene-6.2',
        timeRange: '02:28 -> 02:37',
        narration: 'Selecting an option produces grounded answers',
        visualAction:
          'Cursor clicks "Identity & Authentication Tables" option button. Card resolves to green confirmed badge and targeted query streams.',
        uiTarget: '.clarifying-question-card button, .clarified-badge',
        visualState:
          'Clarification pill marked resolved; assistant streams focused schema migration tables.',
      },
      {
        subId: 'scene-6.3',
        timeRange: '02:37 -> 02:46',
        narration: 'with verified citation pills',
        visualAction:
          'Cursor glides to citation pill, clicks to open Citation Overlay modal, inspects PDF source excerpt and section heading, then closes modal.',
        uiTarget: '.citation-pill, .citation-overlay, .modal-close',
        visualState:
          'Modal displays verified release notes excerpt, proving zero hallucination, then closes.',
      },
      {
        subId: 'scene-6.4',
        timeRange: '02:46 -> 02:55',
        narration: 'and complete reasoning traces.',
        visualAction:
          'Cursor clicks TraceBar below message to inspect step-by-step reasoning tokens, tool invocations, and execution latency.',
        uiTarget: '.trace-bar, .trace-step',
        visualState:
          'TraceBar accordion expands displaying sequential tool execution trace.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-7.1',
        timeRange: '02:55 -> 03:04',
        narration:
          'For multi-faceted trade-offs, switching to Multi-Agent mode activates specialized roles.',
        visualAction:
          'Start new conversation. In composer, change agent mode dropdown from "Single-agent" to "Multi-agent (orchestrator)".',
        uiTarget: 'select.composer-select[data-tip*="agent"]',
        visualState:
          'Composer switches to Multi-Agent Orchestrator mode with active orchestrator indicator.',
      },
      {
        subId: 'scene-7.2',
        timeRange: '03:04 -> 03:15',
        narration:
          'Autonomous specialists query parallel corpuses to compare connector options,',
        visualAction:
          'Type complex prompt: "Compare standard connector vs csv connector vs custom connector via PowerShell considering teams/confluence". Dispatch turn.',
        uiTarget: '.composer textarea, button.composer-send',
        visualState:
          'Turn dispatched. Orchestrator initiates execution plan and spawns parallel subagents.',
      },
      {
        subId: 'scene-7.3',
        timeRange: '03:15 -> 03:28',
        narration: 'while the Reviewer gate validates consistency',
        visualAction:
          'Subagent cards appear in parallel. Cursor inspects Specialist card headers, then watches Reviewer verification card start consistency audit.',
        uiTarget: '.subagent-card, .subagent-card-header',
        visualState:
          'Specialist agent cards show parallel execution; Reviewer card performs adversarial verification pass.',
      },
      {
        subId: 'scene-7.4',
        timeRange: '03:28 -> 03:40',
        narration: 'and approves the response.',
        visualAction:
          'Reviewer gate passes verification without hallucinations. Green verified review badge appears alongside final comprehensive connector comparison table.',
        uiTarget: '.review-badge, .message.assistant .markdown-body table',
        visualState:
          'Reviewer badge stamped "Approved by Reviewer"; rich markdown comparison table displayed.',
      },
    ],
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
    subBeats: [
      {
        subId: 'scene-8.1',
        timeRange: '03:40 -> 03:48',
        narration:
          'Yvoke delivers sub-ten-millisecond instant search across your entire conversation history,',
        visualAction:
          'Focus sidebar search box, type "Identity", observe instantaneous thread matching and snippet highlighting (<10ms), click clear.',
        uiTarget: '.thread-search input, .search-clear',
        visualState:
          'Instant search results filter in under 10ms with matched highlights, then clear cleanly.',
      },
      {
        subId: 'scene-8.2',
        timeRange: '03:48 -> 03:55',
        narration:
          'coupled with a responsive, polished UI supporting dark and light themes.',
        visualAction:
          'Toggle theme to Light mode. Entire UI re-themes cleanly with high contrast tokens and zero flicker.',
        uiTarget: ':root[data-theme="light"]',
        visualState:
          'Full app renders in Light mode with crisp typography and theme variables.',
      },
      {
        subId: 'scene-8.3',
        timeRange: '03:55 -> 04:00',
        narration: '[Outro & Transition to Dark Mode]',
        visualAction:
          'Toggle theme back to default Dark mode. Cursor moves to center. Video concludes cleanly.',
        uiTarget: ':root[data-theme="dark"]',
        visualState: 'Dark mode restored; smooth outro conclusion.',
      },
    ],
  },
];

/**
 * Renders the storyboard beats as a formatted markdown document with synchronized table and granular breakdown.
 */
export function renderStoryboardMarkdown(beats: StoryboardBeat[] = STORYBOARD_BEATS): string {
  const lines: string[] = [
    '# Yvoke Desktop Demo Video Storyboard',
    '',
    'Comprehensive 8-scene walkthrough synchronized between spoken voiceover narration, visual UI actions, and live agent execution modes.',
    '',
    '## High-Level Scene Overview',
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
  lines.push('---');
  lines.push('');
  lines.push('## Detailed Planned Storyboard Breakdown');
  lines.push('');
  lines.push(
    'Granular sub-beat choreography mapping second-by-second narration segments to target UI selectors, element interactions, and visual application states.',
  );
  lines.push('');

  for (const beat of beats) {
    lines.push(`### ${beat.id.toUpperCase()}: ${beat.title} (\`${beat.timeRange}\`)`);
    lines.push('');
    lines.push(`- **Execution Mode**: \`${beat.execution}\``);
    if (beat.turnConfig) {
      if (beat.turnConfig.playbook) {
        lines.push(`- **Playbook**: \`${beat.turnConfig.playbook}\``);
      }
      if (beat.turnConfig.mode) {
        lines.push(`- **Agent Mode**: \`${beat.turnConfig.mode}\``);
      }
      if (beat.turnConfig.prompt) {
        lines.push(`- **Prompt**: *"${beat.turnConfig.prompt}"*`);
      }
      if (beat.turnConfig.followUp) {
        lines.push(`- **Follow-up**: *"${beat.turnConfig.followUp}"*`);
      }
    }
    lines.push('');

    if (beat.subBeats && beat.subBeats.length > 0) {
      lines.push(
        '| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |',
      );
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const sub of beat.subBeats) {
        const cleanSubNarration = sub.narration.replace(/\|/g, '\\|');
        const cleanSubVisual = sub.visualAction.replace(/\|/g, '\\|');
        const cleanTarget = (sub.uiTarget || '-').replace(/\|/g, '\\|');
        const cleanState = (sub.visualState || '-').replace(/\|/g, '\\|');
        lines.push(
          `| ${sub.timeRange} | ${cleanSubNarration} | ${cleanSubVisual} | \`${cleanTarget}\` | ${cleanState} |`,
        );
      }
      lines.push('');
    }
  }

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

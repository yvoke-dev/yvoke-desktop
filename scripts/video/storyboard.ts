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
      'Welcome to Yvoke Desktop, the local AI workspace grounded in your enterprise knowledge base. On the left, the sidebar organizes your conversation history into clear timeframes, with instant search across past discussions. Along the bottom, check your active account, with quick access to Settings.',
    visualAction:
      'Launch application, highlight sidebar timeline buckets (Today, Previous 7 days), glide over authenticated profile indicator and server connection status.',
    execution: 'real_app_ui',
    subBeats: [
      {
        subId: 'scene-1.1',
        timeRange: '00:00 -> 00:07',
        narration:
          'Welcome to Yvoke Desktop, the local AI workspace grounded in your enterprise knowledge base.',
        visualAction:
          'Launch application in 720p HD displaying active conversation. Glide demo cursor across active message response and thought trace pill.',
        uiTarget: '.chat-view, .message.assistant, .trace-bar',
        visualState:
          'Main workspace active in dark mode with pre-loaded conversation thread and model response visible.',
      },
      {
        subId: 'scene-1.2',
        timeRange: '00:07 -> 00:12',
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
        timeRange: '00:12 -> 00:15',
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
          'Along the bottom, check your active account, with quick access to Settings.',
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
      'Opening Settings reveals full control over your environment. Under Server, configure backend endpoints, transport, and authentication. Models lets you define Claude model versions and default thinking effort. Agents configures multi-agent roles, turns, and automatic playbook validation. Web Search toggles web access while displaying the allowed domains, Appearance customizes themes and density, while About lets you verify your credentials and check for updates.',
    visualAction:
      'Click Settings gear icon, systematically tab through navigation sections (Server, Models, Agents, Web Search, Appearance, About), click check for updates and verify credentials, then close settings.',
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
          'Click Models tab. Cursor glides over Claude Sonnet / Opus selector chips and thinking effort radio options.',
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
        narration: 'Web Search toggles web access while displaying the allowed domains,',
        visualAction:
          'Click Web search tab. View the web tools toggle and inspect the enforced enterprise domain allowlist rows (support.oneidentity.com).',
        uiTarget: '.settings-nav button.nav-pane:has-text("Web search"), .domain-row',
        visualState: 'Web search pane showing enterprise domain allowlist entries.',
      },
      {
        subId: 'scene-2.6',
        timeRange: '00:40 -> 00:43',
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
        timeRange: '00:43 -> 00:48',
        narration:
          'while About lets you verify your credentials and check for updates.',
        visualAction:
          'Click About tab, click Check for Updates and wait for status, click Check Credentials and wait for verification badges, then click Cancel to return to workspace.',
        uiTarget:
          '.settings-nav button.nav-pane:has-text("About"), .check-updates-btn, .check-credentials-btn, .dialog-actions button:has-text("Cancel")',
        visualState:
          'About pane active with verified update and credential badges; modal closes returning to main workspace.',
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
      'Here, a consultant asks when the table POLPlaybook was introduced under the getting-started playbook. Yvoke determines that the selected playbook should not be used for this question, and it recommends using the oim-db-history playbook instead. Now, we wait for the response as Yvoke queries the database history and streams the answer.',
    visualAction:
      'Select oim-getting-started playbook, enter prompt "When was the table POLPlaybook introduced?", submit query, trigger preflight recommendation card, accept recommendation switching to oim-db-history, wait for completed streamed response.',
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
          'Here, a consultant asks when the table POLPlaybook was introduced under the getting-started playbook.',
        visualAction:
          'Select oim-getting-started playbook. Type query "When was the table POLPlaybook introduced?" into composer and click Send.',
        uiTarget: '.picker-row, .active-playbook, .composer textarea, button.composer-send',
        visualState:
          'Composer contains user query with oim-getting-started playbook active, send button clicked.',
      },
      {
        subId: 'scene-4.2',
        timeRange: '01:18 -> 01:25',
        narration:
          'Yvoke determines that the selected playbook should not be used for this question, and',
        visualAction:
          'Preflight validation runs and displays amber recommendation card with reason and suggested playbook.',
        uiTarget: '.preflight-checking, .preflight-card, .preflight-card-reason',
        visualState:
          'Amber recommendation card visible explaining table migration history belongs in database records.',
      },
      {
        subId: 'scene-4.3',
        timeRange: '01:25 -> 01:31',
        narration: 'it recommends using the oim-db-history playbook instead.',
        visualAction:
          'Glide cursor to recommendation card and click "Switch to Database History" button to accept the selection.',
        uiTarget: '.preflight-card button.primary',
        visualState:
          'Card dismisses, composer playbook switches to oim-db-history, live turn dispatches.',
      },
      {
        subId: 'scene-4.4',
        timeRange: '01:31 -> 01:45',
        narration:
          'Now, we wait for the response as Yvoke queries the database history and streams the answer.',
        visualAction:
          'Wait until the response is finished and the Send button reappears from Stop. Cursor glides over TraceBar and streaming answer.',
        uiTarget:
          'button.danger.composer-send, button.primary.composer-send, .trace-bar, .message.assistant',
        visualState:
          'Turn completes, Stop button reverts to Send, assistant response renders with schema version details.',
      },
    ],
  },
  {
    id: 'scene-5',
    timeRange: '01:45 -> 02:20',
    title: 'Live Query 2 — Follow-Up, Citations & Search Hints',
    narration:
      'In this conversation, we explore iterative follow-ups and search hints. Now, we wait for the response as Yvoke queries the manuals and streams the explanation. Notice that every statement that comes from documentation is cited. Clicking a citation link reveals the exact source passage from the manual. Next, we prompt the assistant to search Teams and Confluence knowledge, effortlessly combining official documentation with real-world operational experience as Yvoke completes the answer.',
    visualAction:
      'Submit initial question "what is a value template?", await answer, click citation link to inspect source modal, close citation modal, submit multi-turn follow-up with search hints for Teams and Confluence, await completed response.',
    execution: 'real_live_turn',
    turnConfig: {
      playbook: 'oim-full',
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
          'Start new conversation, select oim-full. Type prompt "what is a value template?" into composer, click Send, and if preflight recommendation card appears, click "Send anyway".',
        uiTarget:
          'button[data-tip="New conversation"], .composer textarea, button.composer-send, .preflight-card button',
        visualState:
          'Composer filled with initial technical inquiry under oim-full, preflight checked, send anyway clicked.',
      },
      {
        subId: 'scene-5.2',
        timeRange: '01:52 -> 02:00',
        narration:
          'Now, we wait for the response as Yvoke queries the manuals and streams the explanation.',
        visualAction:
          'Wait until first turn completes (Stop button disappears, Send button reappears). Cursor hovers over the streamed response.',
        uiTarget: 'button.danger.composer-send, button.primary.composer-send, .message.assistant',
        visualState:
          'Assistant message displays formal value template documentation and formula definitions.',
      },
      {
        subId: 'scene-5.3',
        timeRange: '02:00 -> 02:07',
        narration:
          'Notice that every statement that comes from documentation is cited. Clicking a citation link reveals the exact source passage from the manual.',
        visualAction:
          'Cursor clicks citation link. Citation source overlay modal opens displaying manual title and excerpt. Window remains open for 5 seconds for viewer inspection. Cursor clicks Close (✕).',
        uiTarget: 'button.citation-link, .citation-overlay, .citation-modal-header button',
        visualState:
          'Citation modal renders exact manual excerpt for 5 seconds, then cleanly closes back to the thread.',
      },
      {
        subId: 'scene-5.4',
        timeRange: '02:07 -> 02:13',
        narration:
          'Next, we prompt the assistant to search Teams and Confluence knowledge,',
        visualAction:
          'Cursor scrolls message thread smoothly to the bottom. Type follow-up query: "check if you find any practical info in teams or confluence" into composer. Click Send.',
        uiTarget: '.messages, .composer textarea, button.composer-send',
        visualState: 'Thread scrolled to bottom, follow-up question dispatched in multi-turn conversation thread.',
      },
      {
        subId: 'scene-5.5',
        timeRange: '02:13 -> 02:20',
        narration:
          'effortlessly combining official documentation with real-world operational experience as Yvoke completes the answer.',
        visualAction:
          'Model invokes enterprise search tools. Wait until second turn completes and Send button reappears. Cursor inspects synthesized tips and caveats.',
        uiTarget: '.message.assistant:last-child, button.primary.composer-send',
        visualState:
          'Comprehensive response synthesizing official documentation and real-world operational insights.',
      },
    ],
  },
  {
    id: 'scene-6',
    timeRange: '02:20 -> 02:55',
    title: 'Live Query 3 — Clarifying Questions & Disambiguation',
    narration:
      'When an ambiguous query is made, Yvoke surfaces an interactive clarification card to confirm scope. Selecting an option narrows the query to the chosen domain, streaming the relevant table and column modifications. Opening the trace reveals the underlying tool calls and database queries executed to retrieve the schema history.',
    visualAction:
      'Submit query "what database changes were done for the AOB module between 9.3.1 and 10.0?" under oim-db-history, observe Clarification Required interactive card, click domain option button, wait for streaming response to finish, then click TraceBar to expand and inspect the tool calls.',
    execution: 'real_live_turn',
    turnConfig: {
      playbook: 'oim-db-history',
      prompt: 'what database changes were done for the AOB module between 9.3.1 and 10.0?',
      expectClarification: true,
    },
    subBeats: [
      {
        subId: 'scene-6.1',
        timeRange: '02:20 -> 02:29',
        narration:
          'When an ambiguous query is made, Yvoke surfaces an interactive clarification card to confirm scope.',
        visualAction:
          'Start new conversation under oim-db-history. Type "what database changes were done for the AOB module between 9.3.1 and 10.0?" into composer and send. Trace block collapses immediately upon appearance, keeping the interface uncluttered while the Clarification Required card renders with selectable domain options.',
        uiTarget: '.composer textarea, button.composer-send, .clarifying-question-card',
        visualState:
          'Interactive Clarification Required card displays domain options to narrow down schema scope.',
      },
      {
        subId: 'scene-6.2',
        timeRange: '02:29 -> 02:43',
        narration:
          'Selecting an option narrows the query to the chosen domain, streaming the relevant table and column modifications.',
        visualAction:
          'Cursor clicks the domain option button (e.g. "Schema changes in release 10.0"). Card resolves to green confirmed badge ("Clarification provided"), and the focused schema change table streams while trace stays collapsed and thread auto-scrolls.',
        uiTarget:
          '.clarifying-question-card button.option-button, .clarified-badge, .message.assistant',
        visualState:
          'Clarification resolved; assistant streams focused schema migration tables with auto-scroll.',
      },
      {
        subId: 'scene-6.3',
        timeRange: '02:43 -> 02:55',
        narration:
          'Opening the trace reveals the underlying tool calls and database queries executed to retrieve the schema history.',
        visualAction:
          'With the response complete, cursor glides to the collapsed TraceBar and clicks to open it, inspecting the executed database history tool calls and reasoning steps.',
        uiTarget: 'button.trace-bar, .trace-body, .trace-step',
        visualState:
          'TraceBar accordion expands displaying sequential tool execution trace.',
      },
    ],
  },
  {
    id: 'scene-7',
    timeRange: '02:55 -> 03:50',
    title: 'Live Query 4 — Multi-Agent System (MAS)',
    narration:
      'When queries span multiple knowledge areas and rigorous review is essential, Multi-Agent mode coordinates specialized roles. Specialists investigate each connector architecture in parallel, while an independent Reviewer gate guards against hallucinations and approves the synthesized response. Thank you for watching this overview of Yvoke Desktop. Experience grounded, verifiable intelligence across your knowledge base.',
    visualAction:
      'Start fresh thread with isolated session, switch composer agent mode dropdown to Multi-agent (orchestrator), submit connector comparison query, observe Specialist subagent cards execute concurrently, view Reviewer validation pass and approved review badge, then conclude with outro.',
    execution: 'real_live_turn',
    turnConfig: {
      mode: 'orchestrator',
      prompt:
        'Compare standard connector vs csv connector vs custom connector via PowerShell considering also teams/confluence.',
    },
    subBeats: [
      {
        subId: 'scene-7.1',
        timeRange: '02:55 -> 03:04',
        narration:
          'When queries span multiple knowledge areas and rigorous review is essential, Multi-Agent mode coordinates specialized roles.',
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
          'Specialists investigate each connector architecture in parallel,',
        visualAction:
          'Type prompt: "Compare standard connector vs csv connector vs custom connector via PowerShell considering also teams/confluence.". Dispatch turn. Orchestrator spawns parallel specialist subagent cards.',
        uiTarget: '.composer textarea, button.composer-send',
        visualState:
          'Turn dispatched. Orchestrator initiates execution plan and spawns parallel subagents.',
      },
      {
        subId: 'scene-7.3',
        timeRange: '03:15 -> 03:28',
        narration: 'while an independent Reviewer gate guards against hallucinations',
        visualAction:
          'Subagent cards run parallel investigations across manuals and enterprise notes. Reviewer card activates and performs adversarial consistency and hallucination verification pass.',
        uiTarget: '.subagent-card, .subagent-card-header',
        visualState:
          'Specialist agent cards show parallel execution; Reviewer card performs adversarial verification pass.',
      },
      {
        subId: 'scene-7.4',
        timeRange: '03:28 -> 03:40',
        narration: 'and approves the synthesized response.',
        visualAction:
          'Reviewer gate passes verification without hallucinations. Green verified review badge appears on Reviewer card. Cursor inspects a Specialist card and the Reviewer card, then hovers over the final comprehensive connector comparison table.',
        uiTarget: '.subagent-card .verdict-badge.approved, .message.assistant .markdown-body table',
        visualState:
          'Reviewer badge stamped "Approved by Reviewer"; rich markdown comparison table displayed.',
      },
      {
        subId: 'scene-7.5',
        timeRange: '03:40 -> 03:50',
        narration:
          'Thank you for watching this overview of Yvoke Desktop. Experience grounded, verifiable intelligence across your knowledge base.',
        visualAction:
          'Cursor glides smoothly to resting position in the center, view settles over the clean workspace, and the video concludes.',
        uiTarget: '.chat-view, .app-body',
        visualState:
          'Clean resting state showcasing final verified answer; smooth outro conclusion.',
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
    'Comprehensive 7-scene walkthrough synchronized between spoken voiceover narration, visual UI actions, and live agent execution modes.',
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

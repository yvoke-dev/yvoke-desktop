# Yvoke Desktop Demo Video Storyboard

Comprehensive 8-scene walkthrough synchronized between spoken voiceover narration, visual UI actions, and live agent execution modes.

## High-Level Scene Overview

| Time Range | Scene / ID | Spoken Narration | Visual UI Action | Execution Mode |
| :--- | :--- | :--- | :--- | :--- |
| 00:00 -> 00:20 | scene-1: App & Sidebar Overview | Welcome to Yvoke Desktop, the native AI assistant for deep enterprise engineering. On the left, the sidebar organizes your conversation history into clear timeframes, with instant search across past discussions. At the bottom, view your authenticated profile, security mode, and access application settings. | Launch application, highlight sidebar timeline buckets (Today, Previous 7 days), glide over authenticated profile indicator and server connection status. | real_app_ui |
| 00:20 -> 00:48 | scene-2: Settings Walkthrough | Opening Settings reveals full control over your environment. Under Server, configure backend endpoints, transport, and authentication. Models lets you define Claude model versions and default thinking effort. Agents configures multi-agent roles, turns, and automatic playbook validation. Web Search manages enterprise domain allowlists, Appearance customizes themes and density, while Advanced and About display identity registration and version details. | Click Settings gear icon, systematically tab through navigation sections (Server, Models, Agents, Web Search, Appearance, Advanced, About) highlighting critical configuration controls, return to main chat view. | real_app_ui |
| 00:48 -> 01:10 | scene-3: Main Window & Composer | Starting a new conversation opens the main workspace. The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history. Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls. | Click New Conversation (+), open Playbook picker dropdown (/), highlight domain playbooks, focus composer textarea, inspect model selector and thinking slider. | real_app_ui |
| 01:10 -> 01:45 | scene-4: Live Query 1 — Playbook Validation | Here, an engineer asks when the table POLPlaybook was introduced under the getting-started playbook. Yvoke immediately catches that table migration history belongs in database records, recommending oim-db-history before dispatching. | Select oim-getting-started playbook, enter prompt "When was the table POLPlaybook introduced?", submit query, trigger preflight recommendation card, accept recommendation switching to oim-db-history, stream response. | real_live_turn |
| 01:45 -> 02:20 | scene-5: Live Query 2 — Follow-Up & Search Hints | In this conversation, we explore iterative follow-ups and search hints. After defining a value template, we prompt the assistant to search Teams and Confluence knowledge, effortlessly combining official documentation with real-world operational experience. | Submit initial question "what is a value template?", await answer, submit multi-turn follow-up with search hints for Teams and Confluence, inspect citations and operational knowledge synthesis. | real_live_turn |
| 02:20 -> 02:55 | scene-6: Live Query 3 — Clarifying Questions & Citations | When querying complex database schema changes, Yvoke surfaces an interactive clarification card to confirm scope. Selecting an option produces grounded answers with verified citation pills and complete reasoning traces. | Submit query "what database changes were done between 9.3.1 and 10.0?" under oim-db-history, observe Clarification Required interactive card, click "Identity & Authentication Tables" option, inspect verified citation pill, open citation modal, view TraceBar reasoning steps. | real_live_turn |
| 02:55 -> 03:40 | scene-7: Live Query 4 — Multi-Agent System (MAS) | For multi-faceted trade-offs, switching to Multi-Agent mode activates specialized roles. Autonomous specialists query parallel corpuses to compare connector options, while the Reviewer gate validates consistency and approves the response. | Start fresh thread with isolated session, switch composer agent mode dropdown to Multi-agent (orchestrator), submit connector comparison query, observe Specialist subagent cards execute concurrently, view Reviewer validation pass and approved review badge. | real_live_turn |
| 03:40 -> 04:00 | scene-8: Instant Search & Theme Toggle | Yvoke delivers sub-ten-millisecond instant search across your entire conversation history, coupled with a responsive, polished UI supporting dark and light themes. | Focus sidebar search box, type instant query ("POLPlaybook" / "connector"), verify instant search hit highlight (<10ms), clear search, toggle theme between dark and light, conclude video. | real_app_ui |

---

## Detailed Planned Storyboard Breakdown

Granular sub-beat choreography mapping second-by-second narration segments to target UI selectors, element interactions, and visual application states.

### SCENE-1: App & Sidebar Overview (`00:00 -> 00:20`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 00:00 -> 00:05 | Welcome to Yvoke Desktop, the native AI assistant for deep enterprise engineering. | Launch application in Full HD displaying active conversation. Glide demo cursor across active message response and thought trace pill. | `.chat-view, .message.assistant, .trace-bar` | Main workspace active in dark mode with pre-loaded conversation thread and model response visible. |
| 00:05 -> 00:10 | On the left, the sidebar organizes your conversation history into clear timeframes, | Glide mouse over sidebar thread list, hovering across Today and Previous 7 days group headers and thread items. | `aside.thread-list, .thread-group-label, .thread-item` | Sidebar visible showing conversation history categorized by relative dates with thread titles and timestamps. |
| 00:10 -> 00:15 | with instant search across past discussions. | Focus sidebar search input, type query "template", observe instant filtering across threads, then click clear. | `.thread-search input, .search-clear` | Search input focused, matching threads filtered in real-time (<10ms), then restored to full list. |
| 00:15 -> 00:20 | At the bottom, view your authenticated profile, security mode, and access application settings. | Glide down to sidebar footer, hovering over authenticated user email, security chip (🔒 dev · v1.2.2), sign-out icon, and Settings gear button. | `.thread-list-footer, .account-chip, button[data-tip="Settings"]` | User email, local dev security chip, and Settings button clearly in view. |

### SCENE-2: Settings Walkthrough (`00:20 -> 00:48`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 00:20 -> 00:24 | Opening Settings reveals full control over your environment. | Click Settings gear button in sidebar footer. Settings modal opens with smooth fade-in. | `button[data-tip="Settings"], .settings-view` | Settings modal dialog open displaying sidebar navigation tabs and Server pane. |
| 00:24 -> 00:28 | Under Server, configure backend endpoints, transport, and authentication. | Inspect Server pane showing backend endpoint (http://localhost:8080), Streamable HTTP transport, and dev token field. | `.settings-nav button.nav-pane:has-text("Server"), .settings-field input` | Server pane active showing local development configuration. |
| 00:28 -> 00:32 | Models lets you define Claude model versions and default thinking effort. | Click Models tab. Cursor glides over Claude 3.5 Sonnet / Opus selector chips and thinking effort radio options. | `.settings-nav button.nav-pane:has-text("Models"), .chip-list, .seg` | Models configuration active showing Sonnet selected and thinking effort controls. |
| 00:32 -> 00:36 | Agents configures multi-agent roles, turns, and automatic playbook validation. | Click Agents tab. Hover over playbook validation toggle checkbox and multi-agent system role cards. | `.settings-nav button.nav-pane:has-text("Agents"), .check-field input, .role-card` | Agents pane displaying validation toggle enabled and orchestrator/specialist/reviewer settings. |
| 00:36 -> 00:40 | Web Search manages enterprise domain allowlists, | Click Web search tab. Inspect enterprise domain allowlist rows (support.oneidentity.com). | `.settings-nav button.nav-pane:has-text("Web search"), .domain-row` | Web search pane showing enterprise domain allowlist entries. |
| 00:40 -> 00:44 | Appearance customizes themes and density, | Click Appearance tab. Glide across Dark, Light, System theme choices and layout density controls. | `.settings-nav button.nav-pane:has-text("Appearance"), .theme-choices, .density-choice` | Appearance pane showing dark theme and comfortable density selected. |
| 00:44 -> 00:48 | while Advanced and About display identity registration and version details. | Click Advanced tab (inspecting dev token notes), click About tab (verifying version 1.2.2), then click Cancel button to exit. | `.settings-nav button.nav-pane:has-text("Advanced"), .about-version-row, .dialog-actions button:has-text("Cancel")` | True version v1.2.2 displayed; modal closes returning to main workspace. |

### SCENE-3: Main Window & Composer (`00:48 -> 01:10`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 00:48 -> 00:52 | Starting a new conversation opens the main workspace. | Click "+ New Conversation" button in sidebar header. Workspace resets to empty thread with centered greeting. | `button[data-tip="New conversation"], .chat-view` | Pristine new thread view showing empty composer and quick-start suggestions. |
| 00:52 -> 01:00 | The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history. | Open Playbook picker dropdown (/), focus search filter, glide over domain playbooks (oim-getting-started, oim-db-history). | `.picker, .picker-filter input, .picker-row` | Playbook picker grid open, displaying curated domain playbooks with scoped source descriptions. |
| 01:00 -> 01:10 | Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls. | Cursor inspects composer textarea, file/image attach button, agent mode dropdown (Single/Multi-agent), model selector, and thinking effort selector. | `.composer textarea, .composer-attach-btn, select.composer-select, button.composer-send` | Full composer control toolbar visible with active dropdowns and input capabilities. |

### SCENE-4: Live Query 1 — Playbook Validation (`01:10 -> 01:45`)

- **Execution Mode**: `real_live_turn`
- **Playbook**: `oim-getting-started`
- **Prompt**: *"When was the table POLPlaybook introduced?"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 01:10 -> 01:18 | Here, an engineer asks when the table POLPlaybook was introduced under the getting-started playbook. | Select oim-getting-started playbook. Type query "When was the table POLPlaybook introduced?" into composer. | `.composer textarea, .playbook-pill` | Composer contains user query with oim-getting-started playbook active. |
| 01:18 -> 01:26 | Yvoke immediately catches that table migration history belongs in database records, | Click Send (or ⌘↵). Playbook validation preflight detects mismatch and renders amber recommendation banner. | `button.composer-send, .preflight-card` | Preflight recommendation card appears: "Question queries table migration history. We recommend switching from oim-getting-started to oim-db-history." |
| 01:26 -> 01:34 | recommending oim-db-history before dispatching. | Glide cursor to recommendation card and click "Switch to oim-db-history" button. Card dismisses and query dispatches with corrected playbook. | `.preflight-card button.primary, .demo-switch-btn` | Playbook automatically switches to oim-db-history; live turn execution starts. |
| 01:34 -> 01:45 | [Turn Processing & Response Streaming] | Live query executes against Claude SDK. Thinking trace streams, and authoritative response details the schema migration version where POLPlaybook was added. | `.message.assistant, .trace-bar, .markdown-body` | Assistant response rendered with schema version details and TraceBar showing tool calls. |

### SCENE-5: Live Query 2 — Follow-Up & Search Hints (`01:45 -> 02:20`)

- **Execution Mode**: `real_live_turn`
- **Playbook**: `oim-getting-started`
- **Prompt**: *"what is a value template?"*
- **Follow-up**: *"check if you find any practical info in teams or confluence"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 01:45 -> 01:52 | In this conversation, we explore iterative follow-ups and search hints. | Start new conversation, select oim-getting-started. Type prompt "what is a value template?" into composer. | `button[data-tip="New conversation"], .composer textarea` | Composer filled with initial technical inquiry in getting-started domain. |
| 01:52 -> 02:02 | After defining a value template, | Click Send. Model streams architectural explanation of Value Templates, calculation formulas, and column dependencies. | `button.composer-send, .message.assistant` | Assistant message displays formal value template documentation and code examples. |
| 02:02 -> 02:11 | we prompt the assistant to search Teams and Confluence knowledge, | Type follow-up query: "check if you find any practical info in teams or confluence". Click Send. | `.composer textarea, button.composer-send` | Follow-up question dispatched in multi-turn conversation thread. |
| 02:11 -> 02:20 | effortlessly combining official documentation with real-world operational experience. | Model invokes enterprise search tools, synthesizing internal team discussions, known caveats, and deployment tips. | `.message.assistant:last-child, .citation-pill` | Comprehensive response synthesizing official documentation and real-world operational insights. |

### SCENE-6: Live Query 3 — Clarifying Questions & Citations (`02:20 -> 02:55`)

- **Execution Mode**: `real_live_turn`
- **Playbook**: `oim-db-history`
- **Prompt**: *"what database changes were done between 9.3.1 and 10.0?"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 02:20 -> 02:28 | When querying complex database schema changes, Yvoke surfaces an interactive clarification card to confirm scope. | Start new thread under oim-db-history. Type "what database changes were done between 9.3.1 and 10.0?" and send. Clarifying question card renders. | `.composer textarea, .clarifying-question-card` | Interactive Clarification Required card displays domain options to narrow down schema scope. |
| 02:28 -> 02:37 | Selecting an option produces grounded answers | Cursor clicks "Identity & Authentication Tables" option button. Card resolves to green confirmed badge and targeted query streams. | `.clarifying-question-card button, .clarified-badge` | Clarification pill marked resolved; assistant streams focused schema migration tables. |
| 02:37 -> 02:46 | with verified citation pills | Cursor glides to citation pill, clicks to open Citation Overlay modal, inspects PDF source excerpt and section heading, then closes modal. | `.citation-pill, .citation-overlay, .modal-close` | Modal displays verified release notes excerpt, proving zero hallucination, then closes. |
| 02:46 -> 02:55 | and complete reasoning traces. | Cursor clicks TraceBar below message to inspect step-by-step reasoning tokens, tool invocations, and execution latency. | `.trace-bar, .trace-step` | TraceBar accordion expands displaying sequential tool execution trace. |

### SCENE-7: Live Query 4 — Multi-Agent System (MAS) (`02:55 -> 03:40`)

- **Execution Mode**: `real_live_turn`
- **Agent Mode**: `orchestrator`
- **Prompt**: *"Compare standard connector vs csv connector vs custom connector via PowerShell considering teams/confluence"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 02:55 -> 03:04 | For multi-faceted trade-offs, switching to Multi-Agent mode activates specialized roles. | Start new conversation. In composer, change agent mode dropdown from "Single-agent" to "Multi-agent (orchestrator)". | `select.composer-select[data-tip*="agent"]` | Composer switches to Multi-Agent Orchestrator mode with active orchestrator indicator. |
| 03:04 -> 03:15 | Autonomous specialists query parallel corpuses to compare connector options, | Type complex prompt: "Compare standard connector vs csv connector vs custom connector via PowerShell considering teams/confluence". Dispatch turn. | `.composer textarea, button.composer-send` | Turn dispatched. Orchestrator initiates execution plan and spawns parallel subagents. |
| 03:15 -> 03:28 | while the Reviewer gate validates consistency | Subagent cards appear in parallel. Cursor inspects Specialist card headers, then watches Reviewer verification card start consistency audit. | `.subagent-card, .subagent-card-header` | Specialist agent cards show parallel execution; Reviewer card performs adversarial verification pass. |
| 03:28 -> 03:40 | and approves the response. | Reviewer gate passes verification without hallucinations. Green verified review badge appears alongside final comprehensive connector comparison table. | `.review-badge, .message.assistant .markdown-body table` | Reviewer badge stamped "Approved by Reviewer"; rich markdown comparison table displayed. |

### SCENE-8: Instant Search & Theme Toggle (`03:40 -> 04:00`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 03:40 -> 03:48 | Yvoke delivers sub-ten-millisecond instant search across your entire conversation history, | Focus sidebar search box, type "Identity", observe instantaneous thread matching and snippet highlighting (<10ms), click clear. | `.thread-search input, .search-clear` | Instant search results filter in under 10ms with matched highlights, then clear cleanly. |
| 03:48 -> 03:55 | coupled with a responsive, polished UI supporting dark and light themes. | Toggle theme to Light mode. Entire UI re-themes cleanly with high contrast tokens and zero flicker. | `:root[data-theme="light"]` | Full app renders in Light mode with crisp typography and theme variables. |
| 03:55 -> 04:00 | [Outro & Transition to Dark Mode] | Toggle theme back to default Dark mode. Cursor moves to center. Video concludes cleanly. | `:root[data-theme="dark"]` | Dark mode restored; smooth outro conclusion. |

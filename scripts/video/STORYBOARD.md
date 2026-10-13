# Yvoke Desktop Demo Video Storyboard

Comprehensive 7-scene walkthrough synchronized between spoken voiceover narration, visual UI actions, and live agent execution modes.

## High-Level Scene Overview

| Time Range | Scene / ID | Spoken Narration | Visual UI Action | Execution Mode |
| :--- | :--- | :--- | :--- | :--- |
| 00:00 -> 00:20 | scene-1: App & Sidebar Overview | Welcome to Yvoke Desktop, the local AI workspace grounded in your enterprise knowledge base. On the left, the sidebar organizes your conversation history into clear timeframes, with instant search across past discussions. Along the bottom, check your active account, with quick access to Settings. | Launch application, highlight sidebar timeline buckets (Today, Previous 7 days), glide over authenticated profile indicator and server connection status. | real_app_ui |
| 00:20 -> 00:48 | scene-2: Settings Walkthrough | Opening Settings reveals full control over your environment. Under Server, configure backend endpoints, transport, and authentication. Models lets you define Claude model versions and default thinking effort. Agents configures multi-agent roles, turns, and automatic playbook validation. Web Search toggles web access while displaying the allowed domains, Appearance customizes themes and density, while About lets you verify your credentials and check for updates. | Click Settings gear icon, systematically tab through navigation sections (Server, Models, Agents, Web Search, Appearance, About), click check for updates and verify credentials, then close settings. | real_app_ui |
| 00:48 -> 01:10 | scene-3: Main Window & Composer | Starting a new conversation opens the main workspace. The Playbook picker scopes the assistant to focused knowledge domains, from getting-started manuals to database migration history. Below, the composer provides rich prompt input, image attachments, seamless single-agent or multi-agent mode selection, and granular model and thinking controls. | Click New Conversation (+), open Playbook picker dropdown (/), highlight domain playbooks, focus composer textarea, inspect model selector and thinking slider. | real_app_ui |
| 01:10 -> 01:45 | scene-4: Live Query 1 — Playbook Validation | Here, a consultant asks when the table POLPlaybook was introduced under the getting-started playbook. Yvoke determines that the selected playbook should not be used for this question, and it recommends using the oim-db-history playbook instead. Now, we wait for the response as Yvoke queries the database history and streams the answer. | Select oim-getting-started playbook, enter prompt "When was the table POLPlaybook introduced?", submit query, trigger preflight recommendation card, accept recommendation switching to oim-db-history, wait for completed streamed response. | real_live_turn |
| 01:45 -> 02:20 | scene-5: Live Query 2 — Follow-Up, Citations & Search Hints | In this conversation, we explore iterative follow-ups and search hints. Now, we wait for the response as Yvoke queries the manuals and streams the explanation. Notice that every statement that comes from documentation is cited. Clicking a citation link reveals the exact source passage from the manual. Next, we prompt the assistant to search Teams and Confluence knowledge, effortlessly combining official documentation with real-world operational experience as Yvoke completes the answer. | Submit initial question "what is a value template?", await answer, click citation link to inspect source modal, close citation modal, submit multi-turn follow-up with search hints for Teams and Confluence, await completed response. | real_live_turn |
| 02:20 -> 02:55 | scene-6: Live Query 3 — Clarifying Questions & Disambiguation | When an ambiguous query is made, Yvoke surfaces an interactive clarification card to confirm scope. Selecting an option narrows the query to the chosen domain, streaming the relevant table and column modifications. Opening the trace reveals the underlying tool calls and database queries executed to retrieve the schema history. | Submit query "what database changes were done for the AOB module between 9.3.1 and 10.0?" under oim-db-history, observe Clarification Required interactive card, click domain option button, wait for streaming response to finish, then click TraceBar to expand and inspect the tool calls. | real_live_turn |
| 02:55 -> 03:50 | scene-7: Live Query 4 — Multi-Agent System (MAS) | When queries span multiple knowledge areas and rigorous review is essential, Multi-Agent mode coordinates specialized roles. Specialists investigate each connector architecture in parallel, while an independent Reviewer gate guards against hallucinations and approves the synthesized response. Thank you for watching this overview of Yvoke Desktop. Experience grounded, verifiable intelligence across your knowledge base. | Start fresh thread with isolated session, switch composer agent mode dropdown to Multi-agent (orchestrator), submit connector comparison query, observe Specialist subagent cards execute concurrently, view Reviewer validation pass and approved review badge, then conclude with outro. | real_live_turn |

---

## Detailed Planned Storyboard Breakdown

Granular sub-beat choreography mapping second-by-second narration segments to target UI selectors, element interactions, and visual application states.

### SCENE-1: App & Sidebar Overview (`00:00 -> 00:20`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 00:00 -> 00:07 | Welcome to Yvoke Desktop, the local AI workspace grounded in your enterprise knowledge base. | Launch application in 720p HD displaying active conversation. Glide demo cursor across active message response and thought trace pill. | `.chat-view, .message.assistant, .trace-bar` | Main workspace active in dark mode with pre-loaded conversation thread and model response visible. |
| 00:07 -> 00:12 | On the left, the sidebar organizes your conversation history into clear timeframes, | Glide mouse over sidebar thread list, hovering across Today and Previous 7 days group headers and thread items. | `aside.thread-list, .thread-group-label, .thread-item` | Sidebar visible showing conversation history categorized by relative dates with thread titles and timestamps. |
| 00:12 -> 00:15 | with instant search across past discussions. | Focus sidebar search input, type query "template", observe instant filtering across threads, then click clear. | `.thread-search input, .search-clear` | Search input focused, matching threads filtered in real-time (<10ms), then restored to full list. |
| 00:15 -> 00:20 | Along the bottom, check your active account, with quick access to Settings. | Glide down to sidebar footer, hovering over authenticated user email, security chip (🔒 dev · v1.2.2), sign-out icon, and Settings gear button. | `.thread-list-footer, .account-chip, button[data-tip="Settings"]` | User email, local dev security chip, and Settings button clearly in view. |

### SCENE-2: Settings Walkthrough (`00:20 -> 00:48`)

- **Execution Mode**: `real_app_ui`

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 00:20 -> 00:24 | Opening Settings reveals full control over your environment. | Click Settings gear button in sidebar footer. Settings modal opens with smooth fade-in. | `button[data-tip="Settings"], .settings-view` | Settings modal dialog open displaying sidebar navigation tabs and Server pane. |
| 00:24 -> 00:28 | Under Server, configure backend endpoints, transport, and authentication. | Inspect Server pane showing backend endpoint (http://localhost:8080), Streamable HTTP transport, and dev token field. | `.settings-nav button.nav-pane:has-text("Server"), .settings-field input` | Server pane active showing local development configuration. |
| 00:28 -> 00:32 | Models lets you define Claude model versions and default thinking effort. | Click Models tab. Cursor glides over Claude Sonnet / Opus selector chips and thinking effort radio options. | `.settings-nav button.nav-pane:has-text("Models"), .chip-list, .seg` | Models configuration active showing Sonnet selected and thinking effort controls. |
| 00:32 -> 00:36 | Agents configures multi-agent roles, turns, and automatic playbook validation. | Click Agents tab. Hover over playbook validation toggle checkbox and multi-agent system role cards. | `.settings-nav button.nav-pane:has-text("Agents"), .check-field input, .role-card` | Agents pane displaying validation toggle enabled and orchestrator/specialist/reviewer settings. |
| 00:36 -> 00:40 | Web Search toggles web access while displaying the allowed domains, | Click Web search tab. View the web tools toggle and inspect the enforced enterprise domain allowlist rows (support.oneidentity.com). | `.settings-nav button.nav-pane:has-text("Web search"), .domain-row` | Web search pane showing enterprise domain allowlist entries. |
| 00:40 -> 00:43 | Appearance customizes themes and density, | Click Appearance tab. Glide across Dark, Light, System theme choices and layout density controls. | `.settings-nav button.nav-pane:has-text("Appearance"), .theme-choices, .density-choice` | Appearance pane showing dark theme and comfortable density selected. |
| 00:43 -> 00:48 | while About lets you verify your credentials and check for updates. | Click About tab, click Check for Updates and wait for status, click Check Credentials and wait for verification badges, then click Cancel to return to workspace. | `.settings-nav button.nav-pane:has-text("About"), .check-updates-btn, .check-credentials-btn, .dialog-actions button:has-text("Cancel")` | About pane active with verified update and credential badges; modal closes returning to main workspace. |

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
| 01:10 -> 01:18 | Here, a consultant asks when the table POLPlaybook was introduced under the getting-started playbook. | Select oim-getting-started playbook. Type query "When was the table POLPlaybook introduced?" into composer and click Send. | `.picker-row, .active-playbook, .composer textarea, button.composer-send` | Composer contains user query with oim-getting-started playbook active, send button clicked. |
| 01:18 -> 01:25 | Yvoke determines that the selected playbook should not be used for this question, and | Preflight validation runs and displays amber recommendation card with reason and suggested playbook. | `.preflight-checking, .preflight-card, .preflight-card-reason` | Amber recommendation card visible explaining table migration history belongs in database records. |
| 01:25 -> 01:31 | it recommends using the oim-db-history playbook instead. | Glide cursor to recommendation card and click "Switch to Database History" button to accept the selection. | `.preflight-card button.primary` | Card dismisses, composer playbook switches to oim-db-history, live turn dispatches. |
| 01:31 -> 01:45 | Now, we wait for the response as Yvoke queries the database history and streams the answer. | Wait until the response is finished and the Send button reappears from Stop. Cursor glides over TraceBar and streaming answer. | `button.danger.composer-send, button.primary.composer-send, .trace-bar, .message.assistant` | Turn completes, Stop button reverts to Send, assistant response renders with schema version details. |

### SCENE-5: Live Query 2 — Follow-Up, Citations & Search Hints (`01:45 -> 02:20`)

- **Execution Mode**: `real_live_turn`
- **Playbook**: `oim-full`
- **Prompt**: *"what is a value template?"*
- **Follow-up**: *"check if you find any practical info in teams or confluence"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 01:45 -> 01:52 | In this conversation, we explore iterative follow-ups and search hints. | Start new conversation, select oim-full. Type prompt "what is a value template?" into composer, click Send, and if preflight recommendation card appears, click "Send anyway". | `button[data-tip="New conversation"], .composer textarea, button.composer-send, .preflight-card button` | Composer filled with initial technical inquiry under oim-full, preflight checked, send anyway clicked. |
| 01:52 -> 02:00 | Now, we wait for the response as Yvoke queries the manuals and streams the explanation. | Wait until first turn completes (Stop button disappears, Send button reappears). Cursor hovers over the streamed response. | `button.danger.composer-send, button.primary.composer-send, .message.assistant` | Assistant message displays formal value template documentation and formula definitions. |
| 02:00 -> 02:07 | Notice that every statement that comes from documentation is cited. Clicking a citation link reveals the exact source passage from the manual. | Cursor clicks citation link. Citation source overlay modal opens displaying manual title and excerpt. Window remains open for 5 seconds for viewer inspection. Cursor clicks Close (✕). | `button.citation-link, .citation-overlay, .citation-modal-header button` | Citation modal renders exact manual excerpt for 5 seconds, then cleanly closes back to the thread. |
| 02:07 -> 02:13 | Next, we prompt the assistant to search Teams and Confluence knowledge, | Cursor scrolls message thread smoothly to the bottom. Type follow-up query: "check if you find any practical info in teams or confluence" into composer. Click Send. | `.messages, .composer textarea, button.composer-send` | Thread scrolled to bottom, follow-up question dispatched in multi-turn conversation thread. |
| 02:13 -> 02:20 | effortlessly combining official documentation with real-world operational experience as Yvoke completes the answer. | Model invokes enterprise search tools. Wait until second turn completes and Send button reappears. Cursor inspects synthesized tips and caveats. | `.message.assistant:last-child, button.primary.composer-send` | Comprehensive response synthesizing official documentation and real-world operational insights. |

### SCENE-6: Live Query 3 — Clarifying Questions & Disambiguation (`02:20 -> 02:55`)

- **Execution Mode**: `real_live_turn`
- **Playbook**: `oim-db-history`
- **Prompt**: *"what database changes were done for the AOB module between 9.3.1 and 10.0?"*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 02:20 -> 02:29 | When an ambiguous query is made, Yvoke surfaces an interactive clarification card to confirm scope. | Start new conversation under oim-db-history. Type "what database changes were done for the AOB module between 9.3.1 and 10.0?" into composer and send. Trace block collapses immediately upon appearance, keeping the interface uncluttered while the Clarification Required card renders with selectable domain options. | `.composer textarea, button.composer-send, .clarifying-question-card` | Interactive Clarification Required card displays domain options to narrow down schema scope. |
| 02:29 -> 02:43 | Selecting an option narrows the query to the chosen domain, streaming the relevant table and column modifications. | Cursor clicks the domain option button (e.g. "Schema changes in release 10.0"). Card resolves to green confirmed badge ("Clarification provided"), and the focused schema change table streams while trace stays collapsed and thread auto-scrolls. | `.clarifying-question-card button.option-button, .clarified-badge, .message.assistant` | Clarification resolved; assistant streams focused schema migration tables with auto-scroll. |
| 02:43 -> 02:55 | Opening the trace reveals the underlying tool calls and database queries executed to retrieve the schema history. | With the response complete, cursor glides to the collapsed TraceBar and clicks to open it, inspecting the executed database history tool calls and reasoning steps. | `button.trace-bar, .trace-body, .trace-step` | TraceBar accordion expands displaying sequential tool execution trace. |

### SCENE-7: Live Query 4 — Multi-Agent System (MAS) (`02:55 -> 03:50`)

- **Execution Mode**: `real_live_turn`
- **Agent Mode**: `orchestrator`
- **Prompt**: *"Compare standard connector vs csv connector vs custom connector via PowerShell considering also teams/confluence."*

| Sub-Beat Range | Spoken Narration Segment | Visual UI Action | UI Target Selector | Visual State |
| :--- | :--- | :--- | :--- | :--- |
| 02:55 -> 03:04 | When queries span multiple knowledge areas and rigorous review is essential, Multi-Agent mode coordinates specialized roles. | Start new conversation. In composer, change agent mode dropdown from "Single-agent" to "Multi-agent (orchestrator)". | `select.composer-select[data-tip*="agent"]` | Composer switches to Multi-Agent Orchestrator mode with active orchestrator indicator. |
| 03:04 -> 03:15 | Specialists investigate each connector architecture in parallel, | Type prompt: "Compare standard connector vs csv connector vs custom connector via PowerShell considering also teams/confluence.". Dispatch turn. Orchestrator spawns parallel specialist subagent cards. | `.composer textarea, button.composer-send` | Turn dispatched. Orchestrator initiates execution plan and spawns parallel subagents. |
| 03:15 -> 03:28 | while an independent Reviewer gate guards against hallucinations | Subagent cards run parallel investigations across manuals and enterprise notes. Reviewer card activates and performs adversarial consistency and hallucination verification pass. | `.subagent-card, .subagent-card-header` | Specialist agent cards show parallel execution; Reviewer card performs adversarial verification pass. |
| 03:28 -> 03:40 | and approves the synthesized response. | Reviewer gate passes verification without hallucinations. Green verified review badge appears on Reviewer card. Cursor inspects a Specialist card and the Reviewer card, then hovers over the final comprehensive connector comparison table. | `.subagent-card .verdict-badge.approved, .message.assistant .markdown-body table` | Reviewer badge stamped "Approved by Reviewer"; rich markdown comparison table displayed. |
| 03:40 -> 03:50 | Thank you for watching this overview of Yvoke Desktop. Experience grounded, verifiable intelligence across your knowledge base. | Cursor glides smoothly to resting position in the center, view settles over the clean workspace, and the video concludes. | `.chat-view, .app-body` | Clean resting state showcasing final verified answer; smooth outro conclusion. |

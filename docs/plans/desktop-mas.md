# Multi-agent orchestrator mode for the desktop app

> **Historical record.** Kept as written; one thing has since changed and is *not* corrected below:
> the MCP server alias is `yvoke`, so tools are `mcp__yvoke__*` rather than `mcp__oim__*`. The
> `oim-*` playbook and profile names below are real data from the One Identity Manager knowledge
> base, used here as examples — they are not built into the client.

> **Status: implemented.** Server endpoint live, desktop orchestrator mode wired, typecheck + 36
> desktop tests + 12 server controller tests green, full build passes. Spikes
> (`scripts/spike-mas.ts`, `scripts/spike-orchestrator-build.ts`) validated SDK delegation and the real
> build path against the live server. Remaining: interactive Electron GUI click-through (select the OIM
> profile, ask a question, watch the specialist/reviewer cards render).

## Goal

Bring the web chat's multi-agent system (MAS) to the Electron desktop app. The user picks a
**profile** (knowledge base, e.g. `OIM`) from a dropdown; an **orchestrator** decomposes the
question, delegates to **specialist** sub-agents, composes one grounded answer, and a **reviewer**
validates it before delivery — mirroring the web behavior, but running **locally on the user's Claude
subscription** via the Claude Agent SDK, not server-side on Gemini.

## Decisions (locked with the user)

1. **Execution = local SDK sub-agents.** The orchestrator is the main `query()` agent; specialists +
   reviewer are SDK **sub-agents** (the `agents` option → `AgentDefinition` map), invoked by the
   orchestrator through the built-in **Task** tool (`subagent_type`). Everything runs on the user's
   Claude subscription. No dependency on the Java `OrchestrationService`.
2. **Config = reuse the server.** The **profile roster** (which specialists belong to a KB) and all
   **playbook content** come from the server. Playbooks already arrive via MCP prompts /
   `/api/chat/v1/playbooks`; we add one small endpoint for the profile roster. The desktop supplies
   only the **Claude model binding** per role (server profiles reference Gemini models, which the
   Claude SDK can't use).

## How the SDK maps to the web MAS

| Web MAS (Java, Gemini) | Desktop (Agent SDK, Claude) |
|---|---|
| Orchestrator agent (pro) | Main `query()` agent; `agent`/`systemPrompt` = orchestrator playbook |
| `call_specialist(name, q)` tool | Built-in **Task** tool with `subagent_type=<specialist>` |
| Specialist playbook subagents (flash) | `agents[<name>]` = `AgentDefinition{ prompt, tools, model }` |
| Reviewer agent + `submit_review` (pro) | `agents.reviewer` sub-agent; verdict returned as its final text |
| Deterministic ≤2-round review loop | **Prompt-enforced** in the orchestrator playbook (model-driven) |
| `agent_runs`/`agent_steps` persistence | Local trace rendered in-chat + local store (no server run) |
| Profiles in `application.yml` | Fetched from server; models bound locally from `settings.json` |

**Key consequence of choosing SDK-native (option 1):** the review loop and specialist-call budget are
**prompt-enforced**, not code-enforced. `maxTurns` (orchestrator + per sub-agent) is the hard backstop.
If exact code-enforced parity with the Java loop is ever required, that's the "deterministic TS loop"
variant (multiple explicit `query()` calls) — deliberately not chosen here.

## Playbook adaptation (the one real friction point)

The existing `oim-orchestrator.md` / `oim-orchestrator-reviewer.md` are written around the web tools
(`call_specialist`, `submit_review`). On desktop the delegation tool is **Task** and the reviewer
returns text. Rather than fork the playbooks (which would break "reuse server config"), the desktop
**appends a short client-adapter preamble** to the orchestrator/reviewer system prompt at session
build time:

- Orchestrator adapter: "To consult a specialist, call the **Task** tool with
  `subagent_type=<specialist name>` and a self-contained question. The available specialists are: …
  (roster injected). You have no `call_specialist` tool; Task is the equivalent."
- Reviewer adapter: "There is no `submit_review` tool here — end your turn with your verdict as text:
  first line `APPROVED` or `REJECTED`, then the feedback / unsupported-claims."

This keeps a single source of truth for playbook *content* while translating the *tool vocabulary*.
The roster (`name | title | description`) is injected the same way the web orchestrator prompt does.

## Server changes (yvoke-web) — minimal

1. **`GET /api/chat/v1/orchestrator/profiles`** in
   [`DesktopSyncController`](../../yvoke-web/src/main/java/de/palsoftware/yvoke/chat/api/DesktopSyncController.java).
   Returns each profile's **structure** only:
   ```json
   [{ "name": "OIM",
      "orchestratorPlaybook": "oim-orchestrator",
      "reviewerPlaybook": "oim-orchestrator-reviewer",
      "specialistPlaybooks": ["oim-access-governance", "oim-developer-api", ...] }]
   ```
   Backed by `OrchestratorProperties` (already a bean; iterate `profiles()`). No model/thinking in the
   payload — the desktop binds Claude models locally. ~15 lines + a DTO.
2. **(Optional cleanup)** mark orchestrator/reviewer/specialist playbooks so they can be filtered out
   of the desktop's single-playbook picker (see step 6). Either a `meta.role` flag on the playbook, or
   the desktop derives the exclusion set from the profiles response. Prefer the latter (no server
   change).

## Desktop changes (yvoke-desktop)

### Step 1 — Shared contracts (`src/shared/types.ts`)

- `OrchestratorProfile { name; orchestratorPlaybook; reviewerPlaybook; specialistPlaybooks: string[] }`.
- `ThreadMeta.orchestratorProfile?: string` — selected profile name; `undefined`/`''` = Off.
- Extend `AppSettings` with an `orchestrator` block — the **role → Claude model + thinking** binding
  and budgets:
  ```ts
  orchestrator: {
    orchestrator: { model: 'opus',   thinkingLevel: 'high' },
    reviewer:     { model: 'opus',   thinkingLevel: 'high' },
    specialist:   { model: 'haiku',  thinkingLevel: 'medium' },
    maxReviewRounds: 2,        // passed into the orchestrator prompt
    maxSpecialistCalls: 8,     // passed into the orchestrator prompt
    orchestratorMaxTurns: 60,  // hard backstop for the main agent
    specialistMaxTurns: 20,
  }
  ```
  Seed defaults in `settings.json`.
- New `AgentEvent` variants for MAS trace rendering:
  `{ kind: 'subagent-start'; threadId; taskId; subagentType; question }`,
  `{ kind: 'subagent-complete'; threadId; taskId; subagentType; text; usage }`,
  `{ kind: 'review-verdict'; threadId; approved; feedback }`.

### Step 2 — Fetch profiles (`SyncClient` + `AppCore`)

- `SyncClient.getOrchestratorProfiles(): Promise<OrchestratorProfile[]>` → `GET
  /api/chat/v1/orchestrator/profiles` (cache with a short TTL like `McpPrompts.list`).
- `AppCore.listOrchestratorProfiles()` wrapper (empty list if unreachable → dropdown hidden).
- IPC: `ipcMain.handle('orchestrator:profiles', …)` + preload bridge method.

### Step 3 — MAS session build (`AgentService.ensureSession`) — the core

When `thread.orchestratorProfile` is set, build the query in **orchestrator mode** instead of the
normal single-playbook mode:

1. Resolve the profile (from `AppCore`/cache). Fetch playbook **texts** via `mcpPrompts.getText(name)`
   and **tool constraints** via `mcpPrompts.list()` for the orchestrator, reviewer, and every
   specialist (parallelize; reuse the existing 60 s prompt cache).
2. Build the `agents` map:
   ```ts
   const agents: Record<string, AgentDefinition> = {};
   for (const spec of specialists) {
     agents[spec.name] = {
       description: spec.description,                       // roster text → Task tool selection
       prompt: spec.text,                                   // specialist playbook = its system prompt
       tools: mapPlaybookTools(spec.tools, spec.codeExecution), // mcp__oim__* + ToolSearch/Bash
       model: settings.orchestrator.specialist.model,
       maxTurns: settings.orchestrator.specialistMaxTurns,
     };
   }
   agents.reviewer = {
     description: 'Validates the composed answer against gathered evidence. Never searches anew.',
     prompt: reviewerText + REVIEWER_ADAPTER,
     tools: ['mcp__oim__verify_citations', 'mcp__oim__get_section'],
     model: settings.orchestrator.reviewer.model,
   };
   ```
3. Build orchestrator options:
   ```ts
   const options: Options = {
     agent: 'orchestrator',                                 // main-thread agent
     agents: { orchestrator: { description, prompt: orchestratorText + ORCH_ADAPTER(roster, budgets),
                               tools: ['Task', 'mcp__oim__ask_clarifying_question'],
                               model: settings.orchestrator.orchestrator.model,
                               maxTurns: settings.orchestrator.orchestratorMaxTurns },
               ...agents },
     allowedTools: [...allSpecialistAndReviewerTools, 'Task', 'mcp__oim__ask_clarifying_question'],
     canUseTool: buildCanUseTool(...),                      // reuse; ask_clarifying_question intercept still works
     forwardSubagentText: true,                             // so the renderer can show nested transcripts
     mcpServers, includePartialMessages: true, settingSources: [], cwd, env,
   };
   ```
   - `mapPlaybookTools` = the existing `buildAllowedTools` logic (prefixing, ToolSearch, Bash gate).
   - `allowedTools` must union every sub-agent's tools **plus** `Task` (so delegation is permitted) —
     `canUseTool`'s default-deny still governs the leaf MCP calls.
   - **Delegation token (confirmed by `scripts/spike-mas.ts`):** put **`'Task'`** in `allowedTools`
     to permit delegation, but the model emits the delegation as a `tool_use` block whose **`name` is
     `'Agent'`** (with `input.subagent_type`/`prompt`/`description`). translate.ts must detect
     `name === 'Agent'`, not `'Task'`.
- Keep the single-playbook path exactly as today when no profile is selected. Restart the session when
  the selected profile changes (same pattern as the existing playbook-change restart at
  `AgentService.sendMessage`).
- In orchestrator mode the user message is **not** prepended with a playbook (the orchestrator's system
  prompt drives it) — `sendMessage` skips `injectBefore`.

### Step 4 — Trace translation (`translate.ts`)

The SDK forwards sub-agent messages tagged with `parent_tool_use_id` (the Task tool_use that spawned
them). Extend `translateMessage`:
- A `Task` tool_use on the main thread → emit `subagent-start` (read `subagent_type` + the question).
- Assistant/user messages carrying `parent_tool_use_id` → attribute to that sub-agent; group into a
  nested block keyed by the Task id (reuse the block/`toolCalls` structure already in `TurnContext`).
- The Task tool_result → `subagent-complete` (the specialist's returned text + usage).
- Detect the reviewer sub-agent's `APPROVED`/`REJECTED` first line → `review-verdict`.
- Everything still funnels into `session.turn.blocks`, so `completeTurn` persistence/sync is unchanged;
  the final answer is the orchestrator's last text block.

### Step 5 — Renderer (`ChatView.tsx` + new `SubagentCard.tsx`)

- **Profile dropdown** in the footer controls, populated from `orchestrator:profiles` with an `Off`
  option (rendered only when ≥1 profile exists; hidden in read-only view). On change →
  `threads:patch { orchestratorProfile }` (persist locally + push to conversation settings via sync,
  same as model/thinking).
- When a profile is selected: **hide** the playbook `+` picker, `/`-autocomplete, and the model /
  thinking selectors (the profile owns models) — mirroring the web behavior.
- **MAS trace UI:** render `subagent-start`/`subagent-complete` as collapsible `SubagentCard`s
  ("🔬 access-governance → …") nested under the orchestrator turn, and the reviewer verdict as a
  distinct card (✅ approved / ⚠️ rejected + feedback). Reuse `ToolCallCard` styling. A `delivered
  flagged` outcome (reviewer still rejecting after `maxReviewRounds`) shows the same ⚠️ note the web
  appends.

### Step 6 — Playbook-picker hygiene

Filter the single-playbook picker (`prompts:list`) to exclude any playbook that appears as an
orchestrator/reviewer/specialist in a profile — otherwise the internal control playbooks show up as
user-selectable. Derive the exclusion set on the desktop from the profiles response (no server change).

### Step 7 — `settings.json`

Add the `orchestrator` block (role→Claude model + thinking + budgets/maxTurns) from step 1. Raise or
per-mode-override the global `maxTurns` (MAS needs more than 25 across the orchestrator + reviewer +
several specialists).

## Verification

1. **Spike first** (`scripts/spike.ts` variant): a 2-specialist `agents` map + orchestrator `agent`,
   one cross-topic OIM question. Confirm: (a) the exact `allowedTools` token for delegation (`Task`),
   (b) sub-agents connect to the `oim` MCP server and are confined to their `tools`, (c)
   `forwardSubagentText` yields renderable nested messages, (d) per-sub-agent usage is reported.
2. **Unit** (`tests/`): `mapPlaybookTools` prefixing/gating; `translate.ts` grouping of
   `parent_tool_use_id` messages into sub-agent blocks; verdict parsing.
3. **Manual e2e**: OIM profile selected → ask the standard cross-topic question ("difference between a
   business role and a system role, and how to read a person's assigned roles via REST") → confirm
   specialists + reviewer cards render, the final answer is grounded/cited, and it syncs to the server
   as one assistant message. Compare quality against the web run for the same question.
4. **Regression**: with `Off`, the single-playbook path is byte-for-byte unchanged.

## Open questions / risks

- **Review-loop fidelity.** Prompt-enforced, not code-enforced (consequence of SDK-native choice). If
  the model under-reviews or over-delegates (the same economy issue seen on the web), the fix is
  playbook tuning + `maxTurns`, not code. Revisit the deterministic-loop variant only if this proves
  insufficient.
- **Cost.** Many sub-agents per question on the user's Claude subscription. `specialist.model = haiku`
  keeps the fan-out cheap; orchestrator/reviewer on opus/sonnet. Surface per-turn cost (already shown).
- **Trace persistence (implemented).** Desktop runs now persist to `agent_runs`/`agent_steps` via
  `POST /api/chat/v1/orchestrator/runs`, so they appear in the same admin viewer as web runs. The final
  answer + prompt still land in `conversations`/`messages` (clean composed answer for orchestrator
  turns); the run links to the assistant message via `message_id`. Assembled client-side in
  `agent/runTrace.ts` from the Agent delegations (each carries `subagentType`/`subagentBlocks`/
  `verdict`), POSTed once the message sync returns the server id. Best-effort: a failed POST loses the
  trace, not the conversation. Per-step token breakdown is not available from the SDK (only the
  aggregate), so per-step tokens are null; run-level tokens come from the aggregate usage.
- **Model binding drift.** Server profiles' Gemini models are ignored on desktop; the role→Claude map
  lives only in `settings.json`. Document this so the two chat surfaces' model choices don't surprise.

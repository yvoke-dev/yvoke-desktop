---
name: asdd
description: >-
  Run the Antigravity Spec-Driven Development (ASDD) workflow for large tasks, new features, architectural enhancements, or major refactors in yvoke-desktop. Enforces 6 phases with 3 adversarial gates, isolated git worktrees, strict TDD mutation proofs, and spec updates.
---

# Antigravity Spec-Driven Development (ASDD)

Follow this workflow for large tasks, features, architectural changes, and refactors in `yvoke-desktop`. For small/medium tasks, execute directly.

For complete normative protocol details, refer to [`.antigravity/sdd_protocol.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/sdd_protocol.md).

---

## Phase 0: Subagent Bootstrap

Before launching Phase 1, ensure all required SDD subagents are defined for the conversation using `define_subagent`. Inspect the definitions in `.antigravity/agents/`:

1. **`sdd_planner`** ([`sdd_planner.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/sdd_planner.md)):
   - `enable_write_tools: false`, `enable_mcp_tools: false`, `enable_subagent_tools: false`
2. **`sdd_plan_critic`** ([`sdd_plan_critic.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/sdd_plan_critic.md)):
   - `enable_write_tools: false`, `enable_mcp_tools: false`, `enable_subagent_tools: false`
3. **`sdd_task_architect`** ([`sdd_task_architect.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/sdd_task_architect.md)):
   - `enable_write_tools: true`, `enable_mcp_tools: false`, `enable_subagent_tools: false`
4. **`sdd_task_critic`** ([`sdd_task_critic.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/sdd_task_critic.md)):
   - `enable_write_tools: false`, `enable_mcp_tools: false`, `enable_subagent_tools: false`
5. **`desktop_implementer`** ([`desktop_implementer.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/desktop_implementer.md)):
   - `enable_write_tools: true`, `enable_mcp_tools: false`, `enable_subagent_tools: false`
6. **`desktop_reviewer`** ([`desktop_reviewer.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/desktop_reviewer.md)):
   - `enable_write_tools: true` (strictly read-only for codebase files; runs tests/git diff), `enable_mcp_tools: false`, `enable_subagent_tools: false`
7. **`sdd_auditor`** ([`sdd_auditor.md`](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.antigravity/agents/sdd_auditor.md)):
   - `enable_write_tools: true`, `enable_mcp_tools: false`, `enable_subagent_tools: false`

---

## Phase 1: Discovery & Architectural Sparring

1. **Spec Investigation**: Invoke `sdd_planner` to inspect the relevant capability chapters in `spec/` (e.g. `spec/01_asking_questions.md`) to understand current behavior, limits, and intentional absences ("Not supported").
2. **Implications & Trade-offs**: Planner identifies side effects across Electron processes (Main, Preload, Renderer, Shared), Claude Agent SDK policies, and offline sync.
3. **User Clarifications**: Planner sends formulated trade-off questions via `send_message`. The parent agent presents them interactively to the user via `ask_question` and relays answers back.

---

## Phase 2: Planning Mode & Adversarial Plan Critique (Gate 1)

1. **Adversarial Plan Attack**: Invoke `sdd_plan_critic` to attack the draft plan against:
   - Desktop Known Pitfalls in `.agents/AGENTS.md` § 6.
   - Electron multi-process security (`contextBridge`, IPC argument validation).
   - React 19 lifecycle: listener unsubscription in `useEffect`, memory leaks.
   - Anti-bloat & unrepresentability.
2. **Harden Plan**: Planner refines the plan based on critic feedback.
3. **Implementation Plan Artifact**: Parent agent writes `implementation_plan.md` in the native brain folder with `RequestFeedback: true` and pauses for explicit user approval.

---

## Phase 3: Worktree Setup & Adversarial Test Critique (Gate 2)

1. **Worktree Creation**: Invoke `sdd_task_architect` to create an isolated worktree inside `.worktrees/`:
   ```bash
   git worktree add -b sdd/<feature-name> .worktrees/sdd-<feature-name> HEAD
   ```
   - *Dependencies*: Brand new git worktrees do not contain `node_modules/` (gitignored). Worktrees rely on Node's upward module resolution to load packages from the repository root. If a wave adds packages to `package.json`, run `npm install` at the **root repository level** (never inside `.worktrees/`).
2. **Draft Wave Breakdown**: Group tasks into dependency-ordered waves (Main Store -> Preload -> React UI -> Spec Update -> Audit).
3. **Adversarial Test Critique (Gate 2)**: Invoke `sdd_task_critic` to attack the task list:
   - **Eliminates Happy-Path Test Syndrome**: Mandate that **every wave must include at least one explicit Negative / Failure Test** (e.g. malformed IPC arguments, corrupt JSON recovery, sync timeouts).
4. **Task Artifact**: Emit `task.md` in the native brain folder:
   - Mandatory Wave $N-1$: Update `spec/` chapter and verify via `npm test -- tests/spec.test.ts`.
   - Mandatory Wave $N$: Holistic audit and PR creation.

---

## Phase 4: Wave Execution Loop (Gate 3)

For each wave, execute strictly inside the worktree directory:

> [!IMPORTANT]
> **Worktree Path Propagation**: Subagents inherit the workspace root by default. The parent agent MUST explicitly instruct `desktop_implementer` and `desktop_reviewer` to pass `Cwd: /path/to/.worktrees/sdd-<feature-name>` for all shell commands and use absolute paths inside the worktree for all file edits.

1. **Implementer (Strict Red-Green TDD)**:
   Invoke `desktop_implementer`:
   - *Red Phase*: Write test first in `tests/`, execute targeted command (`npm test -- tests/MyTest.test.ts`), verify RED.
   - *Green Phase*: Write minimal production code, verify GREEN.
   - *Refactor Phase*: Clean up, run `npm run typecheck`.
   - *Test Mutation Proof*: Break the production code minimally to confirm RED, then restore by re-reading the original.
2. **Adversarial Code Review (Gate 3)**:
   Invoke `desktop_reviewer` to audit `git diff` inside the worktree for IPC validation, memory leaks, CSP, and type safety.
3. **Wave Commit**:
   Commit the wave on the feature branch:
   ```bash
   git add -A && git commit -m "feat(<domain>): [Wave N] <description>"
   ```

---

## Phase 5: Holistic Audit & Verification

Invoke `sdd_auditor` inside the worktree:
1. **Spec Verification**: Verify `spec/` was updated and run `npm test -- tests/spec.test.ts`.
2. **Steering Check**: Run `python3 .antigravity/scripts/check_steering.py`.
3. **Typecheck & Parity**: Run `npm run typecheck` and `npm test -- tests/AgentRuleFilesParity.test.ts`.
4. **Full Test Suite**: Run `npm test`.

---

## Phase 6: Branch Push, PR Creation & Handoff

1. **Push Branch**: `git push -u origin sdd/<feature-name>`
2. **Open PR**: `gh pr create --base main --head sdd/<feature-name> --title "feat(<domain>): ..." --body "..."`
3. **Handoff**: Write `walkthrough.md` in native brain folder with PR link, wave commit summary, and test logs.

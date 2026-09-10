---
name: asdd
description: >-
  Run the Antigravity Spec-Driven Development (ASDD) workflow for large tasks, new features, architectural enhancements, or major refactors in yvoke-desktop. Enforces 6 phases with active branch pre-flight confirmation, 3 adversarial gates, strict TDD mutation proofs, and spec updates.
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

## Phase 3: Branch Pre-flight Verification & Adversarial Test Critique (Gate 2)

1. **Active Branch Pre-flight Confirmation**:
   Before breaking down waves or touching code, inspect git status:
   ```bash
   git branch --show-current
   git status --porcelain
   ```
   The agent **MUST ALWAYS** ask the user to confirm whether the current branch is the intended branch for this task, even if not on `main` (to guard against stale feature branches or branch pollution):
   - **If on `main`**: Committing directly to `main` is strictly prohibited. Halt and prompt the user:
     1. Create and checkout a new branch (`git checkout -b sdd/<feature-name>`) in the current workspace.
     2. Pause so the user can switch or set up a branch manually.
   - **If on another branch**: Prompt the user with the branch name and status:
     1. Proceed on the current branch.
     2. Create and checkout a new branch (`sdd/<feature-name>`).
     3. Pause so the user can switch branches manually.
   - **If working tree is dirty**: Warn and prompt the user to commit, stash, or review changes before starting waves.
2. **Draft Wave Breakdown**: The task architect reads `implementation_plan.md` first (Plan-Binding & Anti-Drift Invariant) and organizes the work into waves sized proportionally to scope:
   - **Focused tasks (2 Waves)**: Wave 1 (Implementation & Strict TDD) -> Wave 2 (Spec Update, Audit & PR).
   - **Large multi-system tasks (3+ Waves)**: Staged layered waves (e.g. State/Store -> IPC/Preload Bridge -> React UI -> Spec Update -> Audit) only when deep dependencies require staged review.
3. **Adversarial Test Critique (Gate 2)**: Invoke `sdd_task_critic` to attack the task list:
   - **Eliminates Happy-Path Test Syndrome**: Mandate that **every wave must include at least one explicit Negative / Failure Test** (e.g. malformed IPC arguments, corrupt JSON recovery, sync timeouts).
4. **Task Artifact**: Emit `task.md` in the native brain folder:
   - Mandatory Wave $N-1$: Update `spec/` chapter and verify via `npm test -- tests/spec.test.ts`.
   - Mandatory Wave $N$: Holistic audit and PR creation.

---

## Phase 4: Wave Execution Loop (Gate 3)

For each wave, execute directly in the active workspace on the confirmed feature branch:

1. **Implementer (Strict Red-Green TDD)**:
   Invoke `desktop_implementer`:
   - *Red Phase*: Write test first in `tests/`, execute targeted command (`npm test -- tests/MyTest.test.ts`), verify RED.
   - *Green Phase*: Write minimal production code, verify GREEN.
   - *Refactor Phase*: Clean up, run `npm run typecheck`.
   - *Test Mutation Proof*: Break the production code minimally to confirm RED, then restore by re-reading the original.
2. **Adversarial Code Review (Gate 3)**:
   Invoke `desktop_reviewer` to audit `git diff` for IPC validation, memory leaks, CSP, and type safety.
3. **Wave Commit**:
   Commit the wave on the feature branch:
   ```bash
   git add -A && git commit -m "feat(<domain>): [Wave N] <description>"
   ```

---

## Phase 5: Holistic Audit & Verification

Invoke `sdd_auditor` in the workspace:
1. **Spec Verification**: Verify `spec/` was updated and run `npm test -- tests/spec.test.ts`.
2. **Steering Check**: Run `python3 .antigravity/scripts/check_steering.py`.
3. **Typecheck & Parity**: Run `npm run typecheck` and `npm test -- tests/AgentRuleFilesParity.test.ts`.
4. **Full Test Suite**: Run `npm test`.

---

## Phase 6: Branch Push, PR Creation & Handoff

1. **Push Branch**: `git push -u origin sdd/<feature-name>`
2. **Open PR**: `gh pr create --base main --head sdd/<feature-name> --title "feat(<domain>): ..." --body "..."`
3. **Handoff**: Write `walkthrough.md` in native brain folder with PR link, wave commit summary, and test logs.

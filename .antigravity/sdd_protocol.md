# Strict SDD Protocol: Spec-Driven Development (Electron + React + TypeScript)

This guide defines the strict Antigravity Spec-Driven Development (SDD) workflow for features, architectural enhancements, and refactors in `yvoke-desktop`. All plans and task tracking occur natively within the parent agent's `brain` directory; do NOT create *per-task* plan, design, or checklist files in the local workspace.

The durable **functional specification** in `spec/` (indexed by `spec/README.md`) describes what the desktop app does, its limits, and what it deliberately does not do. Read the chapter in `spec/` for the area you are changing at the start of Phase 1 — that is the intent — then the tests owning the feature, which are the contract. Always update the relevant chapter in `spec/` whenever a change alters user-observable behaviour, limits, or defaults.

```
                    STRICT SDD PIPELINE OVERVIEW (DESKTOP)
                    
  Phase 1: Discovery & Sparring  sdd_planner reads spec/ chapter, investigates implications,
                                 formulates trade-off questions via ask_question.
          │
  Phase 2: Plan & Red Team       sdd_plan_critic attacks draft plan (Known Pitfalls, IPC
          (Gate 1)               boundaries, CSP, React 19 leaks, unrepresentability).
                                 Parent produces hardened implementation_plan.md artifact.
          │
  Phase 3: Worktree & Tasks      sdd_task_architect creates git worktree in .worktrees/.
          (Gate 2)               sdd_task_critic eliminates Happy-Path Test Syndrome,
                                 mandating negative/failure test cases per wave.
                                 Emits task.md with explicit negative test criteria.
          │
  Phase 4: Wave Execution Loop   For each wave (inside the worktree):
          (Gate 3)               1. desktop_implementer: Red -> Green -> Refactor (Vitest).
                                    Test Mutation Proof (break production code, watch RED, restore).
                                 2. desktop_reviewer: Audits diff (IPC safety, memory leaks, CSP).
                                 3. Wave Commit: git commit -m "feat(<domain>): [Wave N] ..."
                                 (Mandatory Wave N-1: Update spec/ chapter file)
          │
  Phase 5: Holistic Audit        sdd_auditor verifies spec/ chapter, tests/spec.test.ts,
                                 check_steering.py, npm run typecheck, AgentRuleFilesParity.test.ts,
                                 and full test suite.
          │
  Phase 6: PR & Handoff          sdd_auditor pushes branch, opens GitHub PR (gh pr create),
                                 compiles walkthrough.md for user review & squash-merge.
```

---

## Phase 0: Subagent Bootstrap
Before starting, ensure the required SDD subagents are defined for the session. In Antigravity, subagents from `.antigravity/agents/*.md` must be registered via `define_subagent` if not already loaded:
- `sdd_planner`: Read-only requirements discovery and sparring partner (`.antigravity/agents/sdd_planner.md`).
- `sdd_plan_critic`: Read-only adversarial architect attacking draft plans against Known Pitfalls (`.antigravity/agents/sdd_plan_critic.md`).
- `sdd_task_architect`: Generates isolated worktree and task waves (`.antigravity/agents/sdd_task_architect.md`).
- `sdd_task_critic`: Read-only QA critic eliminating Happy-Path Test Syndrome (`.antigravity/agents/sdd_task_critic.md`).
- `desktop_implementer`: Writes code and tests strictly via Red-Green TDD (`.antigravity/agents/desktop_implementer.md`).
- `desktop_reviewer`: Read-only diff auditor inspecting IPC security, listener leaks, and CSP (`.antigravity/agents/desktop_reviewer.md`).
- `sdd_auditor`: Release gatekeeper verifying specs, steering, parity, and tests (`.antigravity/agents/sdd_auditor.md`).

---

## Phase 1: Discovery & Architectural Sparring
1. **Spec Investigation**: Invoke `sdd_planner` to inspect the relevant capability chapters in `spec/` (e.g. `spec/01_asking_questions.md`, `spec/02_how_an_answer_is_produced.md`, etc.) and understand current behaviour, limits, and intentional absences ("Not supported").
2. **Implications & Trade-offs Check**: The planner analyzes side effects across Electron multi-process boundaries (main, preload, renderer, shared), Claude Agent SDK policies, and offline sync state. It identifies what might break or become ambiguous, formulating sharp questions.
3. **User Clarifications**: The planner sends formulated questions to the parent agent, which presents them via the interactive `ask_question` tool. Relay user answers back to the planner.

---

## Phase 2: Planning Mode & Adversarial Plan Critique (Gate 1)
1. **Adversarial Plan Attack (Gate 1)**: Before presenting the plan to the user, invoke `sdd_plan_critic` to attack the draft plan:
   - Cross-checks against all Known Pitfalls in `CLAUDE.md` / `.agents/AGENTS.md` § 6.
   - Evaluates multi-process security: contextBridge API boundaries, parameter validation on IPC channels.
   - Evaluates React 19 lifecycle: event listener cleanup, memory leaks.
   - Challenges over-engineering and tests whether the bug can be made *unrepresentable* instead of adding defensive code.
2. **Harden Implementation Plan**: The planner refines the plan based on the critic's report.
3. **Design Plan Artifact**: The parent agent produces `implementation_plan.md` natively in the brain directory, documenting:
   - User Review Required & Breaking Changes
   - Resolved Design Questions & Trade-offs
   - Red Team Critique & Mitigations
   - Multi-Process Boundaries & Invariants
   - Required Spec Delta (`spec/0*.md`)
   - Verification Plan
4. **User Approval**: Present the plan to the user (`RequestFeedback: true`) and wait for explicit approval before proceeding.

---

## Phase 3: Task Architecture & Adversarial Test Critique (Gate 2)
1. **Worktree Creation**: Invoke `sdd_task_architect` to create an isolated git worktree inside `.worktrees/`:
   ```bash
   git worktree add -b sdd/<feature-name> .worktrees/sdd-<feature-name> HEAD
   ```
   *Rule*: All implementation and review work must execute strictly within this worktree. The main working tree on `main` remains untouched and undisturbed.
   - **Worktree Dependencies & `node_modules`**: Brand new git worktrees do not contain `node_modules/` (gitignored). Worktrees rely on Node's upward module resolution to load packages from the repository root. If a wave adds or updates packages in `package.json`, `npm install` must be executed at the **root repository level** (not inside `.worktrees/`) to preserve a single canonical `package-lock.json` and prevent duplicating hundreds of megabytes in the worktree.
   - **Build Caches**: Vite and TypeScript build caches (e.g. `node_modules/.vite` or `*.tsbuildinfo`) generated in the worktree are local and gitignored.
2. **Draft Wave Breakdown**: The task architect organizes the work into sequential waves (State/Store -> IPC/Preload Bridge -> React UI & styles.css -> Spec Update -> Audit).
3. **Adversarial Task & Test Critique (Gate 2)**: Invoke `sdd_task_critic` to attack the task list:
   - **Eliminates Happy-Path Test Syndrome**: Mandates that **every wave must include at least one explicit Negative / Failure Test** (e.g. malformed IPC args, corrupt JSON store recovery, network sync timeouts, bad tool input rejection).
   - Verifies tests assert real state mutations rather than trivial assertions.
4. **Task Artifact Generation (`task.md`)**: The task architect incorporates all negative tests and emits the hardened `task.md` in the brain directory:
   - **Mandatory Wave N-1**: Update `spec/` capability chapter and verify via `tests/spec.test.ts`.
   - **Mandatory Wave N**: SDD Auditor verification and PR creation.

---

## Phase 4: Wave Execution Loop & Resilience Review (Gate 3)
Execute each wave sequentially inside the worktree directory:

> [!IMPORTANT]
> **Worktree Path Propagation**: Subagents inherit the workspace root by default. The parent agent MUST explicitly instruct `desktop_implementer` and `desktop_reviewer` to pass `Cwd: <absolute-path-to-worktree>` for all shell commands and use absolute paths inside the worktree for all file edits. If Node is managed via `fnm`/`nvm` in user directories, commands like `npm test` and `npm run typecheck` may require `BypassSandbox: true` so the user can permit execution outside the standard sandbox.

1. **Implementer (Strict Red-Green TDD)**:
   Invoke `desktop_implementer` inside `.worktrees/sdd-<feature-name>`:
   - **Red Phase**: Write the test first (both happy-path and mandatory negative tests) in `tests/`. Run the targeted test command (e.g. `npm test -- tests/MyFeature.test.ts`) and verify it fails (RED).
   - **Green Phase**: Write minimal production code to satisfy the test. Verify it passes (GREEN).
   - **Refactor & Typing**: Clean up code and run `npm run typecheck`.
   - **Test Mutation Proof**: A test does not count until you have seen it fail. Break the production code minimally to confirm RED, then restore by re-reading the original.
2. **Adversarial Code & Resilience Review (Gate 3)**:
   Invoke `desktop_reviewer` inside `.worktrees/sdd-<feature-name>` to audit `git diff`:
   - Inspects for IPC parameter validation, contextBridge leaks, CSP compliance, React `useEffect` listener cleanups, type safety, and Known Pitfalls.
   - Probes for tainted input vulnerabilities (renderer IPC payloads, LLM outputs, sync responses).
   - Verifies test quality and confirms the test actually ran Red -> Green.
3. **Remediation**:
   If the reviewer finds material issues, invoke `desktop_implementer` to remediate, followed by a re-review.
4. **Wave Commit**:
   Once the wave passes review and tests, commit the wave on the feature branch:
   ```bash
   git add -A && git commit -m "feat(<domain>): [Wave N] <wave description>"
   ```

---

## Phase 5: Holistic Audit & Verification
Invoke `sdd_auditor` inside `.worktrees/sdd-<feature-name>` to run the release gatekeeper checks:
1. **Spec Verification**: Verify the relevant chapter in `spec/` was updated, and run:
   ```bash
   npm test -- tests/spec.test.ts
   ```
2. **Steering Check**: Run `python3 .antigravity/scripts/check_steering.py`. If structural changes occurred, update `.antigravity/steering/`.
3. **Typecheck & Parity Check**: Run `npm run typecheck` and `npm test -- tests/AgentRuleFilesParity.test.ts`.
4. **Full Test Suite**: Run `npm test`.

---

## Phase 6: Branch Push, PR Creation & User Handoff
1. **Push Branch**: Inside the worktree, push the feature branch to origin:
   ```bash
   git push -u origin sdd/<feature-name>
   ```
2. **Open Pull Request**: Create a PR against `main` using GitHub CLI:
   ```bash
   gh pr create --base main --head sdd/<feature-name> --title "feat(<domain>): <feature-title>" --body "<plan, changes, and test summary>"
   ```
   *(Note: If `gh` is unauthenticated or not installed, provide the direct GitHub URL or instructions to open the PR manually).*
3. **Walkthrough & Handoff**:
   - Compile `walkthrough.md` in the brain directory with the PR link, summary of wave commits, and verification logs.
   - Instruct the user to review the PR on GitHub and squash-merge when ready.
   - Once merged, the worktree can be cleanly removed:
     ```bash
     git worktree remove --force .worktrees/sdd-<feature-name>
     git branch -D sdd/<feature-name>
     ```

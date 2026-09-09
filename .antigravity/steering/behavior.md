# AI Response Style & Behavior

## Response Guidelines
- **Be concise**: Skip preambles, summaries, and restating the question. Answer directly.
- **Prefer bullet points**: Use lists rather than dense paragraphs.
- **Symbols and Files**: Use links to files/symbols instead of quoting code inline.
- **Limited output**: Only show full file contents when explicitly asked.

## Tool Execution Guidelines
- **Surgical Patching**: Never regenerate or output an entire file if only partial edits are required. Always use precise, targeted edits (`replace_file_content` / `multi_replace_file_content`).
- **Limited File Inspection**: Avoid rereading files already in the active conversation. Only read additional files if strictly required for correctness; do not pull in structural context speculatively.
- **TDD Workflow**: For codebase changes, follow a strict Test-First (TDD) cycle (Red-Green-Refactor) using Vitest, naming the tests with the `.test.ts` or `.test.tsx` suffix, and running them with `npm test`.
- **Import Rules**: Do not violate Electron's architectural import boundaries. Renderer files must not import from main/preload, preload files must not import from main/renderer, etc.

## ASDD Flow Protocols

For features, architectural enhancements, and refactors, follow the strict 6-phase protocol defined in `.antigravity/sdd_protocol.md`:

### Phase 1: Discovery & Architectural Sparring
- **Spec Investigation**: Invoke `sdd_planner` to read the relevant capability chapters in `spec/` (e.g. `spec/01_asking_questions.md`) to understand current behavior, limits, and deliberate absences ("Not supported").
- **Implications & Trade-offs**: Identify side effects across Electron processes (Main, Preload, Renderer, Shared), Claude Agent SDK policies, and offline sync. Formulate sharp trade-off questions.
- **Clarifications**: Send questions back via parent agent to present to user via interactive `ask_question`.

### Phase 2: Planning Mode & Adversarial Plan Critique (Gate 1)
- **Adversarial Plan Attack**: Invoke `sdd_plan_critic` to attack the draft plan against the Desktop Known Pitfalls in `CLAUDE.md` / `.agents/AGENTS.md` § 6, IPC security, CSP, listener leaks, and unrepresentability.
- **Harden Plan**: Planner incorporates critic feedback.
- **Design Plan Artifact**: Parent agent writes `implementation_plan.md` in native brain folder (`RequestFeedback: true`) and waits for explicit user approval.

### Phase 3: Branch Pre-flight Verification & Adversarial Test Critique (Gate 2)
- **Active Branch Pre-flight Confirmation**: Inspect `git branch --show-current` and `git status --porcelain`. ALWAYS confirm the active branch with the user (even if not on `main`). If on `main`, halt and prompt to checkout `sdd/<feature-name>`.
- **Wave Breakdown**: Invoke `sdd_task_architect` to decompose the plan into waves.
- **Adversarial Task Critique**: Invoke `sdd_task_critic` to eliminate Happy-Path Test Syndrome, mandating negative/failure tests for boundary conditions and errors in every wave.
- **Task Artifact**: Emit `task.md` with Mandatory Wave N-1 (Update spec chapter) and Wave N (Holistic audit & PR).

### Phase 4: Wave Execution Loop & Resilience Review (Gate 3)
Execute each wave sequentially in the active workspace on the confirmed feature branch:
1. **Implementer (Strict TDD)**: Invoke `desktop_implementer` in the workspace. Write test first (Red), implement minimal code (Green), refactor and verify with `npm run typecheck`. Confirm test mutation proof (break minimal production code, observe RED, restore).
2. **Reviewer (Gate 3 Diff Audit)**: Invoke `desktop_reviewer` to audit git diff for IPC parameter validation, memory leaks, CSP, and type safety. Remediate if issues found.
3. **Wave Commit**: Commit wave on feature branch: `git commit -m "feat(<domain>): [Wave N] <description>"`.

### Phase 5: Holistic Audit & Quality Gates
Invoke `sdd_auditor` in the workspace to run release gates:
1. Spec update verified: `npm test -- tests/spec.test.ts`.
2. Steering check: `python3 .antigravity/scripts/check_steering.py`.
3. Typecheck and rule parity: `npm run typecheck` and `npm test -- tests/AgentRuleFilesParity.test.ts`.
4. Full test suite: `npm test`.

### Phase 6: Branch Push, PR Creation & Handoff
- `sdd_auditor` pushes feature branch to origin and opens Pull Request via `gh pr create --base main --head sdd/<feature-name>`.
- Parent agent compiles `walkthrough.md` in brain folder with PR link, wave commit summary, and test logs.
- Instruct user to review and squash-merge the PR on GitHub.


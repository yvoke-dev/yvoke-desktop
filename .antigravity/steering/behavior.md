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

### 0. Discovery & Research Phase
- **Take Time to Understand**: Before creating any design documents or writing code, the parent agent must take its time to fully understand what needs to be done.
- **Grill the User**: Ask clarifying questions to resolve any ambiguity, underspecified requirements, or design intent. Do not proceed with assumptions if requirements are unclear; instead, interview/grill the user to align on details.
- **Alternative Strategies**: Perform research to identify and document 2 to 3 different ways of achieving the feature.
- **Pros/Cons & Recommendation**: For each proposed strategy, list concrete pros and cons, and conclude with a clear recommended path. Only transition to the next phase after the user approves/aligns on the recommendation.

### 1. Planning Mode
- The parent agent enters Planning Mode natively to create and manage the feature design (`implementation_plan.md`) and task checklist (`task.md`) inside the native brain directory (`<appDataDir>/brain/<conversation-id>/`).
- Do NOT create any design plans, checklists, or spec files inside the workspace root or the `.antigravity/` folder.

### 2. Subagent Definition Protocol
- Before invoking a specialized subagent (e.g., `desktop_implementer`, `desktop_reviewer`), the parent agent MUST read the corresponding markdown template file in `.antigravity/agents/` (e.g., `desktop_implementer.md`).
- Define the subagent first using the `define_subagent` tool, passing the exact name, description, and system prompt found in that template file. Configure the tool permissions as specified.
- Always run subagents with `Workspace: inherit` to modify the active local repository directly.

### 3. Sequential Subagent Execution & Checklist Update
- Only one code-writing subagent (`desktop_implementer`) may be active at any given time.
- The implementer performs changes in-place on the local workspace without creating git branches or committing.
- The implementer reports task completion to the parent agent. The parent agent updates its native task checklist (`task.md`) in its brain folder directly.

### 4. Code Review & Remediation Loop
- Once the implementer finishes, the parent agent invokes `desktop_reviewer` (`Workspace: inherit`) to review the uncommitted changes.
- **Remediation Loop**: If the reviewer finds material issues (High/Medium severity):
  1. Present findings and a proposed fix to the user.
  2. Upon user approval, invoke `desktop_implementer` to remediate the issues.
  3. Re-run `desktop_reviewer` to verify.
- Once clean, the parent agent checks off the reviewer audit task natively in `task.md`.

### 5. Steering Maintenance, User Review, & Ship
- At the end of implementation, the parent agent runs the steering check script:
  `python3 .antigravity/scripts/check_steering.py`
- If structural changes occurred, the parent agent updates the corresponding steering files under `.antigravity/steering/` (`structure.md`, `tech.md`, `product.md`).
- The parent agent writes `walkthrough.md` in its native brain folder (never in the workspace).
- Present the final summary, uncommitted git diff, and review findings to the user.
- **Do NOT commit or merge changes.** Present the final summary and ask the user to review the files in their IDE and commit manually when ready.

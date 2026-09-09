# Yvoke - Desktop — Agent Project Rules

This project enforces Spec-Driven Development and strict architectural patterns.
These rules **override** default behavior. Follow them exactly.

> This file is the multi-agent equivalent of `CLAUDE.md`. The two are kept
> in sync intentionally — if you change a rule here, mirror it there (and vice versa).

## 1. Universal Hard Rules (apply to ALL tasks)

- **Branch isolation, pre-flight confirmation, wave commits & PRs**: Never commit directly to `main`, push to `main`, or merge via Git. The same applies to release tags: never create, move or push one. Releases are cut strictly via `npm run release` (`scripts/release.sh`), which checks for clean `main`, runs typecheck and tests, bumps `package.json`, commits, tags, and pushes in one place. For SDD feature development, always verify and confirm the active branch with the user as the first step (even if not on `main`, to guard against stale feature branches); work on a confirmed dedicated branch (`sdd/<feature>`), commit per wave once reviewed, and open a Pull Request against `main` for the user to review and squash-merge.
- **Testing & TDD**: Use strict TDD (Red → Green → Refactor). All tests live under `tests/`, ending with `.test.ts` or `.test.tsx`. Run unit and integration tests via `npm test` (Vitest).
- **Regression testing**: When a bug is discovered, first write a failing test in `tests/` that reproduces it, then fix it.
- **A test does not count until you have seen it fail**: after writing or changing a test, break the *one specific thing it claims to pin* with a minimal edit to production code, run it, watch it go **red**, then restore — by re-reading the original, never from memory, since a whole-file restore silently reverts a sibling mutation and the "green" run afterwards proves nothing. A test that has only ever been green is a claim, not evidence, and a brand-new test that passes on its **first** run against code you have not yet fixed is a defect in the test, not luck.
- **Confirm the change is actually running before you trust a result**: the edit is made, the tool reports success, and the change is not live — always verify TypeScript types via `npm run typecheck`, confirm the test count changed, and never assume an edit was cleanly picked up.
- **Prefer making the bug unrepresentable over fixing it**: when the fix is in, ask what parameter, branch or overload can now be **deleted** so the mistake cannot be re-expressed — an argument or state that no longer exists needs no rule, no comment and no reviewer. This is the only form of guidance a future agent cannot skip, misread or fail to load, so reach for it before reaching for prose.
- **Electron multi-process boundaries**: Respect the four architectural layers. Renderer (`src/renderer/`) must never import from `src/main/` or `src/preload/`. Preload (`src/preload/`) must never import from `src/main/` or `src/renderer/`. Main (`src/main/`) must never import from `src/renderer/` or `src/preload/`. Only pure data types in `src/shared/types.ts` may cross boundaries. Enforced by `python3 .antigravity/scripts/check_steering.py`.
- **Preload API isolation**: Preload scripts must use `contextBridge.exposeInMainWorld` to expose narrow, explicit methods. Never leak raw Node `require`, Electron `ipcRenderer`, or system APIs directly to the renderer.
- **No assumptions**: If requirements are ambiguous, use the `ask_question` tool (or interactive questioning) to present structured options before proceeding. Do not guess on design intent.
- **The tests are the behaviour contract**: there is no prose specification of internal implementation behaviour, deliberately. Before changing a feature, read the tests that own it; to change behaviour, change a test. **If no test fails when you break a rule, that rule is not enforced** — treat it as undocumented rather than assuming it is safe, and pin it with a test in the same change.
- **The functional specification lives in `spec/` (indexed by `spec/README.md`)**: what the system does, its limits, and what it deliberately does not do. **Before a substantial change, read the relevant chapter in `spec/` for the area you are touching**, then the tests that own the feature: the chapter gives you intent and deliberate non-features, the tests give you the contract. Keep it true — a change a user would notice updates that chapter in the same change set, **Limits** / **Not supported** included, since intentional absences are what no test can fail on.
- **Self-learning**: When you hit a non-obvious pitfall or key architectural insight, record it so it isn't repeated — in § 6 *Known Pitfalls* of **both** this file **and** `.agents/AGENTS.md`, word for word (`AgentRuleFilesParity.test.ts` fails the build if they diverge, or if a pitfall is also restated outside § 6), or in the relevant `.antigravity/steering/` doc.

## 2. Engineering Standards (security · performance · maintainability)

Apply to **all** code, not just large tasks. Get it right while writing — do not defer to review.

**Security:**
- **Tainted input validation**: All data from the renderer over IPC (`ipcMain.handle` / `ipcMain.on`), remote sync endpoints, and LLM outputs are **untrusted**. Validate schemas and arguments at the boundary before processing or passing to system calls.
- **Content Security Policy (CSP)**: Maintain strict CSP headers in `src/renderer/index.html`. Never allow `unsafe-eval` or inline execution of external scripts.
- **Never expose secrets**: Credentials, API keys, and corporate bearer tokens must never be written to logs, stored in plain text outside secure caches, or included in client bundle outputs.

**Performance:**
- **React lifecycle and listener cleanup**: Every IPC subscription or DOM listener established inside a React `useEffect` MUST return an unsubscription cleanup function. Orphaned IPC listeners cause severe memory leaks and duplicated event dispatch.
- **Non-blocking main process**: Heavy compute (parsing huge JSON, crypto operations, search indexing) must not block Electron's main UI event loop. Stream large LLM answers incrementally.
- **Efficient state synchronization**: Use the offline `SyncQueue` for remote persistence without stalling local chat interactions.

**Maintainability:**
- Smallest change at the root cause; no speculative abstraction or "for later" config knobs.
- Vanilla CSS in `src/renderer/src/styles.css` using theme variables defined in `:root`. No ad-hoc inline styling (`style={{...}}`) in TSX components.
- Strict TypeScript typing across both Node and Web targets (`tsconfig.node.json`, `tsconfig.web.json`). No unnecessary `any` or loose casts.

## 3. Tech Stack & Local Workflow

- **Runtime & Framework**: Electron 42 + Vite 7 + React 19 + TypeScript 6.
- **Agent Loop**: Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) running native Claude CLI binary.
- **Testing**: Vitest (`npm test`).
- **Type Checking**: `npm run typecheck` (covers both Node and Browser compilation targets).
- **Spikes & Probes**: Headless probe scripts via `npm run spike` (`tsx scripts/spike.ts`).
- **Packaging & Release**: Multi-platform packaging via `electron-builder`. Releases managed strictly via `npm run release`.

## 4. Task Routing

- **Small / medium tasks**: Execute directly. No planning artifacts required.
- **Large tasks / features / refactors**: Use the Spec-Driven Development flow — activate the `asdd` skill (`.agents/skills/asdd/SKILL.md`) or follow `.antigravity/sdd_protocol.md`.
- **Subagents**: In Antigravity, bootstrap roles via `define_subagent` from `.antigravity/agents/*.md`:
  - `sdd_planner`: requirements discovery & sparring.
  - `sdd_plan_critic`: adversarial plan critique against Known Pitfalls (Gate 1).
  - `sdd_task_architect`: branch pre-flight check & wave breakdown.
  - `sdd_task_critic`: adversarial test critique eliminating Happy-Path Test Syndrome (Gate 2).
  - `desktop_implementer`: writes Electron main, preload, React UI, Vanilla CSS, and Vitest code via Red-Green TDD.
  - `desktop_reviewer`: read-only audit for IPC validation, memory leaks, CSP, type safety (Gate 3).
  - `sdd_auditor`: whole-change gatekeeper (spec, steering, parity, test suite, and PR).
  - Only **one** code-writing subagent should be active at a time.

## 5. Deep Context & Steering

**`spec/` (indexed by `spec/README.md`) is the functional specification** — eight capability chapters, each with *What you can do* / *How it behaves* / *Limits* / *Not supported*. It governs *what the product does*. **Start a substantial change by reading its chapter for the area you are touching**: it is the fastest way to learn what a feature is for, which behaviours are deliberate, and what the product has decided not to do. The **Limits** and **Not supported** sections are load-bearing — they record intentional absences, and an absence is exactly what no test can fail on. It is not a technical specification and must not become one; it says what the product does, never how it is built.

**The test suite is the behaviour contract.** `npm test` together with `npm run typecheck` is what enforces it; every rule worth preserving has a test that fails when it is broken. So: the spec chapter for *intent*, then the tests that own the feature for the *contract*, both read *before* changing it. This file governs *how to build*.

For large tasks or architectural decisions, also read the steering docs:
- `.antigravity/steering/tech.md` — tech stack details.
- `.antigravity/steering/structure.md` — directory & process layout.
- `.antigravity/steering/product.md` — domain glossary.
- `.antigravity/steering/behavior.md` — response guidelines & protocols.

After structural changes, run `python3 .antigravity/scripts/check_steering.py` and update steering docs if drift is flagged.

## 6. Known Pitfalls (project-specific)
Accumulated, hard-won gotchas. Several exist specifically because the obvious diagnosis was the wrong one — read this section before debugging a build or test failure that makes no sense.

**This list is a FULL MIRROR of `.agents/AGENTS.md` § 6, not a pointer.** The two files are the same rules for two different agent toolchains, and an agent that loads only one of them must not be missing a pitfall. Add every new entry to BOTH, verbatim, and to this section only — `AgentRuleFilesParity.test.ts` fails the build when they diverge, and also when a pitfall is restated outside § 6.

- **SDK `canUseTool` `allow` must always return `updatedInput`**: While the TypeScript type marks `updatedInput` optional, the Claude CLI validates the reply against a Zod union whose `allow` branch requires it — a bare `{ behavior: 'allow' }` fails at runtime with `ZodError: invalid_union` and silently blocks tool execution (this was why WebFetch broke in 1.1.4). Always return `{ behavior: 'allow', updatedInput: input }`. All allow paths in `src/main/agent/policy.ts` must pass `input` back unchanged when not rewriting.
- **Withholding Web & Clarification Tools from `allowedTools`**: `WebSearch`, `WebFetch`, and `ask_clarifying_question` must be granted but deliberately omitted from the SDK's `allowedTools` array (`withheldFromAutoApproval` in `src/main/agent/policy.ts`). Placing them on `allowedTools` bypasses `canUseTool`, completely disarming domain allow-lists and WAF challenge blocks without any test failing.
- **Tool Name Prefixing (`qualifyTool`)**: The harness built-ins `WebSearch`, `WebFetch`, and `ToolSearch` must pass through `qualifyTool` unprefixed. Prefixing them with `mcp__yvoke__` yields tools no server serves, causing declarations to be silently inert. Built-ins are matched case-insensitively against the bare name in `src/shared/types.ts`.
- **Bot-Challenged Hosts Denied Before Allow-List**: Hosts behind AWS WAF or Cloudflare (e.g. `support.oneidentity.com`, `www.oneidentity.com`) return `200 OK` with an empty body to non-browser fetch. The fetch succeeds and the model gets a blank page, tempting it to hallucinate. `WAF_CHALLENGED_HOSTS` in `policy.ts` must refuse these hosts upfront with an explicit instruction directing the model to use `WebSearch` instead, matched on exact host (never suffix, as `docs.oneidentity.com` serves 200 and is fetchable).
- **`webSearch.allowedDomains` is Deployment Configuration**: Domains are read strictly from bundled `settings.json` and never from the user's profile. `Settings.set()` must refuse renderer-supplied domain lists. An empty list is refused at runtime, and paths may be used to narrow fetching (matched on segment boundaries).
- **`settingsVersion` Defaults Reconciliation**: The store merges the user's `settings.json` over the bundled one and writes back the entire object, freezing current values. Changing a default in the bundle does not reach existing profiles unless `settingsVersion` is bumped and migrated via `CURRENT_SETTINGS_VERSION` in `reconcileWebSearch`. Bump it when a default must be re-applied, not when one is merely added.
- **Preload IPC Listener Memory Leaks**: In React components subscribing to main-process events (`window.api.on...`), the `useEffect` hook MUST return the unsubscribe cleanup function. Omitting cleanup leaves orphan listeners that trigger duplicate state updates and memory leaks on subsequent renders.
- **Cross-Process Import Boundary Violations**: Renderer code (`src/renderer/`) must never import from `src/main/` or `src/preload/`. Preload (`src/preload/`) must never import from `src/main/` or `src/renderer/`. Main (`src/main/`) must never import from `src/renderer/` or `src/preload/`. Only `src/shared/` can be imported across boundaries. Enforced by `check_steering.py`.
- **Native Claude Binary Packaging**: `node_modules` contains only the build host's native binary. Multi-platform and cross-architecture packaging requires running `scripts/fetch-claude-binary.ts` into `build/claude/<target>/` and unpacking via `asarUnpack` in `electron-builder.yml`. `AgentService` passes the staged path to the SDK as `pathToClaudeCodeExecutable`.
- **Incremental Search Indexing Covers Message Prose Only**: `search-index.json` indexes only message prose (thinking blocks and tool call/result payloads are skipped to keep the index ~40x smaller). Startup re-reads only logs whose size/mtime changed since the last sweep.
- **Single-Agent Playbook Preflight Fails Open**: The validation model call (`validate-playbook`) must fail open on timeouts, errors, or unparseable replies so the message sends anyway rather than blocking user chat.
- **Release Tags & Manual Commits Forbidden**: Never tag or push git tags manually; `electron-builder` requires versions in `package.json` and git tags to be stamped in sync. Releases are cut strictly via `npm run release` (`scripts/release.sh`), which checks for clean `main`, runs typecheck and tests, bumps `package.json`, commits, tags, and pushes.
- **Multi-Megabyte Console Logging Freezes GitHub Actions Runners**: Emitting massive (multi-megabyte) single-line strings to `console.log` or `stdout` (e.g. testing 5MB file rotation or dumping large buffers) freezes the GitHub Actions runner process (`Runner.Worker`) for hours. The runner's secret-masking engine scans every line with regexes to redact repository secrets, choking on lines with millions of characters. In logger implementations, cap or truncate single lines emitted to stdout/stderr (e.g. `MAX_CONSOLE_LINE_LENGTH = 8192`) while persisting full content to disk files, and spy on or mock console outputs in tests dealing with bulk payloads.

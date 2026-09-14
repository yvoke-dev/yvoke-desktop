# Project Structure

## Directory Layout

```
yvoke-desktop/
├── .agents/                # Antigravity & multi-platform instructions, hooks, and skills
│   ├── AGENTS.md           # Authoritative agent project rules
│   ├── hooks.json          # Antigravity lifecycle hooks (PreToolUse signing guard, Stop steering reminder)
│   └── skills/             # On-demand agent skills
│       └── asdd/
│           └── SKILL.md    # Antigravity Spec-Driven Development workflow skill
├── .antigravity/           # Steering files, ASDD protocol, subagents, and scripts
│   ├── steering/           # AI behavior, product, structure, and tech guidelines
│   │   ├── behavior.md
│   │   ├── product.md
│   │   ├── structure.md
│   │   └── tech.md
│   ├── agents/             # Subagent roles
│   │   ├── desktop_implementer.md
│   │   ├── desktop_reviewer.md
│   │   ├── sdd_auditor.md
│   │   ├── sdd_plan_critic.md
│   │   ├── sdd_planner.md
│   │   ├── sdd_task_architect.md
│   │   └── sdd_task_critic.md
│   ├── scripts/            # Boundary, steering, and hook verification scripts
│   │   ├── check_steering.py
│   │   ├── protect_signing_hook.py
│   │   └── steering_reminder_hook.py
│   └── sdd_protocol.md     # Normative 6-phase Spec-Driven Development protocol
├── .claude/                # Claude Code CLI configuration, commands, hooks, and agents
│   ├── agents/             # desktop-implementer, desktop-reviewer
│   ├── commands/           # /sdd command
│   ├── hooks/              # PreToolUse and Stop hooks (protect-signing, steering-reminder)
│   └── settings.local.json # Tool permissions and hooks registry
├── spec/                   # Modular functional specification
│   ├── README.md           # Specification catalog, glossary, and index
│   ├── 01_asking_questions.md
│   ├── 02_how_an_answer_is_produced.md
│   ├── 03_multi_agent_investigations.md
│   ├── 04_where_conversations_live.md
│   ├── 05_signing_in.md
│   ├── 06_settings_and_what_they_change.md
│   ├── 07_what_the_app_tells_the_server.md
│   └── 08_installing_updating_and_diagnosing.md
├── CLAUDE.md               # Claude Code authoritative project rules
├── src/                    # Source code
│   ├── main/               # Electron main process (Node.js runtime)
│   │   ├── agent/          # Claude Agent SDK runner, credentials, prompts, policy
│   │   │   ├── AgentService.ts
│   │   │   ├── ClaudeAuth.ts
│   │   │   ├── McpConnection.ts
│   │   │   ├── McpPrompts.ts
│   │   │   └── policy.ts
│   │   ├── auth/           # Microsoft Entra ID MSAL node authentication
│   │   │   └── ServerAuth.ts
│   │   ├── settings/       # Settings manager and store
│   │   │   └── Settings.ts
│   │   ├── store/          # Local JSON database for thread metadata and logs
│   │   │   └── ThreadStore.ts
│   │   ├── sync/           # Remote sync client and queue managers
│   │   │   ├── SyncClient.ts
│   │   │   └── SyncQueue.ts
│   │   ├── AppCore.ts      # Core orchestrator wiring main-process modules
│   │   ├── bootstrap.ts    # Headless mode, userData path resolution, and settings recovery
│   │   ├── index.ts        # Electron entry point (window setup, IPC registry)
│   │   └── log.ts          # Main process logger
│   ├── preload/            # Preload script (context bridge to expose secure APIs)
│   │   └── index.ts
│   ├── renderer/           # Renderer process (HTML/JS/CSS React app)
│   │   ├── index.html      # Host HTML page (defines CSP)
│   │   └── src/
│   │       ├── components/ # React UI components
│   │       │   ├── ChatView.tsx
│   │       │   ├── CitationModal.tsx
│   │       │   ├── FeedbackControls.tsx
│   │       │   ├── Markdown.tsx
│   │       │   ├── SettingsView.tsx
│   │       │   ├── StatusBanners.tsx
│   │       │   ├── ThreadList.tsx
│   │       │   └── ToolCallCard.tsx
│   │       ├── App.tsx     # Main application container
│   │       ├── env.d.ts    # Renderer-side typescript definitions
│   │       ├── main.tsx    # React mount entry point
│   │       └── styles.css  # Core application Vanilla CSS styling
│   └── shared/             # TypeScript types shared between main and renderer
│       └── types.ts
├── e2e/                    # Playwright end-to-end test suite
│   ├── support/
│   │   └── electronFixture.ts # Electron launch, temp userData, preflight check
│   └── app.spec.ts         # Application launch, composer, settings, and containment specs
├── tests/                  # Vitest unit and integration test suites
│   ├── AgentRuleFilesParity.test.ts # Enforces parity between CLAUDE.md and AGENTS.md
│   ├── bootstrap.test.ts   # Unit tests for bootstrap path & headless resolution
│   ├── spec.test.ts        # Enforces modular spec/ structure and sections
│   ├── SyncQueue.test.ts
│   ├── ThreadStore.test.ts
│   ├── policy.test.ts
│   ├── thinking.test.ts
│   └── translate.test.ts
├── scripts/                # Headless spike and automation scripts
│   └── spike.ts
├── tsconfig.json           # Composite typescript project references
├── tsconfig.node.json      # Node-side compilation targets (main/preload/scripts/tests)
├── tsconfig.web.json       # Browser-side compilation targets (renderer)
├── tsconfig.e2e.json       # E2E compilation targets (e2e/ and playwright.config.ts)
├── electron.vite.config.ts # electron-vite bundling configuration
├── playwright.config.ts    # Playwright E2E configuration
├── vitest.config.ts        # Vitest test runner configuration
├── package.json            # NPM dependencies and scripts
└── README.md
```

## Architectural Boundaries

1. **Main Process (`src/main/`)**:
   - Executes in Node.js environment with full system access.
   - Manages MSAL sign-ins, file writes, settings, offline queues, and Claude Agent SDK child process execution.
   - **Constraint**: Must never import React, DOM, or renderer files.
2. **Preload Script (`src/preload/index.ts`)**:
   - Acts as a bridge. Exposes API surface using `contextBridge.exposeInMainWorld`.
   - **Constraint**: Must never expose raw Node `require` or Electron module interfaces directly to the renderer. Must never import main process modules directly.
3. **Renderer Process (`src/renderer/`)**:
   - Executes in a sandboxed Chromium environment.
   - **Constraint**: Must never import main process files directly. Communications must pass strictly through `window.api` (exposed via preload script).
4. **Shared Types (`src/shared/`)**:
   - Contains pure data interfaces and types.
   - Safe to import in both main and renderer processes.

## State Storage Patterns

- **Local cache**: Written to JSON structures (e.g. `threads/`, `sync-queue.json`) under the user's OS-specific `userData` directory.
- **Server Database**: Synced back to the Postgres schema on the Spring Boot instance through transaction queue synchronization in `SyncQueue.ts`.

# Project Structure

## Directory Layout

```
yvoke-desktop/
├── .antigravity/           # Steering files, subagents, and guidelines
│   ├── steering/           # AI behavior, product, structure, and tech guidelines
│   │   ├── behavior.md
│   │   ├── product.md
│   │   ├── structure.md
│   │   └── tech.md
│   └── agents/             # Subagent roles (desktop_implementer, desktop_reviewer)
│       ├── desktop_implementer.md
│       └── desktop_reviewer.md
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
├── tests/                  # Vitest unit and integration test suites
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
├── electron.vite.config.ts # electron-vite bundling configuration
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

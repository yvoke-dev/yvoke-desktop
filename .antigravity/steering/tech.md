# Technology Stack

## Language & Runtime

- **Node.js 25+**: Main process execution engine.
- **Electron 42+**: Desktop runtime framework.
- **TypeScript 6+**: Primary compilation language.
- **React 19**: Frontend UI library.
- **Vite 7 (via electron-vite 5)**: Asset bundling and hot-reload server.

## Core Dependencies

### Electron & SDKs
- **@anthropic-ai/claude-agent-sdk**: Embedding local agent loop.
- **@modelcontextprotocol/sdk**: Interfacing with MCP tools.
- **@azure/msal-node**: Entra ID PKCE browser authentication.
- **react-markdown** & **remark-gfm**: Rendering chat markdown inside components.

### Development & Build Tools
- **electron-vite**: Specialized builder for Electron processes.
- **electron-builder**: Package distributions into portable formats (`.zip`, `.exe`).
- **vitest**: Fast test runner for Node.js unit testing.
- **tsx**: Executing spike/test scripts without pre-compiling.

## Configuration

- **Multi-Environment TS**:
  - `tsconfig.node.json` targets Node environment (`src/main/`, `src/preload/`, `tests/`, `scripts/`).
  - `tsconfig.web.json` targets Browser DOM environment (`src/renderer/`).
- **electron-builder.yml**: Configures macOS app builder and Windows NSIS installer properties.

## Styling & CSS Architecture

- **Vanilla CSS**: Maintained inside [styles.css](file:///Users/eduardpal/work/yvoke/yvoke-desktop/src/renderer/src/styles.css).
- **Design Tokens**: Standard colors, shadows, border radii, and spacing variables are declared under `:root`.
- **Responsive Layout**: Sidebar collapsible menu and chat pane are constructed using Flexbox/CSS Grid with smooth CSS transitions.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Run hot-reloading dev environment
npm run dev

# Run Vitest test suite
npm test

# Run typescript compilation checks for all compilation scopes
npm run typecheck

# Run end-to-end spike query test (requires local server and active Claude Code credentials)
npm run spike -- "your question"

# Bundle distribution files
npm run dist:mac     # Package for macOS (unsigned release/*.zip)
npm run dist:win     # Package for Windows (release/*.exe, release/*.zip)
```

## Spec-Driven Development (ASDD) Workflow

When implementing new features, the agent MUST follow the **Antigravity Spec-Driven Development (ASDD)** flow:
1. **Native Planning Mode**: All design plans, task checklists, and walkthroughs are managed natively within the parent agent's native brain conversation directory (`<appDataDir>/brain/<conversation-id>/`). No spec files are stored in the workspace.
2. **Workspace Cleanliness**: Keep the workspace entirely free of feature specifications, checklists, or design templates.
3. **Execution Sequence**:
   - Discovery Phase: Deeply understand the feature, grill the user on unclear requirements, research 2-3 approaches with pros/cons, recommend a path, and align in chat.
   - Construct and obtain approval for the design natively (`implementation_plan.md`).
   - Track progress natively (`task.md`).
   - Verify changes, run steering checks, and write results natively (`walkthrough.md`).

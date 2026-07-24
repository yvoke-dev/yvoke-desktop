# Yvoke - Desktop

Desktop chat client for Yvoke (spec: `specs/M20-desktop-chat/`). The agent loop runs locally via the **Claude Agent SDK**; the Spring app provides the `yvoke` MCP tools and the conversation/feedback Sync API (`/api/chat/v1`).

## Two Sign-ins

| What | Pays for / grants | How |
|---|---|---|
| **Claude** (Pro/Max subscription) | The model. Uses the Agent SDK monthly credit, separate from Claude Desktop usage. | The app picks up ambient Claude Code credentials. If missing: `claude /login` in a terminal (install: `npm install -g @anthropic-ai/claude-code`). The app never sees these credentials and strips any `ANTHROPIC_API_KEY` so billing stays on the subscription. |
| **Server** (Entra ID) | Access to the knowledge-base corpus + conversation storage. | Settings → Server authentication. `Dev` mode sends a static token (works when the server runs `APP_SECURITY_MOCK=true`); `Entra ID` runs the corporate sign-in in your browser (MSAL PKCE). |

## Development

First, install dependencies:
```bash
npm install
```

Available npm scripts in [package.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/package.json):
```bash
npm run dev          # Electron with hot reload (server expected on localhost:8080)
npm test             # vitest unit suite
npm run typecheck    # TypeScript compilation check using tsconfig.*.json
npm run spike        # headless end-to-end probe: query() + MCP over SSE + usage output
```

The spike script needs the Spring app running (`APP_SECURITY_MOCK=true` recommended) and a logged-in Claude Code. Run `YVOKE_SERVER=http://host:8080 npm run spike -- "your question"` to override.

## Packaging (unsigned, shared as plain files)

Configure packaging options in [electron-builder.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/electron-builder.yml). To build:

```bash
npm run dist:mac     # release/*.zip (ad-hoc signed, no certificate required)
npm run dist:win     # release/*.exe (NSIS) + release/*.zip (portable)
```

There is no code-signing certificate and no app store; recipients install from the file you send them and must do one extra step on first launch:

- **macOS**: unzip, drag to Applications, then **right-click → Open → Open** (or run `xattr -dr com.apple.quarantine "/Applications/Yvoke - Desktop.app"`). A plain double-click on first launch is blocked by Gatekeeper for unsigned apps.
- **Windows**: SmartScreen shows "Windows protected your PC" → click **More info → Run anyway**.

Auto-update is intentionally not included (it effectively requires code signing). To update, send a new zip. Proper signing/notarization later is an `electron-builder` config change only.

## Notes

- The Agent SDK's bundled Claude Code binary is unpacked from the asar archive (`asarUnpack` in [electron-builder.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/electron-builder.yml)) — don't remove that or packaged builds break.
- Conversations are stored on the server (Postgres) under your identity; the local `userData` dir keeps only a cache, the SDK session ids for resume, and the sync queue.
- There is no local code execution (no Bash / shell); the agent cannot run arbitrary commands. It can call `mcp__yvoke__*` tools, the safe in-process compute tools `mcp__compute__calculate` / `mcp__compute__statistics` / `mcp__compute__date_diff` (for arithmetic, statistics, and date math), and WebSearch when enabled in settings (hard-restricted to the configured domains).
- `webSearch.allowedDomains` ships **empty**, and the allow-list is per-deployment rather than product configuration — the domains worth searching belong to whichever knowledge base is loaded. It fails closed: with `webSearch.enabled: true` and no domains configured, a search is refused rather than run against the open web, so enabling the feature means listing domains at the same time.
- Type checking is split across Node and Web packages; configuration details are in [tsconfig.node.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.node.json) and [tsconfig.web.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.web.json).

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

## Packaging (self-signed, shared as plain files)

Configure packaging options in [electron-builder.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/electron-builder.yml). To build:

```bash
npm run dist:mac     # release/*.zip for arm64 + x64, signed
npm run dist:win     # release/*.exe (NSIS) + release/*.zip (portable), x64, unsigned
```

macOS builds are signed with a self-signed certificate you create once per machine — `dist:mac` fails with instructions if it's missing. See [docs/signing.md](file:///Users/eduardpal/work/yvoke/yvoke-desktop/docs/signing.md) for that, for why signing matters even though it doesn't satisfy Gatekeeper, and for the in-progress Azure Artifact Signing setup for Windows.

There is no Apple Developer ID and no notarization, so recipients still do one extra step on first launch:

- **macOS**: unzip, drag to Applications, then **right-click → Open → Open** (or run `xattr -dr com.apple.quarantine "/Applications/Yvoke - Desktop.app"`). A plain double-click on first launch is blocked by Gatekeeper for apps that aren't notarized.
- **Windows**: SmartScreen shows "Windows protected your PC" → click **More info → Run anyway**.

To cut a release:

```bash
npm run release            # patch; or -- minor / -- major
```

That runs `scripts/release.sh`, which checks you are on a clean, up-to-date `main`, runs the typecheck and tests locally — [ci.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.github/workflows/ci.yml) runs them too, but `release.yml` does not depend on it, so a red test would not stop a release — then bumps `package.json`, commits, tags, and pushes — behind one confirmation. The tag is a bare version like `1.0.1` (via `tag-version-prefix` in [.npmrc](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.npmrc)), which is what the workflow's tag filter matches. The equivalent by hand is `npm version patch && git push --follow-tags`.

The tag triggers [release.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/.github/workflows/release.yml), which builds both platforms and publishes a GitHub release. The workflow refuses to build if the tag and `package.json` version disagree, because electron-builder stamps artifact names and app metadata from `package.json`, not from the tag.

If a build fails, retry the *same* version rather than burning the next one — the version commit already stands, so only the tag needs recreating:

```bash
npm run release:retag      # or -- 1.0.1 for an explicit tag
```

That deletes the tag locally and on the remote, then offers to re-tag `HEAD` and push. A GitHub release that was already published must be deleted in the web UI first — removing the tag leaves the release behind.

The macOS job needs the signing certificate as two repository secrets, `MAC_CSC_LINK` (base64 of the `.p12`) and `MAC_CSC_KEY_PASSWORD`; see [docs/signing.md](file:///Users/eduardpal/work/yvoke/yvoke-desktop/docs/signing.md). To prove them without spending a tag, run the workflow manually (Actions → Release → Run workflow) — it builds both platforms and publishes nothing.

Auto-update is intentionally not included (it effectively requires Developer ID signing). To update, send a new zip.

## Notes

- The native Claude Code binary is **not** taken from `node_modules` when packaging. The SDK finds it by interpolating the running host into a package name (`…-sdk-${process.platform}-${process.arch}`), and npm only ever installs the build machine's own — so a cross-arch or cross-platform build would ship an app that throws `Native CLI binary … not found` on first use. Instead `scripts/fetch-claude-binary.ts` downloads the binary for each **target** (checksum-verified against the SDK's `manifest.json`) into `build/claude/<target>/`, `extraResources` stages it, and `AgentService` passes it to the SDK as `pathToClaudeCodeExecutable`. Adding a build target means adding it to the `fetch:claude` arguments in `package.json`.
- The SDK package itself is still unpacked from the asar archive (`asarUnpack` in [electron-builder.yml](file:///Users/eduardpal/work/yvoke/yvoke-desktop/electron-builder.yml)) — don't remove that or packaged builds break.
- Conversations are stored on the server (Postgres) under your identity; the local `userData` dir keeps only a cache, the SDK session ids for resume, the sync queue, and `search-index.json`.
- Sidebar search covers message text as well as titles. `search-index.json` is a local index over the cached `threads/*.jsonl` prose (message content only — thinking and tool payloads are skipped, which is why it stays ~40x smaller than the logs). It is rebuilt incrementally: startup re-reads only the logs whose size/mtime changed since the last sweep, and each new turn is folded in as it is written. Nothing is sent anywhere to search, and a thread that has never been opened on this machine has no local log — so it is findable by title until you open it, which rehydrates and indexes it.
- In single-agent chat, a message that carries a playbook is preflighted before the turn runs: a one-shot, tool-free model call (the conversation's own model, thinking off, ~3s) is asked whether the selected playbook suits the question, and an objection becomes a card offering the better-matching playbook or "Send anyway". It mirrors the web's `POST /chat/{id}/validate-playbook`, but runs locally like the rest of the agent loop. It fails open at every step — a timeout, an error, or a reply that will not parse sends the message as selected — and is switched off with `playbookValidationEnabled: false` (Settings → Agents → Single agent).
- There is no local code execution (no Bash / shell); the agent cannot run arbitrary commands. It can call `mcp__yvoke__*` tools, the safe in-process compute tools `mcp__compute__calculate` / `mcp__compute__statistics` / `mcp__compute__date_diff` (for arithmetic, statistics, and date math), and WebSearch when enabled in settings (hard-restricted to the configured domains).
- `webSearch.allowedDomains` ships **empty**, and the allow-list is per-deployment rather than product configuration — the domains worth searching belong to whichever knowledge base is loaded. It fails closed: with `webSearch.enabled: true` and no domains configured, a search is refused rather than run against the open web, so enabling the feature means listing domains at the same time.
- Type checking is split across Node and Web packages; configuration details are in [tsconfig.node.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.node.json) and [tsconfig.web.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.web.json).

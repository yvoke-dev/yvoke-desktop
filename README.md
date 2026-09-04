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
- There is no local code execution (no Bash / shell); the agent cannot run arbitrary commands. It can call `mcp__yvoke__*` tools, the safe in-process compute tools `mcp__compute__calculate` / `mcp__compute__statistics` / `mcp__compute__date_diff` (for arithmetic, statistics, and date math), and WebSearch / WebFetch when enabled in settings (hard-restricted to the configured domains).
- Web access is granted **per playbook**, and only for the tools a playbook actually names in its `tools:` list — declaring `WebSearch` alone yields search without fetch, which is the useful shape for a source whose pages cannot be fetched at all. The settings switch is a deployment-wide ceiling, not the grant: it used to be both, which meant enabling it handed the web to every playbook and all fourteen specialists of the OIM profile at once, with no way to give it to one. With no playbook selected there is no declaration to read, so plain chat is governed by the switch alone. `qualifyTool` passes the harness built-ins (`WebSearch`, `WebFetch`, `ToolSearch`) through unprefixed for this to work — before that, a declared `WebSearch` became `mcp__yvoke__WebSearch`, a tool no server serves, so the declaration was silently inert.
- `webSearch.allowedDomains` is **deployment configuration, not a user preference** — the domains worth searching belong to whichever knowledge base is loaded — so it is always read from the bundled `settings.json` and never from the user's profile, and Settings shows it read-only. That is what lets a release add a domain without a migration; it is safe to do retroactively because an empty list is refused at runtime anyway, so `[]` was never a working choice, only an unconfigured state. It still fails closed: with `enabled: true` and no domains, a search or fetch is refused rather than run against the open web. Entries may be written as `example.com`, `https://example.com` or `*.example.com` — all three mean the host and its subdomains — and an entry may add a path to narrow it: `www.example.com/community/` permits only that subtree **for fetching**, since the WebSearch API takes bare domains and cannot express a path. The path is matched on segment boundaries, so `…/community` and `…/community/` mean the same thing and neither reaches a sibling such as `/community-blog` that merely starts the same way.
- The restriction is enforced in `canUseTool` (`src/main/agent/policy.ts`), which the runtime consults only for calls it has not already pre-approved. `WebSearch`, `WebFetch` and `ask_clarifying_question` are therefore granted but deliberately kept off the SDK's `allowedTools` — see `withheldFromAutoApproval`. Putting them back on it would disarm the domain allow-list without any test failing.
- WebFetch reads a permitted page **in full**, not as a snippet, and that text reaches the assistant the same way corpus content does. The allow-list bounds where content may come from, not what it says; keeping domains that carry reader-supplied content off the list is an operator decision.
- Being on the allow-list is not the same as being readable. A domain behind a bot-challenge — AWS WAF, Cloudflare and the like — answers a non-browser client with an empty body, so the fetch *succeeds* and hands the model a blank page rather than an error. `canUseTool` gates the request, not the response, so the app cannot fix that in general — but it can refuse the hosts known to do it, and does: `WAF_CHALLENGED_HOSTS` in `policy.ts` denies WebFetch on `support.oneidentity.com`, `www.oneidentity.com` and `oneidentity.com` with a message telling the model to use WebSearch and not to imply it read the page. Matched on the exact host, never by suffix, because `docs.oneidentity.com` on the same registrable domain serves `200` and is perfectly fetchable. Check a real article before relying on any other domain.
- The two lists are maintained independently, and **in this deployment they overlap completely**: every host in the shipped `allowedDomains` is bot-challenged, so `WebFetch` currently denies every URL it could otherwise be given (a subdomain of one of those entries would still work — none is listed). This build is search-only in practice, so declare `WebSearch` in a playbook and not `WebFetch`, or the model spends turns collecting denials. Because nothing surfaces that at runtime, `webAccessDiagnostics` states the effective grant in the `web` log at startup: which domains searches see, which hosts fetches refuse, and what — if anything — is left fetchable.
- `settingsVersion` is how a **changed default** reaches a profile that already exists. The store merges the user's `settings.json` over the bundled one and `set()` writes the whole merged object back, so the first Save freezes every value then current — which is why simply changing a default in the bundle reaches nobody who has ever opened Settings. A profile whose stamp is below `CURRENT_SETTINGS_VERSION` has the affected keys re-taken from the bundle once, and is then stamped; after that the user's choice wins in both directions. There is no registry of versioned keys: version 1 reconciles exactly one, `webSearch.enabled` in `reconcileWebSearch`, so what a bump means stays written beside the code that applies it — a later bump adds its own reconciliation there. Bump it when a default must be re-applied, not when one is merely added. The stamp lives only in the user's profile; the bundled `settings.json` does not carry it.
- Type checking is split across Node and Web packages; configuration details are in [tsconfig.node.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.node.json) and [tsconfig.web.json](file:///Users/eduardpal/work/yvoke/yvoke-desktop/tsconfig.web.json).

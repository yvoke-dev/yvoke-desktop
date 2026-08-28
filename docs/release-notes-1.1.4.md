# Yvoke Desktop 1.1.4

Changes since 1.1.3. Three feature commits: `8177fef`, `a14c708`, `90a912a`.

## Image attachments in chat (multimodal)

- Messages can carry images. Attach them from the paperclip button in the composer, by pasting
  from the clipboard, or by dragging files onto the chat pane (`src/renderer/src/components/ChatView.tsx`).
- Accepted types are PNG, JPEG, GIF and WebP; up to 5 images per message, 5 MB per image and
  15 MB decoded per message. The renderer checks these to keep the error in the composer; the
  main process re-validates and sanitises every attachment before the turn runs
  (`validateAndSanitizeImages` in `src/main/AppCore.ts`) — the total cap exists because base64
  inflation would otherwise push a legal batch past the API's per-request ceiling.
- Attachments reach the model as real base64 image blocks alongside the message text
  (`src/main/agent/AgentService.ts`).
- Sent images appear as thumbnails on the user message and open in a lightbox (click to enlarge,
  `Escape` to close), with copy and download actions.
- Attachment payloads are stored out of line: the JSONL thread log keeps only a reference and the
  base64 goes to a sibling blob file under `images/<threadId>/`, so opening a thread and sweeping
  the search index no longer re-parse megabytes of base64. Older logs that inline `data` still read
  correctly, and deleting a thread removes its blob directory
  (`src/main/store/ThreadStore.ts`).
- New IPC channel `clipboard:write-image` copies an image to the system clipboard through Electron's
  native clipboard, rejecting anything it cannot decode rather than silently blanking the clipboard
  (`src/main/index.ts`).

## Automatic image descriptions for synced transcripts

- New `ImageDescriptor` (`src/main/agent/ImageDescriptor.ts`) captions each attachment locally in
  one or two sentences, so the server transcript — which is text only — records what a screenshot
  showed instead of just its filename.
- It runs as a one-shot, tool-free call on `haiku` (not the conversation's model), 10 s timeout,
  two images at a time, and never rejects: any failure falls back to the bare filename note.
- Descriptions start when the message is sent so they run alongside the agent turn; persistence
  waits at most 2 s for them (`DESCRIPTION_PERSIST_GRACE_MS`) and otherwise writes the filenames
  alone. Turn persistence is now chained per thread so a slow described turn cannot be overtaken by
  the next short one and swap the two in the log and on the server.
- Descriptions are normalised before storage — whitespace and brackets collapsed, clipped to 500
  characters at a word boundary — so one attachment stays one line in the synced body
  (`normalizeImageDescription` in `src/shared/types.ts`).
- New setting **Agents → Attachments → "Describe images before syncing"**
  (`imageDescriptionsEnabled`, default on). Turning it off syncs the filename only and skips the
  extra model call — relevant because the description records a screenshot's contents server-side.
- `PlaybookValidator` and `ImageDescriptor` now share the single-turn reply reader
  (`src/main/agent/singleTurn.ts`).

## WebFetch: full-page reading, domain-restricted

- The agent can now fetch whole pages (`WebFetch`), not just search, when web search is enabled —
  and only within the configured allow-list (`src/main/agent/policy.ts`).
- Fetch URLs are verified against the list: non-HTTP(S) schemes and unmatched hosts are denied;
  exact hosts and their subdomains match.
- Allow-list entries are read generously and matched strictly. `example.com`,
  `https://example.com/docs`, `*.example.com`, `.example.com`, a port and a trailing root dot all
  reduce to the same host (`normalizeDomain`). An entry that reduces to nothing counts as nothing —
  the empty-list refusal is now checked *after* normalisation, so punctuation-only entries can no
  longer hand WebSearch an empty `allowed_domains`, which the API reads as "unrestricted".
- **Fix:** `WebSearch`, `WebFetch` and `ask_clarifying_question` are granted to the agent but
  deliberately withheld from the SDK's auto-approval list (`buildAutoApproveTools`). Pre-approval
  bypasses `canUseTool`, which is the only place the domain restriction and the clarifying-question
  interception live. This fixes the case where a playbook declaring `ask_clarifying_question`
  silently disabled clarifying questions — the assistant asked and nobody was ever asked.
- Settings → Web search updated: the toggle now reads "Allow web search and page fetching", explains
  that a permitted page is read in full, documents subdomain matching, and warns about entries that
  quietly do the wrong thing — a bare TLD (matches everything under it) or an entry carrying a
  path/query (the path is discarded, so the whole domain is allowed).

- Every `allow` returned from `canUseTool` carries `updatedInput`, even where nothing is rewritten.
  The SDK's TypeScript type marks the field optional, but the CLI validates the reply against a zod
  union whose `allow` branch requires it — a bare `{ behavior: 'allow' }` is rejected as malformed
  and the call dies with `ZodError: invalid_union` rather than running. This was caught before
  release: the first tagged 1.1.4 build had it, and WebFetch failed on every call while WebSearch
  worked, purely because WebSearch already passed `updatedInput` for the domain injection.
- Being on the allow-list does not make a domain readable. A site behind a bot-challenge (AWS WAF,
  Cloudflare) answers a non-browser client with an empty body — `support.oneidentity.com` returns
  `202` with `x-amzn-waf-action: challenge` and zero bytes — so the fetch *succeeds* and hands the
  model a blank page instead of an error. The app cannot tell the two apart: `canUseTool` gates the
  request, never the response. Noted in Settings, the README and the spec; verify a real page on a
  domain before relying on it.

## Mermaid diagrams

- New sanitizer (`src/renderer/src/components/mermaidSanitizer.ts`) repairs the invalid Mermaid
  models commonly emit: semicolons and arrow operators inside sequence-diagram labels, unquoted
  parentheses/semicolons in flowchart node labels and subgraph titles, and literal `\n` where
  `<br/>` was meant.
- Repairs are staged by how much they can change what the reader sees — `syntactic` (quoting only)
  → `text` (character substitution inside labels) → `escapes` (`\n` → `<br/>`, lossy, e.g. Windows
  paths). The renderer tries the chart as written first, then each stage in order, and only reports
  a failure — against the original chart — if none parses. Failed render nodes are cleaned up
  instead of accumulating in the DOM.
- New diagram modal (`src/renderer/src/components/DiagramModal.tsx`): zoom (0.25×–5×), pan by drag,
  keyboard controls (`Escape`, arrows, `+`/`-`, `0`), and a click-outside dismiss that is not
  triggered by a drag released outside the modal.
- Diagram toolbar: copy Mermaid source, copy the diagram as a PNG, and zoom. The PNG export embeds
  the Archivo web font as a data URL so exported labels keep the metrics they were laid out with
  (`src/renderer/src/components/CopyButton.tsx`).
- Mermaid is now configured with the app font and tighter flowchart spacing, and `useMaxWidth` is
  off across diagram types so diagrams render at their natural size.
- A failed diagram still offers "Copy Mermaid source".

## Docs

- `README.md`, `spec.md` and `.antigravity/steering/product.md` updated for WebFetch, the
  grant-vs-pre-approval distinction, the domain normalisation rules, and the fact that a fetched
  page arrives in full and is therefore uncurated corpus the operator has to decide about.

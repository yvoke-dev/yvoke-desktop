# 7. What the app tells the server

**What it is for.** The contract between this app and Yvoke's server: what it reads, what it writes,
and what therefore shows up in the web app's screens.

**Who uses it.** The platform team, and the product owner deciding what the company can see about
desktop usage.

## What you can do

| Capability | What happens |
| --- | --- |
| **Read the knowledge base** | Every search, listing, table of contents, section read, graph lookup, record query and citation check goes to the server's knowledge-base connection, authenticated as the signed-in user. |
| **Read the configuration** | The whole playbook library and every multi-agent profile are fetched live over the same connection. |
| **Write conversations** | Conversations are created, retitled, re-settinged and deleted through the conversation API, and each finished turn is appended to it (including the active playbook name and version number on both user and assistant messages in single-agent turns). |
| **Write ratings** | A thumb and its comment are stored against the server's id for that answer, so they appear in the web app's feedback screens and counts. |
| **Write multi-agent traces** | A completed multi-agent turn is uploaded step by step (including each step's playbook name and resolved version number) and appears in the web app's trace viewer alongside runs the web performed. |
| **Mark itself as the desktop** | Conversations are created labelled as coming from the desktop and the desktop version that created them, which is what lets the web sidebar mark them as desktop conversations and lets the conversation header and the admin conversation register show which desktop version started each one. |
| **Share a conversation's settings with the web** | The model, the thinking level and the selected profile are written together alongside any existing server-side conversation settings under the keys the web app uses, so the two surfaces see the same choices without overwriting one another. |
| **Reconcile and clean up conversations** | At startup, the app reads server messages for conversations with unsaved local work so only missing trailing turns are uploaded, recreates conversations that disappeared from the server whenever local messages exist, and removes untouched empty desktop-created conversations once per launch. |

## How it behaves

- **The app only ever reads the corpus.** Nothing reachable from here can import, edit or delete
  knowledge-base content.
- **Configuration changes reach the app without a release.** A playbook or profile
  edited on the server is picked up within about a minute — the same library the web app and connected
  AI clients read.
- **An answer is stored as one text field with markers in it.** Reasoning and the name and arguments of
  each tool call are folded into the stored text so a desktop conversation can be read in the web app.
  A multi-agent turn instead stores the composed answer and the lead's reasoning, with its team's work
  going to the trace.
- **Playbook names and version numbers round-trip with the server.** When a single-agent turn is synced,
  both the user message and the assistant message include the active playbook name and its positive
  whole-number version, and pulling a conversation from the server restores both onto the local messages
  (ignoring blank names, invalid version numbers, or version numbers without a playbook name) and locks
  the conversation's playbook from the restored transcript. Multi-agent messages carry neither on the
  messages themselves and instead report the playbook name and version number on each uploaded trace step.
- **Creating a conversation records the desktop version that created it, and later settings updates preserve that creation version.**
  When a new conversation is created, the app records its own version verbatim (trimming only surrounding
  whitespace, and omitting non-text, blank, or over-256-character values) alongside the initial conversation
  settings. Updating a conversation's settings later — including from a newer desktop release — preserves
  the version recorded when the conversation was created rather than overwriting it, and older
  conversations that were created before version recording was introduced remain unversioned.
- **Conversation settings updates preserve existing server settings, adopt remote profile changes on unstarted conversations, and repair diverged server profiles on refresh.**
  Whenever a conversation's model, thinking level, or multi-agent profile changes, the app merges its
  settings with the conversation's latest server settings so that updating one setting on the desktop
  never clears web-managed settings (and keys removed on the server are not resurrected). When refreshing
  the conversation list, if a conversation has not yet started locally and has no turn in flight, the app
  adopts any non-blank orchestrator profile reported by the server; once a conversation has started locally
  (or while a turn is in flight), its local agent mode is permanently locked, and whenever the server's
  reported orchestrator profile is missing, blank, or differs from the local mode, the app pushes the full
  conversation settings back in the background to repair it.
- **A rating is refused rather than queued** when the answer has not yet been accepted by the server —
  there is no id to attach it to.
- **Startup compares unsaved local turns against the server's stored messages.** When the app starts
  with unsaved local turns, it reads up to 10,000 messages per affected conversation from the server,
  adopts the server identifiers of turns that had already been saved before a crash, and uploads only
  trailing unsaved turns along with their ratings and multi-agent traces (leaving any unsaved gap
  earlier than a later server-saved message local rather than overwriting the server conversation).
- **Missing server conversations with local messages are recreated in full, preserving their creation desktop version.**
  Whenever the server reports a conversation missing and this machine holds cached messages or waiting
  turns for it, the app creates a new server conversation with the same settings and the original
  creation desktop version (leaving legacy conversations created before version recording unversioned),
  then uploads every cached turn, rating, and multi-agent trace in chronological order.
- **Turns rejected as invalid are dropped for the session with a dismissible error banner and retried once on the next launch.**
  If the server rejects a turn as invalid (other than an expired sign-in token or a missing
  conversation), the app stops retrying that turn for the rest of the session, shows a sticky
  dismissible error banner, and tries it once more on the next app launch while it remains unrecorded on
  the server.
- **Confirmed-empty stale desktop conversations are deleted once per launch.** Once per launch after
  reaching the server, for any desktop-created conversation at least five minutes old that still has a
  blank or default placeholder title, has not been touched in the current session, and has zero local
  messages, the app checks whether the server holds at least one message for it and deletes the
  conversation when the server confirms it is empty (leaving web-created conversations untouched and
  doing nothing if the check fails).

## Limits

- **The company cannot see what a desktop answer cost.** The model calls are billed to the user's own
  Claude subscription, so only the knowledge-base searches the app makes appear in the server's spend
  reporting. A desktop conversation therefore looks far cheaper than it was, in the same report as a
  web one.
- **No tool result is ever stored.** The server holds which tools ran and what they were asked, never
  what they returned — so a desktop answer cannot be audited from the server the way a web answer can.
- **Beyond the desktop version recorded when a conversation is created, the app tells the server nothing about the client machine.**
  No operating system, no platform, no hardware details, and no per-message version are sent; a
  conversation continued after an app upgrade still carries only the version that originally created it,
  and older conversations created before version recording was introduced carry no version at all.
- **Searches from this app are not rate-limited by anything.** The web app's per-user cap does not
  cover this route.
- **A rejected turn sets its trace aside for the session.** If the server rejects a turn as invalid, its
  pending multi-agent trace is not uploaded during that session (and is rebuilt from the local message
  cache only if the turn succeeds on the next launch's single retry).
- **Live retries carry no idempotency key, though startup comparison avoids re-sending committed turns across restarts.**
  Re-sending the same turn after a dropped connection mid-reply can create a second copy on the server
  within a session, and startup comparison stops at 10,000 server messages per conversation; multi-agent
  trace uploads likewise skip retrying network drops, internal server errors, gateway timeouts, and
  malformed responses during a session, though a gateway error returned after the server committed can still record a
  duplicate trace row.
- **The sidebar applies no topic or visibility filter to the 200 most recent conversations the server returns.**
  Refresh asks for the signed-in user's 200 most recently updated conversations and merges all of them
  alongside retaining locally cached conversations past 200 (pruning only unopened header-only entries
  outside that 200-conversation window and deleting untouched empty desktop-created conversations once
  per launch).

## Not supported

- Writing to the knowledge base in any form.
- Reading a multi-agent trace back from the server. Once a run's detail leaves this machine it can
  only be read in the web app.
- Reaching any administrative endpoint. The app speaks to the knowledge-base connection and the
  conversation API, and nothing else.
- Telling the server that a turn failed, was stopped, or was never asked.


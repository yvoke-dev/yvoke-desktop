# 4. Where conversations live

**What it is for.** Conversations belong to the server, under the signed-in identity. This chapter is
what the app keeps on the machine, when it talks to the server, and what happens when it cannot.

**Who uses it.** Every user, usually without noticing — until they open the app on a second machine,
or lose the network mid-conversation.

## What you can do

| Capability | What happens |
| --- | --- |
| **Keep every conversation in the account** | Creating, changing settings and deleting all happen on the server; the local copy follows. Conversations appear in the web app's sidebar marked as coming from the desktop. |
| **Read old conversations offline** | Everything opened on this machine is cached, so the sidebar and the transcripts still work with no network. A banner says the server is unreachable. |
| **Pick a conversation up on another machine** | Opening a conversation with no local copy pulls its messages back from the server and caches them. |
| **Keep asking while sync is down** | A finished turn is written locally and queued. The queue survives restarts and resumes automatically at startup; a banner counts all waiting turns across every conversation. |
| **Search what was said, locally** | The sidebar's search runs entirely against the local index; no query and no text ever leaves the machine. |
| **Delete a conversation everywhere** | Deleting removes it from the server, from the local cache, from the message log and from the search index. |

## How it behaves

- **The server is the record; the disk is a cache.** What is kept locally is the conversation list,
  one message log per conversation, the search index, the sync queue, the encrypted sign-in token, and
  a working directory the assistant is pointed at.
- **A turn is written locally first, then queued.** The local write is best-effort and never delays
  the answer; the queued copy is what guarantees delivery.
- **Undelivered turns resume automatically when the app starts.** At launch, the app scans local
  message logs alongside the sync queue and immediately shows the total number of waiting turns across
  all conversations in the banner — even while offline or signed out, without opening a browser sign-in
  prompt. Once the server is reachable, queued turns and any unqueued local turns left behind by an
  earlier crash or damaged queue file are reconciled against the server and delivered automatically
  without waiting for a new question to be asked.
- **Startup compares local turns against the server's messages before sending.** For each conversation
  with unsaved local work, the app reads up to 10,000 messages from the server: turns that already
  reached the server before a crash adopt their server identifiers without sending duplicates, and only
  trailing unsaved turns at the end of the conversation are uploaded (along with any local ratings and
  desktop multi-agent traces recorded on them).
- **A conversation missing on the server is recreated whenever local messages exist.** Whether checked
  at startup, during a conversation list refresh, or while uploading a turn, if the server reports that
  a conversation does not exist and this machine holds at least one cached message or waiting turn for
  it, the app creates a replacement conversation on the server — preserving its model, thinking level,
  multi-agent profile, and original creation desktop version (leaving older unversioned conversations
  unversioned) — moves the local conversation, search index entry, and open composer draft seamlessly to
  the replacement, and re-uploads every cached turn, rating, and desktop multi-agent trace in
  chronological order. Deleting a conversation from the web app alone therefore causes a desktop machine
  that still holds its cached messages to recreate it on startup; deleting from the desktop app removes
  both copies.
- **Transient retries are unbounded, deliberately.** A turn keeps trying rather than being lost while the server
  is merely down, backing off 2, 5, 15, 30 and then 60 seconds between attempts.
- **A turn the server rejects as invalid is set aside for the session and retried once on the next launch.**
  When the server refuses a turn as invalid (other than an expired sign-in token or a missing
  conversation), that turn is dropped from the active queue for the rest of the session and surfaces a
  sticky dismissible error banner so other turns can continue; because the turn stays in the local
  message log as unsaved on the server, the next app launch attempts it once more. An expired sign-in
  token instead triggers one silent re-authentication and retry.
- **Durable index and queue files are written atomically, preserved on corruption, and rebuilt from message logs.**
  A corrupt conversation index or sync queue is renamed aside as a `.corrupt` backup rather than
  overwritten (or salvaged item by item when partially readable), a conversation whose message log
  survived on disk is reconstructed if its index entry was lost, and a half-written trailing line in a
  message log costs at most that damaged line rather than the conversation.
- **Conversations past the server's 200-conversation refresh window stay cached and listed while they still exist on the server.**
  On refresh, unopened header-only entries missing from the server's 200-conversation list are pruned
  locally, whereas any conversation outside that list that holds cached local messages is checked
  individually: if it still exists on the server, its local message log, search index entry, and model
  session stay on disk and those conversations remain listed, openable, and searchable in the sidebar
  (keeping their last known local title and settings); if it is missing on the server, it is recreated
  from the local cache. Conversations with turns waiting to sync are never pruned.
- **Untouched empty desktop conversations are cleaned up once per launch.** Once per launch after
  reaching the server, any desktop-created conversation that is at least five minutes old, still carries
  a blank or default placeholder title, has not been opened or touched during the current session, and
  has zero messages both locally and on the server is automatically deleted from the server and from
  this machine. Checks that fail do nothing rather than risking a conversation with content, and
  web-created conversations or custom-titled conversations are never touched.
- **Reopening reads local first.** Only a conversation with no local log is fetched from the server,
  and the fetch also rebuilds its token totals from the per-message figures, because those are normally
  accumulated turn by turn.
- **Deleting requires the server.** The server is asked first; if that fails, nothing local is removed
  and the conversation is still there.
- **The model's memory is local, and it is not the transcript.** Each conversation stores the model's
  own session on this machine. The transcript is synced; the session is not.
- **Search is incremental.** At startup only the logs whose size or timestamp changed are re-read, a
  turn written while the app runs is folded in immediately, and a search typed during startup answers
  from the previous session's index rather than coming back empty.
- **An empty playbook catalogue keeps retrying in the background.** While the server is unreachable or
  the playbook catalogue is still empty (for example, if the knowledge-base connection timed out at
  startup while the conversation list succeeded), the app continues retrying every 10 seconds in the
  background and reloads the playbook and multi-agent profile catalogues as soon as the server responds.

## Limits

- **A conversation continued on a second machine starts with no memory of itself.** The transcript is
  fetched and displayed in full, but the model's session lives only on the machine that produced it —
  so the next question is answered as if it were the first, with the earlier exchange visible on
  screen above it. The same happens after clearing the app's data, and after the machine's Claude
  tooling prunes its own session store.
- **Uncached conversations past the 200 most recent on the server do not appear in the sidebar.**
  Server refresh fetches only the 200 most recently updated conversations: uncached older conversations
  on the server are absent from the sidebar (and unopened header-only local entries past 200 are dropped
  on refresh, hiding any search hits for conversations absent from the sidebar), whereas conversations
  past 200 with cached local messages or waiting turns remain listed, openable, and searchable in the
  sidebar under their last known local title and settings because server metadata beyond the 200 most
  recent is not refreshed.
- **Once cached, a conversation is never re-fetched.** Turns added to it from the web app or another
  machine never appear here.
- **Refresh fetches the 200 most recent server conversations, and restoring an uncached conversation fetches up to 500 messages.**
  A conversation longer than 500 messages is restored partially on a second machine, oldest first, with
  nothing saying so.
- **Startup comparison inspects at most 10,000 server messages per conversation.** In a conversation
  that has grown past 10,000 messages on the server, startup comparison stops rather than paging further
  and leaves older unsaved local turns unqueued so it cannot append duplicates.
- **Unsaved local turns stranded earlier than a later server-saved message are skipped.** Startup
  backfill appends only trailing unsaved turns after the last message already present on the server; an
  unsaved local turn sitting mid-conversation ahead of a later synced message is left local rather than
  replacing or reordering the live server conversation.
- **A conversation restored from the server is a lossy copy.** Reasoning survives, and so does the name
  and arguments of every tool call — but no tool's *result* is stored at all, and each one comes back
  as the placeholder "Completed (details logged locally)" with no indication whether it succeeded. In a
  multi-agent turn the specialists' answers, the reviewer's verdict and the delegation cards are gone
  entirely; those live only in the server's separate run trace, which the app never reads back.
- **Ratings survive a restore; the trace does not.**
- **Transient network or server failures pause the shared sync queue, whereas conversations still awaiting startup comparison are skipped without blocking others.**
  While one conversation is still held for startup inspection, queued turns for other ready
  conversations continue draining; once the server itself is unreachable or returning transient errors,
  the queue backs off as a whole.
- **The queue is capped at 500 waiting turns.** Past that the oldest turn not currently being sent is
  dropped, with an error naming the cap.
- **A turn cannot be rated while rejected by the server**, because the rating needs the server's
  identifier for that answer; until a future launch retry succeeds, no server identifier exists.
- **A second corruption is not preserved.** If a `.corrupt` backup already exists, the newly damaged
  file is left in place and overwritten by the next save.
- **An unlogged turn in a damaged queue file is preserved only in the backup.** Startup log scanning
  recovers unsaved turns that reached a conversation's local message log even when the sync queue file
  is damaged, but if both the local message log write and the queue file failed before a crash, the
  `.corrupt` backup is never re-read automatically.
- **Nothing reconciles two machines.** The same conversation used on two machines interleaves turns by
  arrival order, and each machine's model session knows only its own half.
- **In-flight network drops after the server commits can still duplicate a turn within a session, though startup comparison deduplicates across restarts.**
  Neither side carries idempotency keys during live retries, so a connection lost after the server saved
  a turn but before its reply arrived can send that turn twice in the same session; across a restart,
  startup comparison matches already-saved turns against the server's transcript instead of re-sending
  them.
- **Per-conversation setting changes are fire-and-forget.** A model, thinking-level or profile change
  is applied locally and pushed to the server with the failure discarded — not retried, not reported,
  not even written to the app's own log. So the promise that the web and the desktop share one
  per-conversation setting is best-effort.
- **A conversation that has never had a profile chosen here adopts the server's**, while one that has
  keeps the local value. The two rules are not the same, and nothing on screen distinguishes them.
- **Reasoning tokens are never added to a conversation's totals** on either path, so the running total
  in the header understates every turn that thought.
- **The local cache is not encrypted.** Every question and answer opened on the machine sits in plain
  text under the app's data directory. Only the sign-in token is encrypted, and only where the
  operating system offers a keystore.
- **A conversation's transcript grows without limit.** It is read whole into memory every time it is
  opened, every time a rating or a server id is written into it, and every time the search sweep sees
  it change. Nothing truncates, rotates or compacts it.
- **Refreshing the list rewrites the whole conversation index once per conversation, on the thread that
  draws the window.** With 200 conversations that is 200 full rewrites in a loop.
- **Signing out leaves the cache behind.** Conversations, message logs and the search index all stay on
  the machine, and the sidebar still lists them.
- **A conversation created while the server is unreachable cannot be created at all**, and the failure
  is silent — see chapter 1.

## Not supported

- Asking a question offline. Reading works; answering does not.
- Exporting, backing up or importing the local cache.
- Any retention policy for conversations with content. Aside from the once-per-launch cleanup of untouched, empty desktop-created conversations at least five minutes old, nothing local is ever aged out or deleted automatically.
- Choosing where the cache lives, or clearing it from inside the app.
- Merging or de-duplicating conversations, on either side.
- Transferring a conversation to another person.


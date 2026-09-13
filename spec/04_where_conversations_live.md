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
| **Keep asking while sync is down** | A finished turn is written locally and queued. The queue survives restarts and keeps retrying; a banner counts what is waiting. |
| **Search what was said, locally** | The sidebar's search runs entirely against the local index; no query and no text ever leaves the machine. |
| **Delete a conversation everywhere** | Deleting removes it from the server, from the local cache, from the message log and from the search index. |

## How it behaves

- **The server is the record; the disk is a cache.** What is kept locally is the conversation list,
  one message log per conversation, the search index, the sync queue, the encrypted sign-in token, and
  a working directory the assistant is pointed at.
- **A turn is written locally first, then queued.** The local write is best-effort and never delays
  the answer; the queued copy is what guarantees delivery. In-flight local persistence operations
  across threads can be drained deterministically before test teardown or shutdown.
- **Retries are unbounded, deliberately.** A turn keeps trying rather than being lost while the server
  is merely down, backing off 2, 5, 15, 30 and then 60 seconds between attempts.
- **A rejection is not a retry.** A response that says the request itself was wrong — anything in the
  4xx range other than an expired token — drops that turn permanently and shows the reason. An expired
  token instead triggers one silent re-authentication and retry.
- **Both durable files are written atomically and preserved on corruption.** A corrupt conversation
  index or sync queue is renamed aside as a `.corrupt` backup rather than overwritten, and a
  half-written line in a message log costs that one message, not the conversation.
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

## Limits

- **A conversation continued on a second machine starts with no memory of itself.** The transcript is
  fetched and displayed in full, but the model's session lives only on the machine that produced it —
  so the next question is answered as if it were the first, with the earlier exchange visible on
  screen above it. The same happens after clearing the app's data, and after the machine's Claude
  tooling prunes its own session store.
- **Past 200 conversations, the oldest are deleted from this machine on every refresh.** The server's
  list is treated as authoritative and a locally cached conversation missing from it is removed along
  with its log. Only a conversation with turns still waiting to sync escapes.
- **Once cached, a conversation is never re-fetched.** Turns added to it from the web app or another
  machine never appear here.
- **200 conversations are listed and 500 messages are fetched.** A conversation longer than that is
  restored partially on a second machine, oldest first, with nothing saying so.
- **A conversation restored from the server is a lossy copy.** Reasoning survives, and so does the name
  and arguments of every tool call — but no tool's *result* is stored at all, and each one comes back
  as the placeholder "Completed (details logged locally)" with no indication whether it succeeded. In a
  multi-agent turn the specialists' answers, the reviewer's verdict and the delegation cards are gone
  entirely; those live only in the server's separate run trace, which the app never reads back.
- **Ratings survive a restore; the trace does not.**
- **Undelivered turns are not sent when the app starts.** Delivery resumes only when the next turn
  completes somewhere, so an app opened and closed without asking anything leaves the backlog sitting.
- **The queue is one ordered line shared by every conversation, and it stops at the first turn that
  fails.** One conversation's stuck turn holds up every other conversation's.
- **The queue is capped at 500 waiting turns.** Past that the oldest turn not currently being sent is
  dropped, with an error naming the cap.
- **A turn the server refuses can never be rated**, because the rating needs the server's id for that
  message and the turn was dropped before one was assigned.
- **The "waiting to sync" banner counts one conversation, not the backlog** — whichever conversation
  the most recent sync event was about.
- **A second corruption is not preserved.** If a `.corrupt` backup already exists, the newly damaged
  file is left in place and overwritten by the next save.
- **A corrupt sync queue is preserved but never delivered.** The backup keeps the undelivered turns on
  disk, and nothing ever reads it — recovering them is a manual job.
- **Nothing reconciles two machines.** The same conversation used on two machines interleaves turns by
  arrival order, and each machine's model session knows only its own half.
- **Sending the same turn twice creates two copies.** There is no replay protection on either side.
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
- Any retention policy. Nothing local is ever aged out or deleted automatically.
- Choosing where the cache lives, or clearing it from inside the app.
- Merging or de-duplicating conversations, on either side.
- Transferring a conversation to another person.


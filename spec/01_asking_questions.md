# 1. Asking questions

**What it is for.** The chat window: where a question is typed, an answer arrives with the sources
behind it, and the work that produced it can be opened and read.

**Who uses it.** Everyone who installs the app. There are no roles and no administrator view.

## What you can do

| Capability | What happens |
| --- | --- |
| **Start a conversation** | *New* creates the conversation on the server and opens it empty. The server names it; the app never invents a title. |
| **Pick a playbook** | An empty conversation opens on a picker listing every playbook the user may choose, filterable by title, name or description. In a conversation that already has messages, typing `/` opens the same list as an autocomplete — which filters on title and name only. Prototype playbooks (`prototype: true`) are hidden by default unless *Show prototypes* is enabled in Settings. A single-agent question needs one: sending without it raises *Playbook required* and nothing is asked. |
| **Ask by typing** | The composer starts three rows high and grows with the text to a maximum of nine, with the Send button vertically centered on the right inside the input field. Enter sends, Shift+Enter adds a line. Backspace on an empty composer removes the attached playbook. |
| **Attach images** | Attach up to five images (PNG, JPEG, WebP, GIF) using the attach button on the left of the toolbar, drag-and-drop, or clipboard paste. |
| **Watch the answer being written** | Text and reasoning stream in as they are produced. Until the first of either arrives, the answer shows *Working…*. |
| **Read a formatted answer** | Headings, tables, code blocks, mathematical formulas and drawn diagrams all render. While the answer is still streaming a diagram shows as its source text and is drawn once the answer finishes. |
| **Open the source behind a citation** | A source marker in the answer is a clickable pill; clicking it opens a *Citation source* panel containing the cited passage, fetched live from the server, with the section around it one click away. |
| **See how the answer was produced** | One *Trace* line under every answer that had anything to show — *N steps · N tools · N corpus searches · N failed* plus the turn's token counts. Opening it lists every stretch of reasoning and every tool call in order; opening a step shows its arguments and its result. |
| **Answer a clarifying question** | When the assistant needs more information a *Clarification required* card appears with the question, any ready-made options, and a free-text box. The composer is locked until it is answered, after which the card becomes *Clarification provided* with the answer. |
| **Get a playbook check before sending** | A message that carries a playbook is checked first: a *Playbook recommendation* card explains why another playbook fits better and offers **Switch to …** or **Send anyway**. |
| **Stop a running answer** | The Send button inside the input container dynamically switches to a danger *Stop* button while a turn runs. Stopping ends the turn and shows *Processing stopped.* |
| **Rate an answer** | Thumbs up or thumbs down on every answer. Thumbs up may carry a comment; thumbs down **requires** one. |
| **Copy an answer** | A copy button on every answer copies the answer prose — not the reasoning, the tool calls or the trace. |
| **Choose model, thinking effort and agent mode per conversation** | Three selectors sit in the right group of the bottom toolbar below the composer. Each conversation keeps its own choices; new ones start from the defaults in Settings. |
| **Search conversations** | The sidebar search matches conversation titles *and* the text of messages, showing the matching excerpt with the terms highlighted under the row. |
| **Browse by age** | Conversations are grouped *Today · This Week · Last Week · Earlier*, newest first, each row carrying a relative time that loses precision as it ages — *just now*, *12m ago*, *3h ago*, *Yesterday 14:22*, a weekday, then a date. Only the newest group is open to begin with; a section the reader opens or shuts stays that way. Weeks break where the reader's locale says they do. |
| **Delete a conversation** | Confirmed, then permanent — on the server as well as here. |
| **Change how the app looks** | Light / dark / follow-the-system theme, comfortable or compact rows, three answer text sizes, and whether the trace starts open. |

## How it behaves

- **Prototypes are hidden by default.** Playbooks flagged with `prototype: true` on the server are
  excluded from the picker, slash autocomplete, and preflight recommendations, and profiles flagged the same
  way are excluded from the profile selector, unless *Show prototypes* is enabled in Settings > Agents. One
  setting governs both. The profile a conversation is already set to always stays listed and keeps running,
  whatever the setting says — hiding it would leave the selector reading *Single agent* over a conversation
  that is still multi-agent.
- **A playbook is required for a single-agent question**, as it is on the web: a playbook is what
  scopes the answer, so a message carrying none is refused with a *Playbook required* card and the
  draft is kept. The refusal stands until a playbook is picked. Two cases are not gated, because in
  both the error would be one the user could not act on: a multi-agent conversation, which takes its
  playbooks from the profile, and a server that offers no playbooks at all, where the question is
  sent as it was and the assistant gets the default knowledge-base tool set.
- **A playbook stays selected across messages in a conversation**, matching the web model. Once
  chosen, follow-up questions continue under the same playbook without re-prompting or repeating
  preflight checks. The user can switch playbooks at any time with `/` autocomplete or clear it with
  the remove button. Preflight validation runs on the conversation's first message or when switching
  to a different playbook.
- **Only the answer's prose is the answer.** Reasoning and tool calls live in the trace *below* it,
  collapsed to a single line by default, because process is evidence rather than content. Two things
  stay inline instead: a clarifying question, which the user has to act on, and a delegation to a
  specialist, which in a multi-agent turn is the substance of the run.
- **No trace line means there was nothing to show**, not that it is collapsed. A turn that called no
  tool and did no visible reasoning has no bar at all, and its token counts move into the footer.
- **A question is displayed exactly as typed.** Only answers are rendered as formatted text; a
  question containing code, markdown or a citation-shaped token appears verbatim.
- **The composer layout partitions prompt drafting from toolbar controls.** The input field integrates the prompt textarea and the vertically centered Send / Stop action button on the right. Below it, the toolbar cleanly divides secondary actions: input attachments (image attachment button and active playbook badge) sit on the left, while conversation configuration (agent mode, model, and thinking level selectors) sits on the right.
- **A turn that fails is discarded — and takes its question with it.** Only a turn that ends without
  an error is written to the conversation and queued for the server, and the question is written in
  the same act. So a failed turn leaves no record of having been asked. The question stays on screen
  until the conversation is reopened, which is the only sign that anything was lost. Reaching the
  turn ceiling counts as a failure, so a long investigation that runs out of steps loses everything.
- **Stopping is the same act, for the same reason.** Stopping produces an error result, so the partial
  answer and the question are both discarded. The web app keeps a stopped answer; this one does not.
- **Failures are shown in full, and identify their origin upfront with a clear prefix.** Where the web app shows one generic notice, the desktop shows the underlying message and prefixes it with its actual cause: `Claude: ` for model service failures, turn limits (such as `error_max_turns`), or missing Claude sign-in; `Entra: ` for Microsoft Entra ID authentication and token acquisition failures; and `Yvoke Backend: ` for knowledge-base MCP connectivity, prompt loading, or sync API failures.
- **Anything the user has to act on sits above the conversation, not in it.** Errors, notices, the
  playbook cards and the check's own progress line occupy a strip between the title bar and the
  transcript, outside the part that scrolls, so none of them can be scrolled past — under a
  screenful of playbooks, a refusal at the foot of the pane read as nothing having happened. The
  strip is there only while it has something to say, and scrolls internally rather than growing, so
  a long error cannot crowd out the conversation.
- **The playbook check never blocks a question.** It fails open at every step: switched off, no
  server, a timeout, an unparseable reply, a suggestion naming a playbook that does not exist — all of
  them send the message as selected. It is an assist, not a gate.
- **An open recommendation is answered by sending again**, and the check is not repeated for the same
  playbook — including when the question has been rewritten in the meantime. Only changing the
  playbook makes it a new question.
- **A recommendation belongs to the composer, not the conversation.** Switching conversations retires
  the check and clears the card, and a verdict that arrives late for a conversation the user has left
  is dropped rather than applied.
- **A source marker is a bare id, shown short.** The server instructs the assistant to write the
  source's id in brackets — `[274b9610-9148-4621-a5a1-089e807210c1]` — with no prefix, no numbering
  and no reference list. The pill is labelled with the first eight characters, so an answer that
  cites every sentence still reads as prose; the full id goes to the lookup. The same source cited
  twice is the same id twice, and both occurrences are clickable.
- **A bare id does not say what it names**, so it is looked up as a passage first and as a whole
  document second. Almost every cited id is a passage; a document id arrives only when the
  assistant had no passage to point at.
- **A truncated id is not a marker.** Eight hex characters on their own are as likely to be ordinary
  prose, so only a full id becomes a pill.
- **The older prefixed forms still work.** An answer already in the local history may carry
  `[chunk_id=…]`, `[document_id=…]` or `[file=…]`; those stay clickable and keep their full label.
- **Numbered references are not clickable.** `[1]`-style markers render as plain superscripts; only
  markers that name a source open the citation panel. The same number appears in the answer's own
  reference list, so linking it would have made half the markers link to themselves.
- **Rating is per answer and replaceable.** A new thumb replaces the previous one, and the comment box
  opens pre-filled with whatever was said last time.
- **An answer cannot be rated until it has synced**, because feedback is stored against the server's
  id for that message. Until then it is refused with a message asking the user to try again shortly.
- **The sidebar's model badge only appears when it differs** from the default model, and the
  multi-agent marker only when a profile is selected — a row that matches the norm says nothing.
- **Creating and deleting both need the server, and a failure is silent.** *New conversation* pressed
  while signed out or offline does nothing at all: no row, no banner, no message. A delete whose
  server call fails behaves the same way, leaving the conversation in place.

## Limits

- **The sidebar lists the 200 most recently updated conversations, and the rest are deleted from this
  machine.** The list is treated as the whole truth: a locally cached conversation the server did not
  return is removed along with its message log — a rule meant for conversations deleted elsewhere,
  which past 200 conversations quietly applies to the oldest ones on every refresh. Only a
  conversation with turns still waiting to sync survives it.
- **Once a conversation has a local copy, its transcript is never fetched from the server again.**
  Anything added to it elsewhere is invisible here.
- **Reopening a conversation the server has to supply brings back its first 500 messages**, not its
  most recent 500, with nothing saying so.
- **A conversation opened for the first time while the server is unreachable shows an empty
  transcript with no error at all** — indistinguishable from a conversation with nothing in it.
- **Returning to a conversation whose answer is still being written leaves the pane looking idle.**
  The live view belongs to the conversation that was on screen when the turn started; coming back
  shows the transcript as it was, no streaming answer, no *Stop* button, and no way to interrupt the
  run. The answer appears only once it finishes and the conversation is reopened again.
- **The sidebar is refreshed when a turn finishes syncing**, whether or not that conversation is on
  screen — so a title and a relative time settle by themselves once the turn reaches the server.
- **The per-conversation sync dot goes stale.** It is set when the app is told a turn is pending or
  failed, and never updated again while the app runs — so a conversation that later drains
  successfully, or later fails on a retry, keeps whatever mark it had.
- **A new conversation keeps its placeholder title until its first turn reaches the server.** The
  server names a conversation from its first question and only learns that question when the turn
  syncs; the list is re-read the moment it does, so the name appears as soon as the server has one —
  but a conversation whose turns are still queued (offline, or the server down) stays unnamed.
- **Message-text search only covers conversations opened on this machine.** A conversation never
  opened here is findable by title only.
- **Search needs at least two characters**, waits about 120 ms after the last keystroke, requires
  every word to appear in the *same* message, matches raw substrings anywhere inside a word, and
  returns at most 200 conversations. Results are ranked by how many messages matched, never by
  recency.
- **Only the first 20,000 characters of any one message are searchable**, and the excerpt shown is a
  ~144-character window around the first match, clamped to two lines.
- **Reasoning and tool results are not searchable.** Only message prose is indexed — which is what
  keeps the index roughly forty times smaller than the logs, and what stops a search surfacing raw
  tool payloads.
- **A search hit for a conversation the sidebar is not showing is dropped silently** — no row, no
  excerpt, no count.
- **A trace step shows the first 4,000 characters of a tool's result, cut without an ellipsis or any
  other mark.** The one-line summary of a tool's argument is cut at 72 characters and a reasoning
  preview at 80; those two do show an ellipsis.
- **Token counts are abbreviated above 10,000** — `12.3k` rather than the exact figure.
- **The citation panel shows the passage that was cited, and only that.** A citation is the claim
  "this passage supports this sentence", so the passage it names is what the panel shows. The server
  answers a passage id with the whole section around it — one real answer cited a passage of 1,357
  characters that arrived inside 220 passages and 314,000 characters — so the panel picks the cited
  passage out of that and leaves the rest behind *Show surrounding section*.
- **The surrounding section is offered as context, never as evidence.** It is collapsed, counted, and
  labelled as not being part of the cited source, because none of it was in front of the assistant
  when it wrote the claim — it reads sources one passage at a time. Showing it inline would invite
  confirming a claim from text the assistant never read.
- **A passage split across parts is still shown alone.** Such a passage ends mid-content, but the
  assistant that cited it saw it end there too; padding it out with its sibling parts would hide a
  real weakness in the citation rather than reveal one.
- **A document-level citation names no passage**, so the whole section is shown with no context
  control — there is nothing to single out.
- **The panel shows the document title and version**, from the section's own header. It still offers
  no link to the original page, no way to copy the text, and no navigation between citations; the web
  app's panel has the link. Citation markers *inside* the fetched source are left as literal text.
- **Only one- and two-digit reference markers are recognised.** A `[100]` stays literal text.
- **A diagram is not drawn until the answer finishes.** While streaming it is shown as source text.
- **Stopping is not immediate.** The turn ends at the next point the run can be interrupted.
- **The *Playbook required* refusal cannot be dismissed either**, and it says nothing about which
  playbook to pick — it is cleared by picking any one of them, by sending, or by switching
  conversation. Nothing marks the composer as needing a playbook before the first attempt to send:
  the only warning is its placeholder.
- **A playbook recommendation cannot be dismissed.** It is cleared only by sending, by switching
  conversation, or by a newer check — and both of its buttons are disabled while the composer is
  empty. Clearing the composer with a card standing therefore leaves a card that cannot be acted on,
  and the playbook picker stays hidden behind it.
- **The `/` list is about eight rows tall before it scrolls**, against roughly thirty playbooks.
- **Playbook names are what the picker shows.** The server currently gives every playbook a title
  identical to its name, so rows read like `oim-ts-directory-messaging-browsing`. Nothing in the app
  can improve on that.
- **The window will not go below 900×600, the sidebar is a fixed 272 pixels, and the conversation
  column stops widening at 1000** — a wide monitor adds margin, not content.
- **There is no progress estimate and no notification when an answer finishes.** A multi-agent answer
  takes minutes; nothing tells the user when it lands except looking.
- **The empty state names One Identity Manager**, although nothing else in the app assumes any
  particular knowledge base. It is the one place a per-deployment product name is written into the
  client.
- **The app defines no menu of its own, so the platform's stock one ships** — including *Reload*,
  *Force Reload* and *Toggle Developer Tools* in a released build, on their usual shortcuts. Reloading
  mid-answer throws away the live view of a turn that keeps running without it.
- **The app's own keyboard support stops at the composer.** Enter, Shift+Enter,
  Backspace-clears-playbook, Escape and the arrow keys inside the autocomplete are the whole set —
  and Escape there clears the entire draft rather than just closing the list. There is no shortcut for
  new conversation, search, settings, delete or stop.

## Not supported

- **Renaming a conversation.** The app can send a new title and the server accepts one — the whole
  path works — but nothing in the interface ever asks for one. (Note that `yvoke-web`'s specification
  says the desktop app is the *only* place a conversation can be retitled. That is not true of this
  build.)
- Editing or deleting an individual question or answer; regenerating an answer; retrying with a
  different playbook; branching from an earlier point.
- Removing a rating once given. The two thumbs toggle between them; there is no third state.
- Folders, tags, pinning, favourites or archiving. Grouping by age is the only structure.
- Sharing a conversation, or opening one somebody else shared. Both are web-only.
- Non-image file attachments (PDF, DOCX, CSV, audio, etc.).
- Audio and voice input (dictation, recording); speech-to-text; text-to-speech audio playback of answers. (OS-level native keyboard dictation remains supported through standard text input.)
- Exporting or printing a conversation. Copy, one answer at a time and prose only, is the whole of it.
- Jumping from a search result to the message that matched, or searching inside an open conversation.
- Setting the thinking effort for a single message. The contract carries a per-message override, and
  no control anywhere sets it — the selector changes the whole conversation.
- Resizing or collapsing the sidebar; selecting several conversations; deleting in bulk.
- More than one window, or more than one conversation open at once.


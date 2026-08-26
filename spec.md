# Yvoke - Desktop — Functional Specification

> **What this is.** A complete catalogue of what the Yvoke desktop app does today, written for the
> product owner. Every capability it actually has, the rules it follows, the limits people will hit,
> and the things it deliberately does not do.
>
> **What this is not.** Not a design document, not a roadmap, and not a *technical* specification: it
> says what the product does, never how it is built. It describes the app as it exists now, not as it
> should be.
>
> **Who reads it.** Two audiences, both first-class. The product owner, to know what the app does and
> where it stops. And **anyone — person or agent — about to make a substantial change: read this
> chapter before you start.** It is the fastest way to learn what a feature is *for*, which behaviours
> are deliberate, and what the app has decided not to do — none of which is obvious from the code, and
> the last of which is invisible in it. For a small, local fix, go straight to the code and its tests.
>
> **What it is not a substitute for.** The engineering contract — the exact internal behaviour that
> must be preserved — lives in the test suite: `npm test` (Vitest) together with `npm run typecheck`
> is what enforces it. So read this document for *intent*, then read the tests that own the feature
> for the *contract*, and **to change behaviour, change a test.** If no test fails when you break a
> rule, that rule is not enforced — treat it as undocumented rather than assuming it is safe. The
> *Limits* and *Not supported* sections are the exception: they record what the app deliberately does
> **not** do, and an absence is precisely what no test can fail on.
>
> **Its sibling.** `yvoke-web`'s repo-root `spec.md` is the functional specification of the *server*
> and the web client. This app is one of the surfaces that specification's chapter 7 describes. The
> two documents overlap deliberately and must agree; where this one contradicts it, this one is about
> this build and wins. Every rule about *what the assistant knows* — knowledge areas, tags, imports,
> what a playbook contains — lives there, not here. This document owns only what happens on this
> machine.
>
> **Keeping it true.** A change a user would notice must update the affected chapter in the same
> change — a new capability in *What you can do*, a changed rule in *How it behaves*, a raised or
> lowered ceiling in *Limits*, something newly possible struck from *Not supported*. A stale
> specification is worse than none, because agents act on it.
>
> **How to read it.** Eight chapters, one per capability area. Each has the same shape: what the area
> is for, who uses it, **what you can do**, **how it behaves**, **limits**, and **not supported**. The
> last two are the useful ones in a stakeholder conversation — they are where the surprises live.

---

## Contents

| # | Chapter | Mainly for |
| --- | --- | --- |
| — | [What Yvoke - Desktop is](#what-yvoke---desktop-is) · [Words we use](#words-we-use) | read first |
| 1 | [Asking questions](#1-asking-questions) | every user |
| 2 | [How an answer is produced](#2-how-an-answer-is-produced) | every user · knowledge team |
| 3 | [Multi-agent investigations](#3-multi-agent-investigations) | power users · knowledge team |
| 4 | [Where conversations live](#4-where-conversations-live) | every user · support |
| 5 | [Signing in](#5-signing-in) | everyone · IT |
| 6 | [Settings and what they change](#6-settings-and-what-they-change) | power users · IT |
| 7 | [What the app tells the server](#7-what-the-app-tells-the-server) | platform team · product owner |
| 8 | [Installing, updating and diagnosing](#8-installing-updating-and-diagnosing) | IT · support |
| — | [Decisions worth taking](#decisions-worth-taking) | product owner |

---

## What Yvoke - Desktop is

Yvoke - Desktop is a desktop chat client for Yvoke. It asks the same curated knowledge base the web
app does, cites the same passages, and stores its conversations in the same account — but it produces
the answer **on the user's own machine**, using their own Claude subscription.

**The problem it solves.** The web app answers on the server, which means every answer is paid for by
the department and capped by the server's model budget. Consultants who already hold a Claude Pro or
Max subscription can instead spend their own subscription credit on the same corpus, at the depth they
choose — including a multi-agent investigation that would be expensive to offer to everyone. The
conversation still lands in the shared account, so nothing is lost to a private tool.

**Who uses it.** Consultants and support engineers who have both a Claude subscription and a company
account. There are no roles inside the app: everyone who can sign in sees exactly the same thing.
There is no administration surface here at all — curation, imports, cost reporting and feedback
triage are the web app's job.

**The three things it does.**

1. **Answers questions** against the server's knowledge base, citing the passages it used, with the
   whole run — reasoning, every tool call, every result — openable underneath the answer, for as long
   as the conversation is held on this machine.
2. **Runs a team of agents** for a hard question: a lead delegates to specialist playbooks, and a
   reviewer checks the draft against the evidence before it is delivered.
3. **Keeps everything in the account** — conversations, ratings and multi-agent traces are synced to
   the server, where they appear alongside web conversations.

**Three things to understand about its shape**, because they explain most of the rules later on:

- **The answer is produced here, not there.** The model runs in this app, against the user's Claude
  credentials. So the server never sees the answer being written — only the finished text. Closing the
  app loses a running answer, the model's cost appears in no company report, and the app cannot answer
  at all without a working Claude sign-in.
- **Everything the assistant is *told* lives on the server.** The base instructions, every playbook,
  and every multi-agent profile are fetched live over the knowledge-base connection. There is
  deliberately no local copy and no fallback: an unreachable server means the question fails outright,
  rather than being answered by an assistant running on stale or invented instructions.
- **The local disk is a cache, never the record.** Conversations belong to the server. What is kept
  here is a copy for reading offline and searching, plus the model's own session so a follow-up
  question remembers the last one.

---

## Words we use

| Word | What it means | Also called |
| --- | --- | --- |
| **Conversation** | One thread of questions and answers. Created on the server, listed in the sidebar. | "thread" in the code |
| **Playbook** | A named, reusable way of answering a class of question, written by administrators on the server. The user attaches one to a message. | "prompt" / "skill" historically |
| **Base instructions** | The server-managed instructions every answer runs under, on top of which a playbook is layered. | the `default-chat` system prompt |
| **Profile** | A named multi-agent setup on the server: which playbook leads, which reviews, and which specialists are available. | "orchestrator profile" |
| **Lead** | The agent that plans a multi-agent turn, delegates, and writes the final answer. | "orchestrator" |
| **Specialist** | A sub-agent the lead delegates one self-contained sub-question to. | |
| **Reviewer** | A sub-agent that checks the lead's draft against the evidence and returns approve / reject. | |
| **Trace** | The collapsed line under an answer that opens into the run's reasoning and every tool call. | |
| **Turn** | One question and the answer to it, including every tool call in between. | |
| **Thinking level** | How much reasoning the model is allowed to spend: off, low, medium or high. | "effort" |
| **Knowledge-base tools** | The searching and browsing tools the server exposes; the only way the assistant reaches the corpus. | the `yvoke` MCP tools |
| **Sync queue** | The on-disk list of finished turns not yet accepted by the server. | |
| **Session** | The model's own memory of a conversation, held by the Claude tooling on this machine. | "resume" |

---

## 1. Asking questions

**What it is for.** The chat window: where a question is typed, an answer arrives with the sources
behind it, and the work that produced it can be opened and read.

**Who uses it.** Everyone who installs the app. There are no roles and no administrator view.

### What you can do

| Capability | What happens |
| --- | --- |
| **Start a conversation** | *New* creates the conversation on the server and opens it empty. The server names it; the app never invents a title. |
| **Pick a playbook** | An empty conversation opens on a picker listing every playbook the user may choose, filterable by title, name or description. In a conversation that already has messages, typing `/` opens the same list as an autocomplete — which filters on title and name only. Prototype playbooks (`prototype: true`) are hidden by default unless enabled in Settings. A single-agent question needs one: sending without it raises *Playbook required* and nothing is asked. |
| **Ask by typing** | The composer starts three rows high and grows with the text to a maximum of nine. Enter sends, Shift+Enter adds a line. Backspace on an empty composer removes the attached playbook. |
| **Watch the answer being written** | Text and reasoning stream in as they are produced. Until the first of either arrives, the answer shows *Working…*. |
| **Read a formatted answer** | Headings, tables, code blocks, mathematical formulas and drawn diagrams all render. While the answer is still streaming a diagram shows as its source text and is drawn once the answer finishes. |
| **Open the source behind a citation** | A source marker in the answer is a clickable pill; clicking it opens a *Citation source* panel containing the cited passage, fetched live from the server, with the section around it one click away. |
| **See how the answer was produced** | One *Trace* line under every answer that had anything to show — *N steps · N tools · N corpus searches · N failed* plus the turn's token counts. Opening it lists every stretch of reasoning and every tool call in order; opening a step shows its arguments and its result. |
| **Answer a clarifying question** | When the assistant needs more information a *Clarification required* card appears with the question, any ready-made options, and a free-text box. The composer is locked until it is answered, after which the card becomes *Clarification provided* with the answer. |
| **Get a playbook check before sending** | A message that carries a playbook is checked first: a *Playbook recommendation* card explains why another playbook fits better and offers **Switch to …** or **Send anyway**. |
| **Stop a running answer** | The send button becomes *Stop* while a turn runs. Stopping ends the turn and shows *Processing stopped.* |
| **Rate an answer** | Thumbs up or thumbs down on every answer. Thumbs up may carry a comment; thumbs down **requires** one. |
| **Copy an answer** | A copy button on every answer copies the answer prose — not the reasoning, the tool calls or the trace. |
| **Choose model, thinking effort and agent mode per conversation** | Three selectors sit beside the composer. Each conversation keeps its own choices; new ones start from the defaults in Settings. |
| **Search conversations** | The sidebar search matches conversation titles *and* the text of messages, showing the matching excerpt with the terms highlighted under the row. |
| **Browse by age** | Conversations are grouped *Today · This Week · Last Week · Earlier*, newest first, each row carrying a relative time that loses precision as it ages — *just now*, *12m ago*, *3h ago*, *Yesterday 14:22*, a weekday, then a date. Only the newest group is open to begin with; a section the reader opens or shuts stays that way. Weeks break where the reader's locale says they do. |
| **Delete a conversation** | Confirmed, then permanent — on the server as well as here. |
| **Change how the app looks** | Light / dark / follow-the-system theme, comfortable or compact rows, three answer text sizes, and whether the trace starts open. |

### How it behaves

- **Prototype playbooks are hidden by default.** Playbooks flagged with `prototype: true` on the server are
  excluded from the picker, slash autocomplete, and preflight recommendations unless *Show prototype playbooks*
  is enabled in Settings > Agents.
- **A playbook is required for a single-agent question**, as it is on the web: a playbook is what
  scopes the answer, so a message carrying none is refused with a *Playbook required* card and the
  draft is kept. The refusal stands until a playbook is picked. Two cases are not gated, because in
  both the error would be one the user could not act on: a multi-agent conversation, which takes its
  playbooks from the profile, and a server that offers no playbooks at all, where the question is
  sent as it was and the assistant gets the default knowledge-base tool set.
- **A playbook attaches to one message, not to the conversation.** It is cleared the moment the
  message is sent, so every question in a thread can carry a different one — but each has to carry
  one. On the web a playbook is sticky for the whole conversation. This is why the desktop checks
  **every** playbook-carrying message rather than only the first.
- **Only the answer's prose is the answer.** Reasoning and tool calls live in the trace *below* it,
  collapsed to a single line by default, because process is evidence rather than content. Two things
  stay inline instead: a clarifying question, which the user has to act on, and a delegation to a
  specialist, which in a multi-agent turn is the substance of the run.
- **No trace line means there was nothing to show**, not that it is collapsed. A turn that called no
  tool and did no visible reasoning has no bar at all, and its token counts move into the footer.
- **A question is displayed exactly as typed.** Only answers are rendered as formatted text; a
  question containing code, markdown or a citation-shaped token appears verbatim.
- **A turn that fails is discarded — and takes its question with it.** Only a turn that ends without
  an error is written to the conversation and queued for the server, and the question is written in
  the same act. So a failed turn leaves no record of having been asked. The question stays on screen
  until the conversation is reopened, which is the only sign that anything was lost. Reaching the
  turn ceiling counts as a failure, so a long investigation that runs out of steps loses everything.
- **Stopping is the same act, for the same reason.** Stopping produces an error result, so the partial
  answer and the question are both discarded. The web app keeps a stopped answer; this one does not.
- **Failures are shown in full, and sometimes only as a code.** Where the web app shows one generic
  notice, the desktop shows the underlying message — including the sign-in instructions when the
  cause is a missing Claude login. A failure the model service reports without a message shows as its
  bare outcome name, such as `error_max_turns`.
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

### Limits

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

### Not supported

- **Renaming a conversation.** The app can send a new title and the server accepts one — the whole
  path works — but nothing in the interface ever asks for one. (Note that `yvoke-web`'s specification
  says the desktop app is the *only* place a conversation can be retitled. That is not true of this
  build.)
- Editing or deleting an individual question or answer; regenerating an answer; retrying with a
  different playbook; branching from an earlier point.
- Removing a rating once given. The two thumbs toggle between them; there is no third state.
- Folders, tags, pinning, favourites or archiving. Grouping by age is the only structure.
- Sharing a conversation, or opening one somebody else shared. Both are web-only.
- Attaching a file, image or screenshot to a question.
- Exporting or printing a conversation. Copy, one answer at a time and prose only, is the whole of it.
- Jumping from a search result to the message that matched, or searching inside an open conversation.
- Setting the thinking effort for a single message. The contract carries a per-message override, and
  no control anywhere sets it — the selector changes the whole conversation.
- Resizing or collapsing the sidebar; selecting several conversations; deleting in bulk.
- More than one window, or more than one conversation open at once.

---

## 2. How an answer is produced

**What it is for.** The local agent loop: what the assistant is told, what it is allowed to do, and
what happens between the question and the answer.

**Who uses it.** Everyone who asks a question. The knowledge team owns what it is told, from the
server.

### What you can do

| Capability | What happens |
| --- | --- |
| **Every answer is grounded in a live search** | The assistant answers from what the server's knowledge-base tools return, under the server's own grounding and citation instructions. It has no other source. |
| **A toolbox, not a search box** | The assistant can search the corpus, list an area's documents, read a table of contents, read a whole section, look a thing up in the knowledge graph and follow its connections, query structured records, read their declared shape, and check its own citations. Nine of these are granted by default. |
| **Playbooks scope the run** | A playbook adds its instructions on top of the base instructions and narrows the assistant to the tools it declares. Its text never appears in the conversation — only its name is stored. |
| **Playbook preflight** | Before a playbook-carrying message runs, a tool-free model call is asked whether that playbook suits the question, and offers a better match if not. |
| **Arithmetic without a shell** | Three in-app tools — a calculator, a summary-statistics tool and a date-difference tool — let the assistant do numeric work. They run inside the app with no shell, no file access and no network. |
| **Domain-restricted web search** | When an operator enables it and lists domains, the assistant may search the web — but only within those domains. |
| **It can ask instead of guessing** | The assistant can pause and ask the user a question, with or without ready-made options, and continue from the answer. |
| **Choose how hard it thinks** | Four thinking levels per conversation. |
| **Follow-ups remember the conversation** | The model keeps its own memory of a conversation between questions, so a follow-up does not restate what came before. |

### How it behaves

- **The model runs on this machine, on the user's own Claude subscription.** The app never handles
  those credentials: it picks up whatever the Claude tooling on the machine has already signed in, and
  removes any pay-per-token API key from the environment the model runs in, so an inherited one cannot
  silently move the billing off the subscription.
- **The base instructions come from the server, on every new session, with no fallback and no cache.**
  They carry the grounding rules, the citation contract and the formatting the answer renderer
  expects. If they cannot be fetched — or come back empty — the question fails and says so. A
  hard-coded copy would drift from the server's and quietly contradict the playbooks; running with
  none at all is worse still.
- **Deny by default.** The assistant is granted the knowledge-base tools, a tool-discovery helper, the
  three compute tools and (when enabled) web search. Every other tool the runtime knows about is
  refused the moment it is called, with a message telling the assistant to use the knowledge-base
  tools instead.
- **The shell is blocked outright**, so it is never even offered — absent rather than withheld by a
  policy that could be misconfigured. This is what makes it safe for the assistant to read a corpus
  that anybody could have written into.
- **A playbook's tool list replaces the default one, and three things are added regardless.** Declare
  tools and the assistant gets exactly those; declare none and it gets the nine defaults. Either way
  the tool-discovery helper, the compute tools and — when the setting is on — web search are appended.
  A playbook cannot opt out of any of the three, except by declaring that it may not compute.
- **A playbook can withhold computation.** A playbook that declares no code execution loses the compute
  tools, checked in two independent places. A playbook that declares nothing at all keeps them: the
  grant is opt-out, not opt-in.
- **Tool names in playbooks are re-namespaced, not matched.** A playbook written when the connection
  had a different name still works; its tool names are rewritten to the current one rather than tested
  against it.
- **Web search is force-restricted, not asked to restrict itself.** Whatever domains the model asks for
  are replaced by the configured list before the search runs, and the list is re-read on every call —
  so a change in Settings takes effect immediately. Switched on with no domains listed, every search
  is refused rather than run against the open web.
- **A failing tool does not fail the answer.** The failure is handed back to the assistant as that
  tool's result and shown as a failed step in the trace; the run continues.
- **A clarifying question reaches the model as a refused tool call** whose message reads *User
  answered: …*. Stopping a turn resolves any question still waiting with an empty answer rather than
  leaving the run hanging.
- **Changing the playbook or the agent mode restarts the assistant's session** so the new tool
  allow-list and instructions take effect. The conversation's memory is resumed, so nothing the user
  can see is lost — but because a playbook clears on every send, two consecutive questions under
  different playbooks rebuild the session twice, and each rebuild re-fetches the base instructions
  from the server.
- **Nothing from the user's own Claude tooling configures this app.** Personal settings, project
  settings and instruction files are all excluded; the assistant's behaviour comes from the server's
  instructions plus the selected playbook. The environment the model runs in *is* inherited, so
  variables a developer exported still reach it.
- **Citation markers are rewritten after the answer is parsed, not before.** A real link like
  `[2](https://example.com)`, and a bracketed index inside a code block, are therefore left alone —
  both were corrupted when the rewrite worked on the raw text.
- **A second message while a turn is running is refused.** The composer normally prevents it; the
  refusal surfaces only when something else drives the app.

### Limits

- **25 turns per question as shipped.** That is the ceiling on how many times the assistant may act
  before it must answer — and reaching it ends the turn as a *failure*, so the work and the question
  are both discarded rather than delivered with a warning. The web app instead delivers what it has.
  Setting the ceiling to zero removes it entirely, because the runtime drops the value rather than
  honouring it.
- **Four thinking levels, with fixed budgets** — off spends none, and low, medium and high spend
  roughly 4,000, 10,000 and 32,000 tokens of reasoning. There is nothing between them, and the test
  suite pins only that *off* is zero and that the four ascend.
- **The reported reasoning-token figure is always zero.** The app reads a figure the runtime does not
  publish under that name, so every answer reports no thinking tokens however hard it thought.
  Cache-write tokens are recorded but shown nowhere.
- **The playbook check gets 45 seconds and exactly one model turn**, with no tools, no reasoning and no
  knowledge base, on the conversation's own model — it is a real, billed call, not a cheap classifier.
  It re-sends the entire playbook catalogue as its instructions every time. It cannot be cancelled:
  while it runs there is no *Stop*, only a disabled composer.
- **Changing the model while the check runs is allowed**, so the verdict can come from one model and
  the turn run on another.
- **The check is skipped when there is nothing to compare against** — fewer than two playbooks offered,
  an unreachable server, a playbook the picker does not list, or a multi-agent conversation.
- **A playbook whose constraints cannot be resolved runs with the full default tool set and no
  code-execution restriction.** Nothing is logged when the playbook is simply absent from the server's
  list, and nothing is shown either way — a playbook that meant to narrow the assistant silently
  widens it.
- **Declaring `ask_clarifying_question` in a playbook switches clarifying questions off.** Naming the
  tool pre-approves it, and pre-approval bypasses the only place the question is intercepted and shown
  to the user — so under such a playbook the assistant asks and nobody is ever asked.
- **The playbook list is cached for a minute and has no stale fallback.** A playbook added on the
  server can take that long to appear, and a request that fails takes the whole call down with it.
- **A hung server costs about 24 seconds, not 12.** Each request has a 12-second ceiling and is retried
  once on a fresh connection; establishing that connection has no ceiling of its own.
- **Three conversations stay warm, softly.** Sending in a fourth closes the least recently used *idle*
  one — but if all three are mid-answer, nothing is evicted and a fourth session starts anyway.
- **A turn that crashes leaves its runtime process behind.** The session is dropped without being shut
  down; only a clean close reclaims it.
- **The calculator is arithmetic only** — a fixed list of functions and constants, expressions up to
  1,000 characters, no variables. Note that `log` is base ten and `ln` is the natural logarithm, which
  is the opposite of the convention most programming languages use, and nothing in the tool's own
  description disambiguates them.
- **The statistics tool reports the *sample* variance and standard deviation** (dividing by n−1), and
  reports neither for a single value. Date differences are signed and fractional, never rounded.
- **Nothing checks that a cited passage supports the sentence it is attached to.** The citation check
  the assistant can run confirms a source exists; it never reads it.
- **Nothing here is rate-limited, and nothing warns when the subscription's allowance runs out.** The
  web app caps a user at twenty questions a minute; this app caps nothing, and every knowledge-base
  search it runs costs the server money. The runtime does report when the subscription is being
  throttled; the app does not read it.
- **The user never picks the knowledge area or the version.** The playbook decides, exactly as on the
  web. Asking about a different product version means picking a different playbook.

### Not supported

- Running code, opening a shell, or reading files on the machine. There is no path to any of them.
- Answering without the server. The knowledge base, the playbooks and the base instructions are all
  remote, so an offline app can read old conversations but cannot answer a new question.
- Answering without a Claude sign-in. The app cannot sign in for you; it can only tell you to.
- Choosing a model per message, or any model other than those listed in Settings.
- Editing playbooks or base instructions from the app. Both are server-managed and read-only here.
- Cancelling a playbook check once it has started.
- Automatically retrying a failed turn, or falling back to another model or service when one is busy.
- Any cost figure. The runtime reports what a turn cost and the app forwards it to the interface,
  where nothing displays it.

---

## 3. Multi-agent investigations

**What it is for.** A hard question answered by a team rather than one agent: a lead breaks it up,
specialists research the parts, and a reviewer checks the draft against what they found before the
user sees it.

**Who uses it.** Anyone, on a conversation where they choose a profile — but it costs several times a
normal answer and takes minutes, so it is for questions worth that. The knowledge team owns the
profiles and the playbooks; there is no way to build one from the app.

### What you can do

| Capability | What happens |
| --- | --- |
| **Switch a conversation to a profile** | A selector beside the composer offers *Single agent* plus every profile the server defines. Choosing one takes over the conversation. |
| **Ask once, get one answer** | The lead plans the turn, delegates self-contained sub-questions to specialists, and composes a single cited answer from what they bring back. |
| **See the team's work** | Each delegation is its own card: which specialist was consulted, the sub-question it was given, the tools it called inside its own turn, and the answer it returned. |
| **See the reviewer's verdict** | The reviewer's card carries an *Approved* or *Rejected* badge and its notes. |
| **See when an answer did not pass** | An answer delivered without approval carries a banner saying which of the three happened — *delivered without review*, *no clear verdict*, or *rejected* — with the reviewer's notes beneath it, and the same warning is written into the answer text itself. |
| **Bind a model to each role** | Settings sets the model and thinking level for lead, reviewer and specialist separately, and shows the worst-case number of model calls one turn can make. |
| **Set the budgets** | How many revision rounds a rejection may drive, how many specialist calls a question should spend, and a ceiling on the lead's and each specialist's own loop. |
| **Turn code-enforced review off** | A switch leaves review entirely to the lead's own playbook instead of the runtime insisting on it. |
| **Have the run recorded centrally** | A completed multi-agent turn is uploaded to the server step by step — role, round, playbook, model, instructions, output, verdict and token counts — and appears in the web app's trace viewer beside the runs the web itself performed. |
| **Still run a specialist on its own** | Specialist playbooks stay pickable in ordinary single-agent chat. Only the lead's and the reviewer's playbooks are hidden from the picker. |

### How it behaves

- **Choosing a profile takes over the conversation.** The playbook picker, the model selector and the
  thinking selector all disappear, because the profile and Settings decide them. A message sent in a
  multi-agent conversation carries no playbook and is not preflighted.
- **The lead never touches the knowledge base.** It can delegate and it can ask the user a clarifying
  question; everything else is somebody else's job.
- **The lead and the specialists run under the base instructions; the reviewer does not.** The lead
  writes the user-facing answer, so it needs the citation and formatting contract exactly as the
  specialists do. The reviewer emits a plain verdict rather than prose, so those rules would be noise
  in its context. The playbook is layered last, so a role's own rules win any conflict.
- **The reviewer sees only what the lead pastes.** It is given the original question, the candidate
  answer, and the specialists' answers verbatim; it may re-check that the cited ids are real, and
  nothing else. It cannot search, and it can no longer open a section either — that returned the
  whole section around a passage, which let it judge a claim against neighbouring text no specialist
  ever retrieved. What it is entitled to see is already in front of it, so a claim the evidence does
  not settle is a finding to report rather than a reason to go looking. That is what makes each
  citation testable as the claim it is.
- **The lead checks its own citations before delivering.** An invented id is the one citation fault a
  machine can settle on its own, so the lead verifies every id it is about to write rather than
  spending a whole review round learning the same thing. This says nothing about whether a real
  source supports the claim it sits on — that stays the reviewer's job.
- **Review is enforced in code, not requested in a prompt.** A turn that consulted specialists but
  never called the reviewer is re-prompted once to run one. A turn the reviewer rejected — or on which
  it returned no readable verdict — is handed the feedback *and* the evidence again and asked to
  revise, up to the configured number of rounds. Both were observed being ignored when they were only
  asked for.
- **A held-back draft is discarded from the answer, not from the record.** The prose written so far is
  dropped so the delivered answer is the corrected one rather than draft-plus-final — but the draft is
  still readable inside the reviewer's card, because the lead had to paste it there, and it is in the
  uploaded trace.
- **Out of rounds, the answer ships flagged.** The warning goes into the answer's own text, not only
  into the on-screen badge — that is what gets synced to the server and what the copy button copies.
- **The last verdict is the verdict.** A turn rejected and then approved on the next round reads as
  approved.
- **Only what follows the verdict line is carried back as feedback.** When the verdict is buried in a
  longer reply, the reviewer's own thinking-aloud above it is dropped rather than replayed to the lead
  as objections to address.
- **A specialist's own output never reaches the answer.** Its text, reasoning and tool calls are
  attributed to its delegation card; nothing it says can leak into the composed answer.
- **An interrupted or failed turn is left alone.** Neither is re-prompted for review: there is no
  composed answer worth reviewing, and re-prompting a stopped turn would fight the user's Stop.
- **A lead that answers without consulting anyone is not a multi-agent turn at all.** No review is
  demanded, no banner appears, and no trace is recorded.
- **The trace is uploaded only once the answer has synced**, because it has to name the message it
  belongs to. Until then it is held in memory, and the upload itself is best-effort.

### Limits

- **A multi-agent answer takes minutes and costs several times a normal one.** On the shipped defaults
  the settings panel's own worst-case figure is **30 model calls** for a single question — three lead
  passes, three reviews and twenty-four specialist calls — each on the model bound to its role. Do not
  offer it as a free quality upgrade.
- **A reviewer that says "NOT APPROVED" is read as approved.** When no line is exactly the verdict, the
  fallback accepts any reply containing the word *APPROVED* and not the word *REJECTED* — so a
  negative phrased around the positive word passes.
- **Verdicts and specialist results appear only when the whole turn ends.** While the run is live the
  cards show that a delegation is in flight and nothing more; the tick, the cross and the *Approved* /
  *Rejected* badge all arrive at the end.
- **The specialist budget is advisory.** The lead is *told* how many specialist calls to aim for; no
  code counts them or stops it. Only the lead's own turn ceiling — 60 as shipped — actually bounds the
  run.
- **The reviewer has no ceiling of its own.** It runs under the specialists' turn limit, 20 as shipped.
- **Review enforcement happens at most once per turn.** A lead that ends a second time without a
  reviewer ships unreviewed, with the banner saying so.
- **Two revision rounds by default**, counted as revisions rather than reviews: a first-pass approval
  is zero rounds, and the default allows a draft plus two corrections.
- **A revision notice re-sends every previous round's evidence.** Each specialist's answer is capped at
  12,000 characters, but nothing caps how many are included, and every non-failed delegation from every
  earlier round is included again — so at the shipped budget one revision can carry roughly a hundred
  thousand characters, and the next carries them again.
- **A specialist whose call failed is omitted from that evidence entirely**, so the reviewer is not
  told that part of the investigation is missing.
- **Setting a role's thinking to *off* does not switch thinking off** for specialists or the reviewer —
  their effort floor is *low*. The lead is worse: its budget says zero while its effort setting says
  low, and the two disagree.
- **Changing anything in Settings → Agents does not reach a conversation that already has a warm
  session.** Role models, thinking levels, specialist tool sets and both turn ceilings are bound when
  the session starts. Changing the profile, an eviction, a failed turn or a restart is what picks them
  up.
- **The uploaded trace has no size limit.** Each step carries that sub-agent's whole transcript
  including every tool result verbatim — full corpus-search payloads — with none of the truncation
  applied to revision evidence. The upload is fire-and-forget: a failure is logged and nothing else.
- **The trace names the reviewer's playbook as "reviewer"** rather than the profile's actual reviewer
  playbook, so the web app's trace viewer cannot tell which one ran.
- **A run whose answer the server rejects loses its trace silently**, and at most fifty pending traces
  are held before the oldest are dropped.
- **A specialist that asks a clarifying question locks the composer with no question on screen.** The
  interface reports *Awaiting clarification…* and shows nothing to answer, because a sub-agent's
  question is never rendered.
- **Every multi-agent session costs a burst of server round-trips before the first model call** — the
  base instructions plus the full text of the lead's, the reviewer's and every specialist's playbook,
  none of which is cached. Any one of them failing fails the turn.
- **Profiles are cached for a minute, and an unreachable server yields the last list or none at all** —
  in which case the selector disappears entirely. A conversation set to a profile the server no longer
  offers fails its next turn, saying the profile is unavailable.
- **Cost is not reported anywhere the company can see it.** The model calls are billed to the user's
  Claude subscription; the trace records token counts, but no money.
- **The code's own fallback and the shipped configuration disagree** about the specialist's thinking
  level — medium in one, high in the other. Which one applies depends on whether the deployment's
  settings file reached the machine.

### Not supported

- Choosing which specialists run, or intervening once a run has started.
- A reviewer that can search the knowledge base for itself.
- Nested delegation. A specialist that delegates further produces no card, no result and no trace step
  — the whole sub-run vanishes from the record.
- Creating, editing or importing a profile from the app.
- Multi-agent mode without a server-defined profile. Where none exists, the selector does not appear.
- A playbook on a multi-agent message. The profile decides every prompt in the run.
- Reading a past run's specialist and reviewer cards after the conversation has been restored from the
  server. That detail lives only in the uploaded trace, which the app never reads back.

---

## 4. Where conversations live

**What it is for.** Conversations belong to the server, under the signed-in identity. This chapter is
what the app keeps on the machine, when it talks to the server, and what happens when it cannot.

**Who uses it.** Every user, usually without noticing — until they open the app on a second machine,
or lose the network mid-conversation.

### What you can do

| Capability | What happens |
| --- | --- |
| **Keep every conversation in the account** | Creating, changing settings and deleting all happen on the server; the local copy follows. Conversations appear in the web app's sidebar marked as coming from the desktop. |
| **Read old conversations offline** | Everything opened on this machine is cached, so the sidebar and the transcripts still work with no network. A banner says the server is unreachable. |
| **Pick a conversation up on another machine** | Opening a conversation with no local copy pulls its messages back from the server and caches them. |
| **Keep asking while sync is down** | A finished turn is written locally and queued. The queue survives restarts and keeps retrying; a banner counts what is waiting. |
| **Search what was said, locally** | The sidebar's search runs entirely against the local index; no query and no text ever leaves the machine. |
| **Delete a conversation everywhere** | Deleting removes it from the server, from the local cache, from the message log and from the search index. |

### How it behaves

- **The server is the record; the disk is a cache.** What is kept locally is the conversation list,
  one message log per conversation, the search index, the sync queue, the encrypted sign-in token, and
  a working directory the assistant is pointed at.
- **A turn is written locally first, then queued.** The local write is best-effort and never delays
  the answer; the queued copy is what guarantees delivery.
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

### Limits

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

### Not supported

- Asking a question offline. Reading works; answering does not.
- Exporting, backing up or importing the local cache.
- Any retention policy. Nothing local is ever aged out or deleted automatically.
- Choosing where the cache lives, or clearing it from inside the app.
- Merging or de-duplicating conversations, on either side.
- Transferring a conversation to another person.

---

## 5. Signing in

**What it is for.** Two separate sign-ins, paying for two separate things. Neither substitutes for the
other, and the app is useless without both.

**Who uses it.** Every user once, and IT when a deployment's identity registration changes.

### What you can do

| Capability | What happens |
| --- | --- |
| **Sign in to Claude** | Not in this app. The app picks up whatever the Claude tooling on the machine has already signed in. When nothing is found, a banner explains how to sign in from a terminal and offers a *Retry*. |
| **Sign in to the server** | *Sign in* opens the corporate sign-in in the system browser and returns to the app when it completes. The browser page says so and can be closed. |
| **See who is signed in** | The sidebar footer shows the Claude account when the tooling has recorded one, otherwise the corporate account, and always which mode the server sign-in is in. The About pane spells out both. |
| **Sign out of the server** | Only shown when actually signed in with a corporate account. |
| **Use a development token instead** | A setting sends a fixed token rather than a corporate one, for use against a server running with mock security. |

### How it behaves

| Sign-in | What it pays for or grants | How it works |
| --- | --- | --- |
| **Claude** (Pro/Max subscription) | The model — every answer, every specialist, every review. Drawn from the subscription's agent allowance, separate from other Claude apps. | Picked up from the machine's existing Claude credentials. The app never sees, stores or transmits them. |
| **Server** (corporate account) | The knowledge base, the playbooks, the base instructions, the profiles, and conversation storage. | Corporate sign-in in the system browser; the resulting token authenticates both the knowledge-base connection and the conversation API. |

- **A pay-per-token API key in the environment is removed** before the model runs, so an inherited one
  cannot silently move billing off the subscription.
- **An unconfigured build defaults to corporate sign-in**, never to the development token — the
  default fails closed rather than quietly sending a token that grants nothing.
- **The same token goes to both server endpoints.** The knowledge-base connection and the conversation
  API authenticate identically.
- **An expired session re-authenticates by itself.** A silent refresh is tried first; if that fails for
  any reason other than the network, the corporate sign-in opens automatically. A network failure is
  reported as a network failure rather than being mistaken for an expired session.
- **Any server call refused as unauthorised is retried exactly once**, with a forced interactive
  sign-in.
- **The token cache is encrypted with the operating system's keystore** where one is available.
- **The server address must be secure.** Anything other than `https` is refused when a user saves it,
  with plain `http` allowed only for a local address.

### Limits

- **"Signed in" only means an account was found in the cache.** No token is tried until the first
  server call, so a session whose refresh expired months ago still shows the account name as signed in
  until something fails.
- **Not being signed in is reported as "Server unreachable — showing cached conversations."** The
  banner names the wrong cause, and the fix it implies is the wrong fix.
- **"Claude is connected" is not a credential check.** A stored credential file is enough, and its
  validity is never tested; on macOS, where the credentials may be in the keychain, the app treats
  *inconclusive* as *fine*. The About pane says "Detected from Claude Code" whenever the check was not
  conclusively negative — including when no account was found at all.
- **A corporate sign-in that fails or is cancelled in the browser produces no message.**
- **Where the operating system offers no keystore, there is no token cache at all.** The corporate
  sign-in then has to be repeated on every launch, and the only record of why is a startup line the
  user cannot reach.
- **A token cache that cannot be decrypted is treated as absent, silently.** This is exactly what a
  changed or regenerated code-signing identity produces, so an otherwise routine build change presents
  as "everyone has to sign in again" with no explanation anywhere.
- **One account at a time, of each kind.** No account switcher, no second profile.
- **Signing out clears the cached account and nothing else.** Nothing is revoked on the server, no
  browser session is cleared, and every cached conversation stays readable on the machine.
- **Changing the identity registration drops the in-memory account but leaves the encrypted cache on
  disk**, and the sign-in indicator does not refresh until something asks for a token.
- **The development token is an ordinary setting, not a build flag.** Any user can switch to it. It
  grants nothing against a real server, so the effect is that everything stops working rather than
  that anything is exposed — but the switch is one click away, and dev mode always reports itself as
  signed in.
- **There is no app lock and no re-authentication on wake.** Anyone with the unlocked machine has the
  app.
- **The app cannot sign anybody into Claude.** It can only detect, and explain.
- **Nothing warns when the subscription's allowance runs out.** That surfaces as a failed turn carrying
  the provider's own message.

### Not supported

- Signing in to Claude with an API key or a token pasted into the app.
- Any role or permission inside the app. Everyone who can sign in has the same access, and the
  server's administrator screens are not reachable from here.
- Per-conversation identity, or asking as somebody else.
- Restricting a user to particular knowledge areas from the app. Access control is the sign-in.

---

## 6. Settings and what they change

**What it is for.** Everything the app can be told, in one panel. There is no separate administrator
configuration: whatever ships as the build's defaults, the user can change.

**Who uses it.** Power users and whoever prepares the build. Most users never open it.

### What you can do

| Pane | What it sets |
| --- | --- |
| **Server** | The server address, which knowledge-base transport to use, and whether the server sign-in is corporate or a development token. |
| **Models** | Which models the composer offers, which one new conversations start on, the default thinking level, and the ceiling on how many times the assistant may act per question. |
| **Agents** | Whether a playbook-carrying message is preflighted; whether to show prototype playbooks in the playbook picker and slash menu; and for multi-agent mode, the model and thinking level per role, the revision-round and specialist-call budgets, the per-agent turn ceilings, and whether review is enforced in code. It also shows the worst-case number of model calls one turn can make. |
| **Web search** | Whether the assistant may search the web at all, and the exact list of domains it may search. |
| **Appearance** | Theme, interface density, answer text size, and whether a finished answer's trace starts open. |
| **Advanced** | The corporate identity registration — tenant, client and scope. Replaced by a note when the server sign-in is set to the development token. |
| **About** | Version, server address, both sign-in states. |

### How it behaves

- **The app validates its own settings, not the panel.** The panel sends the whole draft and the app
  keeps only the keys it recognises, so nothing else can be injected. A rejected save keeps the panel
  open with the reason on it rather than failing quietly.
- **Saving reconnects the knowledge base and re-applies the theme**, whatever was changed — even the
  text size.
- **Model and thinking changes apply to new turns and new conversations.** Existing conversations keep
  the choice they were given, changeable in the composer.
- **Removing a model re-points the default** rather than leaving it pointing at something that is gone.
- **Web search ships off with an empty domain list.** Which domains are worth searching belongs to
  whichever knowledge base is loaded, so it is a per-deployment decision rather than a product one —
  and enabling the feature means listing domains in the same act, because it refuses to run otherwise.
  The domain list is the one setting that reaches a running conversation immediately.
- **The theme's *System* setting stays live.** It keeps following the operating system for as long as
  the window is open — including a scheduled evening switch — and takes the native window frame with
  it.
- **Reduced motion follows the system**, with no control of its own.

### Limits

- **The first Save freezes the deployment's defaults.** The build's own settings file is only a
  starting point; saving writes the *whole* resolved configuration into the user's profile, where it
  shadows that file from then on. A later release that changes a default — a new server address, a new
  model list, a different agent budget — reaches nobody who has ever pressed Save.
- **Settings do not reach a conversation that already has a live session.** The server address, the
  transport and the turn ceiling are read when a conversation's session starts. A failed turn, a
  playbook change, an eviction or a restart is what picks up the new values.
- **Only the server address is checked at all.** Every other value — the sign-in mode, the three
  identity strings, the model list, the turn ceiling, every agent budget, every appearance field — is
  written to disk and used exactly as given.
- **And the server address is only checked when a user saves it.** A value that arrives from the
  build's own file, or from a hand-edited profile, is used unvalidated — so an insecure address from
  either source will carry the corporate token in the clear.
- **An empty server address is accepted without complaint**, which disables everything with no
  explanation.
- **Choosing the older knowledge-base transport does not survive a restart.** It is accepted, saved and
  used for the rest of the session, then silently rewritten to the current one at the next launch.
- **Setting the turn ceiling to zero removes the ceiling** rather than setting it to nothing, because
  the runtime drops the value instead of honouring it.
- **The specialist-call budget is not enforced** — see chapter 3. It reaches the lead as an instruction,
  not a limit.
- **Edits are discarded without warning.** Clicking the settings button a second time, or any
  conversation in the sidebar, throws away every pending change across every pane with no prompt.
- **Nothing here can be locked down.** There is no managed-policy channel, no read-only setting and no
  way for IT to pin the server address, forbid the development token, or fix the model list.
- **There is no reset, no export and no import.** A settings file gone wrong is repaired by editing it
  on disk or reinstalling.
- **Nothing validates the identity registration or the model names.** A wrong tenant, client id or
  model saves cleanly and fails later — at the next sign-in, or when a question is asked.

### Not supported

- A managed or enterprise configuration channel.
- Per-conversation overrides for anything other than model, thinking level and agent mode.
- Any setting that changes what the assistant *knows*. Knowledge areas, versions, playbooks and base
  instructions are all server-side.
- Turning off local caching, or choosing where it lives.
- An unsaved-changes prompt.

---

## 7. What the app tells the server

**What it is for.** The contract between this app and Yvoke's server: what it reads, what it writes,
and what therefore shows up in the web app's screens.

**Who uses it.** The platform team, and the product owner deciding what the company can see about
desktop usage.

### What you can do

| Capability | What happens |
| --- | --- |
| **Read the knowledge base** | Every search, listing, table of contents, section read, graph lookup, record query and citation check goes to the server's knowledge-base connection, authenticated as the signed-in user. |
| **Read the configuration** | The base instructions, the whole playbook library and every multi-agent profile are fetched live over the same connection. |
| **Write conversations** | Conversations are created, retitled, re-settinged and deleted through the conversation API, and each finished turn is appended to it. |
| **Write ratings** | A thumb and its comment are stored against the server's id for that answer, so they appear in the web app's feedback screens and counts. |
| **Write multi-agent traces** | A completed multi-agent turn is uploaded step by step and appears in the web app's trace viewer alongside runs the web performed. |
| **Mark itself as the desktop** | Conversations are created labelled as coming from the desktop, which is what lets the web sidebar and the admin conversation register tell them apart. |
| **Share a conversation's settings with the web** | The model, the thinking level and the selected profile are written into the conversation's settings under the keys the web app uses, so the two surfaces see the same choices. |

### How it behaves

- **The app only ever reads the corpus.** Nothing reachable from here can import, edit or delete
  knowledge-base content.
- **Configuration changes reach the app without a release.** A playbook, base-instruction or profile
  edited on the server is picked up within about a minute — the same library the web app and connected
  AI clients read.
- **An answer is stored as one text field with markers in it.** Reasoning and the name and arguments of
  each tool call are folded into the stored text so a desktop conversation can be read in the web app.
  A multi-agent turn instead stores the composed answer and the lead's reasoning, with its team's work
  going to the trace.
- **A rating is refused rather than queued** when the answer has not yet been accepted by the server —
  there is no id to attach it to.

### Limits

- **The company cannot see what a desktop answer cost.** The model calls are billed to the user's own
  Claude subscription, so only the knowledge-base searches the app makes appear in the server's spend
  reporting. A desktop conversation therefore looks far cheaper than it was, in the same report as a
  web one.
- **No tool result is ever stored.** The server holds which tools ran and what they were asked, never
  what they returned — so a desktop answer cannot be audited from the server the way a web answer can.
- **The app tells the server nothing about itself.** No version, no platform, no build. A report about
  a desktop answer cannot be tied from the server's side to the build that produced it; the version is
  visible only in the app's own sidebar and About pane.
- **Searches from this app are not rate-limited by anything.** The web app's per-user cap does not
  cover this route.
- **A dropped turn drops its trace.** If the server rejects a turn as invalid, the multi-agent trace
  waiting to be linked to it is discarded without a word.
- **Nothing de-duplicates.** Re-sending the same turn creates a second copy of it on the server.
- **Which conversations the sidebar shows is entirely the server's decision.** The app asks for the
  signed-in user's conversations and lists what comes back; it applies no filter of its own.

### Not supported

- Writing to the knowledge base in any form.
- Reading a multi-agent trace back from the server. Once a run's detail leaves this machine it can
  only be read in the web app.
- Reaching any administrative endpoint. The app speaks to the knowledge-base connection and the
  conversation API, and nothing else.
- Telling the server that a turn failed, was stopped, or was never asked.

---

## 8. Installing, updating and diagnosing

**What it is for.** How the app reaches a machine, how it is updated, and what there is to look at when
something goes wrong.

**Who uses it.** IT and whoever supports the users.

### What you can do

| Capability | What happens |
| --- | --- |
| **Install on macOS** | A zip per architecture, dragged to Applications. Signed with a certificate created once per build machine. |
| **Install on Windows** | A one-click, per-user installer, plus a portable zip. Unsigned. |
| **Run one copy** | Launching a second time is meant to focus the window already open rather than starting another. |
| **See which build is running** | The version is in the sidebar footer, in the About pane, and — on macOS — in the standard About panel. |
| **Cut a release** | One command checks the branch is clean and current, runs the type check and the tests, bumps the version, commits, tags and pushes — behind a single confirmation. The tag then builds both platforms and publishes them. |
| **Retry a failed release** | A second command re-creates the tag for the same version rather than burning the next one. |

### How it behaves

- **Neither platform's signature satisfies the operating system.** macOS is self-signed, not notarized;
  Windows is unsigned. First launch therefore needs a deliberate override on both — right-click → Open
  on macOS, *More info → Run anyway* past SmartScreen on Windows. Everything after the first launch is
  normal, and every published release carries the same two sentences explaining it.
- **macOS signing is nonetheless load-bearing.** A stable signature is what keeps the operating
  system's keystore willing to hand back the cached sign-in token across updates; an unsigned build
  would look like a different app every time and re-prompt.
- **The model's engine is fetched per target, not bundled from the build machine.** Each platform's
  binary is downloaded for that target and checked against a published checksum during the build,
  because the one on the build machine only ever matches the build machine. After the macOS build the
  pipeline verifies the signing identity, the bundle identifier, a deep signature check, and that
  exactly one copy of that engine is present.
- **The build refuses a tag that disagrees with the version** in the project file — checked on a cheap
  machine before any expensive build starts — because the artifacts are named from the file, not the
  tag.
- **The local macOS build refuses to start without the signing certificate** and prints the steps to
  create one, unless the certificate is supplied through the environment, which is how the pipeline
  does it.
- **Every push and pull request runs the type check and the test suite.**
- **The window itself is hardened.** The page it runs is locked to its own files with no outside
  connections, no frames and no plug-ins, and the interface has no direct access to the system: the
  whole surface between the two is twenty-odd named calls.

### Limits

- **There is no automatic update.** Updating means sending a new file and having each user install it.
  Nothing tells a user their copy is old, and nothing tells the team which versions are in the field.
  The build even produces update-feed files; nothing publishes them.
- **The release build does not run the tests.** The type check and the tests run on every push, and the
  local release command runs them again — but the workflow the tag triggers depends on neither, so a
  red test does not stop a release cut from a tag pushed by hand.
- **The app icon is not in the repository.** It sits in the working tree of whoever made it and nothing
  ignores it — it was simply never committed — so a fresh clone builds without the artwork the build
  file names.
- **There is no log file.** Everything the app records goes to standard output, which a Finder- or
  Explorer-launched app writes nowhere the user can reach. The one line that would say the token cache
  is disabled is written there and nowhere else. Diagnosing a packaged build means launching it from a
  terminal.
- **There is no crash reporting, no telemetry and no diagnostics bundle.** A user's report is the only
  signal that anything went wrong.
- **The app installs no menu of its own, so the platform's stock one ships** — its View menu supplies
  Reload, Force Reload, Toggle Developer Tools and zoom, on their usual shortcuts, in a released build.
  Reloading mid-answer strands the running turn: the interface forgets which conversation was open, so
  the turn continues, finishes and is saved with nothing on screen following it.
- **Two of the app's own protections are effectively inert once packaged.** The check that pins the
  window to its own content, and the check that only the app's own window may call into it, both
  compare an origin that a file-loaded page reports as the literal word "null" — which every other
  file-loaded page reports too. Both are meaningful in development and largely decorative in a shipped
  build; the window's other hardening is what actually carries it.
- **Only secure web links and email addresses are handed to the operating system.** Everything else —
  including a plain insecure web link — is dropped with no error and no feedback.
- **On macOS the app survives its last window closing, and the reference to that window is never
  cleared** — so a second launch after closing the window can try to focus one that no longer exists
  rather than opening a new one.
- **The app's own title strip is 40 pixels tall on every platform.** On macOS and Windows it replaces
  the system title bar; anywhere else the system bar stays and the strip sits under it, costing 40
  pixels for nothing.
- **A handful of colours and the title-strip height are written out twice** — once for the window frame
  and once for the interface — with a comment asking that they be kept in step and nothing checking
  that they are.
- **Only three targets are built** — macOS on both architectures and Windows on x64. There is no Linux
  build and no ARM Windows build.
- **A published release cannot be replaced by re-tagging alone.** Deleting the tag leaves the release
  behind; it has to be removed by hand first.
- **Nothing in the test suite covers the app's lifecycle, the boundary between its two halves, the
  settings store, the packaging configuration or the release scripts.** Twenty-three test files cover
  the agent loop, the stores and the interface components; everything in this chapter is untested.

### Not supported

- Auto-update, update notifications, or any check for a newer version.
- Notarization or a trusted publisher signature on either platform.
- Central deployment, managed installation, or any way to push a configuration with the app.
- A support bundle, a log viewer, or any way for a user to send diagnostics.
- Rolling back to a previous version from inside the app.
- Removing the user's data on uninstall. The Windows uninstaller leaves the cached conversations, the
  search index and the encrypted token cache in place.

---

## Decisions worth taking

Positions the app holds by default rather than by choice. Each is defensible; none has been decided out
loud. The point of the list is that somebody with the authority to accept them should, and record that
they did — an accepted item stops being a risk and becomes a design.

Rows 1–4 are what a user meets first. Rows 9–11 are what an outside party — a budget owner, a security
review, a works council — is most likely to ask about. Row 12 is the only one here that is arguably a
plain defect rather than a position.

| # | The situation | Why it matters |
| --- | --- | --- |
| 1 | **A stopped or failed turn discards the question too.** Only a turn that ends cleanly is written to the conversation, and the question is written in the same act — so the thread keeps no trace of having been asked. Reaching the turn ceiling counts as a failure, so the longest investigations are the likeliest to vanish. | The user's own memory is the only record of what they asked. It also means the model's session and the stored transcript can disagree about what happened, which is exactly the kind of drift a follow-up question exposes. |
| 2 | **A conversation continued on a second machine has no memory of itself.** The transcript is restored and shown in full, but the model's session is local, so the next answer is produced as if the visible exchange above it had not happened. | The most confusing possible failure: everything looks right and the answer behaves as though it is not. Nothing on screen distinguishes a conversation the model remembers from one it does not. |
| 3 | **Past 200 conversations, the oldest are silently deleted from the machine on every refresh.** The rule exists to clean up conversations deleted elsewhere; with no paging behind it, it also fires on everything the server's first page did not mention. | Data loss with no message, on a threshold a regular user reaches within a year. What is lost is only a cache — but with it goes that conversation's searchability and the model's memory of it. |
| 4 | **There is no way to rename a conversation**, although the whole path works and `yvoke-web`'s specification states that the desktop app is the only place it can be done. | Either the capability or the sibling specification is wrong. Two lines of interface would settle it in the app's favour. |
| 5 | **The playbook check runs on every playbook-carrying message**, where the web runs it once per conversation, and re-sends the entire playbook catalogue each time. | It is a real, billed model call per message, with the largest prompt the app ever assembles for the smallest question it ever asks. Deliberate — a desktop playbook is per message — but nobody has priced it. |
| 6 | **The specialist-call budget is advisory.** The lead is told a number; nothing counts. Only its 60-turn ceiling actually bounds a run. | The one setting a user would reach for to control the cost of a multi-agent answer does not control it. |
| 7 | **A reviewer that answers "NOT APPROVED" is recorded as having approved.** The fallback that finds a verdict buried in prose accepts any reply containing the positive word and not the negative one. | The reviewer is the whole justification for multi-agent mode costing what it does. This is the one path where it can fail silently in the direction that ships a bad answer. |
| 8 | **The first Save freezes the deployment's defaults for that user, permanently.** Everything the build ships — server address, identity registration, model list, agent budgets — is copied into the user's profile and shadows the build's file from then on. | A future release cannot change a default for anyone who has ever opened Settings and saved. Migrating a server address would mean asking every user to edit a file. |
| 9 | **The company cannot see what desktop answers cost.** Only the knowledge-base searches reach the server's spend reporting; the model spend is on the user's own subscription, and no tool result is stored either. | A desktop conversation looks an order of magnitude cheaper than it was, in the same report as a web one — and cannot be audited afterwards the way a web answer can. Anyone reading that report to compare surfaces is being misled by design. |
| 10 | **The local cache is unencrypted and never expires**, and signing out leaves all of it behind and still listed. Every question and answer read on the machine stays in plain text under the app's data directory, and the Windows uninstaller leaves it there. | The company's data-protection position for the web app is "administrators can read everything, forever". The desktop adds "and a plain-text copy sits on every laptop that opened it, after sign-out and after uninstall". |
| 11 | **There is no auto-update**, no update notice, and no way to know which versions are in the field — and the app tells the server nothing about itself either. | Every fix reaches users only when somebody sends them a file and they install it. A serious bug has no recall mechanism and no way to measure the exposure. |
| 12 | **The release workflow does not run the tests.** The local release command does, and every push does — but the workflow the tag triggers depends on neither. | The one gate that matters is the one that is optional. A tag pushed by hand ships whatever compiles. |
| 13 | **Choosing the older knowledge-base transport is accepted, used, then silently reverted** at the next launch. | A setting that appears to work and quietly undoes itself is worse than one that is not offered. Either remove the choice or make it stick. |
| 14 | **The app has no offline mode at all — not even a degraded one.** Base instructions, playbooks and profiles are all fetched live with no fallback and no cache, so an unreachable server means no answer rather than a worse one. | Deliberate, and right: a local copy would drift from the server's and contradict it silently. Recorded here as a decision so that nobody "fixes" it by adding a fallback. |
| 15 | **Nothing about the app's shell is tested** — not its lifecycle, not the boundary between its two halves, not the settings store, not the packaging or release scripts. | Every finding in chapter 8 is unenforced by definition. The parts most likely to break a release are the parts nothing watches. |

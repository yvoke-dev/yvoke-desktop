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
> where it stops. And **anyone — person or agent — about to make a substantial change: read the
> relevant chapter in `spec/` before you start.** It is the fastest way to learn what a feature is *for*, which behaviours
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
> **Its sibling.** `yvoke-web`'s `spec/` directory is the functional specification of the *server*
> and the web client. This app is one of the surfaces that specification's chapter 7 describes. The
> two documents overlap deliberately and must agree; where this one contradicts it, this one is about
> this build and wins. Every rule about *what the assistant knows* — knowledge areas, tags, imports,
> what a playbook contains — lives there, not here. This document owns only what happens on this
> machine.
>
> **Keeping it true.** A change a user would notice must update the affected chapter file in `spec/` in the same
> change — a new capability in *What you can do*, a changed rule in *How it behaves*, a raised or
> lowered ceiling in *Limits*, something newly possible struck from *Not supported*. A stale
> specification is worse than none, because agents act on it.
>
> **How to read it.** Eight capability chapters, each in its own file under `spec/`. Each has the same shape: what the area
> is for, who uses it, **what you can do**, **how it behaves**, **limits**, and **not supported**. The
> last two are the useful ones in a stakeholder conversation — they are where the surprises live.

---

## Contents

| # | Chapter | Mainly for | Summary |
| --- | --- | --- | --- |
| — | [What Yvoke - Desktop is](#what-yvoke---desktop-is) · [Words we use](#words-we-use) | read first | Overview of Yvoke - Desktop, problem it solves, and domain glossary. |
| 1 | [Asking questions](01_asking_questions.md) | every user | The chat interface, question input, message rendering, citations, stop/cancel, and format options. |
| 2 | [How an answer is produced](02_how_an_answer_is_produced.md) | every user · knowledge team | Single-agent execution loop, Claude Agent SDK, playbooks, preflight validation, compute tools, and web access. |
| 3 | [Multi-agent investigations](03_multi_agent_investigations.md) | power users · knowledge team | Multi-agent orchestration, lead agent, specialist playbooks, reviewer verification, and execution tracing. |
| 4 | [Where conversations live](04_where_conversations_live.md) | every user · support | Local JSONL cache, incremental search indexing, thread sidebar, deleting and managing conversations. |
| 5 | [Signing in](05_signing_in.md) | everyone · IT | Dual sign-in architecture: Claude Pro/Max subscription and Entra ID (MSAL PKCE) / Dev server access. |
| 6 | [Settings and what they change](06_settings_and_what_they_change.md) | power users · IT | Settings panel, deployment vs user preferences, thinking budget, web search scoping, and version reconciliation. |
| 7 | [What the app tells the server](07_what_the_app_tells_the_server.md) | platform team · product owner | Sync API, transcript synchronization, ratings/feedback, offline queueing, image descriptions, and privacy. |
| 8 | [Installing, updating and diagnosing](08_installing_updating_and_diagnosing.md) | IT · support | Cross-platform installation, Gatekeeper/SmartScreen, logging, diagnostics, and release packaging. |
| — | [Decisions worth taking](#decisions-worth-taking) | product owner | Default positions the app holds that merit deliberate product owner decisions. |

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
| 5 | **The playbook check re-sends the entire playbook catalogue on every check it runs** — the conversation's first message, and again each time the user switches playbooks. | It is a real, billed model call carrying the largest prompt the app ever assembles for the smallest question it ever asks. Now bounded per conversation rather than per message, but still nobody has priced it, and a user who switches playbooks a few times pays it a few times. |
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

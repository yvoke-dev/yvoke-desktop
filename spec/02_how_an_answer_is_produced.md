# 2. How an answer is produced

**What it is for.** The local agent loop: what the assistant is told, what it is allowed to do, and
what happens between the question and the answer.

**Who uses it.** Everyone who asks a question. The knowledge team owns what it is told, from the
server.

## What you can do

| Capability | What happens |
| --- | --- |
| **Every answer is grounded in a live search** | The assistant answers from what the server's knowledge-base tools return, under the server's own grounding and citation instructions. It has no other source. |
| **A toolbox, not a search box** | The assistant can search the corpus, list an area's documents, read a table of contents, read a whole section, look a thing up in the knowledge graph and follow its connections, query structured records, read their declared shape, and check its own citations. Nine of these are granted by default. |
| **Playbooks scope the run** | A playbook adds its instructions on top of the base instructions and narrows the assistant to the tools it declares. Its text never appears in the conversation — only its name is stored. |
| **Playbook preflight** | Before a playbook-carrying message runs, a tool-free model call is asked whether that playbook suits the question, and offers a better match if not. |
| **Arithmetic without a shell** | Three in-app tools — a calculator, a summary-statistics tool and a date-difference tool — let the assistant do numeric work. They run inside the app with no shell, no file access and no network. |
| **Domain-restricted web search and fetch** | When an operator enables it and lists domains, the assistant may search the web and fetch full pages — but only within those domains. |
| **It can ask instead of guessing** | The assistant can pause and ask the user a question, with or without ready-made options, and continue from the answer. |
| **Choose how hard it thinks** | Four thinking levels per conversation. |
| **Follow-ups remember the conversation** | The model keeps its own memory of a conversation between questions, so a follow-up does not restate what came before. |

## How it behaves

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
  three compute tools and (when enabled) web search and page fetch. Every other tool the runtime knows about is
  refused the moment it is called, with a message telling the assistant to use the knowledge-base
  tools instead.
- **Being granted a tool and being pre-approved for it are two different things.** Pre-approval makes
  the runtime grant a call without asking, which means the app's own permission check never sees it.
  So the two tools whose rules live entirely in that check — web access, and the clarifying question —
  are granted but deliberately never pre-approved. They are still offered to the assistant; each call
  simply has to be answered rather than waved through.
- **The shell is blocked outright**, so it is never even offered — absent rather than withheld by a
  policy that could be misconfigured. This is what makes it safe for the assistant to read a corpus
  that anybody could have written into.
- **A playbook's tool list replaces the default one, and three things are added regardless.** Declare
  tools and the assistant gets exactly those; declare none and it gets the nine defaults. Either way
  the tool-discovery helper, the compute tools and — when the setting is on — web search and fetch are appended.
  A playbook cannot opt out of any of the three, except by declaring that it may not compute.
- **A playbook can withhold computation.** A playbook that declares no code execution loses the compute
  tools, checked in two independent places. A playbook that declares nothing at all keeps them: the
  grant is opt-out, not opt-in.
- **Tool names in playbooks are re-namespaced, not matched.** A playbook written when the connection
  had a different name still works; its tool names are rewritten to the current one rather than tested
  against it.
- **Web search and page fetch are force-restricted, not asked to restrict themselves.** Whatever domains the model asks for
  in searches are replaced by the configured list before the search runs, and page fetch strictly verifies
  target URLs against the same list. Both re-read it on every call — so a change in Settings takes effect
  immediately. Switched on with no domains listed, every search or fetch is refused rather than run against the open web.
  This rests on neither tool being pre-approved; pre-approve either and none of it runs.
- **The domain list is read generously and matched strictly.** An entry may be written as a bare
  domain, with a protocol, with a port, with a path, with a leading dot or as `*.example.com`; all of
  them mean the same host, and each one covers that host and everything under it. What is left after
  that reading is what must match — an entry that reduces to nothing counts as nothing, so a list of
  only such entries refuses every call rather than passing an empty restriction along.
- **A fetched page is corpus the operator did not curate.** The allow-list decides which sites may be
  read, not what those sites say, and a permitted page arrives in full rather than as a search-result
  snippet. A domain that hosts anything reader-supplied is therefore a route for text that will be
  read as instructions, and it is the operator's judgement — not a check in the app — that keeps such
  domains off the list.
- **A permitted domain is not necessarily a readable one.** A site that answers non-browser clients
  with a bot-challenge returns an empty document, so the fetch succeeds and the assistant is handed
  a blank page rather than a failure. Nothing in the app can tell the two apart — the permission
  check sees the request, never the response — so whether a domain's pages can actually be read is
  something to verify once, not to assume from the allow-list.
- **A failing tool does not fail the answer.** The failure is handed back to the assistant as that
  tool's result and shown as a failed step in the trace; the run continues.
- **A clarifying question reaches the model as a refused tool call** whose message reads *User
  answered: …*. Stopping a turn resolves any question still waiting with an empty answer rather than
  leaving the run hanging.
- **Changing the playbook or the agent mode restarts the assistant's session** so the new tool
  allow-list and instructions take effect. When continuing under the same playbook, the session
  remains warm and playbook instructions are not redundantly re-injected. When switching playbooks,
  a fresh session is initialized with the new playbook's tools and instructions. Attempting to change
  agent mode while a turn is already running is rejected.
- **Nothing from the user's own Claude tooling configures this app.** Personal settings, project
  settings and instruction files are all excluded; the assistant's behaviour comes from the server's
  instructions plus the selected playbook. The environment the model runs in *is* inherited, so
  variables a developer exported still reach it.
- **Citation markers are rewritten after the answer is parsed, not before.** A real link like
  `[2](https://example.com)`, and a bracketed index inside a code block, are therefore left alone —
  both were corrupted when the rewrite worked on the raw text.
- **A second message while a turn is running is refused.** The composer normally prevents it; the
  refusal surfaces only when something else drives the app.

## Limits

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
- **Changing the model while the check runs is prevented.** All conversation configuration selectors
  (model, thinking effort, agent mode) and playbook controls are disabled while a check runs, so the verdict
  and turn run under the selected model.
- **The check is skipped when there is nothing to compare against** — fewer than two playbooks offered,
  an unreachable server, a playbook the picker does not list, or a multi-agent conversation.
- **A playbook whose constraints cannot be resolved runs with the full default tool set and no
  code-execution restriction.** Nothing is logged when the playbook is simply absent from the server's
  list, and nothing is shown either way — a playbook that meant to narrow the assistant silently
  widens it.
- **A playbook may declare `ask_clarifying_question` without switching clarifying questions off.**
  Naming the tool used to pre-approve it, and pre-approval bypassed the only place the question is
  intercepted and shown to the user, so under such a playbook the assistant asked and nobody was ever
  asked. The tool is now withheld from pre-approval however it was granted.
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

## Not supported

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
- Changing the agent mode while a turn is in progress.


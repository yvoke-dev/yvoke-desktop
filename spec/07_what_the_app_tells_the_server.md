# 7. What the app tells the server

**What it is for.** The contract between this app and Yvoke's server: what it reads, what it writes,
and what therefore shows up in the web app's screens.

**Who uses it.** The platform team, and the product owner deciding what the company can see about
desktop usage.

## What you can do

| Capability | What happens |
| --- | --- |
| **Read the knowledge base** | Every search, listing, table of contents, section read, graph lookup, record query and citation check goes to the server's knowledge-base connection, authenticated as the signed-in user. |
| **Read the configuration** | The base instructions, the whole playbook library and every multi-agent profile are fetched live over the same connection. |
| **Write conversations** | Conversations are created, retitled, re-settinged and deleted through the conversation API, and each finished turn is appended to it. |
| **Write ratings** | A thumb and its comment are stored against the server's id for that answer, so they appear in the web app's feedback screens and counts. |
| **Write multi-agent traces** | A completed multi-agent turn is uploaded step by step and appears in the web app's trace viewer alongside runs the web performed. |
| **Mark itself as the desktop** | Conversations are created labelled as coming from the desktop, which is what lets the web sidebar and the admin conversation register tell them apart. |
| **Share a conversation's settings with the web** | The model, the thinking level and the selected profile are written into the conversation's settings under the keys the web app uses, so the two surfaces see the same choices. |

## How it behaves

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

## Limits

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

## Not supported

- Writing to the knowledge base in any form.
- Reading a multi-agent trace back from the server. Once a run's detail leaves this machine it can
  only be read in the web app.
- Reaching any administrative endpoint. The app speaks to the knowledge-base connection and the
  conversation API, and nothing else.
- Telling the server that a turn failed, was stopped, or was never asked.


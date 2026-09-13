# 3. Multi-agent investigations

**What it is for.** A hard question answered by a team rather than one agent: a lead breaks it up,
specialists research the parts, and a reviewer checks the draft against what they found before the
user sees it.

**Who uses it.** Anyone, on a conversation where they choose a profile — but it costs several times a
normal answer and takes minutes, so it is for questions worth that. The knowledge team owns the
profiles and the playbooks; there is no way to build one from the app.

## What you can do

| Capability | What happens |
| --- | --- |
| **Switch a conversation to a profile** | A selector in the toolbar below the composer offers *Single agent* plus every profile the server defines, minus any marked as a prototype while *Show prototypes* is off (marked 🧪 when shown). Choosing one takes over the conversation. |
| **Ask once, get one answer** | The lead plans the turn, delegates self-contained sub-questions to specialists, and composes a single cited answer from what they bring back. |
| **See the team's work** | Each delegation is its own card: which specialist was consulted, the sub-question it was given, the tools it called inside its own turn, and the answer it returned. |
| **See the reviewer's verdict** | The reviewer's card carries an *Approved* or *Rejected* badge and its notes. |
| **See when an answer did not pass** | An answer delivered without approval carries a banner saying which of the three happened — *delivered without review*, *no clear verdict*, or *rejected* — with the reviewer's notes beneath it, and the same warning is written into the answer text itself. |
| **Bind a model to each role** | Settings sets the model and thinking level for lead, reviewer and specialist separately, and shows the worst-case number of model calls one turn can make. |
| **Set the budgets** | How many revision rounds a rejection may drive, how many specialist calls a question should spend, and a ceiling on the lead's and each specialist's own loop. |
| **Turn code-enforced review off** | A switch leaves review entirely to the lead's own playbook instead of the runtime insisting on it. |
| **Have the run recorded centrally** | A completed multi-agent turn is uploaded to the server step by step — role, round, playbook, model, instructions, output, verdict and token counts — and appears in the web app's trace viewer beside the runs the web itself performed. |
| **Still run a specialist on its own** | Specialist playbooks stay pickable in ordinary single-agent chat. Only the lead's and the reviewer's playbooks are hidden from the picker. |

## How it behaves

- **Choosing a profile takes over the conversation.** The playbook picker, the active playbook badge,
  the model selector and the thinking selector all disappear, because the profile and Settings decide
  them. A message sent in a multi-agent conversation carries no playbook and is not preflighted.
- **Switching between single-agent and multi-agent modes (or between profiles) starts a fresh session.**
  An existing single-agent session cannot be resumed by the multi-agent orchestrator (nor vice versa),
  as their agent topologies, roles and tool permissions are mutually incompatible. Past messages remain
  visible in the conversation log, but the underlying agent subprocess runs fresh under the selected
  profile.
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

## Limits

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
- **Mode switching does not carry model-level session context across boundaries.** When switching
  between single agent and an orchestrator profile, or switching between different profiles, the new
  turn does not resume the prior mode's model session on disk.

## Not supported

- Choosing which specialists run, or intervening once a run has started.
- A reviewer that can search the knowledge base for itself.
- Nested delegation. A specialist that delegates further produces no card, no result and no trace step
  — the whole sub-run vanishes from the record.
- Creating, editing or importing a profile from the app.
- Multi-agent mode without a server-defined profile. Where none exists, the selector does not appear.
- A playbook on a multi-agent message. The profile decides every prompt in the run.
- Reading a past run's specialist and reviewer cards after the conversation has been restored from the
  server. That detail lives only in the uploaded trace, which the app never reads back.


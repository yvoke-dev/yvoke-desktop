# 6. Settings and what they change

**What it is for.** Everything the app can be told, in one panel. There is no separate administrator
configuration: whatever ships as the build's defaults, the user can change.

**Who uses it.** Power users and whoever prepares the build. Most users never open it.

## What you can do

| Pane | What it sets |
| --- | --- |
| **Server** | The server address, which knowledge-base transport to use, and whether the server sign-in is corporate or a development token. |
| **Models** | Which models the composer offers, which one new conversations start on, the default thinking level, and the ceiling on how many times the assistant may act per question. |
| **Agents** | Whether a playbook-carrying message is preflighted; whether to show prototype playbooks and prototype multi-agent profiles in their pickers; and for multi-agent mode, the model and thinking level per role, the revision-round and specialist-call budgets, the per-agent turn ceilings, and whether review is enforced in code. It also shows the worst-case number of model calls one turn can make. |
| **Web search** | Whether the assistant may search the web and fetch pages at all, and the exact list of domains it may access. |
| **Appearance** | Theme, interface density, answer text size, and whether a finished answer's trace starts open. |
| **Advanced** | The corporate identity registration — tenant, client and scope. Replaced by a note when the server sign-in is set to the development token. |
| **About** | Version, server address, both sign-in states, and on-demand credential verification checkmarks. |

## How it behaves

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
  and enabling the feature means listing domains in the same act, because searches and page fetches refuse to run otherwise.
  The domain list is the one setting that reaches a running conversation immediately.
- **The theme's *System* setting stays live.** It keeps following the operating system for as long as
  the window is open — including a scheduled evening switch — and takes the native window frame with
  it.
- **Reduced motion follows the system**, with no control of its own.
- **Verifying credentials in the About pane is on-demand.** Clicking *Check Credentials* tests whether the corporate or development token is accepted and whether the Claude credentials generate a live reply. It runs in the background without modifying settings on disk or interrupting ongoing chat conversations.

## Limits

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

## Not supported

- A managed or enterprise configuration channel.
- Per-conversation overrides for anything other than model, thinking level and agent mode.
- Any setting that changes what the assistant *knows*. Knowledge areas, versions, playbooks and base
  instructions are all server-side.
- Turning off local caching, or choosing where it lives.
- An unsaved-changes prompt.


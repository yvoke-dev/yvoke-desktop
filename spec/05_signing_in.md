# 5. Signing in

**What it is for.** Two separate sign-ins, paying for two separate things. Neither substitutes for the
other, and the app is useless without both.

**Who uses it.** Every user once, and IT when a deployment's identity registration changes.

## What you can do

| Capability | What happens |
| --- | --- |
| **Sign in to Claude** | *Sign in to Claude* opens Anthropic's browser sign-in flow and completes automatically when the browser finishes. Offered whenever Claude credentials are missing or expired — from the startup banner, the Accounts pane, and inline on conversation sign-in errors. While waiting, you can choose *Cancel sign-in* or open *Use another browser* to *Copy sign-in link* into another browser or profile and paste back the authorization code. The app also picks up an existing Claude sign-in already present on the machine. |
| **Sign in to the server** | *Sign in to Yvoke* opens the corporate sign-in in the system browser only when you explicitly click it — from the top banner, *Settings → Accounts*, or inline on a failed chat turn — and returns to the app when it completes. While waiting, you can choose *Cancel sign-in*, and any failure or timeout is reported as an inline error. The browser page confirms completion and can be closed. |
| **See who is signed in** | The clickable sidebar footer shows both Yvoke and Claude status at a glance and jumps straight to *Settings → Accounts*, which spells out both accounts as *Signed in* or *Not signed in*. |
| **Sign out of the server** | Available in *Settings → Accounts* when signed in with a corporate account. Clears the Yvoke corporate sign-in only; Claude credentials are untouched. |
| **Sign out of Claude** | Available in *Settings → Accounts* when Claude is signed in. Clears the local Claude credentials so you can sign in again; your Yvoke corporate sign-in is untouched. |
| **Use a development token instead** | A setting sends a fixed token rather than a corporate one, for use against a server running with mock security. |
| **Verify logins** | In *Settings → Accounts* (the Accounts pane), click *Check Credentials* to test whether both logins actually work. Probes the server connection silently with the corporate or development token, and runs a live one-turn check against the Claude model. Shows active checkmarks or failure explanations. |

## How it behaves

| Sign-in | What it pays for or grants | How it works |
| --- | --- | --- |
| **Claude** (Pro/Max subscription) | The model — every answer, every specialist, every review. Drawn from the subscription's agent allowance, separate from other Claude apps. | Managed by the bundled Claude tooling via in-app browser sign-in or picked up from existing Claude credentials on the machine. The app itself never sees, stores, or transmits raw subscription tokens. |
| **Server** (corporate account) | The knowledge base, the playbooks, the profiles, and conversation storage. | Corporate sign-in in the system browser; the resulting token authenticates both the knowledge-base connection and the conversation API. |

- **Signing in to Claude works in the default browser or any other browser.** Starting *Sign in to Claude*
  opens the system's default browser and waits for completion, offering *Cancel sign-in* to abort cleanly.
  If your personal Claude subscription lives in a different browser or profile, expanding *Use another
  browser* lets you click *Copy sign-in link* to copy the sign-in address to the clipboard and submit the
  resulting authorization code to complete sign-in.
- **Sign-ins completed outside the app are picked up automatically on focus.** While Claude credentials are
  missing, returning to the window re-checks credential status automatically so a login finished in
  another window or tool clears the startup banner without restarting.
- **Completing Claude sign-in refreshes idle warm conversations without losing conversation memory.** Idle
  conversation sessions are cycled onto the fresh credentials while preserving each conversation's session
  history, so follow-up questions pick up right where they left off.
- **A pay-per-token API key in the environment is removed** before the model runs, so an inherited one
  cannot silently move billing off the subscription.
- **An unconfigured build defaults to corporate sign-in**, never to the development token — the
  default fails closed rather than quietly sending a token that grants nothing.
- **The same token goes to both server endpoints.** The knowledge-base connection and the conversation
  API authenticate identically.
- **Corporate sign-in is explicit-click only — the app never opens a browser automatically.** Startup,
  background sync, server polling, and failed chat turns never launch a browser window on their own.
  Before each request, the app tries a silent token refresh; when the server rejects an expired token
  with a 401, the app attempts one forced silent refresh and retries once. Silent refresh clears the
  cached corporate account only when credentials are missing, expired, or require interactive sign-in,
  then asks you to click *Sign in to Yvoke* — offered in the top banner, in *Settings → Accounts*, and
  inline on a failed chat turn. Transient network errors or identity-provider server errors keep the
  cached corporate account intact rather than signing you out, so later attempts can refresh silently
  instead of mistaking a temporary outage for an expired session. Proactive silent re-authentication
  checks token validity before each turn on warm conversations, refreshing credentials in-memory and
  updating MCP connection headers so idle sessions resume without authentication errors.
- **Corporate sign-in can be cancelled and reports errors inline.** While waiting for the browser sign-in
  flow to complete, *Cancel sign-in* aborts cleanly and resets the controls. If corporate sign-in fails or
  times out after 5 minutes, the app shows an inline error so you can try again.
- **Being signed out or expired in corporate mode is distinguished from *Server unreachable*.** The
  *Server unreachable* banner is suppressed while corporate sign-in is required, so a missing or expired
  corporate login shows the corporate sign-in prompt instead of misreporting a network outage.
- **Sign-in controls are shown in one place at a time.** When *Settings → Accounts* is open or the
  active conversation is already showing an inline sign-in error, the matching top sign-in banner stays
  hidden so sign-in controls and error messages are not duplicated, while *Server unreachable* remains
  suppressed whenever corporate sign-in is required.
- **The token cache is encrypted with the operating system's keystore** where one is available.
- **The server address must be secure.** Anything other than `https` is refused when a user saves it,
  with plain `http` allowed only for a local address.
- **Verifying logins tests the server token silently without launching the browser.** *Check Credentials*
  lives in *Settings → Accounts* and runs on demand. When signed out in corporate mode, *Settings → Accounts*
  shows plain *Not signed in* status and offers *Sign in to Yvoke* upfront; if verification reports an
  expired or missing corporate session, *Sign in to Yvoke* is offered inline in the Accounts pane rather
  than opening a browser window automatically. When signed in, *Settings → Accounts* shows *Signed in* and
  offers one-click *Sign out* for Yvoke in corporate mode and for Claude when connected, closing idle
  sessions and returning to the signed-out state. If signing out of Yvoke fails (for example, due to a
  cache write error), an inline error is shown on the Yvoke account row in *Settings → Accounts*,
  matching Claude sign-out.
- **Claude verification performs an isolated, single-turn live probe.** It runs with thinking disabled, low effort, and no tools, confirming that credentials are valid and subscription quota is available without leaving a session on disk or affecting active conversations. A probe turn that fails during execution reports the failure, distinguishing session expiration, subscription allowance depletion, and unexpected errors, while a completed probe must return the expected verification token (*pong*).
- **On macOS, Claude verification reaches keychain credentials.** Verification checks the bundled Claude tooling's keychain-aware credential status before probing: active keychain sessions proceed to the live probe even without a credential file on disk, while missing or signed-out profiles (including previously used ones) report no credentials without probing.
- **Dev server mode is verified against the server endpoint** using the fixed development token.

## Limits

- **Claude verification requires the model to return the probe token.** The verification probe asks the model to emit a single token (`pong`). If a working login returns an empty response, a refusal, or a paraphrased answer that omits the token, *Check Credentials* reports an "unexpected reply" failure even though credentials and quota are valid.
- **Token refresh occurs at turn boundaries, not mid-turn.** Tokens are checked and proactively renewed before each user message starts. A failed silent refresh during transient network or identity-provider server errors reuses an unexpired cached token even when within the 5-minute buffer, so an offline session can still lose knowledge-base access mid-turn. Likewise, if an individual turn or multi-round review execution outlives the token's remaining validity buffer (typically 5 minutes), knowledge-base calls later in that same turn can still encounter a 401 token-expired error.
- **"Signed in" only means an account was found in the cache.** This applies to the passive status shown upon startup; no token is tried until the first server call, so a session whose refresh expired months ago still shows the account name as signed in until something fails. By contrast, the on-demand *Check Credentials* action actively validates token acceptance against the server.
- **"Claude is connected" on startup checks local credential status, not live model access.** Startup queries
  the bundled Claude tooling's Keychain-aware credential status (falling back to local credential detection
  if needed), so missing or signed-out profiles surface the startup banner immediately rather than waiting
  for the first failed question. Even so, startup does not run a live model call: a session revoked on the
  provider side or out of subscription allowance is still caught when a question runs or via the on-demand
  *Check Credentials* action in *Settings → Accounts*. Credentials configured via external helper scripts
  are ignored because personal tooling settings are excluded, and organization or subscription-tier details
  are not displayed.
- **Corporate sign-in gives up after 5 minutes.** If the browser flow is abandoned or cannot complete in
  time, sign-in ends with an inline error so you can try again.
- **Where the operating system offers no keystore, there is no token cache at all.** The corporate
  sign-in then has to be repeated on every launch, and the only record of why is a startup line the
  user cannot reach.
- **A token cache that cannot be decrypted still forces a fresh sign-in** — this is exactly what a
  changed or regenerated code-signing identity produces — but it is no longer silent: *Check
  Credentials* names it as an unreadable cache rather than reporting no account at all.
- **One account at a time, of each kind.** No account switcher, no second profile.
- **Signing out of the server clears the cached server account and nothing else.** Nothing is revoked on
  the server, no browser session is cleared, Claude credentials are untouched, and every cached
  conversation stays readable on the machine.
- **Changing the identity registration drops the in-memory account but leaves the encrypted cache on
  disk**, and the sign-in indicator does not refresh until something asks for a token.
- **The development token is an ordinary setting, not a build flag.** Any user can switch to it. It
  grants nothing against a real server, so the effect is that everything stops working rather than
  that anything is exposed — but the switch is one click away, and dev mode always reports itself as
  signed in.
- **There is no app lock and no re-authentication on wake.** Anyone with the unlocked machine has the
  app.
- **Claude sign-in gives up after 5 minutes, and authorization-code verification gives up after 15 seconds.**
  If the browser flow is abandoned or a pasted authorization code cannot be confirmed in time, sign-in ends
  with an error so you can try again.
- **Signing out of Claude removes the shared Claude Code credentials on the machine.** Terminal or IDE
  Claude Code sessions that share the same operating-system account are signed out as well, and logout gives
  up after 10 seconds with an inline error if it cannot complete.
- **Nothing warns in advance when the subscription's allowance runs out.** Both a failed conversation turn
  and the on-demand *Check Credentials* action report it as a distinct allowance or rate-limit failure
  rather than a sign-in error, without offering an inline *Sign in to Claude* control.
- **Verifying Claude gives up after 45 seconds** and reports the check as timed out. The budget has
  to cover starting the Claude tooling from cold as well as a reply, so a slow link or a first run
  after an update can report a working login as unverified. Nothing is changed by a timeout; the
  check can simply be run again.

## Not supported

- Automatically opening a browser window for corporate sign-in on startup, background sync, polling, or
  turn failure. Corporate sign-in always requires an explicit *Sign in to Yvoke* click.
- Signing in to Claude with an API key or a token pasted into the app.
- Switching directly between multiple Claude accounts or maintaining a second profile from inside the app.
- Any role or permission inside the app. Everyone who can sign in has the same access, and the
  server's administrator screens are not reachable from here.
- Per-conversation identity, or asking as somebody else.
- Restricting a user to particular knowledge areas from the app. Access control is the sign-in.


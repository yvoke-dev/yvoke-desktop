# 5. Signing in

**What it is for.** Two separate sign-ins, paying for two separate things. Neither substitutes for the
other, and the app is useless without both.

**Who uses it.** Every user once, and IT when a deployment's identity registration changes.

## What you can do

| Capability | What happens |
| --- | --- |
| **Sign in to Claude** | Not in this app. The app picks up whatever the Claude tooling on the machine has already signed in. When nothing is found, a banner explains how to sign in from a terminal and offers a *Retry*. |
| **Sign in to the server** | *Sign in* opens the corporate sign-in in the system browser and returns to the app when it completes. The browser page says so and can be closed. |
| **See who is signed in** | The sidebar footer shows the Claude account when the tooling has recorded one, otherwise the corporate account, and always which mode the server sign-in is in. The About pane spells out both. |
| **Sign out of the server** | Only shown when actually signed in with a corporate account. |
| **Use a development token instead** | A setting sends a fixed token rather than a corporate one, for use against a server running with mock security. |
| **Verify logins** | In the About pane, test whether both logins actually work. Probes the server connection silently with the corporate or development token, and runs a live one-turn check against the Claude model. Shows active checkmarks or failure explanations. |

## How it behaves

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
- **Verifying logins tests the server token silently without launching the browser.** If the session is expired or invalid, an inline *Sign in* button is offered directly in the About pane rather than opening a browser window automatically.
- **Claude verification performs an isolated, single-turn live probe.** It runs with thinking disabled, low effort, and no tools, confirming that credentials are valid and subscription quota is available without leaving a session on disk or affecting active conversations.
- **On macOS, Claude verification tests keychain credentials directly.** If local credential files are absent, the live probe confirms whether the machine's keychain contains an active session.
- **Dev server mode is verified against the server endpoint** using the fixed development token.

## Limits

- **"Signed in" only means an account was found in the cache.** This applies to the passive status shown upon startup; no token is tried until the first server call, so a session whose refresh expired months ago still shows the account name as signed in until something fails. By contrast, the on-demand *Check Credentials* action actively validates token acceptance against the server.
- **Not being signed in is reported as "Server unreachable — showing cached conversations."** The
  banner names the wrong cause, and the fix it implies is the wrong fix.
- **"Claude is connected" is not a credential check on startup.** A stored credential file is enough for the passive startup status, and its validity is not tested passively; on macOS, where the credentials may be in the keychain, the app treats *inconclusive* as *fine*, saying "Detected from Claude Code" whenever the check was not conclusively negative. By contrast, the on-demand *Check Credentials* action in About actively tests functional generation against the model.
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

## Not supported

- Signing in to Claude with an API key or a token pasted into the app.
- Any role or permission inside the app. Everyone who can sign in has the same access, and the
  server's administrator screens are not reachable from here.
- Per-conversation identity, or asking as somebody else.
- Restricting a user to particular knowledge areas from the app. Access control is the sign-in.


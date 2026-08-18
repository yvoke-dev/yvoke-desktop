# Code signing

macOS builds are signed with a **self-signed certificate** created locally. Windows builds are
currently **unsigned**.

## Why sign at all, given it doesn't satisfy Gatekeeper

A self-signed certificate does not make macOS trust the app — recipients still need
**right-click → Open** on first launch, exactly as before. What it buys is a *stable identity*.

`safeStorage` encrypts the MSAL token cache (`src/main/index.ts`), and the Keychain item it
creates has an ACL bound to the app's **designated requirement**. With ad-hoc signing that
requirement is the cdhash, which changes on every single build — so each update looked like a
different app to the Keychain, re-prompting the user and potentially leaving the cached token
unreadable. A certificate-based designated requirement is stable across builds, so updates keep
working silently.

This is also why the certificate itself matters more than it looks: **losing it is not a
recoverable inconvenience.** A regenerated certificate is a different identity and every user
gets re-prompted.

## Creating the certificate (once per machine)

1. **Keychain Access → Certificate Assistant → Create a Certificate…**
2. Name `Yvoke Desktop Signing`, Identity Type **Self Signed Root**, Certificate Type
   **Code Signing**.
3. Tick **Let me override defaults** and set validity to `3650` days — the default is 365, and
   an expired certificate means a new identity and re-prompted users.
4. Verify:
   ```bash
   security find-identity -v -p codesigning
   ```
   The name must appear. `npm run dist:mac` runs `scripts/check-signing-cert.sh` first and fails
   with these instructions if it doesn't.

Override the expected name with `MAC_SIGN_IDENTITY` if you need a different one; it must match
`mac.identity` in `electron-builder.yml`.

## Back it up

Export the certificate **together with its private key** as a `.p12` and store it in the team
password manager.

- A second build machine imports the same `.p12` rather than creating its own certificate.
- CI consumes it as base64 in `MAC_CSC_LINK` with `MAC_CSC_KEY_PASSWORD` (see
  `.github/workflows/release.yml`).

## Building

```bash
npm run dist:mac     # arm64 + x64 zips, signed
npm run dist:win     # x64 NSIS + zip, unsigned
```

Both fetch the target's native Claude Code binary first (`scripts/fetch-claude-binary.ts`) — see
the note on multi-arch packaging in `README.md`.

Verify a build:

```bash
codesign -dvvv "release/mac-arm64/Yvoke - Desktop.app"
```

Expect `Authority=Yvoke Desktop Signing`, `Identifier=de.palsoftware.yvoke.desktop`,
`Sealed Resources version=2` and `flags=0x0(none)`. An `Identifier=Electron` or
`adhoc, linker-signed` means signing silently didn't happen.

The staged sidecar keeps its own upstream signature and is deliberately skipped via
`mac.signIgnore`:

```bash
codesign -dvvv "release/mac-arm64/Yvoke - Desktop.app/Contents/Resources/claude"
# Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
```

## Upgrading to Developer ID + notarization

If the project ever joins the Apple Developer Program ($99/yr; an Organization membership needs a
D-U-N-S number), this becomes config-only:

- `mac.identity` → the `Developer ID Application: …` certificate
- `mac.hardenedRuntime: true` plus an entitlements plist with `com.apple.security.cs.allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation` and
  `allow-dyld-environment-variables`
- `mac.notarize: true` with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`

Keep `signIgnore` — the sidecar is already Developer-ID signed and hardened by Anthropic, and a
nested binary signed by another team notarizes fine. That also unblocks auto-update, which is
parked in `docs/plans/desktop-mas.md` for exactly this reason.

## Windows

Unsigned today. Self-signing is pointless here: SmartScreen blocks it regardless, and unlike
macOS there is no continuity to preserve, because Electron's `safeStorage` uses DPAPI on Windows —
bound to the Windows user account, not to the app's signature.

### Azure Artifact Signing (in progress)

An **Artifact Signing account** has been created. Expect to meet this service under three
different names:

| Where | Called |
|---|---|
| Azure portal | **Artifact Signing Accounts** (`portal.azure.com/#browse/Microsoft.CodeSigning%2Fcodesigningaccounts`) |
| electron-builder docs and options | **Trusted Signing** (`win.azureSignOptions`) |
| ARM resource type | `Microsoft.CodeSigning/codesigningaccounts` |

Remaining steps before anything can be signed:

1. **Identity Validation** under the account — submit company legal details for Microsoft to
   verify. Takes days. Nothing is signable until it is approved.
2. **Certificate Profile** — created after validation. Record its name and the exact subject CN.
3. **Service principal** for `EnvironmentCredential` auth (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET`), granted the *Trusted Signing Certificate Profile Signer* role on the
   account.

Then add to the **CI job only** (see below):

```yaml
win:
  azureSignOptions:
    endpoint: https://<region>.codesigning.azure.net
    codeSigningAccountName: <account>
    certificateProfileName: <profile>
    publisherName: <exact subject CN from the certificate profile>
```

`publisherName` must match the certificate's subject CN verbatim, or NSIS update-signature
verification rejects the build.

### It cannot run on macOS — this is a hard constraint

electron-builder implements Azure signing in PowerShell: it installs the `TrustedSigning` module
from PSGallery and calls `Invoke-TrustedSigning`
(`app-builder-lib/out/codeSign/windowsSignAzureManager.js`). On a non-Windows host,
`winPackager.js` routes this through `getWindowsVm()`, which requires **either** a Parallels
Desktop Win10/11 VM **or** both `pwsh` and `wine` installed locally, and otherwise throws
`InvalidConfigurationError`.

So `azureSignOptions` must **not** go into `electron-builder.yml` — that would break local
`npm run dist:win` on macOS. It belongs in the `windows-latest` CI job, where
`process.platform === 'win32'` makes electron-builder use its no-op VM manager and invoke the
signing module directly.

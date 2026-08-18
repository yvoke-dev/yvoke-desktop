#!/usr/bin/env bash
# Fails the mac build early when the code-signing identity is missing, rather than letting
# electron-builder quietly emit an unsigned app. See docs/signing.md.
#
# CI passes the certificate through CSC_LINK/CSC_KEY_PASSWORD instead of the login keychain,
# so this check is skipped there — the workflow asserts the resulting signature after the build.
set -euo pipefail

IDENTITY="${MAC_SIGN_IDENTITY:-Yvoke Desktop Signing}"

if [ -n "${CSC_LINK:-}" ]; then
  echo "check-signing-cert: CSC_LINK set, deferring to electron-builder's keychain import"
  exit 0
fi

if security find-identity -v -p codesigning | grep -qF "$IDENTITY"; then
  echo "check-signing-cert: found \"$IDENTITY\""
  exit 0
fi

cat >&2 <<EOF

  No code-signing identity named "$IDENTITY" in the keychain.

  Create one (once per machine):
    Keychain Access -> Certificate Assistant -> Create a Certificate...
      Name:             $IDENTITY
      Identity Type:    Self Signed Root
      Certificate Type: Code Signing
      Tick "Let me override defaults" and set validity to 3650 days.

  Then verify with:
    security find-identity -v -p codesigning

  If a colleague already made it, import their .p12 instead of creating a second one — a
  different certificate changes the app's designated requirement and re-prompts every user
  for keychain access. Full details in docs/signing.md.

EOF
exit 1

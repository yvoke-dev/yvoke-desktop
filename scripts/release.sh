#!/usr/bin/env bash

# Cuts a release: preflight checks, version bump, tag, push. CI takes over from the tag —
# see .github/workflows/release.yml.
#
#   npm run release             # patch: 1.0.0 -> 1.0.1
#   npm run release -- minor    # or major
#
# Why a script rather than the two raw commands (`npm version patch && git push --follow-tags`):
# ci.yml does run the typecheck and tests, but release.yml does not depend on it — the two run in
# parallel, so a red test does not stop a release from building and publishing. Catching that here
# is also cheaper than on a macOS runner billing at 10x, as is the guard job's tag/package.json
# mismatch. Everything before the push is local and undoable; the push is the commit point, so it
# sits behind a confirmation.

# Exit on error
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

BUMP="${1:-patch}"
case "$BUMP" in
    patch|minor|major) ;;
    *)
        echo -e "${RED}Error: unknown bump '$BUMP'. Use patch, minor, or major.${NC}" >&2
        exit 1
        ;;
esac

REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Releases are cut from main: the tag must point at a commit that is on the default branch, or
# the published artifacts come from code nobody reviewed.
if [ "$BRANCH" != "main" ] && [ -z "${RELEASE_ALLOW_BRANCH:-}" ]; then
    echo -e "${RED}Error: on branch '$BRANCH'; releases are cut from main.${NC}" >&2
    echo "Set RELEASE_ALLOW_BRANCH=1 to override." >&2
    exit 1
fi

# npm version refuses to run on a dirty tree anyway; failing here says why.
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}Error: working tree has uncommitted changes.${NC}" >&2
    git status --short >&2
    echo "Commit, stash, or discard them before releasing." >&2
    exit 1
fi

echo "Fetching $REMOTE..."
git fetch --quiet "$REMOTE"

UPSTREAM="$REMOTE/$BRANCH"
if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
    behind="$(git rev-list --count "HEAD..$UPSTREAM")"
    if [ "$behind" != "0" ]; then
        echo -e "${RED}Error: HEAD is $behind commit(s) behind $UPSTREAM.${NC}" >&2
        echo "Pull first — otherwise the tag points at a commit that is not the branch tip." >&2
        exit 1
    fi
    ahead="$(git rev-list --count "$UPSTREAM..HEAD")"
    if [ "$ahead" != "0" ]; then
        echo -e "${YELLOW}Note: $ahead unpushed commit(s) ahead of $UPSTREAM — they ship with this release.${NC}"
    fi
fi

# ci.yml runs these on the same push, but nothing gates release.yml on it — a red test still ships.
echo -e "${GREEN}=== Typecheck ===${NC}"
npm run typecheck
echo -e "${GREEN}=== Tests ===${NC}"
npm test

CURRENT="$(node -p "require('./package.json').version")"

# The macOS job fails at certificate import if the signing secrets were never added, and the
# first release through CI is the only time nobody has proven they exist.
if [ -z "$(git tag)" ]; then
    cat <<'EOF'

  No tags exist yet, so this is the first release to run through CI.

  The macOS job needs two repository secrets, or it fails at "Import signing certificate":
    MAC_CSC_LINK            base64 of the Yvoke Desktop Signing .p12
    MAC_CSC_KEY_PASSWORD    the password protecting that .p12

  Add them under Settings -> Secrets and variables -> Actions. To prove them without
  spending a tag, run the workflow manually first (Actions -> Release -> Run workflow):
  it builds both platforms and publishes nothing. See docs/signing.md.

EOF
fi

echo
echo -e "${GREEN}=== Release plan ===${NC}"
echo "  bump      $CURRENT -> $BUMP"
echo "  commit    version bump + tag, on $BRANCH"
echo "  push      $BRANCH and the tag to $REMOTE"
echo "  then      CI builds mac (signed) + win (unsigned) and publishes the GitHub release"
echo
read -r -p "Proceed? (y/N): " resp || resp=""
if [[ ! "$resp" =~ ^[Yy]$ ]]; then
    echo "Aborted; nothing changed."
    exit 1
fi

# Bumps package.json, commits, and creates the tag in one step. The tag is bare (1.0.1, not
# v1.0.1) because of tag-version-prefix in .npmrc, which release.yml's tag filter assumes.
npm version "$BUMP"
VERSION="$(node -p "require('./package.json').version")"

echo -e "${GREEN}Pushing $BRANCH and tag $VERSION to $REMOTE...${NC}"
if ! git push --follow-tags "$REMOTE" "$BRANCH"; then
    echo -e "${RED}Push failed. The bump commit and tag $VERSION exist locally only.${NC}" >&2
    echo "Fix the cause and re-run: git push --follow-tags $REMOTE $BRANCH" >&2
    exit 1
fi

WEB="$(git remote get-url "$REMOTE" | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#\.git$##')"

echo
echo -e "${GREEN}Tagged and pushed $VERSION.${NC}"
echo "  Actions:  $WEB/actions"
echo "  Releases: $WEB/releases"
echo
echo "If the build fails, retry the same version with: npm run release:retag"

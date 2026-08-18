#!/usr/bin/env bash

# Deletes a release tag locally and on the remote so a failed release can be retried, then
# optionally re-tags HEAD and pushes to trigger CI again.
#
#   npm run release:retag              # the version in package.json
#   npm run release:retag -- 1.0.1     # an explicit tag
#
# The version commit deliberately stays: package.json already carries the version, so a retry
# re-tags the same commit instead of burning 1.0.2 on a CI misconfiguration. Only reach for a
# fresh bump when the code itself was wrong.
#
# Deleting a tag does NOT delete a GitHub release created from it — a release that was already
# published has to be deleted in the web UI first, or the re-push leaves an orphaned release
# pointing at nothing.

# Exit on error
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

REMOTE="${RELEASE_REMOTE:-origin}"
TAG="${1:-$(node -p "require('./package.json').version")}"

echo "Fetching tags from $REMOTE..."
git fetch --quiet --tags "$REMOTE"

local_exists=0
remote_exists=0
git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null && local_exists=1
[ -n "$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ] && remote_exists=1

if [ "$local_exists" = "0" ] && [ "$remote_exists" = "0" ]; then
    echo -e "${YELLOW}Tag $TAG exists neither locally nor on $REMOTE; nothing to delete.${NC}"
    exit 0
fi

echo
echo -e "${GREEN}=== Retag plan for $TAG ===${NC}"
[ "$local_exists" = "1" ] && echo "  delete    local tag $TAG" || echo "  (no local tag)"
[ "$remote_exists" = "1" ] && echo "  delete    $REMOTE tag $TAG" || echo "  (no remote tag)"
echo
echo -e "${YELLOW}If a GitHub release was already published for $TAG, delete it in the web UI first —${NC}"
echo -e "${YELLOW}removing the tag leaves the release behind.${NC}"
echo
read -r -p "Delete the tag(s)? (y/N): " resp || resp=""
if [[ ! "$resp" =~ ^[Yy]$ ]]; then
    echo "Aborted; nothing changed."
    exit 1
fi

if [ "$remote_exists" = "1" ]; then
    echo "Deleting $REMOTE tag $TAG..."
    git push --delete "$REMOTE" "$TAG"
fi
if [ "$local_exists" = "1" ]; then
    echo "Deleting local tag $TAG..."
    git tag -d "$TAG"
fi
echo -e "${GREEN}Tag $TAG removed.${NC}"

# Re-tagging is the actual retry. Guarded on the version match because release.yml's guard job
# rejects a tag that disagrees with package.json — the same failure this script exists to undo.
PKG="$(node -p "require('./package.json').version")"
if [ "$PKG" != "$TAG" ]; then
    echo
    echo -e "${YELLOW}package.json is $PKG, not $TAG — not offering to re-tag.${NC}"
    echo "CI's guard job would reject a $TAG tag against version $PKG."
    exit 0
fi

echo
echo "HEAD is $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD):"
git log -1 --pretty='  %s'
echo
read -r -p "Re-tag HEAD as $TAG and push to retry the release? (y/N): " resp || resp=""
if [[ ! "$resp" =~ ^[Yy]$ ]]; then
    echo "Tag deleted but not recreated. Re-tag later with: git tag -a $TAG -m $TAG && git push $REMOTE $TAG"
    exit 0
fi

# Annotated, matching what npm version creates — git push --follow-tags skips lightweight tags.
git tag -a "$TAG" -m "$TAG"
git push "$REMOTE" "$TAG"

WEB="$(git remote get-url "$REMOTE" | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#\.git$##')"

echo
echo -e "${GREEN}Re-tagged and pushed $TAG.${NC}"
echo "  Actions:  $WEB/actions"

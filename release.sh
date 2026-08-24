#!/usr/bin/env bash
# Cut a release.
#
#   ./release.sh 0.2.0    set the version, commit it, tag it, push
#   ./release.sh          tag and push whatever version is already set
#
# The Release workflow refuses to publish unless the tag is exactly
# "v$__version__", so this is the only place that has to remember that.

set -euo pipefail
cd "$(dirname "$0")"

VERSION_FILE="server/daq/__init__.py"
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

read_version() { sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$VERSION_FILE"; }

new="${1:-}"
new="${new#v}"                                   # accept 0.2.0 or v0.2.0
if [ -n "$new" ] && ! printf '%s' "$new" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([ab]|rc)?[0-9]*$'; then
    die "'$new' is not a version (want 0.2.0, or 0.2.0rc1)"
fi

[ -n "$(read_version)" ] || die "no __version__ found in $VERSION_FILE"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "on branch '$branch', not main"

if [ -n "$new" ] && [ "$new" != "$(read_version)" ]; then
    sed -i.bak "s/^__version__ = \".*\"$/__version__ = \"$new\"/" "$VERSION_FILE"
    rm -f "$VERSION_FILE.bak"
    [ "$(read_version)" = "$new" ] || die "failed to write the version into $VERSION_FILE"
fi

version="$(read_version)"
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    die "tag $tag already exists locally"
fi
if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
    die "tag $tag already exists on origin"
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "  version -> $version"
    action="commit, tag $tag, push"
else
    action="tag $tag, push"
fi

if [ -t 0 ]; then
    printf 'About to %s. Enter to go, Ctrl-C to stop. ' "$action"
    read -r _
fi

if [ -n "$(git status --porcelain)" ]; then
    # The "Release v..." prefix is load-bearing: CI skips commits with it, so
    # that pushing the bump and its tag together starts one build (Release)
    # rather than two. Change the wording here and in ci.yml together.
    git commit -q -am "Release $tag"
fi
git tag "$tag"
git push -q origin "$branch"
git push -q origin "$tag"

url="$(git remote get-url origin)"
case "$url" in
    *github*) echo "pushed $tag — https://github.com/$(printf '%s' "$url" |
                    sed -E 's#(git@[^:]*:|https://[^/]*/)##; s/\.git$//')/actions" ;;
    *)        echo "pushed $tag" ;;
esac

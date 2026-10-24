#!/bin/sh
# Builds the docs and publishes them to the gh-pages branch, which GitHub Pages serves.
set -eu
cd "$(dirname "$0")/.."
pnpm build
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
cp -R dist/. "$out"
touch "$out/.nojekyll"
remote=$(git remote get-url origin)
commit=$(git rev-parse --short HEAD)
cd "$out"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="$(git -C "$OLDPWD" config user.email)" \
  commit -q -m "docs: deploy $commit"
git push -q --force "$remote" gh-pages
echo "Published the docs from $commit to gh-pages."

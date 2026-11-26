#!/bin/sh
# Publish to GitHub Pages. Bumps the ?v= version on every file the page loads,
# so browsers never mix new and old (cached) files after an update.
# Usage: scripts/release.sh "commit message"
set -e
cd "$(dirname "$0")/.."
v=$(date +%s)
sed -i '' -E "s/\?v=[0-9]+/?v=$v/g" index.html js/app.js js/backend.js
git add -A
git commit -m "${1:-Update}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push

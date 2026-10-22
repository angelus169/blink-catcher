#!/usr/bin/env bash
# Builds dist/blink-catcher-<version>.zip: the files Chrome needs, nothing else.
# Upload it to the Chrome Web Store or attach it to a GitHub release.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/blink-catcher-$version.zip"
mkdir -p dist
rm -f "$out"
zip -q -X "$out" manifest.json detector.js content.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
echo "$out"

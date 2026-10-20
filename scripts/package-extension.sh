#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

if [ "$MANIFEST_VERSION" != "$PACKAGE_VERSION" ]; then
  echo "error: manifest.json version ($MANIFEST_VERSION) differs from package.json version ($PACKAGE_VERSION)" >&2
  exit 1
fi

pnpm build

OUT="$PWD/release/across-amazon-${MANIFEST_VERSION}.zip"
mkdir -p release
rm -f "$OUT"

(cd dist && zip -r -X -q "$OUT" . -x '*.map')

echo "Packaged $OUT"

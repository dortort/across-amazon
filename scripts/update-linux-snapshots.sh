#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PLAYWRIGHT_VERSION="$(node -p "require('@playwright/test/package.json').version")"
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

docker run --rm --ipc=host \
  -v "$PWD:/src:ro" \
  -v "$PWD/tests/e2e:/out" \
  -e CI=1 \
  "$IMAGE" bash -c '
    set -euo pipefail
    mkdir -p /work
    tar -C /src --exclude=node_modules --exclude=.git --exclude=dist --exclude=test-results --exclude=playwright-report -cf - . | tar -C /work -xf -
    cd /work
    corepack enable
    corepack prepare pnpm@10 --activate
    pnpm install --no-frozen-lockfile
    pnpm exec playwright test --update-snapshots=all "$@"
    for dir in tests/e2e/*-snapshots; do
      [ -d "$dir" ] && cp -r "$dir" /out/
    done
  ' bash "$@"

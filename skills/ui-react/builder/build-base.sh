#!/usr/bin/env bash
# Build the shared uireact-base image (the heavy toolkit, pull/build once per
# machine). Called automatically by build.sh when the tagged image is missing,
# or run by hand after bumping base/toolkit.version.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(tr -d '[:space:]' < "$here/base/toolkit.version")"
image="uireact-base:$version"

if docker image inspect "$image" >/dev/null 2>&1; then
  echo "[uireact] $image already present — skipping build (rm it to force rebuild)."
  exit 0
fi

echo "[uireact] building $image (arm64, installs the full toolkit — a few minutes)…"
docker build \
  --platform linux/arm64 \
  -t "$image" \
  -t "uireact-base:latest" \
  -f "$here/Dockerfile" \
  "$here"

echo "[uireact] built $image"

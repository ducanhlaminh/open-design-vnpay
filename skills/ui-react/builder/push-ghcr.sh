#!/usr/bin/env bash
# Publish uireact-base + od-agent-sandbox to the public registry (GHCR) as
# MULTI-ARCH images (arm64 + amd64), so fresh machines `docker pull` in the
# first-run wizard / `od sandbox build` instead of a 10-minute local build.
#
# Run this after bumping any of: base/toolkit.version, sandbox/sandbox.version,
# sandbox/claude.version — then commit the bumped pins so pullers match.
#
# Prereqs (one-time):
#   1. docker login ghcr.io -u <github-user>
#      → password = a GitHub PAT (classic) with the `write:packages` scope.
#   2. AFTER THE FIRST PUSH the GHCR packages are PRIVATE by default — flip
#      both to Public once, or every pull on user machines gets 401:
#        https://github.com/users/<owner>/packages/container/uireact-base/settings
#        https://github.com/users/<owner>/packages/container/od-agent-sandbox/settings
#
# The registry (owner) comes from the `registry` pin file next to this script;
# OD_SANDBOX_REGISTRY overrides. OD_GHCR_PLATFORMS overrides the arch list
# (e.g. OD_GHCR_PLATFORMS=linux/arm64 for a quick single-arch push).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
registry="${OD_SANDBOX_REGISTRY:-$(tr -d '[:space:]' < "$here/registry")}"
[ -n "$registry" ] && [ "$registry" != "off" ] || { echo "no registry configured (pin file 'registry' / OD_SANDBOX_REGISTRY)" >&2; exit 1; }

toolkit="$(tr -d '[:space:]' < "$here/base/toolkit.version")"
sandbox_version="$(tr -d '[:space:]' < "$here/sandbox/sandbox.version")"
claude_version="$(tr -d '[:space:]' < "$here/sandbox/claude.version")"
platforms="${OD_GHCR_PLATFORMS:-linux/arm64,linux/amd64}"

# Multi-arch needs a buildx builder (the default docker driver can't assemble
# multi-platform manifests). Created once, reused after.
builder_name="od-ghcr"
docker buildx inspect "$builder_name" >/dev/null 2>&1 || docker buildx create --name "$builder_name" >/dev/null

echo "[push-ghcr] uireact-base:$toolkit → $registry ($platforms)…"
docker buildx build \
  --builder "$builder_name" \
  --platform "$platforms" \
  -t "$registry/uireact-base:$toolkit" \
  -t "$registry/uireact-base:latest" \
  -f "$here/Dockerfile" \
  --push \
  "$here"

# The sandbox Dockerfile FROMs BASE_IMAGE; point it at the ref just pushed so
# buildx resolves a multi-arch base (a locally-built single-arch uireact-base
# would fail the cross-platform half of the build).
echo "[push-ghcr] od-agent-sandbox:$sandbox_version → $registry ($platforms, claude $claude_version)…"
docker buildx build \
  --builder "$builder_name" \
  --platform "$platforms" \
  --build-arg TOOLKIT_VERSION="$toolkit" \
  --build-arg CLAUDE_CODE_VERSION="$claude_version" \
  --build-arg BASE_IMAGE="$registry/uireact-base:$toolkit" \
  -t "$registry/od-agent-sandbox:$sandbox_version" \
  -t "$registry/od-agent-sandbox:latest" \
  -f "$here/sandbox/Dockerfile" \
  --push \
  "$here/sandbox"

echo "[push-ghcr] done:"
echo "  $registry/uireact-base:$toolkit"
echo "  $registry/od-agent-sandbox:$sandbox_version"
echo "Reminder: first push → set both packages to Public on GitHub, or pulls will 401."

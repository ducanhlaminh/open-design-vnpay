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

# Build for the HOST's native arch — arm64 on Apple Silicon, amd64 on
# Intel mac / Windows / Linux — so the container never runs under QEMU
# emulation. OD_DOCKER_PLATFORM overrides when cross-building intentionally.
case "$(uname -m)" in
  arm64|aarch64) native="linux/arm64" ;;
  *)             native="linux/amd64" ;;
esac
platform="${OD_DOCKER_PLATFORM:-$native}"

# Pull-first: the image is published multi-arch on a public registry (pin file
# `registry`, pushed by push-ghcr.sh). OD_SANDBOX_REGISTRY overrides the pin;
# `off` disables. Any pull failure falls through to the local build.
registry="${OD_SANDBOX_REGISTRY:-}"
if [ -z "$registry" ] && [ -f "$here/registry" ]; then
  registry="$(tr -d '[:space:]' < "$here/registry")"
fi
if [ -n "$registry" ] && [ "$registry" != "off" ]; then
  echo "[uireact] pulling $registry/$image ($platform)…"
  if docker pull --platform "$platform" "$registry/$image"; then
    docker tag "$registry/$image" "$image"
    docker tag "$registry/$image" "uireact-base:latest"
    echo "[uireact] pulled $image from $registry"
    exit 0
  fi
  echo "[uireact] pull failed — building locally…" >&2
fi

echo "[uireact] building $image ($platform, installs the full toolkit — a few minutes)…"
docker build \
  --platform "$platform" \
  -t "$image" \
  -t "uireact-base:latest" \
  -f "$here/Dockerfile" \
  "$here"

echo "[uireact] built $image"

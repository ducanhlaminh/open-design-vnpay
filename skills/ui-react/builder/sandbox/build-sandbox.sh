#!/usr/bin/env bash
# Build the od-agent-sandbox image (agent CLI + uireact toolkit, one per
# machine). Run by hand or via `od sandbox build` after bumping
# sandbox.version / claude.version, or after rebuilding uireact-base.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(tr -d '[:space:]' < "$here/sandbox.version")"
claude_version="$(tr -d '[:space:]' < "$here/claude.version")"
codex_version="$(tr -d '[:space:]' < "$here/codex.version")"
toolkit_version="$(tr -d '[:space:]' < "$here/../base/toolkit.version")"
image="od-agent-sandbox:$version"

if docker image inspect "$image" >/dev/null 2>&1 && [ "${1:-}" != "--force" ]; then
  echo "[sandbox] $image already present — skipping build (--force to rebuild)."
  exit 0
fi

# Pull-first (skipped on --force, which means "rebuild locally"): the image is
# published multi-arch on a public registry (pin file `../registry`, pushed by
# push-ghcr.sh). OD_SANDBOX_REGISTRY overrides the pin; `off` disables. Any
# pull failure falls through to the local build.
if [ "${1:-}" != "--force" ]; then
  case "$(uname -m)" in
    arm64|aarch64) pull_native="linux/arm64" ;;
    *)             pull_native="linux/amd64" ;;
  esac
  pull_platform="${OD_DOCKER_PLATFORM:-$pull_native}"
  registry="${OD_SANDBOX_REGISTRY:-}"
  if [ -z "$registry" ] && [ -f "$here/../registry" ]; then
    registry="$(tr -d '[:space:]' < "$here/../registry")"
  fi
  if [ -n "$registry" ] && [ "$registry" != "off" ]; then
    echo "[sandbox] pulling $registry/$image ($pull_platform)…"
    if docker pull --platform "$pull_platform" "$registry/$image"; then
      docker tag "$registry/$image" "$image"
      docker tag "$registry/$image" "od-agent-sandbox:latest"
      echo "[sandbox] pulled $image from $registry"
      # Best-effort: fetch the base too (per-project ui-react builds run on
      # it); build-base.sh pulls/builds it lazily later if this fails.
      if ! docker image inspect "uireact-base:$toolkit_version" >/dev/null 2>&1; then
        if docker pull --platform "$pull_platform" "$registry/uireact-base:$toolkit_version"; then
          docker tag "$registry/uireact-base:$toolkit_version" "uireact-base:$toolkit_version"
          docker tag "$registry/uireact-base:$toolkit_version" "uireact-base:latest"
        fi
      fi
      exit 0
    fi
    echo "[sandbox] pull failed — building locally…" >&2
  fi
fi

# The base layer must exist first (build-base.sh has its own idempotence).
if ! docker image inspect "uireact-base:$toolkit_version" >/dev/null 2>&1; then
  echo "[sandbox] uireact-base:$toolkit_version missing — building it first…" >&2
  "$here/../build-base.sh"
fi

# Serialize concurrent builds (two agents hitting a missing image at once
# would otherwise race the same tag). mkdir is the portable mutex on macOS
# (no flock(1) in the default userland).
lockdir="${TMPDIR:-/tmp}/od-agent-sandbox-build.lock"
if ! mkdir "$lockdir" 2>/dev/null; then
  echo "[sandbox] another build is running (lock: $lockdir) — waiting…" >&2
  while [ -d "$lockdir" ]; do sleep 2; done
  docker image inspect "$image" >/dev/null 2>&1 && exit 0
  mkdir "$lockdir" 2>/dev/null || { echo "[sandbox] lock contention, retry later" >&2; exit 1; }
fi
trap 'rmdir "$lockdir" 2>/dev/null || true' EXIT

# Native host arch (arm64 on Apple Silicon, amd64 on Intel/Windows/Linux) so
# the agent container never runs under QEMU. OD_DOCKER_PLATFORM overrides.
case "$(uname -m)" in
  arm64|aarch64) native="linux/arm64" ;;
  *)             native="linux/amd64" ;;
esac
platform="${OD_DOCKER_PLATFORM:-$native}"

echo "[sandbox] building $image ($platform, base uireact-base:$toolkit_version, claude $claude_version, codex $codex_version)…"
docker build \
  --platform "$platform" \
  --build-arg TOOLKIT_VERSION="$toolkit_version" \
  --build-arg CLAUDE_CODE_VERSION="$claude_version" \
  --build-arg CODEX_VERSION="$codex_version" \
  -t "$image" \
  -t "od-agent-sandbox:latest" \
  -f "$here/Dockerfile" \
  "$here"

echo "[sandbox] built $image"

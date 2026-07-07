#!/usr/bin/env bash
#
# build.sh — the docs-to-react build backend.
#
# Runs the per-project React app (agent-authored `src/` + isolated config in the
# project CWD) through the SHARED uireact-base toolkit inside a throwaway,
# network-less Docker container, and drops the built `dist/` back into the
# project. The ui-react skill calls this in a loop: author src → build.sh → read
# errors → fix → repeat until green.
#
# Usage:  build.sh [<project-react-dir>]        (default: ./react)
# Env:    UIREACT_PROJECT_ID   stable id for the warm vite-cache volume
#         UIREACT_SKIP_TSC=1   skip the tsc gate (vite build only)
#         UIREACT_IN_SANDBOX=1 agent-in-sandbox mode: we are ALREADY inside the
#                              od-agent-sandbox container (toolkit at
#                              /work/node_modules), so run the gate directly —
#                              no nested docker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="$(tr -d '[:space:]' < "$here/base/toolkit.version")"
image="uireact-base:$version"

# ── target project dir (holds config + src; dist lands here) ───────────────────
target="${1:-./react}"
mkdir -p "$target"
target="$(cd "$target" && pwd)"

# ── agent-in-sandbox: build in-place, no docker ────────────────────────────────
# The od-agent-sandbox image layers the agent CLI on uireact-base, so the same
# toolkit that the docker path mounts is already at /work/node_modules and
# vite/tsc are on PATH. Seed + gate directly; dist lands at <target>/dist.
if [ "${UIREACT_IN_SANDBOX:-0}" = "1" ]; then
  cp -Rn "$here/template/." "$target/" 2>/dev/null || true
  printf 'sandbox:%s\n' "$version" > "$target/.uireact-base"
  export VITE_CACHE_DIR="${VITE_CACHE_DIR:-/work/.vite-cache}"
  gate='vite build'
  [ "${UIREACT_SKIP_TSC:-0}" = "1" ] || gate='tsc --noEmit && vite build'
  echo "[uireact] building $target in-sandbox (gate: $gate)"
  ( cd "$target" && sh -c "$gate" )
  echo "[uireact] OK → $target/dist"
  exit 0
fi

# Stable id → warm cache volume survives across builds of the same project.
projid="${UIREACT_PROJECT_ID:-$(printf '%s' "$target" | shasum | cut -c1-12)}"
cache_vol="uireact-cache-$projid"

# ── preflight ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "[uireact] ERROR: docker not found. Install Docker/OrbStack (arm64)." >&2
  exit 127
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "[uireact] base image $image missing — building it first…" >&2
  "$here/build-base.sh"
fi

# ── seed the scaffold (idempotent: never clobbers agent-authored files) ───────
# Copies config (package.json, vite/tsconfig, index.html) + the VNPAY DS
# components/ui + a sample src/ on the FIRST run; on later runs -n preserves
# everything the agent has since edited.
cp -Rn "$here/template/." "$target/" 2>/dev/null || true
printf '%s\n' "$image" > "$target/.uireact-base"

# ── build in an isolated, network-less container ──────────────────────────────
# node_modules resolves from /work/node_modules (parent of the /work/app mount),
# so nothing is written into the host project dir. dist is written straight to
# the mount → appears at <target>/dist on the host. No docker cp needed.
gate='vite build'
[ "${UIREACT_SKIP_TSC:-0}" = "1" ] || gate='tsc --noEmit && vite build'

echo "[uireact] building $target  (image=$image, gate: $gate)"
docker run --rm \
  -v "$target":/work/app \
  -v "$cache_vol":/work/.vite-cache \
  -e VITE_CACHE_DIR=/work/.vite-cache \
  --tmpfs /tmp \
  --network none \
  --user node \
  --cap-drop ALL \
  --pids-limit 512 \
  --cpus "${UIREACT_CPUS:-1.5}" \
  --memory "${UIREACT_MEMORY:-2g}" \
  -w /work/app \
  "$image" \
  sh -c "$gate"

echo "[uireact] OK → $target/dist"

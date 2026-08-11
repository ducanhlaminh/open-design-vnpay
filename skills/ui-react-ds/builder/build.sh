#!/usr/bin/env bash
#
# build.sh — the UI-Spec (React DS) build backend.
#
# Same isolated-toolkit contract as skills/ui-react/builder/build.sh (which
# owns the shared uireact-base image + version), but seeds THIS skill's
# template: a plain Vite + React app with NO Tailwind/shadcn — screens compose
# from the imported design system's react bundle staged by the daemon at
# ./react-ds/src/ds/ (components/ui + lib/runtime + styles/globals.css).
#
# Usage:  build.sh [<project-react-ds-dir>]      (default: ./react-ds)
# Env:    UIREACT_PROJECT_ID   stable id for the warm vite-cache volume
#         UIREACT_SKIP_TSC=1   skip the tsc gate (vite build only)
#         UIREACT_IN_SANDBOX=1 already inside the od-agent-sandbox container
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uireact="$here/../../ui-react/builder"
version="$(tr -d '[:space:]' < "$uireact/base/toolkit.version")"
image="uireact-base:$version"

# ── target project dir (holds config + src; dist lands here) ───────────────────
target="${1:-./react-ds}"
mkdir -p "$target"
target="$(cd "$target" && pwd)"

# ── agent-in-sandbox: build in-place, no docker ────────────────────────────────
if [ "${UIREACT_IN_SANDBOX:-0}" = "1" ]; then
  cp -Rn "$here/template/." "$target/" 2>/dev/null || true
  printf 'sandbox:%s\n' "$version" > "$target/.uireact-base"
  export VITE_CACHE_DIR="${VITE_CACHE_DIR:-/work/.vite-cache}"
  gate='vite build'
  [ "${UIREACT_SKIP_TSC:-0}" = "1" ] || gate='tsc --noEmit && vite build'
  echo "[uireact-ds] building $target in-sandbox (gate: $gate)"
  ( cd "$target" && sh -c "$gate" )
  node "$here/verify.mjs" "$target"
  echo "[uireact-ds] OK → $target/dist"
  exit 0
fi

projid="${UIREACT_PROJECT_ID:-$(printf '%s' "$target" | shasum | cut -c1-12)}"
cache_vol="uireact-cache-$projid"

# ── preflight ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "[uireact-ds] ERROR: docker not found. Install Docker/OrbStack (arm64)." >&2
  exit 127
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "[uireact-ds] base image $image missing — building it first…" >&2
  "$uireact/build-base.sh"
fi

# ── seed the scaffold (idempotent: never clobbers agent/daemon files) ─────────
cp -Rn "$here/template/." "$target/" 2>/dev/null || true
printf '%s\n' "$image" > "$target/.uireact-base"

# ── build in an isolated, network-less container ──────────────────────────────
gate='vite build'
[ "${UIREACT_SKIP_TSC:-0}" = "1" ] || gate='tsc --noEmit && vite build'

echo "[uireact-ds] building $target  (image=$image, gate: $gate)"
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

# ── design-system gate: token qua class tk-*, khung màn dùng component DS ─────
# (chạy trên host — chỉ đọc file, không cần toolchain trong container)
node "$here/verify.mjs" "$target"

echo "[uireact-ds] OK → $target/dist"

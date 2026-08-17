#!/usr/bin/env bash
# Open Design — host runtime tarball builder (WP6).
#
# Produces open-design-runtime-<version>-<platform>.tar.gz: a single-process,
# Electron-free bundle of the daemon (apps/daemon/dist + production
# node_modules), the static web export (apps/web/out), the same resource
# trees packaged desktop builds ship (skills/design-templates/design-systems/
# craft/plugins/prompt-templates — reused verbatim from
# tools/pack/src/resources.ts via copy-resources.ts, not re-derived here),
# launchd/systemd service templates, a self-contained copy of
# deploy/host/install.sh (for --update), VERSION, manifest.sha256, and a
# release.json fragment.
#
# platform is one of: darwin-arm64 | darwin-x64 | linux-x64 | win32-x64 (Node
# dist naming). Per-platform artifacts are mandatory because better-sqlite3
# (native) and fsevents (darwin) are architecture-specific. The win32-x64 leg
# runs this same bash script unmodified via the Git Bash bundled on
# windows-latest GitHub Actions runners — see
# .github/workflows/release-host-runtime.yml.
#
# Usage:
#   scripts/host-runtime/build-runtime.sh [options]
#
# Options:
#   --platform <darwin-arm64|darwin-x64|linux-x64|win32-x64>   Target platform (default: current host).
#   --version <x.y.z>                                Runtime version (default: root package.json).
#   --out-dir <dir>                                   Output directory (default: .tmp/host-runtime/out).
#   --skip-install                                     Skip `pnpm install` (assume deps already installed).
#   --skip-build                                       Skip daemon/web build (assume dist/out already built).
#   -h, --help                                         Show this help.
set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# On Git Bash (Windows), $WORKSPACE_ROOT is a POSIX-style path (/d/a/...).
# That's fine for bash/cp/mkdir, but native windows node.exe cannot resolve it
# inside a require('...') string -- it fails with MODULE_NOT_FOUND on the
# literal "/d/a/..." text. cygpath -m converts it to a drive-letter path with
# forward slashes (D:/a/...), which node.exe accepts on every platform. No-op
# on macOS/Linux, where cygpath doesn't exist.
to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

OPT_PLATFORM=""
OPT_VERSION=""
OPT_OUT_DIR=""
OPT_SKIP_INSTALL=0
OPT_SKIP_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) shift; OPT_PLATFORM="${1:-}" ;;
    --platform=*) OPT_PLATFORM="${1#--platform=}" ;;
    --version) shift; OPT_VERSION="${1:-}" ;;
    --version=*) OPT_VERSION="${1#--version=}" ;;
    --out-dir) shift; OPT_OUT_DIR="${1:-}" ;;
    --out-dir=*) OPT_OUT_DIR="${1#--out-dir=}" ;;
    --skip-install) OPT_SKIP_INSTALL=1 ;;
    --skip-build) OPT_SKIP_BUILD=1 ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

log()  { printf '[build-runtime] %s\n' "$1"; }
fail() { printf '[build-runtime] ERROR: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Resolve target platform (Node dist naming: darwin-arm64 / darwin-x64 / linux-x64)
# ---------------------------------------------------------------------------
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

host_platform() {
  case "$HOST_OS" in
    Darwin)
      case "$HOST_ARCH" in
        arm64) echo "darwin-arm64" ;;
        x86_64) echo "darwin-x64" ;;
        *) fail "unsupported host arch: ${HOST_ARCH}" ;;
      esac
      ;;
    Linux)
      case "$HOST_ARCH" in
        x86_64) echo "linux-x64" ;;
        *) fail "unsupported host arch for linux: ${HOST_ARCH} (only linux-x64 is supported)" ;;
      esac
      ;;
    *) fail "unsupported host OS: ${HOST_OS}" ;;
  esac
}

PLATFORM="${OPT_PLATFORM:-$(host_platform)}"
case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-x64|win32-x64) ;;
  *) fail "--platform must be one of darwin-arm64, darwin-x64, linux-x64, win32-x64 (got: ${PLATFORM})" ;;
esac

PLATFORM_OS="${PLATFORM%%-*}"
PLATFORM_ARCH="${PLATFORM##*-}"
NPM_ARCH="$([ "$PLATFORM_ARCH" = "x64" ] && echo "x64" || echo "arm64")"

case "$HOST_OS" in
  Darwin) HOST_PLATFORM_OS="darwin" ;;
  Linux)  HOST_PLATFORM_OS="linux" ;;
  # windows-latest GitHub Actions runners execute this script through the
  # bundled Git Bash, which reports itself as MINGW64_NT-* (or MSYS_NT-*
  # depending on the Git-for-Windows build) via `uname -s` — not "Windows".
  # CI always passes --platform explicitly (see host_platform()'s doc note
  # above), so this branch only matters for the cross-OS guard below.
  MINGW*|MSYS*|CYGWIN*) HOST_PLATFORM_OS="win32" ;;
  *)      HOST_PLATFORM_OS="unknown" ;;
esac

if [ "$PLATFORM_OS" != "$HOST_PLATFORM_OS" ]; then
  fail "cross-OS build not supported (host is ${HOST_PLATFORM_OS}, requested ${PLATFORM_OS}). Build on a matching OS/CI runner."
fi

CROSS_ARCH=0
if [ "$NPM_ARCH" != "$HOST_ARCH" ] && { [ "$HOST_ARCH" = "arm64" ] || [ "$HOST_ARCH" = "x86_64" ]; }; then
  # x86_64 host arch reported by uname maps to npm's "x64" — only flag a real
  # cross-arch build when the mapped arches actually differ.
  HOST_NPM_ARCH="$([ "$HOST_ARCH" = "x86_64" ] && echo "x64" || echo "$HOST_ARCH")"
  [ "$NPM_ARCH" != "$HOST_NPM_ARCH" ] && CROSS_ARCH=1
fi

# ---------------------------------------------------------------------------
# 2. Resolve version + output paths
# ---------------------------------------------------------------------------
VERSION="${OPT_VERSION:-$(node -p "require('$(to_node_path "${WORKSPACE_ROOT}/package.json")').version")}"
[ -n "$VERSION" ] || fail "could not resolve version (pass --version explicitly)"

OUT_DIR="${OPT_OUT_DIR:-${WORKSPACE_ROOT}/.tmp/host-runtime/out}"
STAGE_NAME="open-design-runtime-${VERSION}-${PLATFORM}"
STAGE_DIR="${OUT_DIR}/${STAGE_NAME}"
TARBALL="${OUT_DIR}/${STAGE_NAME}.tar.gz"

PLATFORM_SUFFIX=""
[ "$CROSS_ARCH" = "1" ] && PLATFORM_SUFFIX=" (cross-arch best-effort — prefer a native ${PLATFORM} runner)"

log "workspace root: ${WORKSPACE_ROOT}"
log "platform:       ${PLATFORM}${PLATFORM_SUFFIX}"
log "version:        ${VERSION}"
log "output:         ${TARBALL}"

mkdir -p "$OUT_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# ---------------------------------------------------------------------------
# 3. Install + build (daemon dist, web static export)
# ---------------------------------------------------------------------------
if [ "$OPT_SKIP_INSTALL" = "0" ]; then
  log "pnpm install --frozen-lockfile"
  (cd "$WORKSPACE_ROOT" && pnpm install --frozen-lockfile)
fi

if [ "$OPT_SKIP_BUILD" = "0" ]; then
  log "building @open-design/daemon"
  (cd "$WORKSPACE_ROOT" && pnpm --filter @open-design/daemon build)

  log "building @open-design/web (static export — OD_WEB_OUTPUT_MODE unset)"
  (cd "$WORKSPACE_ROOT" && unset OD_WEB_OUTPUT_MODE; pnpm --filter @open-design/web build)
fi

[ -f "${WORKSPACE_ROOT}/apps/daemon/dist/cli.js" ] || fail "apps/daemon/dist/cli.js missing — build failed or --skip-build used without a prior build"
[ -d "${WORKSPACE_ROOT}/apps/web/out" ] || fail "apps/web/out missing — static export failed or --skip-build used without a prior build"

# ---------------------------------------------------------------------------
# 4. Deploy production daemon (dist + prod-only node_modules for PLATFORM)
#    Mirrors deploy/Dockerfile's `pnpm deploy --legacy --prod` recipe.
# ---------------------------------------------------------------------------
mkdir -p "${STAGE_DIR}/apps/daemon"
log "pnpm deploy --legacy --prod (native deps resolved for ${PLATFORM})"
# --config.node-linker=hoisted: without this, pnpm links workspace packages
# (e.g. @open-design/contracts) through node_modules/.pnpm/<pkg>/node_modules
# symlinks, and resolves THAT package's own deps (e.g. zod) as siblings only
# reachable by following the symlink. Step 10's `tar -czhf -h` (dereference,
# required so Windows extraction doesn't need symlink privilege) then copies
# just the symlink target's own directory -- dropping those sibling deps
# entirely, so e.g. zod silently goes missing from the shipped tarball
# (reproduced locally: `import('.../@open-design/contracts/dist/index.mjs')`
# throws ERR_MODULE_NOT_FOUND for 'zod' without this flag). Hoisted linker
# writes every dep as a real top-level directory, no .pnpm virtual store, so
# there's nothing for dereferencing to lose.
if [ "$CROSS_ARCH" = "1" ]; then
  log "cross-arch install: npm_config_arch=${NPM_ARCH} (best-effort; relies on prebuilt binaries — a native runner is preferred, see .github/workflows/release-host-runtime.yml)"
  (
    cd "$WORKSPACE_ROOT"
    npm_config_arch="$NPM_ARCH" npm_config_platform="$PLATFORM_OS" \
      pnpm --filter @open-design/daemon deploy --legacy --prod --config.node-linker=hoisted "${STAGE_DIR}/apps/daemon"
  )
else
  (cd "$WORKSPACE_ROOT" && pnpm --filter @open-design/daemon deploy --legacy --prod --config.node-linker=hoisted "${STAGE_DIR}/apps/daemon")
fi

# Prune dev-only cruft from the deployed node_modules — mirrors deploy/Dockerfile
# so the tarball stays lean and never carries test fixtures / source maps.
find "${STAGE_DIR}/apps/daemon/node_modules" -type d \( \
    -name test -o \
    -name tests -o \
    -name "__tests__" -o \
    -name docs -o \
    -name doc -o \
    -name example -o \
    -name examples -o \
    -name ".github" \
  \) -prune -exec rm -rf '{}' + 2>/dev/null || true
find "${STAGE_DIR}/apps/daemon/node_modules" -type f \( \
    -name "*.md" -o \
    -name "*.markdown" -o \
    -name "*.d.ts" -o \
    -name "*.d.cts" -o \
    -name "*.d.mts" -o \
    -name "*.map" -o \
    -name "*.tsbuildinfo" -o \
    -name "binding.gyp" \
  \) -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Web static export
# ---------------------------------------------------------------------------
mkdir -p "${STAGE_DIR}/apps/web"
cp -R "${WORKSPACE_ROOT}/apps/web/out" "${STAGE_DIR}/apps/web/out"

# ---------------------------------------------------------------------------
# 6. Bundled resource trees — reused verbatim from tools/pack/src/resources.ts
#    (skills, design-templates, design-systems, craft, plugins/_official,
#    plugins/registry, prompt-templates, assets/frames → frames,
#    assets/community-pets → community-pets). The daemon is started with
#    OD_RESOURCE_ROOT=<install>/current/resources/open-design so it resolves
#    every one of these from this single tree — see
#    apps/daemon/src/server.ts:resolveDaemonResourceDir.
# ---------------------------------------------------------------------------
log "copying bundled resource trees (reusing tools/pack/src/resources.ts)"
node --experimental-strip-types "${SCRIPT_DIR}/copy-resources.ts" \
  "$WORKSPACE_ROOT" "${STAGE_DIR}/resources/open-design"

# ---------------------------------------------------------------------------
# 7. Service templates + self-contained install.sh copy (for --update) + VERSION
# ---------------------------------------------------------------------------
mkdir -p "${STAGE_DIR}/runtime/service"
cp "${SCRIPT_DIR}/service/com.vnpay.open-design.plist.in" "${STAGE_DIR}/runtime/service/"
cp "${SCRIPT_DIR}/service/open-design.service.in" "${STAGE_DIR}/runtime/service/"

cp "${WORKSPACE_ROOT}/deploy/host/install.sh" "${STAGE_DIR}/install.sh"
chmod +x "${STAGE_DIR}/install.sh"

# win32-x64 also gets a self-contained copy of install.ps1 (its --update
# entrypoint is `powershell -File <current>/install.ps1 -Update`, mirroring
# install.sh's own bundled copy above). The unconditional install.sh copy
# above stays too — harmless unused weight on a Windows tarball, kept
# unconditional deliberately so this step doesn't need a platform branch for
# the darwin/linux case.
if [ "$PLATFORM" = "win32-x64" ]; then
  cp "${WORKSPACE_ROOT}/deploy/host/install.ps1" "${STAGE_DIR}/install.ps1"
fi

# Bundled env defaults (CONFLUENCE_URL/MEDIA_*/IDENTITY_URL/GOOGLE_CLIENT_*/SESSION_SECRET)
# -- ONLY written when the calling environment actually provides them (CI,
# from GitHub Actions secrets; unset for a plain local/dev build, which
# gets no bundled file and behaves exactly as before). install.sh/
# install.ps1 read this from inside the extracted release as their last
# fallback before "unconfigured", so a fresh install needs zero flags.
# This is a deliberate choice for this specific repo's release pipeline
# despite the repo being public (see release-host-runtime.yml) -- it is
# NOT a default other forks/deployments should copy without the same
# tradeoff being intentional there too.
if [ -n "${CONFLUENCE_URL:-}" ] || [ -n "${MEDIA_URL:-}" ]; then
  log "bundling host-env.template"
  {
    [ -n "${CONFLUENCE_URL:-}" ] && printf 'CONFLUENCE_URL=%s\n' "$CONFLUENCE_URL"
    [ -n "${MEDIA_URL:-}" ] && printf 'MEDIA_URL=%s\n' "$MEDIA_URL"
    [ -n "${MEDIA_APP_ID:-}" ] && printf 'MEDIA_APP_ID=%s\n' "$MEDIA_APP_ID"
    [ -n "${MEDIA_USER_ID:-}" ] && printf 'MEDIA_USER_ID=%s\n' "$MEDIA_USER_ID"
    [ -n "${MEDIA_USER_ROLE:-}" ] && printf 'MEDIA_USER_ROLE=%s\n' "$MEDIA_USER_ROLE"
    [ -n "${IDENTITY_URL:-}" ] && printf 'IDENTITY_URL=%s\n' "$IDENTITY_URL"
    [ -n "${GOOGLE_CLIENT_ID:-}" ] && printf 'GOOGLE_CLIENT_ID=%s\n' "$GOOGLE_CLIENT_ID"
    [ -n "${GOOGLE_CLIENT_SECRET:-}" ] && printf 'GOOGLE_CLIENT_SECRET=%s\n' "$GOOGLE_CLIENT_SECRET"
    [ -n "${SESSION_SECRET:-}" ] && printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
  } > "${STAGE_DIR}/host-env.template"
fi

printf '%s\n' "$VERSION" > "${STAGE_DIR}/VERSION"

# ---------------------------------------------------------------------------
# 8. manifest.sha256 — checksum of every bundled file, verifiable with
#    `shasum -c manifest.sha256` (or `sha256sum -c`) from inside STAGE_DIR.
# ---------------------------------------------------------------------------
sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

log "writing manifest.sha256"
(
  cd "$STAGE_DIR"
  find . -type f ! -name manifest.sha256 -print | sort | while IFS= read -r f; do
    sha256_tool "$f"
  done
) > "${STAGE_DIR}/manifest.sha256"

# ---------------------------------------------------------------------------
# 9. release.json fragment (per-platform). The release workflow merges every
#    platform's fragment into one release-level release.json asset.
# ---------------------------------------------------------------------------
NODE_ENGINE="$(node -p "require('$(to_node_path "${WORKSPACE_ROOT}/apps/daemon/package.json")').engines.node")"
BUILT_AT="$(node -p "new Date().toISOString()")"
cat > "${STAGE_DIR}/release.json" <<JSON
{
  "version": "${VERSION}",
  "platform": "${PLATFORM}",
  "tarball": "${STAGE_NAME}.tar.gz",
  "nodeEngine": "${NODE_ENGINE}",
  "builtAt": "${BUILT_AT}"
}
JSON

# ---------------------------------------------------------------------------
# 10. Tarball — single root directory (STAGE_NAME) so install.sh's tar-safety
#     check (exactly one top-level entry, no `..` path) always holds.
# ---------------------------------------------------------------------------
log "creating tarball"
# -h/--dereference: pnpm's .pnpm virtual-store node_modules layout links
# packages via symlinks that pnpm records with an ABSOLUTE path anchored to
# wherever they were built (this CI runner's own temp workspace) -- those
# targets don't exist on any machine the tarball gets extracted onto.
# Symlink creation on Windows also requires an elevated privilege install.ps1
# deliberately doesn't have. Dereferencing at archive-creation time replaces
# every symlink with a real copy of its target, so the tarball is a flat,
# fully portable, symlink-free tree on every platform.
(cd "$OUT_DIR" && tar -czhf "${STAGE_NAME}.tar.gz" "$STAGE_NAME")
(cd "$OUT_DIR" && sha256_tool "${STAGE_NAME}.tar.gz") > "${TARBALL}.sha256"

log "done: ${TARBALL}"
log "      ${TARBALL}.sha256"

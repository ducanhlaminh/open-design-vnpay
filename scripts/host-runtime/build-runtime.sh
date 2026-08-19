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
# better-sqlite3 ships its C sources (deps/sqlite3/sqlite3.c alone is 9 MB
# raw) and node-gyp inputs next to the prebuilt build/Release/*.node the
# daemon actually loads. Nothing at runtime reads them -- they only matter
# for a from-source rebuild, which pnpm deploy already did on this runner.
# ~2.5 MB of the compressed tarball for a 100 % dead-weight subtree.
rm -rf "${STAGE_DIR}/apps/daemon/node_modules/better-sqlite3/deps" \
       "${STAGE_DIR}/apps/daemon/node_modules/better-sqlite3/src" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Web static export
# ---------------------------------------------------------------------------
mkdir -p "${STAGE_DIR}/apps/web"
cp -R "${WORKSPACE_ROOT}/apps/web/out" "${STAGE_DIR}/apps/web/out"
# Next's static export leaves a source map next to every chunk (~4.5 MB
# compressed, one of them 10 MB raw). Browsers only fetch .map files when
# DevTools is open and a 404 there is harmless -- the daemon serves the
# export as-is and never reads them. Same rule the node_modules prune above
# already applies.
find "${STAGE_DIR}/apps/web/out" -type f -name "*.map" -delete 2>/dev/null || true

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
# 6b. Trim the resource tree. Measured on 0.8.48: the tarball was 104 MB
#     compressed and 81 MB of that was resources/ -- the actual app (daemon +
#     web export) is ~19 MB. Two kinds of weight go here:
#
#     (1) Human-only documentation imagery bundled next to a template:
#         design-templates/*/docs/readme (README hero.gif/screenshots) and
#         design-templates/*/scripts/verify-output (self-test screenshots).
#         Nothing resolves them at runtime -- SKILL.md files never reference
#         them; only the template's own README.md (which we ship for humans,
#         not for the daemon) does.
#     (2) Byte-identical duplicates: plugins/_official/examples/<x>/assets is
#         a verbatim copy of design-templates/<x>/assets for some templates
#         (open-design-landing alone: 22 MB of PNGs, twice). Both paths must
#         stay valid at runtime, so instead of deleting one we HARDLINK the
#         duplicate to the first copy. tar (GNU and bsdtar alike) records the
#         second occurrence of a hard-linked file as a link entry, and every
#         extractor we target (GNU tar, bsdtar, Windows 10+ tar.exe) recreates
#         it as a hard link on NTFS/APFS/ext4 -- so the bytes travel once and
#         both files exist after extraction. If `ln` is unavailable for any
#         reason the file is left as a plain copy (no savings, still correct).
#         Only files >= 256 KB are considered: below that the bookkeeping
#         costs more than it saves.
#
#     Deliberately NOT removed (they back live features): community-pets
#     (web pet UI), skills/*/assets (agents copy them into outputs),
#     plugins/_official/examples themselves.
# ---------------------------------------------------------------------------
RESOURCE_ROOT="${STAGE_DIR}/resources/open-design"
log "trimming resource tree: template README/self-test imagery"
find "${RESOURCE_ROOT}/design-templates" -mindepth 2 -maxdepth 3 -type d \
  \( -path "*/docs/readme" -o -path "*/scripts/verify-output" \) \
  -prune -exec rm -rf '{}' + 2>/dev/null || true

log "deduplicating identical resource files (>= 256 KB) via hard links"
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}
DEDUPE_FILES=0
DEDUPE_BYTES=0
while IFS="$(printf '\t')" read -r keep dup; do
  [ -n "${dup:-}" ] || continue
  size="$(wc -c < "${RESOURCE_ROOT}/${dup}" | tr -d ' ')"
  if ln -f "${RESOURCE_ROOT}/${keep}" "${RESOURCE_ROOT}/${dup}" 2>/dev/null; then
    DEDUPE_FILES=$((DEDUPE_FILES + 1))
    DEDUPE_BYTES=$((DEDUPE_BYTES + size))
  fi
done < <(
  cd "$RESOURCE_ROOT" \
    && find . -type f -size +256k -print \
    | while IFS= read -r f; do sha256_of "$f"; done \
    | sort \
    | awk '{ h = substr($0, 1, 64); p = substr($0, 67); sub(/^\.\//, "", p);
             if (h in first) { printf "%s\t%s\n", first[h], p } else { first[h] = p } }'
)
log "deduplicated ${DEDUPE_FILES} file(s), ${DEDUPE_BYTES} bytes now stored once"

# ---------------------------------------------------------------------------
# 7. Service templates + self-contained install.sh copy (for --update) + VERSION
# ---------------------------------------------------------------------------
mkdir -p "${STAGE_DIR}/runtime/service"
cp "${SCRIPT_DIR}/service/com.vnpay.open-design.plist.in" "${STAGE_DIR}/runtime/service/"
cp "${SCRIPT_DIR}/service/open-design.service.in" "${STAGE_DIR}/runtime/service/"

cp "${WORKSPACE_ROOT}/deploy/host/install.sh" "${STAGE_DIR}/install.sh"
chmod +x "${STAGE_DIR}/install.sh"

# Darwin-only: stage the same 4 macOS double-click launchers INSIDE the
# tarball too (runtime/launchers/), so install.sh's install_mac_launchers()
# can copy them out onto disk as freshly-created, unquarantined files after
# extraction -- com.apple.quarantine only ever attaches to a browser
# download, never to a file a script copies from an already-verified local
# payload. deploy/host/*.command stays the single source of truth; this is a
# copy for the payload, not a fork -- OpenDesign-macOS-Installer.zip below
# still ships the same 4 files for the browser-download path, which DOES
# pick up quarantine (unavoidably, that's the part this feature works around).
case "$PLATFORM" in
  darwin-*)
    mkdir -p "${STAGE_DIR}/runtime/launchers"
    cp "${WORKSPACE_ROOT}/deploy/host/install.command" "${STAGE_DIR}/runtime/launchers/OpenDesign-Install.command"
    cp "${WORKSPACE_ROOT}/deploy/host/update.command" "${STAGE_DIR}/runtime/launchers/OpenDesign-Update.command"
    cp "${WORKSPACE_ROOT}/deploy/host/start.command" "${STAGE_DIR}/runtime/launchers/OpenDesign-Start.command"
    cp "${WORKSPACE_ROOT}/deploy/host/stop.command" "${STAGE_DIR}/runtime/launchers/OpenDesign-Stop.command"
    chmod +x "${STAGE_DIR}/runtime/launchers"/*.command
    ;;
esac

# win32-x64 also gets a self-contained copy of install.ps1 (its --update
# entrypoint is `powershell -File <current>/install.ps1 -Update`, mirroring
# install.sh's own bundled copy above). The unconditional install.sh copy
# above stays too — harmless unused weight on a Windows tarball, kept
# unconditional deliberately so this step doesn't need a platform branch for
# the darwin/linux case.
if [ "$PLATFORM" = "win32-x64" ]; then
  cp "${WORKSPACE_ROOT}/deploy/host/install.ps1" "${STAGE_DIR}/install.ps1"
  cp "${WORKSPACE_ROOT}/deploy/host/launcher.ps1" "${STAGE_DIR}/launcher.ps1"
  for command_file in install.cmd update.cmd start.cmd stop.cmd; do
    cp "${WORKSPACE_ROOT}/deploy/host/${command_file}" "${STAGE_DIR}/${command_file}"
  done
  # Windows double-click entry points, shipped as ONE zip (the counterpart of
  # OpenDesign-macOS-Installer.zip below) so the release page has exactly two
  # installer downloads: one per OS. Built on windows-latest under Git Bash,
  # where `zip` is usually absent -- fall back to 7z, then Compress-Archive.
  WIN_CMD_STAGE="${OUT_DIR}/.win-commands"
  rm -rf "$WIN_CMD_STAGE"
  mkdir -p "$WIN_CMD_STAGE"
  cp "${WORKSPACE_ROOT}/deploy/host/install.cmd" "${WIN_CMD_STAGE}/OpenDesign-Install.cmd"
  cp "${WORKSPACE_ROOT}/deploy/host/update.cmd" "${WIN_CMD_STAGE}/OpenDesign-Update.cmd"
  cp "${WORKSPACE_ROOT}/deploy/host/start.cmd" "${WIN_CMD_STAGE}/OpenDesign-Start.cmd"
  cp "${WORKSPACE_ROOT}/deploy/host/stop.cmd" "${WIN_CMD_STAGE}/OpenDesign-Stop.cmd"
  WIN_ZIP="${OUT_DIR}/OpenDesign-Windows-Installer.zip"
  rm -f "$WIN_ZIP"
  if command -v zip >/dev/null 2>&1; then
    (cd "$WIN_CMD_STAGE" && zip -X -q "$WIN_ZIP" OpenDesign-Install.cmd OpenDesign-Update.cmd OpenDesign-Start.cmd OpenDesign-Stop.cmd)
  elif command -v 7z >/dev/null 2>&1; then
    (cd "$WIN_CMD_STAGE" && 7z a -tzip -bso0 -bsp0 "$WIN_ZIP" OpenDesign-Install.cmd OpenDesign-Update.cmd OpenDesign-Start.cmd OpenDesign-Stop.cmd)
  else
    powershell.exe -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$WIN_CMD_STAGE")\*.cmd' -DestinationPath '$(cygpath -w "$WIN_ZIP")' -Force"
  fi
  rm -rf "$WIN_CMD_STAGE"
fi

# macOS double-click entry points (the .command counterparts of the Windows
# .cmd files above). Shipped as ONE zip, not as bare files: an HTTP download
# does not carry the executable bit, so a bare `.command` fetched from the
# release page could not be double-clicked ("you do not have appropriate
# access privileges") — a zip preserves +x, and Safari/Finder unzip it in one
# click. Only the darwin-arm64 build emits it (both darwin builds would
# otherwise upload the same asset twice); the files themselves are
# architecture-independent — they only pick which install.sh to run.
if [ "$PLATFORM" = "darwin-arm64" ]; then
  MAC_CMD_STAGE="${OUT_DIR}/.mac-commands"
  rm -rf "$MAC_CMD_STAGE"
  mkdir -p "$MAC_CMD_STAGE"
  cp "${WORKSPACE_ROOT}/deploy/host/install.command" "${MAC_CMD_STAGE}/OpenDesign-Install.command"
  cp "${WORKSPACE_ROOT}/deploy/host/update.command" "${MAC_CMD_STAGE}/OpenDesign-Update.command"
  # Start/Stop complete the parity with the Windows zip's four .cmd files.
  # macOS gets them for the same reason Windows does: the alternative is
  # asking a designer to type `launchctl bootout gui/$(id -u)/…` by hand.
  cp "${WORKSPACE_ROOT}/deploy/host/start.command" "${MAC_CMD_STAGE}/OpenDesign-Start.command"
  cp "${WORKSPACE_ROOT}/deploy/host/stop.command" "${MAC_CMD_STAGE}/OpenDesign-Stop.command"
  chmod +x "${MAC_CMD_STAGE}"/*.command
  rm -f "${OUT_DIR}/OpenDesign-macOS-Installer.zip"
  (cd "$MAC_CMD_STAGE" && zip -X -q "${OUT_DIR}/OpenDesign-macOS-Installer.zip" \
    OpenDesign-Install.command OpenDesign-Update.command \
    OpenDesign-Start.command OpenDesign-Stop.command)
  rm -rf "$MAC_CMD_STAGE"
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

#!/usr/bin/env bash
# Open Design — host runtime one-command installer (WP6).
#
# Installs the daemon + static web export directly on the host (macOS or
# Linux), no Docker required. Structure inspired by kit-gen style installers
# (not copied from any project): download → verify → extract into a
# releases/<version> tree with a `current` symlink → install a user service
# (LaunchAgent / systemd --user) → health check with rollback.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<repo>/<tag>/deploy/host/install.sh -o install.sh
#   bash install.sh
#
#   bash install.sh --update       # update an existing install in place
#
# Options:
#   --archive <path>        Use a local tarball instead of downloading.
#   --release-url <url>     Direct .tar.gz URL, OR a release "asset base" URL
#                            (e.g. .../releases/download/<tag>) containing a
#                            release.json manifest. Default: the latest
#                            GitHub release of this repo.
#   --sha256 <hex>          Expected sha256 of the tarball (overrides any
#                            discovered .sha256 sidecar / release.json entry).
#   --port <n>               Daemon port (default: 7456).
#   --data-dir <path>        OD_DATA_DIR (default: $HOME/od-data/open-design).
#   --env-file <url|path>    KEY=VALUE defaults for MEDIA_*/IDENTITY_URL
#                            (an internal mirror env template). Individual
#                            flags below always take priority over this file.
#   --media-url <url>        MEDIA_URL
#   --media-app-id <id>      MEDIA_APP_ID
#   --media-user-id <id>     MEDIA_USER_ID
#   --media-user-role <role> MEDIA_USER_ROLE
#   --identity-url <url>     IDENTITY_URL
#   --google-client-id <id>       GOOGLE_CLIENT_ID
#   --google-client-secret <sec>  GOOGLE_CLIENT_SECRET
#   --session-secret <sec>        SESSION_SECRET
#                            (Google login for KG sync push/pull attribution
#                            and Shared Project registration. All three must
#                            be set together or login stays off — everything
#                            else still works, pushes just fall back to
#                            anonymous/installation-id attribution.)
#   --no-start                Install everything but do not start/enable the service.
#   --update                  Update an existing ~/.open-design install in place.
#   -h, --help                 Show this help.
#
# No sudo. Everything lives under $HOME (~/.open-design by default).
set -eu
set -o pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_GH_REPO="ducanhlaminh/open-design-vnpay"
OD_HOME="${HOME}/.open-design"
DEFAULT_PORT=7456
DEFAULT_DATA_DIR="${HOME}/od-data/open-design"
# Mirrors apps/daemon/package.json#engines ("~24") — see root AGENTS.md FAQ
# "Can I use Node 22 instead of Node 24?". Cross-referenced at implementation
# time rather than parsed at install time, so the very first bootstrap step
# (choosing/downloading the archive) never depends on a JSON parser being
# available yet.
REQUIRED_NODE_MAJOR=24
HEALTH_TIMEOUT=60
SERVICE_LABEL="com.vnpay.open-design"

# ---------------------------------------------------------------------------
# Colors & small helpers (style mirrors deploy/scripts/install.sh)
# ---------------------------------------------------------------------------
BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" RESET=""
if [ -t 1 ]; then
  BOLD="\033[1m" DIM="\033[2m" RED="\033[31m" GREEN="\033[32m"
  YELLOW="\033[33m" CYAN="\033[36m" RESET="\033[0m"
fi
step()  { printf "  ${DIM}▸${RESET} %s\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1" >&2; }
error() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; }
info()  { printf "  ${CYAN}›${RESET} %s\n" "$1"; }
fail()  { error "$1"; exit 1; }
phase() { printf "\n${BOLD}%s${RESET}\n" "$1"; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
OPT_ARCHIVE="" OPT_RELEASE_URL="" OPT_SHA256=""
OPT_PORT="" OPT_DATA_DIR="" OPT_ENV_FILE=""
OPT_MEDIA_URL="" OPT_MEDIA_APP_ID="" OPT_MEDIA_USER_ID="" OPT_MEDIA_USER_ROLE=""
OPT_IDENTITY_URL=""
OPT_GOOGLE_CLIENT_ID="" OPT_GOOGLE_CLIENT_SECRET="" OPT_SESSION_SECRET=""
OPT_NO_START=0
OPT_UPDATE=0

print_help() {
  sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) shift; OPT_ARCHIVE="${1:-}" ;;
    --archive=*) OPT_ARCHIVE="${1#--archive=}" ;;
    --release-url) shift; OPT_RELEASE_URL="${1:-}" ;;
    --release-url=*) OPT_RELEASE_URL="${1#--release-url=}" ;;
    --sha256) shift; OPT_SHA256="${1:-}" ;;
    --sha256=*) OPT_SHA256="${1#--sha256=}" ;;
    --port) shift; OPT_PORT="${1:-}" ;;
    --port=*) OPT_PORT="${1#--port=}" ;;
    --data-dir) shift; OPT_DATA_DIR="${1:-}" ;;
    --data-dir=*) OPT_DATA_DIR="${1#--data-dir=}" ;;
    --env-file) shift; OPT_ENV_FILE="${1:-}" ;;
    --env-file=*) OPT_ENV_FILE="${1#--env-file=}" ;;
    --media-url) shift; OPT_MEDIA_URL="${1:-}" ;;
    --media-url=*) OPT_MEDIA_URL="${1#--media-url=}" ;;
    --media-app-id) shift; OPT_MEDIA_APP_ID="${1:-}" ;;
    --media-app-id=*) OPT_MEDIA_APP_ID="${1#--media-app-id=}" ;;
    --media-user-id) shift; OPT_MEDIA_USER_ID="${1:-}" ;;
    --media-user-id=*) OPT_MEDIA_USER_ID="${1#--media-user-id=}" ;;
    --media-user-role) shift; OPT_MEDIA_USER_ROLE="${1:-}" ;;
    --media-user-role=*) OPT_MEDIA_USER_ROLE="${1#--media-user-role=}" ;;
    --identity-url) shift; OPT_IDENTITY_URL="${1:-}" ;;
    --identity-url=*) OPT_IDENTITY_URL="${1#--identity-url=}" ;;
    --google-client-id) shift; OPT_GOOGLE_CLIENT_ID="${1:-}" ;;
    --google-client-id=*) OPT_GOOGLE_CLIENT_ID="${1#--google-client-id=}" ;;
    --google-client-secret) shift; OPT_GOOGLE_CLIENT_SECRET="${1:-}" ;;
    --google-client-secret=*) OPT_GOOGLE_CLIENT_SECRET="${1#--google-client-secret=}" ;;
    --session-secret) shift; OPT_SESSION_SECRET="${1:-}" ;;
    --session-secret=*) OPT_SESSION_SECRET="${1#--session-secret=}" ;;
    --no-start) OPT_NO_START=1 ;;
    --update) OPT_UPDATE=1 ;;
    --help|-h) print_help; exit 0 ;;
    *) warn "Unknown argument: $1 (ignored)" ;;
  esac
  shift
done

if [ "$OPT_UPDATE" = "1" ] && [ ! -L "${OD_HOME}/current" ]; then
  fail "--update given but no existing install found at ${OD_HOME} (run without --update first)"
fi

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Flat-key lookup for the release.json manifest this repo's release workflow
# publishes (see .github/workflows/release-host-runtime.yml): top-level keys
# named "<platform>.url" / "<platform>.sha256" rather than nested objects, so
# a value can be pulled out with grep instead of a JSON parser.
json_flat_value() {
  printf '%s\n' "$1" | grep -o '"'"$2"'"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed -E 's/.*"([^"]*)"$/\1/' | head -1
}

TMP_DIRS=""
cleanup_tmp() {
  for d in $TMP_DIRS; do rm -rf "$d"; done
}
trap cleanup_tmp EXIT

mktemp_dir() {
  d="$(mktemp -d)"
  TMP_DIRS="$TMP_DIRS $d"
  printf '%s' "$d"
}

# ---------------------------------------------------------------------------
# Platform detection — uname -s / uname -m → darwin-arm64 | darwin-x64 | linux-x64
# ---------------------------------------------------------------------------
detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) PLATFORM="darwin-arm64" ;;
        x86_64) PLATFORM="darwin-x64" ;;
        *) fail "Unsupported macOS architecture: ${arch}" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) PLATFORM="linux-x64" ;;
        *) fail "Unsupported Linux architecture: ${arch} (only linux-x64 is supported)" ;;
      esac
      ;;
    *)
      fail "Unsupported OS: ${os} (only macOS and Linux are supported)"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Step 1/6 — resolve + verify the release archive
# ---------------------------------------------------------------------------
ARCHIVE_PATH=""
ARCHIVE_SHA_HINT=""

download_archive() {
  # $1 = tarball url, $2 = optional sha256 sidecar url
  dl_dir="$(mktemp_dir)"
  ARCHIVE_PATH="${dl_dir}/$(basename "$1")"
  step "Downloading $(basename "$1")"
  curl -fsSL -o "$ARCHIVE_PATH" "$1" || fail "download failed: $1"
  if [ -n "${2:-}" ]; then
    curl -fsSL -o "${ARCHIVE_PATH}.sha256" "$2" 2>/dev/null \
      && ARCHIVE_SHA_HINT="$(awk '{print $1}' "${ARCHIVE_PATH}.sha256")" \
      || true
  fi
}

resolve_archive() {
  if [ -n "$OPT_ARCHIVE" ]; then
    [ -f "$OPT_ARCHIVE" ] || fail "--archive not found: ${OPT_ARCHIVE}"
    ARCHIVE_PATH="$OPT_ARCHIVE"
    [ -f "${OPT_ARCHIVE}.sha256" ] && ARCHIVE_SHA_HINT="$(awk '{print $1}' "${OPT_ARCHIVE}.sha256")"
    detect_platform
    return
  fi

  detect_platform

  case "$OPT_RELEASE_URL" in
    *.tar.gz)
      download_archive "$OPT_RELEASE_URL" "${OPT_RELEASE_URL}.sha256"
      return
      ;;
  esac

  release_json_url=""
  if [ -n "$OPT_RELEASE_URL" ]; then
    release_json_url="${OPT_RELEASE_URL%/}/release.json"
  else
    step "Looking up the latest release of ${DEFAULT_GH_REPO}"
    # github.com/<repo>/releases/latest/download/<asset> is a redirect
    # GitHub serves for exactly this "give me the latest release's asset,
    # no API call" case -- it resolves through github.com and the
    # release-assets.githubusercontent.com CDN it redirects to, never
    # touching api.github.com. Some corporate proxies allowlist
    # github.com/*.githubusercontent.com for normal git/browsing traffic
    # but block the api. subdomain specifically (observed in the wild),
    # so this sidesteps that without needing --release-url.
    release_json_url="https://github.com/${DEFAULT_GH_REPO}/releases/latest/download/release.json"
  fi

  # release.json shape (see .github/workflows/release-host-runtime.yml):
  #   { "version": "...", "tag": "...",
  #     "<platform>.url": "https://…/open-design-runtime-<v>-<platform>.tar.gz",
  #     "<platform>.sha256": "<hex>", … one pair per supported platform … }
  rel_json="$(curl -fsSL "$release_json_url")" || fail "could not fetch release.json from ${release_json_url} (curl exit $?)"
  tarball_url="$(json_flat_value "$rel_json" "${PLATFORM}.url")"
  tarball_sha="$(json_flat_value "$rel_json" "${PLATFORM}.sha256")"
  [ -n "$tarball_url" ] || fail "release.json has no entry for platform ${PLATFORM}"

  download_archive "$tarball_url"
  [ -z "$ARCHIVE_SHA_HINT" ] && ARCHIVE_SHA_HINT="$tarball_sha"
}

STAGE_NAME=""

verify_tar_safety() {
  # Reject path traversal and anything other than exactly one top-level
  # directory before extraction ever runs.
  listing="$(tar -tzf "$ARCHIVE_PATH" 2>/dev/null)" || fail "archive is not a valid tar.gz: ${ARCHIVE_PATH}"
  [ -n "$listing" ] || fail "archive is empty: ${ARCHIVE_PATH}"

  if printf '%s\n' "$listing" | grep -qE '(^|/)\.\.(/|$)'; then
    fail "archive contains a '..' path traversal entry — refusing to extract"
  fi

  top_level="$(printf '%s\n' "$listing" | sed -E 's#/.*##' | sort -u)"
  top_count="$(printf '%s\n' "$top_level" | grep -c . || true)"
  [ "$top_count" -eq 1 ] || fail "archive must contain exactly one top-level directory (found ${top_count})"
  STAGE_NAME="$top_level"
}

verify_checksum() {
  expected="${OPT_SHA256:-$ARCHIVE_SHA_HINT}"
  [ -n "$expected" ] || fail "no checksum to verify against — pass --sha256 or ensure a .sha256/release.json entry is available"
  actual="$(sha256_of "$ARCHIVE_PATH")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${ARCHIVE_PATH}: expected ${expected}, got ${actual}"
  ok "Checksum verified (sha256)"
}

# ---------------------------------------------------------------------------
# Step 0 — network preflight. Not part of the "N/6" phase numbering (a
# connectivity probe, not an install step). Corporate networks sometimes
# block one of these domains outright; without this, the resulting failure
# is a bare curl/DNS error buried mid-download, with nothing telling the
# user (or their IT) which domain is actually the problem. Only probes
# domains this particular run will actually touch, mirroring each step's own
# gate (archive already local? Node already satisfies engine? claude/codex
# already on PATH?) so this never warns about a domain the run never needed.
# ---------------------------------------------------------------------------
preflight_probe() {
  # $1 = url. Deliberately no -f: any HTTP response at all (even 404/403 --
  # e.g. GitHub's asset CDN 404s on a bare root path with no signed asset
  # path, verified live) proves DNS/TCP/TLS all worked, which is all this
  # probes for. Only a curl-level failure (DNS, connect, TLS, timeout)
  # should count as unreachable. Short timeout -- a probe, not a real
  # download.
  curl -sS --connect-timeout 5 --max-time 8 -o /dev/null "$1" >/dev/null 2>&1
}

preflight_check() {
  phase "Kiểm tra kết nối mạng"
  required_ok=1

  if [ -z "$OPT_ARCHIVE" ] && [ -z "$OPT_RELEASE_URL" ]; then
    if preflight_probe "https://github.com"; then
      ok "github.com"
    else
      required_ok=0
      warn "github.com — không kết nối được"
    fi
    if preflight_probe "https://release-assets.githubusercontent.com"; then
      ok "release-assets.githubusercontent.com"
    else
      required_ok=0
      warn "release-assets.githubusercontent.com — không kết nối được"
    fi
  fi

  if ! node_satisfies_engine; then
    if preflight_probe "https://nodejs.org"; then
      ok "nodejs.org"
    else
      warn "nodejs.org — không kết nối được (cần để tải Node.js riêng — máy chưa có Node ${REQUIRED_NODE_MAJOR}.x)"
    fi
  fi

  if [ "$OPT_UPDATE" != "1" ]; then
    if ! command -v claude >/dev/null 2>&1; then
      if preflight_probe "https://claude.ai"; then
        ok "claude.ai"
      else
        warn "claude.ai — không kết nối được (sẽ bỏ qua cài Claude CLI)"
      fi
    fi
    if ! command -v codex >/dev/null 2>&1; then
      if preflight_probe "https://chatgpt.com"; then
        ok "chatgpt.com"
      else
        warn "chatgpt.com — không kết nối được (sẽ bỏ qua cài Codex CLI)"
      fi
    fi
  fi

  if [ "$required_ok" = "0" ]; then
    fail "Không kết nối được tới github.com / release-assets.githubusercontent.com — cần 2 domain này để tải gói cài đặt. Nhờ IT mở domain rồi thử lại, hoặc dùng --archive <file đã tải sẵn>."
  fi
}

VERSION=""

step1_verify_package() {
  phase "1/6 Kiểm tra gói cài đặt"
  resolve_archive
  step "Platform: ${PLATFORM}"
  # Checksum BEFORE any extraction — mandatory.
  verify_checksum
  verify_tar_safety
  VERSION="$(tar -xzf "$ARCHIVE_PATH" -O "${STAGE_NAME}/VERSION" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$VERSION" ] || fail "could not read VERSION from the archive"
  ok "Package verified: ${STAGE_NAME} (version ${VERSION})"
}

# ---------------------------------------------------------------------------
# Step 2/6 — Node.js runtime
# ---------------------------------------------------------------------------
NODE_BIN=""

node_satisfies_engine() {
  command -v node >/dev/null 2>&1 || return 1
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"
  [ "$major" = "$REQUIRED_NODE_MAJOR" ]
}

install_private_node() {
  dist_os="$([ "${PLATFORM%%-*}" = darwin ] && echo darwin || echo linux)"
  dist_arch="${PLATFORM##*-}"
  shasums_url="https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/SHASUMS256.txt"
  step "Fetching Node.js ${REQUIRED_NODE_MAJOR}.x checksums"
  shasums="$(curl -fsSL "$shasums_url")" || fail "could not fetch ${shasums_url} (curl exit $?)"
  filename="$(printf '%s\n' "$shasums" \
    | grep -oE "node-v${REQUIRED_NODE_MAJOR}\\.[0-9]+\\.[0-9]+-${dist_os}-${dist_arch}\\.tar\\.gz" \
    | head -1)"
  [ -n "$filename" ] || fail "no Node ${REQUIRED_NODE_MAJOR}.x build found for ${dist_os}-${dist_arch}"
  expected_sha="$(printf '%s\n' "$shasums" | grep " ${filename}\$" | awk '{print $1}')"

  dl_dir="$(mktemp_dir)"
  node_tar="${dl_dir}/${filename}"
  step "Downloading ${filename}"
  curl -fsSL -o "$node_tar" "https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/${filename}" \
    || fail "download failed: ${filename}"
  actual_sha="$(sha256_of "$node_tar")"
  [ "$actual_sha" = "$expected_sha" ] || fail "Node.js checksum mismatch (SHASUMS256.txt) for ${filename}"

  mkdir -p "${OD_HOME}/tools"
  tar -xzf "$node_tar" -C "${OD_HOME}/tools"
  node_dir_name="${filename%.tar.gz}"
  NODE_BIN="${OD_HOME}/tools/${node_dir_name}/bin/node"
  [ -x "$NODE_BIN" ] || fail "Node install did not produce an executable at ${NODE_BIN}"
  ok "Private Node.js installed: ${NODE_BIN}"
}

step2_ensure_node() {
  phase "2/6 Kiểm tra Node.js"
  if node_satisfies_engine; then
    NODE_BIN="$(command -v node)"
    ok "System Node.js satisfies engines (~${REQUIRED_NODE_MAJOR}): ${NODE_BIN}"
  else
    warn "System Node.js missing or not ~${REQUIRED_NODE_MAJOR} — installing a private copy under ${OD_HOME}/tools"
    install_private_node
  fi
}

# ---------------------------------------------------------------------------
# Step 3/6 — extract + config.env + service templates + `current` symlink
# ---------------------------------------------------------------------------
PREV_CURRENT=""
RELEASE_DIR=""

extract_release() {
  mkdir -p "${OD_HOME}/releases"
  RELEASE_DIR="${OD_HOME}/releases/${VERSION}"
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR" --strip-components=1
  ok "Extracted to ${RELEASE_DIR}"
}

# --env-file (url|path) → whitelisted KEY=VALUE lines only, never sourced as
# arbitrary shell.
ENV_FILE_VARS=""
load_env_file() {
  ef_path="$OPT_ENV_FILE"
  if [ -z "$ef_path" ]; then
    # No --env-file given. A copy bundled INTO this release's own tarball
    # by the release-host-runtime.yml CI pipeline (from GitHub Actions
    # secrets, see build-runtime.sh) means a fresh install needs zero
    # config flags to get KG sync + Google login working -- a deliberate
    # choice for this repo despite being PUBLIC (anyone can download the
    # tarball and read these values), not a default other
    # forks/deployments should copy without the same tradeoff being
    # intentional there too.
    bundled_env_file="${RELEASE_DIR}/host-env.template"
    if [ -f "$bundled_env_file" ]; then
      ef_path="$bundled_env_file"
      step "Using env defaults bundled with this release"
    else
      return 0
    fi
  else
    case "$OPT_ENV_FILE" in
      http://*|https://*)
        ef_path="$(mktemp_dir)/env-file"
        curl -fsSL -o "$ef_path" "$OPT_ENV_FILE" || fail "could not fetch --env-file ${OPT_ENV_FILE} (curl exit $?)"
        ;;
    esac
  fi
  [ -f "$ef_path" ] || fail "--env-file not found: ${ef_path}"
  ENV_FILE_VARS="$(grep -E '^(MEDIA_URL|MEDIA_APP_ID|MEDIA_USER_ID|MEDIA_USER_ROLE|IDENTITY_URL|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|SESSION_SECRET|OD_PORT|OD_DATA_DIR)=' "$ef_path" || true)"
}

env_file_value() {
  [ -n "$ENV_FILE_VARS" ] || return 0
  printf '%s\n' "$ENV_FILE_VARS" | grep "^$1=" | tail -1 | cut -d= -f2-
}

existing_config_value() {
  [ -f "${OD_HOME}/config.env" ] || return 0
  # `grep` exits 1 when the key was never configured (e.g. MEDIA_URL on an
  # install with KG sync off) — under `set -eu -o pipefail` that would abort
  # the whole --update run right here, silently, before the symlink repoint.
  { grep -E "^$1=" "${OD_HOME}/config.env" 2>/dev/null || true; } | tail -1 | cut -d= -f2-
}

# Priority: explicit flag > --env-file > existing config.env (on --update) > "".
resolve_cfg() {
  flag_val="$1" key="$2"
  if [ -n "$flag_val" ]; then printf '%s' "$flag_val"; return; fi
  efv="$(env_file_value "$key")"
  if [ -n "$efv" ]; then printf '%s' "$efv"; return; fi
  existing_config_value "$key"
}

PORT=""
DATA_DIR=""

write_config_env() {
  load_env_file

  PORT="$(resolve_cfg "$OPT_PORT" OD_PORT)"; PORT="${PORT:-$DEFAULT_PORT}"
  DATA_DIR="$(resolve_cfg "$OPT_DATA_DIR" OD_DATA_DIR)"; DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
  media_url="$(resolve_cfg "$OPT_MEDIA_URL" MEDIA_URL)"
  media_app_id="$(resolve_cfg "$OPT_MEDIA_APP_ID" MEDIA_APP_ID)"
  media_user_id="$(resolve_cfg "$OPT_MEDIA_USER_ID" MEDIA_USER_ID)"
  media_user_role="$(resolve_cfg "$OPT_MEDIA_USER_ROLE" MEDIA_USER_ROLE)"
  identity_url="$(resolve_cfg "$OPT_IDENTITY_URL" IDENTITY_URL)"
  google_client_id="$(resolve_cfg "$OPT_GOOGLE_CLIENT_ID" GOOGLE_CLIENT_ID)"
  google_client_secret="$(resolve_cfg "$OPT_GOOGLE_CLIENT_SECRET" GOOGLE_CLIENT_SECRET)"
  session_secret="$(resolve_cfg "$OPT_SESSION_SECRET" SESSION_SECRET)"

  {
    echo "# Generated by deploy/host/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "OD_SANDBOX=0"
    echo "OD_WRITE_ISOLATION=required"
    echo "OD_DATA_DIR=${DATA_DIR}"
    echo "OD_PORT=${PORT}"
    # Bundled skills/design-systems/design-templates/craft/plugins/prompt-
    # templates live under <current>/resources/open-design (build-runtime.sh
    # step 6), never at a path apps/daemon/src/server.ts's
    # resolveDaemonResourceRoot() finds on its own — without this, every
    # bundled resource tree silently falls back to <current>/<segment>
    # (which doesn't exist in this layout) and the daemon reports zero
    # skills. `current` is a symlink re-pointed on every --update, so this
    # string keeps resolving correctly across releases without rewriting.
    echo "OD_RESOURCE_ROOT=${OD_HOME}/current/resources/open-design"
    [ -n "$media_url" ] && echo "MEDIA_URL=${media_url}"
    [ -n "$media_app_id" ] && echo "MEDIA_APP_ID=${media_app_id}"
    [ -n "$media_user_id" ] && echo "MEDIA_USER_ID=${media_user_id}"
    [ -n "$media_user_role" ] && echo "MEDIA_USER_ROLE=${media_user_role}"
    [ -n "$identity_url" ] && echo "IDENTITY_URL=${identity_url}"
    [ -n "$google_client_id" ] && echo "GOOGLE_CLIENT_ID=${google_client_id}"
    [ -n "$google_client_secret" ] && echo "GOOGLE_CLIENT_SECRET=${google_client_secret}"
    [ -n "$session_secret" ] && echo "SESSION_SECRET=${session_secret}"
  } > "${OD_HOME}/config.env"
  chmod 600 "${OD_HOME}/config.env"

  if [ -z "$media_url$identity_url" ]; then
    warn "No Media/Identity endpoints configured — KG sync sẽ tắt (dùng --env-file hoặc --media-*/--identity-url để bật)."
  fi
  if [ -z "$google_client_id$google_client_secret$session_secret" ]; then
    warn "No Google login configured — /login sẽ tắt (dùng --env-file hoặc --google-client-id/--google-client-secret/--session-secret để bật). KG sync push/pull vẫn chạy được nhưng attribution rơi về anonymous/installation-id."
  elif [ -z "$google_client_id" ] || [ -z "$google_client_secret" ] || [ -z "$session_secret" ]; then
    warn "Google login config không đủ 3 biến (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/SESSION_SECRET) — /login sẽ tắt cho tới khi cả 3 đều có."
  fi
  ok "Wrote ${OD_HOME}/config.env (chmod 600)"
}

render_template() {
  sed -e "s#@OD_BIN@#${NODE_BIN}#g" -e "s#@OD_HOME@#${OD_HOME}#g" "$1" > "$2"
}

SERVICE_MODE=""
DARWIN_PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LINUX_UNIT_PATH="${HOME}/.config/systemd/user/open-design.service"

write_service_files() {
  case "$(uname -s)" in
    Darwin)
      mkdir -p "${HOME}/Library/LaunchAgents"
      render_template "${RELEASE_DIR}/runtime/service/com.vnpay.open-design.plist.in" "$DARWIN_PLIST_PATH"
      SERVICE_MODE="launchd"
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        mkdir -p "${HOME}/.config/systemd/user"
        render_template "${RELEASE_DIR}/runtime/service/open-design.service.in" "$LINUX_UNIT_PATH"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        SERVICE_MODE="systemd"
      else
        SERVICE_MODE="nohup"
      fi
      ;;
    *)
      SERVICE_MODE="nohup"
      ;;
  esac
}

step3_extract_and_configure() {
  phase "3/6 Giải nén & cài đặt"
  [ -L "${OD_HOME}/current" ] && PREV_CURRENT="$(readlink "${OD_HOME}/current")"
  extract_release
  write_config_env
  mkdir -p "${OD_HOME}/logs"
  ln -sfn "$RELEASE_DIR" "${OD_HOME}/current"
  ok "current -> releases/${VERSION}"
  write_service_files
}

# ---------------------------------------------------------------------------
# Step 4/6 — service registration
# ---------------------------------------------------------------------------
step4_configure_service() {
  phase "4/6 Cấu hình dịch vụ"
  if [ "$OPT_NO_START" = "1" ]; then
    step "--no-start: service files written but not enabled"
    return
  fi
  case "$SERVICE_MODE" in
    launchd) ok "LaunchAgent installed: ${DARWIN_PLIST_PATH}" ;;
    systemd) ok "systemd --user unit installed: ${LINUX_UNIT_PATH}" ;;
    nohup)   warn "No launchd/systemd found — falling back to a nohup-managed process" ;;
  esac
}

start_service() {
  case "$SERVICE_MODE" in
    launchd)
      launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
      # `bootout` on a job with a live process (the normal case on --update,
      # since the previous release's daemon is still running) returns before
      # launchd finishes tearing it down. An immediate `bootstrap` then loses
      # the race and fails with "5: Input/output error". Retry briefly
      # instead of aborting the whole update.
      bootstrap_ok=0
      i=0
      while [ "$i" -lt 10 ]; do
        if launchctl bootstrap "gui/$(id -u)" "$DARWIN_PLIST_PATH" 2>/dev/null; then
          bootstrap_ok=1
          break
        fi
        sleep 1
        i=$((i + 1))
      done
      [ "$bootstrap_ok" = "1" ] || fail "launchctl bootstrap failed after retries — see: launchctl print gui/$(id -u)/${SERVICE_LABEL}"
      launchctl kickstart -k "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
      ;;
    systemd)
      systemctl --user enable open-design >/dev/null 2>&1 || true
      systemctl --user restart open-design
      ;;
    nohup)
      pkill -f "apps/daemon/dist/cli.js" >/dev/null 2>&1 || true
      sleep 1
      nohup "$NODE_BIN" "${OD_HOME}/current/apps/daemon/dist/cli.js" --no-open \
        >>"${OD_HOME}/logs/open-design.out.log" 2>>"${OD_HOME}/logs/open-design.err.log" &
      echo $! > "${OD_HOME}/open-design.pid"
      disown 2>/dev/null || true
      ;;
  esac
}

stop_service() {
  case "$SERVICE_MODE" in
    launchd) launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true ;;
    systemd) systemctl --user stop open-design >/dev/null 2>&1 || true ;;
    nohup)
      if [ -f "${OD_HOME}/open-design.pid" ]; then
        kill "$(cat "${OD_HOME}/open-design.pid")" >/dev/null 2>&1 || true
        rm -f "${OD_HOME}/open-design.pid"
      fi
      ;;
  esac
}

wait_for_health() {
  port="$1"
  timeout="${2:-$HEALTH_TIMEOUT}"
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/health" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && return 0
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

# ---------------------------------------------------------------------------
# Step 5/6 — start + health check + rollback
# ---------------------------------------------------------------------------
rollback() {
  if [ -n "$PREV_CURRENT" ] && [ "$PREV_CURRENT" != "$RELEASE_DIR" ]; then
    warn "Health check failed — rolling back to $(basename "$PREV_CURRENT")"
    ln -sfn "$PREV_CURRENT" "${OD_HOME}/current"
    write_service_files
    start_service
    if wait_for_health "$PORT" 30; then
      warn "Rolled back successfully. Release ${VERSION} was NOT activated."
    else
      error "Rollback also failed the health check — manual intervention required."
    fi
  else
    stop_service
    error "No previous release to roll back to. Service stopped."
  fi
  error "Install/update FAILED for version ${VERSION}. Logs: ${OD_HOME}/logs/"
  exit 1
}

step5_start_and_health_check() {
  phase "5/6 Khởi động & kiểm tra sức khỏe"
  if [ "$OPT_NO_START" = "1" ]; then
    step "--no-start: skipping service start and health check"
    return
  fi
  start_service
  step "Waiting for health check (up to ${HEALTH_TIMEOUT}s)…"
  if wait_for_health "$PORT" "$HEALTH_TIMEOUT"; then
    ok "Daemon is healthy on port ${PORT}"
  else
    rollback
  fi
}

# ---------------------------------------------------------------------------
# Step 6/6 — Claude CLI + login probe + final checklist
# ---------------------------------------------------------------------------

# Best-effort bash port of apps/daemon/src/runtimes/auth.ts:probeClaudeAuthStatus
# (does not need to be byte-identical — same on-disk signals: credentials
# file with a non-empty accessToken, settings.json apiKeyHelper, or macOS
# Keychain item presence).
probe_claude_login() {
  if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] || [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ]; then
    return 0
  fi
  config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -f "${config_dir}/.credentials.json" ] \
    && grep -qE '"accessToken"[[:space:]]*:[[:space:]]*"[^"]' "${config_dir}/.credentials.json" 2>/dev/null; then
    return 0
  fi
  if [ -f "${config_dir}/settings.json" ] \
    && grep -qE '"apiKeyHelper"[[:space:]]*:[[:space:]]*"[^"]' "${config_dir}/settings.json" 2>/dev/null; then
    return 0
  fi
  if [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1; then
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# Best-effort bash port of apps/daemon/src/runtimes/auth.ts:probeCodexAuthStatus
# — same on-disk signal: <CODEX_HOME>/auth.json (default ~/.codex) carrying
# either a nested tokens.access_token or a bare OPENAI_API_KEY field. A flat
# regex (not a real JSON parser) is intentional, matching how
# probe_claude_login above already treats its own credentials file.
probe_codex_login() {
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    return 0
  fi
  codex_home="${CODEX_HOME:-$HOME/.codex}"
  if [ -f "${codex_home}/auth.json" ] \
    && grep -qE '"(access_token|OPENAI_API_KEY)"[[:space:]]*:[[:space:]]*"[^"]' "${codex_home}/auth.json" 2>/dev/null; then
    return 0
  fi
  return 1
}

ensure_codex_cli() {
  if command -v codex >/dev/null 2>&1; then
    ok "codex CLI found on PATH: $(command -v codex)"
    return
  fi
  warn "codex CLI not found on PATH — installing via the native installer"
  # Official OpenAI installer (verified live at implementation time —
  # chatgpt.com/codex/install.sh redirects to releases.openai.com/codex/
  # install.sh). Unlike Claude's installer, the version pin is an env var
  # (CODEX_RELEASE), not a positional arg; CODEX_NON_INTERACTIVE skips any
  # prompts, matching this installer's own unattended/no-sudo invariant. No
  # pin-file support yet (no codex.version bundled by build-runtime.sh) —
  # always installs latest, same as Claude's own unpinned fallback path.
  # NON_INTERACTIVE must be set on `sh` (the pipeline stage that actually
  # interprets the downloaded script), not on `curl` -- a leading VAR=val
  # prefix only scopes to the single command it directly precedes.
  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=true sh \
    || warn "Codex CLI install failed — install manually: curl -fsSL https://chatgpt.com/codex/install.sh | sh"
}

ensure_claude_cli() {
  if command -v claude >/dev/null 2>&1; then
    ok "claude CLI found on PATH: $(command -v claude)"
    return
  fi
  warn "claude CLI not found on PATH — installing via the native installer"
  pin=""
  [ -f "${RELEASE_DIR}/claude.version" ] && pin="$(tr -d '[:space:]' < "${RELEASE_DIR}/claude.version")"
  if [ -n "$pin" ]; then
    step "Attempting pinned install (claude.version=${pin})"
    if ! (curl -fsSL https://claude.ai/install.sh | bash -s -- "$pin"); then
      warn "Pinned Claude CLI install failed or is unsupported by the installer — falling back to latest"
      curl -fsSL https://claude.ai/install.sh | bash \
        || warn "Claude CLI install failed — install manually: curl -fsSL https://claude.ai/install.sh | bash"
    fi
  else
    curl -fsSL https://claude.ai/install.sh | bash \
      || warn "Claude CLI install failed — install manually: curl -fsSL https://claude.ai/install.sh | bash"
  fi
}

step6_claude_and_summary() {
  phase "6/6 Kiểm tra Claude & Codex CLI & hoàn tất"
  ensure_claude_cli
  ensure_codex_cli

  LOGIN_OK=1
  probe_claude_login || LOGIN_OK=0
  CODEX_LOGIN_OK=1
  probe_codex_login || CODEX_LOGIN_OK=0

  # Final checklist — od sandbox status already reports Claude sandbox
  # image/auth-volume health (Docker sandbox specific); best-effort, never
  # fails the install.
  if [ "$OPT_NO_START" != "1" ]; then
    "$NODE_BIN" "${OD_HOME}/current/apps/daemon/dist/cli.js" sandbox status \
      --daemon-url "http://127.0.0.1:${PORT}" 2>/dev/null || true
  fi

  printf "\n"
  printf "${BOLD}${GREEN}  ── Cài đặt hoàn tất ──────────────────────────────${RESET}\n"
  printf "\n"
  if [ "$OPT_NO_START" != "1" ]; then
    printf "  URL:      http://127.0.0.1:%s\n" "$PORT"
  fi
  printf "  Version:  %s\n" "$VERSION"
  printf "  Home:     %s\n" "$OD_HOME"
  printf "  Config:   %s\n" "${OD_HOME}/config.env"
  case "$SERVICE_MODE" in
    launchd) printf "  Service:  launchctl (label: %s)\n" "$SERVICE_LABEL" ;;
    systemd) printf "  Service:  systemctl --user start|stop|status open-design\n" ;;
    nohup)   printf "  Service:  nohup (pid file: %s/open-design.pid)\n" "$OD_HOME" ;;
  esac
  printf "\n"
  if [ "$LOGIN_OK" = "0" ]; then
    printf "  ${YELLOW}còn một bước: chạy \`claude /login\` để đăng nhập Claude Code.${RESET}\n\n"
  fi
  if [ "$CODEX_LOGIN_OK" = "0" ]; then
    printf "  ${YELLOW}còn một bước: chạy \`codex login\` để đăng nhập Codex CLI.${RESET}\n\n"
  fi
  printf "  Update:    bash %s/install.sh --update\n" "$OD_HOME"
  printf "  Uninstall/rollback: see deploy/host/README.md\n"
  printf "\n"
}

# ---------------------------------------------------------------------------
# --update summary (prints the new version from /api/version)
# ---------------------------------------------------------------------------
print_update_summary() {
  if [ "$OPT_NO_START" = "1" ]; then
    ok "Update installed (not started — --no-start)."
    return
  fi
  # /api/version returns {"version":{...}} — parsed with Node (already
  # guaranteed available at this point), not python3.
  version_json="$(curl -fsS "http://127.0.0.1:${PORT}/api/version" 2>/dev/null || echo '{}')"
  printed="$(printf '%s' "$version_json" | "$NODE_BIN" -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const v = JSON.parse(s).version; console.log(typeof v === "string" ? v : JSON.stringify(v)); }
      catch { console.log("unknown"); }
    });' 2>/dev/null || echo unknown)"
  ok "Updated. Running /api/version: ${printed}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  printf "\n"
  printf "${BOLD}  ┌──────────────────────────────────────┐${RESET}\n"
  printf "${BOLD}  │${RESET}   ${CYAN}◈${RESET}  ${BOLD}Open Design — Host Runtime${RESET}       ${BOLD}│${RESET}\n"
  printf "${BOLD}  │${RESET}      ${DIM}One-command installer${RESET}                ${BOLD}│${RESET}\n"
  printf "${BOLD}  └──────────────────────────────────────┘${RESET}\n"

  mkdir -p "$OD_HOME"

  preflight_check
  step1_verify_package
  step2_ensure_node
  step3_extract_and_configure
  step4_configure_service
  step5_start_and_health_check

  if [ "$OPT_UPDATE" = "1" ]; then
    print_update_summary
  else
    step6_claude_and_summary
  fi
}

# deploy/tests/host-install.test.ts sources this script with
# OD_INSTALL_SH_TEST_SOURCE=1 to unit-test individual functions (tar safety,
# checksum, config.env generation, rollback) without ever driving a real
# launchd/systemd session. Every real invocation (curl | bash, bash
# install.sh …) leaves this unset and runs normally.
if [ "${OD_INSTALL_SH_TEST_SOURCE:-0}" != "1" ]; then
  main
fi

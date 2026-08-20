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
#                            (e.g. .../releases/download/<tag>, or a mirror
#                            folder) containing a release.json manifest.
#                            Default: $OD_RELEASE_URL, then OD_RELEASE_URL
#                            from an existing config.env (so --update keeps
#                            using the same mirror), then the latest GitHub
#                            release of this repo. A base URL is persisted
#                            as OD_RELEASE_URL in config.env; a direct
#                            .tar.gz URL is not. Why a mirror: networks that
#                            TLS-inspect github.com throttle release downloads
#                            to a few hundred KB/s (measured 2026-08-18).
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
#   --start                   Start the already-installed daemon and exit
#                            (no download, no config rewrite). Backs
#                            OpenDesign-Start.command.
#   --stop                    Stop the running daemon and exit. Backs
#                            OpenDesign-Stop.command.
#   -h, --help                 Show this help.
#
# No sudo. Everything lives under $HOME (~/.open-design by default).
set -eu
set -o pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_GH_REPO="ducanhlaminh/open-design-vnpay"
# Cloudflare Pages mirror published in parallel with every GitHub Release
# (scripts/host-runtime/mirror-publish.sh: <public>/latest/ carries
# release.json + install.sh + install.ps1 + the runtime tarball). This is
# the DEFAULT release source (not a fallback) when nothing else is
# configured: this installer's user base sits inside the VNPAY network,
# which blocks/TLS-inspects github.com for most users (WP16). GitHub is the
# fallback -- see resolve_release_url()/preflight_check() below.
DEFAULT_MIRROR_URL="https://od-runtime.pages.dev/latest"
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
step()  { printf "  ${DIM}▸${RESET} %s\n" "$1" || true; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1" || true; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1" >&2 || true; }
error() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2 || true; }
info()  { printf "  ${CYAN}›${RESET} %s\n" "$1" || true; }
fail()  { error "$1"; exit 1; }
phase() { printf "\n${BOLD}%s${RESET}\n" "$1" || true; }

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
OPT_START=0
OPT_STOP=0

print_help() {
  sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'
}

require_flag_value() {
  flag="$1"
  [ "$#" -ge 2 ] || fail "${flag} requires a value"
  [ -n "$2" ] || fail "${flag} requires a non-empty value"
  case "$2" in --*) fail "${flag} requires a value (got another flag: $2)" ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --archive) require_flag_value "$@"; shift; OPT_ARCHIVE="$1" ;;
    --archive=*) OPT_ARCHIVE="${1#--archive=}"; [ -n "$OPT_ARCHIVE" ] || fail "--archive requires a non-empty value" ;;
    --release-url) require_flag_value "$@"; shift; OPT_RELEASE_URL="$1" ;;
    --release-url=*) OPT_RELEASE_URL="${1#--release-url=}"; [ -n "$OPT_RELEASE_URL" ] || fail "--release-url requires a non-empty value" ;;
    --sha256) require_flag_value "$@"; shift; OPT_SHA256="$1" ;;
    --sha256=*) OPT_SHA256="${1#--sha256=}"; [ -n "$OPT_SHA256" ] || fail "--sha256 requires a non-empty value" ;;
    --port) require_flag_value "$@"; shift; OPT_PORT="$1" ;;
    --port=*) OPT_PORT="${1#--port=}"; [ -n "$OPT_PORT" ] || fail "--port requires a non-empty value" ;;
    --data-dir) require_flag_value "$@"; shift; OPT_DATA_DIR="$1" ;;
    --data-dir=*) OPT_DATA_DIR="${1#--data-dir=}"; [ -n "$OPT_DATA_DIR" ] || fail "--data-dir requires a non-empty value" ;;
    --env-file) require_flag_value "$@"; shift; OPT_ENV_FILE="$1" ;;
    --env-file=*) OPT_ENV_FILE="${1#--env-file=}"; [ -n "$OPT_ENV_FILE" ] || fail "--env-file requires a non-empty value" ;;
    --media-url) require_flag_value "$@"; shift; OPT_MEDIA_URL="$1" ;;
    --media-url=*) OPT_MEDIA_URL="${1#--media-url=}"; [ -n "$OPT_MEDIA_URL" ] || fail "--media-url requires a non-empty value" ;;
    --media-app-id) require_flag_value "$@"; shift; OPT_MEDIA_APP_ID="$1" ;;
    --media-app-id=*) OPT_MEDIA_APP_ID="${1#--media-app-id=}"; [ -n "$OPT_MEDIA_APP_ID" ] || fail "--media-app-id requires a non-empty value" ;;
    --media-user-id) require_flag_value "$@"; shift; OPT_MEDIA_USER_ID="$1" ;;
    --media-user-id=*) OPT_MEDIA_USER_ID="${1#--media-user-id=}"; [ -n "$OPT_MEDIA_USER_ID" ] || fail "--media-user-id requires a non-empty value" ;;
    --media-user-role) require_flag_value "$@"; shift; OPT_MEDIA_USER_ROLE="$1" ;;
    --media-user-role=*) OPT_MEDIA_USER_ROLE="${1#--media-user-role=}"; [ -n "$OPT_MEDIA_USER_ROLE" ] || fail "--media-user-role requires a non-empty value" ;;
    --identity-url) require_flag_value "$@"; shift; OPT_IDENTITY_URL="$1" ;;
    --identity-url=*) OPT_IDENTITY_URL="${1#--identity-url=}"; [ -n "$OPT_IDENTITY_URL" ] || fail "--identity-url requires a non-empty value" ;;
    --google-client-id) require_flag_value "$@"; shift; OPT_GOOGLE_CLIENT_ID="$1" ;;
    --google-client-id=*) OPT_GOOGLE_CLIENT_ID="${1#--google-client-id=}"; [ -n "$OPT_GOOGLE_CLIENT_ID" ] || fail "--google-client-id requires a non-empty value" ;;
    --google-client-secret) require_flag_value "$@"; shift; OPT_GOOGLE_CLIENT_SECRET="$1" ;;
    --google-client-secret=*) OPT_GOOGLE_CLIENT_SECRET="${1#--google-client-secret=}"; [ -n "$OPT_GOOGLE_CLIENT_SECRET" ] || fail "--google-client-secret requires a non-empty value" ;;
    --session-secret) require_flag_value "$@"; shift; OPT_SESSION_SECRET="$1" ;;
    --session-secret=*) OPT_SESSION_SECRET="${1#--session-secret=}"; [ -n "$OPT_SESSION_SECRET" ] || fail "--session-secret requires a non-empty value" ;;
    --no-start) OPT_NO_START=1 ;;
    --update) OPT_UPDATE=1 ;;
    --start) OPT_START=1 ;;
    --stop) OPT_STOP=1 ;;
    --help|-h) print_help; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
  shift
done

# --start / --stop are lifecycle COMMANDS, not install options: they never
# download, extract, or rewrite config.env. Mirrors install.ps1's
# `Assert-Parameters` ("-Start, -Stop, and -Uninstall are mutually exclusive").
if [ "$OPT_START" = "1" ] && [ "$OPT_STOP" = "1" ]; then
  fail "--start and --stop are mutually exclusive"
fi
if { [ "$OPT_START" = "1" ] || [ "$OPT_STOP" = "1" ]; } && [ "$OPT_UPDATE" = "1" ]; then
  fail "--start / --stop cannot be combined with --update"
fi

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
# Prints the value of a top-level "<key>": "<value>" pair, or nothing when the
# key is absent. Absence is a normal answer (e.g. "<platform>.parts" only
# exists on the Cloudflare mirror), so grep's exit 1 must NOT propagate — under
# `set -e -o pipefail` it would kill the whole install at the release lookup.
json_flat_value() {
  printf '%s\n' "$1" \
    | { grep -o '"'"$2"'"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } \
    | sed -E 's/.*"([^"]*)"$/\1/' | head -1
}

TMP_DIRS=""
LAST_TMP_DIR=""
cleanup_tmp() {
  for d in $TMP_DIRS; do
    case "$d" in /tmp/*|/private/tmp/*|"${TMPDIR:-/tmp}"/*) rm -rf "$d" ;; esac
  done
  if [ -n "${RELEASE_STAGE:-}" ]; then
    case "$RELEASE_STAGE" in "${OD_HOME}/releases/".*.staging.*) rm -rf "$RELEASE_STAGE" ;; esac
  fi
  if [ -n "${REPLACED_RELEASE_BACKUP:-}" ]; then
    case "$REPLACED_RELEASE_BACKUP" in
      "${OD_HOME}/releases/".*.replaced.*)
        if [ ! -e "${RELEASE_DIR:-}" ]; then
          mv "$REPLACED_RELEASE_BACKUP" "$RELEASE_DIR" || true
        else
          rm -rf "$REPLACED_RELEASE_BACKUP"
        fi
        ;;
    esac
  fi
  [ -z "${CONFIG_TEMP:-}" ] || rm -f "$CONFIG_TEMP"
  if [ -n "${CONFIG_BACKUP:-}" ]; then
    if [ "${CONFIG_WRITTEN:-0}" = "1" ]; then
      warn "Preserving config backup for manual recovery: ${CONFIG_BACKUP}"
    else
      rm -f "$CONFIG_BACKUP"
    fi
  fi
}

mktemp_dir() {
  LAST_TMP_DIR="$(mktemp -d)"
  TMP_DIRS="$TMP_DIRS $LAST_TMP_DIR"
}

# Shared network policy: retry transient failures a bounded number of times,
# fail quickly on connect errors, and abort a transfer that has effectively
# stalled. curl's progress bar is only enabled for an interactive stderr;
# redirected logs/CI remain stable one-line output with no ANSI or CR updates.
curl_download() {
  output="$1" url="$2"
  if [ -t 2 ]; then
    curl --fail --location --show-error --progress-bar \
      --retry 3 --retry-delay 1 --retry-max-time 45 \
      --connect-timeout 10 --speed-limit 1024 --speed-time 30 \
      -o "$output" "$url"
  else
    curl --fail --location --silent --show-error \
      --retry 3 --retry-delay 1 --retry-max-time 45 \
      --connect-timeout 10 --speed-limit 1024 --speed-time 30 \
      -o "$output" "$url"
  fi
}

curl_text() {
  curl --fail --location --silent --show-error \
    --retry 3 --retry-delay 1 --retry-max-time 45 \
    --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$1"
}

curl_stream() {
  if [ -t 2 ]; then
    curl --fail --location --show-error --progress-bar \
      --retry 3 --retry-delay 1 --retry-max-time 45 \
      --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$1"
  else
    curl --fail --location --silent --show-error \
      --retry 3 --retry-delay 1 --retry-max-time 45 \
      --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$1"
  fi
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
ARCHIVE_SHA256=""

download_archive() {
  # $1 = tarball url, $2 = optional sha256 sidecar url, $3 = optional part count.
  # $3 > 0: the mirror serves <url>.part01 .. .partNN (hosts with a per-file
  # size cap -- Cloudflare Pages: 25 MiB) instead of the whole file. Fetch each
  # part with the same retry/stall policy, concatenate, and let verify_checksum
  # check the whole-file sha256 from release.json exactly as usual.
  mktemp_dir
  dl_dir="$LAST_TMP_DIR"
  ARCHIVE_PATH="${dl_dir}/$(basename "$1")"
  parts="${3:-0}"
  case "$parts" in ''|*[!0-9]*) fail "release.json has a non-numeric part count: ${parts}" ;; esac
  if [ "$parts" -gt 0 ]; then
    step "Downloading $(basename "$1") (${parts} parts)"
    : > "$ARCHIVE_PATH"
    i=1
    while [ "$i" -le "$parts" ]; do
      suffix="$(printf '.part%02d' "$i")"
      step "  part ${i}/${parts}"
      curl_download "${ARCHIVE_PATH}${suffix}" "$1${suffix}" || fail "download failed after bounded retries: $1${suffix}"
      cat "${ARCHIVE_PATH}${suffix}" >> "$ARCHIVE_PATH" || fail "could not assemble ${ARCHIVE_PATH} from its parts"
      rm -f "${ARCHIVE_PATH}${suffix}"
      i=$((i + 1))
    done
    return
  fi
  step "Downloading $(basename "$1")"
  curl_download "$ARCHIVE_PATH" "$1" || fail "download failed after bounded retries: $1"
  if [ -n "${2:-}" ]; then
    curl_download "${ARCHIVE_PATH}.sha256" "$2" 2>/dev/null \
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
  rel_json="$(curl_text "$release_json_url")" || fail "could not fetch release.json from ${release_json_url}"
  tarball_url="$(json_flat_value "$rel_json" "${PLATFORM}.url")"
  tarball_sha="$(json_flat_value "$rel_json" "${PLATFORM}.sha256")"
  # "<platform>.parts" (string count) = the archive is served as .partNN files
  # (see build-release-manifest.ts --split-mib). Absent on GitHub Releases.
  tarball_parts="$(json_flat_value "$rel_json" "${PLATFORM}.parts")"
  [ -n "$tarball_url" ] || fail "release.json has no entry for platform ${PLATFORM}"

  download_archive "$tarball_url" "" "${tarball_parts:-0}"
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
  ARCHIVE_SHA256="$actual"
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

# --release-url flag > $OD_RELEASE_URL (set by the user / IT, or inherited
# from config.env by the daemon that spawns `--update`) > OD_RELEASE_URL
# persisted in config.env > DEFAULT_MIRROR_URL (with GitHub as preflight's
# runtime fallback if the mirror is unreachable -- see preflight_check()).
# RELEASE_URL_IS_MIRROR_BASE is what write_config_env persists: only a
# user/IT-provided base URL (folder with release.json), never a one-off
# direct .tar.gz URL (would pin every future --update to one fixed file)
# and never the untouched default (see RELEASE_URL_IS_DEFAULT below).
RELEASE_URL_IS_MIRROR_BASE=0
# Set only when OPT_RELEASE_URL was filled in by the DEFAULT_MIRROR_URL
# fallback below, i.e. nothing in flag/env/config.env named a source.
# write_config_env must not persist OD_RELEASE_URL in that case: the
# default can change release-to-release, and persisting it would pin every
# future --update to whatever mirror happened to be default at install
# time instead of tracking the shipped default.
RELEASE_URL_IS_DEFAULT=0
resolve_release_url() {
  if [ -z "$OPT_RELEASE_URL" ]; then
    if [ -n "${OD_RELEASE_URL:-}" ]; then
      OPT_RELEASE_URL="$OD_RELEASE_URL"
    else
      OPT_RELEASE_URL="$(existing_config_value OD_RELEASE_URL)"
    fi
  fi
  if [ -z "$OPT_RELEASE_URL" ]; then
    # Nothing configured anywhere -- default to the mirror (WP16), treated
    # exactly like a user-provided mirror base except it is not persisted
    # (RELEASE_URL_IS_DEFAULT=1, see above). preflight_check() below falls
    # back to GitHub at runtime if the mirror itself is unreachable.
    OPT_RELEASE_URL="$DEFAULT_MIRROR_URL"
    RELEASE_URL_IS_MIRROR_BASE=1
    RELEASE_URL_IS_DEFAULT=1
    info "Release source: ${OPT_RELEASE_URL} (default mirror)"
    return
  fi
  case "$OPT_RELEASE_URL" in
    *.tar.gz) info "Release source: ${OPT_RELEASE_URL} (direct archive URL)" ;;
    *)
      OPT_RELEASE_URL="${OPT_RELEASE_URL%/}"
      RELEASE_URL_IS_MIRROR_BASE=1
      info "Release source: ${OPT_RELEASE_URL} (OD_RELEASE_URL / --release-url)"
      ;;
  esac
}

preflight_check() {
  phase "Kiểm tra kết nối mạng"
  required_ok=1

  if [ -z "$OPT_ARCHIVE" ] && [ -n "$OPT_RELEASE_URL" ] && [ "$RELEASE_URL_IS_DEFAULT" != "1" ]; then
    # User/IT-provided source (flag / OD_RELEASE_URL / config.env): that
    # host is the only one the download needs, and it never fails over --
    # it's the one place they explicitly told us to use.
    release_host="$(printf '%s' "$OPT_RELEASE_URL" | sed -E 's#^(https?://[^/]+).*$#\1#')"
    if [ -n "$release_host" ]; then
      if preflight_probe "$release_host"; then
        ok "$release_host"
      else
        required_ok=0
        warn "${release_host} — không kết nối được"
      fi
    fi
  fi

  if [ -z "$OPT_ARCHIVE" ] && [ "$RELEASE_URL_IS_DEFAULT" = "1" ]; then
    # Default source is the Cloudflare Pages mirror (see DEFAULT_MIRROR_URL
    # above) -- probe it first. Only if the mirror itself is unreachable do
    # we fall back to the old GitHub path (github.com + its asset CDN),
    # exactly as this installer behaved before WP16.
    mirror_host="$(printf '%s' "$OPT_RELEASE_URL" | sed -E 's#^(https?://[^/]+).*$#\1#')"
    if preflight_probe "$mirror_host"; then
      ok "$mirror_host"
    else
      warn "${mirror_host} — không kết nối được"
      info "mirror không tới được — dùng GitHub"
      # Clear the mirror default so resolve_archive()'s "no OPT_RELEASE_URL"
      # branch runs (looks up the latest GitHub release), and so
      # write_config_env's mirror-persist check (RELEASE_URL_IS_MIRROR_BASE)
      # stays correctly off for this run.
      OPT_RELEASE_URL=""
      RELEASE_URL_IS_MIRROR_BASE=0
      RELEASE_URL_IS_DEFAULT=0
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
    if [ -n "$OPT_RELEASE_URL" ]; then
      fail "Không kết nối được tới nguồn tải ${OPT_RELEASE_URL} — kiểm tra OD_RELEASE_URL / --release-url, hoặc dùng --archive <file đã tải sẵn>."
    fi
    fail "Không kết nối được tới od-runtime.pages.dev (mirror) / github.com / release-assets.githubusercontent.com — cần ít nhất 1 trong các nguồn này để tải gói cài đặt. Nhờ IT mở domain rồi thử lại, hoặc dùng --archive <file đã tải sẵn>."
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
  case "$VERSION" in
    .|..|*[!A-Za-z0-9._-]*) fail "archive VERSION contains unsafe characters: ${VERSION}" ;;
  esac
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
  shasums="$(curl_text "$shasums_url")" || fail "could not fetch ${shasums_url}"
  filename="$(printf '%s\n' "$shasums" \
    | grep -oE "node-v${REQUIRED_NODE_MAJOR}\\.[0-9]+\\.[0-9]+-${dist_os}-${dist_arch}\\.tar\\.gz" \
    | head -1)"
  [ -n "$filename" ] || fail "no Node ${REQUIRED_NODE_MAJOR}.x build found for ${dist_os}-${dist_arch}"
  expected_sha="$(printf '%s\n' "$shasums" | grep " ${filename}\$" | awk '{print $1}')"

  mktemp_dir
  dl_dir="$LAST_TMP_DIR"
  node_tar="${dl_dir}/${filename}"
  step "Downloading ${filename}"
  curl_download "$node_tar" "https://nodejs.org/dist/latest-v${REQUIRED_NODE_MAJOR}.x/${filename}" \
    || fail "download failed after bounded retries: ${filename}"
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
RELEASE_STAGE=""
REPLACED_RELEASE_BACKUP=""
CONFIG_BACKUP=""
CONFIG_TEMP=""
CONFIG_HAD_PREVIOUS=0
CONFIG_WRITTEN=0
ACTIVATED=0
HEALTH_CONFIRMED=0
ROLLBACK_IN_PROGRESS=0

extract_release() {
  mkdir -p "${OD_HOME}/releases"
  RELEASE_DIR="${OD_HOME}/releases/${VERSION}"
  RELEASE_STAGE="$(mktemp -d "${OD_HOME}/releases/.${VERSION}.staging.XXXXXX")"
  tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_STAGE" --strip-components=1

  [ -f "${RELEASE_STAGE}/VERSION" ] || fail "staged release is missing VERSION"
  staged_version="$(tr -d '[:space:]' < "${RELEASE_STAGE}/VERSION")"
  [ "$staged_version" = "$VERSION" ] || fail "staged VERSION mismatch: expected ${VERSION}, got ${staged_version}"
  [ -f "${RELEASE_STAGE}/apps/daemon/dist/cli.js" ] \
    || fail "staged release is missing apps/daemon/dist/cli.js"
  [ -f "${RELEASE_STAGE}/install.sh" ] \
    || fail "staged release is missing install.sh required for the next self-update"
  case "$(uname -s)" in
    Darwin) required_service="${RELEASE_STAGE}/runtime/service/com.vnpay.open-design.plist.in" ;;
    Linux) required_service="${RELEASE_STAGE}/runtime/service/open-design.service.in" ;;
    *) required_service="" ;;
  esac
  [ -z "$required_service" ] || [ -f "$required_service" ] \
    || fail "staged release is missing required service template: ${required_service#${RELEASE_STAGE}/}"

  # A release channel may publish different preview bytes under the same
  # VERSION. Never overwrite the directory currently serving those bytes:
  # choose a distinct immutable target derived from the verified archive and
  # this installer process, then activate it through `current` below.
  active_version=""
  if [ -n "$PREV_CURRENT" ] && [ -f "${PREV_CURRENT}/VERSION" ]; then
    active_version="$(tr -d '[:space:]' < "${PREV_CURRENT}/VERSION")"
  fi
  if [ "$active_version" = "$VERSION" ]; then
    digest_prefix="$(printf '%s' "$ARCHIVE_SHA256" | cut -c1-12)"
    candidate="${OD_HOME}/releases/${VERSION}-${digest_prefix}-$$"
    candidate_index=0
    while [ -e "$candidate" ]; do
      candidate_index=$((candidate_index + 1))
      candidate="${OD_HOME}/releases/${VERSION}-${digest_prefix}-$$-${candidate_index}"
    done
    RELEASE_DIR="$candidate"
    step "Version ${VERSION} is active; promoting new bytes to $(basename "$RELEASE_DIR")"
  fi

  # An inactive same-version directory can be the residue of a previously
  # interrupted install. Move it aside first, atomically promote the fully
  # validated staging tree, then remove only that explicitly-scoped backup.
  if [ -e "$RELEASE_DIR" ]; then
    REPLACED_RELEASE_BACKUP="${OD_HOME}/releases/.${VERSION}.replaced.$$"
    [ ! -e "$REPLACED_RELEASE_BACKUP" ] || fail "temporary release backup already exists: ${REPLACED_RELEASE_BACKUP}"
    mv "$RELEASE_DIR" "$REPLACED_RELEASE_BACKUP"
    if ! mv "$RELEASE_STAGE" "$RELEASE_DIR"; then
      mv "$REPLACED_RELEASE_BACKUP" "$RELEASE_DIR" || true
      REPLACED_RELEASE_BACKUP=""
      fail "could not promote staged release to ${RELEASE_DIR}"
    fi
    RELEASE_STAGE=""
    rm -rf "$REPLACED_RELEASE_BACKUP"
    REPLACED_RELEASE_BACKUP=""
  else
    mv "$RELEASE_STAGE" "$RELEASE_DIR" || fail "could not promote staged release to ${RELEASE_DIR}"
    RELEASE_STAGE=""
  fi
  ok "Validated and promoted release to ${RELEASE_DIR}"
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
        mktemp_dir
        ef_path="${LAST_TMP_DIR}/env-file"
        curl_download "$ef_path" "$OPT_ENV_FILE" || fail "could not fetch --env-file ${OPT_ENV_FILE}"
        ;;
    esac
  fi
  [ -f "$ef_path" ] || fail "--env-file not found: ${ef_path}"
  ENV_FILE_VARS="$(grep -E '^(CONFLUENCE_URL|MEDIA_URL|MEDIA_APP_ID|MEDIA_USER_ID|MEDIA_USER_ROLE|IDENTITY_URL|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|SESSION_SECRET|OD_PORT|OD_DATA_DIR)=' "$ef_path" || true)"
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

  if [ "$OPT_UPDATE" = "1" ] && [ -f "${OD_HOME}/config.env" ]; then
    CONFIG_BACKUP="$(mktemp "${OD_HOME}/.config.env.backup.XXXXXX")"
    cp -p "${OD_HOME}/config.env" "$CONFIG_BACKUP"
    CONFIG_HAD_PREVIOUS=1
  fi

  PORT="$(resolve_cfg "$OPT_PORT" OD_PORT)"; PORT="${PORT:-$DEFAULT_PORT}"
  DATA_DIR="$(resolve_cfg "$OPT_DATA_DIR" OD_DATA_DIR)"; DATA_DIR="${DATA_DIR:-$DEFAULT_DATA_DIR}"
  confluence_url="$(resolve_cfg "" CONFLUENCE_URL)"
  media_url="$(resolve_cfg "$OPT_MEDIA_URL" MEDIA_URL)"
  media_app_id="$(resolve_cfg "$OPT_MEDIA_APP_ID" MEDIA_APP_ID)"
  media_user_id="$(resolve_cfg "$OPT_MEDIA_USER_ID" MEDIA_USER_ID)"
  media_user_role="$(resolve_cfg "$OPT_MEDIA_USER_ROLE" MEDIA_USER_ROLE)"
  identity_url="$(resolve_cfg "$OPT_IDENTITY_URL" IDENTITY_URL)"
  google_client_id="$(resolve_cfg "$OPT_GOOGLE_CLIENT_ID" GOOGLE_CLIENT_ID)"
  google_client_secret="$(resolve_cfg "$OPT_GOOGLE_CLIENT_SECRET" GOOGLE_CLIENT_SECRET)"
  session_secret="$(resolve_cfg "$OPT_SESSION_SECRET" SESSION_SECRET)"

  CONFIG_TEMP="$(mktemp "${OD_HOME}/.config.env.tmp.XXXXXX")"
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
    # Without this, apps/daemon/src/app-version.ts falls back to the nearest
    # package.json on disk (apps/daemon/package.json), which is a different,
    # not-kept-in-sync file from the one this release's VERSION was cut from
    # -- GET /api/update/status's `currentVersion` would then never match the
    # version the update just installed, so it never sees the update as
    # applied and the UI banner never clears.
    echo "OD_APP_VERSION=${VERSION}"
    # Mirror base URL survives into --update (the daemon loads config.env
    # into its env before spawning install.sh --update; resolve_release_url
    # reads it from either place). See --release-url in the header. The
    # RELEASE_URL_IS_DEFAULT guard keeps the untouched DEFAULT_MIRROR_URL
    # (WP16) out of config.env -- only a user/IT-provided source is durable;
    # the shipped default is free to change release-to-release.
    if [ "$RELEASE_URL_IS_DEFAULT" != "1" ]; then
      [ "$RELEASE_URL_IS_MIRROR_BASE" = "1" ] && echo "OD_RELEASE_URL=${OPT_RELEASE_URL}"
    fi
    [ -n "$confluence_url" ] && echo "CONFLUENCE_URL=${confluence_url}"
    [ -n "$media_url" ] && echo "MEDIA_URL=${media_url}"
    [ -n "$media_app_id" ] && echo "MEDIA_APP_ID=${media_app_id}"
    [ -n "$media_user_id" ] && echo "MEDIA_USER_ID=${media_user_id}"
    [ -n "$media_user_role" ] && echo "MEDIA_USER_ROLE=${media_user_role}"
    [ -n "$identity_url" ] && echo "IDENTITY_URL=${identity_url}"
    [ -n "$google_client_id" ] && echo "GOOGLE_CLIENT_ID=${google_client_id}"
    [ -n "$google_client_secret" ] && echo "GOOGLE_CLIENT_SECRET=${google_client_secret}"
    [ -n "$session_secret" ] && echo "SESSION_SECRET=${session_secret}"
  } > "$CONFIG_TEMP"
  chmod 600 "$CONFIG_TEMP"
  CONFIG_WRITTEN=1
  mv "$CONFIG_TEMP" "${OD_HOME}/config.env"
  CONFIG_TEMP=""

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

# Fresh install over an existing one = uninstall first, then install (asked
# 2026-08-18; mirrors install.ps1's Remove-ExistingInstallation).
# OpenDesign-Install.command therefore no longer routes to --update; only
# OpenDesign-Update.command / the web button / `od self-update` update in
# place. Runs AFTER step 1 verified the new package so a download failure
# leaves the old install untouched. Project data (OD_DATA_DIR) is kept;
# everything under $OD_HOME plus the launchd plist / systemd unit goes.
remove_existing_installation() {
  if [ ! -e "${OD_HOME}/current" ] && [ ! -d "${OD_HOME}/releases" ] && [ ! -f "${OD_HOME}/config.env" ]; then
    return 0
  fi
  local old_version=""
  [ -f "${OD_HOME}/current/VERSION" ] && old_version="$(tr -d '[:space:]' < "${OD_HOME}/current/VERSION" 2>/dev/null || true)"
  phase "Gỡ bản cũ"
  step "Found an existing Open Design${old_version:+ ${old_version}} at ${OD_HOME} — removing it before the fresh install (project data is kept)"

  case "$(uname -s)" in
    Darwin)
      launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
      rm -f "$DARWIN_PLIST_PATH"
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now open-design >/dev/null 2>&1 || true
        rm -f "$LINUX_UNIT_PATH"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
      ;;
  esac
  if [ -f "${OD_HOME}/open-design.pid" ]; then
    kill "$(cat "${OD_HOME}/open-design.pid" 2>/dev/null)" >/dev/null 2>&1 || true
  fi

  rm -rf "$OD_HOME"
  [ -e "$OD_HOME" ] && fail "could not remove the previous installation at ${OD_HOME} — check permissions and run the installer again"
  mkdir -p "$OD_HOME"
  ok "Previous installation removed${old_version:+ (${old_version})}"
}

step3_extract_and_configure() {
  phase "3/6 Giải nén & cài đặt"
  [ -L "${OD_HOME}/current" ] && PREV_CURRENT="$(readlink "${OD_HOME}/current")"
  extract_release
  write_config_env
  mkdir -p "${OD_HOME}/logs"
  ACTIVATED=1
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
restore_previous_config() {
  [ "$CONFIG_WRITTEN" = "1" ] || return 0
  restore_tmp="$(mktemp "${OD_HOME}/.config.env.restore.XXXXXX")"
  if [ "$CONFIG_HAD_PREVIOUS" = "1" ] && [ -f "$CONFIG_BACKUP" ]; then
    if ! cp -p "$CONFIG_BACKUP" "$restore_tmp" \
      || ! mv "$restore_tmp" "${OD_HOME}/config.env"; then
      rm -f "$restore_tmp"
      return 1
    fi
    warn "Restored previous config.env"
  else
    rm -f "$restore_tmp" "${OD_HOME}/config.env"
  fi
  CONFIG_WRITTEN=0
}

perform_rollback() {
  [ "$ROLLBACK_IN_PROGRESS" = "0" ] || return 0
  ROLLBACK_IN_PROGRESS=1
  restore_previous_config || error "Could not restore previous config.env — manual intervention required."

  if [ "$ACTIVATED" = "1" ] && [ -n "$PREV_CURRENT" ] && [ "$PREV_CURRENT" != "$RELEASE_DIR" ]; then
    warn "Install was interrupted or unhealthy — rolling back to $(basename "$PREV_CURRENT")"
    failed_release="$RELEASE_DIR"
    ln -sfn "$PREV_CURRENT" "${OD_HOME}/current"
    RELEASE_DIR="$PREV_CURRENT"
    write_service_files || true
    start_service || true
    if wait_for_health "$PORT" 30; then
      warn "Rolled back successfully. Release ${VERSION} was NOT activated."
    else
      error "Rollback also failed the health check — manual intervention required."
    fi
    RELEASE_DIR="$failed_release"
  elif [ "$ACTIVATED" = "1" ]; then
    stop_service || true
    error "No previous release to roll back to. Service stopped."
  fi
  ACTIVATED=0
}

rollback() {
  # Explicit rollback() is only called after the new `current` target has
  # been activated (the EXIT handler calls perform_rollback() directly).
  ACTIVATED=1
  perform_rollback
  error "Install/update FAILED for version ${VERSION}. Logs: ${OD_HOME}/logs/"
  exit 1
}

handle_exit() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && { [ "$ACTIVATED" = "1" ] || [ "$CONFIG_WRITTEN" = "1" ]; } \
    && [ "$HEALTH_CONFIRMED" = "0" ]; then
    perform_rollback || true
  fi
  cleanup_tmp || true
  exit "$status"
}

handle_int() { exit 130; }
handle_term() { exit 143; }

finalize_transaction() {
  HEALTH_CONFIRMED=1
  CONFIG_WRITTEN=0
  [ -z "$CONFIG_BACKUP" ] || rm -f "$CONFIG_BACKUP"
  CONFIG_BACKUP=""
}

# After a HEALTHY update, remove every release under $OD_HOME/releases that
# is not the one `current` points at (asked 2026-08-18: the web "Cập nhật"
# button must leave the machine with only the new version, i.e. old
# version removed, new one installed and started -- ordered install ->
# start -> remove-old so a failed health check can still roll back; not
# run on --no-start, where nothing verified the new release). Never
# touches the running release, project data, tools/ (private Node) or logs.
# Best-effort: an undeletable directory only warns.
remove_old_releases() {
  local releases_dir="${OD_HOME}/releases"
  [ -d "$releases_dir" ] || return 0
  local current_target=""
  if [ -L "${OD_HOME}/current" ]; then
    current_target="$(cd "${OD_HOME}/current" 2>/dev/null && pwd -P || true)"
  fi
  [ -n "$current_target" ] || return 0
  local removed=0
  local entry entry_real
  for entry in "$releases_dir"/* "$releases_dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    entry_real="$(cd "$entry" 2>/dev/null && pwd -P || true)"
    [ -n "$entry_real" ] || continue
    [ "$entry_real" != "$current_target" ] || continue
    if rm -rf "$entry" 2>/dev/null; then
      removed=$((removed + 1))
    else
      warn "could not remove old release: ${entry}"
    fi
  done
  [ "$removed" -eq 0 ] || ok "Removed ${removed} old release(s); only $(basename "$current_target") remains"
}

step5_start_and_health_check() {
  phase "5/6 Khởi động & kiểm tra sức khỏe"
  if [ "$OPT_NO_START" = "1" ]; then
    step "--no-start: skipping service start and health check"
    finalize_transaction
    return
  fi
  start_service
  step "Waiting for health check (up to ${HEALTH_TIMEOUT}s)…"
  if wait_for_health "$PORT" "$HEALTH_TIMEOUT"; then
    ok "Daemon is healthy on port ${PORT}"
    finalize_transaction
    # Only here -- after a CONFIRMED healthy start (not on --no-start, where
    # nothing verified the new release and the old one is the only way back).
    remove_old_releases
  else
    rollback
  fi
}

# ---------------------------------------------------------------------------
# macOS-only: regenerate the 4 local launcher .command files (CÁCH B, no
# Developer ID / notarization yet). macOS attaches com.apple.quarantine to a
# file ONLY when a browser (or anything using the Quarantine API, e.g.
# curl'd-then-unzipped-by-Safari) writes it -- never to a file a script
# copies from an already-downloaded-and-verified payload like this install's
# own extracted release. So every successful install/update regenerates
# fresh, unquarantined copies under ~/Applications/Open Design/ (a standard
# user-writable location Finder/Launchpad already show) from the payload
# that was just installed/updated. From then on the user can double-click
# any of them with no Gatekeeper "Open Anyway" prompt -- unlike the 4
# .command files inside OpenDesign-macOS-Installer.zip, which DO inherit
# quarantine from the browser download of the zip itself.
#
# Entirely best-effort: a missing runtime/launchers/ (older tarball built
# before this feature) or a copy/chmod failure only warns, it never fails
# the install/update. --start / --stop intentionally do NOT call this --
# they stay zero-side-effect, per their own docblock above.
install_mac_launchers() {
  [ "$(uname -s)" = "Darwin" ] || return 0
  src_dir="${OD_HOME}/current/runtime/launchers"
  if [ ! -d "$src_dir" ]; then
    warn "Không thấy runtime/launchers trong bản cài này (${src_dir}) — bỏ qua tạo launcher cục bộ."
    return 0
  fi
  dest_dir="${HOME}/Applications/Open Design"
  mkdir -p "$dest_dir" 2>/dev/null || { warn "không tạo được ${dest_dir} — bỏ qua tạo launcher cục bộ"; return 0; }
  found=0
  for src in "$src_dir"/*.command; do
    [ -e "$src" ] || continue
    found=1
    name="$(basename "$src")"
    if cp "$src" "${dest_dir}/${name}" 2>/dev/null; then
      chmod +x "${dest_dir}/${name}" 2>/dev/null || true
      # Best-effort self-heal only: a file this loop just copied never has
      # the flag in the first place, so this only matters if the user
      # previously overwrote it with a quarantined copy from elsewhere.
      xattr -d com.apple.quarantine "${dest_dir}/${name}" 2>/dev/null || true
    else
      warn "không copy được ${name} vào ${dest_dir}"
    fi
  done
  if [ "$found" = "0" ]; then
    warn "runtime/launchers trống trong bản cài này (${src_dir}) — bỏ qua tạo launcher cục bộ."
    return 0
  fi
  ok "Launcher cục bộ: ${dest_dir}"
  info "Double-click các file trên — không bị Gatekeeper hỏi \"Open Anyway\" (file sinh cục bộ, không tải qua trình duyệt)."
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
  curl_stream https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=true sh \
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
    if ! (curl_stream https://claude.ai/install.sh | bash -s -- "$pin"); then
      warn "Pinned Claude CLI install failed or is unsupported by the installer — falling back to latest"
      curl_stream https://claude.ai/install.sh | bash \
        || warn "Claude CLI install failed — install manually: curl -fsSL https://claude.ai/install.sh | bash"
    fi
  else
    curl_stream https://claude.ai/install.sh | bash \
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
  install_mac_launchers
}

# ---------------------------------------------------------------------------
# --update summary (prints the new version from /api/version)
# ---------------------------------------------------------------------------
print_update_summary() {
  if [ "$OPT_NO_START" = "1" ]; then
    ok "Update installed (not started — --no-start)."
    install_mac_launchers
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
  install_mac_launchers
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Install traps only for real executions (not test-time sourcing). EXIT is
  # the single cleanup/transaction boundary; INT/TERM preserve conventional
  # exit codes and flow through it, triggering rollback when needed.
  trap handle_exit EXIT
  trap handle_int INT
  trap handle_term TERM

  printf "\n"
  printf "${BOLD}  ┌──────────────────────────────────────┐${RESET}\n"
  printf "${BOLD}  │${RESET}   ${CYAN}◈${RESET}  ${BOLD}Open Design — Host Runtime${RESET}       ${BOLD}│${RESET}\n"
  printf "${BOLD}  │${RESET}      ${DIM}One-command installer${RESET}                ${BOLD}│${RESET}\n"
  printf "${BOLD}  └──────────────────────────────────────┘${RESET}\n"

  mkdir -p "$OD_HOME"

  resolve_release_url
  preflight_check
  step1_verify_package
  [ "$OPT_UPDATE" = "1" ] || remove_existing_installation
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

# ---------------------------------------------------------------------------
# `--start` / `--stop` — lifecycle commands for an ALREADY-installed runtime.
#
# These never download, extract, or rewrite config.env: they only drive the
# service manager the install already registered. They exist so macOS can ship
# OpenDesign-Start.command / OpenDesign-Stop.command, the double-click
# counterparts of the Windows OpenDesign-Start.cmd / OpenDesign-Stop.cmd
# (which call install.ps1 -Start / -Stop the same way). A designer must not
# have to type `launchctl bootout gui/$(id -u)/com.vnpay.open-design`.
#
# The launchd bootstrap race (`Bootstrap failed: 5: Input/output error` when
# bootstrap runs before launchd finished tearing the old job down) is already
# handled by start_service()'s retry loop — that is exactly why these route
# through start_service instead of calling launchctl directly.
# ---------------------------------------------------------------------------

# Service mode for an install that already exists. Unlike write_service_files
# (the install path) this NEVER renders a template — a stop must not rewrite
# the plist, and a start must use whatever the install registered. Falls back
# to nohup when the unit/plist is absent (e.g. installed with --no-start on a
# machine with no launchd/systemd), which is the same daemon, just unmanaged.
detect_service_mode() {
  case "$(uname -s)" in
    Darwin)
      SERVICE_MODE="launchd"
      [ -f "$DARWIN_PLIST_PATH" ] || SERVICE_MODE="nohup"
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && [ -f "$LINUX_UNIT_PATH" ]; then
        SERVICE_MODE="systemd"
      else
        SERVICE_MODE="nohup"
      fi
      ;;
    *) SERVICE_MODE="nohup" ;;
  esac
}

require_existing_install() {
  [ -f "${OD_HOME}/current/apps/daemon/dist/cli.js" ] \
    || fail "Open Design chưa được cài ở ${OD_HOME} — chạy OpenDesign-Install.command trước."
}

# Node for the nohup path (launchd/systemd already have the interpreter baked
# into the plist/unit). System Node when it matches engines, else the private
# copy install.sh downloaded under $OD_HOME/tools.
resolve_existing_node_bin() {
  if node_satisfies_engine; then
    NODE_BIN="$(command -v node)"
    return 0
  fi
  for candidate in "${OD_HOME}/tools"/node-v*/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

resolve_existing_port() {
  existing_port="$(existing_config_value OD_PORT)"
  printf '%s' "${existing_port:-$DEFAULT_PORT}"
}

run_start_command() {
  require_existing_install
  detect_service_mode
  resolve_existing_node_bin \
    || fail "không tìm thấy Node.js ${REQUIRED_NODE_MAJOR}.x — chạy lại OpenDesign-Install.command."
  start_port="$(resolve_existing_port)"
  phase "Khởi động Open Design"
  start_service
  step "Chờ daemon sẵn sàng (tối đa ${HEALTH_TIMEOUT}s)..."
  if wait_for_health "$start_port"; then
    ok "Open Design đang chạy trên cổng ${start_port}"
    info "URL: http://127.0.0.1:${start_port}"
  else
    fail "daemon không phản hồi health check — xem log tại ${OD_HOME}/logs/"
  fi
}

run_stop_command() {
  require_existing_install
  detect_service_mode
  phase "Dừng Open Design"
  stop_service
  # A launchd/systemd stop can still race a detached child, and the nohup path
  # only knows the pid it wrote — sweep anything still running from THIS
  # install so a following --start does not hit "port already in use".
  pkill -f "${OD_HOME}/current/apps/daemon/dist/cli.js" >/dev/null 2>&1 || true
  ok "Open Design đã dừng."
}

# deploy/tests/host-install.test.ts sources this script with
# OD_INSTALL_SH_TEST_SOURCE=1 to unit-test individual functions (tar safety,
# checksum, config.env generation, rollback) without ever driving a real
# launchd/systemd session. Every real invocation (curl | bash, bash
# install.sh …) leaves this unset and runs normally.
if [ "${OD_INSTALL_SH_TEST_SOURCE:-0}" != "1" ]; then
  if [ "$OPT_STOP" = "1" ]; then
    run_stop_command
  elif [ "$OPT_START" = "1" ]; then
    run_start_command
  else
    main
  fi
fi

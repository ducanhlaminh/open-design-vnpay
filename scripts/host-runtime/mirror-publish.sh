#!/usr/bin/env bash
# Publish a host-runtime release to the download mirror -- the SAME code path
# the release workflow's "Mirror" step runs, usable from any machine with
# `gh` (+ `aws` or `npx`) to backfill a release cut before the mirror existed,
# or to try a new bucket/project without waiting for CI. Why a mirror at all:
# deploy/host/README.md "Download mirror" (corporate TLS inspection of
# github.com throttles release downloads to a few hundred KB/s).
#
# Two targets:
#   --bucket <name>          S3-compatible bucket (Cloudflare R2, MinIO, AWS S3)
#                            via `aws s3 cp`; whole files.
#   --pages-project <name>   Cloudflare Pages (free, no card, Cloudflare CDN)
#                            via `wrangler pages deploy`. Pages caps files at
#                            25 MiB, so tarballs are split into .partNN files
#                            (build-release-manifest.ts --split-mib 24) and
#                            release.json carries "<platform>.parts"; the
#                            installers reassemble. Each deploy replaces the
#                            whole site, so only THIS tag + latest/ are served.
#
# Layout written under <public-url>:
#   <tag>/    open-design-runtime-*.tar.gz[.partNN] (+ .sha256), OpenDesign-*-Installer.zip,
#             release.json (points INTO this folder), install.ps1, install.sh
#   latest/   release.json, install.ps1, install.sh, OpenDesign-*-Installer.zip
#
# Usage:
#   scripts/host-runtime/mirror-publish.sh --tag host-runtime-v0.8.52 \
#     --pages-project od-runtime [--public-url https://od-runtime.pages.dev]
#   scripts/host-runtime/mirror-publish.sh --tag host-runtime-v0.8.52 \
#     --bucket <bucket> --public-url https://dl.example.com/open-design \
#     [--endpoint https://<account>.r2.cloudflarestorage.com] [--prefix <p>] [--region auto]
#   common: [--repo ducanhlaminh/open-design-vnpay] [--assets-dir <dir already holding the assets>] [--dry-run]
#
# Credentials (env): S3 -> AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
#                    Pages -> CLOUDFLARE_API_TOKEN (Pages: Edit) / CLOUDFLARE_ACCOUNT_ID.
# --dry-run stages everything and prints the upload command without running it.
set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TAG="" BUCKET="" PAGES_PROJECT="" PUBLIC_URL="" ENDPOINT="" PREFIX="" REGION="auto"
REPO="ducanhlaminh/open-design-vnpay" ASSETS_DIR="" DRY_RUN=0
SPLIT_MIB=24   # Cloudflare Pages limit is 25 MiB per file
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) shift; TAG="${1:-}" ;;
    --bucket) shift; BUCKET="${1:-}" ;;
    --pages-project) shift; PAGES_PROJECT="${1:-}" ;;
    --public-url) shift; PUBLIC_URL="${1:-}" ;;
    --endpoint) shift; ENDPOINT="${1:-}" ;;
    --prefix) shift; PREFIX="${1:-}" ;;
    --region) shift; REGION="${1:-}" ;;
    --repo) shift; REPO="${1:-}" ;;
    --assets-dir) shift; ASSETS_DIR="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$TAG" ] || { echo "--tag is required (see --help)" >&2; exit 2; }
if [ -n "$BUCKET" ] && [ -n "$PAGES_PROJECT" ]; then echo "use either --bucket or --pages-project, not both" >&2; exit 2; fi
if [ -z "$BUCKET" ] && [ -z "$PAGES_PROJECT" ]; then echo "--bucket or --pages-project is required" >&2; exit 2; fi
if [ -n "$PAGES_PROJECT" ] && [ -z "$PUBLIC_URL" ]; then PUBLIC_URL="https://${PAGES_PROJECT}.pages.dev"; fi
[ -n "$PUBLIC_URL" ] || { echo "--public-url is required with --bucket" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) is required" >&2; exit 2; }
if [ "$DRY_RUN" = "0" ]; then
  if [ -n "$BUCKET" ]; then
    command -v aws >/dev/null 2>&1 || { echo "aws (AWS CLI) is required for --bucket" >&2; exit 2; }
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || { echo "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be set" >&2; exit 2; }
  else
    command -v npx >/dev/null 2>&1 || { echo "npx (Node.js) is required for --pages-project" >&2; exit 2; }
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID must be set" >&2; exit 2; }
  fi
fi

log() { printf '[mirror-publish] %s\n' "$1"; }
PUBLIC_URL="${PUBLIC_URL%/}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/od-mirror.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
MIRROR="$WORK/mirror"
mkdir -p "$MIRROR/$TAG" "$MIRROR/latest"

if [ -n "$ASSETS_DIR" ]; then
  ASSETS="$(cd "$ASSETS_DIR" && pwd)"
  log "using assets from $ASSETS"
else
  ASSETS="$WORK/assets"; mkdir -p "$ASSETS"
  log "downloading release $TAG assets from github.com/$REPO"
  gh release download "$TAG" --repo "$REPO" --dir "$ASSETS" \
    --pattern '*.tar.gz' --pattern '*.tar.gz.sha256' --pattern '*.zip'
fi
VERSION="$(printf '%s' "$TAG" | sed -E 's/^(host-runtime-)?v//')"
[ -n "$VERSION" ] || { echo "could not derive version from tag $TAG" >&2; exit 1; }

# Installers come from THIS checkout (deploy/host), not from inside the
# tarball: in CI both are the same commit, and when backfilling an older
# release the newest installer is the one that understands the mirror's
# release.json (e.g. "<platform>.parts" -- a tarball cut before multipart
# support carries an install.ps1 that would 404 on a parts-only mirror).
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cp "${WORKSPACE_ROOT}/deploy/host/install.ps1" "${WORKSPACE_ROOT}/deploy/host/install.sh" "$MIRROR/$TAG/"
cp "$ASSETS"/*.tar.gz "$ASSETS"/*.tar.gz.sha256 "$ASSETS"/*.zip "$MIRROR/$TAG/"

MANIFEST_EXTRA=()
if [ -n "$PAGES_PROJECT" ]; then MANIFEST_EXTRA=(--split-mib "$SPLIT_MIB"); fi
(
  cd "$MIRROR/$TAG" && node --experimental-strip-types "${SCRIPT_DIR}/build-release-manifest.ts" \
    --version "$VERSION" --tag "$TAG" --repo "$REPO" \
    --base-url "$PUBLIC_URL/$TAG" --out "$MIRROR/$TAG/release.json" "${MANIFEST_EXTRA[@]}"
)
if [ -n "$PAGES_PROJECT" ]; then
  # Whole tarballs exceed the per-file cap; only their parts are served.
  rm -f "$MIRROR/$TAG"/open-design-runtime-*.tar.gz
  # Immutable per-tag folder, rolling latest/: Pages reads cache rules from _headers.
  cat > "$MIRROR/_headers" <<EOF
/latest/*
  Cache-Control: no-cache
/${TAG}/*
  Cache-Control: public, max-age=31536000, immutable
EOF
fi
cp "$MIRROR/$TAG/release.json" "$MIRROR/$TAG/install.ps1" "$MIRROR/$TAG/install.sh" "$ASSETS"/*.zip "$MIRROR/latest/"

log "staged:"; (cd "$MIRROR" && find . -type f | sort | sed 's/^/  /')
log "release.json -> $(grep -o '"win32-x64.url": "[^"]*"' "$MIRROR/latest/release.json")$(grep -o '"win32-x64.parts": "[^"]*"' "$MIRROR/latest/release.json" | sed 's/^/ /')"

if [ -n "$BUCKET" ]; then
  PREFIX="${PREFIX#/}"; PREFIX="${PREFIX%/}"
  DEST="s3://${BUCKET}${PREFIX:+/$PREFIX}"
  ENDPOINT_ARGS=()
  [ -n "$ENDPOINT" ] && ENDPOINT_ARGS=(--endpoint-url "$ENDPOINT")
  UPLOAD_TAG=(aws s3 cp "${ENDPOINT_ARGS[@]}" --recursive --no-progress
    --cache-control "public, max-age=31536000, immutable" "$MIRROR/$TAG" "$DEST/$TAG")
  UPLOAD_LATEST=(aws s3 cp "${ENDPOINT_ARGS[@]}" --recursive --no-progress
    --cache-control "no-cache" "$MIRROR/latest" "$DEST/latest")
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run; would run:"; printf '  %q ' "${UPLOAD_TAG[@]}"; echo; printf '  %q ' "${UPLOAD_LATEST[@]}"; echo; exit 0
  fi
  export AWS_DEFAULT_REGION="$REGION" AWS_EC2_METADATA_DISABLED=true
  log "uploading $TAG/ (immutable) ..."; "${UPLOAD_TAG[@]}"
  log "uploading latest/ (no-cache) ..."; "${UPLOAD_LATEST[@]}"
else
  DEPLOY=(npx --yes wrangler@4 pages deploy "$MIRROR" --project-name "$PAGES_PROJECT" --branch main --commit-dirty=true)
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run; would run:"; printf '  %q ' "${DEPLOY[@]}"; echo; exit 0
  fi
  # Create the project on first use; "already exists" is not an error.
  if ! npx --yes wrangler@4 pages project list 2>/dev/null | grep -qE "^\W*${PAGES_PROJECT}\W"; then
    log "creating Pages project $PAGES_PROJECT"
    npx --yes wrangler@4 pages project create "$PAGES_PROJECT" --production-branch main >/dev/null 2>&1 || true
  fi
  log "deploying to Cloudflare Pages project $PAGES_PROJECT ..."
  "${DEPLOY[@]}"
fi

log "verifying $PUBLIC_URL/latest/release.json"
tries=0
until curl -fsSL "$PUBLIC_URL/latest/release.json" 2>/dev/null | grep -q "\"version\": \"$VERSION\""; do
  tries=$((tries + 1))
  [ "$tries" -lt 12 ] || { echo "public URL did not serve the new release.json after 60 s (not public yet, or CDN cache?)" >&2; exit 1; }
  sleep 5
done
log "ok -- install with: OD_RELEASE_URL=$PUBLIC_URL/latest"

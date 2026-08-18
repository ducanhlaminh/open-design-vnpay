#!/usr/bin/env bash
# Publish an EXISTING GitHub host-runtime release to the download mirror
# (same layout the release workflow's "Mirror" steps produce), from any
# machine with `gh` + `aws` -- for backfilling a release that was cut before
# the mirror secrets existed, or for testing a new bucket without waiting for
# CI. Why a mirror at all: deploy/host/README.md "Download mirror".
#
# Layout written under <public-url>:
#   <tag>/    open-design-runtime-*.tar.gz (+ .sha256), OpenDesign-*-Installer.zip,
#             release.json (points INTO this folder), install.ps1, install.sh
#   latest/   release.json, install.ps1, install.sh, OpenDesign-*-Installer.zip
#
# Usage:
#   scripts/host-runtime/mirror-publish.sh --tag host-runtime-v0.8.52 \
#     --bucket <bucket> --public-url https://dl.example.com/open-design \
#     [--endpoint https://<account>.r2.cloudflarestorage.com] [--prefix <key-prefix>] \
#     [--region auto] [--repo ducanhlaminh/open-design-vnpay] [--dry-run]
#
# Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment
# (an R2 "Object Read & Write" API token works as-is). --dry-run stages
# everything and prints the aws commands without uploading.
set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TAG="" BUCKET="" PUBLIC_URL="" ENDPOINT="" PREFIX="" REGION="auto"
REPO="ducanhlaminh/open-design-vnpay" DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) shift; TAG="${1:-}" ;;
    --bucket) shift; BUCKET="${1:-}" ;;
    --public-url) shift; PUBLIC_URL="${1:-}" ;;
    --endpoint) shift; ENDPOINT="${1:-}" ;;
    --prefix) shift; PREFIX="${1:-}" ;;
    --region) shift; REGION="${1:-}" ;;
    --repo) shift; REPO="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$TAG" ] && [ -n "$BUCKET" ] && [ -n "$PUBLIC_URL" ] || { echo "--tag, --bucket and --public-url are required (see --help)" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) is required" >&2; exit 2; }
command -v aws >/dev/null 2>&1 || { echo "aws (AWS CLI) is required" >&2; exit 2; }
if [ "$DRY_RUN" = "0" ] && { [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; }; then
  echo "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be set (or use --dry-run)" >&2; exit 2
fi

log() { printf '[mirror-publish] %s\n' "$1"; }
PUBLIC_URL="${PUBLIC_URL%/}"
PREFIX="${PREFIX#/}"; PREFIX="${PREFIX%/}"
DEST="s3://${BUCKET}${PREFIX:+/$PREFIX}"
ENDPOINT_ARGS=()
[ -n "$ENDPOINT" ] && ENDPOINT_ARGS=(--endpoint-url "$ENDPOINT")

WORK="$(mktemp -d "${TMPDIR:-/tmp}/od-mirror.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ASSETS="$WORK/assets"; MIRROR="$WORK/mirror"
mkdir -p "$ASSETS" "$MIRROR/$TAG" "$MIRROR/latest"

log "downloading release $TAG assets from github.com/$REPO"
gh release download "$TAG" --repo "$REPO" --dir "$ASSETS" \
  --pattern '*.tar.gz' --pattern '*.tar.gz.sha256' --pattern '*.zip'
VERSION="$(gh release view "$TAG" --repo "$REPO" --json tagName --jq '.tagName' | sed -E 's/^(host-runtime-)?v//')"
[ -n "$VERSION" ] || { echo "could not derive version from tag $TAG" >&2; exit 1; }

# The installers shipped INSIDE the win32 tarball are the ones that match
# this release exactly -- take them from there rather than from the checkout.
WIN_TARBALL="$(ls "$ASSETS"/open-design-runtime-*-win32-x64.tar.gz | head -1)"
STAGE_NAME="$(tar -tzf "$WIN_TARBALL" | head -1 | cut -d/ -f1)"
tar -xzf "$WIN_TARBALL" -C "$WORK" "$STAGE_NAME/install.ps1" "$STAGE_NAME/install.sh"
cp "$WORK/$STAGE_NAME/install.ps1" "$WORK/$STAGE_NAME/install.sh" "$MIRROR/$TAG/"

cp "$ASSETS"/*.tar.gz "$ASSETS"/*.tar.gz.sha256 "$ASSETS"/*.zip "$MIRROR/$TAG/"
(
  cd "$ASSETS" && node --experimental-strip-types "${SCRIPT_DIR}/build-release-manifest.ts" \
    --version "$VERSION" --tag "$TAG" --repo "$REPO" \
    --base-url "$PUBLIC_URL/$TAG" --out "$MIRROR/$TAG/release.json"
)
cp "$MIRROR/$TAG/release.json" "$MIRROR/$TAG/install.ps1" "$MIRROR/$TAG/install.sh" "$ASSETS"/*.zip "$MIRROR/latest/"

log "staged:"; (cd "$MIRROR" && find . -type f | sort | sed 's/^/  /')
log "release.json -> $(grep -o '"win32-x64.url": "[^"]*"' "$MIRROR/latest/release.json")"

UPLOAD_TAG=(aws s3 cp "${ENDPOINT_ARGS[@]}" --recursive --no-progress
  --cache-control "public, max-age=31536000, immutable" "$MIRROR/$TAG" "$DEST/$TAG")
UPLOAD_LATEST=(aws s3 cp "${ENDPOINT_ARGS[@]}" --recursive --no-progress
  --cache-control "no-cache" "$MIRROR/latest" "$DEST/latest")
if [ "$DRY_RUN" = "1" ]; then
  log "dry-run; would run:"; printf '  %q ' "${UPLOAD_TAG[@]}"; echo; printf '  %q ' "${UPLOAD_LATEST[@]}"; echo
  exit 0
fi
export AWS_DEFAULT_REGION="$REGION" AWS_EC2_METADATA_DISABLED=true
log "uploading $TAG/ (immutable) ..."; "${UPLOAD_TAG[@]}"
log "uploading latest/ (no-cache) ..."; "${UPLOAD_LATEST[@]}"

log "verifying $PUBLIC_URL/latest/release.json"
curl -fsSL "$PUBLIC_URL/latest/release.json" | grep -q "\"version\": \"$VERSION\"" \
  && log "ok -- install with: OD_RELEASE_URL=$PUBLIC_URL/latest" \
  || { echo "public URL did not serve the new release.json (bucket not public, or CDN cache?)" >&2; exit 1; }

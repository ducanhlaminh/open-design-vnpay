#!/usr/bin/env bash
#
# Build all platforms + publish to a GitHub Release in one command (VNPAY fork).
# Runs on macOS (mac DMGs are mac-only; Windows ships as a portable ZIP because
# the NSIS installer can only be built on Windows). See docs/BUILD-VNPAY-APP.md §6.
#
# Usage:
#   scripts/build-and-release.sh [VERSION] [--signed] [--dry-run] [--skip-win]
#
#   VERSION     x.y.z — bumps apps/packaged/package.json first. Omit to use the
#               version already in apps/packaged/package.json.
#   --signed    build signed + notarized mac DMGs (needs APPLE_ID /
#               APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID + Developer ID cert).
#   --dry-run   build everything + print the metadata.json, but DON'T upload.
#   --skip-win  mac only (no Windows portable zip).
#
# Prereqs: gh CLI authenticated (`gh auth login`); repo public; Node 24 + pnpm.
set -euo pipefail

REPO="ducanhlaminh/open-design-vnpay"
cd "$(dirname "$0")/.."   # repo root: ui/open-design-vnpay

# ---- parse args -------------------------------------------------------------
VERSION_ARG=""
SIGNED=""
DRYRUN=""
SKIP_WIN=""
for arg in "$@"; do
  case "$arg" in
    --signed)   SIGNED="--signed" ;;
    --dry-run)  DRYRUN="--dry-run" ;;
    --skip-win) SKIP_WIN="1" ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION_ARG="$arg" ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script builds mac DMGs and must run on macOS." >&2
  exit 1
fi

# ---- bake config (KGS/media) from .env.local so the app ships ready ---------
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi

# ---- bump version (optional) ------------------------------------------------
if [ -n "$VERSION_ARG" ]; then
  node -e '
    const fs = require("fs"); const f = "apps/packaged/package.json";
    let s = fs.readFileSync(f, "utf8");
    s = s.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${process.argv[1]}$2`);
    fs.writeFileSync(f, s);
  ' "$VERSION_ARG"
  echo "[release] bumped apps/packaged version -> $VERSION_ARG"
fi
VERSION="$(node -p "require('./apps/packaged/package.json').version")"
TAG="open-design-v$VERSION"

WORK=".tmp/release-$VERSION"
rm -rf "$WORK"; mkdir -p "$WORK"
DMG=".tmp/tools-pack/out/mac/namespaces/default/dmg/Open Design-default.dmg"

echo "==================================================================="
echo "[release] version=$VERSION tag=$TAG signed=${SIGNED:-no} dry-run=${DRYRUN:-no} skip-win=${SKIP_WIN:-no}"
echo "==================================================================="

# ---- 1. mac Apple Silicon (arm64) ------------------------------------------
echo "[release] [1/4] building mac arm64 DMG ..."
pnpm tools-pack mac build --to dmg $SIGNED
cp "$DMG" "$WORK/mac-arm64.dmg"

# ---- 2. mac Intel (x64) — cross-build; SAME output path, so copy after each -
echo "[release] [2/4] building mac Intel (x64) DMG ..."
OD_PACK_MAC_ARCH=x64 pnpm tools-pack mac build --to dmg $SIGNED
cp "$DMG" "$WORK/mac-x64.dmg"

# ---- 3. Windows portable ZIP (from win-unpacked in the build cache) ---------
WIN_ZIP=""
if [ -z "$SKIP_WIN" ]; then
  echo "[release] [3/4] building Windows (--to dir) + zipping portable ..."
  WIN_JSON="$WORK/win-build.json"
  pnpm tools-pack win build --to dir --json | tee "$WIN_JSON"
  # win-unpacked lives at the cache "unpackedPath", NOT out/win/.../builder/
  WINUP="$(grep -oE '"unpackedPath": "[^"]*"' "$WIN_JSON" | tail -1 | sed 's/.*: "//; s/"$//')"
  if [ -z "$WINUP" ] || [ ! -d "$WINUP" ]; then
    echo "[release] could not resolve win-unpacked path" >&2; exit 1
  fi
  # No-code machine setup: ship the Docker/sandbox bootstrap script already in
  # place next to Open Design.exe so the user never has to copy files by hand.
  cp scripts/setup-no-code/setup-open-design-windows.bat "$WINUP/"
  cp scripts/setup-no-code/setup-open-design-windows.ps1 "$WINUP/"
  cp scripts/setup-no-code/README.txt "$WINUP/HUONG-DAN-CAI-DAT.txt"
  WIN_ZIP="$WORK/open-design-$VERSION-win-x64-portable.zip"
  ditto -c -k --keepParent "$WINUP" "$WIN_ZIP"
else
  echo "[release] [3/4] skipping Windows (--skip-win)"
fi

# ---- 3b. mac no-code setup script (separate small asset) --------------------
# The mac script finds the installed app under /Applications itself, so it
# doesn't need to live inside the DMG — ship it as its own tiny zip next to
# the DMGs on the release page.
MAC_SETUP_ZIP="$WORK/open-design-$VERSION-setup-no-code-mac.zip"
MAC_SETUP_STAGE="$WORK/setup-no-code-mac"
rm -rf "$MAC_SETUP_STAGE"; mkdir -p "$MAC_SETUP_STAGE"
cp scripts/setup-no-code/setup-open-design-mac.command "$MAC_SETUP_STAGE/"
cp scripts/setup-no-code/README.txt "$MAC_SETUP_STAGE/HUONG-DAN-CAI-DAT.txt"
ditto -c -k --keepParent "$MAC_SETUP_STAGE" "$MAC_SETUP_ZIP"

# ---- 4. publish -------------------------------------------------------------
echo "[release] [4/4] publishing to GitHub Release $TAG ..."
node --experimental-strip-types scripts/release-github.ts \
  --version "$VERSION" \
  --arm64-dmg "$WORK/mac-arm64.dmg" \
  --x64-dmg "$WORK/mac-x64.dmg" \
  $SIGNED $DRYRUN

if [ -z "$DRYRUN" ]; then
  echo "[release] uploading mac no-code setup script ..."
  gh release upload "$TAG" "$MAC_SETUP_ZIP" --repo "$REPO" --clobber
fi

if [ -n "$WIN_ZIP" ] && [ -z "$DRYRUN" ]; then
  echo "[release] uploading Windows portable zip ..."
  gh release upload "$TAG" "$WIN_ZIP" --repo "$REPO" --clobber
fi

echo "==================================================================="
if [ -n "$DRYRUN" ]; then
  echo "[release] DRY RUN done — nothing uploaded. Artifacts in $WORK/"
else
  echo "[release] DONE. https://github.com/$REPO/releases/tag/$TAG"
fi
echo "==================================================================="

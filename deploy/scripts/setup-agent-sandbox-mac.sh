#!/usr/bin/env bash
# Open Design — Agent Sandbox Setup (macOS)
#
# Prepares a fresh Mac to run the open-design-vnpay desktop app with the
# agent-in-sandbox feature ready on first launch: installs Docker Desktop if
# missing, waits for the daemon to come up, then builds the two images the
# app needs (uireact-base + od-agent-sandbox) so nothing has to build lazily
# the first time a chat/pipeline run happens.
#
# What this script CANNOT finish for you:
#   - Docker Desktop's first-run license prompt (macOS requires a human click).
#   - `od sandbox login` — the Claude CLI OAuth flow is intentionally
#     interactive and cannot be scripted. Run it once yourself after this
#     script finishes (see the final message).
#
# Usage:
#   ./setup-agent-sandbox-mac.sh [--non-interactive]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILDER_DIR="$REPO_ROOT/skills/ui-react/builder"

NON_INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
  esac
done

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

prompt_confirm() {
  _question="$1" _default="$2"
  if [ "$NON_INTERACTIVE" = "1" ]; then return 0; fi
  _yn_default="y"
  if [ "$_default" = "0" ]; then _yn_default="n"; fi
  printf "%s [%s]: " "$_question" "$_yn_default" >&2
  read -r _yn
  case "$_yn" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$_default" = "1" ] && return 0; return 1 ;;
  esac
}

echo ""
printf "${BOLD}Open Design — agent sandbox setup (macOS)${RESET}\n"
echo ""

# ---------------------------------------------------------------------------
# 1. Docker Desktop: detect, install if missing, wait for the daemon
# ---------------------------------------------------------------------------
step "Checking for Docker…"
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  if [ "$NON_INTERACTIVE" = "1" ] || prompt_confirm "Install Docker Desktop now (brew install --cask docker)?" 1; then
    if ! command -v brew >/dev/null 2>&1; then
      warn "Homebrew is not installed either — bootstrapping it first (one-time, a few minutes)."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      # Apple Silicon brew installs to /opt/homebrew, Intel to /usr/local — add
      # whichever exists to this script's PATH so `brew` resolves immediately.
      [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
      [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
    fi
    step "Running: brew install --cask docker"
    brew install --cask docker
    ok "Docker Desktop installed."
  else
    error "Docker is required. Install it from https://www.docker.com/products/docker-desktop/ and re-run."
    exit 1
  fi
else
  ok "Docker is already installed."
fi

if ! docker info >/dev/null 2>&1; then
  warn "Docker is installed but not running."
  open -a Docker
  step "Waiting for Docker Desktop to start (first launch may ask you to accept its license — do that now)…"
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 3
  done
  if ! docker info >/dev/null 2>&1; then
    error "Docker still isn't running after 3 minutes. Open Docker Desktop manually, wait for it to be ready, and re-run this script."
    exit 1
  fi
fi
ok "Docker is running."

# ---------------------------------------------------------------------------
# 2. Build both images ahead of time (uireact-base → od-agent-sandbox)
# ---------------------------------------------------------------------------
echo ""
step "Building sandbox images (uireact-base + od-agent-sandbox) — a few minutes on first run…"
"$BUILDER_DIR/sandbox/build-sandbox.sh"
ok "Sandbox images ready."

# ---------------------------------------------------------------------------
# 3. What's still manual
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}Done.${RESET} Docker + both sandbox images are ready.\n"
echo ""
info "One manual step remains — log the sandboxed Claude CLI in (interactive OAuth, cannot be scripted):"
echo ""
sandbox_version="$(tr -d '[:space:]' < "$BUILDER_DIR/sandbox/sandbox.version")"
printf "    docker run -it --rm -v od-claude-auth:/home/node/.claude od-agent-sandbox:%s claude /login\n" "$sandbox_version"
echo ""
info "After that, open-design-vnpay is ready to run chat/pipelines with zero host Claude CLI install."

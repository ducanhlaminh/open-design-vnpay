#!/bin/bash
# OpenDesign-Install.command — macOS double-click installer for the Open
# Design host runtime. Thin wrapper: it never installs anything itself, it
# only decides which install.sh to run and keeps the Terminal window open at
# the end so the result (or the actionable error) stays visible.
#
#   - Existing install (~/.open-design/current/install.sh present) → runs THAT
#     bundled copy with --update (safe in-place update + rollback).
#   - No install yet → downloads the latest deploy/host/install.sh from
#     GitHub into a temp file and runs it (fresh install).
#
# Flags: --no-pause (scripts/CI: do not wait for a key press at the end).
# Env:   OD_HOME (default ~/.open-design), OD_INSTALL_SH_URL (override the
#        bootstrap URL — used by tests and mirrors).
#
# Windows has the equivalent OpenDesign-Install.cmd; this file is macOS
# only (Linux users keep `curl … | bash`, see deploy/host/README.md).
set -u

OD_HOME="${OD_HOME:-$HOME/.open-design}"
OD_INSTALL_SH_URL="${OD_INSTALL_SH_URL:-https://raw.githubusercontent.com/ducanhlaminh/open-design-vnpay/main/deploy/host/install.sh}"
PAUSE=1
for arg in "$@"; do
  case "$arg" in
    --no-pause) PAUSE=0 ;;
  esac
done

finish() {
  local code="$1"
  printf '\n'
  if [ "$code" -eq 0 ]; then
    printf 'Open Design is ready.\n'
  else
    printf 'Open Design installation did not complete. Review the message above.\n'
  fi
  if [ "$PAUSE" -eq 1 ]; then
    printf '\nPress Enter to close this window.'
    # shellcheck disable=SC2034
    read -r _ignored || true
  fi
  exit "$code"
}

printf '\n'
if [ -f "${OD_HOME}/current/install.sh" ]; then
  printf 'Open Design is already installed. Running a safe update instead...\n\n'
  bash "${OD_HOME}/current/install.sh" --update
  finish $?
fi

printf 'Installing Open Design...\n'
printf 'Downloading the latest Open Design installer...\n\n'
tmp="$(mktemp -t open-design-install.XXXXXX)" || finish 1
cleanup() { rm -f "$tmp"; }
if ! curl -fsSL "$OD_INSTALL_SH_URL" -o "$tmp"; then
  cleanup
  printf '\nCould not download the installer. Check your network connection and try again.\n'
  finish 1
fi
bash "$tmp"
code=$?
cleanup
finish "$code"

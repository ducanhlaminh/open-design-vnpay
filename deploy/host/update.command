#!/bin/bash
# OpenDesign-Update.command — macOS double-click updater. Runs the bundled
# install.sh of the CURRENT install with --update (never a fresh install: if
# nothing is installed it says so and points at OpenDesign-Install.command).
# Flags: --no-pause. Env: OD_HOME (default ~/.open-design).
set -u

OD_HOME="${OD_HOME:-$HOME/.open-design}"
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
    printf 'Open Design is up to date.\n'
  else
    printf 'Open Design update did not complete. Review the message above.\n'
  fi
  if [ "$PAUSE" -eq 1 ]; then
    printf '\nPress Enter to close this window.'
    # shellcheck disable=SC2034
    read -r _ignored || true
  fi
  exit "$code"
}

printf '\n'
if [ ! -f "${OD_HOME}/current/install.sh" ]; then
  printf 'Open Design is not installed yet (no %s/current/install.sh).\n' "$OD_HOME"
  printf 'Double-click OpenDesign-Install.command to install it first.\n'
  finish 1
fi
printf 'Updating Open Design...\n\n'
bash "${OD_HOME}/current/install.sh" --update
finish $?

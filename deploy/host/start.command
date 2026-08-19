#!/bin/bash
# OpenDesign-Start.command — macOS double-click "start". Runs the bundled
# install.sh of the CURRENT install with --start, which drives the LaunchAgent
# the installer registered (retrying the launchd bootstrap race) and waits for
# the health check before reporting success.
#
# Windows ships the equivalent OpenDesign-Start.cmd (install.ps1 -Start).
# Nothing here downloads or reinstalls anything.
#
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
    printf 'Open Design is running.\n'
  else
    printf 'Open Design could not be started. Review the message above.\n'
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
printf 'Starting Open Design...\n\n'
bash "${OD_HOME}/current/install.sh" --start
finish $?

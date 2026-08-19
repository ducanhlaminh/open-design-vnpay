#!/bin/bash
# OpenDesign-Stop.command — macOS double-click "stop". Runs the bundled
# install.sh of the CURRENT install with --stop: boots the LaunchAgent out
# (systemd stop / pid kill on the other service modes) and sweeps any daemon
# left running from this install.
#
# Windows ships the equivalent OpenDesign-Stop.cmd (install.ps1 -Stop).
# Project data and the install itself are untouched — this only stops the
# process; double-click OpenDesign-Start.command to bring it back.
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
    printf 'Open Design is stopped.\n'
  else
    printf 'Open Design could not be stopped. Review the message above.\n'
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
printf 'Stopping Open Design...\n\n'
bash "${OD_HOME}/current/install.sh" --stop
finish $?

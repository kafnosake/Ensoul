#!/bin/sh
cd "$(dirname "$0")" || exit 1
sh scripts/bootstrap.sh --setup
result=$?
if [ "$result" -ne 0 ]; then
  printf '\nInstallation failed. Press Enter to close.'
  read -r answer
fi
exit "$result"

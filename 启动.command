#!/bin/sh
cd "$(dirname "$0")" || exit 1
sh scripts/bootstrap.sh
result=$?
if [ "$result" -ne 0 ]; then
  printf '\nLaunch failed. Press Enter to close.'
  read -r answer
fi
exit "$result"

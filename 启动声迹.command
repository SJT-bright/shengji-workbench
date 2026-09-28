#!/bin/zsh
set -e
if [[ -d /Applications/声迹.app ]]; then
  open /Applications/声迹.app
else
  cd "${0:A:h}"
  if [[ ! -d release/声迹.app ]]; then
    npm install
    ./scripts/build-app.sh
  fi
  open release/声迹.app
fi

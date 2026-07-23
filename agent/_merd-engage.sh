#!/bin/bash
# Merd X engagement runner (called by launchd on a cadence).
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
export X_LIVE=true
echo "=== $(date) ===" >> "$HOME/Library/Logs/merd-engage.log"
./node_modules/.bin/tsx _merd-engage.mts >> "$HOME/Library/Logs/merd-engage.log" 2>&1

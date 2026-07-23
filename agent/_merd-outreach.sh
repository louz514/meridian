#!/bin/bash
# Merd X outbound-engagement runner (called by launchd on a cadence).
#
# MERD_OUTREACH_ENABLED is exported HERE rather than put in .env on purpose:
# only this scheduled job posts. Running `tsx _merd-outreach.mts` by hand still
# dry-runs, so testing can never accidentally reply to strangers.
export PATH="/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; [ -f .env ] && source .env; set +a
export X_LIVE=true
export MERD_OUTREACH_ENABLED=true
echo "=== $(date) ===" >> "$HOME/Library/Logs/merd-outreach.log"
./node_modules/.bin/tsx _merd-outreach.mts >> "$HOME/Library/Logs/merd-outreach.log" 2>&1

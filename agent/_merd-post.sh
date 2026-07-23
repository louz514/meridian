#!/bin/bash
# Merd X autopilot runner (called by launchd on a cadence).
export PATH="/usr/local/bin:$PATH"
cd /Users/zach/Downloads/meridian/agent || exit 1
set -a; [ -f .env ] && source .env; set +a
export X_LIVE=true
echo "=== $(date) ===" >> _autopilot.log
./node_modules/.bin/tsx _merd-autopilot.mts >> _autopilot.log 2>&1

#!/bin/bash
# Snapshot Merd's memory + action logs into the repo so they survive this
# machine. Self-throttles to ~once a day so the autopilot can call it every run.
export PATH="/usr/local/bin:$PATH"
REPO=/Users/zach/Downloads/meridian
STAMP="$HOME/.merd-backup-stamp"

# throttle: skip if a backup ran in the last 20h (unless FORCE=1)
if [ "$FORCE" != "1" ] && [ -f "$STAMP" ] && [ $(( $(date +%s) - $(cat "$STAMP" 2>/dev/null || echo 0) )) -lt 72000 ]; then
  exit 0
fi

cd "$REPO/agent" || exit 1
mkdir -p merd-memory/workspace
cp -Rf ~/.openhermit/workspaces/merd/. merd-memory/workspace/ 2>/dev/null
cp -f x-posts.jsonl merd-decisions.jsonl merd-memory/ 2>/dev/null
cd "$REPO" || exit 1
git add -f agent/merd-memory >/dev/null 2>&1  # logs are *.jsonl (gitignored), force them into the backup
if ! git diff --cached --quiet agent/merd-memory; then
  git commit -q -m "backup: merd memory $(date +%F_%H%M)"
  git push -q origin main && echo "merd memory backed up + pushed to GitHub"
fi
date +%s > "$STAMP"

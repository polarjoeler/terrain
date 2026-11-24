#!/bin/bash
# Drain the www-duplicate reservoir. TEMPORARY JOB — retire it once the pool is empty.
#
# WHY THIS EXISTS. shopify-radar PR #9 stopped ct_tail landing `www.X` as a second store, but it did
# nothing about the www rows already in the table. 196,589 of them had no bare twin when the fix went
# in, and ct_tail now correctly discovers the BARE domain of each of those shops — so a fresh
# duplicate pair forms for every orphan it re-observes. 19,464 pairs re-formed within hours of the
# first full cleanup. The fix converted the leak; it did not close it.
#
# WHY A SCHEDULED MERGE AND NOT A BULK RENAME. The reservoir is self-draining: each orphan pairs
# exactly once, the merge folds its data into the bare row and deletes the www row, so the pool
# shrinks by one. At the observed ~15k/day it empties in roughly two weeks, and certificates renew
# about every 90 days, so nearly every live shop gets re-observed. Renaming the 196k orphans instead
# would be a far larger irreversible write for no extra benefit — DNS-checked on 600 published
# visible orphans, the bare domain resolves for only 91.7%, and most of the rest are shops whose www
# name does not resolve either, i.e. already dead.
#
# RATE BUDGET: none. This is pure DB work — no store is fetched, so it never touches the one
# residential-IP Shopify-edge budget. It does hold a write connection, so the batch stays modest.
#
# HOW TO SEE THE DRAIN, AND WHEN TO RETIRE THIS JOB. Every run logs its own `WORKLIST <n> pairs`
# line. That number is the whole dashboard: it should fall run over run. Once it reads 0 for a few
# consecutive days the reservoir is empty — unload the plist and delete this file.
#
#   launchctl unload ~/Library/LaunchAgents/com.tembo.dedupe-www.plist
#
# BACKUPS. Each run writes the www rows and the side rows it deletes to BACKUP_DIR as gzipped JSONL.
# Nothing in the schema has a foreign key, so those files are the only undo. They are a few MB per
# run; Rex sits at ~87% disk, so prune them by hand once the result is trusted.
set -uo pipefail
cd /Users/joel/storepulse || exit 1

BACKUP_DIR=/Users/joel/backups/dedupe-www
mkdir -p "$BACKUP_DIR"

# One at a time. A second copy would rebuild the worklist under the first one's feet.
if pgrep -f "scripts/dedupe-www.mjs" >/dev/null 2>&1; then
  echo "$(date '+%F %T') already running — skipping this tick"
  exit 0
fi

# launchd hands an agent a minimal PATH with no node on it, so resolve node the way every other
# lane wrapper on Rex does. Without this the job runs daily and fails instantly on
# "node: command not found" — silently, because nothing reads the error log.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "$(date '+%F %T') FATAL node not on PATH — drain did not run" >&2
  exit 127
fi

echo "=== $(date '+%F %T') dedupe-www drain starting ==="
node --env-file=.env.local scripts/dedupe-www.mjs --batch 2000 --backup-dir "$BACKUP_DIR"
rc=$?
echo "=== $(date '+%F %T') dedupe-www drain finished rc=$rc ==="
exit $rc

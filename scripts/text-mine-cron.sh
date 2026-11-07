#!/bin/bash
# Chad — best-effort text-mine helper.
# Reads the banked homepage/contact copy already in the DB and extracts commercial attributes
# (business model, physical store, ships-international, founded year) with the LOCAL 7B model.
# ZERO network: it never touches the shared Shopify-edge IP budget, so it competes with nothing —
# the right job for the dev laptop's spare GPU. Resumable (only rows with banked text and no
# text_mined_at). Best-effort: Chad sleeps when closed; a batch that dies mid-run just resumes next
# wake. Low priority (Nice/LowPriorityIO in the plist) so it never gets in the way when Chad's in use.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /Users/joel/storepulse || exit 1

LOCK=/tmp/tembo-text-mine.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    echo "another text-mine holds the lock — exiting"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

DEADLINE=$(( $(date +%s) + 7000 ))   # ~1h55m — finish before the next 2h fire
node --env-file=.env.local scripts/heartbeat.mjs text-mine "starting (Chad, local 7B)" >/dev/null 2>&1 || true
echo "===== text-mine (Chad) $(date '+%F %T') ====="
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  OUT=$(node --env-file=.env.local scripts/text-mine.mjs --limit 300 2>&1)
  echo "$OUT" | grep -E "store\(s\)|mined|error" | head -3
  # header reads "text-mine: 0 store(s) ..." when nothing is left to mine → done for this fire.
  echo "$OUT" | grep -qE "text-mine: 0 store" && { echo "→ backlog drained"; break; }
done
node --env-file=.env.local scripts/heartbeat.mjs text-mine "idle — done" >/dev/null 2>&1 || true
echo "===== done $(date '+%F %T') ====="

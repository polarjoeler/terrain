#!/bin/bash
# text-mine — runs on Rex (always-on, ~85% idle CPU). Moved from Chad 2026-11-23: on Chad it stopped
# whenever the laptop slept and hadn't run since 10-25.
# Reads the banked homepage/contact copy already in the DB and extracts commercial attributes
# (business model, physical store, ships-international, founded year) with the LOCAL 7B model.
# ZERO network: it never touches the shared Shopify-edge IP budget, so it competes with nothing —
# the right job for Rex's idle CPU. Resumable (only rows with banked text and no text_mined_at). Low
# priority (Nice/LowPriorityIO in the plist) so it yields to everything else on the box.
#
# AFRICA FIRST: each batch mines the customer-visible markets (lib/markets.ts VISIBLE_MARKETS) until
# they're drained, then the rest of the world with whatever time is left in the fire.
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

VISIBLE="ZA,KE,NG,EG,MA,GH,TZ,UG,DZ,TN,CI,SN,MU,MZ,CM,BW,AO,NA,RW,ZM,ET,ZW,LY,MW,SO,LS,SZ"
DEADLINE=$(( $(date +%s) + 7000 ))   # ~1h55m — finish before the next 2h fire
node --env-file=.env.local scripts/heartbeat.mjs text-mine "starting (local 7B)" >/dev/null 2>&1 || true
echo "===== text-mine $(date '+%F %T') ====="
SCOPE="--country $VISIBLE"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  OUT=$(node --env-file=.env.local scripts/text-mine.mjs $SCOPE --limit 300 2>&1)
  echo "$OUT" | grep -E "store\(s\)|mined|error" | head -3
  # header reads "text-mine: 0 store(s) ..." when nothing is left to mine in this scope.
  if echo "$OUT" | grep -qE "text-mine: 0 store"; then
    if [ -n "$SCOPE" ]; then echo "→ Africa drained; mining the rest"; SCOPE=""; continue; fi
    echo "→ backlog drained"; break
  fi
done
node --env-file=.env.local scripts/heartbeat.mjs text-mine "idle — done" >/dev/null 2>&1 || true
echo "===== done $(date '+%F %T') ====="

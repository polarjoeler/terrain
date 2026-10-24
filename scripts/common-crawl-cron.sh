#!/bin/bash
# Common Crawl discovery — Africa-first. FREE, no API keys, DNS-based (rate-EXEMPT, so it never
# touches the Shopify-edge budget). Monthly cadence: Common Crawl publishes a new crawl ~monthly and
# re-running the same crawl yields nothing new, so this fires on the 1st (seed_commoncrawl auto-detects
# the latest crawl). Pulls every host under each African ccTLD suffix, DNS-classifies
# (seed_commoncrawl | bulk_classify): Shopify -> ct-discoveries.jsonl, other hosted CMS ->
# cms-discoveries.jsonl (published=false), then lands both. Its real value is the NON-Shopify SA tail
# (Wix/Squarespace/ShopStar) that the CT tailer structurally can't see.
#
# GLOBAL later: append more suffixes / broader TLDs to SUFFIXES once Africa is steady.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
RADAR="$HOME/shopify-radar"; PULSE="$HOME/storepulse"; PY="$RADAR/.venv/bin/python"

LOCK=/tmp/tembo-common-crawl.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1440 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else echo "another common-crawl run is active — exiting"; exit 0; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Africa-first: ZA/NG/KE lead, then the rest of the African ccTLD commercial suffixes.
SUFFIXES="co.za com.ng co.ke com.gh co.tz co.ug co.zw co.zm com.na co.bw"

cd "$PULSE" && node --env-file=.env.local scripts/heartbeat.mjs common-crawl "starting (Africa)" >/dev/null 2>&1 || true
echo "===== common-crawl $(date '+%F %T') ====="
mkdir -p "$RADAR/logs"; cd "$RADAR" || exit 1
for S in $SUFFIXES; do
  echo "--- $S ---"
  "$PY" seed_commoncrawl.py --tld "$S" --max-hosts 150000 2>>logs/common-crawl.err \
    | "$PY" bulk_classify.py --source common_crawl 2>>logs/common-crawl.err | tail -3
done

echo "=== landing finds ==="
cd "$PULSE" || exit 1
node --env-file=.env.local scripts/land-ct-discoveries.mjs 2>&1 | grep -iE "NEW|already|recall" | head -3
node --env-file=.env.local scripts/land-cms-discoveries.mjs 2>&1 | grep -iE "new|already|total" | head -3
node --env-file=.env.local scripts/heartbeat.mjs common-crawl "idle — done" >/dev/null 2>&1 || true
echo "===== common-crawl done $(date '+%F %T') ====="

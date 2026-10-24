#!/bin/bash
# Lucy — dedicated hosting-enrich (DNS/ASN) lane.
# DNS is RATE-EXEMPT, so this runs wide and never touches the shared Shopify-edge budget that
# Rex's fetch lanes draw on. Focus-first, resumable (only null-hosting rows), lockfile-guarded.
# Driven by com.tembo.hosting-enrich.plist (every 3h, RunAtLoad). Best-effort: if Lucy sleeps
# mid-run the job just stops and the next fire resumes — nothing depends on it.
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /Users/joel/storepulse || exit 1

LOCK=/tmp/tembo-hosting-enrich.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +240 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    echo "another hosting-enrich holds the lock — exiting"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Focus-first: ZA, KE, NG, then the rest of Africa + Middle East + JP.
FOCUS="ZA KE NG AO BW CI CM DZ EG ET GH LS LY MA MU MW MZ NA RW SN SO SZ TN TZ UG ZM ZW AE SA IL TR QA KW BH OM JO LB IQ YE PS SY JP"

node --env-file=.env.local scripts/heartbeat.mjs hosting-enrich "starting (Lucy, focus-first DNS)" >/dev/null 2>&1 || true
echo "===== hosting-enrich (Lucy) $(date '+%F %T') ====="
for C in $FOCUS; do
  echo "--- $C ---"
  node --env-file=.env.local scripts/hosting-enrich.mjs --all --country "$C" --concurrency 12 2>&1 | tail -5 || echo "!! $C failed"
done
node --env-file=.env.local scripts/heartbeat.mjs hosting-enrich "idle — done" >/dev/null 2>&1 || true
echo "===== done $(date '+%F %T') ====="

#!/bin/bash
# Nightly contact-quality sweep — turns info@ leads into named, typed, rankable contacts.
# See scripts/contact-enrich.mjs for the why; the short version is that a lead row with a generic
# mailbox and no way to tell it apart from a real one is the complaint this answers.
#
# Driven by scripts/launchd/com.tembo.contact-enrich.plist (nightly). Runs from the Mac on purpose:
# it is a multi-page crawl of merchant sites, which is unreliable from serverless, and it needs the
# residential IP (see the PACE note below).
#
# PACE, not egress spread: measured on two disjoint 10-store ZA Shopify samples, the Webshare fleet
# was rate-limited on 5/10 stores while the direct residential IP completed 10/10 with zero 429s —
# Shopify throttles datacenter ASNs on plain HTML far harder than on the checkout endpoints the
# Python probes use that fleet for. So this runs DIRECT, with 2 workers and a pause between a
# store's pages. It shares one IP's Shopify-edge budget with the payment probes, so it is scheduled
# away from them and deliberately capped per night rather than run --all.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"   # node under launchd's minimal PATH

cd /Users/joel/storepulse || exit 1

# Markets in sell-order. ~1200 stores/night at this pace (~8s/store, 2 workers) backfills ZA in
# about a fortnight and then only sees new discoveries. Raise LIMIT once the backlog is cleared.
FOCUS="ZA,KE,NG"
LIMIT=1200

# This runs for ~3 hours on a LAPTOP. On 2026-10-21 the run stopped dead at 02:43 with 528 of 1200
# stores done because the machine hit 1% battery and force-slept — caffeinate cannot hold off a
# low-power sleep. Nothing was lost (an unfinished store simply stays queued), but the log just
# stopped mid-line with no explanation. Record the power state up front so the next truncated run
# explains itself.
POWER=$(pmset -g batt 2>/dev/null | head -1)
CHARGE=$(pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -1)
echo "=== contact-enrich sweep $(date '+%Y-%m-%d %H:%M:%S') (markets: $FOCUS, limit: $LIMIT) ==="
echo "power: $POWER $CHARGE"
case "$POWER" in
  *"Battery Power"*) echo "WARNING: on battery ($CHARGE). A ~3h sweep will be cut short if this runs flat — plug in." ;;
esac
node --env-file=.env.local scripts/contact-enrich.mjs \
  --country "$FOCUS" --limit "$LIMIT" --concurrency 2 --delay-ms 1200

# Deliverability over whatever the crawl just landed. Pure DNS — no store is contacted and none of
# the Shopify-edge rate budget is touched — so it runs straight after at full concurrency, and
# cheaply re-checks anything new. An address that cannot receive mail is a bounce no matter how
# good the local-part looks, which is the other half of what a high-volume sender needs.
echo "--- deliverability pass ---"
node --env-file=.env.local scripts/contact-mx.mjs --limit 5000
echo "=== done $(date '+%H:%M:%S') ==="

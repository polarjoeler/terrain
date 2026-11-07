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

# Markets in sell-order.
FOCUS="ZA,KE,NG"

# LANE SPLIT — this file runs on BOTH machines and both agents fire at 01:15. Without a split they
# select the same `contact_checked_at IS NULL` rows in the same revenue order and crawl every store
# TWICE: no extra coverage, double the requests at each URL.
#
# Splitting by platform is the only split that actually parallelises. A Shopify store's own domain
# is served from Shopify's edge, so every machine behind the home IP competes for one rate budget —
# that lane must stay on a single box, paced. Every other CMS is fetched from the merchant's own
# server with no shared ceiling, so it can run harder, elsewhere, at the same time.
#
# Self-configuring by host so the same file is correct wherever it is pulled; CONTACT_LANE
# overrides it for a one-off.
LANE="${CONTACT_LANE:-}"
if [ -z "$LANE" ]; then
  case "$(scutil --get LocalHostName 2>/dev/null)" in
    *Studio*|*studio*) LANE="non-shopify" ;;   # Rex — own-domain, no contention
    *)                 LANE="shopify"     ;;   # Chad (and any other host) — the paced lane
  esac
fi
if [ "$LANE" = "non-shopify" ]; then
  LIMIT="${CONTACT_LIMIT:-6000}"   # no shared budget to protect
  CONC="${CONTACT_CONC:-6}"
  DELAY="${CONTACT_DELAY:-400}"
else
  LIMIT="${CONTACT_LIMIT:-1200}"   # paced: shares the Shopify edge with every other probe
  CONC="${CONTACT_CONC:-2}"
  DELAY="${CONTACT_DELAY:-1200}"
fi

# This runs for ~3 hours on a LAPTOP. On 2026-10-21 the run stopped dead at 02:43 with 528 of 1200
# stores done because the machine hit 1% battery and force-slept — caffeinate cannot hold off a
# low-power sleep. Nothing was lost (an unfinished store simply stays queued), but the log just
# stopped mid-line with no explanation. Record the power state up front so the next truncated run
# explains itself.
POWER=$(pmset -g batt 2>/dev/null | head -1)
CHARGE=$(pmset -g batt 2>/dev/null | grep -o '[0-9]*%' | head -1)
echo "=== contact-enrich sweep $(date '+%Y-%m-%d %H:%M:%S') · lane=$LANE · markets: $FOCUS · limit: $LIMIT ==="
echo "power: $POWER $CHARGE"
case "$POWER" in
  *"Battery Power"*) echo "WARNING: on battery ($CHARGE). A ~3h sweep will be cut short if this runs flat — plug in." ;;
esac
node --env-file=.env.local scripts/contact-enrich.mjs \
  --platform "$LANE" --country "$FOCUS" --limit "$LIMIT" --concurrency "$CONC" --delay-ms "$DELAY"

# Deliverability over whatever the crawl just landed. Pure DNS — no store is contacted and none of
# the Shopify-edge rate budget is touched — so it runs straight after at full concurrency, and
# cheaply re-checks anything new. An address that cannot receive mail is a bounce no matter how
# good the local-part looks, which is the other half of what a high-volume sender needs.
echo "--- deliverability pass ---"
node --env-file=.env.local scripts/contact-mx.mjs --limit 5000
echo "=== done $(date '+%H:%M:%S') ==="

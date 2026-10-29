#!/bin/bash
# Weekly ShopStar reverse-IP harvest — enumerate the fleet off the two xneelo anchor IPs via
# HackerTarget's free reverse-IP API, HTTP-confirm each (shared IP → exclude co-tenants), land +
# refresh live_status. Low cadence on purpose: the HackerTarget free tier is rate-limited and the
# ShopStar fleet grows slowly. Driven by scripts/launchd/com.tembo.harvest-shopstar.plist (Rex).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "${1:-$HOME/storepulse}" || exit 1
exec node --env-file=.env.local scripts/harvest-shopstar.mjs

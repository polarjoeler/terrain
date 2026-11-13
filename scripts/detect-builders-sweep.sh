#!/bin/bash
# Hosted-platform DNS sweep — WORLDWIDE. Reclassifies platform IS NULL / 'custom' rows in every country
# (incl. country-less) against the shared fingerprint table (scripts/lib/hosted-platforms.json, vendored
# from shopify-radar/hosted_platforms.json). Replaces the ad-hoc per-focus-country loop that lived
# untracked on Rex. Pure DNS — no request reaches a store, so it's outside the Shopify-edge budget.
# Reclassifying does NOT publish. Rows checked before the table's `version` date are re-checked once, so
# a new fingerprint applies retroactively. Measured 2026-11-13: the whole pool (~24k rows) in ~10 min.
#   Driven by ~/Library/LaunchAgents/com.tembo.detect-builders.plist (weekly).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
LOCK="/tmp/tembo-detect-builders.lock"
mkdir "$LOCK" 2>/dev/null || { [ -n "$(find "$LOCK" -maxdepth 0 -mmin +240 2>/dev/null)" ] && rmdir "$LOCK" && mkdir "$LOCK"; } || { echo "detect-builders already running"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
node --env-file=.env.local scripts/heartbeat.mjs detect-builders "hosted-platform DNS sweep" >/dev/null 2>&1 || true
echo "===== detect-builders $(date '+%F %T') ====="
node --env-file=.env.local scripts/detect-builders.mjs --limit 200000 --conc 40 --timeout 3000 || echo "!! detect-builders failed"
node --env-file=.env.local scripts/heartbeat.mjs detect-builders "idle — done" >/dev/null 2>&1 || true
echo "===== detect-builders done $(date '+%F %T') ====="

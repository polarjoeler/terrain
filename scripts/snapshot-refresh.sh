#!/bin/bash
# snapshot-refresh — keeps the Intelligence reports' snapshot-backed views current so they auto-update
# as the pipeline enriches (no manual rebuild). Runs the two DB-aggregate refreshers SEQUENTIALLY
# (never concurrent — the browse aggregate is heavy and the pool is small):
#   • refresh-browse-snapshot → the Explorer's facet/count snapshot + warms agg_cache (also powers the
#     live Africa timeline), THE key one.
#   • snapshot-providers → per-provider market-share snapshots for the provider dashboards.
# NB: snapshot-africa (the homepage-map committed-JSON fallback) is deliberately an opt-in WEEKLY
# refresh and is intentionally NOT run here. Driven by com.tembo.snapshot-refresh.plist (every 6h).
set -u
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "$HOME/storepulse" || exit 1
node --env-file=.env.local scripts/heartbeat.mjs snapshot-refresh "starting" >/dev/null 2>&1 || true
echo "===== snapshot-refresh $(date '+%F %T') ====="
# refresh-browse imports the app's TS lib (lib/leads-explore.ts → ./db) — node's type-stripping can't
# resolve extensionless .ts, so run it through the tsx loader (keeps --env-file working).
node --env-file=.env.local --import tsx scripts/refresh-browse-snapshot.mjs || echo "!! refresh-browse-snapshot failed"
node --env-file=.env.local scripts/snapshot-providers.mjs || echo "!! snapshot-providers failed"
node --env-file=.env.local scripts/heartbeat.mjs snapshot-refresh "idle — done" >/dev/null 2>&1 || true
echo "===== snapshot-refresh done $(date '+%T') ====="

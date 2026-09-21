#!/bin/bash
# Monthly Shopify recall report — reads the latest Shodan per-market lists (written by the
# discovery tick, no extra credits) and records what % of them we track, per market + overall,
# into coverage_benchmarks → shown on /ops/coverage. Needs SHODAN_API_KEY set (for the pulls).
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node --env-file=.env.local scripts/heartbeat.mjs recall-report "monthly shopify recall" >/dev/null 2>&1 || true
echo "===== recall-report $(date '+%F %T') ====="
node --env-file=.env.local scripts/recall-report.mjs || echo "!! recall-report failed"

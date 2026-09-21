#!/bin/bash
# Daily sync of Africa Shop Experts (Fundi) → Terrain's service_partners table.
set -u
cd "$HOME/storepulse" || exit 1
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
# Optional EXPERTS_SUPABASE_SERVICE_KEY (Fundi write-back) lives here, gitignored.
[ -f worker/.env.seeds ] && { set -a; . worker/.env.seeds; set +a; }
node --env-file=.env.local scripts/heartbeat.mjs sync-experts "pull experts" >/dev/null 2>&1 || true
echo "===== sync-experts $(date '+%F %T') ====="
node --env-file=.env.local scripts/sync-experts.mjs || echo "!! sync-experts failed"

# Attribute stores from PUBLIC signals (portfolio is cheap/no-crawl; footer piggybacks a small
# rolling batch). Writes back to Fundi automatically when EXPERTS_SUPABASE_SERVICE_KEY is set.
WB=""; [ -n "${EXPERTS_SUPABASE_SERVICE_KEY:-}" ] && WB="--writeback"
node --env-file=.env.local scripts/attribute-partners.mjs --footer 1500 $WB || echo "!! attribute-partners failed"
# Low-priority trickle: promote a few discovered agencies (footer-credit byproduct) into the
# directory as "Discovered" listings. A handful of agency-site fetches — never store discovery.
node --env-file=.env.local scripts/enrich-candidates.mjs --limit 8 || echo "!! enrich-candidates failed"
echo "===== done $(date '+%T') ====="

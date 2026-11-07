#!/bin/bash
# Keep the leads-browse aggregate cache (browse_cache) warm by hitting the production refresh endpoint.
# Run on a schedule by com.tembo.warm-browse.plist (every 30 min). Reads CRON_SECRET from the app's
# .env.local so the token isn't baked into the plist. Best-effort: if the token doesn't match prod or
# the endpoint is slow, the page still falls back to a live scan — this only pre-warms the hot keys.
set -euo pipefail
ENV_FILE="/Users/joel/storepulse/.env.local"
URL="https://heyterrain.com/api/cron/refresh-browse"
TOKEN="$(grep -E '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'' | tr -d '\r')"
curl -fsS --max-time 90 "${URL}?token=${TOKEN}" || echo "warm-browse: request failed ($(date))"
echo " · warm-browse ran $(date)"

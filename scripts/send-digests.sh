#!/bin/bash
# Daily trigger for the per-user weekly digest. POSTs the deployed /api/digest/send route,
# which finds the users whose digest is DUE (cadence elapsed) and emails each a digest scoped
# to their platform focus. The route is SAFE BY DEFAULT — it only actually sends when
# DIGEST_ENABLED=1 and RESEND_API_KEY are set in the deployment; otherwise it dry-runs.
#
# Setup before this does anything real:
#   1. Set CRON_SECRET (same value here + in Vercel env).
#   2. Set RESEND_API_KEY + EMAIL_FROM + DIGEST_ENABLED=1 in Vercel.
#   3. launchctl load ~/Library/LaunchAgents/com.tembo.send-digests.plist
#
# CRON_SECRET is read from worker/.env.seeds (gitignored) or the environment.
set -u
cd "$HOME/storepulse" 2>/dev/null || true
[ -f worker/.env.seeds ] && { set -a; . worker/.env.seeds; set +a; }
URL="${DIGEST_URL:-https://terrain-mocha.vercel.app/api/digest/send}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "[$(date '+%F %T')] send-digests: CRON_SECRET not set — skipping (see setup notes in this script)."
  exit 0
fi
echo "[$(date '+%F %T')] send-digests → $URL"
curl -s -X POST "$URL" -H "x-cron-secret: $CRON_SECRET" --max-time 120 | head -c 500
echo ""

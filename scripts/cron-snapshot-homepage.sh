#!/bin/bash
# Weekly refresh of the committed homepage-map snapshots. Regenerates lib/*-snapshot.json from the DB,
# commits ONLY those files, and pushes to main — which triggers a Vercel production redeploy.
#
# Runs in an ISOLATED git worktree ($WT) so it never touches your main working tree, current branch,
# or uncommitted changes. Enable it with:
#   cp scripts/launchd/com.tembo.snapshot-homepage.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.tembo.snapshot-homepage.plist
# Disable: launchctl unload ~/Library/LaunchAgents/com.tembo.snapshot-homepage.plist
#
# NOTE: each run that finds changes is an unattended production deploy. The homepage data changes
# slowly, so this is weekly. Run it by hand any time with: node --env-file=.env.local scripts/snapshot-homepage-map.mjs
set -euo pipefail
REPO="/Users/joel/storepulse"
WT="$HOME/.terrain-snapshot-wt"
mkdir -p "$HOME/Library/Logs"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') snapshot-homepage run ==="

# ensure an isolated worktree pinned to main exists
if ! git -C "$REPO" worktree list | grep -q "$WT"; then
  git -C "$REPO" worktree add -f "$WT" main
fi
git -C "$WT" fetch origin main -q
git -C "$WT" reset --hard origin/main -q

# regenerate the three snapshots using the repo's env (DATABASE_URL in .env.local)
( cd "$WT" && node --env-file="$REPO/.env.local" scripts/snapshot-homepage-map.mjs )

git -C "$WT" add lib/world-points-snapshot.json lib/world-stores-snapshot.json lib/geo-timeline-snapshot.json
if git -C "$WT" diff --cached --quiet; then
  echo "no snapshot changes — nothing to deploy"
else
  git -C "$WT" commit -q -m "chore: refresh homepage map snapshots [automated]"
  git -C "$WT" push -q origin HEAD:main
  echo "pushed refreshed snapshots → main (Vercel will redeploy)"
fi

#!/bin/bash
# Install (or refresh) the HOURLY payments-probe launchd job on THIS machine — e.g. a
# second worker laptop that offloads payment/shipping probing from the primary. Detects
# $HOME so it's username-agnostic. Run it AFTER:
#   1. git clone storepulse   → ~/storepulse   (+ npm install)
#   2. git clone shopify-radar → ~/shopify-radar
#   3. python3 -m venv ~/shopify-radar/.venv && ~/shopify-radar/.venv/bin/pip install httpx cryptography
#   4. put DATABASE_URL into ~/storepulse/.env.local
#
#   bash scripts/install-worker-launchd.sh
set -euo pipefail

LABEL="com.tembo.payments-probe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$HOME/storepulse/scripts/payments-probe.sh"
LOGDIR="$HOME/storepulse/logs"

# Preflight — warn loudly but don't block, so you can install then fix.
[ -f "$SCRIPT" ] || { echo "!! $SCRIPT not found — clone storepulse to ~/storepulse first."; exit 1; }
[ -x "$HOME/shopify-radar/.venv/bin/python" ] || echo "⚠️  ~/shopify-radar/.venv missing — create the venv (httpx, cryptography) or the probe step is skipped."
grep -q "DATABASE_URL" "$HOME/storepulse/.env.local" 2>/dev/null || echo "⚠️  DATABASE_URL not found in ~/storepulse/.env.local — add it or the queue/sync will fail."

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

# $HOME/$LOGDIR are expanded now (launchd needs absolute paths); \$HOME stays literal so
# the login shell resolves it at runtime (also picks up nvm/brew node on PATH via -lc).
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>exec "\$HOME/storepulse/scripts/payments-probe.sh"</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME/storepulse</string>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/payments-probe.out.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/payments-probe.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "✓ Installed $LABEL (runs hourly, and once now)."
echo "  Plist: $PLIST"
echo "  Logs:  $LOGDIR/payments-probe.out.log"
echo "  Verify loaded:   launchctl list | grep tembo"
echo "  Watch first run: tail -f $LOGDIR/payments-probe.out.log"

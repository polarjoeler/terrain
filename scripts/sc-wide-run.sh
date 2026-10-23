#!/usr/bin/env bash
# sc-wide-run — process every part file from the wide StoreCensus pull, in order, exactly once.
#
# The pull writes ~75k-row parts to ~/Downloads as it streams. This lands each one via
# sc-wide-part.mjs and records it in a done-file, so the run is resumable: re-running skips what
# already landed rather than re-importing it. Sequential by design — each part does batched DB
# writes and two import passes, and overlapping them just contends on the pooler.
set -uo pipefail
cd "$HOME/storepulse"
DONE="$HOME/storepulse/.sc-wide-done"
LOG="${1:-/tmp/sc-wide-run.log}"
touch "$DONE"
total=0; placed=0; pub=0; n=0
for f in "$HOME"/Downloads/sc_wide_p*.ndjson; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  if grep -qxF "$base" "$DONE"; then echo "skip $base (already landed)" | tee -a "$LOG"; continue; fi
  echo "=== $base ===" | tee -a "$LOG"
  if node --env-file=.env.local scripts/sc-wide-part.mjs "$f" 2>&1 \
       | grep -E "rows$|imported|placed|pass2" | tee -a "$LOG"; then
    echo "$base" >> "$DONE"; n=$((n+1))
  else
    echo "!! $base FAILED — left out of the done-file so a re-run retries it" | tee -a "$LOG"
  fi
done
echo "landed $n part(s) this run" | tee -a "$LOG"

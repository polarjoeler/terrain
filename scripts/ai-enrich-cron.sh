#!/bin/bash
# AI enrichment sweep — categorises + describes discovered stores that still lack a
# category/description. Resumable by design: only touches rows where category/description
# is empty, so re-runs never re-fetch or re-charge. LOCAL LLM (qwen on Rex) = $0/store.
#
# Driven by ~/Library/LaunchAgents/com.tembo.ai-enrich.plist (StartInterval 14400 = every 4h),
# but this script DRAINS CONTINUOUSLY within each fire: it loops batch-after-batch until the
# backlog is cleared or a wall-clock deadline (just under 4h) is hit, so Rex never sits idle
# between fires. A lockfile prevents a second launchd fire from overlapping the first.
#
# MODEL: pinned to qwen2.5:3b for THIS job only (measured ~1.8x the throughput of 7b at
# on-par quality for a one-category + one-line task). Other local-LLM jobs (deep-enrich,
# completeness) keep the .env.local default (7b) for their richer extraction.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"   # make `node` available under launchd's minimal PATH

cd /Users/joel/storepulse || exit 1

# ---- single-instance lock (atomic mkdir; auto-clears if stale >5h after a crash) ----
LOCK="/tmp/tembo-ai-enrich.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # stale-lock recovery: if the lockdir is older than 5h, a previous run died holding it.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +300 2>/dev/null)" ]; then
    echo "stale lock (>5h) — reclaiming"; rmdir "$LOCK" 2>/dev/null; mkdir "$LOCK" 2>/dev/null || exit 0
  else
    echo "another ai-enrich run holds the lock — exiting"; exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Route the Shopify-edge products.json fetch across the Webshare fleet (not the home IP).
export STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt"
# Keep the local GPU fed: parallel fetch+describe so the per-store fetch never starves ollama.
# (Concurrency past this doesn't raise throughput — one GPU serialises the describes — it just
# keeps the queue full so the GPU is never idle waiting on a fetch.)
export AI_ENRICH_CONC=24
# Faster model for this job (see header). Shell export overrides the .env.local default.
export LOCAL_LLM_MODEL=qwen2.5:3b

AFRICA="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW"
MIDEAST="AE,SA,IL,TR,QA,KW,BH,OM,JO,LB,IQ,YE,PS,SY"
FOCUS="$AFRICA,$MIDEAST,JP"

BATCH=6000                                   # rows per ai-enrich invocation
DEADLINE=$(( $(date +%s) + 13800 ))          # ~3h50m — finish before the next 4h fire
FLOOR=500                                    # stop draining a scope once it's within this of empty

# remaining rows missing category/description. arg1="focus" scopes to FOCUS countries; else global.
remaining() {
  local scope="$1"
  FOCUS="$FOCUS" SCOPE="$scope" node --env-file=.env.local -e "
    import('postgres').then(({default:p})=>{const s=p(process.env.DATABASE_URL,{prepare:false,max:1});
    const base=\"from imported_stores where published and coalesce(activity_tier,'') not in ('not_a_store','dormant') and (coalesce(category,'')='' or coalesce(description,'')='')\";
    const q = process.env.SCOPE==='focus'
      ? s.unsafe('select count(*)::int n '+base+' and upper(country)=any(string_to_array(\$1,\\',\\'))',[process.env.FOCUS])
      : s.unsafe('select count(*)::int n '+base);
    q.then(r=>{console.log(r[0].n);s.end()}).catch(()=>{console.log(-1);s.end()})})" 2>/dev/null
}

echo "===== ai-enrich $(date '+%F %T') — model=$LOCAL_LLM_MODEL, continuous drain (focus→global) ====="
node --env-file=.env.local scripts/heartbeat.mjs ai-enrich "starting (3b continuous)" >/dev/null 2>&1 || true

# Ensure the schema column exists ONCE per fire (brief ACCESS EXCLUSIVE lock), then tell every batch
# invocation below to skip it — so the tight loop never re-acquires that lock on the hot table.
node --env-file=.env.local -e "import('postgres').then(({default:p})=>{const s=p(process.env.DATABASE_URL,{prepare:false,max:1});s\`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ai_enriched_at TIMESTAMPTZ\`.then(()=>s.end()).catch(e=>{console.error(e.message);s.end()})})" 2>&1 | head -2
export SKIP_SCHEMA_ENSURE=1

# ---- Phase 1: drain FOCUS (Africa + Middle East + JP) ----
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  REMAIN=$(remaining focus)
  echo "focus remaining missing cat/desc: ${REMAIN:-?}"
  [ "${REMAIN:-0}" -ge 0 ] && [ "${REMAIN:-0}" -lt "$FLOOR" ] && { echo "→ focus drained"; break; }
  node --env-file=.env.local scripts/ai-enrich.mjs --all --country "$FOCUS" --limit "$BATCH" || { echo "!! focus batch failed"; sleep 30; }
done

# ---- Phase 2: spend remaining time budget on GLOBAL gaps ----
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  REMAIN=$(remaining global)
  echo "global remaining missing cat/desc: ${REMAIN:-?}"
  [ "${REMAIN:-0}" -ge 0 ] && [ "${REMAIN:-0}" -lt "$FLOOR" ] && { echo "→ global drained"; break; }
  node --env-file=.env.local scripts/ai-enrich.mjs --all --limit "$BATCH" || { echo "!! global batch failed"; sleep 30; }
done

node --env-file=.env.local scripts/heartbeat.mjs ai-enrich "idle — done" >/dev/null 2>&1 || true
echo "===== ai-enrich done $(date '+%F %T') ====="

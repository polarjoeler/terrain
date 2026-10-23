#!/bin/bash
# Daily AI enrichment sweep — categorises + describes newly-discovered live SA
# stores that still lack a category. Resumable by design: the script only touches
# rows where ai_enriched_at IS NULL, so re-runs never re-fetch or re-charge.
#
# Driven by ~/Library/LaunchAgents/com.tembo.ai-enrich.plist (daily).
# Runs from the Mac on purpose: merchant-site fetches are throttled/unreliable
# from serverless, so this heavy I/O lives here, and the web app only reads.

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"   # make `node` available under launchd's minimal PATH

cd /Users/joel/storepulse || exit 1

# Route the Shopify-edge products.json fetch across the Webshare fleet (not the home IP).
export STORE_PROBE_PROXY_FILE="$HOME/shopify-radar/proxies.txt"
# Rex has idle compute — run more parallel fetch+describe so the local LLM stays fed (keeps the
# per-store fetch from starving ollama). DB pool scales as CONCURRENCY+1.
export AI_ENRICH_CONC=16

# LOCAL LLM (qwen on Rex) = $0/store, so cost is no longer the gate — PRIORITY is. Fill Africa +
# Middle East (+ JP) first; once that backlog is drained, auto-advance to GLOBAL gaps. Gated to rows
# missing category/description, so re-runs never redo work. (ai-enrich reads products.json → Shopify/
# NULL-platform stores; non-Shopify CMS needs a separate path.)
AFRICA="AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW"
MIDEAST="AE,SA,IL,TR,QA,KW,BH,OM,JO,LB,IQ,YE,PS,SY"
FOCUS="$AFRICA,$MIDEAST,JP"

node --env-file=.env.local scripts/heartbeat.mjs ai-enrich "starting (Africa+ME+JP)" >/dev/null 2>&1 || true
echo "=== ai-enrich $(date '+%F %T') — Africa+ME+JP priority ==="
node --env-file=.env.local scripts/ai-enrich.mjs --all --country "$FOCUS" --limit 6000

# Auto-advance: once the focus backlog is nearly drained, spend remaining capacity on GLOBAL gaps.
REMAIN=$(FOCUS="$FOCUS" node --env-file=.env.local -e "import('postgres').then(({default:p})=>{const s=p(process.env.DATABASE_URL,{prepare:false,max:1});s\`select count(*)::int n from imported_stores where published and coalesce(activity_tier,'') not in ('not_a_store','dormant') and (coalesce(category,'')='' or coalesce(description,'')='') and upper(country)=any(string_to_array(\${process.env.FOCUS},','))\`.then(r=>{console.log(r[0].n);s.end()}).catch(()=>{console.log(999999);s.end()})})" 2>/dev/null)
echo "focus (Africa+ME+JP) remaining missing cat/desc: ${REMAIN:-?}"
if [ "${REMAIN:-999999}" -lt 1000 ]; then
  echo "→ focus drained, filling GLOBAL gaps"
  node --env-file=.env.local scripts/ai-enrich.mjs --all --limit 6000
fi
node --env-file=.env.local scripts/heartbeat.mjs ai-enrich "idle — done" >/dev/null 2>&1 || true
echo "=== done $(date '+%H:%M:%S') ==="

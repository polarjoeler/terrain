# Terrain Ops — Machines, Pipeline & Priorities

> **Living doc. Source of truth for the Rex migration and who-runs-what.**
> Last updated: 2026-10-21. If chat and this file disagree, fix this file.

---

## 1. Machines (anchored by hostname — nicknames drift, hostnames don't)

| Nickname | Hostname | LAN IP | Public IP | Hardware | Role | Status |
|---|---|---|---|---|---|---|
| **Rex** | `Joels-Mac-Studio` | 192.168.101.157 | 196.41.15.149 | Mac Studio (`Mac17,14`), M-series | **Primary always-on pipeline host** | Set up, never-sleep ON, code+deps verified, 24 jobs staged (not yet loaded) |
| **Chad** | `MacBook-Pro-7` | 192.168.101.150 | 196.41.15.149 | MacBook Pro 2024 (`Mac16,1`), M4 | Dev laptop + headed-browser jobs. **This session runs here.** Currently still runs the live pipeline (26 jobs) until cutover | Live now |
| **Lucy** | `peter-johns-macbook-pro-2` | (same home net) | 196.41.15.149 | MacBook Pro 2019, Intel | → move to **non-Shopify (own-domain) + DNS lanes** | Pending Joel's go |
| **VPS** | — | — | **own IP** | cloud | Option A: tail Google CT (argon/xenon) from its own IP; Option B: switch off | **Decision pending** |
| ~~Mac Mini~~ | — | — | — | — | **DOES NOT EXIST** — earlier note was a plan that never happened. Local LLM runs on Rex (or Adam) instead. | n/a |

---

## 2. The resource model — why adding Macs ≠ more throughput

Rex, Chad, and Lucy are all on the **same home network = same public IP (196.41.15.149)**. Only the VPS has its own IP. Store work splits into **three classes**, and the single-IP limit binds only one:

| Work class | Examples | Shared IP budget? | Parallel across machines? |
|---|---|---|---|
| **DNS / discovery** | CT tailer, `.com` firehose, DNS liveness | **Exempt** | Yes, free |
| **Own-domain enrichment** | **WooCommerce**, confirm-other-cms, social, subscriptions, deep-enrich | **No** — hits each store's own server | **Yes, direct, zero contention** |
| **Shopify-edge probing** | payments, checkout, meta.json | Per-IP limited — **but already rotates via the Webshare 100-proxy fleet** (`checkout_probe.py`: `random.choice(_PROXIES)`) | Via the rotator, bounded by fleet size |

**Implications:**
- Extra Macs add **DNS capacity, own-domain throughput, local compute, and uptime** — not raw Shopify-edge capacity.
- A **second network line (true 2nd IP)** is the only thing that directly lifts Shopify-edge throughput beyond the proxy fleet. Not required, but the biggest single lever.
- **Prerequisite for multi-machine fan-out:** the DB work-queue must claim rows atomically, or two machines double-probe. Verify before fanning out (we've been bitten by queue zombies + pool deadlocks).

---

## 3. Role split — what each machine CAN do vs SHOULD do

**Principle:** Rex owns everything Shopify-edge + DNS + anything that must be reliable/always-on (sole owner, one sequence, no contention). Lucy *adds* capacity on own-domain batch lanes (parallel, no budget) but nothing critical depends solely on her uptime. Chad is dev. VPS is the only 2nd IP.

| Machine | CAN do | SHOULD do (assigned) | Must NOT |
|---|---|---|---|
| **Rex** (always-on, home IP, powerful) | anything | **All Shopify-edge in ONE sequence** (payments via Webshare, checkout, catalog/launch dating, meta) · **all DNS discovery** (`ct_tail`+`.com` firehose, ct-land/reconcile, cert-launch, discover-more) · **local LLM** ai-enrich (category-only) · monitoring/digests/health · a reliable **baseline** of own-domain + email crawl | — |
| **Lucy** (2019 Intel, home IP, best-effort uptime) | own-domain enrichment, DNS sweeps, CPU batch. **Not** an LLM box (Intel) | **Own-domain parallel capacity:** Woo checkout queue (~1,383), confirm-other-cms, `store_classifier` on the 1,094 'custom' crux stores + banked Wix, ingest-ranked KE/NG, DNS liveness sweeps, **email-quality contact crawl (#6)** | **No Shopify-edge direct** (shares the budget). Stop launch-enrich (moves to Rex) |
| **Chad** (2024 M4, home IP, dev) | anything | Dev/product (homepage-redesign branch) · **email-quality code fixes (#6)** · headed-browser jobs when open · optional overflow Shopify-edge via rotator when open | No 24/7 pipeline dependence |
| **VPS** (own IP) | CT tailing, light cloud jobs | **Decision pending:** tail Google CT (argon/xenon) from its own IP, or off | — |

---

## 4. Priorities (Joel, 2026-10-21) → how each is served

1. **Test Rex vs previous runs** — capture Adam's **baselines before cutover** (discovery/day, payments probed/run, confirm rate). Calibration: Rex wins on discovery + always-on + compute, **not** payments-probe throughput (IP-bound).
2. **Find every store (Africa + globe)** — DNS-bound = cheap = Rex. Africa already covered (CT tailer, CrUX ranked ingest, crt.sh backfill); `.com` firehose adds the global head; always-on closes overnight gaps.
3. **Improve payments coverage (esp. Africa)** — the real bottleneck (Shopify-edge HTTP). Levers: Africa-first probe queue, cheap plain-HTTP checkout parsing, Webshare rotator across Rex (+Adam/Lucy overflow), and a 2nd IP if we want more.
4. **Local free enrichment** — Ollama + `ai-enrich` on **Rex** (no Mini). Category-only, `WHERE category IS NULL` (~18.5k live focus-market leads missing a category).
5. **`.com` firehose + StoreCensus ingest — NOT at the expense of Africa/ME/Japan.** Guarantee: discovering `.com` is free (DNS); *enriching* it competes for the HTTP budget. So **focus markets get HTTP-budget priority; global `.com` enrichment runs on leftover budget / proxy lane only.** StoreCensus rows ingest `published=false`, enriched for focus markets only.

6. **Email quality & lead-email quality (NEW — Joel: "a huge one").** Entirely own-domain + MX (DNS) → **does NOT compete with payments for the IP budget**, scales across Lucy + Rex. Three parts:
   - **Fix the poisoned `contact_email`** — `logistics-scan.mjs` scrapes any email off a redirect-followed page with no domain match, and the lead drawer prefers it over the import-accurate `email`. Fix drawer + harden the scan (store-domain match, no cross-domain attribution) + null/re-validate existing cross-domain emails. → **Chad (code)** + one-time DB cleanup.
   - **Coverage** — find a real contact email for leads that have none: crawl the store's own contact/about pages + `mailto:` + MX. → **Lucy** (direct crawl) + Rex baseline, **Africa-first**.
   - **Quality classification** — `contact-enrich.mjs` contact_type: named-person vs role vs generic queue + WhatsApp ("Reaches a person" filter). Must run **DIRECT, not Webshare** (measured 5/10→0/10 429s). → runs with the crawl; name-detection can use Rex's local LLM.
   - *Product tie-in:* Peach Payments said bad emails are the #1 thing Terrain could help them with (ZA top-1000 baseline: 17.4% reach a person, 73.6% generic queue, 139 WhatsApp).

**The hard rule for #5:** if going global means doing Africa/ME/Japan poorly, we don't go global. Focus-market quality is the gate.

---

## 5. Rex migration — status & gate

**Done & verified on Rex:** never-sleep ON; `shopify-radar` mirrored (venv 3.11, deps, `CT_COM` toggle wired, scripts compile); `storepulse` mirrored to `homepage-redesign @ 6877a26` (node_modules built, DB reachable 2.74M rows, scripts syntax-clean); SSH bridge from Adam (`ssh rex`); 24 plists staged + valid, `ct-tail` has `CT_COM=1`.

**✅ CUTOVER DONE (2026-10-21).** 24 jobs booted out on Chad → bootstrapped on Rex; verified (Rex heartbeats fresh under `joels-mac-studio`, `.com` firehose live `CT_COM=1`). Reversible (plists remain on Chad).

**Executed machine state (2026-10-21):**
- **Rex** — 24 pipeline jobs live, always-on, `.com` firehose on.
- **Chad** — `ollama` (qwen2.5:7b + 3b) + `ai-enrich` (local `qwen2.5:7b`, **$0 verified**, daily JP sweep @ 06:30) + **`contact-enrich` = email-quality lane (#6)** (named/role/generic + WhatsApp + MX pass, fires 01:15, ~1,200/night, queue ~40,721) + `browser-probe`. ai-enrich & contact-enrich both direct-fetch store pages (shared IP budget) but are staggered 01:15/06:30 so they don't overlap; contact run warns if >10% 429. **✅ contact-quality-lane code pushed 2026-10-21 → `origin/ops/contact-quality-lane` (commit 0ff7d5b, 7 files). Safe on remote; Rex can pull it when we move the lane there.**
- **Lucy** — dead `launch-enrich` removed (was skipping every run + date-bug crashing); `woo-worker` repointed from its drained queue to the **80,270 `woo-candidates.txt`** backlog (BATCH 500 / CONC 20, ~24k/day → ~3 days). Lucy = Python/radar only (no node, no storepulse).
- **VPS** (161.35.98.224, Ubuntu 1vCPU/1GB NYC) — **CORRECTION: not dead.** Runs `shopify-radar-za.service` every 2h = GLOBAL CT discovery → per-TLD Google Sheet tabs (`SHEET_ID 1U7Iz…`), ~82 Shopify/run (~980/day) across 27 TLDs. **But the Sheet→DB bridge is broken:** `sync-sheet.mjs` reads a stale `ENRICHED_TAB` (last populated Sep 10) and only runs inside the unscheduled `radar-pipeline.sh` (last sync Oct 16). Global ccTLD finds are stuck in Sheets. Rex's `.com` firehose now covers global .com/.net/.org direct-to-DB, so VPS's unique value = the ccTLD tail. **Fix options below — needs Joel's steer (priority #5 = lowest).**

**Still to do:** re-snapshot Rex-vs-Chad (~24h) · **commit the 37 dirty `homepage-redesign` files** (disk-loss risk — contact-quality-lane already pushed ✓) · lever-1 publish pass (44,614 ZA/KE/NG unpublished → dashboard) · **move email-quality (contact-enrich) lane to Rex** (needs the code pushed first + LLM-on-Rex decision) · modernize VPS → direct-to-DB (parked) · round-2 throughput bumps (woo-checkout limit, cms-probe cadence) · verify `ai-enrich` doesn't live-fetch products.json (shared IP budget) · install node+storepulse on Lucy for her node lanes.

**Migrate set (24):** caffeinate, cert-launch, cms-probe, confirm-cms, contact-enrich, country-enrich, ct-land, ct-tail, deep-enrich, discover-more, health-check, liveness, liveness-tail, morning-digest, payment-watch, payments-probe, recall-report, retag, send-digests, social-enrich, subscriptions, sync-experts, woo-checkout, woo-date.
**Exclude (stay off Rex):** ai-enrich (→ set up fresh on Rex), ollama (→ Rex), radar-pipeline/fingerprint/monitor, browser-probe, warm-browse.

---

## 5b. Non-Shopify discovery — the real state (baseline 2026-10-21)

**We are NOT short on finding non-Shopify stores — we're finding them faster than we confirm them.**

- **Discovery sources that exist (beyond CrUX+imports):** `ct_tail.py` (CT firehose routes every non-Shopify domain onward), `seed_censys.py`, `seed_commoncrawl.py` (Common Crawl), `radar/discovery/whoisds_source.py` (new-domain registrations), zone/massdns seeding.
- **Classification (`bulk_classify.py`) — DNS/CNAME/IP, no rate budget:** Wix (`wixdns.net`, `185.230.60.0/22`), Squarespace, BigCommerce, BASE, Ecwid, ShopStar; `woo_probe.py` for self-hosted Woo.
- **The bottleneck = feed backlogs draining too slowly:** `woo-candidates.txt` **80,270**, `woo-2019-resolves.txt` 16,962, `not-a-store-recheck.txt` 13,520, `ct-nonshopify.txt` 2,191.
- **Why it trickles:** `woo-checkout` = `--limit 500` every 2h (6k/day capacity) but only **253/day actual** (sleep-prone host misses runs); `cms-probe` runs **every 48h**.
- **Fix (all own-domain/DNS — zero payments cost):** (1) Rex always-on → woo-checkout ~6k/day; (2) raise woo limits 500→2000 / conc 10→30; (3) cms-probe 48h → every few hours; (4) fan woo_probe + bulk_classify onto Lucy. Clears the 80k backlog in ~2 weeks.
- **Global ordering (honors #5):** drain focus-market non-Shopify backlog first, THEN widen seeds to global + `.com` firehose.

## 5c. Baseline (Chad-era, 2026-10-21) — full JSON in `ops/baseline-chad-2026-10-21.json`

Rows 2.745M / published 1.678M. Per-day (7d avg): discovery ~202k, catalog 292k, **liveness 119k (capacity fine — but core-market recheck only 30/12/11%, a targeting problem)**, **payments 68k (focus backlog just 138 — keeping up)**, deep-enrich 2.5k, **contact/email 636 + MX 1.8k (badly under-served)**, woo 253. Machines live: Chad (`macbook-pro-7`) core but subscriptions/deep-enrich/cms-probe stale 32–34h; Lucy (`peter-johns-macbook-pro-2`) alive on woo "13 queued"; VPS `sheet-discovery` **0 new, 5.5d stale**; ghost `mac` 17d stale (identity TBD).

## 5d. Imported stores → dashboard (2026-10-21) — CORRECTED model

**The dashboard gate is BOTH conditions** (`lib/browse.ts:124-125`): `published=true` **AND** `country = ANY({ZA,KE,NG})` (`VISIBLE_MARKETS`, `lib/markets.ts:7`). `published=true` alone does NOT surface a store — the country filter is the hard UI gate. All data is safe in the Supabase `imported_stores` table regardless (system of record).

```
total 2,745,432 · published 1,677,989 · UNpublished 1,067,443
  published ZA/KE/NG:    74,063   ← what the dashboard shows today
  published JP:          46,949   (enriched; /jp, not main picker — JP ∉ VISIBLE_MARKETS)
  published OTHER/global: 1,431,405  ← published=true but country-filtered out of UI
  UNpublished ZA/KE/NG:  44,614
  UNpublished JP:        40,449
  global published + live-verified: 1,264,564
```
**Three distinct levers to surface imports (NOT one confirm/publish backlog):**
1. **ZA/KE/NG unpublished (44,614)** — already in a visible market → just need `published=true` (confirm→publish pass via Rex/Lucy + reconcile-probed). The only group where "drain backlog → surface" is correct.
2. **JP (~87k)** — publishing alone does nothing; needs **JP added to `VISIBLE_MARKETS`** (product decision) + enrichment.
3. **Global (1.26M live-verified, already published)** — one `VISIBLE_MARKETS` config change from showing; NOT an enrich/publish backlog. Deliberate, market-by-market activation only (per #5 — don't bury focus markets / surface thin data).

So "bring imports into the dashboard" = mostly a **market-activation decision**, not data processing. `published=true` is set widely (incl. ~1.43M global — the old import-landed-published issue, see [[bulk-import-published-flag]]); isolation is by country filter, not publish-state.

## 5e. First overnight on Rex (2026-10-21 20:36 → 10-22 05:05, 8.5h) — clean

Zero job failures; no overnight stalls. +7,038 rows, +6,733 published. Highlights:
- **Two lanes from ZERO → flowing:** `ai_enriched_at` 0→10,706 (Chad local qwen, $0), `contact_mx_checked_at` 0→4,736 (email #6).
- **Liveness** 89k→121k/day (always-on effect).
- **Lucy Woo backlog** 80,270→54,270 (~26k confirmed in 8h vs old 253/day).
- **Email quality (#6):** 1,200 stores — named 156 (13% reach a person), role_generic 56%, 266 "will bounce" (no MX); qwen7b $0, only 16 (1.3%) rate-limited → no 429 clash with ai-enrich (stagger works).
- **Payments flat** (~4k/day, IP-bound, as expected).
- **WATCH:** `discovered_at` 24h count dipped 11.3k→4.9k — discovery heartbeat is live, so likely bulk-import burst timing, not a ct_tail regression. Confirm over a full day. Snapshots: `ops/baseline-chad-2026-10-21.json`, `ops/rex-2026-10-22.json`.

## 5f. Round-2 tuning + payments/rotator reality (2026-10-22)

**Payments is NOT home-IP-bound** (correcting earlier shorthand): `payments-probe.sh:63` sets `STORE_PROBE_PROXY_FILE=…/proxies.txt` and `checkout_probe.py` picks a random proxy per store → every probe egresses via one of **102 Webshare proxies**, not the home IP. Capacity ≈ 2,500/run × 16 runs/day (90-min cadence) = **~40k/day**, but actual ~4k/day → it has **~10× headroom**; "flat" = the eligible focus queue is nearly caught up (health-check ~233 in-queue), NOT throttling. **The lever to probe more is the queue feeder (`payment-queue.mjs`) / a #5 global decision, not proxies or a 2nd line.** Home IP only limits the small DIRECT lanes (contact-enrich — measured worse via proxy; ai-enrich product fetches).

Published-but-unprobed backlog: **40,487 focus (ZA/KE/NG, incl. non-Shopify not eligible for checkout probe) · 966,343 total.**

**Round-2 tuning applied on Rex** (own-domain/DNS, no payments-budget impact):
- `cms-probe`: StartInterval 172800→**21600** (48h → 6h).
- `woo-checkout`: `--limit 500 --concurrency 10` → **`2000 / 20`** (keeps pace with Lucy's ~78k/day Woo confirms).
TODO fold these into the repo (Rex-local edits today; plist interval is machine-local anyway).

**Rotator scope (when to use the 102-proxy fleet):** only Shopify-edge requests benefit (per-IP rate limit). Payments already rotated (~10× spare). **Own-domain lanes (contact-enrich, Woo confirm, homepage crawls, confirm-cms) must stay DIRECT** — datacenter proxies get bot-blocked harder there (measured: contact-enrich worse via Webshare); scaling those needs *residential* rotating proxies, not this fleet. DNS exempt. **TODO (for a global ai-enrich dump only):** route `ai-enrich.mjs`'s `products.json` fetch (line 102, Shopify-edge, currently direct) through `STORE_PROBE_PROXY_FILE` so it leaves the home IP and stops competing with contact-enrich. Not urgent (~10k/day, 1.3% rate-limited).

## 5g. Lever-1 reality (2026-10-22) — surfacing imports is SMALL; the real lever is classification

The `activity_tier` taxonomy already exists (`selling`/`active`/`dormant`/`not_a_store`) — **no `store_state` field needed**; not-selling Woo are already kept + labeled (`not_a_store`/`dormant`). Measured on ZA/KE/NG unpublished (44,749):
- `promote-confirmed --dry` (the safe publisher: live native-ecom + Woo selling/active) → **only 72 publishable now** (opencart 25, prestashop 15, shopstar 12, shopware 10, ecwid 5, woo 2, magento/ec-cube/bigcommerce 1 each).
- `reclassify-not-a-store` dry (800 ZA): **17 recovered (~2.6%)** → `not_a_store` tag is ~97% accurate; low ROI, and recoveries are already-published (Insights accuracy, not lead count).
- **39,491 are UNCLASSIFIED** (null activity_tier) — this is where publishable sellers hide. Neither publisher touches them.

**Conclusion:** the dashboard-growth lever is NOT publishing banked stores (~72) — it's a **classification sweep over the 39.5k unclassified** (catalog + activity-tier, own-domain/DNS, Rex/Lucy), which then feeds `promote-confirmed`. `promote-confirmed` publishes Shopify? No — Shopify is reconcile-probed's job (publishes 0 now); Wix/Squarespace/Webflow/Odoo need the store-vs-brochure crawl (not promoted here).

**EXECUTED 2026-10-22:**
- ✅ `promote-confirmed --markets ZA,KE,NG` → **published 73** confirmed-live sellers (opencart/prestashop/shopstar/shopware/ecwid/woo/magento/…).
- Classification sweep lanes (own-domain, no payments cost): `wix-probe`+`magento-probe` now 6h (was 48h) via `cms-probe`; `woo_probe` on Lucy draining 80k; **`probe-cms --markets ZA --limit 1500` kicked** (classifies platform-stamped non-Shopify, publishes catalog-confirmed sellers — yield pending).
- `probe-cms.mjs` classify+publish logic: catalog found → `published=true, activity_tier='selling'`; else `not_a_store`. Targets platform-stamped non-Shopify (not null-platform — those need bulk_classify).
- Remaining unclassified gaps: ~20k WordPress + ~14k platform-NULL need woo_probe / bulk_classify routing (partially via Lucy + discover-more).
- **probe-cms results: ZA 580/967 promoted (Wix 387, Squarespace 153, Odoo 30…), KE/NG 51/89. Session total ~704 new ZA/KE/NG sellers published** (incl. the 73 from promote-confirmed). Payment rails read in-pass (PayPal/Stripe/Yoco/M-Pesa/Peach…). Focus-market platform-stamped non-Shopify banked backlog now ~cleared.
- **RECOMMEND: schedule `probe-cms` (currently manual)** — it's the highest-yield classifier (60% real-store hit rate, own-domain, quality-gated). Add `node … probe-cms.mjs --markets ZA,KE,NG --limit 1500` to `cms-probe.sh` (already runs wix/magento every 6h) so new banked stores keep getting classified+published automatically. TODO.

## 5h. VPS modernized (2026-10-22) — lands direct to DB

`land_to_supabase.py` on the VPS reads `radar.db.stores` (106,605 confirmed Shopify) and upserts NEW ones into `imported_stores` (`published=false`, `platform='Shopify'`, `source='vps_ct'`, ON CONFLICT(domain) DO NOTHING). **First run landed 58,075 new global Shopify** (1,028 focus). Wired as `ExecStartPost` on `shopify-radar-za.service` → auto-lands new finds every 2h via a `.last_landed` watermark. Sheets bridge bypassed. asyncpg needs `statement_cache_size=0` (Supabase pgbouncer). 4.3GB radar.db; `seen_domains`=25.6M, `stores`=106k.

## 5i. HIERARCHY OF IMPORTANCE — how to read every pipeline number

**Two kinds of work (never conflate them in a metric):**
- **ACQUISITION** (one-time per store, grows *coverage*): discover domain → confirm real store+platform → first-enrich (launch date, category, launch-day provider).
- **MONITORING** (recurring per store, keeps *signal* fresh): re-check liveness (migrated/dead=churn), re-probe payments (provider switch, gateway add/drop). **This feeds the paid weekly digest.**

A raw count like `payments_checked_at=68k/day` is meaningless until split into **first-probe (acquisition) vs re-probe (monitoring)**, and **by region**. TODO: make `pipeline-stats.mjs` report new-vs-recheck × region.

**Hierarchy by RESOURCE + PERISHABILITY (not a flat order — 2026-10-22, Joel):** launch capture and focus freshness use *different pipes* (CT/DNS vs HTTP/proxy), so they mostly don't compete — you can push global capture AND keep focus freshness. A missed launch is irreversible (lose launch date + launch-day provider forever); focus freshness is recoverable (a later re-check catches up). So:
- **Tier A — Launch capture, focus AND global** (perishable + cheap; CT-tailing + DNS; VPS own-IP + Rex DNS-gated): catch every new store worldwide at launch. Scaling = **more CT keep-up capacity** (Google logs rate-limit per-IP; VPS was step 1; more IPs/boxes → closer to "all global"). Barely touches the focus HTTP budget.
- **Tier B — Focus-market value** (paid product; scarce HTTP/proxy budget): focus completeness (confirm/first-enrich) + freshness (re-probe payments/liveness). Revenue engine today. *StoreLeads full ingest = Tier B completeness catch-up.*
- **Tier C — Deferred/background**: global *enrichment* (products.json/catalog — the ONLY thing that truly competes with Tier B) + global re-monitoring. Capture now (`published=false`), enrich selectively later.

**Resolution of "give up freshness to find all global?":** mostly NO — *capturing* all global is cheap + independent (Tier A, do it); only *enriching* all global trades against focus freshness (Tier C, deferred). The lever for "all global launches" = CT-tailing capacity, not cutting focus monitoring. See [[activity-hierarchy]], [[dashboard-visibility-gate]], [[pipeline-discovery-vs-ingestion]].

## 5j. Payments coverage + Rex push (2026-10-22 baselines)

**Coverage metric rule (Joel): exclude `not_a_store` + `dormant` from the denominator** — they'll never have payments (not selling), so counting them understates coverage. Reporting must use the real-store denominator.

Payments coverage baseline (real stores = published, excl not_a_store/dormant):
- **ZA: 52.1%** (49,456 real; 41.6% if you wrongly count all published incl non-stores).
- **Africa(27): 59.5%** (81,711 real; 48.4% all-published).
- Gap ≈ 24k real ZA stores without payments — target of the push below.

**Rex push + focus-first applied 2026-10-22:**
- `app_settings ops.priority = {country: ZA}` → ZA leads the payment queue (~75%).
- `payments-probe.sh`: checkout_probe `--limit 2500→5000`, payment-queue `--limit 8000→15000` (proxied, ~80k/day capacity).
- `probe-cms --markets ZA,KE,NG --limit 2000` added to the 6h `cms-probe` job (classification → coverage, auto).
- Payments MARKETS is already Africa(27)+JP scoped (NOT true-global) — earlier "2/3 global" was a mislabel (other-Africa+JP are target markets).

**STILL A GAP — focus liveness freshness:** `dns-liveness` only does `live_checked_at IS NULL` (FIRST checks) on global imports by source — it never RE-freshes focus stores (no churn/migration detection on ZA/KE/NG). Needs a dedicated focus-recheck pass (source-liveness has `--country` + MAX_AGE stale logic to build on). TODO.

## 5k. "Test Rex's power" + load-up (2026-10-22)

**Finding: Rex is NOT the bottleneck.** Under boosted deep-enrich (conc 30) + ollama pull + ct-tail `.com` + 24 jobs, Rex sat at **load 1.85/18 cores (~10%), 93% mem free**. The Studio has huge headroom. The real ceilings are: **network I/O** (own-domain fetch latency caps deep-enrich, not CPU), the **home IP** (Shopify-edge), and the **Supabase DB pool** (concurrent writes — watch this as concurrency climbs; see [[postgres-pool-deadlock]]).

Loaded onto Rex today:
- **deep-enrich boosted**: non-Shopify own-domain (free), focus-scoped (Africa27+JP), `--limit 3000→30000`, `--concurrency 8→60`, cadence daily→**3h**. Backlog ~1.66M; was ~3k/day (≈1.5yr) → now much faster. Kickstarted.
- **ollama installed on Rex** (`com.tembo.ollama` KeepAlive service) + pulling `qwen2.5:7b` (free/local) → Rex becomes a 2nd LLM box (descriptions, contact name-eval) at $0.
- Payments pushed + ZA-lead (§5j).

**Lucy** cleared the entire 80k Woo backlog (→0) and went idle → being converted to a **full node worker** (storepulse mirrored, Node 24, npm installing) for the **focus-liveness freshness pass** (the Tier-B gap) + own-domain enrichment. Lucy = Intel, own-domain/DNS/node only (no ollama).

**Backlogs (own-domain, the real work):** deep-enrich ~1.66M, contact-enrich ~1.66M. These are Rex/Lucy own-domain lanes — bounded by I/O + DB pool, not CPU.

TODO: finish Lucy focus-liveness build (after npm) · wire Rex local-LLM description lane (after qwen pull) · parallelize contact-enrich (email quality) across Chad+Rex · watch DB pool as concurrency climbs.

## 5l. Endstate profile scorecard + rotator wiring (2026-10-22)

**Endstate goal (Joel):** complete data on primary markets (then global) — payments + shipping + CMS, MONITORED for change (migrations/churn/switches); full profile (theme/apps/hosting/payments/shipping) + solid contact (email + WhatsApp).

**ZA real-store (49,463) completeness scorecard:** hosting 77% · theme 64% · apps 63% · payments 52% · shipping 34% · email 34% · **WhatsApp 1%**. → worst gaps are WhatsApp, shipping, email (NOT payments).

**Field → lane map:**
- payments + shipping → `checkout_probe` (proxied ✓; one probe fills both; pushed ZA-lead). Shipping rises with payments.
- theme/apps → `deep-enrich` (boosted Rex, conc60, focus-first).
- hosting → `hosting-enrich` (DNS/ASN, exempt) — **UNSCHEDULED**; schedule on Rex.
- description/category/socials → `ai-enrich` (local qwen, **now rotator-wired for products.json** — verified status 200 via proxy; Chad, Rex ollama ready).
- email + WhatsApp → `contact-enrich` (Chad only; the worst gap) — parallelize onto Rex.
- **monitoring (migrations/churn/switches)** → the focus re-check pass (Lucy build) must re-run liveness **+ platform + payments** on focus stores on a cadence. This is the Tier-B product engine.

**Rotator wiring (closing §5f gaps):** `ai-enrich.mjs` products.json now routes via `scripts/lib/proxy-fetch.mjs` + `STORE_PROBE_PROXY_FILE` (set in ai-enrich-cron.sh) — verified. **catalog-enrich is the next same-fix gap.** Own-domain lanes stay direct (rotator bot-blocks there).

## 5m. Systemic completion — the profile-completeness coordinator (direction, 2026-10-22)

**Joel's steer: systemic per-store completion, not piecemeal per-field projects.** Today we track per-FIELD coverage (payments 52%, email 34%…) → patchwork. The architecture to build:
- **Per-store completeness score**: a store is "complete" when it has payments+shipping+theme+apps+hosting+contact(email/WhatsApp)+description. Metric = **% of stores fully profiled**, per market, driven to 100%.
- **Coordinator** (new): walks incomplete stores focus-first, routes each through ONLY the sub-lanes it's missing until complete. Sub-lanes (checkout_probe, deep-enrich, contact-enrich, hosting-enrich) are mechanisms; coordinator + score = systemic. **Rex runs it** (always-on, 90% idle headroom).
- **Monitoring layer**: re-check complete stores on a cadence (liveness+platform+payments) to keep fresh → churn/migration/switch signals. The Tier-B engine (Lucy).

**Non-Shopify payments/shipping:** checkout_probe drives the Shopify (+Woo) checkout flow — can't generalize to Wix/Magento/custom. Those come from **deep-enrich page fingerprints** (`deep-enrich.mjs:67` — PayFast/Yoco/Paystack/Peach/…). So complete African payments = checkout_probe (Shopify/Woo exact) + deep-enrich fingerprints (rest). Strengthening African-provider fingerprints closes the non-Shopify half.

**BUILT 2026-10-22: `scripts/completeness.mjs`** (deployed to Rex) — the systemic coordinator.
- Per-store "complete" = payments · shipping · theme · apps · hosting · contact(email) · description.
- **Platform-aware hosting** (Joel): hosted CMSs (Shopify/Wix/Squarespace/BigCommerce/BASE/…) are hosted BY the platform → no independent host → hosting auto-satisfied; it's only a real field for self-hosted (Woo/Magento/PrestaShop/custom).
- Default = scorecard (% fully profiled per market); `--run --country X` orchestrates the own-domain lanes (deep-enrich→theme/apps/desc, hosting-enrich→hosting, contact-enrich→contact) for that market, then re-scores. Payments/shipping stay on the dedicated checkout_probe job.
- **RESOLVED model (Joel): a field counts as done when FILLED or CHECKED-EMPTY** (via `*_checked_at`), so 100% is reachable — drive "unchecked→checked," not "empty→filled." Two numbers: filled% (richness) vs COMPLETE% (resolved). Fields map to checks: payments/shipping→`payments_checked_at`, theme/apps→`deep_enriched_at`, hosting→`hosting_checked_at`(or hosted-CMS), contact→`contact_checked_at`, description→`ai_enriched_at`.
- **Baseline COMPLETE% (resolved):** ZA **20%** (9,675/49,476) · KE 10% · NG 13%. Biggest UNCHECKED gaps: contact (ZA 36% resolved) ≫ shipping (62%) > description (68%) > payments (78%). Contact is the top lever (Rex contact-enrich running).
- Metric flips us from per-field patchwork → per-store completion driven to 100%, market by market.
**Completion SEQUENCE (Joel 2026-10-22): finish ZA to ~100% COMPLETE first, THEN advance through the rest of Africa** (next KE, NG, then remaining Africa by store count), then JP/global later. The scheduled coordinator should work ZA until resolved, then auto-advance to the next incomplete African market (don't spread thin across all at once). `ops.priority=ZA` already leads the payment queue; extend the same ZA-first ordering to deep-enrich/contact/hosting via the coordinator.

**✅ SCHEDULED 2026-10-22: `com.tembo.completeness` on Rex** (`completeness-cron.sh` → `completeness.mjs --auto --limit 4000`, every 4h, RunAtLoad). `--auto` = ZA-first auto-advance: works the first focus market below 97% COMPLETE (ZA→KE→NG→rest of Africa by store count→JP), running its own-domain lanes. **The coordinator now OWNS deep-enrich/hosting-enrich/contact-enrich for focus markets — standalone `com.tembo.deep-enrich` was booted out on Rex to avoid double-running** (global/non-focus deep-enrich pauses = Tier-C deferral, intended). COMPLETE% is surfaced in the morning digest §5.
TODO: commit completeness.mjs + today's Rex-local edits (ai-enrich rotator, tuning) — currently Chad+Rex only, disk-loss exposed.

## 6. Open decisions (need Joel)

- [ ] **Cutover go/no-go** — flip the 24 jobs Adam→Rex?
- [ ] **Lucy** — approve moving her to non-Shopify + DNS lanes? (don't act without go)
- [ ] **VPS** — revive for CT tailing (own IP) or switch off? (don't act without go)
- [ ] **Second network line** — worth it for payments throughput?

---

## 7. Evidence / gotchas (from the other session, worth confirming)

- `worker/launch-worker.sh` writes its heartbeat (line ~19) **before** the same-IP guard (line ~37, `STUDIO_IP=196.41.15.149`). On the shared IP it likely exits every run while the `launch` heartbeat still looks fresh → false "healthy." Confirm by tailing Lucy's launch log for "Skipping this run" (unless `LAUNCH_ALLOW_SAME_IP=1`).
- `woo-worker.sh` has the same guard, gated by `WOO_ALLOW_SAME_IP`; heartbeating "processing N queued" so it's allowed. Woo = own-server, fine.
- `STUDIO_IP` in Lucy's env points at Chad's old IP — the whole hotspot-guard design is moot on a shared network.
- **Liveness recheck gap:** only ~30% ZA / 12% KE / 11% NG live stores re-checked in last 30 days, vs ~98% for global imports. Core markets are under-swept.

---

## 8. Next (after cutover), per Joel

- **Per-machine performance/output tracker** (Rex / Lucy / Adam) — per-host heartbeat (hostname + load/disk/uptime) so monitoring knows *which box* and *is it online*, not just whether a job ran.
- **Full job inventory + reprioritization** — every job: what it does, cadence, cost, market, still-earning-its-slot? Feeds both the tracker and the priority queue.

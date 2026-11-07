# Terrain — Launch Readiness Review (2026-10-25)

Evidence-based audit of Terrain's position ahead of outreach to ~100 SA + ~50–60 African prospects (PSPs, Shopify/Woo agencies, logistics, app developers). Companion to `OPS.md` (operations log). Tags: **[FACT]** measured this review · **[HYP]** supported inference · **[UNK]** not yet measurable.

Headline conclusions are in the chat summary; this document carries the supporting detail, section by section in the order of the brief.

---

## 0. What was inspected, and what remains unknown

**Inspected (read-only):** the full session history and memory; `OPS.md` and the roadmap plan file; `lib/{browse,leads,imported,insights,fleet,ops,db}.ts`; discovery (`ct_tail.py`, `seed_commoncrawl.py`, `bulk_classify.py`, landers), enrichment (`ai-enrich`, `completeness`, `contact-enrich`, `text-mine`), probes (`checkout_probe.py`), liveness; launchd plists on Rex/Lucy/Chad; job logs and `agent_heartbeat`; live DB measurements (funnel by CMS, freshness buckets, duplicate pairs, `payment_changes` reliability, a 13-store trace); the `/fleet` monitor and the fleet artifact; StoreLeads' public terms.

**Explicitly missing context [UNK]:**
- Any customer interview, pilot, usage or willingness-to-pay evidence. None appears anywhere I can see.
- Whether any paying customer exists today (pricing tiers were locked in Aug 2026; a 226-row partner list exists; no conversion evidence).
- Webshare proxy cost and Vercel plan/cost; Supabase's own disk-IO dashboard numbers (I inferred throttling from query latency and the warning you received).
- Accuracy of `launched_at`/`first_product_at` (the "new store" signal) and of country attribution for generic-TLD stores.
- The `dormant` vs `not_a_store` split inside the Woo bucket.
- The full, current StoreLeads terms (the public page is truncated and undated).
- True market population (unknowable; must be triangulated — §2).

---

## 1. What is actually working — the pipeline, stage by stage

### 1.1 Stage map and evidence

| Stage | What it does | Throughput / backlog | Principal bottleneck | Where records go wrong |
|---|---|---|---|---|
| **Discovery** | CT-log tail (`ct_tail`, `.com` firehose ON), Common Crawl (monthly, Africa-first), VPS CT (own IP), CrUX ranked, Woo CMS/DNS, bought StoreCensus | **[FACT]** ct_tail finds ~18k/day globally; ~87% already held → net-new 2.4k–8.9k/day. African CT net-new ≈ **105/day**. Common Crawl co.za full sweep: ~310 net-new, almost all **non-Shopify** | CT is **saturating** (overlap 59–87%); Africa's remaining Shopify is largely found. Non-Shopify breadth is the real frontier | **www/bare duplicates** (CT surfaces `www.`, imports surface bare) → 3,838 pairs in published focus **[FACT]**; generic-TLD country guesses (`everstrongapparel.com`=KE, `need4bead.com`=LB) **[HYP: some wrong]** |
| **Landing / verify** | DNS + Shopify-edge confirm; `land-ct-discoveries` upserts `published=true` | Landing keeps up (0.1% behind the finds file) **[FACT]** | None | Lands `www.` twins as separate rows; `discovered_at` null for some imports |
| **Liveness** | DNS resolve → `live_status` | 2.2M checked; full-table slowed to 24h (disk-IO); focus-liveness on Lucy (6h) | **Lucy is a laptop that sleeps** (25h offline this week) → focus freshness stalls **[FACT]** | **`active` means "DNS resolves", not "sells"** — dead template store `everstrongapparel.com` (products.json = `[]`) is `active` **[FACT]**. Liveness ≠ selling ≠ churn |
| **Classification** | platform/CMS detection; `activity_tier` (store/dormant/not_a_store) for Woo | Woo bucket: **19,496 of 32,004 (61%) non-store** **[FACT]** | 2019 BuiltWith Woo import never verified as *stores* | KE/NG published are **~42% non-store** (ZA 24%) **[FACT]**. **Keep them** (Joel): a non-store WooCommerce *site* is still a lead for agencies/plugin devs. The defect is *blending* them into Woo totals — every Woo count, report and research view must split **Woo stores** vs **Woo sites (not a store)** |
| **Enrichment** | ai-enrich (category+desc, local 3B), deep-enrich (theme/apps), hosting (DNS), contact (crawl), text-mine (biz-model) | ai-enrich drained focus; now on 1.5M global. Contact: Shopify lane 1,200/day paced; non-Shopify 6,000/day | Shopify-edge **shared home-IP budget** — the one truly constrained resource **[FACT]** | `Unknown` category persists post-enrich (thin input); contact crawl covers **31%** of published focus **[FACT]**; www twins enrichment-poor |
| **Payments verify** | Shopify checkout probe (`payments_checked_at`) **and a separate Woo checkout probe** (`woo_checkout_at`, `payments_source='woo_checkout'`) + sync → `payments`, `payment_changes` | Shopify: **85% probed, 84% fresh <90d**. **Woo: 99% probed (31,609/32,004), all fresh** — a named gateway in ~33% **[FACT, corrected]** | Footprint-free HTTP; Shopify `no_variant` false-negatives (`frut.co.za`); **Woo gateway-name recovery capped at ~33%** (manual EFT/COD/unnamed plugins) | Woo payments are **our own `woo_checkout` probe, not imports** [corrected]; the ~21k Woo with no named gateway is an observability limit, not a gap |
| **Change detection** | `payment_changes` log (add/remove/primary) | 2,285 changes / 2,158 domains; 2,118 in last 30d **[FACT]** | Only the probed subset moves; **ordering/prominence never recorded** (`reordered`=0) **[FACT]** | **0 flicker** (A→B→A) and **0 empty-transitions** — the "no verdict on failure" design works **[FACT]**; cannot separate "merchant changed" from "detector changed" (no detector version) **[UNK]** |
| **Publication** | `published` + `country ∈ {ZA,KE,NG}` gate; leads exclude `not_a_store` by default; insights exclude it too | 75,488 published focus rows | — | **`dormant` not excluded from leads** **[FACT]**; the 1.43M published *global* rows are hidden by the country gate |

### 1.2 Representative trace (13 stores) — what it shows

Full rows in the review output; the patterns that matter:
- **Successful, trustworthy record:** `edgars.co.za` — csv-sourced, platform Shopify, payments probe-verified 10-23, liveness 10-25, 2 real changes logged (+Capitec Pay/SOHVA 09-25, −Capitec Pay 10-21). Also exists as `www.edgars.co.za` (ct_tail) — **a duplicate**.
- **Dead store marked active:** `everstrongapparel.com` — empty template, `live=active`, `pay=[PayPal;Paystack Onsite]` from a 10-14 probe. A PSP would be told this is an active Paystack merchant. **It isn't.**
- **Probe false-negative, DB correct by luck:** `frut.co.za` — forced reprobe 10-23 returned `no_variant`; DB still holds `[Paystack;PayFast;Paystack Onsite]` from 10-21 because the sync records no verdict on failure. Right outcome, fragile mechanism.
- **Enriched-but-useless:** `blackblock.store` — `cat=Unknown` after ai-enrich; `contact=form_only`.
- **Spending probes on the dead:** `psasigns.co.za` — `live=dead`, yet hosting/payments/contact all re-probed 10-23/24.
- **Split identity:** `toykingdom.co.za` (contact=role_generic) vs `www.toykingdom.co.za` (no contact) — enrichment landed on one twin.
- **Missing by normalisation:** `salvana.co.za` enriched per the ai-enrich log but **not in the DB by that domain** (likely stored as `www.`).

**Verdict on §1:** a successful *job* frequently does not produce a useful *record*. The pipeline is mechanically sound (landing keeps up, change log is artifact-free) but the **semantics are loose** in three places customers will notice: identity (duplicates), liveness ("active" ≠ selling), and Woo (store/site totals blended, and only ~33% of Woo exposes a named gateway — Woo itself is 99% probe-verified). Most recent fixes (3B switch, lane dedupe, liveness cadence, Common Crawl) addressed **real root causes**; the contact-lane episode was fixed twice because the first diagnosis was wrong — a reminder to verify which lane an agent *actually* runs before assuming.

---

## 2. Discovery and coverage

### 2.1 The funnel, focus markets, by CMS (published = customer-visible) [FACT]

| Stage | Shopify | Woo | Wix | Other CMS |
|---|---:|---:|---:|---:|
| Published | 40,538 | 32,004 | 1,712 | ~1,060 |
| …live (DNS) | 31,153 (77%) | 31,800 | 1,711 | ~1,030 |
| …not non-store | 40,538 | **12,508 (39%)** | 1,444 | ~1,060 |
| …category (non-Unknown) | 29,101 (72%) | 28,932 | 1,564 | ~860 |
| …payments **checkout-probed** by us\* | 34,412 (85%) | **31,609 (99%)** | 1,712 | — |
| …probe fresh <90d | 33,943 (84%) | **31,609 (100% of probed)** | 1,712 | — |
| …**named gateway recovered** | ~34,412 | **10,471 (33% of probed)** | 1,605 | — |

\* Verification is tracked in **platform-specific** columns: Shopify → `payments_checked_at`, **Woo → `woo_checkout_at`** (its own checkout probe; `payments_source='woo_checkout'`). The review's first draft wrongly counted `payments_checked_at` for Woo (→ "9"), which is ~0 for Woo by design. Woo is **99% probe-verified and fresh**; the real limit is that only **~33% of Woo checkouts expose a named gateway** (the rest are manual EFT/COD/unnamed plugins) — an observability ceiling, not a backlog.
| …contact crawled | 21,600 (53%) | 1,063 (3%) | 347 | ~200 |
| …reaches a person | 2,513 (6.2%) | 167 | 77 | ~26 |

**Per country (published → live → real store):** ZA 65,010 → 55,782 → ~49,700 · KE 5,534 → 5,364 → **~3,180** · NG 4,944 → 4,723 → **~2,850**.

**Woo sites are kept, not discarded (Joel, 2026-10-25):** the 19,496 non-store Woo rows are a legitimate lead class — "WooCommerce site, not a store" — valuable to agencies and plugin developers. They stay in the product; they must simply never be blended into "WooCommerce stores" in any count, report or research view. The "real store" figures above are the *selling-store* view; the sites view is a separate, clearly labelled total.

### 2.2 Weaknesses, ranked by customer value (not domain volume)
1. **Identity / dedup** — 3,838 www/bare pairs (~5% of published focus) double-count stores and split enrichment. Fix first: cheap, and every count/claim depends on it.
2. **Liveness semantics** — rename/split: `reachable` (DNS) vs `selling` (products + recent activity). Churn claims must rest on *selling*, never DNS.
3. **Woo segmentation (not verification)** — Woo is actually **99% checkout-probe-verified and fresh** (correction: `woo_checkout_at`, not the Shopify column I first counted). The real issues are two, both about *presentation* not coverage: (a) keep the 61% non-store Woo as an explicitly labelled segment ("Woo site — not a store"; valuable to agencies/plugin devs) and **split every Woo total into stores vs sites**; (b) we recover a **named gateway for only ~33%** of Woo (manual EFT/COD/unnamed) — report that honestly (e.g. "gateway not exposed at checkout"), don't let a blank read as "no payments". Caveat spotted in the sample: a `not_a_store` row (`thetinroofpty.co.za`) has a live Yoco checkout — `activity_tier` is noisy and the stores/sites split needs the classifier, not just the existing tag.
4. **KE/NG depth** — ~3k real stores each. CT won't grow them; Common Crawl (non-Shopify) and partner lists will. Set expectations ("SA-strong, Africa-emerging").
5. **Country attribution for generic TLDs** — use `shop_country` from `/meta.json` (ground truth) over ccTLD/currency guesses; label inferred countries.
6. **Rediscovery of closures** — dead stores keep being probed; closure is a *signal* (churn) we currently waste budget on instead of recording.

Headless storefronts, multi-storefront businesses (`shop_id` identity) and cross-border stores (currency vs ship-to) are **[UNK]** — no measurement exists yet; `backfill-shop-meta` (shop_id) is the lever for the multi-storefront case.

### 2.3 Estimating completeness without the true population
Use **capture–recapture across independent sources**: the overlap between what CT finds, what Common Crawl finds, what CrUX ranked lists hold, and partner-supplied customer lists gives a Lincoln–Petersen style estimate of the undiscovered remainder. Current overlap signals: Common Crawl Shopify finds **59% already held**; CT finds **87% already held** — both say Africa's Shopify is near saturation **[HYP]**. Biases to state out loud: all our sources favour stores with certificates and crawlable sites, so **new, headless and dormant stores are under-represented**, and the sources are not truly independent. Report **ranges**, never a single "coverage %". The cleanest ground truth available: a PSP's or agency's **own merchant list** as an independent sample — this is also a sales conversation.

---

## 3. Fleet capacity and economics

**Utilisation [FACT]:** Rex ran ~85% idle before this week; now busier but the limits that bind are **not CPU**. The binding constraints are **external and shared**: (1) the single home IP's Shopify-edge budget (contact lane hit 89% rate-limited at ~24k/day; the proven-clean rate is 1,200/day @ conc 2); (2) **Supabase disk IO** (burst budget depleting → throttle → review queries timing out). Adding machines amplifies both.

**Wasted / duplicate / low-value work [FACT]:** ~87% of CT finds re-find held stores (cheap DNS, acceptable); the 24k/day unpaced contact lane (fixed); full-table liveness over 2M global rows nobody sees (slowed to 24h); www twins enriched twice; probing dead stores; global ai-enrich (1.5M) consuming DB write IO pre-launch for records no African customer sees.

**Recommended launch allocation:**
- **Rex:** focus-market freshness (payments, contact-Shopify paced, liveness-focus) + discovery. **Move focus-liveness here** from Lucy (a sleeping laptop must not own the digest's freshness).
- **Lucy:** DNS-only lanes (hosting, non-Shopify contact) — best-effort, nothing depended on.
- **Chad:** text-mine (zero network) — best-effort.
- **Global ai-enrich:** **throttle to a trickle** until Africa thresholds are met and IO has recovered; it is Tier-C and is spending the scarce resource (DB IO).

**Safeguards:** per-lane rate-limited % (<10% healthy; the scripts already warn); Supabase disk-IO burst balance recovering; **rollback = restore the previous cadence/limit** (every change is a plist value or env var). Monitor in the founder digest (§8), not the artifact.

**Costs [FACT/UNK]:** Supabase Pro $25 + Medium compute ≈ $60 → ~$85/mo (verify on billing). Webshare 102 proxies: cost **[UNK]**. Vercel: **[UNK]**. Machines owned; local LLM $0. Likely total infra **< $200/mo** [HYP]. The scaling cost is **DB IO** (Large compute ~$110/mo or a provisioned-IOPS add-on), not machines. Forecast assumptions: Africa-only hot workload, global as background.

---

## 4. Lead accuracy and actionability

### 4.1 "Customer-ready lead" per segment
| Segment | Must have (verified, dated) | Nice to have | **Withhold / label cautiously** |
|---|---|---|---|
| **PSP** | deduped identity; verified country (`meta.json`, not ccTLD); CMS; current gateways + primary (probe-dated); change history; contact reaching a decision-maker + deliverable; *selling* evidence | Plus tier; AOV band | payment **preference/volume** (unprovable); **ordering/prominence** (not detected); inferred country |
| **Agency** | CMS, theme, apps, Plus tier; **migration** (platform change confirmed twice); contact | product-count trend ("growth"); **Woo sites (not stores) as a separate, labelled lead class** | "expansion" beyond observed changes; a Woo *site* presented as a *store* |
| **Logistics** | shipping providers (probe-dated); ships-international **(text-mine = model-labelled)**; new market/currency observed; contact | — | text-mine attributes as fact |
| **App devs** | apps installed (deep-enrich), CMS, Plus tier, category; contact | — | app *usage* (unobservable) |

### 4.2 Provenance we retain [FACT]
`source` ✓ · per-field `*_checked_at` ✓ (payments, contact, live, ai, hosting…) — and the model is right: **`checked_at` set + field empty = confirmed absence; null = unknown** · `payment_changes` history ✓ · partial confidence: `contact_name_source`, `text_mine_model` ✓ — **no confidence on category, platform or country** ✗.

### 4.3 Repeatable quality review (recommend)
Monthly, 100 stores stratified (ZA Shopify 50 / ZA Woo 20 / KE 15 / NG 15), manual check of 8 fields (identity, country, CMS, live/selling, gateways, primary, contact type, contact deliverable). Report **accuracy** and **completeness** separately, and **unknown vs confirmed-absent** separately. First run **before outreach** so you walk in with honest numbers. Baseline today: **missing**.

---

## 5. Intelligence and change detection

**What's clean [FACT]:** 0 flicker, 0 empty-transitions in 2,285 changes; insights deliberately separate `discovered_at` ("we found them") from `launched_at` ("new to market"); `not_a_store` excluded from denominators; `paymentReachable` is an honest payment denominator.

**What's not [FACT/UNK]:** ordering/prominence not captured; no detector-version stamp (can't separate merchant change from detection change); "churn" currently rests on DNS; `launched_at` coverage/accuracy unmeasured; growth tiles built on `discovered_at` still reflect *our* discovery rate — keep them labelled as such.

**Confirmation rules before any alert:** a change must be observed on **2 consecutive probes ≥24h apart**; record **first-observed** and the **may-have-happened window** (between the last unchanged probe and the first changed one); never alert from a probe failure (already enforced); hold alerts on stores that fail `selling`.

**Woo payment-gateway recovery — VALIDATED AND REJECTED (2026-10-25).** ~21,202 verified Woo stores show no *named* gateway. I tested two recovery paths on random samples before building anything: (1) re-mine banked homepage plugin slugs → **0/40** had a gateway slug (plugins load at checkout, not the homepage); (2) the WooCommerce Store API cart path (`/wc/store/v1/cart` → `payment_methods`) → **0/40 recovered, 36/40 had a down/404/500/disabled Store API**, 4 empty. A manual diagnosis confirmed the failures are **server-side** (`blacbrush.co.za` 500s on both `/checkout/` and `/wp-json`), not our fetch — one healthy store (`currentbodysouthafrica.co.za`) returned `payment_methods=["sankee","mp"]`, proving the method works *when the site does*. **Conclusion: the no-gateway Woo population is overwhelmingly broken/classic/disabled-API — i.e. the weak "WooCommerce site, not a real store" tail — so a standing recovery job would spend effort for ~0 yield.** Do **not** build it. The right treatment is the **stores-vs-sites classifier split** (§2.2 gap #3), which subsumes this: a Woo store whose checkout/API doesn't even function is almost by definition "site, not store." If a healthy-Woo-store subset with manual-only payments turns out to matter to a specific PSP pilot, revisit then with the Store API path (it works on healthy stores) — scoped to that subset, not the whole tail.

**Follow-up (2026-10-25): gateway coverage on REAL Woo stores + can the gap close?** Restricting to Woo *stores* (`activity_tier in selling,active`): **12,260 real stores, 8,877 with a named gateway = 72.4%, gap 3,383** (the blended 33% was dragged down by the 4.5%-covered not_a_store tail). Tested three cheap recovery paths on the real-store gap, all ~0: homepage-plugin re-mine (gateways don't footprint the homepage), Store API empty-cart (~1/40), Store API add-to-cart (0/10, mostly empty-after-add or 400). **Root cause: SA Woo overwhelmingly uses *classic* (shortcode) checkout, where gateways render only as form inputs on a cart-populated `/checkout/` page and never appear in the Store API `payment_methods` field (that's a Blocks-checkout feature SA gateways mostly don't use).** The 72% we have comes from homepage plugin footprints; the 3,383 gap is structurally invisible to HTTP probing. Only remaining path = **headless render of a cart-populated classic checkout** (`checkout_probe_browser.py`/`headless_probe.py`) — expensive per store, uncertain yield, **not worth a standing job**, but bounded (3,383) so viable as a scoped one-off for a PSP pilot. **Decision: ship Woo-store payments at 72%, label the gap "gateway not detected (often classic checkout/manual)", hold headless in reserve.** 72% on verified+fresh real Woo stores is competitive — Woo gateway detection is hard for everyone.

**Refinement (2026-10-25, Joel): don't chase the whole gap — manually check only the high-revenue slice.** Ranking the 3,383 gap by `revenue_ballpark_usd` (traffic×AOV estimate; a ranking key, not verified fact — 617 corroborated by a CrUX rank): only **~149 stores are ≥$20k/mo and ~289 ≥$5k/mo**; the other ~3,100 are R7–27k/mo or ~R0. The top ~12 are named SA retailers at $65k–150k/mo (aldoshoes.co.za/Aldo, talisman, rhinoman, thewoolshoppe, diesel-electric, midasparts…). So the commercially meaningful gap is a **~20-minute (top 12) to one-afternoon (top 150) manual check**, not an engineering job — and it doubles as flagship-prospect sales research and a classification sanity check (a few show `product_count=null`, possibly not real stores). Worklist generated: `woo-gateway-manual-check.csv` (289 rows ≥$5k/mo, ranked, with checkout URLs + fill-in columns for gateway and is-real-store). **Owner: Joel/team, manual. Acceptance: top 150 checked, gateway or "manual/EFT/none" recorded.**

**Browser-capture test of the top 12 (2026-10-25) — 1 clean capture, and a data-quality catch.** Drove the built-in browser through add-to-cart→checkout on the highest-value gap stores. **aldoshoes.co.za captured: Stitch, PayGate, PayU, PayJustNow** (written to DB, `payments_source='browser_checkout'`) — proof the rendered checkout yields what the HTTP probe couldn't. My browser capture **failed** on rhinoman.co.za and talisman.co.za — and I wrongly turned that failure into "they have no online-payment checkout." **Correction (peer, verified):** a blank `payments` on these means *not checkout-probed*, NOT "can't take money" — never read a blank as evidence of absence. Their text-mine data splits them: talisman = services/physical_store/wholesale (consistent with quote/B2B hire), but **rhinoman = dtc with 157 products — probably a real store I just failed to read** (block checkout / hydration). So the only confident capture here is Aldo. Three corrected implications: (1) **the clean verdict is a *checkout probe*, not a blank field, not a failed browser read, and not the biz_model classifier** (which is 1-for-2 on these two and only separates no-gateway at 14% dtc vs 23% services — a prioritiser, not a filter); (2) **`revenue_ballpark` over-estimates high-traffic non-ecommerce sites**, so it isn't a clean "is this a store" signal — but note the customer *contact* lane ranks by `estimated_monthly_sales`, not `revenue_ballpark`, so it isn't exposed to that bias (though `estimated_monthly_sales`/StoreCensus runs ~61% light on local SA brands — opposite bias, same caution); (3) automated capture is per-store flaky (classic vs block checkout, redirect-to-home, hydration), so the **manual worklist wins on speed and judgement** — and it should be prioritised by biz_model (dtc/physical_store=false first = likeliest real online store) so the human checks the best prospects first.

**Three launch use cases + minimum evidence:**
1. **PSP gateway add/remove alerts (SA Shopify)** — probe-verified before/after, 2-probe confirmation, dated window, deduped identity, store is *selling*.
2. **Agency: CMS migration + genuine new-store feed (SA)** — platform change confirmed twice; "new" from `launched_at`/`first_product_at`, never `discovered_at`.
3. **PSP/logistics market view** — provider share among **verified live selling** stores (fixed denominator), with coverage expansion shown **separately** so discovery growth is never read as market growth.

Not at launch: ordering/prominence, transaction volume/preference, DNS-based churn, discovery-as-growth.

---

## 6. Competitors and StoreLeads

**Where we have evidence of an edge [FACT]:** contact labelling (named 13.8% vs vendor 3.9%; no-email 16.7% vs 28.8%, measured on 4,450 stores); payment verification freshness (84% of ZA Shopify <90d — vendors' freshness **[UNK]**); live change detection (vendors appear snapshot-based **[HYP]**); focus markets are mostly self-sourced (StoreCensus is 8%/4%/4% of ZA/KE/NG). **Untested:** discovery breadth vs StoreLeads/BuiltWith for Africa; their accuracy; usability head-to-head.

**StoreLeads import — Joel's decision: proceed, for benchmarking only (2026-10-25).** My risk flag stands but is recorded, not blocking: their public [terms](https://storeleads.app/terms) bar reselling, republishing, mirroring **and "using the information for competitive purposes"** — and Terrain is a competitor, so benchmark-to-improve-a-competing-product is the exact use that clause targets; independent re-verification does **not** lift a contract term, and the public page is truncated/undated. **Action for Joel:** read the full current terms and ideally obtain written sign-off before importing. **Safe-handling requirements (non-negotiable for the benchmark to be valid):** (1) isolate imported rows in their own table/namespace, `source='storeleads'`, **never** in `imported_stores`; (2) keep StoreLeads timestamps strictly separate from our `*_checked_at`; (3) **hold out an independent evaluation sample** assessed only by our own probes and never fed from their data, so "do we beat them" stays a real measurement, not a copy of theirs; (4) investigate every discrepancy with our own probe, don't accept their classification. **Output:** a gap analysis — stores each system has that the other misses + classification disagreements. Complementary clean signals that need no licence: partner-supplied merchant lists (also a sales motion) and capture–recapture across CT / Common Crawl / CrUX (§2.3).

---

## 7. Product work — the sequence, challenged

Your order: Stripe → onboarding → digests → global → StoreLeads. **Recommended: onboarding → PSP change-alert digest v1 → entitlement model → Stripe (gated on pay intent) → *defer* global → *drop* StoreLeads import.**

| Initiative | Customer outcome / smallest useful version | Deps & data quality | Effort / ongoing | Acceptance | When |
|---|---|---|---|---|---|
| **Onboarding → first useful result** | Role + markets + goal → one saved list + one intelligence view in <5 min | dedup; activity tier always visible (Woo **stores vs sites** split, never blended); honest "live" | M / low | 3 pilots reach a saved list unaided | **Before pilots** |
| **PSP change-alert digest v1 (email)** | Weekly: gateway adds/removes on verified SA Shopify, with dates + evidence + action | confirmation rules (§5); deduped identity | M / low | 1 PSP acts on an alert | **Before pilots** (it *is* the product) |
| **Entitlement model** (plan-aware `hasAccess`, CMS gating, metered export) | Pilots scoped honestly; no unmetered export | — | M / low | tiers see different data; export metered | **Before paid** |
| **Stripe billing** (eligibility, sub, entitlement, failed payment + dunning email, cancel) | Pay → access; fail → grace → lock | entitlement model; webhook emails (today: none) | M–L / med | end-to-end test incl. failure + cancel | **Before paid, after pay intent is heard in interviews** |
| **WhatsApp digest** | — | consent/opt-in (POPIA), unsubscribe | M / med | — | **Later** (email first) |
| **Expose global coverage** | — | unverified, would spend scarce DB IO | — | — | **Defer**: keep internal until Africa thresholds met |
| **StoreLeads import** | — | ToS competitive clause | — | — | **Drop**; do §6 alternative |

---

## 8. Reporting that helps decide

**Founder digest (weekly, with daily exceptions) — seven lines:**
1. *More useful to customers?* — pilot users active, saved lists, alerts acted on. **Baseline missing (needs instrumentation).**
2. *Improved / deteriorated* — WoW: verified-fresh ZA Shopify, reach-a-person count, duplicate pairs, Woo verified %.
3. *Weak markets/CMS* — KE/NG selling-store counts; Woo **stores vs sites** reported separately; Woo named-gateway recovery % (vs the 99% probe-verified base).
4. *Fresher & more accurate* — freshness buckets; monthly audit accuracy.
5. *Machines efficient* — useful verified records/day per lane; waste (rate-limited %, dedup %, IO budget).
6. *Blocked* — e.g. Lucy offline, IO throttle, any lane >10% 429.
7. *Decision needed from Joel.*
Each with baseline → target → trend arrow; exceptions only; no raw totals.

**The fleet artifact should become:** retire the **replayed "live" feed** (a snapshot that reads as a socket); keep **`/fleet` in-app** as the genuinely live *ops health* strip; the **founder digest** is the decision surface; `OPS.md` stays the ops log.

---

## 9. Source of truth and accountability

Propose a compact **`LAUNCH.md`** (seeded from this review) holding: goals & launch criteria · architecture & constraints (one page) · decisions + rationale · open assumptions + evidence needed · priorities, owners, dates · deferred work + reasons · customer feedback → changes. `OPS.md` remains the operational log; the two link to each other.

**Only you can do [action · date]:** 10 discovery interviews booked (PSP×4, agency×3, logistics×2, app×1) — **by 2026-11-01**; 1-page positioning ("SA Shopify-strong, Africa-emerging") — **2026-11-01**; pricing validated in interviews, 3 pilot commitments — **2026-11-15**; sales script + the 226-row list worked — rolling from **2026-11-01**.

**Flags (said plainly):** the last several days were almost entirely pipeline work with **zero customer contact evidenced** — necessary (things were broken) but the ratio is off; **scope creep** candidates: Radar ②/③A, global exposure, Censys/Shodan, text-mine attribute expansion, JP; **conflicting goals:** max throughput vs DB-IO budget, global reach vs African freshness; **overdue decisions:** launch scope claim, billing timing. (Woo is resolved: sites kept as a labelled class, payments already 99% probe-verified — only the stores-vs-sites split and honest "no named gateway" labelling remain, both presentation work.)

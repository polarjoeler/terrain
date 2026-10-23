#!/usr/bin/env node
/**
 * Mine the page text we have ALREADY FETCHED for commercial attributes — at $0, with no network.
 *
 * deep-enrich and contact-enrich bank cleaned page copy (homepage_text / contact_text) precisely so
 * a later pass can read it without touching the store again. 47k stores are banked and nothing has
 * ever read them. This is the job an always-on local LLM box is for: compute-bound, not crawl-bound,
 * so it competes with NOTHING — not the Shopify rate budget, not the payment probes, not DNS.
 *
 *   node --env-file=.env.local scripts/text-mine.mjs --migrate            # ONCE
 *   node --env-file=.env.local scripts/text-mine.mjs --eval --limit 120   # score before trusting
 *   node --env-file=.env.local scripts/text-mine.mjs --country ZA --limit 2000
 *
 * WHAT IT EXTRACTS, and why a lead buyer cares:
 *   biz_model          dtc | wholesale_b2b | marketplace | subscription | services | unclear
 *   sells_wholesale    trade/stockist accounts → invoicing and terms, a different payments product
 *   physical_store     a real shop → card-present, the single most useful split for a PSP
 *   ships_international cross-border → FX and international acquiring
 *   founded_year       age without relying on a vendor's guess
 *
 * HONESTY ABOUT CONFIDENCE. Only ONE of these can be scored against something we independently
 * know: `subscription`, which deep-enrich detects from app fingerprints (Recharge, Appstle, …).
 * `--eval` measures the model against those 273 labelled stores, so we calibrate on the one
 * attribute with ground truth and know whether to trust the model's judgement at all. The rest are
 * stored with the model name against them and must be presented as model-labelled, never as
 * verified fact.
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const DRY = has("--dry"), MIGRATE = has("--migrate"), EVAL = has("--eval"), VERBOSE = has("--verbose");
const LIMIT = Number(arg("--limit", 500));
const CONC = Number(arg("--concurrency", 3));
const MODEL = arg("--model", process.env.LOCAL_LLM_MODEL || "qwen2.5:7b");
const LLM = (process.env.LOCAL_LLM_URL || "").replace(/\/$/, "");
const countries = (arg("--country", "") || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

const MODELS = ["dtc", "wholesale_b2b", "marketplace", "subscription", "services", "unclear"];

function prompt(domain, text) {
  return `Below is website copy from the online store ${domain}.

"""
${text.slice(0, 4000)}
"""

Answer ONLY from the text above. Use null where the text does not say. Do not guess.

- business_model: one of ${MODELS.join(", ")}
- sells_wholesale: true only if it offers trade, stockist, wholesale or reseller accounts
- physical_store: true only if it states a shop/showroom customers can visit (a postal or
  returns address alone is NOT a shop)
- ships_international: true only if it states shipping outside its own country
- founded_year: a 4-digit year it says it was founded/established, else null

Respond with ONLY minified JSON:
{"business_model":"...","sells_wholesale":true|false|null,"physical_store":true|false|null,"ships_international":true|false|null,"founded_year":null}`;
}

const asBool = (v) => (v === true || v === false ? v : null);
function parse(raw) {
  const p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  const bm = MODELS.includes(p.business_model) ? p.business_model : null;
  const yr = Number(p.founded_year);
  return {
    biz_model: bm,
    sells_wholesale: asBool(p.sells_wholesale),
    physical_store: asBool(p.physical_store),
    ships_international: asBool(p.ships_international),
    founded_year: Number.isInteger(yr) && yr >= 1900 && yr <= new Date().getFullYear() ? yr : null,
  };
}

async function ask(domain, text) {
  const res = await fetch(`${LLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: "user", content: prompt(domain, text) }],
      max_tokens: 160, temperature: 0, response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const d = await res.json();
  return parse(d.choices?.[0]?.message?.content ?? "");
}

const DDL = [
  "SET lock_timeout = '3s'",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS biz_model TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS sells_wholesale BOOLEAN",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS physical_store BOOLEAN",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ships_international BOOLEAN",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS founded_year INTEGER",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS text_mined_at TIMESTAMPTZ",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS text_mine_model TEXT",
  "RESET lock_timeout",
];

const TEXT = "COALESCE(NULLIF(homepage_text,''), NULLIF(contact_text,''))";

async function main() {
  if (!LLM) { console.error("LOCAL_LLM_URL not set — this lane is local-only by design."); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    if (MIGRATE) {
      for (const q of DDL) {
        console.log(q.slice(0, 74));
        try { await sql.unsafe(q); }
        catch (e) { if (/lock timeout|canceling/i.test(e.message)) { console.error(`  ✗ busy: ${e.message}`); process.exit(4); } throw e; }
      }
      console.log("migrated."); return;
    }

    if (EVAL) {
      // Calibrate on the ONE attribute we independently know: deep-enrich detects subscription
      // tooling from app fingerprints. Balanced set — equal positives and negatives, so a model
      // that simply always says "no" scores 50%, not 90%.
      const pos = await sql.unsafe(`SELECT domain, ${TEXT} AS text, true AS truth FROM imported_stores
        WHERE subscription_tools IS NOT NULL AND subscription_tools <> '' AND length(${TEXT}) > 400
        ORDER BY random() LIMIT ${Math.floor(LIMIT / 2)}`);
      const neg = await sql.unsafe(`SELECT domain, ${TEXT} AS text, false AS truth FROM imported_stores
        WHERE (subscription_tools IS NULL OR subscription_tools = '') AND length(${TEXT}) > 400
        ORDER BY random() LIMIT ${Math.floor(LIMIT / 2)}`);
      const set = [...pos, ...neg];
      if (!set.length) { console.log("no labelled stores."); return; }
      console.log(`eval: ${MODEL} on ${set.length} stores (${pos.length} with subscription tooling detected, ${neg.length} without)\n`);
      let tp = 0, fp = 0, tn = 0, fn = 0, err = 0;
      for (const r of set) {
        let g; try { g = await ask(r.domain, r.text); } catch { err++; continue; }
        const said = g.biz_model === "subscription";
        if (said && r.truth) tp++; else if (said && !r.truth) { fp++; if (VERBOSE) console.log(`  FP ${r.domain}`); }
        else if (!said && r.truth) fn++; else tn++;
      }
      const n = tp + fp + tn + fn, pc = (x, d) => (d ? `${Math.round((100 * x) / d)}%` : "—");
      console.log(`  correctly called subscription  ${tp}`);
      console.log(`  missed it (said something else) ${fn}`);
      console.log(`  false alarms                    ${fp}`);
      console.log(`  correctly not subscription      ${tn}`);
      if (err) console.log(`  model errors                    ${err}`);
      console.log(`\nprecision ${pc(tp, tp + fp)}  recall ${pc(tp, tp + fn)}  overall ${pc(tp + tn, n)}`);
      console.log(`A coin-flip scores 50% overall here (the set is balanced). Below ~70% precision,\ndo not ship these fields as anything but a hint.`);
      return;
    }

    const rows = await sql.unsafe(`SELECT domain, ${TEXT} AS text FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND length(${TEXT}) > 400 AND text_mined_at IS NULL
        ${countries.length ? `AND UPPER(country) = ANY(ARRAY[${countries.map((c) => `'${c}'`).join(",")}])` : ""}
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${Number(LIMIT)}`);
    if (!rows.length) { console.log("nothing to mine — every banked store is done."); return; }
    console.log(`text-mine: ${rows.length} store(s)${DRY ? " [DRY]" : ""} · ${MODEL} · banked text only, no network`);

    const tally = {}; let done = 0, failed = 0;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (i < rows.length) {
        const r = rows[i++];
        let g; try { g = await ask(r.domain, r.text); } catch { failed++; done++; continue; }
        tally[g.biz_model ?? "null"] = (tally[g.biz_model ?? "null"] ?? 0) + 1;
        done++;
        if (DRY) console.log(`● ${r.domain.padEnd(34)} ${String(g.biz_model).padEnd(14)} wholesale:${String(g.sells_wholesale).padEnd(5)} shop:${String(g.physical_store).padEnd(5)} intl:${String(g.ships_international).padEnd(5)} est.${g.founded_year ?? "-"}`);
        else await sql`UPDATE imported_stores SET
            biz_model = ${g.biz_model}, sells_wholesale = ${g.sells_wholesale},
            physical_store = ${g.physical_store}, ships_international = ${g.ships_international},
            founded_year = COALESCE(${g.founded_year}, founded_year),
            text_mined_at = now(), text_mine_model = ${MODEL}
          WHERE domain = ${r.domain}`.catch((e) => console.log(`  ! ${r.domain}: ${e.message}`));
        if (done % 100 === 0) console.log(`— ${done}/${rows.length}`);
      }
    }));
    console.log(`\nDone. ${done} mined, ${failed} model errors.`);
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

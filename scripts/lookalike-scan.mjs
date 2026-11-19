/**
 * lookalike-scan — which domains we hold wear a top African store's name? (Radar Watch)
 *
 * The catalogue sweep (clone-sweep.mjs) can only compare stores it has fingerprinted, and the
 * fingerprint lanes are scoped to African markets. Clones get a foreign or empty country
 * (sale-ripcurl.shop was tagged AU), so on 2026-11-19 only 6 of 519 look-alike candidates had a
 * fingerprint and none appeared in catalog_matches. Domain names are free and cover every store,
 * so they FIND the candidates; catalogue fetches are scarce, so they only CONFIRM them.
 *
 *  1. Scan. Victims = the top 1,000 stores per market (store_priority.market_rank, ZA/KE/NG) plus
 *     the brand watchlist (~/shopify-radar/brands.txt). A suspect matches when its folded label
 *     (lib/radar/clone-score.mjs canon + label: homoglyphs, punctuation and TLD stripped) wraps the
 *     brand label, equals it on another domain, or is one edit away. A brand label found inside more
 *     than GENERIC_FAN domains is a dictionary word ("fashion"), not a brand, and is dropped.
 *     The brand's own sites are excluded: same registrable domain, same store group, same shop_id,
 *     or shared owner identity (sameOperator).
 *     Daily runs scan only domains created since the last run; a full pass runs weekly (Sundays,
 *     or --full) so new victims are checked against the whole corpus.
 *  2. Tier. A = wraps/same-name AND (a bait word — official/sale/outlet/promo/deal… — or a
 *     throwaway TLD on a domain we first saw in the last 120 days). B = other wraps/same-name.
 *     One-edit typos are mostly coincidence (bakerswarehouse ↔ bikerswarehouse) and are not stored.
 *  3. Confirm. Up to --confirm tier-A Shopify/Woo candidates a run get a targeted catalogue check
 *     against their victim: Shopify product sitemaps (same polite path as sitemap-fp) or the Woo
 *     Store API. The first strong overlap is frozen into `evidence`, because clones empty themselves
 *     once noticed (burntstudiospro.co.za, Aug 2026).
 *
 * Writes only lookalike_candidates (and store_catalog_fp for a suspect with no fingerprint yet).
 * Review status (new / confirmed / benign / dismissed) is set on /admin/radar/watch and never
 * overwritten here.
 *
 *   node --env-file=.env.local scripts/lookalike-scan.mjs --migrate          # once: create the table
 *   node --env-file=.env.local scripts/lookalike-scan.mjs --dry [--full]      # scan, print, write nothing
 *   node --env-file=.env.local scripts/lookalike-scan.mjs [--full] [--confirm 60] [--no-confirm]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { label, canon, registrable, sameOperator, valueFanout } from "../lib/radar/clone-score.mjs";
import { buildFp, upsertFp, scorePair } from "./lib/catalog-fp.mjs";
import { fetchWooCatalog } from "./lib/woo-catalog.mjs";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { parseProductSitemap } from "./sitemap-fp.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry"), MIGRATE = has("--migrate");
const FULL = has("--full") || new Date().getDay() === 0;
const CONFIRM = has("--no-confirm") ? 0 : Number(arg("--confirm", 60));
const VICTIM_RANK = Number(arg("--top", 1000));
const MARKETS = ["ZA", "KE", "NG"];
const GENERIC_FAN = 40;    // a label inside more domains than this is a word, not a brand
const RECENT_DAYS = 120;
const PAUSE_MS = 1000;
const CURSOR_KEY = "lookalike-scan.since";

// Words a clone bolts onto a brand to look like its sale/official channel.
// "wholesale" is a real channel, not bait, so "sale" must not match inside it.
export const BAIT = /(official|outlet|(?<!whole)sales?|discount|factory|deals?|clearance|cheap|promo|blackfriday|warehouse)/;
const SUFFIX = /(online|store|stores|shop|shops|sa|za|southafrica|africa|kenya|nigeria|mall|boutique|direct|express|hub|wholesale)/g;
export const THROWAWAY_TLD = /\.(shop|store|online|xyz|top|site|club|live|vip|buzz|icu|life|fun|website|space)$/;

/** One-character deletions, the SymSpell trick: two labels one edit apart share a deletion. */
const del1 = (s) => { const o = new Set([s]); for (let i = 0; i < s.length; i++) o.add(s.slice(0, i) + s.slice(i + 1)); return o; };

/** Build the matcher once per run. brands: Map(canonLabel → victim). */
export function buildMatcher(brands) {
  const pre = new Map(), dIdx = new Map();
  for (const c of brands.keys()) {
    const k = c.slice(0, 5);
    (pre.get(k) ?? pre.set(k, []).get(k)).push(c);
    if (c.length >= 6) for (const v of del1(c)) (dIdx.get(v) ?? dIdx.set(v, new Set()).get(v)).add(c);
  }
  /** domain → [{ brand, how: 'wraps' | 'same-name' | 'typo' }] */
  return (domain) => {
    const s = canon(label(domain));
    if (s.length < 5) return [];
    const found = new Map();
    for (let i = 0; i + 5 <= s.length; i++)
      for (const c of pre.get(s.slice(i, i + 5)) ?? []) if (s.includes(c)) found.set(c, s === c ? "same-name" : "wraps");
    for (const v of del1(s)) for (const c of dIdx.get(v) ?? []) if (!found.has(c) && c !== s) found.set(c, "typo");
    const reg = registrable(domain), out = [];
    for (const [c, how] of found) if (registrable(brands.get(c).domain) !== reg) out.push({ brand: c, how });
    return out;
  };
}

/** Score + tier one hit. s = suspect row, v = victim row. Pure, so it's testable. */
export function assess(h, s, v, now = Date.now()) {
  const sig = []; let score = 0;
  const add = (p, why) => { score += p; sig.push(why); };
  const rest = canon(label(s.domain)).replace(h.brand, " ");
  const bait = rest.match(BAIT)?.[1];
  const suffixes = [...new Set(rest.match(SUFFIX) ?? [])];
  const odd = THROWAWAY_TLD.test(s.domain);
  const ageDays = s.seen ? (now - new Date(s.seen).getTime()) / 864e5 : null;
  const recent = ageDays !== null && ageDays < RECENT_DAYS;
  if (h.how === "typo") add(30, "one letter off the brand");
  if (h.how === "same-name") add(10, "same name on another domain");
  if (bait) add(30, `bait word "${bait}"`);
  else if (suffixes.length) add(10, `adds "${suffixes.join("+")}"`);
  if (odd) add(15, `throwaway TLD .${s.domain.split(".").pop()}`);
  if (recent) add(15, `first seen ${Math.round(ageDays)}d ago`);
  if ((s.theme || "").toLowerCase().startsWith("copy of")) add(25, `duplicated theme "${s.theme}"`);
  const social = [s.instagram, s.facebook, s.tiktok].some((x) => x && !/^(shopify|instagram|facebook|tiktok)$/i.test(String(x).replace(/.*\.com\//, "").replace(/\/+$/, "")));
  if (!social && (s.product_count ?? 0) >= 20) add(10, "no social accounts");
  if (s.name && canon(s.name).includes(h.brand)) add(10, `calls itself "${String(s.name).slice(0, 40)}"`);
  if ((s.product_count ?? 0) > 0) add(5, `${s.product_count} products`);
  const tier = h.how === "typo" ? null : (bait || (odd && recent)) ? "A" : "B";
  return { score, signals: sig, tier };
}

function loadWatchlist(file = process.env.BRANDS_FILE || path.join(os.homedir(), "shopify-radar", "brands.txt")) {
  try {
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("|") || line.trim().startsWith("#")) continue;
      const [name, doms] = line.split("|");
      for (const d of doms.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) out.push({ domain: d, name: name.trim() });
    }
    return out;
  } catch { return []; }
}

async function ensureTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS lookalike_candidates (
    suspect text NOT NULL, brand text NOT NULL,
    brand_rank int, brand_market text,
    match text NOT NULL, tier text NOT NULL, score int NOT NULL, signals text[] NOT NULL,
    suspect_seen_at timestamptz, suspect_platform text, suspect_live text,
    catalog_score int, catalog_verdict text, catalog_detail jsonb, catalog_checked_at timestamptz,
    evidence jsonb, evidence_at timestamptz,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'benign', 'dismissed')),
    reviewed_at timestamptz, reviewed_by text, note text, unpublished_lead boolean NOT NULL DEFAULT false,
    first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (suspect, brand))`;
  await sql`CREATE INDEX IF NOT EXISTS lookalike_candidates_tier ON lookalike_candidates (tier, status)`;
  await sql`CREATE INDEX IF NOT EXISTS lookalike_candidates_brand ON lookalike_candidates (brand)`;
}

const DETAIL_COLS = (sql) => sql`s.domain, s.name, s.platform, s.published, coalesce(s.live_status, s.status) AS live, s.product_count,
  coalesce(s.discovered_at::timestamptz, s.created_at::timestamptz) AS seen, s.theme, s.instagram, s.facebook, s.tiktok,
  s.email, s.contact_email, s.contact_phone, s.merchant_name, s.shop_id, m.group_id`;

async function scan(sql) {
  const t0 = Date.now();
  const vic = await sql`SELECT p.domain, p.country, p.market_rank FROM store_priority p
    WHERE p.country = ANY(${MARKETS}) AND p.market_rank <= ${VICTIM_RANK}`;
  const brands = new Map();
  for (const v of vic) {
    const c = canon(label(v.domain));
    if (c.length >= 5 && !/^\d+$/.test(c) && (!brands.has(c) || v.market_rank < brands.get(c).market_rank)) brands.set(c, v);
  }
  for (const w of loadWatchlist()) { const c = canon(label(w.domain)); if (c.length >= 4) brands.set(c, { domain: w.domain, country: "watchlist", market_rank: 0 }); }
  const match = buildMatcher(brands);

  // Generic-label fan-out needs the WHOLE corpus, so it is counted on full passes and kept in
  // app_settings for the daily incremental runs.
  const setting = async (k) => (await sql`SELECT value FROM app_settings WHERE key = ${k}`.catch(() => []))[0]?.value ?? null;
  const since = FULL ? null : await setting(CURSOR_KEY);
  const startedAt = new Date().toISOString();
  let generic = new Set(JSON.parse((await setting(`${CURSOR_KEY}.generic`)) || "[]"));
  const fan = new Map(), hits = [];
  let n = 0;
  const take = (rows) => {
    for (const { domain } of rows) {
      n++;
      for (const h of match(domain)) { fan.set(h.brand, (fan.get(h.brand) ?? 0) + 1); hits.push({ domain, ...h }); }
    }
  };
  if (since) {
    take(await sql`SELECT domain FROM imported_stores WHERE created_at > ${since}::timestamptz`);
  } else {
    // Keyset pages on the primary key, not one long cursor: the pooler holds every statement to
    // its 2-minute default (a connection-level statement_timeout is ignored), and a single scan of
    // 5.6M rows runs past it. Short index-ordered pages also go easier on the shared DB.
    for (let last = ""; ;) {
      const rows = await sql`SELECT domain FROM imported_stores WHERE domain > ${last} ORDER BY domain LIMIT 50000`;
      if (!rows.length) break;
      take(rows);
      last = rows.at(-1).domain;
    }
  }
  if (!since) generic = new Set([...fan].filter(([, f]) => f > GENERIC_FAN).map(([c]) => c));
  const kept = hits.filter((h) => !generic.has(h.brand) && h.how !== "typo");
  console.log(`lookalike-scan: ${since ? `incremental since ${since.slice(0, 19)}` : "FULL pass"} · ${brands.size.toLocaleString()} brand labels · ${n.toLocaleString()} domains · ${hits.length.toLocaleString()} raw hits · ${generic.size} generic labels dropped · ${kept.length.toLocaleString()} kept (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // Details for suspects and their victims, in batches.
  const doms = [...new Set([...kept.map((h) => h.domain), ...kept.map((h) => brands.get(h.brand).domain)])];
  const D = new Map();
  for (let i = 0; i < doms.length; i += 2000)
    for (const r of await sql`SELECT ${DETAIL_COLS(sql)} FROM imported_stores s LEFT JOIN store_group_members m ON m.domain = s.domain
        WHERE s.domain = ANY(${doms.slice(i, i + 2000)})`) D.set(r.domain, r);
  const idf = valueFanout([...D.values()]);
  const out = [];
  let own = 0;
  for (const h of kept) {
    const s = D.get(h.domain), b = brands.get(h.brand), v = D.get(b.domain) ?? b;
    if (!s) continue;
    if ((s.group_id && s.group_id === v.group_id) || (s.shop_id && s.shop_id === v.shop_id) || sameOperator(v, s, idf)) { own++; continue; }
    const a = assess(h, s, v);
    if (!a.tier) continue;
    out.push({ suspect: s.domain, brand: b.domain, brand_rank: b.market_rank ?? null, brand_market: b.country ?? null, match: h.how,
      tier: a.tier, score: a.score, signals: a.signals, suspect_seen_at: s.seen ?? null, suspect_platform: s.platform ?? null, suspect_live: s.live ?? null });
  }
  // One row per (suspect, brand): a domain wrapping two labels of one brand keeps the stronger.
  const best = new Map();
  for (const r of out) { const k = `${r.suspect}|${r.brand}`; if (!best.has(k) || r.score > best.get(k).score) best.set(k, r); }
  const rows = [...best.values()].sort((x, y) => y.score - x.score);
  const tiers = rows.reduce((o, r) => ((o[r.tier] = (o[r.tier] ?? 0) + 1), o), {});
  console.log(`  ${rows.length.toLocaleString()} candidates (${own} were the brand's own sites) · tiers ${JSON.stringify(tiers)}`);
  for (const r of rows.filter((r) => r.tier === "A").slice(0, 15)) console.log(`   ${String(r.score).padStart(3)} ${r.suspect} → ${r.brand} · ${r.signals.slice(0, 3).join("; ")}`);
  if (DRY) return rows;

  for (let i = 0; i < rows.length; i += 500) {
    await sql`INSERT INTO lookalike_candidates ${sql(rows.slice(i, i + 500), "suspect", "brand", "brand_rank", "brand_market", "match", "tier", "score", "signals",
        "suspect_seen_at", "suspect_platform", "suspect_live")}
      ON CONFLICT (suspect, brand) DO UPDATE SET brand_rank = EXCLUDED.brand_rank, brand_market = EXCLUDED.brand_market, match = EXCLUDED.match,
        tier = CASE WHEN lookalike_candidates.catalog_score >= 50 THEN 'A' ELSE EXCLUDED.tier END,
        score = EXCLUDED.score, signals = EXCLUDED.signals, suspect_platform = EXCLUDED.suspect_platform,
        suspect_live = EXCLUDED.suspect_live, last_seen_at = now()`;
  }
  for (const [k, v] of [[CURSOR_KEY, startedAt], ...(since ? [] : [[`${CURSOR_KEY}.generic`, JSON.stringify([...generic])]])])
    await sql`INSERT INTO app_settings (key, value, updated_at) VALUES (${k}, ${v}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  console.log(`  ✓ upserted ${rows.length.toLocaleString()} candidates`);
  return rows;
}

// ---- Confirmation: a targeted catalogue check of tier-A candidates against their victim ----

async function fetchShopifySitemap(domain, pool, get) {
  const idx = await get(`https://${domain}/sitemap.xml`, pool);
  if (!idx || idx.status !== 200) return { error: idx ? `sitemap HTTP ${idx.status}` : "unreachable" };
  const decode = (s) => s.replace(/&amp;/g, "&");
  const files = [...idx.text.matchAll(/<loc>([^<]*sitemap_products[^<]*)<\/loc>/g)].map((m) => decode(m[1])).slice(0, 4);
  if (!files.length) return { error: "no product sitemap" };
  const products = [];
  for (const f of files) {
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    const r = await get(f, pool);
    if (!r || r.status !== 200) return products.length ? { products } : { error: r ? `HTTP ${r.status}` : "unreachable" };
    products.push(...parseProductSitemap(r.text));
  }
  return { products };
}

async function fetchCatalogue(domain, platform, pool, get) {
  if (/shopify/i.test(platform ?? "")) return fetchShopifySitemap(domain, pool, get);
  if (/woo/i.test(platform ?? "")) {
    try { return { products: (await fetchWooCatalog(domain, { maxProducts: 4000, pauseMs: 700 })).products }; }
    catch (e) { return { error: e.message }; }
  }
  return { error: `unsupported platform ${platform ?? "unknown"}` };
}

async function withBrandPlatform(sql, rows) {
  const p = new Map((await sql`SELECT domain, platform FROM imported_stores WHERE domain = ANY(${rows.map((r) => r.brand)})`).map((r) => [r.domain, r.platform]));
  return rows.map((r) => ({ ...r, brand_platform: p.get(r.brand) ?? null }));
}

const toFp = (r) => ({ n: r.n_products, img: Int32Array.from(r.img), sku: Int32Array.from(r.sku), handle: Int32Array.from(r.handle), title: Int32Array.from(r.title), price: Int32Array.from(r.price) });

async function confirm(sql, scanned) {
  // --dry with no table yet: check the scan's own top tier-A rows, write nothing.
  const todo = scanned ? await withBrandPlatform(sql, scanned.filter((r) => r.tier === "A" && /shopify|woo/i.test(r.suspect_platform ?? "")
      && !/dead|migrated/.test(r.suspect_live ?? "")).slice(0, CONFIRM)) : await sql`
    SELECT c.suspect, c.brand, c.suspect_platform, v.platform AS brand_platform
      FROM lookalike_candidates c LEFT JOIN imported_stores v ON v.domain = c.brand
     WHERE c.tier = 'A' AND c.status IN ('new', 'confirmed')
       AND coalesce(c.suspect_live, '') NOT IN ('dead', 'migrated')
       AND (c.suspect_platform ILIKE 'shopify' OR c.suspect_platform ILIKE 'woo%')
       AND (c.catalog_checked_at IS NULL OR c.catalog_checked_at < now() - interval '14 days')
     ORDER BY c.catalog_checked_at NULLS FIRST, c.suspect_seen_at DESC NULLS LAST
     LIMIT ${CONFIRM}`;
  if (!todo.length) { console.log("confirm: nothing due"); return; }
  const pool = loadProxies();
  let requests = 0, throttled = 0;
  const get = async (url, p) => { requests++; const r = await fetchText(url, { proxy: pickProxy(p), timeoutMs: 20000, maxBytes: 12_000_000 }); if (r?.status === 429) throttled++; return r; };
  console.log(`confirm: ${todo.length} tier-A candidates · ${pool.length ? `${pool.length} proxies` : "DIRECT"}`);
  const fpOf = async (domain, platform) => {
    const [row] = await sql`SELECT * FROM store_catalog_fp WHERE domain = ${domain} AND n_products > 0 AND fp_at > now() - interval '30 days'`;
    if (row) return { fp: toFp(row), cached: true };
    const r = await fetchCatalogue(domain, platform, pool, get);
    if (r.error || !r.products?.length) return { error: r.error ?? "empty catalogue" };
    const fp = buildFp(r.products);
    if (!DRY) await upsertFp(sql, domain, fp, null);   // feeds clone-sweep's universe too
    return { fp, products: r.products };
  };
  const st = { ok: 0, strong: 0, failed: 0 };
  for (const c of todo) {
    if (throttled >= 5) { console.log("! 5 × 429 — stopping; the rest wait for the next run"); break; }
    const sus = await fpOf(c.suspect, c.suspect_platform);
    const vic = sus.error ? null : await fpOf(c.brand, c.brand_platform);
    let detail, score = null, verdict = null;
    if (sus.error || vic?.error) {
      st.failed++;
      detail = { error: sus.error ? `suspect: ${sus.error}` : `brand: ${vic.error}` };
    } else {
      const r = scorePair(vic.fp, sus.fp);
      score = r.score; verdict = r.verdict; st.ok++;
      detail = { shared: r.k, copied: Math.round(r.copied * 1000) / 1000, suspect_products: sus.fp.n, brand_products: vic.fp.n, reasons: r.reasons,
        sample: (sus.products ?? []).slice(0, 8).map((p) => p.title || p.handle) };
      if (score >= 50) st.strong++;
    }
    console.log(`  ${score === null ? " — " : String(score).padStart(3)} ${c.suspect} vs ${c.brand}${detail.error ? ` · ${detail.error}` : ` · ${detail.reasons.slice(0, 2).join(", ")}`}`);
    if (!DRY) await sql`UPDATE lookalike_candidates SET catalog_score = ${score}::int, catalog_verdict = ${verdict}::text, catalog_detail = ${sql.json(detail)},
        catalog_checked_at = now(),
        evidence = CASE WHEN evidence IS NULL AND ${score ?? 0}::int >= 50 THEN ${sql.json(detail)} ELSE evidence END,
        evidence_at = CASE WHEN evidence IS NULL AND ${score ?? 0}::int >= 50 THEN now() ELSE evidence_at END
      WHERE suspect = ${c.suspect} AND brand = ${c.brand}`;
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  closeAgents();
  console.log(`confirm: ${st.ok} compared (${st.strong} share ≥50 of the brand's catalogue) · ${st.failed} unreadable · ${requests} requests · ${throttled} × 429`);
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 600000, lock_timeout: 10000 } });
  try {
    if (MIGRATE) { await ensureTable(sql); console.log("✓ lookalike_candidates ready"); return; }
    const [{ t }] = await sql`SELECT to_regclass('public.lookalike_candidates') AS t`;
    if (!t && !DRY) throw new Error("lookalike_candidates missing — run once with --migrate");
    const rows = await scan(sql);
    if (CONFIRM) await confirm(sql, t ? null : rows);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("lookalike-scan failed:", e.message); process.exit(1); });

/**
 * promo-scan — Black Friday 2026 deals lane. Reads the live promo offers of the top ZA stores so
 * tembocommerce.africa/za/black-friday can list them. Scope: ~/Documents/Test/DESIGN-black-friday-2026.md
 * (approved by Joel 2026-11-18, incl. the new store_promos / store_promo_scan tables).
 *
 * Per store, cheapest first:
 *   1. Homepage, DIRECT (own-domain HTML is worse via the datacenter fleet). Text → offers; BF links
 *      (/collections/black-friday…) straight from the page's own hrefs; Klaviyo company_id.
 *   2. Klaviyo public forms feed for that company_id — hits Klaviyo, not the store, so it costs no
 *      store budget. Live popup/flyout text → offers.
 *   3. Shopify only: /sitemap.xml → sitemap_collections_*.xml through the Webshare fleet, for BF
 *      collection URLs the homepage doesn't link to. (Sitemaps answer where products.json is refused.)
 *   4. --llm: a local model (LOCAL_LLM_URL, e.g. Ollama on Rex) writes a ≤12-word headline for BF
 *      offers. Local only — never a paid API.
 *
 * Budget: Shopify homepages share the home IP's ~1,200/day clean budget with contact-enrich
 * (which is paused 20 Nov → 1 Dec by Joel's decision). 5 refusals (429/430) in a row end the run.
 * Bot-protected stores (403 to a plain fetch) are recorded and LEFT ALONE — they reach the page by
 * merchant submission only. Never tune headers or render pages to get past them.
 *
 * --baseline marks every offer seen in this run as pre-BF, so the page can drop the all-year
 * welcome popups and standing sales. Run it once, before BF promos start (Thu 19 Nov).
 *
 *   node --env-file=.env.local scripts/promo-scan.mjs --dry --limit 20
 *   node --env-file=.env.local scripts/promo-scan.mjs --baseline [--top 1500] [--concurrency 2]
 *   node --env-file=.env.local scripts/promo-scan.mjs --domains a.co.za,b.co.za --dry
 *   node --env-file=.env.local scripts/promo-scan.mjs --llm            # daily run on Rex
 */
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { siteOf } from "./lib/catalog-fp.mjs";
import {
  htmlToText, detectOffers, findKlaviyoCid, klaviyoText, bfLinksFromHtml, bfLinksFromSitemap, collectionSitemaps,
} from "./lib/promo-detect.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const BASELINE = has("--baseline");
const LLM = has("--llm");
const TOP = Number(arg("--top", 1500));
// Non-Shopify stores past the top list (sister brands in a group, the traffic-ranked tail). Their
// homepages are their own servers, not Shopify's edge, so they cost none of the home IP's budget.
const EXTRA_OTHER = Number(arg("--extra-other", 0));
const LIMIT = Number(arg("--limit", TOP));
const CONC = Number(arg("--concurrency", 2));
const PAUSE_MS = Number(arg("--pause-ms", 1200));
const COUNTRY = arg("--country", "ZA").toUpperCase();
const DOMAINS = arg("--domains", "") ? arg("--domains", "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) : null;
const STALE_H = Number(arg("--stale-hours", 18));        // skip stores scanned more recently than this
const STREAK_STOP = 5;
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "";
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "qwen2.5:7b";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensurePromoTables(sql) {
  // to_regclass first: CREATE … IF NOT EXISTS still takes a lock, and lanes call this every run.
  const [{ a, b }] = await sql`SELECT to_regclass('public.store_promo_scan') a, to_regclass('public.store_promos') b`;
  if (!a) await sql`CREATE TABLE store_promo_scan (
    domain text PRIMARY KEY,
    platform text,
    scanned_at timestamptz NOT NULL DEFAULT now(),
    http int,
    final_host text,                        -- after redirects: pepcell.com → pepstores.com dedupe on the page
    klaviyo_cid text,
    n_offers int NOT NULL DEFAULT 0,
    baseline_at timestamptz,
    note text)`;
  if (!b) {
    await sql`CREATE TABLE store_promos (
      domain text NOT NULL,
      offer_key text NOT NULL,
      source text NOT NULL,                 -- homepage | klaviyo | sitemap | merchant
      kind text NOT NULL,                   -- bf | welcome | sale | link
      offer_text text,
      headline text,
      pct_max int, up_to boolean NOT NULL DEFAULT false, sitewide boolean NOT NULL DEFAULT false,
      rand_off int, code text, link text,
      seen_in_baseline boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'auto',  -- auto | approved | rejected | merchant_pending | removed
      submitted_by text,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (domain, offer_key))`;
    await sql`CREATE INDEX store_promos_last_seen ON store_promos (last_seen_at DESC)`;
  }
}

async function watchList(sql) {
  if (DOMAINS) {
    return sql`SELECT s.domain, lower(s.platform) platform, s.name, p.market_rank, NULL::text klaviyo_cid
                 FROM imported_stores s LEFT JOIN store_priority p ON p.domain = s.domain WHERE s.domain = ANY(${DOMAINS})`;
  }
  // Top N live, published stores by store_priority — one per store group AND per registrable site,
  // so mirror domains and www/apex duplicates count once.
  const rows = await sql`
    WITH w AS (
      SELECT s.domain, lower(s.platform) platform, s.name, p.market_rank, p.score, m.group_id,
             ps.scanned_at, ps.klaviyo_cid,
             row_number() OVER (PARTITION BY coalesce(m.group_id::text, s.domain) ORDER BY p.score DESC, s.domain) gr
        FROM imported_stores s
        JOIN store_priority p ON p.domain = s.domain
        LEFT JOIN store_group_members m ON m.domain = s.domain
        LEFT JOIN store_promo_scan ps ON ps.domain = s.domain
       WHERE s.published AND s.country = ${COUNTRY}
         AND coalesce(s.live_status, '') NOT IN ('dead', 'migrated')
         AND s.activity_tier IS DISTINCT FROM 'not_a_store'
         AND s.storefront_http IS DISTINCT FROM 402
         AND s.password_protected IS NOT TRUE
         AND s.domain NOT LIKE '%.myshopify.com'
         AND s.domain !~ '^(account|accounts|mail|webmail|cpanel|shop-admin|admin|login|portal)\\.'
    )
    SELECT * FROM w WHERE gr = 1 ORDER BY market_rank NULLS LAST, score DESC LIMIT ${TOP * 2}`;
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const site = siteOf(r.domain);
    if (seen.has(site)) continue;
    seen.add(site);
    out.push(r);
    if (out.length >= TOP) break;
  }
  if (EXTRA_OTHER > 0) {
    const have = new Set(out.map((r) => r.domain));
    const extra = await sql`
      SELECT s.domain, lower(s.platform) platform, s.name, p.market_rank, ps.scanned_at, ps.klaviyo_cid
        FROM imported_stores s
        LEFT JOIN store_priority p ON p.domain = s.domain
        LEFT JOIN store_promo_scan ps ON ps.domain = s.domain
       WHERE s.published AND s.country = ${COUNTRY} AND lower(coalesce(s.platform, '')) <> 'shopify'
         AND coalesce(s.live_status, '') NOT IN ('dead', 'migrated')
         AND s.activity_tier IS DISTINCT FROM 'not_a_store' AND s.storefront_http IS DISTINCT FROM 402
         AND s.password_protected IS NOT TRUE
         AND s.domain !~ '^(account|accounts|mail|webmail|cpanel|shop-admin|admin|login|portal|payments?|app|archive[0-9]*|ipaper|staging|dev|test)\.'
         AND (p.market_rank <= ${TOP} OR s.crux_rank <= 50000)
       ORDER BY s.crux_rank NULLS LAST, p.market_rank NULLS LAST
       LIMIT ${EXTRA_OTHER * 2}`;
    const sites = new Set(out.map((r) => siteOf(r.domain)));
    let n = 0;
    for (const r of extra) {
      if (n >= EXTRA_OTHER) break;
      if (have.has(r.domain) || sites.has(siteOf(r.domain))) continue;
      sites.add(siteOf(r.domain)); out.push(r); n++;
    }
  }
  const cutoff = Date.now() - STALE_H * 3600e3;
  return out.filter((r) => BASELINE || !r.scanned_at || new Date(r.scanned_at).getTime() < cutoff).slice(0, LIMIT);
}

async function klaviyoOffers(cid) {
  try {
    const r = await fetch(`https://fast.a.klaviyo.com/forms/api/v7/full-forms?company_id=${cid}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const j = await r.json();
    // Stores run many near-identical forms (one per page/segment/A-B arm): keep one per offer shape.
    const out = new Map();
    for (const f of j.full_forms || []) {
      for (const v of f.live_form_versions || []) {
        const text = klaviyoText(v.views).slice(0, 4000);
        for (const o of detectOffers(text, { maxOffers: 2 })) {
          const key = `klaviyo:${o.key}`;
          if (!out.has(key)) out.set(key, { ...o, key });
        }
      }
    }
    return [...out.values()].sort((x, y) => (y.kind === "bf") - (x.kind === "bf")).slice(0, 3);
  } catch { return []; }
}

async function sitemapLinks(origin, pool) {
  const idx = await fetchText(`${origin}/sitemap.xml`, { proxy: pickProxy(pool), timeoutMs: 12000, maxBytes: 300_000 });
  if (!idx || idx.status !== 200) return [];
  const links = [];
  for (const sm of collectionSitemaps(idx.text).slice(0, 2)) {
    const x = await fetchText(sm, { proxy: pickProxy(pool), timeoutMs: 12000, maxBytes: 600_000 });
    if (x?.status === 200) links.push(...bfLinksFromSitemap(x.text));
  }
  return links;
}

async function headline(o, storeName) {
  if (!LLM || !LOCAL_LLM_URL || o.kind !== "bf") return null;
  try {
    const res = await fetch(`${LOCAL_LLM_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: LOCAL_LLM_MODEL, temperature: 0, max_tokens: 40,
        messages: [
          { role: "system", content: "You write one short deal headline (max 12 words) from text scraped off a store's homepage. Use only facts in the text: discount, what it applies to, dates, code. No hype words, no emoji, no store name. If the text has no concrete Black Friday or Cyber Monday offer, reply exactly NONE." },
          { role: "user", content: `Store: ${storeName || "?"}\nText: ${o.offer_text}` },
        ],
      }),
    });
    const j = await res.json();
    const h = j.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "");
    return h && h !== "NONE" && h.length <= 120 ? h : null;
  } catch { return null; }
}

async function scanOne(store, pool) {
  const origin = `https://${store.domain}`;
  const page = await fetchText(origin + "/", { timeoutMs: 15000, maxBytes: 1_500_000 });
  let finalHost = null;
  try { finalHost = page?.url ? new URL(page.url).hostname.replace(/^www\./, "") : null; } catch { /* keep null */ }
  const res = { http: page?.status ?? null, finalHost, offers: [], links: [], cid: store.klaviyo_cid || null, refused: false, note: null };
  if (!page) { res.note = "unreachable"; return res; }
  if (page.status === 429 || page.status === 430) { res.refused = true; res.note = "rate-limited"; return res; }
  if (page.status === 402) { res.note = "frozen"; return res; }
  if (page.status === 403 || page.status === 503) { res.note = "bot-protected: submission only"; return res; }
  if (page.status !== 200) { res.note = `http ${page.status}`; return res; }

  const html = page.text;
  const text = htmlToText(html);
  res.offers.push(...detectOffers(text).map((o) => ({ ...o, source: "homepage", key: `home:${o.key}` })));
  res.links.push(...bfLinksFromHtml(html, page.url || origin));
  res.cid = findKlaviyoCid(html) || res.cid;
  if (res.cid) res.offers.push(...(await klaviyoOffers(res.cid)).map((o) => ({ ...o, source: "klaviyo" })));
  if (store.platform === "shopify" && !res.links.length && pool.length) {
    res.links.push(...(await sitemapLinks(new URL(page.url || origin).origin, pool)));
  }
  for (const o of res.offers) o.headline = await headline(o, store.name);
  return res;
}

async function save(sql, store, r) {
  const link = r.links[0] ?? null;
  const rows = r.offers.map((o) => ({
    domain: store.domain, offer_key: o.key, source: o.source, kind: o.kind, offer_text: o.offer_text?.slice(0, 600) ?? null,
    headline: o.headline ?? null, pct_max: o.pct_max, up_to: o.up_to, sitewide: o.sitewide, rand_off: o.rand_off,
    code: o.code, link, seen_in_baseline: BASELINE,
  }));
  // A BF landing page with no readable offer text is still a signal ("Black Friday sale on").
  if (link && !rows.some((x) => x.kind === "bf")) {
    rows.push({ domain: store.domain, offer_key: "link:bf", source: r.links.length && r.offers.length === 0 ? "sitemap" : "homepage",
      kind: "link", offer_text: null, headline: null, pct_max: null, up_to: false, sitewide: false, rand_off: null, code: null, link,
      seen_in_baseline: BASELINE });
  }
  await sql.begin(async (tx) => {
    if (rows.length) {
      await tx`INSERT INTO store_promos ${tx(rows)}
        ON CONFLICT (domain, offer_key) DO UPDATE SET
          offer_text = EXCLUDED.offer_text, headline = coalesce(EXCLUDED.headline, store_promos.headline),
          pct_max = EXCLUDED.pct_max, up_to = EXCLUDED.up_to, sitewide = EXCLUDED.sitewide, rand_off = EXCLUDED.rand_off,
          code = EXCLUDED.code, link = coalesce(EXCLUDED.link, store_promos.link), last_seen_at = now(),
          seen_in_baseline = store_promos.seen_in_baseline OR EXCLUDED.seen_in_baseline`;
    }
    await tx`INSERT INTO store_promo_scan (domain, platform, scanned_at, http, final_host, klaviyo_cid, n_offers, baseline_at, note)
      VALUES (${store.domain}, ${store.platform}, now(), ${r.http}, ${r.finalHost}, ${r.cid}, ${rows.length}, ${BASELINE ? new Date() : null}, ${r.note})
      ON CONFLICT (domain) DO UPDATE SET platform = EXCLUDED.platform, scanned_at = now(), http = EXCLUDED.http,
        final_host = coalesce(EXCLUDED.final_host, store_promo_scan.final_host),
        klaviyo_cid = coalesce(EXCLUDED.klaviyo_cid, store_promo_scan.klaviyo_cid), n_offers = EXCLUDED.n_offers,
        baseline_at = coalesce(EXCLUDED.baseline_at, store_promo_scan.baseline_at), note = EXCLUDED.note`;
  });
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 60000, lock_timeout: 10000 } });
  const pool = loadProxies();
  const t0 = Date.now();
  const stats = { scanned: 0, withOffer: 0, bf: 0, links: 0, klaviyo: 0, refused: 0, botProtected: 0, unreachable: 0 };
  let streak = 0, stop = false;
  try {
    // A dry run never creates tables; before the first real run, it reads the list without scan state.
    if (!DRY) await ensurePromoTables(sql);
    const [{ t: haveScan }] = await sql`SELECT to_regclass('public.store_promo_scan') t`;
    const stores = haveScan ? await watchList(sql) : await watchListNoScan(sql);
    console.log(`promo-scan ${COUNTRY}: ${stores.length} stores · concurrency ${CONC} · ${PAUSE_MS}ms pause · sitemaps via ${pool.length ? `${pool.length} proxies` : "— (no proxy file, skipped)"}${BASELINE ? " · BASELINE" : ""}${LLM ? ` · llm ${LOCAL_LLM_URL ? LOCAL_LLM_MODEL : "OFF (no LOCAL_LLM_URL)"}` : ""}${DRY ? " · DRY" : ""}`);
    let i = 0;
    const worker = async () => {
      while (!stop && i < stores.length) {
        const s = stores[i++];
        const r = await scanOne(s, pool);
        stats.scanned++;
        if (r.refused) { stats.refused++; if (s.platform === "shopify" && ++streak >= STREAK_STOP) { stop = true; console.log(`!! ${STREAK_STOP} refusals in a row — stopping`); } }
        else streak = 0;
        if (r.note?.startsWith("bot-protected")) stats.botProtected++;
        if (r.note === "unreachable") stats.unreachable++;
        if (r.offers.length || r.links.length) stats.withOffer++;
        if (r.offers.some((o) => o.kind === "bf")) stats.bf++;
        if (r.links.length) stats.links++;
        if (r.offers.some((o) => o.source === "klaviyo")) stats.klaviyo++;
        if (DRY) {
          const top = r.offers[0];
          console.log(`${String(s.market_rank ?? "-").padStart(5)} ${s.domain.padEnd(36)} ${String(r.http ?? "-").padEnd(4)} ${(r.note || "").padEnd(14)} ${r.offers.length ? r.offers.map((o) => `${o.kind}/${o.source}${o.pct_max ? `/${o.up_to ? "≤" : ""}${o.pct_max}%` : ""}`).join(",") : ""}${r.links.length ? ` link:${r.links[0]}` : ""}`);
          if (top) console.log(`        └ ${(top.headline || top.offer_text).slice(0, 160)}`);
        } else if (!r.refused) {
          await save(sql, s, r);
        }
        if (stats.scanned % 100 === 0) console.log(`  … ${stats.scanned}/${stores.length} · ${stats.bf} BF · ${stats.withOffer} any · ${stats.refused} refused · ${Math.round((Date.now() - t0) / 60000)}m`);
        await sleep(PAUSE_MS);
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    const pct = (n) => stats.scanned ? `${Math.round((100 * n) / stats.scanned)}%` : "0%";
    console.log(`promo-scan done in ${Math.round((Date.now() - t0) / 60000)}m: ${stats.scanned} scanned · BF offer ${stats.bf} (${pct(stats.bf)}) · any offer/link ${stats.withOffer} (${pct(stats.withOffer)}) · BF links ${stats.links} · via Klaviyo ${stats.klaviyo} · bot-protected ${stats.botProtected} · unreachable ${stats.unreachable} · rate-limited ${stats.refused} (${pct(stats.refused)})`);
    if (stats.refused / Math.max(1, stats.scanned) > 0.1) console.log("!! rate-limited above 10% — slow down or shrink --top");
  } finally {
    closeAgents();
    await sql.end({ timeout: 5 });
  }
}

// Dry runs before the tables exist: same list, no scan-state join.
async function watchListNoScan(sql) {
  const rows = await sql`
    WITH w AS (
      SELECT s.domain, lower(s.platform) platform, s.name, p.market_rank, p.score, NULL::text klaviyo_cid,
             row_number() OVER (PARTITION BY coalesce(m.group_id::text, s.domain) ORDER BY p.score DESC, s.domain) gr
        FROM imported_stores s JOIN store_priority p ON p.domain = s.domain
        LEFT JOIN store_group_members m ON m.domain = s.domain
       WHERE s.published AND s.country = ${COUNTRY} AND coalesce(s.live_status, '') NOT IN ('dead', 'migrated')
         AND s.activity_tier IS DISTINCT FROM 'not_a_store' AND s.storefront_http IS DISTINCT FROM 402
         AND s.password_protected IS NOT TRUE AND s.domain NOT LIKE '%.myshopify.com'
         AND s.domain !~ '^(account|accounts|mail|webmail|cpanel|shop-admin|admin|login|portal)\\.'
         ${DOMAINS ? sql`AND s.domain = ANY(${DOMAINS})` : sql``})
    SELECT * FROM w WHERE gr = 1 ORDER BY market_rank NULLS LAST, score DESC LIMIT ${TOP * 2}`;
  const seen = new Set();
  return rows.filter((r) => { const s = siteOf(r.domain); if (seen.has(s)) return false; seen.add(s); return true; }).slice(0, LIMIT);
}

main().catch((e) => { console.error(e); process.exit(1); });

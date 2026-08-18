#!/usr/bin/env node
/**
 * Production AI enrichment: synthesise a category + one-line description for
 * stores that lack them (primarily newly-discovered stores that came in without
 * StoreLeads' rich fields), and fill socials/contact the site exposes for free.
 *
 *   node --env-file=.env.local scripts/ai-enrich.mjs               # next 200 by value
 *   node --env-file=.env.local scripts/ai-enrich.mjs --limit 50
 *   node --env-file=.env.local scripts/ai-enrich.mjs --all         # everything unenriched
 *   node --env-file=.env.local scripts/ai-enrich.mjs --dry         # gather only, no AI, no writes
 *
 * Design notes:
 *  - Resumable: sets ai_enriched_at once processed, so a store is never
 *    re-fetched or re-charged on a later run (even low-info stores get stamped).
 *  - Never clobbers existing data: every write is COALESCE(existing, new), so
 *    StoreLeads categories/descriptions and manual corrections survive.
 *  - Cheap model (Haiku) — ~$0.001/store. Website fetch is free; only the
 *    category+description step costs anything, and we skip it for empty stores.
 */

import postgres from "postgres";

const MODEL = "claude-haiku-4-5-20251001";
const DRY = process.argv.includes("--dry");
const ALL = process.argv.includes("--all");
const limArg = process.argv.indexOf("--limit");
const LIMIT = ALL ? null : limArg > -1 ? Number(process.argv[limArg + 1]) : 200;
const CONCURRENCY = 5;

const TAXONOMY = [
  "Apparel", "Home & Garden", "Beauty & Fitness", "Food & Drink", "Sports",
  "Health", "Electronics", "Computers", "Business & Industrial", "Toys & Games",
  "Arts & Entertainment", "Jewellery & Accessories", "Pets", "Automotive",
  "Books & Media", "Baby & Kids", "Office", "Travel & Outdoor", "Other",
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const clean = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

async function get(url, ms = 8000) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
    return r.ok ? r : null;
  } catch { return null; }
}

const SOCIALS = {
  instagram: /(?:instagram\.com)\/([A-Za-z0-9_.]+)/i,
  facebook: /(?:facebook\.com)\/([A-Za-z0-9_.\-]+)/i,
  tiktok: /tiktok\.com\/@([A-Za-z0-9_.]+)/i,
};
const JUNK = new Set(["sharer", "share", "intent", "tr", "plugins", "channel", "watch",
  "embed", "user", "c", "results", "hashtag", "p", "pin", "policy", "help"]);

function extractSocials(html) {
  const out = {};
  for (const [net, re] of Object.entries(SOCIALS)) {
    const m = html.match(re);
    if (m && m[1] && !JUNK.has(m[1].toLowerCase().split("/")[0])) out[net] = m[1];
  }
  return out;
}

// Placeholder / template emails that leak into theme markup — never real contacts.
const EMAIL_JUNK = /(sentry|wixpress|example\.|godaddy|shopify\.com|fakedomain|yourdomain|your@|youremail|email@|no-?reply|donotreply|placeholder|test@|sample@|domain\.com)/i;

function firstRealEmail(html) {
  for (const m of html.matchAll(/mailto:([^"'?]+)/gi)) {
    const e = m[1].trim().toLowerCase();
    if (!EMAIL_JUNK.test(e) && !/\.(png|jpe?g|gif|svg|webp)$/.test(e)) return e;
  }
  for (const m of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = m[0].toLowerCase();
    if (!EMAIL_JUNK.test(e) && !/\.(png|jpe?g|gif|svg|webp)$/.test(e)) return e;
  }
  return null;
}

async function gather(domain) {
  const d = clean(domain);
  const pj = await get(`https://${d}/products.json?limit=250`);
  let types = new Set(), titles = [], nProducts = 0;
  if (pj) {
    try {
      const items = (await pj.json()).products || [];
      nProducts = items.length;
      for (const p of items) {
        if (p.product_type) types.add(p.product_type);
        if (p.title && titles.length < 8) titles.push(p.title);
      }
    } catch { /* ignore */ }
  }
  const home = await get(`https://${d}`);
  let title = "", metaDesc = "", socials = {}, email = null;
  if (home) {
    const html = await home.text().catch(() => "");
    title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").trim().slice(0, 160);
    metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1]
      || "").trim().slice(0, 300);
    socials = extractSocials(html);
    email = firstRealEmail(html);
  }
  return { domain: d, title, metaDesc, types: [...types].slice(0, 10), titles, nProducts, socials, email };
}

// Nothing to classify from: no catalogue and no descriptive copy. Skip the AI
// call (save money, avoid guessed categories) but still record socials/email.
const lowInfo = (g) => g.nProducts === 0 && !g.metaDesc && !g.title;

function buildPrompt(g) {
  return `Store: ${g.domain}
Title: ${g.title || "(none)"}
Meta description: ${g.metaDesc || "(none)"}
Product types: ${g.types.join(", ") || "(none)"}
Sample products: ${g.titles.join(", ") || "(none)"}

Classify this store into exactly one category from this list:
${TAXONOMY.join(", ")}

Then write a single concise sentence (max 18 words) describing what the store sells, in a neutral factual tone.
Respond with ONLY minified JSON: {"category":"...","description":"..."}`;
}

async function askClaude(g) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: "user", content: buildPrompt(g) }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text);
  // Only accept a category that's actually in our taxonomy.
  const category = TAXONOMY.includes(parsed.category) ? parsed.category : null;
  const description = typeof parsed.description === "string" ? parsed.description.slice(0, 200) : null;
  return { category, description };
}

async function processStore(sql, row) {
  const g = await gather(row.domain);
  let category = null, description = null;
  if (!DRY && !lowInfo(g)) {
    try { ({ category, description } = await askClaude(g)); }
    catch (e) { console.log(`  ! ${g.domain}: AI failed (${e.message})`); }
  }
  if (DRY) {
    console.log(`● ${g.domain}  [${g.nProducts}p]  ${g.metaDesc ? "meta✓" : "meta✗"}  socials:${Object.keys(g.socials).length}  ${lowInfo(g) ? "LOW-INFO (would skip AI)" : ""}`);
    return { ai: 0 };
  }
  await sql`
    UPDATE imported_stores SET
      category    = COALESCE(category, ${category}),
      description = COALESCE(description, ${description}),
      instagram   = COALESCE(instagram, ${g.socials.instagram ?? null}),
      facebook    = COALESCE(facebook, ${g.socials.facebook ?? null}),
      tiktok      = COALESCE(tiktok, ${g.socials.tiktok ?? null}),
      email       = COALESCE(email, ${g.email}),
      ai_enriched_at = now()
    WHERE domain = ${row.domain}`;
  const tag = category ? `${category}` : lowInfo(g) ? "low-info→skipped" : "no-category";
  console.log(`✓ ${g.domain}  →  ${tag}${description ? `  · "${description.slice(0, 60)}"` : ""}`);
  return { ai: category ? 1 : 0 };
}

async function main() {
  if (!DRY && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — add it to .env.local, or run with --dry.");
    process.exit(2);
  }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: CONCURRENCY + 1 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ai_enriched_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE published
        AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
        AND ai_enriched_at IS NULL
        AND (category IS NULL OR description IS NULL)
      ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC
      ${LIMIT ? sql`LIMIT ${LIMIT}` : sql``}`;

    if (!rows.length) { console.log("Nothing to enrich — all live stores already have category + description."); return; }
    console.log(`Enriching ${rows.length} store(s)${DRY ? " [DRY]" : ""} at concurrency ${CONCURRENCY}…\n`);

    let done = 0, aiCount = 0;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((r) => processStore(sql, r).catch((e) => {
        console.log(`  ! ${r.domain}: ${e.message}`); return { ai: 0 };
      })));
      done += batch.length;
      aiCount += results.reduce((s, r) => s + r.ai, 0);
      if (done % 25 === 0 || done === rows.length) console.log(`— ${done}/${rows.length} (${aiCount} categorised)`);
    }
    console.log(`\nDone. ${done} processed, ${aiCount} categorised via AI.`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

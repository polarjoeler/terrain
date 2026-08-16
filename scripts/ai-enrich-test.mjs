#!/usr/bin/env node
/**
 * Test: AI category + description enrichment for stores.
 *
 *   node --env-file=.env.local scripts/ai-enrich-test.mjs            # picks sample live stores
 *   node --env-file=.env.local scripts/ai-enrich-test.mjs mystore.co.za other.co.za
 *   node --env-file=.env.local scripts/ai-enrich-test.mjs --dry      # show inputs only, no AI call
 *
 * For each store: gather the raw material the model sees (title, meta
 * description, product types/titles from products.json), then ask Claude for a
 * clean category (from our taxonomy) + a one-line description. Prints the AI
 * output next to the store's existing StoreLeads category, to compare.
 */

import postgres from "postgres";

const MODEL = "claude-haiku-4-5-20251001"; // fast + cheap for classification at scale
const DRY = process.argv.includes("--dry");
const argDomains = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// Our category taxonomy (mirrors the imported StoreLeads top-level set).
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

/** Gather the raw signals the model will reason over. */
async function gather(domain) {
  const d = clean(domain);
  const pj = await get(`https://${d}/products.json?limit=15`);
  let types = new Set(), titles = [];
  if (pj) {
    try {
      const items = (await pj.json()).products || [];
      for (const p of items) {
        if (p.product_type) types.add(p.product_type);
        if (p.title && titles.length < 8) titles.push(p.title);
      }
    } catch { /* ignore */ }
  }
  const home = await get(`https://${d}`);
  let title = "", metaDesc = "";
  if (home) {
    const html = await home.text().catch(() => "");
    title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").trim().slice(0, 160);
    metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1]
      || "").trim().slice(0, 300);
  }
  return { domain: d, title, metaDesc, types: [...types].slice(0, 10), titles };
}

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
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: "user", content: buildPrompt(g) }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text); }
  catch { return { category: "?", description: text.slice(0, 120) }; }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  let targets;
  try {
    if (argDomains.length) {
      const rows = await sql`SELECT domain, category FROM imported_stores WHERE domain = ANY(${argDomains.map(clean)})`;
      targets = argDomains.map((d) => ({ domain: clean(d), category: rows.find((r) => r.domain === clean(d))?.category ?? null }));
    } else {
      targets = await sql`
        SELECT domain, category FROM imported_stores
        WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        ORDER BY random() LIMIT 8`;
    }
  } finally { await sql.end(); }

  if (!DRY && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — add it to .env.local, or run with --dry to see the inputs.");
    process.exit(2);
  }

  for (const t of targets) {
    const g = await gather(t.domain);
    if (DRY) {
      console.log(`\n● ${g.domain}   [StoreLeads: ${t.category ?? "—"}]`);
      console.log(`  title:  ${g.title || "—"}`);
      console.log(`  meta:   ${g.metaDesc || "—"}`);
      console.log(`  types:  ${g.types.join(", ") || "—"}`);
      continue;
    }
    try {
      const ai = await askClaude(g);
      console.log(`\n● ${g.domain}`);
      console.log(`  StoreLeads category: ${t.category ?? "—"}`);
      console.log(`  AI category:         ${ai.category}`);
      console.log(`  AI description:      ${ai.description}`);
    } catch (e) {
      console.log(`\n● ${g.domain} — AI failed: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

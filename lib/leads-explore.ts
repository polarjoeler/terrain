/** Data layer for the leads Explorer — a StoreInspect-style faceted browser.
 *  Loads every live, published lead with the fields the explorer shows plus a
 *  computed Lead Fit Score, so the client can facet/sort/search instantly. */

import postgres from "postgres";

// Markets surfaced to customers (see lib/markets.ts VISIBLE_MARKETS — kept in sync).
// Inlined here rather than imported so the standalone snapshot-refresh script (Node
// --experimental-strip-types) doesn't choke on a relative .ts import.
const VISIBLE_MARKETS = ["ZA", "KE", "NG"] as const;

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

export type ExploreLead = {
  domain: string;
  name: string | null;
  category: string | null;
  country: string | null;
  city: string | null;
  theme: string | null;
  platform: string | null;
  payments: string | null;            // semicolon-separated verified gateways
  shippingProviders: string | null;   // semicolon-separated carriers/apps
  apps: string | null;                // semicolon-separated installed apps
  productCount: number | null;        // captured from /products.json
  aovUsd: number | null;              // avg product price, USD-normalized
  estMonthlySales: number | null;
  plus: boolean;
  top100: boolean;               // curated Top 100 (by sales)
  top500: boolean;               // curated Top 500 (by sales)
  email: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  discoveredAt: string | null;   // ISO date we first tracked the store — powers the recency filter
  score: number;         // 0–100 Lead Fit Score
};

// Apps are stored as raw Shopify app-store URLs (some concatenated). Extract the
// slug of each PUBLIC app — which drops custom/private apps (they have no app-store
// URL) — and render a clean name. Aliases tidy the most common ones.
const APP_ALIAS: Record<string, string> = {
  inbox: "Shopify Inbox", "product-reviews": "Shopify Reviews", geolocation: "Shopify Geolocation",
  judgeme: "Judge.me", "klaviyo-email-marketing": "Klaviyo", "customer-privacy-banner": "Privacy Banner",
  "whatsapp-chat-for-support": "WhatsApp Chat", instafeed: "Instafeed", pagefly: "PageFly",
  omnisend: "Omnisend", mailchimp: "Mailchimp",
};
const APP_SKIP = new Set(["partners", "collections", "browse", "categories", "stores"]); // app-store links, not installed apps
function cleanApps(raw: string | null): string | null {
  if (!raw) return null;
  const slugs = [...raw.matchAll(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase()).filter((s) => !APP_SKIP.has(s));
  if (!slugs.length) return null; // only custom/private apps → nothing public to show
  const names = [...new Set(slugs)].map((s) => APP_ALIAS[s] ?? s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
  return names.join(";");
}

// The imported estimated_monthly_sales is in each store's LOCAL currency, so we
// normalise to USD before banding/scoring — otherwise ZAR/NGN/KES are compared
// as if they were dollars. Rough static rates (fine for banding, not accounting).
const FX: Record<string, number> = { USD: 1, ZAR: 0.054, NGN: 0.00065, KES: 0.0077, GBP: 1.27, EUR: 1.08, AUD: 0.66, CAD: 0.73 };
const CCY_BY_COUNTRY: Record<string, string> = { ZA: "ZAR", NG: "NGN", KE: "KES", US: "USD", GB: "GBP" };
function toUsd(sales: number | null, currency: string | null, country: string | null): number | null {
  if (sales == null) return null;
  const ccy = currency || CCY_BY_COUNTRY[(country ?? "").toUpperCase()] || "USD";
  return Math.round(sales * (FX[ccy] ?? 1));
}

/** Transparent 0–100 fit score from the signals we trust: revenue (value),
 *  a reachable email, Shopify Plus, social reach, and recency of discovery. */
function scoreLead(sales: number, email: boolean, plus: boolean, social: number, discoveredAt: Date | null, catalog: number, aovUsd: number): number {
  let score = 0;
  score += Math.min(38, Math.round((Math.log10(sales + 1) / 7) * 38));      // revenue → up to 38
  if (email) score += 18;                                                     // contactable
  if (plus) score += 12;                                                      // enterprise
  score += Math.min(10, Math.round((Math.log10(social + 1) / 6) * 10));      // social reach
  score += Math.min(9, Math.round((Math.log10(catalog + 1) / 2.6) * 9));     // catalog depth (established)
  if (aovUsd >= 100) score += 8; else if (aovUsd >= 30) score += 4;          // higher-value baskets
  if (discoveredAt && (Date.now() - new Date(discoveredAt).getTime()) <= 30 * 864e5) score += 7; // fresh
  return Math.max(1, Math.min(100, score));
}

// Load the whole live set so every lead is browsable + enrichment shows on all of
// them — not just the top slice. The client ships every row for instant faceting;
// ~13k rows (~3.8MB) parses/facets fine, and only `shown` (60) render at a time.
// The 20k ceiling is a guardrail against unbounded growth, not the working size.
export async function exploreLeads(limit = 20000): Promise<ExploreLead[]> {
  return loadExploreLeads(limit);
}

async function loadExploreLeads(limit = 20000): Promise<ExploreLead[]> {
  const rows = await db()<{
    domain: string; name: string | null; category: string | null; country: string | null; city: string | null;
    theme: string | null; platform: string | null; payments: string | null; shipping_providers: string | null; apps: string | null;
    product_count: number | null; avg_product_price: string | null;
    estimated_monthly_sales: string | null; currency: string | null; plus: boolean; email: string | null;
    instagram: string | null; facebook: string | null; tiktok: string | null;
    instagram_followers: number | null; facebook_followers: number | null; discovered_at: Date | null;
    top100: boolean; top500: boolean;
  }[]>`
    SELECT domain, name, category, country, city, theme, platform, payments, shipping_providers, apps,
           product_count, avg_product_price, estimated_monthly_sales, currency, plus, email,
           instagram, facebook, tiktok, instagram_followers, facebook_followers, discovered_at,
           (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-100')) AS top100,
           (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-500')) AS top500
    FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND country = ANY(${[...VISIBLE_MARKETS]})
    ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC
    LIMIT ${limit}`;

  return rows.map((r) => {
    const sales = toUsd(r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null, r.currency, r.country);
    const aov = toUsd(r.avg_product_price != null ? Number(r.avg_product_price) : null, r.currency, r.country);
    const social = (r.instagram_followers ?? 0) + (r.facebook_followers ?? 0);
    return {
      domain: r.domain, name: r.name, category: r.category, country: r.country, city: r.city,
      theme: r.theme, platform: r.platform, payments: r.payments, shippingProviders: r.shipping_providers, apps: cleanApps(r.apps),
      productCount: r.product_count, aovUsd: aov,
      estMonthlySales: sales, plus: r.plus, top100: r.top100, top500: r.top500, email: r.email,
      instagram: r.instagram, facebook: r.facebook, tiktok: r.tiktok,
      discoveredAt: r.discovered_at ? new Date(r.discovered_at).toISOString().slice(0, 10) : null,
      score: scoreLead(sales ?? 0, !!r.email, r.plus, social, r.discovered_at, r.product_count ?? 0, aov ?? 0),
    };
  });
}

/** Total live, published leads — so the UI can show the real count even when the
 *  explorer only loads the top slice for speed. */
export async function exploreLeadCount(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT COUNT(*)::int n FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND country = ANY(${[...VISIBLE_MARKETS]})`;
  return Number(r.n);
}

// The browse dataset is identical for every viewer and changes slowly (enrichment
// trickles in), yet marshaling ~13k wide rows on the request path is ~2.8s and, under
// concurrent DB load from the enrichment jobs, blew past the statement timeout and
// broke the dashboard. So we PRECOMPUTE it into a single jsonb snapshot row: the
// request path reads one row (~0.2s — one 7MB value parsed once, not 13k×22 fields),
// and never runs the heavy query live. A warm in-process cache sits in front so we
// don't even re-read the blob each request; an in-flight guard collapses stampedes.
type Browse = { leads: ExploreLead[]; count: number };
const BROWSE_TTL_MS = 5 * 60 * 1000;
let _browse: { at: number; data: Browse } | null = null;
let _browseInflight: Promise<Browse> | null = null;

async function ensureSnapshotTable() {
  await db()`CREATE TABLE IF NOT EXISTS browse_snapshot (
    id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data jsonb NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now()
  )`;
}

/** Recompute the browse snapshot and persist it. Run OFF the request path — from the
 *  pipeline after enrichment — so live reads never touch the heavy query. */
export async function refreshBrowseSnapshot(): Promise<number> {
  const [leads, count] = await Promise.all([loadExploreLeads(), exploreLeadCount()]);
  const data: Browse = { leads, count };
  await ensureSnapshotTable();
  // Pass the payload as a text param cast to jsonb — avoids sql.json()'s narrow
  // JSONValue typing while storing identical jsonb.
  await db()`INSERT INTO browse_snapshot (id, data, computed_at)
             VALUES (1, ${JSON.stringify(data)}::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`;
  _browse = { at: Date.now(), data };   // warm this instance too
  return leads.length;
}

async function readSnapshot(): Promise<Browse | null> {
  try {
    await ensureSnapshotTable();
    const [row] = await db()<{ data: Browse }[]>`SELECT data FROM browse_snapshot WHERE id = 1`;
    return row?.data ?? null;
  } catch {
    return null;
  }
}

export async function exploreBrowse(): Promise<Browse> {
  if (_browse && Date.now() - _browse.at < BROWSE_TTL_MS) return _browse.data;
  if (!_browseInflight) {
    _browseInflight = (async () => {
      // Prefer the precomputed snapshot (one light row read).
      let data = await readSnapshot();
      // Cold start with no snapshot yet: compute + persist once (the pipeline keeps
      // it fresh thereafter). Under heavy enrichment load this is the only path that
      // can be slow — and only until the first snapshot lands.
      if (!data || !data.leads?.length) data = await (async () => {
        await refreshBrowseSnapshot();
        return _browse!.data;
      })();
      _browse = { at: Date.now(), data };
      return data;
    })().finally(() => { _browseInflight = null; });
  }
  return _browseInflight;
}

/** Brand index — which brands each store sells, from products.json `vendor` (store_vendors, written
 *  by scripts/catalog-enrich.mjs on every catalogue it reads). Three uses:
 *   - a store's drawer: the brands it carries;
 *   - a brand's page: every store carrying it, which one looks official, which are its stockists;
 *   - impersonation: a store that mostly sells brand X, uses X's name, and isn't X's own site —
 *     the Burnt Studios clone pattern (memory: brand-abuse-monitoring).
 *  The table fills as catalogue reads succeed; it starts sparse and grows with the lane. */

import { db } from "./db";
import { VISIBLE_MARKETS } from "./markets";

export type StoreBrand = { key: string; vendor: string; products: number };

export type BrandSummary = { key: string; vendor: string; stores: number; products: number };

export type BrandStore = {
  domain: string; name: string | null; country: string | null; platform: string | null;
  /** Products under this brand, and the store's whole catalogue. */
  products: number; catalogue: number | null;
  /** Brand products / catalogue — 1.0 = a single-brand store. */
  share: number;
  /** The site's name or domain spells the brand. */
  namesBrand: boolean;
  role: "official" | "impersonation" | "stockist";
  groupId: string | null;
};

export type BrandDetail = { key: string; vendor: string; stores: BrandStore[]; official: BrandStore | null };

/** Vendor values that are not a brand. Placeholders are what a theme or importer writes when nobody
 *  filled the field in (Shopify's "My Store" becomes "mysite"); suppliers are print-on-demand and
 *  dropship sources the vendor field names instead of the brand. Placeholders are hidden everywhere;
 *  suppliers are hidden from the brand list only, since "uses Printify" is still true of a store. */
export const PLACEHOLDER_VENDORS = ["not specified", "default", "default vendor", "mysite", "my store", "vendor", "unknown",
  "n a", "na", "none", "no brand", "generic", "other", "brand", "test", "shopify"];
export const SUPPLIER_VENDORS = ["printify", "printful", "eprolo", "cj dropshipping", "cjdropshipping", "spocket", "zendrop",
  "aliexpress", "gelato", "teelaunch", "dsers", "gooten", "customcat"];

/** Store names arrive HTML-escaped from WordPress titles ("Shoes &amp; Slides", "&#8211;"). */
export function cleanName(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

const site = (d: string) => d.replace(/^www\./, "");
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** "steve madden" is spelled by stevemaddenshoes.co.za and by a store named "Steve Madden SA". */
const spells = (key: string, domain: string, name: string | null) => {
  const k = compact(key);
  if (k.length < 4) return false;   // "h and m", "sa" — too short to read anything into
  return compact(site(domain).split(".")[0]).includes(k) || compact(name ?? "").includes(k);
};

export async function getStoreBrands(domain: string, limit = 8): Promise<{ brands: StoreBrand[]; total: number }> {
  const rows = await db()<{ vendor_key: string; vendor: string; n_products: number; total: number }[]>`
    SELECT vendor_key, vendor, n_products, count(*) OVER ()::int AS total
    FROM store_vendors WHERE domain = ${domain.trim().toLowerCase()}
      AND vendor_key <> ALL(${PLACEHOLDER_VENDORS})
    ORDER BY n_products DESC, vendor_key LIMIT ${limit}`;
  return {
    brands: rows.map((r) => ({ key: r.vendor_key, vendor: r.vendor, products: Number(r.n_products) })),
    total: rows[0]?.total ?? 0,
  };
}

/** Brands by how many stores carry them (one per site). `q` matches the brand key. */
export async function listBrands(q?: string, limit = 60): Promise<BrandSummary[]> {
  const sql = db();
  const rows = await sql<{ vendor_key: string; vendor: string; stores: number; products: number }[]>`
    SELECT v.vendor_key, mode() WITHIN GROUP (ORDER BY v.vendor) AS vendor,
           count(DISTINCT regexp_replace(v.domain, '^www\\.', ''))::int AS stores, sum(v.n_products)::int AS products
    FROM store_vendors v JOIN imported_stores s ON s.domain = v.domain
    WHERE s.published AND s.country = ANY(${[...VISIBLE_MARKETS]})
      AND (s.live_status IS NULL OR s.live_status NOT IN ('dead','migrated'))
      AND v.vendor_key <> ALL(${[...PLACEHOLDER_VENDORS, ...SUPPLIER_VENDORS]})
      ${q ? sql`AND v.vendor_key LIKE ${"%" + q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim() + "%"}` : sql``}
    GROUP BY v.vendor_key
    ORDER BY stores DESC, products DESC, v.vendor_key
    LIMIT ${limit}`;
  return rows.map((r) => ({ key: r.vendor_key, vendor: r.vendor, stores: Number(r.stores), products: Number(r.products) }));
}

export async function getBrand(key: string): Promise<BrandDetail | null> {
  const rows = await db()<{
    domain: string; name: string | null; country: string | null; platform: string | null;
    n_products: number; product_count: number | null; vendor: string; group_id: string | null;
  }[]>`
    SELECT v.domain, s.name, s.country, s.platform, v.n_products, s.product_count, v.vendor, m.group_id
    FROM store_vendors v JOIN imported_stores s ON s.domain = v.domain
    LEFT JOIN store_group_members m ON m.domain = v.domain
    WHERE v.vendor_key = ${key} AND s.published AND s.country = ANY(${[...VISIBLE_MARKETS]})
      AND (s.live_status IS NULL OR s.live_status NOT IN ('dead','migrated'))
    ORDER BY v.n_products DESC`;
  if (!rows.length) return null;

  // One row per site (www/apex twins are one store).
  const seen = new Set<string>();
  const stores: BrandStore[] = [];
  for (const r of rows) {
    if (seen.has(site(r.domain))) continue;
    seen.add(site(r.domain));
    const catalogue = r.product_count == null ? null : Number(r.product_count);
    const products = Number(r.n_products);
    stores.push({
      domain: r.domain, name: cleanName(r.name), country: r.country, platform: r.platform, products, catalogue,
      share: catalogue && catalogue > 0 ? Math.min(1, products / catalogue) : 1,
      namesBrand: spells(key, r.domain, r.name), role: "stockist", groupId: r.group_id,
    });
  }

  // Official = the store that spells the brand and sells the most of it, preferring the oldest-
  // established signal we have: the biggest brand catalogue. Its own group (sister sites) is official too.
  const official = stores.filter((s) => s.namesBrand && s.share >= 0.5).sort((a, b) => b.products - a.products)[0] ?? null;
  for (const s of stores) {
    if (official && (s === official || (s.groupId && s.groupId === official.groupId))) s.role = "official";
    // Spells the brand, mostly sells it, and isn't the official site or its operator → the clone pattern.
    else if (official && s.namesBrand && s.share >= 0.5) s.role = "impersonation";
  }
  return { key, vendor: rows[0].vendor, stores, official };
}

export type CatalogueCopy = {
  suspect: string; score: number; verdict: string; kind: string;
  copiedShare: number; reasons: string[]; firstSeenAt: string;
};

/** Stores the weekly clone sweep (scripts/clone-sweep.mjs → catalog_matches) found hosting this
 *  store's catalogue. Clones first, then stockists. */
export async function getCatalogueCopies(domain: string, limit = 20): Promise<CatalogueCopy[]> {
  const d = domain.trim().toLowerCase();
  const rows = await db()<{ suspect: string; score: number; verdict: string; kind: string; copied_share: number; reasons: string[]; first_seen_at: Date }[]>`
    SELECT suspect, score, verdict, kind, copied_share, reasons, first_seen_at
    FROM catalog_matches WHERE original IN (${d}, ${"www." + site(d)}, ${site(d)})
    ORDER BY (kind = 'clone') DESC, score DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    suspect: r.suspect, score: Number(r.score), verdict: r.verdict, kind: r.kind,
    copiedShare: Number(r.copied_share), reasons: r.reasons ?? [], firstSeenAt: new Date(r.first_seen_at).toISOString().slice(0, 10),
  }));
}

/** How much of the visible base the index covers: stores with at least one brand row, and brands.
 *  Shown on the customer page so a missing brand reads as "not read yet", never "nobody sells it". */
export async function brandCoverage(): Promise<{ stores: number; brands: number }> {
  const [r] = await db()<{ stores: number; brands: number }[]>`
    SELECT count(DISTINCT regexp_replace(v.domain, '^www\\.', ''))::int AS stores, count(DISTINCT v.vendor_key)::int AS brands
    FROM store_vendors v JOIN imported_stores s ON s.domain = v.domain
    WHERE s.published AND s.country = ANY(${[...VISIBLE_MARKETS]})
      AND (s.live_status IS NULL OR s.live_status NOT IN ('dead','migrated'))`;
  return { stores: Number(r?.stores ?? 0), brands: Number(r?.brands ?? 0) };
}

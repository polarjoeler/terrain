/** Partner Finder data — the PRODUCT side (payment gateways, apps, shipping carriers) broken out
 *  per country, so the directory can be filtered to one market instead of dumping every app we've
 *  ever seen on one page.
 *
 *  One viewer-agnostic aggregate, cached with cachedAgg (the three unnest scans take ~15s cold), then
 *  filtered in-process per request. Scoped to VISIBLE_MARKETS like every customer query — the old
 *  /partners page counted every country we hold, including hidden markets. */
import { cachedAgg } from "./agg-cache";
import { db } from "./db";
import { VISIBLE_MARKETS } from "./markets";
import { realPaymentsClause } from "./insights";
import { classify, canonicalProvider, type PayType } from "./payments-taxonomy";
import { providerSlug } from "./provider-slug";

export type ProductCategory = "payments" | "apps" | "shipping";
export const PRODUCT_CATEGORIES: ProductCategory[] = ["payments", "apps", "shipping"];

export type DirectoryRow = {
  cat: ProductCategory;
  name: string;
  subtype: PayType | null;
  slug: string | null;
  /** live-store count per ISO2 market */
  by: Record<string, number>;
};

export type ProductDirectory = {
  rows: DirectoryRow[];
  /** stores with that category detected, per market — the denominator for "share of stores" */
  base: Record<ProductCategory, Record<string, number>>;
  computedAt: string;
};

const LIVE = (sql: ReturnType<typeof db>) =>
  sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND country = ANY(${[...VISIBLE_MARKETS]})`;

// Per (raw value, country) distinct-store counts + per-country base for one ";"-delimited column.
async function scan(column: "payments" | "apps" | "shipping_providers") {
  const sql = db();
  const extra = column === "payments" ? sql`AND ${realPaymentsClause(sql)}` : sql``;
  const where = sql`${LIVE(sql)} AND ${sql(column)} IS NOT NULL AND ${sql(column)} <> '' ${extra}`;
  const pairs = await sql<{ v: string; c: string; n: number }[]>`
    SELECT v, country AS c, COUNT(DISTINCT domain)::int n FROM (
      SELECT domain, country, trim(unnest(string_to_array(${sql(column)}, ';'))) AS v
      FROM imported_stores WHERE ${where}
    ) x WHERE v <> '' GROUP BY 1, 2`;
  const base = await sql<{ c: string; n: number }[]>`
    SELECT country AS c, COUNT(*)::int n FROM imported_stores WHERE ${where} GROUP BY 1`;
  return {
    pairs: pairs.map((r) => ({ v: r.v, c: r.c, n: Number(r.n) })),
    base: Object.fromEntries(base.map((r) => [r.c, Number(r.n)])) as Record<string, number>,
  };
}

// A Shopify-app URL → a readable app name ("https://apps.shopify.com/twik-app-2" → "Twik App 2").
function appName(raw: string): string | null {
  const m = raw.match(/apps\.shopify\.com\/([a-z0-9-]+)/i);
  const slug = m ? m[1] : raw.replace(/^https?:\/\//, "").split("/")[0];
  if (!slug || slug.length < 2) return null;
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Payment "methods" that aren't a company anyone could partner with.
const NOT_A_PAYMENT_PARTNER = new Set(["Cash on Delivery", "Bank Deposit", "Bank Transfer", "Credit Card", "Cheque", "Visa", "Mastercard", "Amex"]);

// Shipping labels are free text from checkout: Shopify's internal rate layers, merchant rule
// names and snake_case carrier codes. Fold to one name per carrier/app and drop the non-partners.
const SHIP_DROP = /^(shopify|manual|custom|flat rate|free shipping|pickup|shipping rates?|table rates? shipping|postcode shipping|custom zip code.*|customship)$|^shopify_provided_|^merchant_customized_/i;
const SHIP_FOLD: [RegExp, string][] = [
  [/fastway/i, "Fastway"], [/pargo/i, "Pargo"], [/^tunl/i, "TUNL"], [/^aramexs?$/i, "Aramex"],
  [/^fedex/i, "FedEx"], [/^usps$/i, "USPS"], [/^ups(_shipping)?$/i, "UPS"], [/^dhl_express$/i, "DHL Express"],
  [/^dhl_ecommerce$/i, "DHL eCommerce"], [/^canada_post$/i, "Canada Post"], [/courier guy/i, "The Courier Guy"],
  [/^bob go/i, "Bob Go"], [/^octolize/i, "Octolize"], [/shipzip/i, "ShipZip"], [/^shipx\b/i, "Shipx"],
];
function shippingName(raw: string): string | null {
  const v = raw.trim().replace(/\.$/, "");
  if (!v || SHIP_DROP.test(v)) return null;
  for (const [re, name] of SHIP_FOLD) if (re.test(v)) return name;
  // any other snake_case code → Title Case words
  return /_/.test(v) ? v.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : v;
}

// Fold raw labels onto one name per real product, summing per-country counts. (Summing variants can
// slightly overcount a store carrying two spellings of the same gateway — same as availableProviders.)
function fold(cat: ProductCategory, pairs: { v: string; c: string; n: number }[], name: (v: string) => string | null, min: number): DirectoryRow[] {
  const agg = new Map<string, Record<string, number>>();
  for (const p of pairs) {
    const k = name(p.v);
    if (!k) continue;
    const by = agg.get(k) ?? {};
    by[p.c] = (by[p.c] ?? 0) + p.n;
    agg.set(k, by);
  }
  const rows: DirectoryRow[] = [];
  for (const [k, by] of agg) {
    const total = Object.values(by).reduce((s, n) => s + n, 0);
    if (total < min) continue;
    rows.push({
      cat, name: k, by,
      subtype: cat === "payments" ? classify(k) : null,
      slug: cat === "payments" ? providerSlug(k) : null,
    });
  }
  return rows;
}

export function productDirectory(): Promise<ProductDirectory> {
  return cachedAgg("partners:directory:v2", 6 * 60 * 60 * 1000, async () => {
    // Sequential on purpose — three heavy scans must not fan out on the shared pool.
    const pay = await scan("payments");
    const app = await scan("apps");
    const ship = await scan("shipping_providers");
    return {
      rows: [
        ...fold("payments", pay.pairs, (v) => { const c = canonicalProvider(v); return c && !NOT_A_PAYMENT_PARTNER.has(c) ? c : null; }, 5),
        ...fold("apps", app.pairs, appName, 5),
        ...fold("shipping", ship.pairs, shippingName, 3),
      ],
      base: { payments: pay.base, apps: app.base, shipping: ship.base },
      computedAt: new Date().toISOString(),
    };
  });
}

/** Stores for a row in one market, or across every visible market when `country` is empty. */
export function storesIn(row: DirectoryRow, country?: string): number {
  if (country) return row.by[country] ?? 0;
  let s = 0;
  for (const n of Object.values(row.by)) s += n;
  return s;
}

export function baseIn(dir: ProductDirectory, cat: ProductCategory, country?: string): number {
  const b = dir.base[cat] ?? {};
  if (country) return b[country] ?? 0;
  return Object.values(b).reduce((s, n) => s + n, 0);
}

/** Markets with any product data, most stores first — drives the country filter. */
export function directoryCountries(dir: ProductDirectory, cat?: ProductCategory): { code: string; stores: number }[] {
  const tot: Record<string, number> = {};
  for (const c of cat ? [cat] : PRODUCT_CATEGORIES) for (const [cc, n] of Object.entries(dir.base[c] ?? {})) tot[cc] = Math.max(tot[cc] ?? 0, n);
  return Object.entries(tot).map(([code, stores]) => ({ code, stores })).sort((a, b) => b.stores - a.stores);
}

// Service partners store their country as a NAME ("South Africa"); the filter speaks ISO2.
const NAME_TO_CODE: Record<string, string> = {
  "South Africa": "ZA", Kenya: "KE", Nigeria: "NG", Ghana: "GH", Egypt: "EG", Morocco: "MA", Tanzania: "TZ",
  Uganda: "UG", Rwanda: "RW", Botswana: "BW", Namibia: "NA", Zambia: "ZM", Zimbabwe: "ZW", Mauritius: "MU",
  Ethiopia: "ET", Senegal: "SN", "Côte d'Ivoire": "CI", "Côte d’Ivoire": "CI", "Ivory Coast": "CI", Cameroon: "CM",
  Mozambique: "MZ", Malawi: "MW", Angola: "AO", Tunisia: "TN", Algeria: "DZ",
};
export function countryCode(name: string | null | undefined): string | null {
  if (!name) return null;
  if (/^[A-Z]{2}$/.test(name)) return name;
  return NAME_TO_CODE[name.trim()] ?? null;
}

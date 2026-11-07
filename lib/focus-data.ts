/** Numbers for the Overview's "Your focus" panel: how big the user's chosen slice of the market is,
 *  what launched in it, and its biggest stores. Server-only (DB).
 *
 *  Cached per FOCUS, not per user (agg_cache, SWR): everyone who picked "$100k+ stores in South
 *  Africa" shares one row, and a changed answer is simply a different key. Each query is bounded and
 *  they run sequentially (the small pool).
 *
 *  Launch counts use the same guarded key as Insights (#97/#110): a certificate date is a placeholder,
 *  not a launch, so it never counts as "launched".
 */
import { db as sharedDb } from "./db";
import { cachedAgg } from "./agg-cache";
import { FOCUS_MARKETS } from "./markets";
import { PLATFORMS } from "./platforms";
import type { Focus } from "./focus";
import type { SizeBand } from "./onboarding";

function db() { return sharedDb(); }

export type FocusStore = {
  domain: string; name: string | null; country: string | null; platform: string | null;
  category: string | null; estMonthlySales: number | null; productCount: number | null;
};
// Each count comes in two parts: CONFIRMED (size known and in a chosen band) and UNKNOWN (fits every
// other choice but has no size data). Kept apart on purpose — new stores almost never carry a
// revenue estimate, so folding them in would make "$100k+ stores launched this month" mostly stores
// we simply can't size yet.
export type FocusSnapshot = {
  live: number; liveUnknown: number;
  launched30: number; launched30Unknown: number;   // real launch dates only (no cert placeholders)
  launched7: number; launched7Unknown: number;
  top: FocusStore[];     // biggest confirmed stores, by estimated monthly sales
};
const EMPTY: FocusSnapshot = { live: 0, liveUnknown: 0, launched30: 0, launched30Unknown: 0, launched7: 0, launched7Unknown: 0, top: [] };

const REV: Partial<Record<SizeBand, [number, number]>> = {
  rev_100k_plus: [100_000, 1e15], rev_25_100k: [25_000, 100_000], rev_5_25k: [5_000, 25_000],
  rev_1_5k: [1_000, 5_000], rev_under_1k: [0, 1_000],
};

/** Stable cache key for the parts of the focus this snapshot depends on. */
function keyOf(f: Focus): string {
  const s = (xs: string[]) => [...xs].map((x) => x.toLowerCase()).sort().join(",");
  return `focus:v2:${s(f.platforms)}|${s(f.countries)}|${s(f.categories)}|${s(f.excludeCategories)}|${s(f.sizeBands)}|${f.unknownSizeOk ? 1 : 0}`;
}

export async function focusSnapshot(f: Focus): Promise<FocusSnapshot> {
  return cachedAgg(keyOf(f), 60 * 60 * 1000, async () => {
    const sql = db();
    const countries = f.countries.length ? f.countries : [...FOCUS_MARKETS];
    // A platform id covers several raw values ("magento" is Adobe Commerce); NULL counts as Shopify.
    const platformValues = [...new Set(f.platforms.flatMap((id) => (PLATFORMS.find((p) => p.id === id)?.dbValues ?? [id]).map((v) => v.toLowerCase())))];
    const cats = f.categories.map((c) => c.toLowerCase());
    const excl = f.excludeCategories.map((c) => c.toLowerCase());

    const base = sql`
      published AND country = ANY(${countries})
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      ${platformValues.length ? sql`AND lower(coalesce(platform, 'shopify')) = ANY(${platformValues})` : sql``}
      ${cats.length ? sql`AND lower(category) = ANY(${cats})` : sql``}
      ${excl.length ? sql`AND (category IS NULL OR NOT (lower(category) = ANY(${excl})))` : sql``}`;

    // Size: "in band" when any chosen band contains the store; "unknown" when a chosen band can't be
    // evaluated for it. Same rule as lib/focus matchLevel.
    // COALESCE: a NULL revenue makes the band test NULL, and NOT NULL is still NULL — without it the
    // size-unknown stores would count as neither in nor out.
    const bandTest = f.sizeBands.length
      ? f.sizeBands.map((b) =>
          b === "cat_large" ? sql`product_count >= 100`
          : b === "cat_small" ? sql`product_count < 100`
          : sql`estimated_monthly_sales >= ${REV[b]![0]} AND estimated_monthly_sales < ${REV[b]![1]}`)
        .reduce((acc, c) => sql`${acc} OR (${c})`, sql`false`)
      : sql`true`;
    const inBand = sql`COALESCE((${bandTest}), false)`;
    const usesRev = f.sizeBands.some((b) => b.startsWith("rev_"));
    const usesCat = f.sizeBands.some((b) => b.startsWith("cat_"));
    const unknown = f.sizeBands.length && f.unknownSizeOk
      ? sql`(${usesRev ? sql`estimated_monthly_sales IS NULL` : sql`false`} OR ${usesCat ? sql`product_count IS NULL` : sql`false`})`
      : sql`false`;
    const launchKey = sql`COALESCE(first_product_at::date, CASE WHEN launched_source IS DISTINCT FROM 'cert' THEN launched_at::date END)`;

    const [c] = await sql.begin(async (t) => {
      await t`SET LOCAL statement_timeout = '20s'`;
      return t<{ live: number; live_u: number; l30: number; l30_u: number; l7: number; l7_u: number }[]>`
        WITH s AS (
          SELECT ${inBand} AS confirmed, (NOT ${inBand} AND ${unknown}) AS unsized, ${launchKey} AS launched
          FROM imported_stores WHERE ${base})
        SELECT
          count(*) FILTER (WHERE confirmed)::int live,
          count(*) FILTER (WHERE unsized)::int live_u,
          count(*) FILTER (WHERE confirmed AND launched > current_date - 30)::int l30,
          count(*) FILTER (WHERE unsized AND launched > current_date - 30)::int l30_u,
          count(*) FILTER (WHERE confirmed AND launched > current_date - 7)::int l7,
          count(*) FILTER (WHERE unsized AND launched > current_date - 7)::int l7_u
        FROM s`;
    });
    const top = await sql<{ domain: string; name: string | null; country: string | null; platform: string | null; category: string | null; estimated_monthly_sales: string | null; product_count: number | null }[]>`
      SELECT domain, name, upper(country) country, platform, category, estimated_monthly_sales, product_count
      FROM imported_stores WHERE ${base} AND (${inBand})
      ORDER BY estimated_monthly_sales DESC NULLS LAST, product_count DESC NULLS LAST LIMIT 5`.catch(() => []);

    return {
      live: c?.live ?? 0, liveUnknown: c?.live_u ?? 0,
      launched30: c?.l30 ?? 0, launched30Unknown: c?.l30_u ?? 0, launched7: c?.l7 ?? 0, launched7Unknown: c?.l7_u ?? 0,
      top: top.map((r) => ({
        domain: r.domain, name: r.name, country: r.country, platform: r.platform, category: r.category,
        estMonthlySales: r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null, productCount: r.product_count,
      })),
    };
  }).catch(() => EMPTY);
}

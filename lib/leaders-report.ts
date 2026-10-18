/** Market-leaders report — the biggest stores in a market, and the platforms powering them.
 *
 *  It needs TWO lenses, because the two questions are served by different data:
 *   • PLATFORM LEADERSHIP ranks by TRAFFIC (CrUX rank). This is the only lens that surfaces the
 *     custom/headless enterprise head (Takealot, Cape Union Mart class) — which dominates real traffic
 *     but carries no revenue estimate, so a revenue ranking would hide it as ~100% Shopify. Most of
 *     these are still published=false (traffic-identified, not yet enriched), so this lens deliberately
 *     does NOT gate on published — it's market intelligence, not the lead list.
 *   • REVENUE LEADERS uses the revenue-estimate top-cohort tags (store_tags top-100/top-500), the
 *     enriched set that actually carries estimated_monthly_sales → real $ projections (Shopify-skewed).
 *
 *  The gap between the two (custom owns the traffic head, but we hold $ only on the Shopify set) is
 *  itself the signal — the enrichment frontier — surfaced as "most interesting platform".
 */
import { db as sharedDb } from "./db";
import { usdSqlExpr } from "./fx";

function db() { return sharedDb(); }

export type LeaderPlatform = {
  platform: string;        // slug: 'custom' | 'shopify' | 'woocommerce' | 'magento' | … | 'unknown'
  stores: number;          // in the traffic cohort
  topPct: number;          // share of the cohort
  overallPct: number;      // share of all live stores in the market
  lift: number;            // topPct / overallPct — over-representation among the leaders
};
export type LeaderStore = { domain: string; name: string | null; platform: string | null; cruxRank: number | null };
export type RevenueCut = { platform: string; stores: number; revenueUsd: number };
export type LeadersReport = {
  country: string;
  cohort: number;                 // 100 | 500 (requested)
  // ── Platform leadership (by traffic) ──
  trafficTotal: number;           // stores ranked by traffic (≤ cohort)
  platforms: LeaderPlatform[];    // sorted by store count desc
  topStores: LeaderStore[];       // top 15 by traffic
  mostInteresting: { platform: string; topPct: number; overallPct: number; lift: number } | null;
  // ── Revenue leaders (by revenue estimate; the enriched cohort) ──
  revenueStores: number;          // # in the revenue-tag cohort
  revenueMonthlyUsd: number;      // summed est. monthly sales (USD)
  revenueAnnualUsd: number;
  revenueByPlatform: RevenueCut[];// where the revenue sits, by platform
};

const bkt = (p: string | null): string => (p && p.trim() ? p.trim().toLowerCase() : "unknown");

export async function leadersReport(country: string, cohort = 100): Promise<LeadersReport> {
  const sql = db();
  const C = country.toUpperCase();
  const N = cohort === 500 ? 500 : 100;
  const tag = N === 500 ? "top-500" : "top-100";
  const usd = sql.unsafe(usdSqlExpr());
  // Traffic lens: live + real store, ANY published (the custom head is parked unpublished).
  const LIVE = sql`UPPER(country) = ${C}
    AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND activity_tier IS DISTINCT FROM 'not_a_store'`;

  // ── Platform leadership — top N by traffic rank ──
  const top = await sql<{ domain: string; name: string | null; platform: string | null; crux_rank: number | null }[]>`
    SELECT domain, name, platform, crux_rank FROM imported_stores
    WHERE ${LIVE} AND crux_rank IS NOT NULL ORDER BY crux_rank ASC LIMIT ${N}`;
  const overall = await sql<{ p: string | null; n: number }[]>`
    SELECT platform p, COUNT(*)::int n FROM imported_stores WHERE ${LIVE} GROUP BY 1`;
  const overallTotal = overall.reduce((s, r) => s + Number(r.n), 0) || 1;
  const overallByPlat = new Map<string, number>();
  for (const r of overall) overallByPlat.set(bkt(r.p), (overallByPlat.get(bkt(r.p)) ?? 0) + Number(r.n));

  const trafficTotal = top.length;
  const byPlat = new Map<string, number>();
  for (const s of top) byPlat.set(bkt(s.platform), (byPlat.get(bkt(s.platform)) ?? 0) + 1);
  const platforms: LeaderPlatform[] = [...byPlat.entries()].map(([platform, stores]) => {
    const topPct = trafficTotal ? (100 * stores) / trafficTotal : 0;
    const overallPct = (100 * (overallByPlat.get(platform) ?? 0)) / overallTotal;
    return {
      platform, stores,
      topPct: Math.round(topPct * 10) / 10,
      overallPct: Math.round(overallPct * 10) / 10,
      lift: overallPct > 0 ? Math.round((topPct / overallPct) * 10) / 10 : 0,
    };
  }).sort((a, b) => b.stores - a.stores);
  const mi = platforms.filter((p) => p.stores >= Math.max(3, trafficTotal * 0.03) && p.overallPct > 0)
    .sort((a, b) => b.lift - a.lift)[0] ?? null;
  const topStores: LeaderStore[] = top.slice(0, 15).map((s) => ({
    domain: s.domain, name: s.name, platform: s.platform, cruxRank: s.crux_rank == null ? null : Number(s.crux_rank),
  }));

  // ── Revenue leaders — the revenue-estimate top-cohort tag (where real $ lives) ──
  const rev = await sql<{ p: string | null; stores: number; rev: number }[]>`
    SELECT i.platform p, COUNT(*)::int stores, COALESCE(SUM(${usd}), 0)::bigint rev
    FROM imported_stores i JOIN store_tags st ON st.domain = i.domain AND st.tag = ${tag}
    WHERE UPPER(i.country) = ${C} AND (i.live_status IS NULL OR i.live_status NOT IN ('dead','migrated'))
      AND i.activity_tier IS DISTINCT FROM 'not_a_store'
    GROUP BY 1`;
  const revenueByPlatform: RevenueCut[] = rev.map((r) => ({ platform: bkt(r.p), stores: Number(r.stores), revenueUsd: Number(r.rev) }))
    .sort((a, b) => b.revenueUsd - a.revenueUsd);
  const revenueStores = revenueByPlatform.reduce((s, r) => s + r.stores, 0);
  const revenueMonthlyUsd = revenueByPlatform.reduce((s, r) => s + r.revenueUsd, 0);

  return {
    country: C, cohort: N,
    trafficTotal, platforms, topStores, mostInteresting: mi,
    revenueStores, revenueMonthlyUsd, revenueAnnualUsd: revenueMonthlyUsd * 12, revenueByPlatform,
  };
}

/** Markets that actually have CrUX-ranked stores (for the picker). */
export async function leadersMarkets(min = 20): Promise<{ country: string; stores: number }[]> {
  const sql = db();
  const rows = await sql<{ c: string; n: number }[]>`
    SELECT UPPER(country) c, COUNT(*)::int n FROM imported_stores
    WHERE crux_rank IS NOT NULL AND country IS NOT NULL AND country <> ''
      AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND activity_tier IS DISTINCT FROM 'not_a_store'
    GROUP BY 1 HAVING COUNT(*) >= ${min} ORDER BY n DESC`.catch(() => []);
  return rows.map((r) => ({ country: r.c, stores: Number(r.n) }));
}

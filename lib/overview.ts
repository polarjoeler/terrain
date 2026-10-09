/** Data for the command-center Overview (the login landing). Everything here is LAUNCH-DATED and
 *  collection-neutral — "this week" means stores that launched this week, not ones we happened to
 *  discover — so an import/scan-heavy week can't fake momentum. Focus markets only. Cached, each
 *  query bounded; sequential (never Promise.all on the small pool). */
import { db as sharedDb } from "./db";
import { cachedAgg } from "./agg-cache";
import { FOCUS_MARKETS } from "./markets";

function db() { return sharedDb(); }
const FOCUS = [...FOCUS_MARKETS];

export type OverviewPulse = {
  newWeek: number; newPrev: number;       // genuinely new launches, this week vs prior week
  plusWeek: number;                        // Shopify Plus among this week's launches
  churnWeek: number; churnPrev: number;    // confirmed-dead this week vs prior
  migWeek: number; migPrev: number;        // migrated off-platform this week vs prior
  totalLive: number;                       // live store base across focus markets
};
export type LaunchItem = { domain: string; name: string | null; country: string | null; platform: string | null; launchedAt: string };
export type DayBucket = { day: string; shopify: number; woo: number; other: number };
export type MarketCell = { country: string; live: number; newWeek: number };
export type OverviewData = { pulse: OverviewPulse; launches: LaunchItem[]; trend: DayBucket[]; markets: MarketCell[]; updatedAt: string };

const EMPTY: OverviewData = {
  pulse: { newWeek: 0, newPrev: 0, plusWeek: 0, churnWeek: 0, churnPrev: 0, migWeek: 0, migPrev: 0, totalLive: 0 },
  launches: [], trend: [], markets: [], updatedAt: new Date(0).toISOString(),
};

export async function overviewData(): Promise<OverviewData> {
  return cachedAgg("overview:cmd:v2", 10 * 60 * 1000, async () => {
    const sql = db();
    // 1) Pulse — one scan, launch-dated this-week-vs-prior.
    const [p] = await sql.begin(async (t) => {
      await t`SET LOCAL statement_timeout = '25s'`;
      return t<{ new_w: number; new_pw: number; plus_w: number; churn_w: number; churn_pw: number; mig_w: number; mig_pw: number; live: number }[]>`
        SELECT
          count(*) FILTER (WHERE launched_at > now()-interval '7 days')::int new_w,
          count(*) FILTER (WHERE launched_at > now()-interval '14 days' AND launched_at <= now()-interval '7 days')::int new_pw,
          count(*) FILTER (WHERE plus AND launched_at > now()-interval '7 days')::int plus_w,
          count(*) FILTER (WHERE live_status = 'dead' AND live_checked_at > now()-interval '7 days')::int churn_w,
          count(*) FILTER (WHERE live_status = 'dead' AND live_checked_at > now()-interval '14 days' AND live_checked_at <= now()-interval '7 days')::int churn_pw,
          count(*) FILTER (WHERE live_status = 'migrated' AND live_checked_at > now()-interval '7 days')::int mig_w,
          count(*) FILTER (WHERE live_status = 'migrated' AND live_checked_at > now()-interval '14 days' AND live_checked_at <= now()-interval '7 days')::int mig_pw,
          count(*) FILTER (WHERE live_status IS NULL OR live_status NOT IN ('dead','migrated'))::int live
        FROM imported_stores WHERE published AND country = ANY(${FOCUS})`;
    });
    // 2) Launch trend — daily launches over 30 days, split by platform (Shopify folds in unclassified).
    const trendRows = await sql<{ d: string; shopify: number; woo: number; other: number }[]>`
      SELECT date_trunc('day', launched_at)::date d,
        count(*) FILTER (WHERE platform IS NULL OR lower(platform) = 'shopify')::int shopify,
        count(*) FILTER (WHERE lower(platform) = 'woocommerce')::int woo,
        count(*) FILTER (WHERE platform IS NOT NULL AND lower(platform) NOT IN ('shopify','woocommerce'))::int other
      FROM imported_stores
      WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '90 days'
      GROUP BY 1 ORDER BY 1`.catch(() => []);
    // 3) Recent launches — the honest "what's new" feed (launch-dated, not discovery).
    const launches = await sql<{ domain: string; name: string | null; country: string | null; platform: string | null; launched_at: string }[]>`
      SELECT domain, name, upper(country) country, platform, launched_at
      FROM imported_stores
      WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '14 days'
      ORDER BY launched_at DESC NULLS LAST LIMIT 7`.catch(() => []);
    // 4) Market pulse — live base + this week's launches.
    const markets = await sql<{ country: string; live: number; new_w: number }[]>`
      SELECT upper(country) country, count(*)::int live,
        count(*) FILTER (WHERE launched_at > now()-interval '7 days')::int new_w
      FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND country = ANY(${FOCUS})
      GROUP BY 1 HAVING count(*) >= 50 ORDER BY live DESC LIMIT 6`.catch(() => []);

    return {
      pulse: { newWeek: p.new_w, newPrev: p.new_pw, plusWeek: p.plus_w, churnWeek: p.churn_w, churnPrev: p.churn_pw, migWeek: p.mig_w, migPrev: p.mig_pw, totalLive: p.live },
      launches: launches.map((r) => ({ domain: r.domain, name: r.name, country: r.country, platform: r.platform, launchedAt: new Date(r.launched_at).toISOString() })),
      trend: trendRows.map((r) => ({ day: new Date(r.d).toISOString().slice(0, 10), shopify: r.shopify, woo: r.woo, other: r.other })),
      markets: markets.map((r) => ({ country: r.country, live: r.live, newWeek: r.new_w })),
      updatedAt: new Date().toISOString(),
    };
  }).catch(() => EMPTY);
}

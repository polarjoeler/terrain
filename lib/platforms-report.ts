/** Platform Share & Growth — global CMS landscape: who's winning, how fast each is growing, and the
 *  net impact of migrations. Starts global; scopeable by region / country, and filterable by CMS.
 *  Uses ALL published stores (not just focus markets) since this is the worldwide platform view — but
 *  we're candid that coverage is deepest in our focus markets (the `coverage` block). */
import { db as sharedDb } from "./db";
import { cachedAgg } from "./agg-cache";

function db() { return sharedDb(); }

// Region → ISO2 country set (null = global, no country filter). Compact but covers where we have data.
export const REGIONS: Record<string, { label: string; countries: string[] | null }> = {
  global: { label: "Global", countries: null },
  africa: { label: "Africa", countries: "ZA KE NG EG MA GH TZ UG DZ TN CI SN MU MZ CM BW AO NA RW ZM ET ZW LY MW SO LS SZ BJ BF ML NE TD MG MR".split(" ") },
  apac: { label: "Asia-Pacific", countries: "JP CN IN AU NZ SG MY ID TH VN PH KR TW HK PK BD LK".split(" ") },
  europe: { label: "Europe", countries: "GB IE DE FR ES IT NL BE PT SE NO DK FI PL CH AT CZ GR RO HU".split(" ") },
  americas: { label: "Americas", countries: "US CA BR MX AR CL CO PE".split(" ") },
  mena: { label: "Middle East & N. Africa", countries: "AE SA EG MA QA KW BH OM JO LB IL TR TN DZ LY".split(" ") },
};

export type CmsShare = { cms: string; live: number; pct: number; newWeek: number; newPrev: number };
export type MigrationFlow = { cms: string; joined: number; left: number; net: number };
export type DayBucket = { day: string; shopify: number; woo: number; other: number };
export type PlatformReport = {
  share: CmsShare[];
  migrations: MigrationFlow[];
  trend: DayBucket[];
  coverage: { stores: number; countries: number };
  scopeLabel: string;
};

const cmsLabel = (c: string) => ({ shopify: "Shopify", woocommerce: "WooCommerce", magento: "Magento", wix: "Wix", squarespace: "Squarespace", prestashop: "PrestaShop", bigcommerce: "BigCommerce", "ec-cube": "EC-CUBE", base: "BASE", cafe24: "Cafe24", shopstar: "ShopStar", opencart: "OpenCart" }[c] ?? (c ? c.charAt(0).toUpperCase() + c.slice(1) : "Other"));
export { cmsLabel };

export async function platformReport(opts: { region?: string; country?: string; cms?: string }): Promise<PlatformReport> {
  const region = opts.region && REGIONS[opts.region] ? opts.region : "global";
  const country = opts.country && /^[A-Za-z]{2}$/.test(opts.country) ? opts.country.toUpperCase() : undefined;
  const cms = opts.cms && /^[a-z0-9-]{2,20}$/.test(opts.cms) ? opts.cms : undefined;
  const countries = country ? [country] : REGIONS[region].countries;
  const scopeLabel = country ? country : REGIONS[region].label;

  return cachedAgg(`platreport:v1:${region}:${country ?? ""}:${cms ?? ""}`, 15 * 60 * 1000, async () => {
    const sql = db();
    const inScope = countries ? sql`AND country = ANY(${countries})` : sql``;
    const cmsClause = cms ? sql`AND (CASE WHEN platform IS NULL OR lower(platform)='shopify' THEN 'shopify' ELSE lower(platform) END) = ${cms}` : sql``;

    return await sql.begin(async (t) => {
      await t`SET LOCAL statement_timeout = '30s'`;

      // 1 · CMS market share (live), with this-week vs prior-week new launches.
      const shareRows = await t<{ cms: string; live: number; new_w: number; new_pw: number }[]>`
        SELECT CASE WHEN platform IS NULL OR lower(platform)='shopify' THEN 'shopify' ELSE lower(platform) END cms,
          count(*)::int live,
          count(*) FILTER (WHERE launched_at > now()-interval '7 days')::int new_w,
          count(*) FILTER (WHERE launched_at > now()-interval '14 days' AND launched_at <= now()-interval '7 days')::int new_pw
        FROM imported_stores
        WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) ${inScope} ${cmsClause}
        GROUP BY 1 ORDER BY live DESC LIMIT 12`;
      const total = shareRows.reduce((a, r) => a + r.live, 0);
      const share: CmsShare[] = shareRows.map((r) => ({ cms: r.cms, live: r.live, pct: total ? Math.round((1000 * r.live) / total) / 10 : 0, newWeek: r.new_w, newPrev: r.new_pw }));

      // 2 · Migration flows — net stores gained/lost per CMS via platform switches.
      const migRows = await t<{ cms: string; joined: number; lft: number }[]>`
        SELECT cms, sum(joined)::int joined, sum(lft)::int lft FROM (
          SELECT lower(live_platform) cms, count(*)::int joined, 0 lft FROM imported_stores
            WHERE live_status='migrated' AND live_platform IS NOT NULL AND live_platform <> '' ${inScope} GROUP BY 1
          UNION ALL
          SELECT lower(platform) cms, 0 joined, count(*)::int lft FROM imported_stores
            WHERE live_status='migrated' AND platform IS NOT NULL ${inScope} GROUP BY 1
        ) u WHERE cms IS NOT NULL AND cms <> '' GROUP BY cms ORDER BY (sum(joined)-sum(lft)) DESC`;
      const migrations: MigrationFlow[] = migRows.map((r) => ({ cms: r.cms, joined: r.joined, left: r.lft, net: r.joined - r.lft }));

      // 3 · Launch trend — daily by platform bucket (90d), scoped.
      const trendRows = await t<{ d: string; shopify: number; woo: number; other: number }[]>`
        SELECT date_trunc('day', launched_at)::date d,
          count(*) FILTER (WHERE platform IS NULL OR lower(platform)='shopify')::int shopify,
          count(*) FILTER (WHERE lower(platform)='woocommerce')::int woo,
          count(*) FILTER (WHERE platform IS NOT NULL AND lower(platform) NOT IN ('shopify','woocommerce'))::int other
        FROM imported_stores WHERE published AND launched_at > now()-interval '90 days' ${inScope} ${cmsClause}
        GROUP BY 1 ORDER BY 1`;

      // 4 · Coverage.
      const [cov] = await t<{ stores: number; countries: number }[]>`
        SELECT count(*)::int stores, count(DISTINCT country)::int countries
        FROM imported_stores WHERE published ${inScope}`;

      return {
        share, migrations,
        trend: trendRows.map((r) => ({ day: new Date(r.d).toISOString().slice(0, 10), shopify: r.shopify, woo: r.woo, other: r.other })),
        coverage: { stores: cov?.stores ?? 0, countries: cov?.countries ?? 0 },
        scopeLabel,
      };
    });
  }).catch(() => ({ share: [], migrations: [], trend: [], coverage: { stores: 0, countries: 0 }, scopeLabel }));
}

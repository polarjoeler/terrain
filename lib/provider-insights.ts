/** Provider-specific insights — a reusable read model for ONE payment gateway
 *  (Paystack, PayFast, …). Powers the shareable provider dashboard that a payment
 *  company uses to see how they're doing across the market: adoption among new
 *  stores, what vintage of store they win, where they sit in the checkout stack
 *  (only option / top spot / rank), who they compete with, and store size.
 *
 *  Everything here comes from `imported_stores.payments`, which the checkout probe
 *  stores in CHECKOUT DISPLAY ORDER (primary gateway first) — so rank/top-spot are
 *  real positions, not guesses. Trends over time come from provider_snapshots
 *  (see snapshotProviders), not from this point-in-time read. */

import postgres from "postgres";
import type { InsightItem } from "./insights";
import { classify, PAY_TYPES, type PayType } from "./payments-taxonomy";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);
const items = (m: Map<string, number>, denom: number): InsightItem[] =>
  [...m.entries()].map(([label, count]) => ({ label, count, pct: pct(count, denom) })).sort((a, b) => b.count - a.count);

export type ProviderStore = {
  domain: string; name: string | null; country: string | null;
  rank: number; gateways: string[]; sales: number | null; firstSeen: string | null;
};

export type ProviderInsights = {
  provider: string;
  total: number;                 // live stores with this gateway at checkout
  verifiedBase: number;          // live stores with ANY verified payment data (the denominator)
  byCountry: InsightItem[];
  // adoption among genuinely-new (discovered) stores
  newLast7: number; newLast30: number;
  newStores7: number;            // all new stores discovered in last 7d (denominator)
  shareOfNew7: number;           // % of last-7d new stores that chose this provider
  // position in the checkout stack
  exclusive: number; exclusivePct: number;   // this gateway is the ONLY option
  topSpot: number; topSpotPct: number;       // this gateway is displayed FIRST
  rankDist: InsightItem[];                    // how many at position 1, 2, 3…
  avgRank: number | null;
  avgStackSize: number | null;               // avg # of gateways at their checkouts
  // competition & profile
  providerType: PayType;                     // PSP | BNPL | APM — what this gateway is
  coOccurrenceByType: Record<PayType, InsightItem[]>; // competitors alongside, grouped by type
  vintage: InsightItem[];                    // first_seen year; pct = MARKET SHARE in that year
  sizeBands: InsightItem[];                  // est monthly sales bands
  topStores: ProviderStore[];                // biggest wins (by sales)
};

const norm = (s: string) => s.trim().toLowerCase();
const salesBand = (n: number | null): string =>
  n == null ? "unknown"
    : n >= 1e6 ? "$1M+/mo" : n >= 1e5 ? "$100k–1M" : n >= 1e4 ? "$10k–100k" : n >= 1e3 ? "$1k–10k" : "<$1k";

export async function providerInsights(provider: string, country?: string): Promise<ProviderInsights> {
  const sql = db();
  const p = norm(provider);
  const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
  const AND_C = country ? sql`AND UPPER(country) = ${country.toUpperCase()}` : sql``;

  // Every live store that has ANY verified payment data (the honest denominator),
  // pulled with the fields we need — provider membership is decided in JS off the
  // ordered token list so rank/exclusive/top-spot are exact.
  const rows = await sql<{
    domain: string; name: string | null; country: string | null;
    payments: string; first_seen: string | null; discovered_at: Date | null;
    estimated_monthly_sales: string | null;
  }[]>`
    SELECT domain, name, country, payments, first_seen, discovered_at, estimated_monthly_sales
    FROM imported_stores
    WHERE ${LIVE} ${AND_C} AND payments IS NOT NULL AND payments <> ''`;

  const verifiedBase = rows.length;
  const mine = rows
    .map((r) => {
      const gateways = String(r.payments).split(";").map((x) => x.trim()).filter(Boolean);
      const rank = gateways.findIndex((g) => norm(g) === p) + 1; // 1-based; 0 = absent
      return { r, gateways, rank };
    })
    .filter((x) => x.rank > 0);

  const total = mine.length;
  const byCountry = new Map<string, number>();
  const rankDist = new Map<string, number>();
  const coOcc = new Map<string, number>();
  const vintage = new Map<string, number>();
  const sizeBands = new Map<string, number>();
  let exclusive = 0, topSpot = 0, rankSum = 0, stackSum = 0;

  for (const { r, gateways, rank } of mine) {
    byCountry.set((r.country || "??").toUpperCase(), (byCountry.get((r.country || "??").toUpperCase()) ?? 0) + 1);
    rankDist.set(`#${rank}`, (rankDist.get(`#${rank}`) ?? 0) + 1);
    rankSum += rank; stackSum += gateways.length;
    if (gateways.length === 1) exclusive++;
    if (rank === 1) topSpot++;
    for (const g of gateways) if (norm(g) !== p) coOcc.set(g, (coOcc.get(g) ?? 0) + 1);
    const yr = (r.first_seen && /^\d{4}/.test(r.first_seen)) ? r.first_seen.slice(0, 4) : "unknown";
    vintage.set(yr, (vintage.get(yr) ?? 0) + 1);
    sizeBands.set(salesBand(r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null),
      (sizeBands.get(salesBand(r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null)) ?? 0) + 1);
  }

  // Adoption among NEW (discovered) stores — organic, excludes imports.
  const disc = (r: { discovered_at: Date | null }, days: number) =>
    r.discovered_at != null && (Date.now() - new Date(r.discovered_at).getTime()) <= days * 864e5;
  const newLast7 = mine.filter((x) => disc(x.r, 7)).length;
  const newLast30 = mine.filter((x) => disc(x.r, 30)).length;
  const [nd] = await sql<{ n7: number }[]>`
    SELECT COUNT(*)::int n7 FROM imported_stores
    WHERE ${LIVE} ${AND_C} AND discovered_at IS NOT NULL AND discovered_at >= CURRENT_DATE - 7`;
  const newStores7 = Number(nd.n7);

  // Denominator for vintage MARKET SHARE: all verified stores by first_seen year.
  const allByYear = new Map<string, number>();
  for (const r of rows) {
    const yr = (r.first_seen && /^\d{4}/.test(r.first_seen)) ? r.first_seen.slice(0, 4) : "unknown";
    allByYear.set(yr, (allByYear.get(yr) ?? 0) + 1);
  }
  // Competitors grouped by payment type (PSP / BNPL / APM).
  const coOccurrenceByType: Record<PayType, InsightItem[]> = { PSP: [], BNPL: [], APM: [] };
  for (const [label, count] of coOcc.entries())
    coOccurrenceByType[classify(label)].push({ label, count, pct: pct(count, total) });
  for (const t of PAY_TYPES) coOccurrenceByType[t].sort((a, b) => b.count - a.count);

  const topStores: ProviderStore[] = mine
    .sort((a, b) => (Number(b.r.estimated_monthly_sales) || 0) - (Number(a.r.estimated_monthly_sales) || 0))
    .slice(0, 25)
    .map(({ r, gateways, rank }) => ({
      domain: r.domain, name: r.name, country: r.country, rank, gateways,
      sales: r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null,
      firstSeen: r.first_seen,
    }));

  return {
    provider,
    total, verifiedBase,
    byCountry: items(byCountry, total),
    newLast7, newLast30, newStores7, shareOfNew7: pct(newLast7, newStores7),
    exclusive, exclusivePct: pct(exclusive, total),
    topSpot, topSpotPct: pct(topSpot, total),
    rankDist: [...rankDist.entries()].map(([label, count]) => ({ label, count, pct: pct(count, total) }))
      .sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1))),
    avgRank: total ? Math.round((rankSum / total) * 10) / 10 : null,
    avgStackSize: total ? Math.round((stackSum / total) * 10) / 10 : null,
    providerType: classify(provider),
    coOccurrenceByType,
    // pct = MARKET SHARE — of all verified stores from that year, how many use us.
    vintage: [...vintage.entries()].map(([label, count]) => ({ label, count, pct: pct(count, allByYear.get(label) ?? count) }))
      .sort((a, b) => b.label.localeCompare(a.label)),
    sizeBands: items(sizeBands, total),
    topStores,
  };
}

export type ProviderTrendPoint = { date: string; total: number; topSpot: number; exclusive: number; newLast7: number };

/** Snapshot the current metrics for every provider — run weekly so the trend lines
 *  on the provider dashboards accrue. Idempotent per (provider, date). */
export async function snapshotProviders(min = 5): Promise<number> {
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS provider_snapshots (
    provider TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'ALL', date DATE NOT NULL DEFAULT CURRENT_DATE,
    data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (provider, country, date))`;
  const providers = await availableProviders(min);
  let n = 0;
  for (const { provider } of providers) {
    const d = await providerInsights(provider);
    const snap = {
      total: d.total, topSpot: d.topSpot, exclusive: d.exclusive,
      newLast7: d.newLast7, newLast30: d.newLast30, shareOfNew7: d.shareOfNew7,
      topSpotPct: d.topSpotPct, exclusivePct: d.exclusivePct, avgRank: d.avgRank,
    } as Record<string, number | null>;
    await sql`INSERT INTO provider_snapshots (provider, country, date, data)
      VALUES (${provider}, ${'ALL'}, CURRENT_DATE, ${sql.json(snap)})
      ON CONFLICT (provider, country, date) DO UPDATE SET data = EXCLUDED.data`;
    n++;
  }
  return n;
}

/** Historical trend for one provider (all snapshots, oldest → newest). */
export async function providerHistory(provider: string, country = "ALL"): Promise<ProviderTrendPoint[]> {
  const sql = db();
  const rows = await sql<{ date: Date; data: Record<string, number> }[]>`
    SELECT date, data FROM provider_snapshots
    WHERE lower(provider) = ${provider.toLowerCase()} AND country = ${country}
    ORDER BY date ASC`.catch(() => []);
  return rows.map((r) => ({
    date: new Date(r.date).toISOString().slice(0, 10),
    total: Number(r.data.total ?? 0), topSpot: Number(r.data.topSpot ?? 0),
    exclusive: Number(r.data.exclusive ?? 0), newLast7: Number(r.data.newLast7 ?? 0),
  }));
}

/** Providers we have enough data on to build a page for (verified on ≥ `min` stores). */
export async function availableProviders(min = 5): Promise<{ provider: string; stores: number }[]> {
  const sql = db();
  const rows = await sql<{ provider: string; n: number }[]>`
    SELECT trim(g) AS provider, COUNT(*)::int n FROM (
      SELECT unnest(string_to_array(payments, ';')) AS g FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND payments IS NOT NULL AND payments <> ''
    ) x WHERE trim(g) <> '' GROUP BY 1 HAVING COUNT(*) >= ${min} ORDER BY n DESC`;
  return rows.map((r) => ({ provider: r.provider, stores: Number(r.n) }));
}

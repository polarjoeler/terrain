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
import { classify, cleanPayments, canonicalProvider, providerVariants, PAY_TYPES, type PayType } from "./payments-taxonomy";

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
  plus: boolean; discoveredAt: string | null; productCount: number | null;
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
  stores: ProviderStore[];                   // the provider's stores — for the filterable list
  // A PSP only really competes with other PSPs (BNPL/APMs sit alongside, not against).
  // So: on your stores, how often is a RIVAL PSP also at checkout vs you being the sole PSP?
  pspRivalry: { total: number; soloPsp: number; soloPspPct: number; withRival: number; withRivalPct: number; rivals: InsightItem[] };
  // Where you sit in the checkout stack, by store VINTAGE cohort — are you winning the
  // primary spot more with newer merchants? (avg rank + % you lead the checkout.)
  rankByCohort: { cohort: string; total: number; avgRank: number; topSpotPct: number }[];
  // Penetration in the segments a payment company sells to — the high-value/enterprise
  // tail (Top 100 / Top 500 by sales) and Shopify Plus. Volume is the game.
  segments: { key: string; label: string; total: number; mine: number; pct: number }[];
};

const norm = (s: string) => s.trim().toLowerCase();
const salesBand = (n: number | null): string =>
  n == null ? "unknown"
    : n >= 1e6 ? "$1M+/mo" : n >= 1e5 ? "$100k–1M" : n >= 1e4 ? "$10k–100k" : n >= 1e3 ? "$1k–10k" : "<$1k";

export async function providerInsights(provider: string, country?: string): Promise<ProviderInsights> {
  const sql = db();
  const p = norm(canonicalProvider(provider) || provider);
  const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
  const AND_C = country ? sql`AND UPPER(country) = ${country.toUpperCase()}` : sql``;

  // Every live store that has ANY verified payment data (the honest denominator),
  // pulled with the fields we need — provider membership is decided in JS off the
  // ordered token list so rank/exclusive/top-spot are exact.
  // Customer-facing surface → prefer own-sourced fields (est_revenue_usd), never the
  // vendor first_seen / estimated_monthly_sales. NOTE: launched_at now also carries a
  // StoreLeads month proxy (launched_source='storeleads_created') for older stores —
  // a deliberate exception so launch-year cohorts aren't stuck at ~14% coverage.
  const rows = await sql<{
    domain: string; name: string | null; country: string | null;
    payments: string; launched_at: Date | null; discovered_at: Date | null;
    est_revenue_usd: string | null; product_count: number | null; plus: boolean;
    t100: boolean; t500: boolean;
  }[]>`
    SELECT domain, name, country, payments, launched_at, discovered_at, est_revenue_usd, product_count,
           COALESCE(plus, false) AS plus,
           (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-100'))  AS t100,
           (domain IN (SELECT domain FROM store_tags WHERE tag = 'top-500')) AS t500
    FROM imported_stores
    WHERE ${LIVE} ${AND_C} AND payments IS NOT NULL AND payments <> ''`;
  const yearOf = (d: Date | null) => (d ? new Date(d).getUTCFullYear().toString() : "unknown");

  const verifiedBase = rows.length;
  const mine = rows
    .map((r) => {
      // Canonicalise before ranking: the stored list mixes machine tokens and card
      // icons, which would otherwise pad the stack and push real gateways down a rank.
      const gateways = cleanPayments(String(r.payments).split(";"));
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
    const yr = yearOf(r.launched_at);
    vintage.set(yr, (vintage.get(yr) ?? 0) + 1);
    const rev = r.est_revenue_usd != null ? Number(r.est_revenue_usd) : null;
    sizeBands.set(salesBand(rev), (sizeBands.get(salesBand(rev)) ?? 0) + 1);
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

  // Denominators for MARKET SHARE: all verified stores, by first_seen year and by country.
  const allByYear = new Map<string, number>();
  const verifiedByCountry = new Map<string, number>();
  for (const r of rows) {
    allByYear.set(yearOf(r.launched_at), (allByYear.get(yearOf(r.launched_at)) ?? 0) + 1);
    const c = (r.country || "??").toUpperCase();
    verifiedByCountry.set(c, (verifiedByCountry.get(c) ?? 0) + 1);
  }
  // Competitors grouped by payment type (PSP / BNPL / APM).
  const coOccurrenceByType: Record<PayType, InsightItem[]> = { PSP: [], BNPL: [], APM: [] };
  for (const [label, count] of coOcc.entries())
    coOccurrenceByType[classify(label)].push({ label, count, pct: pct(count, total) });
  for (const t of PAY_TYPES) coOccurrenceByType[t].sort((a, b) => b.count - a.count);

  // The provider's full store set (capped for payload) — the client sorts/filters it
  // (most recent, largest, leads-checkout, Plus, by period). Not pre-sorted by sales:
  // own-sourced revenue is still sparse, so "biggest" wasn't meaningful.
  const stores: ProviderStore[] = mine
    .slice(0, 1000)
    .map(({ r, gateways, rank }) => ({
      domain: r.domain, name: r.name, country: r.country, rank, gateways,
      sales: r.est_revenue_usd != null ? Number(r.est_revenue_usd) : null,
      firstSeen: r.launched_at ? new Date(r.launched_at).toISOString().slice(0, 10) : null,
      plus: r.plus,
      discoveredAt: r.discovered_at ? new Date(r.discovered_at).toISOString().slice(0, 10) : null,
      productCount: r.product_count != null ? Number(r.product_count) : null,
    }));

  // PSP rivalry — you only really compete with other PSPs (BNPL/APM sit alongside).
  let soloPsp = 0, withRival = 0;
  const rivals = new Map<string, number>();
  for (const { gateways } of mine) {
    const rivalPsps = gateways.filter((g) => norm(g) !== p && classify(g) === "PSP");
    if (rivalPsps.length === 0) soloPsp++;
    else { withRival++; for (const g of rivalPsps) rivals.set(g, (rivals.get(g) ?? 0) + 1); }
  }
  const pspRivalry = {
    total, soloPsp, soloPspPct: pct(soloPsp, total),
    withRival, withRivalPct: pct(withRival, total),
    rivals: items(rivals, total),
  };

  // Checkout placement by store-vintage cohort — avg rank + how often you lead.
  const cohortAgg = new Map<string, { n: number; rankSum: number; top: number }>();
  for (const { r, rank } of mine) {
    const yr = yearOf(r.launched_at);
    if (yr === "unknown") continue;
    const a = cohortAgg.get(yr) ?? { n: 0, rankSum: 0, top: 0 };
    a.n++; a.rankSum += rank; if (rank === 1) a.top++;
    cohortAgg.set(yr, a);
  }
  const rankByCohort = [...cohortAgg.entries()]
    .map(([cohort, a]) => ({ cohort, total: a.n, avgRank: Math.round((a.rankSum / a.n) * 10) / 10, topSpotPct: pct(a.top, a.n) }))
    .sort((x, y) => y.cohort.localeCompare(x.cohort));

  // Segment penetration — Top 100 / Top 500 (by sales) and Shopify Plus. Volume game.
  const seg = (flag: (r: (typeof rows)[number]) => boolean, key: string, label: string) => {
    const segTotal = rows.filter(flag).length;
    const m = mine.filter((x) => flag(x.r)).length;
    return { key, label, total: segTotal, mine: m, pct: pct(m, segTotal) };
  };
  const segments = [
    seg((r) => r.t100, "top100", "Top 100"),
    seg((r) => r.t500, "top500", "Top 500"),
    seg((r) => r.plus, "plus", "Shopify Plus"),
  ];

  return {
    provider,
    total, verifiedBase,
    pspRivalry, rankByCohort, segments,
    // pct = MARKET SHARE in that country (provider stores ÷ verified stores there),
    // count = provider store count. Sorted by share so the strongest market leads.
    byCountry: [...byCountry.entries()]
      .map(([label, count]) => ({ label, count, pct: pct(count, verifiedByCountry.get(label) ?? count) }))
      .sort((a, b) => b.pct - a.pct || b.count - a.count),
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
    stores,
  };
}

export type NewShareBucket = { date: string; total: number; mine: number; share: number };
export type NewSharePeriod = "day" | "week" | "month" | "quarter" | "year";
const NEW_SHARE_CFG: Record<NewSharePeriod, { trunc: string; window: string }> = {
  day: { trunc: "day", window: "45 days" },
  week: { trunc: "week", window: "26 weeks" },
  month: { trunc: "month", window: "18 months" },
  quarter: { trunc: "quarter", window: "36 months" },
  year: { trunc: "year", window: "6 years" },
};

/** Share of NEWLY-DISCOVERED stores that chose this provider, bucketed by period —
 *  the acquisition curve a payment company watches. Denominator is new stores WITH
 *  verified payment data (so "chose you" is knowable). Sparse until coverage grows. */
export async function providerNewShareSeries(
  provider: string, period: NewSharePeriod = "month", country?: string,
): Promise<NewShareBucket[]> {
  const sql = db();
  // Match whole checkout tokens, not substrings: ILIKE '%credit card%' also hit
  // "Mollie - Credit Card". Variants fold aliases ("wigwag-app") into the provider.
  const variants = providerVariants(provider);
  const cfg = NEW_SHARE_CFG[period] ?? NEW_SHARE_CFG.month;
  const AND_C = country ? sql`AND UPPER(country) = ${country.toUpperCase()}` : sql``;
  const rows = await sql<{ b: Date; total: number; mine: number }[]>`
    SELECT date_trunc(${cfg.trunc}, discovered_at)::date AS b,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM unnest(string_to_array(payments, ';')) g
             WHERE lower(btrim(g)) = ANY(${variants}::text[])))::int AS mine
    FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) ${AND_C}
      AND discovered_at IS NOT NULL AND discovered_at >= now() - ${cfg.window}::interval
      AND payments IS NOT NULL AND payments <> ''
    GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({
    date: new Date(r.b).toISOString().slice(0, 10),
    total: Number(r.total), mine: Number(r.mine),
    share: pct(Number(r.mine), Number(r.total)),
  }));
}

export type ProviderTrendPoint = { date: string; total: number; verifiedBase: number; share: number; topSpot: number; exclusive: number; newLast7: number };

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
  return rows.map((r) => {
    const total = Number(r.data.total ?? 0), verifiedBase = Number(r.data.verifiedBase ?? 0);
    return {
      date: new Date(r.date).toISOString().slice(0, 10),
      total, verifiedBase,
      share: r.data.share != null ? Number(r.data.share) : (verifiedBase ? Math.round((10000 * total) / verifiedBase) / 100 : 0),
      topSpot: Number(r.data.topSpot ?? 0), exclusive: Number(r.data.exclusive ?? 0), newLast7: Number(r.data.newLast7 ?? 0),
    };
  });
}

/** Countries where this provider appears at checkout — for the page's country filter. */
export async function providerCountries(provider: string): Promise<string[]> {
  const sql = db();
  const rows = await sql<{ c: string }[]>`
    SELECT UPPER(country) c, COUNT(*)::int n FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND country IS NOT NULL AND country <> ''
      AND EXISTS (SELECT 1 FROM unnest(string_to_array(payments, ';')) g
                  WHERE lower(btrim(g)) = ANY(${providerVariants(provider)}::text[]))
    GROUP BY 1 HAVING COUNT(*) >= 1 ORDER BY n DESC`;
  return rows.map((r) => r.c);
}

/** Providers we have enough data on to build a page for (verified on ≥ `min` stores). */
export async function availableProviders(min = 5): Promise<{ provider: string; stores: number }[]> {
  const sql = db();
  const rows = await sql<{ provider: string; n: number }[]>`
    SELECT trim(g) AS provider, COUNT(*)::int n FROM (
      SELECT unnest(string_to_array(payments, ';')) AS g FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND payments IS NOT NULL AND payments <> ''
    ) x WHERE trim(g) <> '' GROUP BY 1`;
  // Fold the raw checkout labels to one row per real gateway before applying `min`,
  // so variants count together ("wigwag-app" + "WigWag") and noise drops out entirely.
  const agg = new Map<string, number>();
  for (const r of rows) {
    const canon = canonicalProvider(r.provider);
    if (!canon) continue;
    agg.set(canon, (agg.get(canon) ?? 0) + Number(r.n));
  }
  return [...agg.entries()]
    .filter(([, n]) => n >= min)
    .map(([provider, stores]) => ({ provider, stores }))
    .sort((a, b) => b.stores - a.stores);
}

export type ProviderMomentum = {
  provider: string;
  share: number;        // latest share %
  shareDelta: number;   // share-point change over the window (+/-)
  rank: number;         // latest avg checkout rank (1 = usually primary)
  rankDelta: number;    // change in avg rank (negative = moved UP the checkout)
  total: number;        // latest merchant count
  totalDelta: number;   // merchant-count change
  days: number;         // span of history compared
};

/** Per-provider ADOPTION momentum among NEWLY-DISCOVERED stores — "which PSPs are new
 *  stores choosing, this period vs last". Deliberately DISCOVERY-NEUTRAL: it compares
 *  stores discovered in the last period against those discovered in the period before,
 *  keyed on discovered_at. Backfilling payment data onto OLDER stores can't move this
 *  (they fall outside both windows), so the delta is real new-store movement — not an
 *  artefact of our vetting catching up on the existing base. */
export async function providerMomentum(country = "ALL", period: "day" | "week" = "week"): Promise<ProviderMomentum[]> {
  const sql = db();
  const P = period === "day" ? 1 : 7;
  const AND_C = country !== "ALL" ? sql`AND UPPER(country) = ${country.toUpperCase()}` : sql``;
  const rows = await sql<{ discovered_at: Date; payments: string }[]>`
    SELECT discovered_at, payments FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND payments IS NOT NULL AND payments <> ''
      AND discovered_at IS NOT NULL AND discovered_at >= CURRENT_DATE - ${2 * P}::int ${AND_C}`.catch(() => []);

  const recentCut = Date.now() - P * 864e5;
  let recentTotal = 0, priorTotal = 0;
  const recent = new Map<string, number>(), prior = new Map<string, number>();
  for (const r of rows) {
    const isRecent = new Date(r.discovered_at).getTime() >= recentCut;
    if (isRecent) recentTotal++; else priorTotal++;
    // Canonical, de-duped gateways for the store (drops card icons / sub-rails).
    const provs = new Set(cleanPayments(String(r.payments).split(";")).map((g) => canonicalProvider(g)).filter(Boolean) as string[]);
    for (const p of provs) {
      const m = isRecent ? recent : prior;
      m.set(p, (m.get(p) ?? 0) + 1);
    }
  }

  const out: ProviderMomentum[] = [];
  for (const name of new Set<string>([...recent.keys(), ...prior.keys()])) {
    const rc = recent.get(name) ?? 0, pc = prior.get(name) ?? 0;
    const rShare = recentTotal ? (rc / recentTotal) * 100 : 0;
    const pShare = priorTotal ? (pc / priorTotal) * 100 : 0;
    out.push({
      provider: name,
      share: Math.round(rShare * 10) / 10,
      shareDelta: Math.round((rShare - pShare) * 10) / 10,
      rank: 0, rankDelta: 0,          // checkout-rank movement needs stable snapshots — omitted here
      total: rc, totalDelta: rc - pc, // new stores on this PSP: this period vs last
      days: P,
    });
  }
  // Biggest share movers first, then by new-store volume this period.
  return out.sort((a, b) => Math.abs(b.shareDelta) - Math.abs(a.shareDelta) || b.total - a.total);
}

export type PaymentShift = {
  domain: string; changedAt: string;
  added: string[]; removed: string[];
  oldPrimary: string | null; newPrimary: string | null;
  reordered: boolean;
};

/** Recent per-store payment-provider shifts from the payment_changes log — a live feed
 *  of stores adding/dropping a gateway. ONE row per store (its latest change), and only
 *  genuine gateway changes (add/drop), so a single flapping store can't flood the feed. */
export async function recentPaymentShifts(limit = 40): Promise<PaymentShift[]> {
  const sql = db();
  const rows = await sql<{
    domain: string; changed_at: Date; added: string[] | null; removed: string[] | null;
    old_primary: string | null; new_primary: string | null; reordered: boolean;
  }[]>`
    SELECT domain, changed_at, added, removed, old_primary, new_primary, reordered
    FROM (
      SELECT DISTINCT ON (domain) domain, changed_at, added, removed, old_primary, new_primary, reordered
      FROM payment_changes
      WHERE COALESCE(array_length(added, 1), 0) > 0 OR COALESCE(array_length(removed, 1), 0) > 0
      ORDER BY domain, changed_at DESC
    ) latest
    ORDER BY changed_at DESC LIMIT ${limit}`.catch(() => []);
  // Filter sub-rail / card-brand noise on read too, so even older rows render clean;
  // drop any row that has no real gateway change left after filtering.
  const clean = (arr: string[] | null) => (arr ?? []).filter((t) => !PAY_SHIFT_NOISE.has(t.toLowerCase()));
  return rows
    .map((r) => ({
      domain: r.domain,
      changedAt: new Date(r.changed_at).toISOString().slice(0, 10),
      added: clean(r.added), removed: clean(r.removed),
      oldPrimary: r.old_primary, newPrimary: r.new_primary, reordered: r.reordered,
    }))
    .filter((s) => s.added.length > 0 || s.removed.length > 0);
}

// Kept in sync with PAY_NOISE in scripts/sync-checkout-payments.mjs — intermittent
// sub-rails and card brands that aren't gateways.
const PAY_SHIFT_NOISE = new Set(["instant eft", "bank deposit", "eft", "bank transfer",
  "cash on delivery", "cod", "manual payment", "manual", "other", "credit card",
  "debit card", "card", "visa", "mastercard", "amex", "american express", "discover",
  "maestro", "diners club", "diners", "unionpay", "jcb"]);
const cleanShiftTokens = (arr: string[] | null) => (arr ?? []).filter((t) => !PAY_SHIFT_NOISE.has(t.toLowerCase()));

/** Genuine payment switches within a period, optionally scoped to a country — one row
 *  per store (its latest change), genuine gateway changes only. Powers the standalone
 *  switches report. periodDays = null → all time. */
export async function paymentShifts(periodDays: number | null = null, country?: string, limit = 200): Promise<PaymentShift[]> {
  const sql = db();
  const AND_PERIOD = periodDays ? sql`AND pc.changed_at >= now() - (${periodDays}::int * interval '1 day')` : sql``;
  const AND_C = country ? sql`AND UPPER(i.country) = ${country.toUpperCase()}` : sql``;
  const rows = await sql<{
    domain: string; changed_at: Date; added: string[] | null; removed: string[] | null;
    old_primary: string | null; new_primary: string | null; reordered: boolean;
  }[]>`
    SELECT domain, changed_at, added, removed, old_primary, new_primary, reordered FROM (
      SELECT DISTINCT ON (pc.domain) pc.domain, pc.changed_at, pc.added, pc.removed, pc.old_primary, pc.new_primary, pc.reordered
      FROM payment_changes pc JOIN imported_stores i ON i.domain = pc.domain
      WHERE (COALESCE(array_length(pc.added, 1), 0) > 0 OR COALESCE(array_length(pc.removed, 1), 0) > 0)
        ${AND_PERIOD} ${AND_C}
      ORDER BY pc.domain, pc.changed_at DESC
    ) latest ORDER BY changed_at DESC LIMIT ${limit}`.catch(() => []);
  return rows
    .map((r) => ({
      domain: r.domain,
      changedAt: new Date(r.changed_at).toISOString().slice(0, 10),
      added: cleanShiftTokens(r.added), removed: cleanShiftTokens(r.removed),
      oldPrimary: r.old_primary, newPrimary: r.new_primary, reordered: r.reordered,
    }))
    .filter((s) => s.added.length > 0 || s.removed.length > 0);
}

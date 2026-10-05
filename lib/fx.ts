/** Currency conversion, shared by the TS row-mapper and the SQL query builder.
 *
 *  This lives in one file on purpose. Revenue is both displayed AND sorted/banded
 *  in SQL, so the rates have to agree in both places — and when they didn't, the
 *  damage was invisible: `FX["zar"]` missed the uppercase-keyed table, fell
 *  through to x1, and left amounts in rands labelled USD (~18.5x high; NGN was
 *  ~1538x). Those inflated rows then won the revenue sort and displaced real ones.
 */

export const FX: Record<string, number> = {
  USD: 1, ZAR: 0.054, NGN: 0.00065, KES: 0.0077, JPY: 0.0067,
  GBP: 1.27, EUR: 1.08, AUD: 0.66, CAD: 0.73,
  // Other focus-market currencies (approx; revenue is a rough band, not accounting).
  EGP: 0.021, MAD: 0.10, GHS: 0.064, TZS: 0.00037, UGX: 0.00026, DZD: 0.0074, TND: 0.32,
  XOF: 0.0016, MUR: 0.021, MZN: 0.016, XAF: 0.0016, BWP: 0.073, AOA: 0.0011, NAD: 0.054,
  RWF: 0.00072, ZMW: 0.037, ETB: 0.0071, ZWL: 0.0021, LYD: 0.205,
};

export const CCY_BY_COUNTRY: Record<string, string> = {
  ZA: "ZAR", NG: "NGN", KE: "KES", US: "USD", GB: "GBP", JP: "JPY",
  EG: "EGP", MA: "MAD", GH: "GHS", TZ: "TZS", UG: "UGX", DZ: "DZD", TN: "TND",
  CI: "XOF", SN: "XOF", MU: "MUR", MZ: "MZN", CM: "XAF", BW: "BWP", AO: "AOA",
  NA: "NAD", RW: "RWF", ZM: "ZMW", ET: "ETB", ZW: "ZWL", LY: "LYD",
};

/** Currency is stored inconsistently cased ("ZAR" and "zar" both occur), so
 *  every lookup normalises first. */
export function toUsd(sales: number | null, currency: string | null, country: string | null): number | null {
  if (sales == null) return null;
  const ccy = (currency || CCY_BY_COUNTRY[(country ?? "").toUpperCase()] || "USD").toUpperCase();
  return Math.round(sales * (FX[ccy] ?? 1));
}

/** Convert any local-currency NUMERIC column to USD as a SQL expression, generated from the table
 *  above so SQL and TS can't drift. `currency`/`country` on the row pick the rate. */
export function usdExpr(col: string): string {
  const ccy = Object.entries(CCY_BY_COUNTRY)
    .map(([c, k]) => `WHEN '${c}' THEN '${k}'`).join(" ");
  const fx = Object.entries(FX)
    .map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ");
  return `ROUND(${col} * (
    CASE upper(COALESCE(NULLIF(currency, ''), CASE upper(COALESCE(country,'')) ${ccy} ELSE 'USD' END))
      ${fx} ELSE 1 END)::numeric)`;
}

/** Estimated monthly sales in USD. */
export function usdSqlExpr(): string {
  return usdExpr("estimated_monthly_sales");
}

/** Revenue bands, recalibrated to the actual distribution of this market.
 *  The previous set opened at "<$10K", which swallowed 96% of stores and left
 *  the top three bands empty. Measured percentiles (USD/month, 24,029 stores):
 *  p50 $125 · p75 $1.1K · p90 $3.2K · p95 $7.2K · p99 $40K · max $1.5M. */
// "New" is the no-data floor: a freshly discovered store has no revenue signal yet, so instead of a
// blank "—" (or a fabricated estimate) we band it "New" and DISPLAY it as the honest "up to $10k /
// R0–R150k"-ish range (see bandDisplay). Listed last — it's the unknown floor, below <$100.
export const REVENUE_BANDS = ["$100K+", "$25K–100K", "$5K–25K", "$1K–5K", "$100–1K", "<$100", "New"] as const;
export type RevenueBand = (typeof REVENUE_BANDS)[number] | "—";

export function revenueBand(n: number | null): RevenueBand {
  if (n == null) return "New";
  if (n >= 1e5) return "$100K+";
  if (n >= 25e3) return "$25K–100K";
  if (n >= 5e3) return "$5K–25K";
  if (n >= 1e3) return "$1K–5K";
  if (n >= 100) return "$100–1K";
  return "<$100";
}

/** Revenue band → pill colour (richest lilac at the top → faint cream at the bottom), used by the
 *  leads table. Co-located with the band scale it colours so the two can't drift apart. */
export function bandTone(band: RevenueBand): string {
  switch (band) {
    case "$100K+": return "bg-lilac/25 text-lilac border-lilac/40";
    case "$25K–100K": return "bg-cyan/15 text-cyan border-cyan/30";
    case "$5K–25K": return "bg-mint/15 text-mint border-mint/30";
    case "$1K–5K": return "bg-orange/15 text-orange border-orange/30";
    case "$100–1K": return "bg-cream/10 text-cream/50 border-cream/15";
    case "New": return "bg-mint/20 text-mint border-mint/40";   // fresh discovery — the primary driver
    default: return "bg-cream/5 text-cream/30 border-cream/10";
  }
}

/** Band as a SQL expression, for GROUP BY facet counts. */
export function bandSqlExpr(): string {
  const usd = usdSqlExpr();
  return `CASE WHEN estimated_monthly_sales IS NULL THEN 'New'
    WHEN ${usd} >= 100000 THEN '$100K+'
    WHEN ${usd} >= 25000  THEN '$25K–100K'
    WHEN ${usd} >= 5000   THEN '$5K–25K'
    WHEN ${usd} >= 1000   THEN '$1K–5K'
    WHEN ${usd} >= 100    THEN '$100–1K'
    ELSE '<$100' END`;
}

/** USD monthly-GMV edges per band ([min, max]; max null = open-ended). "New" is the no-data floor —
 *  an honest "up to $10k, probably early-stage" range, not a fabricated point estimate. */
const BAND_USD: Record<RevenueBand, [number, number | null]> = {
  "$100K+": [100000, null], "$25K–100K": [25000, 100000], "$5K–25K": [5000, 25000],
  "$1K–5K": [1000, 5000], "$100–1K": [100, 1000], "<$100": [0, 100],
  "New": [0, 10000], "—": [0, 0],
};
const CCY_SYMBOL: Record<string, string> = { USD: "$", ZAR: "R", NGN: "₦", KES: "KSh" };

/** 1852 → "1.9k", 150000 → "150k", 1.8e6 → "1.8m", 0 → "0". Two significant figures, compact. */
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  for (const [div, suf] of [[1e6, "m"], [1e3, "k"]] as const) {
    if (n >= div) { const v = n / div; return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + suf; }
  }
  return String(Math.round(n));
}

/** The band as a human range in the STORE'S local currency, with the USD range beside it — e.g. a
 *  $1K–5K store in ZA → { local: "R19k–R93k", usd: "$1k–5k" }. We band in USD (one scale across
 *  markets) but merchants think in rands/naira/shillings, so the row shows local first, USD second. */
export function bandDisplay(band: RevenueBand, country: string | null): { local: string; usd: string } {
  const [lo, hi] = BAND_USD[band] ?? [0, 0];
  const ccy = CCY_BY_COUNTRY[(country ?? "").toUpperCase()] ?? "USD";
  const sym = CCY_SYMBOL[ccy] ?? "$";
  const rate = FX[ccy] ?? 1;                 // USD per 1 local unit
  const fmt = (s: string, a: number, b: number | null) => (b == null ? `${s}${compact(a)}+` : `${s}${compact(a)}–${s}${compact(b)}`);
  return {
    local: ccy === "USD" ? fmt("$", lo, hi) : fmt(sym, lo / rate, hi == null ? null : hi / rate),
    usd: fmt("$", lo, hi),
  };
}

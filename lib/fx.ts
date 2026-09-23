/** Currency conversion, shared by the TS row-mapper and the SQL query builder.
 *
 *  This lives in one file on purpose. Revenue is both displayed AND sorted/banded
 *  in SQL, so the rates have to agree in both places — and when they didn't, the
 *  damage was invisible: `FX["zar"]` missed the uppercase-keyed table, fell
 *  through to x1, and left amounts in rands labelled USD (~18.5x high; NGN was
 *  ~1538x). Those inflated rows then won the revenue sort and displaced real ones.
 */

export const FX: Record<string, number> = {
  USD: 1, ZAR: 0.054, NGN: 0.00065, KES: 0.0077,
  GBP: 1.27, EUR: 1.08, AUD: 0.66, CAD: 0.73,
};

export const CCY_BY_COUNTRY: Record<string, string> = {
  ZA: "ZAR", NG: "NGN", KE: "KES", US: "USD", GB: "GBP",
};

/** Currency is stored inconsistently cased ("ZAR" and "zar" both occur), so
 *  every lookup normalises first. */
export function toUsd(sales: number | null, currency: string | null, country: string | null): number | null {
  if (sales == null) return null;
  const ccy = (currency || CCY_BY_COUNTRY[(country ?? "").toUpperCase()] || "USD").toUpperCase();
  return Math.round(sales * (FX[ccy] ?? 1));
}

/** The same conversion as a SQL expression, generated from the table above so the
 *  two can't drift. Returns estimated monthly sales in USD. */
export function usdSqlExpr(): string {
  const ccy = Object.entries(CCY_BY_COUNTRY)
    .map(([c, k]) => `WHEN '${c}' THEN '${k}'`).join(" ");
  const fx = Object.entries(FX)
    .map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(" ");
  return `ROUND(estimated_monthly_sales * (
    CASE upper(COALESCE(NULLIF(currency, ''), CASE upper(COALESCE(country,'')) ${ccy} ELSE 'USD' END))
      ${fx} ELSE 1 END)::numeric)`;
}

/** Revenue bands, recalibrated to the actual distribution of this market.
 *  The previous set opened at "<$10K", which swallowed 96% of stores and left
 *  the top three bands empty. Measured percentiles (USD/month, 24,029 stores):
 *  p50 $125 · p75 $1.1K · p90 $3.2K · p95 $7.2K · p99 $40K · max $1.5M. */
export const REVENUE_BANDS = ["$100K+", "$25K–100K", "$5K–25K", "$1K–5K", "$100–1K", "<$100"] as const;
export type RevenueBand = (typeof REVENUE_BANDS)[number] | "—";

export function revenueBand(n: number | null): RevenueBand {
  if (n == null) return "—";
  if (n >= 1e5) return "$100K+";
  if (n >= 25e3) return "$25K–100K";
  if (n >= 5e3) return "$5K–25K";
  if (n >= 1e3) return "$1K–5K";
  if (n >= 100) return "$100–1K";
  return "<$100";
}

/** Band as a SQL expression, for GROUP BY facet counts. */
export function bandSqlExpr(): string {
  const usd = usdSqlExpr();
  return `CASE WHEN estimated_monthly_sales IS NULL THEN '—'
    WHEN ${usd} >= 100000 THEN '$100K+'
    WHEN ${usd} >= 25000  THEN '$25K–100K'
    WHEN ${usd} >= 5000   THEN '$5K–25K'
    WHEN ${usd} >= 1000   THEN '$1K–5K'
    WHEN ${usd} >= 100    THEN '$100–1K'
    ELSE '<$100' END`;
}

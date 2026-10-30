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
// ZAR-native monthly-GMV bands (set by Joel 2026-10-30). SA is the home market and merchants think
// in rands, so the canonical scale is ZAR, not USD. revenueBand() receives a USD-converted value, so
// the thresholds are the USD equivalents of each rand boundary (× FX.ZAR = 0.054); bandSqlExpr uses
// the same cuts on the SQL USD expression. Headroom to R25m+/mo so enterprise retailers band honestly.
export const REVENUE_BANDS = ["R25m+", "R10m–R25m", "R5m–R10m", "R2.5m–R5m", "R1m–R2.5m", "R500k–R1m", "R250k–R500k", "R100k–R250k", "R0–R100k", "New"] as const;
export type RevenueBand = (typeof REVENUE_BANDS)[number] | "—";

export function revenueBand(n: number | null): RevenueBand {
  if (n == null) return "New";       // n is monthly GMV in USD; thresholds = rand boundary × 0.054
  if (n >= 1_350_000) return "R25m+";
  if (n >= 540_000) return "R10m–R25m";
  if (n >= 270_000) return "R5m–R10m";
  if (n >= 135_000) return "R2.5m–R5m";
  if (n >= 54_000) return "R1m–R2.5m";
  if (n >= 27_000) return "R500k–R1m";
  if (n >= 13_500) return "R250k–R500k";
  if (n >= 5_400) return "R100k–R250k";
  return "R0–R100k";
}

/** Revenue band → pill colour (richest lilac at the top → faint cream at the bottom), used by the
 *  leads table. Co-located with the band scale it colours so the two can't drift apart. */
export function bandTone(band: RevenueBand): string {
  switch (band) {
    case "R25m+": return "bg-lilac/40 text-lilac border-lilac/60";
    case "R10m–R25m": return "bg-lilac/30 text-lilac border-lilac/50";
    case "R5m–R10m": return "bg-lilac/25 text-lilac border-lilac/40";
    case "R2.5m–R5m": return "bg-cyan/20 text-cyan border-cyan/35";
    case "R1m–R2.5m": return "bg-cyan/15 text-cyan border-cyan/30";
    case "R500k–R1m": return "bg-mint/15 text-mint border-mint/30";
    case "R250k–R500k": return "bg-orange/15 text-orange border-orange/30";
    case "R100k–R250k": return "bg-cream/10 text-cream/50 border-cream/15";
    case "New": return "bg-mint/20 text-mint border-mint/40";   // fresh discovery — the primary driver
    default: return "bg-cream/5 text-cream/30 border-cream/10";  // R0–R100k + fallback
  }
}

/** Band as a SQL expression, for GROUP BY facet counts. */
export function bandSqlExpr(): string {
  const usd = usdSqlExpr();
  return `CASE WHEN estimated_monthly_sales IS NULL THEN 'New'
    WHEN ${usd} >= 1350000 THEN 'R25m+'
    WHEN ${usd} >= 540000  THEN 'R10m–R25m'
    WHEN ${usd} >= 270000  THEN 'R5m–R10m'
    WHEN ${usd} >= 135000  THEN 'R2.5m–R5m'
    WHEN ${usd} >= 54000   THEN 'R1m–R2.5m'
    WHEN ${usd} >= 27000   THEN 'R500k–R1m'
    WHEN ${usd} >= 13500   THEN 'R250k–R500k'
    WHEN ${usd} >= 5400    THEN 'R100k–R250k'
    ELSE 'R0–R100k' END`;
}

/** ZAR monthly-GMV edges per band ([min, max] in rand; max null = open-ended). The canonical scale is
 *  ZAR; bandDisplay converts to the store's local currency for non-ZA rows. "New" = no-data floor. */
const BAND_ZAR: Record<RevenueBand, [number, number | null]> = {
  "R25m+": [25e6, null], "R10m–R25m": [10e6, 25e6], "R5m–R10m": [5e6, 10e6], "R2.5m–R5m": [2.5e6, 5e6],
  "R1m–R2.5m": [1e6, 2.5e6], "R500k–R1m": [5e5, 1e6], "R250k–R500k": [25e4, 5e5],
  "R100k–R250k": [1e5, 25e4], "R0–R100k": [0, 1e5], "New": [0, 1e5], "—": [0, 0],
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
  const [loZ, hiZ] = BAND_ZAR[band] ?? [0, 0];
  const ccy = CCY_BY_COUNTRY[(country ?? "").toUpperCase()] ?? "ZAR";
  const sym = CCY_SYMBOL[ccy] ?? "R";
  const rate = FX[ccy] ?? FX.ZAR;            // USD per 1 local unit
  const toLocal = (z: number) => (z * FX.ZAR) / rate;   // ZAR → USD → local (ZA: unchanged)
  const fmt = (s: string, a: number, b: number | null) => (b == null ? `${s}${compact(a)}+` : `${s}${compact(a)}–${s}${compact(b)}`);
  return {
    local: fmt(sym, toLocal(loZ), hiZ == null ? null : toLocal(hiZ)),
    usd: fmt("$", loZ * FX.ZAR, hiZ == null ? null : hiZ * FX.ZAR),
  };
}

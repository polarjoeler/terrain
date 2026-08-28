/** Data layer for the leads Explorer — a StoreInspect-style faceted browser.
 *  Loads every live, published lead with the fields the explorer shows plus a
 *  computed Lead Fit Score, so the client can facet/sort/search instantly. */

import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

export type ExploreLead = {
  domain: string;
  name: string | null;
  category: string | null;
  country: string | null;
  city: string | null;
  theme: string | null;
  payments: string | null;   // semicolon-separated verified gateways
  estMonthlySales: number | null;
  plus: boolean;
  email: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  score: number;         // 0–100 Lead Fit Score
};

// The imported estimated_monthly_sales is in each store's LOCAL currency, so we
// normalise to USD before banding/scoring — otherwise ZAR/NGN/KES are compared
// as if they were dollars. Rough static rates (fine for banding, not accounting).
const FX: Record<string, number> = { USD: 1, ZAR: 0.054, NGN: 0.00065, KES: 0.0077, GBP: 1.27, EUR: 1.08, AUD: 0.66, CAD: 0.73 };
const CCY_BY_COUNTRY: Record<string, string> = { ZA: "ZAR", NG: "NGN", KE: "KES", US: "USD", GB: "GBP" };
function toUsd(sales: number | null, currency: string | null, country: string | null): number | null {
  if (sales == null) return null;
  const ccy = currency || CCY_BY_COUNTRY[(country ?? "").toUpperCase()] || "USD";
  return Math.round(sales * (FX[ccy] ?? 1));
}

/** Transparent 0–100 fit score from the signals we trust: revenue (value),
 *  a reachable email, Shopify Plus, social reach, and recency of discovery. */
function scoreLead(sales: number, email: boolean, plus: boolean, social: number, discoveredAt: Date | null): number {
  let score = 0;
  score += Math.min(45, Math.round((Math.log10(sales + 1) / 7) * 45));      // revenue → up to 45
  if (email) score += 20;                                                     // contactable
  if (plus) score += 15;                                                      // enterprise
  score += Math.min(12, Math.round((Math.log10(social + 1) / 6) * 12));      // social reach
  if (discoveredAt && (Date.now() - new Date(discoveredAt).getTime()) <= 30 * 864e5) score += 8; // fresh
  return Math.max(1, Math.min(100, score));
}

// Cap the initial payload — the client ships every lead for instant faceting, so
// loading all ~13k (3.8MB) made the page slow. The top ~5k by value are the real
// outreach targets (most below that have no sales signal — median is ~500 local).
export async function exploreLeads(limit = 5000): Promise<ExploreLead[]> {
  const rows = await db()<{
    domain: string; name: string | null; category: string | null; country: string | null; city: string | null;
    theme: string | null; payments: string | null;
    estimated_monthly_sales: string | null; currency: string | null; plus: boolean; email: string | null;
    instagram: string | null; facebook: string | null; tiktok: string | null;
    instagram_followers: number | null; facebook_followers: number | null; discovered_at: Date | null;
  }[]>`
    SELECT domain, name, category, country, city, theme, payments, estimated_monthly_sales, currency, plus, email,
           instagram, facebook, tiktok, instagram_followers, facebook_followers, discovered_at
    FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
    ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC
    LIMIT ${limit}`;

  return rows.map((r) => {
    const sales = toUsd(r.estimated_monthly_sales != null ? Number(r.estimated_monthly_sales) : null, r.currency, r.country);
    const social = (r.instagram_followers ?? 0) + (r.facebook_followers ?? 0);
    return {
      domain: r.domain, name: r.name, category: r.category, country: r.country, city: r.city,
      theme: r.theme, payments: r.payments,
      estMonthlySales: sales, plus: r.plus, email: r.email,
      instagram: r.instagram, facebook: r.facebook, tiktok: r.tiktok,
      score: scoreLead(sales ?? 0, !!r.email, r.plus, social, r.discovered_at),
    };
  });
}

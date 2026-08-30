/** Full detail for a single store — every field we know — for the lead drawer.
 *  Kept out of the Explorer's bulk payload (that ships ~13k rows); fetched on click. */

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

export type LeadDetail = {
  domain: string; name: string | null; category: string | null;
  country: string | null; city: string | null;
  theme: string | null; platform: string | null; plus: boolean | null;
  payments: string | null; shipping_providers: string | null; free_shipping: boolean | null;
  logistics_apps: string | null; apps: string | null;
  product_count: number | null; avg_product_price: string | null;
  estimated_monthly_sales: string | null; est_revenue_usd: string | null; currency: string | null;
  email: string | null; contact_email: string | null; contact_phone: string | null;
  instagram: string | null; facebook: string | null; tiktok: string | null;
  instagram_followers: number | null; facebook_followers: number | null;
  launched_at: string | null; launched_source: string | null;
  first_seen: string | null; first_product_at: string | null; discovered_at: string | null;
  source: string | null; live_status: string | null;
};

export async function getLeadDetail(domain: string): Promise<LeadDetail | null> {
  const d = domain.trim().toLowerCase();
  const [r] = await db()<LeadDetail[]>`
    SELECT domain, name, category, country, city, theme, platform, plus,
           payments, shipping_providers, free_shipping, logistics_apps, apps,
           product_count, avg_product_price, estimated_monthly_sales, est_revenue_usd, currency,
           email, contact_email, contact_phone,
           instagram, facebook, tiktok, instagram_followers, facebook_followers,
           launched_at, launched_source, first_seen, first_product_at, discovered_at,
           source, live_status
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  return r ?? null;
}

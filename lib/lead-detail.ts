/** Full detail for a single store — every field we know — for the lead drawer.
 *  Kept out of the Explorer's bulk payload (that ships ~13k rows); fetched on click. */

import { db as sharedDb } from "./db";
import { getStoreGroup, type StoreGroup } from "./store-groups";
import { getStoreBrands, type StoreBrand } from "./brands";

function db() {
  return sharedDb();
}

export type LeadDetail = {
  domain: string; name: string | null; category: string | null;
  country: string | null; city: string | null;
  theme: string | null; platform: string | null; plus: boolean | null; published: boolean | null;
  activity_tier: string | null; activity_score: number | null;   // Woo: real-store reveal
  hosting_provider: string | null; hosting_asn: number | null; platform_version: string | null; plugins: string | null; technologies: string | null;
  payments: string | null; shipping_providers: string | null; free_shipping: boolean | null;
  logistics_apps: string | null; apps: string | null;
  product_count: number | null; avg_product_price: string | null;
  estimated_monthly_sales: string | null; est_revenue_usd: string | null; currency: string | null;
  email: string | null; contact_email: string | null; contact_phone: string | null;
  /** The person behind the store (name/role) + the best-guess personal email and its status —
   *  shown and admin-editable in the drawer. contact_email is the VERIFIED/known address; the guess
   *  is our inferred first@domain for a named decision-maker (kept separate so it never masquerades). */
  contact_name: string | null; contact_role: string | null;
  contact_email_guess: string | null; contact_guess_status: string | null; contact_mx_ok: boolean | null;
  instagram: string | null; facebook: string | null; tiktok: string | null;
  instagram_followers: number | null; facebook_followers: number | null;
  launched_at: string | null; launched_source: string | null;
  first_seen: string | null; first_product_at: string | null; discovered_at: string | null;
  source: string | null; live_status: string | null;
  /** CrUX traffic-rank bucket, the CrUX month it is from (so the drawer can show how fresh the
   *  ranking is) and the move since the previous month we hold. */
  crux_rank: number | null; crux_rank_month: string | null; crux_trend: string | null;
  /** Ballpark revenue band + its confidence (see scripts/revenue-ballpark.mjs). */
  revenue_band: string | null; revenue_confidence: string | null;
  /** Set by /api/lead: the viewer is an admin (may edit; sees vendor estimates). */
  canEdit?: boolean;
  /** Curated tags (store_tags) — shown + editable in the admin drawer. */
  tags: string[];
  /** Other stores run by the same operator (scripts/build-store-groups.mjs), or null. */
  group: StoreGroup | null;
  /** Brands it sells (store_vendors, from its catalogue), biggest first; total = distinct brands. */
  brands: { brands: StoreBrand[]; total: number } | null;
  /** Who BUILT the store — the best partner edge (scripts/attribute-partners.mjs), or null. This is
   *  Fundi's differentiator: what the crawler actually saw on the page, not what an agency claims.
   *  `confirmed` = a strong signal (self-declared portfolio / linked public credit); weaker signals
   *  (text credit, generator/theme, code comment) surface as unconfirmed until verified. */
  builtBy: { name: string; website: string | null; source: string; confidence: string; confirmed: boolean } | null;
};

/** The single best builder→store edge for a store, or null. Confidence-ranked, confirmed first. */
export async function getStoreBuilder(domain: string): Promise<LeadDetail["builtBy"]> {
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  const [r] = await db()<{ name: string; website_url: string | null; source: string; confidence: string; published: boolean }[]>`
    SELECT sp.name, sp.website_url, ps.source, ps.confidence, ps.published
    FROM partner_stores ps JOIN service_partners sp ON sp.id = ps.partner_id
    WHERE ps.store_domain = ${d}
    ORDER BY ps.published DESC,
      CASE ps.confidence WHEN 'declared' THEN 6 WHEN 'declared_title' THEN 5 WHEN 'public_credit' THEN 4
        WHEN 'comment_credit' THEN 3 WHEN 'theme_author' THEN 2 ELSE 1 END DESC
    LIMIT 1`;
  if (!r || !r.name) return null;
  const website = r.website_url && /^https?:\/\//i.test(r.website_url) ? r.website_url
    : r.website_url ? `https://${r.website_url}` : null;
  return { name: r.name, website, source: r.source, confidence: r.confidence, confirmed: Boolean(r.published) };
}

export async function getLeadDetail(domain: string): Promise<LeadDetail | null> {
  const d = domain.trim().toLowerCase();
  const [r] = await db()<LeadDetail[]>`
    SELECT domain, name, category, country, city, theme, platform, plus, published,
           activity_tier, activity_score, hosting_provider, hosting_asn, platform_version, plugins, technologies,
           payments, shipping_providers, free_shipping, logistics_apps, apps,
           product_count, avg_product_price, estimated_monthly_sales, est_revenue_usd, currency,
           email, contact_email, contact_phone,
           instagram, facebook, tiktok, instagram_followers, facebook_followers,
           launched_at, launched_source, first_seen, first_product_at, discovered_at,
           source, live_status,
           crux_rank, crux_rank_month, crux_trend, revenue_band, revenue_confidence,
           COALESCE((SELECT array_agg(tag ORDER BY tag) FROM store_tags WHERE store_tags.domain = imported_stores.domain), '{}') AS tags
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  if (!r) return null;
  // Sequential, not Promise.all: the shared pool is small (see memory: postgres-pool-deadlock). A
  // missing or failing group lookup never costs the drawer the rest of the store.
  r.group = await getStoreGroup(d).catch(() => null);
  r.brands = await getStoreBrands(d).catch(() => null);
  r.builtBy = await getStoreBuilder(d).catch(() => null);
  return r;
}

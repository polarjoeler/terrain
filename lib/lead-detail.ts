/** Full detail for a single store — every field we know — for the lead drawer.
 *  Kept out of the Explorer's bulk payload (that ships ~13k rows); fetched on click. */

import { db as sharedDb } from "./db";

function db() {
  return sharedDb();
}

export type LeadDetail = {
  domain: string; name: string | null; category: string | null;
  country: string | null; city: string | null;
  theme: string | null; platform: string | null; plus: boolean | null;
  activity_tier: string | null; activity_score: number | null;   // Woo: real-store reveal
  hosting_provider: string | null; hosting_asn: number | null; platform_version: string | null; plugins: string | null;
  payments: string | null; shipping_providers: string | null; free_shipping: boolean | null;
  logistics_apps: string | null; apps: string | null;
  product_count: number | null; avg_product_price: string | null;
  estimated_monthly_sales: string | null; est_revenue_usd: string | null; currency: string | null;
  email: string | null; contact_email: string | null; contact_phone: string | null;
  /** Contact quality (scripts/contact-enrich.mjs): the verdict on the best address we found,
   *  the whole ranked set, and the person behind it when the site names one. */
  contact_type: string | null; contact_source: string | null;
  contact_name: string | null; contact_name_source: string | null; contact_role: string | null;
  contact_form_url: string | null; contact_checked_at: string | null;
  contacts: { email: string; kind: string; source: string }[] | null;
  whatsapp: string | null; linkedin: string | null;
  contact_mx_ok: boolean | null; contact_mx_provider: string | null; contact_shared_count: number | null;
  /** An INFERRED address (scripts/contact-permute.mjs) — never conflated with contact_email,
   *  which is always an address the merchant actually published. */
  contact_email_guess: string | null; contact_guess_status: string | null;
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
  /** Per-store CHANGE HISTORY (monitoring signal): payment-provider changes (payment_changes,
   *  written by sync-checkout-payments) and platform migrations (churn_log, written by verify-liveness). */
  payment_history: { changed_at: string; added: string | null; removed: string | null; old_primary: string | null; new_primary: string | null; reordered: boolean | null }[];
  migrations: { changed_at: string; status: string | null; migrated_to: string | null }[];
};

export async function getLeadDetail(domain: string): Promise<LeadDetail | null> {
  const d = domain.trim().toLowerCase();
  const [r] = await db()<LeadDetail[]>`
    SELECT domain, name, category, country, city, theme, platform, plus,
           activity_tier, activity_score, hosting_provider, hosting_asn, platform_version, plugins,
           payments, shipping_providers, free_shipping, logistics_apps, apps,
           product_count, avg_product_price, estimated_monthly_sales, est_revenue_usd, currency,
           email, contact_email, contact_phone,
           contact_type, contact_source, contact_name, contact_name_source, contact_role,
           contact_form_url, contact_checked_at, contacts, whatsapp, linkedin,
           contact_mx_ok, contact_mx_provider, contact_shared_count,
           contact_email_guess, contact_guess_status,
           instagram, facebook, tiktok, instagram_followers, facebook_followers,
           launched_at, launched_source, first_seen, first_product_at, discovered_at,
           source, live_status,
           crux_rank, crux_rank_month, crux_trend, revenue_band, revenue_confidence
    FROM imported_stores WHERE domain = ${d} LIMIT 1`;
  if (!r) return null;
  // Change history — sequential (never Promise.all on the small pool). Match www + bare.
  const doms = [d, d.replace(/^www\./, "")];
  const payment_history = (await db()`
    SELECT changed_at, added, removed, old_primary, new_primary, reordered
    FROM payment_changes WHERE domain = ANY(${doms}) ORDER BY changed_at DESC LIMIT 20`) as LeadDetail["payment_history"];
  const migrations = (await db()`
    SELECT churned_at AS changed_at, status, migrated_to
    FROM churn_log WHERE domain = ANY(${doms}) AND (status = 'migrated' OR migrated_to IS NOT NULL)
    ORDER BY churned_at DESC LIMIT 10`) as LeadDetail["migrations"];
  return { ...r, payment_history, migrations };
}

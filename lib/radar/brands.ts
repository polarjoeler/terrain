/** Enrolled brands — the fingerprint-on-file that turns a one-off Brand Audit
 *  into ongoing monitoring.
 *
 *  When a brand runs an audit we already compute its catalogue fingerprint; here
 *  we persist it (plus the official-domain allowlist and trademark) as a standing
 *  reference. The monitoring side then matches every newly-discovered store
 *  against these rows — so a clone is caught as it appears, with the brand's own
 *  domains excluded from the start.
 */

import { db, ensureSchema } from "./db";
import { cleanDomain, compare, type Fingerprint, type MatchReport } from "./catalog";
import type { Market } from "../prioritize";

export type BrandEnrollment = {
  brandDomain: string;
  brandName: string | null;
  market: Market;
  email?: string | null;
  officialDomains?: string[]; // allowlist — never flagged
  trademark?: string | null;
};

/** Persist (or refresh) a brand's reference fingerprint + allowlist. Idempotent:
 *  re-running an audit updates the stored fingerprint to the latest catalogue. */
export async function enrollBrand(e: BrandEnrollment, fp: Fingerprint): Promise<void> {
  await ensureSchema();
  const brand = cleanDomain(e.brandDomain);
  // Always allowlist the brand's own domain alongside any extras it declared.
  const allow = [...new Set([brand, ...(e.officialDomains ?? []).map(cleanDomain)])].filter(Boolean);
  await db()`
    INSERT INTO radar_brands (
      brand_domain, brand_name, market, email, official_domains, trademark,
      n_products, image_stems, skus, handles, titles, price_by_handle,
      monitoring, fingerprinted_at
    ) VALUES (
      ${brand}, ${e.brandName ?? null}, ${e.market}, ${e.email ?? null},
      ${db().json(allow)}, ${e.trademark ?? null},
      ${fp.nProducts}, ${db().json([...fp.imageStems])}, ${db().json([...fp.skus])},
      ${db().json([...fp.handles])}, ${db().json([...fp.titles])},
      ${db().json(Object.fromEntries(fp.priceByHandle))}, true, now()
    )
    ON CONFLICT (brand_domain) DO UPDATE SET
      brand_name       = EXCLUDED.brand_name,
      market           = EXCLUDED.market,
      email            = COALESCE(EXCLUDED.email, radar_brands.email),
      -- Merge allowlists so a later audit never drops a domain added earlier.
      official_domains = (
        SELECT jsonb_agg(DISTINCT d)
        FROM jsonb_array_elements_text(radar_brands.official_domains || EXCLUDED.official_domains) AS d
      ),
      trademark        = COALESCE(EXCLUDED.trademark, radar_brands.trademark),
      n_products       = EXCLUDED.n_products,
      image_stems      = EXCLUDED.image_stems,
      skus             = EXCLUDED.skus,
      handles          = EXCLUDED.handles,
      titles           = EXCLUDED.titles,
      price_by_handle  = EXCLUDED.price_by_handle,
      fingerprinted_at = now()
  `;
}

export type MonitoredBrand = {
  brandDomain: string;
  brandName: string | null;
  market: string;
  officialDomains: string[];
  fp: Fingerprint;
};

/** Load monitored brands (optionally for one market) with their fingerprints. */
export async function loadMonitoredBrands(market?: Market): Promise<MonitoredBrand[]> {
  await ensureSchema();
  const rows = await db()<
    {
      brand_domain: string;
      brand_name: string | null;
      market: string;
      official_domains: string[];
      n_products: number;
      image_stems: string[];
      skus: string[];
      handles: string[];
      titles: string[];
      price_by_handle: Record<string, number>;
    }[]
  >`
    SELECT brand_domain, brand_name, market, official_domains, n_products,
           image_stems, skus, handles, titles, price_by_handle
    FROM radar_brands
    WHERE monitoring AND n_products > 0
      ${market ? db()`AND market = ${market}` : db()``}
  `;
  return rows.map((r) => ({
    brandDomain: r.brand_domain,
    brandName: r.brand_name,
    market: r.market,
    officialDomains: r.official_domains ?? [],
    fp: {
      domain: r.brand_domain,
      nProducts: r.n_products,
      imageStems: new Set(r.image_stems),
      skus: new Set(r.skus),
      handles: new Set(r.handles),
      titles: new Set(r.titles),
      priceByHandle: new Map(Object.entries(r.price_by_handle)),
    },
  }));
}

/** Reverse match: given a freshly-discovered store's fingerprint, return every
 *  monitored brand it appears to be copying (score ≥ minScore). This is the
 *  monitoring hook — call it per new store instead of re-scanning per brand. */
export async function matchStoreAgainstBrands(
  suspectFp: Fingerprint,
  minScore = 25,
): Promise<MatchReport[]> {
  if (suspectFp.nProducts === 0) return [];
  const suspect = cleanDomain(suspectFp.domain);
  const brands = await loadMonitoredBrands();
  const hits: MatchReport[] = [];
  for (const b of brands) {
    if (b.officialDomains.includes(suspect)) continue; // the brand's own store
    const rep = compare(b.fp, suspectFp);
    if (rep.score >= minScore) {
      rep.suspectName = suspectFp.domain;
      hits.push(rep);
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

export async function monitoredBrandCount(): Promise<number> {
  await ensureSchema();
  const [r] = await db()`SELECT COUNT(*)::int AS n FROM radar_brands WHERE monitoring`;
  return Number(r?.n ?? 0);
}

/* ---- customer subscriptions -------------------------------------------------- */

export type BrandAccount = {
  brandDomain: string;
  brandName: string | null;
  market: string;
  status: string | null; // subscription_status
  currentPeriodEnd: string | null;
  fingerprintedAt: string;
};

/** An active (or trialing) Radar monitoring subscription unlocks the dashboard. */
export const hasActiveMonitoring = (status: string | null | undefined) =>
  status === "active" || status === "trialing";

/** The brands enrolled under a signed-in customer's email. */
export async function brandsForEmail(email: string): Promise<BrandAccount[]> {
  await ensureSchema();
  const rows = await db()<
    {
      brand_domain: string;
      brand_name: string | null;
      market: string;
      subscription_status: string | null;
      current_period_end: Date | null;
      fingerprinted_at: Date;
    }[]
  >`
    SELECT brand_domain, brand_name, market, subscription_status, current_period_end, fingerprinted_at
    FROM radar_brands WHERE lower(email) = ${email.toLowerCase()}
    ORDER BY fingerprinted_at DESC`;
  return rows.map((r) => ({
    brandDomain: r.brand_domain,
    brandName: r.brand_name,
    market: r.market,
    status: r.subscription_status,
    currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end).toISOString() : null,
    fingerprintedAt: new Date(r.fingerprinted_at).toISOString(),
  }));
}

/** Persist a Stripe subscription state onto a brand (called by the webhook). */
export async function setBrandSubscription(
  brandDomain: string,
  s: {
    customerId?: string | null;
    subscriptionId?: string | null;
    status?: string | null;
    currentPeriodEnd?: string | null;
  },
): Promise<void> {
  await ensureSchema();
  await db()`
    UPDATE radar_brands SET
      stripe_customer_id     = COALESCE(${s.customerId ?? null}, stripe_customer_id),
      stripe_subscription_id = COALESCE(${s.subscriptionId ?? null}, stripe_subscription_id),
      subscription_status    = ${s.status ?? null},
      current_period_end     = ${s.currentPeriodEnd ?? null}
    WHERE brand_domain = ${cleanDomain(brandDomain)}`;
}

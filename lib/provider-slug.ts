/** URL slugs for provider dashboards. Client-safe (no node:crypto) so both the
 *  server route and the client view can build the same links — keep it out of
 *  lib/provider-share.ts, which pulls in node crypto and can't be bundled.
 *
 *  Gateway names come from the checkout probe verbatim ("Peach Payments",
 *  "M-Pesa"), so a name can carry spaces that don't belong in a path. */

import { KNOWN_PROVIDERS } from "./payments-taxonomy";

/** "Peach Payments" → "peach-payments" */
export function providerSlug(provider: string): string {
  return provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Does a slug from the URL address this provider? Accepts the slug form AND the
 *  older raw-lowercase form ("/p/paystack", "/p/peach%20payments") so share links
 *  already handed out keep resolving. */
export function matchesProviderSlug(provider: string, slug: string): boolean {
  let raw = slug;
  try { raw = decodeURIComponent(slug); } catch { /* malformed %-escape — match on the literal */ }
  return providerSlug(raw) === providerSlug(provider);
}

/** Display name from a slug, for metadata that runs before we've resolved the
 *  canonical name from the data. Prefers the taxonomy's own casing so the tab
 *  reads "PayFast" and "Instant EFT", not "Payfast"/"Instant Eft"; falls back to
 *  title-case for gateways the taxonomy doesn't list yet. */
export function slugToTitle(slug: string): string {
  const known = KNOWN_PROVIDERS.find((n) => providerSlug(n) === providerSlug(slug));
  if (known) return known;
  return slug.split(/[-\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

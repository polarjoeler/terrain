/** One canonical spelling per app, applied at the write boundary.
 *
 *  The `apps` column carries TWO disjoint populations, from different feeders, and the
 *  read path only understood one of them:
 *    - URL form  — "https://apps.shopify.com/inbox"            11,562 rows
 *    - NAME form — "Sticky Add To Cart Bar Pro"                10,260 rows
 *  `cleanApps()` in leads-explore.ts extracts app-store slugs and returns null when it
 *  finds none, so every name-form row was silently dropped on read — 47% of the rows that
 *  have app data at all. No row carries both forms, so this is a feeder split, not a mix.
 *
 *  Values are also joined with EITHER ';' or '|' (6,468 rows use '|'), which is why a
 *  naive split on ';' reports ~13,900 distinct "apps": the pipe-joined runs count as one
 *  giant value each. Split on both and the real vocabulary is ~2,400 — small enough to
 *  categorise, which is the point of normalising.
 */

/** Slugs that appear in app-store URLs but are not installed apps. */
const APP_SKIP = new Set(["partners", "collections", "browse", "categories", "stores", "search"]);

/** Slug → the name people recognise. Extends the read-path list; anything absent is
 *  title-cased from its slug, which is right for most ("pagefly" → "Pagefly"). */
const APP_ALIAS: Record<string, string> = {
  inbox: "Shopify Inbox", "product-reviews": "Shopify Reviews", geolocation: "Shopify Geolocation",
  "shopify-forms": "Shopify Forms", "shopify-email": "Shopify Email", "shopify-search-and-discovery": "Shopify Search & Discovery",
  judgeme: "Judge.me", "judge-me-product-reviews-testimonials": "Judge.me",
  "klaviyo-email-marketing": "Klaviyo", "customer-privacy-banner": "Privacy Banner",
  "whatsapp-chat-for-support": "WhatsApp Chat", instafeed: "Instafeed", pagefly: "PageFly",
  omnisend: "Omnisend", mailchimp: "Mailchimp", "printful-print-on-demand": "Printful",
  "ecomposer-landing-page-builder": "EComposer", "seal-subscriptions": "Seal Subscriptions",
  "recharge-subscriptions": "Recharge", "bold-subscriptions": "Bold Subscriptions",
};

/** Canonicalise one raw value (URL or name) → display name, or null to drop it. */
function canonOne(part: string): string | null {
  const v = part.trim().replace(/\s+/g, " ");
  if (!v) return null;
  const m = v.match(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/i);
  if (m) {
    const slug = m[1].toLowerCase();
    if (APP_SKIP.has(slug)) return null;
    return APP_ALIAS[slug] ?? slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  // Name form. A bare URL we don't recognise is not an app name — drop it rather than
  // show a link in a facet. Everything else is kept as written, whitespace-collapsed.
  if (/^https?:\/\//i.test(v)) return null;
  return v;
}

/** Canonical `;`-delimited app list for a raw column value.
 *  Splits on BOTH delimiters, canonicalises each part, de-duplicates case-insensitively
 *  (keeping the first spelling seen), and rejoins with a single ';'. */
export function canonicalApps(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[;|]/)) {
    const name = canonOne(part);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length ? out.join(";") : null;
}

/** Parse a canonical (or raw) value into app names — for facets and categorisation. */
export function appList(raw: string | null | undefined): string[] {
  const c = canonicalApps(raw);
  return c ? c.split(";") : [];
}

/** `technologies` has the same disease with a different delimiter: values are ';'-joined,
 *  but detector output also concatenates with ':' — "Cloudflare CDN:Facebook Pixel",
 *  "Cloudflare CDN:YouTube Player". That is why it reports 5,789 distinct values; split on
 *  both and the real vocabulary is far smaller, and head-heavy enough to categorise
 *  (top 25 = 86.5% of store-tech pairs, top 100 = 90.8%).
 *
 *  This is the column worth building a technology taxonomy on, not `apps`: it is
 *  self-sourced (deep-enrich TECH_FP + the Woo plugin probe) rather than vendor-only, it
 *  covers 53,940 stores, and its head already spans payments, marketing, analytics and CDN. */
/** Product names that legitimately contain a colon. Belt-and-braces alongside the
 *  capital-letter rule below, for capitalisation variants like "Re:Amaze". */
const COLON_NAMES = [/^re:a?maze$/i];

/** Split a technologies string. Delimiters are ';' and '|' outright. ':' is a delimiter
 *  ONLY when followed by a capital — measured across 3,633 colon-containing tokens, every
 *  concatenation joins capitalised names ("Cloudflare CDN:Facebook Pixel", ":Google
 *  Analytics", ":Judge.me") while the one real colon-name, Re:amaze (1,897 rows), is
 *  lowercase after the colon. Splitting on every ':' turned it into "Re;amaze". */
function splitTech(raw: string): string[] {
  return raw
    .split(/[;|]/)
    .flatMap((chunk) => (COLON_NAMES.some((re) => re.test(chunk.trim())) ? [chunk] : chunk.split(/:(?=[A-Z])/)));
}

export function canonicalTechnologies(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of splitTech(raw)) {
    const v = part.trim().replace(/\s+/g, " ");
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.length ? out.join(";") : null;
}

export function techList(raw: string | null | undefined): string[] {
  const c = canonicalTechnologies(raw);
  return c ? c.split(";") : [];
}

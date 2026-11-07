/**
 * Canonical "what tech does this store run" — the one place that merges our three
 * provenance-split columns into a single deduped, display-ready stack.
 *
 *   apps          Shopify App Store installs, stored as raw apps.shopify.com/<slug> URLs
 *                 (often concatenated). SHOPIFY-ONLY — a non-Shopify store has none by
 *                 definition, so reading `apps` alone reads ~0% there. That emptiness is
 *                 not a coverage gap; it is the wrong column.
 *   technologies  cross-platform JS / vendor fingerprints (Klaviyo, Gorgias, Meta Pixel…),
 *                 already clean names, ';'-separated. Filled for ~56% Shopify / ~89% non-Shopify.
 *   plugins       WP/Woo/PrestaShop module slugs (wp-content/plugins/<slug>, /modules/<slug>),
 *                 ';'-separated. Non-Shopify only.
 *
 * A non-Shopify store's entire stack lives in technologies+plugins. Any surface that reads
 * `apps` on its own (a drawer section, a facet, a coverage metric, an onboarding agent
 * querying the DB) will wrongly conclude the store has no apps. Read THIS instead.
 */

type TechRow = { apps?: string | null; technologies?: string | null; plugins?: string | null };

// apps.shopify.com slugs that are navigation, not installed apps.
const APP_SKIP = new Set(["partners", "collections", "browse", "categories", "stores"]);

// Public app slugs with a nicer display name than a naive title-case.
const APP_ALIAS: Record<string, string> = {
  inbox: "Shopify Inbox", "product-reviews": "Shopify Reviews", geolocation: "Shopify Geolocation",
  judgeme: "Judge.me", "klaviyo-email-marketing": "Klaviyo", "customer-privacy-banner": "Privacy Banner",
  "whatsapp-chat-for-support": "WhatsApp Chat", instafeed: "Instafeed", pagefly: "PageFly",
  omnisend: "Omnisend", mailchimp: "Mailchimp",
};

const titleCase = (slug: string) =>
  slug.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

const split = (raw: string | null | undefined) =>
  (raw ?? "").split(";").map((s) => s.trim()).filter(Boolean);

/** apps.shopify.com URLs → clean app names (falls back to pass-through for already-clean names). */
export function appNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const slugs = [...raw.matchAll(/apps\.shopify\.com\/([a-z0-9][a-z0-9-]*)/gi)]
    .map((m) => m[1].toLowerCase()).filter((s) => !APP_SKIP.has(s));
  if (slugs.length) return slugs.map((s) => APP_ALIAS[s] ?? titleCase(s));
  // Already clean, ';'-separated names (e.g. from a snapshot) — keep plausible ones.
  return split(raw).filter((x) => /^[A-Za-z][A-Za-z0-9 .&'-]{1,28}$/.test(x));
}

/** technologies column — already human names; pass through. */
export function techNames(raw: string | null | undefined): string[] {
  return split(raw);
}

/** WP/Woo/Presta plugin/module slugs → readable names. */
export function pluginNames(raw: string | null | undefined): string[] {
  return split(raw).filter((s) => s.length >= 3 && !APP_SKIP.has(s.toLowerCase()))
    .map((s) => (/[A-Z ]/.test(s) ? s : titleCase(s)));
}

/**
 * The store's whole stack as one deduped, display-ready list — apps, then cross-platform
 * tech, then plugins. Case/space/punctuation-insensitive de-dup so "WooCommerce" (tech) and
 * "woocommerce" (plugin) collapse to one chip.
 */
export function normalizeTechStack(row: TechRow): string[] {
  const seen = new Map<string, string>();
  for (const name of [...appNames(row.apps), ...techNames(row.technologies), ...pluginNames(row.plugins)]) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key && !seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

export const hasTech = (row: TechRow): boolean => normalizeTechStack(row).length > 0;

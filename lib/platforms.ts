/** Ecommerce-platform registry — the single source of truth for every platform Terrain
 *  tracks and how it surfaces. Adding a platform (Wix, Adobe Commerce, BigCommerce, …) is
 *  ONE entry here; the dashboard, Explorer, snapshot gate, and insights all read from this.
 *
 *  `customerVisible` is the launch gate: a platform stays admin-only until its dataset is
 *  thick enough to be credible (we don't ship 57 Woo stores next to 22k Shopify). Flip the
 *  flag (or the NEXT_PUBLIC_VISIBLE_PLATFORMS env override, for a dark launch to testers)
 *  when a platform is ready — no other code changes needed.
 */

export type PlatformId = "shopify" | "woocommerce" | "wix" | "adobe_commerce";

export type Platform = {
  id: PlatformId;
  label: string;
  emoji: string;
  /** DB `platform` column values that map to this platform (probes/imports aren't uniform). */
  dbValues: string[];
  /** Shown on customer-facing surfaces? Admin always sees every platform. */
  customerVisible: boolean;
  /** Has the selling / active / dormant / not-a-store "is it a REAL store" reveal. */
  hasActivityTiers: boolean;
};

export const PLATFORMS: Platform[] = [
  { id: "shopify",        label: "Shopify",        emoji: "🛍️", dbValues: ["Shopify", "shopify"], customerVisible: true,  hasActivityTiers: false },
  { id: "woocommerce",    label: "WooCommerce",    emoji: "🪵", dbValues: ["woocommerce", "WooCommerce"], customerVisible: false, hasActivityTiers: true },
  { id: "wix",            label: "Wix",            emoji: "🧩", dbValues: ["wix", "Wix"], customerVisible: false, hasActivityTiers: true },
  { id: "adobe_commerce", label: "Adobe Commerce", emoji: "🅰️", dbValues: ["adobe_commerce", "magento", "Magento"], customerVisible: false, hasActivityTiers: true },
];

const BY_DBVALUE = new Map<string, Platform>();
for (const p of PLATFORMS) for (const v of p.dbValues) BY_DBVALUE.set(v.toLowerCase(), p);

/** The platform a raw DB `platform` value belongs to (null-safe; unknown/NULL → undefined). */
export function platformFromDbValue(v: string | null | undefined): Platform | undefined {
  if (!v) return undefined;
  return BY_DBVALUE.get(v.toLowerCase());
}

/** Display label for a raw DB value (falls back to the raw value, then "Shopify" for NULL —
 *  NULL platform is an unconfirmed CT discovery, which is Shopify-first in our pipeline). */
export function platformLabel(v: string | null | undefined): string {
  return platformFromDbValue(v)?.label ?? (v ?? "Shopify");
}

/** Optional dark-launch override: NEXT_PUBLIC_VISIBLE_PLATFORMS="shopify,woocommerce".
 *  When set, it REPLACES the registry's customerVisible flags (so you can preview a platform
 *  for testers without a code change). Unset → the registry flags apply. */
function visibleOverride(): Set<PlatformId> | null {
  const raw = process.env.NEXT_PUBLIC_VISIBLE_PLATFORMS;
  if (!raw) return null;
  const ids = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set(ids.filter((id): id is PlatformId => PLATFORMS.some((p) => p.id === id)));
}

/** Is this platform (by id) shown to customers right now? */
export function isPlatformCustomerVisible(id: PlatformId): boolean {
  const ov = visibleOverride();
  return ov ? ov.has(id) : (PLATFORMS.find((p) => p.id === id)?.customerVisible ?? false);
}

/** Platforms shown to customers right now. */
export function customerVisiblePlatforms(): Platform[] {
  return PLATFORMS.filter((p) => isPlatformCustomerVisible(p.id));
}

/** DB `platform` values that should be HIDDEN from customer surfaces (every value of every
 *  not-yet-visible platform). NULL/unknown platforms are never hidden — they're Shopify-first
 *  CT discoveries. Used to gate the customer browse snapshot. */
export function hiddenPlatformDbValues(): string[] {
  return PLATFORMS.filter((p) => !isPlatformCustomerVisible(p.id)).flatMap((p) => p.dbValues);
}

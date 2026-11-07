/** Declared service markets per payment provider — the countries where a PSP actually operates,
 *  independent of how many stores we've so far detected it on. This is the single source of truth for
 *  a provider page's country dropdown and its "share of new stores" acquisition scope, so a provider
 *  shows (and is measured over) its REAL markets even where our detection is still thin — e.g. Peach
 *  in Kenya / Mauritius, where the PSP is live but we've verified only a handful of stores so far.
 *
 *  Keyed by canonical provider name, lowercased. Add a provider here to give it declared markets;
 *  anything not listed falls back to detected-countries-only (the prior behaviour). Seeded with the
 *  ones we're sure of — extend as we confirm others.
 */
import { canonicalProvider } from "./payments-taxonomy";

const DECLARED: Record<string, string[]> = {
  // Peach Payments — SA home market plus Kenya and Mauritius. (Joel, 2026-11-05)
  "peach payments": ["ZA", "KE", "MU"],
  // Paystack — Nigeria (home), Ghana, South Africa, Kenya, Côte d'Ivoire, Egypt (official markets).
  paystack: ["NG", "GH", "ZA", "KE", "CI", "EG"],
};

/** Declared service markets (ISO2, upper-cased) for a provider, or [] if none are declared. */
export function declaredMarkets(provider: string): string[] {
  const key = (canonicalProvider(provider) || provider).toLowerCase();
  return DECLARED[key] ?? [];
}

/** Dropdown markets = declared ∪ detected, declared first so a provider's real markets always appear
 *  even with thin detection, then any extra detected markets; de-duped and upper-cased. */
export function mergeMarkets(detected: string[], declared: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...declared, ...detected]) {
    const u = (c || "").toUpperCase();
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

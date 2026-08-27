/** Pure, client-safe banding helpers for the leads Explorer — revenue bands and
 *  Lead Fit Score colours. No DB imports, so client components can use them. */

export const REVENUE_BANDS = ["$10M+", "$2M–10M", "$500K–2M", "$100K–500K", "$10K–100K", "<$10K"] as const;
export type RevenueBand = (typeof REVENUE_BANDS)[number] | "—";

export function revenueBand(n: number | null): RevenueBand {
  if (n == null) return "—";
  if (n >= 1e7) return "$10M+";
  if (n >= 2e6) return "$2M–10M";
  if (n >= 5e5) return "$500K–2M";
  if (n >= 1e5) return "$100K–500K";
  if (n >= 1e4) return "$10K–100K";
  return "<$10K";
}

/** Tailwind tone for a revenue band chip (matches the app palette). */
export function bandTone(band: RevenueBand): string {
  switch (band) {
    case "$10M+": return "bg-lilac/25 text-lilac border-lilac/40";
    case "$2M–10M": return "bg-lilac/20 text-lilac border-lilac/30";
    case "$500K–2M": return "bg-cyan/15 text-cyan border-cyan/30";
    case "$100K–500K": return "bg-mint/15 text-mint border-mint/30";
    case "$10K–100K": return "bg-orange/15 text-orange border-orange/30";
    case "<$10K": return "bg-cream/10 text-cream/50 border-cream/15";
    default: return "bg-cream/5 text-cream/30 border-cream/10";
  }
}

/** Lead Fit Score → ring colour (green best → orange lowest). */
export function scoreColor(s: number): string {
  if (s >= 70) return "var(--color-mint)";
  if (s >= 45) return "var(--color-cyan)";
  if (s >= 25) return "var(--color-orange)";
  return "var(--color-cream)";
}

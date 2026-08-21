/** Pure tag definitions — safe to import from client components (no DB deps). */

export const PRESET_TAGS: { key: string; label: string }[] = [
  { key: "top-100", label: "Top 100" },
  { key: "top-1000", label: "Top 1000" },
  { key: "partner-managed", label: "Partner Managed" },
];

// Dynamic (computed) cohorts — not manual tags, but selectable in Insights.
export const DYNAMIC_COHORTS: Record<string, string> = {
  new: "Brand New Stores",
};

export const tagLabel = (key: string) =>
  PRESET_TAGS.find((t) => t.key === key)?.label ?? DYNAMIC_COHORTS[key] ?? key;

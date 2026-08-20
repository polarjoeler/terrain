/** Pure tag definitions — safe to import from client components (no DB deps). */

export const PRESET_TAGS: { key: string; label: string }[] = [
  { key: "top-100", label: "Top 100" },
  { key: "top-1000", label: "Top 1000" },
  { key: "partner-managed", label: "Partner Managed" },
];

export const tagLabel = (key: string) =>
  PRESET_TAGS.find((t) => t.key === key)?.label ?? key;

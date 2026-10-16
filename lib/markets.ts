/** Country/market presentation — flag emoji, display name, and adjective — for
 *  the market selectors on the dashboard and insights. Shared so both agree. */

// Markets shown in customer-facing surfaces (dashboard, insights, pickers). We store
// stores GLOBALLY (CT tailer is global), but only surface these until we launch more.
// Every customer query filters to this set; everything else stays in the DB, hidden.
export const VISIBLE_MARKETS = ["ZA", "KE", "NG"] as const;

// Every market we actively enrich + are willing to surface in the insights country picker (the picker
// then shows only those that clear a live-store threshold). Africa focus + Japan. Still a curated set,
// not "every country on earth" — the DB holds stores globally but an unbounded country scan is too
// expensive on the pooled instance (see availableCountries).
export const FOCUS_MARKETS = [
  "ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ", "JP",
] as const;

export const MARKETS: Record<string, { name: string; emoji: string; adjective: string }> = {
  ZA: { name: "South Africa", emoji: "🇿🇦", adjective: "South African" },
  NG: { name: "Nigeria", emoji: "🇳🇬", adjective: "Nigerian" },
  KE: { name: "Kenya", emoji: "🇰🇪", adjective: "Kenyan" },
  EG: { name: "Egypt", emoji: "🇪🇬", adjective: "Egyptian" },
  MA: { name: "Morocco", emoji: "🇲🇦", adjective: "Moroccan" },
  GH: { name: "Ghana", emoji: "🇬🇭", adjective: "Ghanaian" },
  TZ: { name: "Tanzania", emoji: "🇹🇿", adjective: "Tanzanian" },
  UG: { name: "Uganda", emoji: "🇺🇬", adjective: "Ugandan" },
  JP: { name: "Japan", emoji: "🇯🇵", adjective: "Japanese" },
  DZ: { name: "Algeria", emoji: "🇩🇿", adjective: "Algerian" },
  TN: { name: "Tunisia", emoji: "🇹🇳", adjective: "Tunisian" },
  CI: { name: "Côte d’Ivoire", emoji: "🇨🇮", adjective: "Ivorian" },
  SN: { name: "Senegal", emoji: "🇸🇳", adjective: "Senegalese" },
  MU: { name: "Mauritius", emoji: "🇲🇺", adjective: "Mauritian" },
  MZ: { name: "Mozambique", emoji: "🇲🇿", adjective: "Mozambican" },
  CM: { name: "Cameroon", emoji: "🇨🇲", adjective: "Cameroonian" },
  BW: { name: "Botswana", emoji: "🇧🇼", adjective: "Botswanan" },
  AO: { name: "Angola", emoji: "🇦🇴", adjective: "Angolan" },
  NA: { name: "Namibia", emoji: "🇳🇦", adjective: "Namibian" },
  RW: { name: "Rwanda", emoji: "🇷🇼", adjective: "Rwandan" },
  ZM: { name: "Zambia", emoji: "🇿🇲", adjective: "Zambian" },
  ET: { name: "Ethiopia", emoji: "🇪🇹", adjective: "Ethiopian" },
  ZW: { name: "Zimbabwe", emoji: "🇿🇼", adjective: "Zimbabwean" },
  LY: { name: "Libya", emoji: "🇱🇾", adjective: "Libyan" },
  MW: { name: "Malawi", emoji: "🇲🇼", adjective: "Malawian" },
  SO: { name: "Somalia", emoji: "🇸🇴", adjective: "Somali" },
  LS: { name: "Lesotho", emoji: "🇱🇸", adjective: "Basotho" },
  SZ: { name: "Eswatini", emoji: "🇸🇿", adjective: "Swazi" },
};

// Region groupings for the market selector — Africa by UN sub-region, then Asia-Pacific. Order is
// the display order of the optgroups; codes within a region order the options when counts tie.
// Every FOCUS_MARKETS code appears in exactly one region (keep in sync when adding a market).
export const REGIONS: { name: string; codes: string[] }[] = [
  { name: "Southern Africa", codes: ["ZA", "BW", "NA", "ZW", "MZ", "ZM", "MW", "LS", "SZ"] },
  { name: "East Africa", codes: ["KE", "TZ", "UG", "RW", "ET", "MU", "SO"] },
  { name: "West Africa", codes: ["NG", "GH", "CI", "SN"] },
  { name: "Central Africa", codes: ["CM", "AO"] },
  { name: "North Africa", codes: ["EG", "MA", "DZ", "TN", "LY"] },
  { name: "Asia-Pacific", codes: ["JP"] },
];

const REGION_OF: Record<string, string> = Object.fromEntries(
  REGIONS.flatMap((r) => r.codes.map((c) => [c, r.name])),
);

/** Group a plain list of ISO2 codes into region sections (for selectors that only have codes, not
 *  store counts). Preserves each region's incoming order; unmapped codes fall into a trailing "Other". */
export function groupCodesByRegion(codes: string[]): { region: string; codes: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const c of codes) {
    const region = REGION_OF[c] ?? "Other";
    if (!buckets.has(region)) buckets.set(region, []);
    buckets.get(region)!.push(c);
  }
  const order = [...REGIONS.map((r) => r.name), "Other"];
  return order.filter((name) => buckets.has(name)).map((name) => ({ region: name, codes: buckets.get(name)! }));
}

/** Group a flat country list into region sections for an optgroup selector. Keeps each region's
 *  members sorted by store count (desc), drops empty regions, and sweeps any country not mapped to
 *  a region into a trailing "Other" group so nothing silently disappears from the picker. */
export function groupByRegion<T extends { country: string; stores: number }>(
  items: T[],
): { region: string; items: T[] }[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const region = REGION_OF[it.country] ?? "Other";
    if (!buckets.has(region)) buckets.set(region, []);
    buckets.get(region)!.push(it);
  }
  const order = [...REGIONS.map((r) => r.name), "Other"];
  return order
    .filter((name) => buckets.has(name))
    .map((name) => ({
      region: name,
      items: buckets.get(name)!.sort((a, b) => b.stores - a.stores),
    }));
}

/** Flag + name, e.g. "🇿🇦 South Africa". Falls back to the raw code. */
export const marketLabel = (code: string) => {
  const m = MARKETS[code];
  return m ? `${m.emoji} ${m.name}` : code;
};

/** Just the flag emoji (or a globe for unknown / all). */
export const marketFlag = (code: string) => MARKETS[code]?.emoji ?? "🌍";

/** Adjective for headers, e.g. "South African". */
export const marketAdjective = (code: string) => MARKETS[code]?.adjective ?? code;

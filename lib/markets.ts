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
};

/** Flag + name, e.g. "🇿🇦 South Africa". Falls back to the raw code. */
export const marketLabel = (code: string) => {
  const m = MARKETS[code];
  return m ? `${m.emoji} ${m.name}` : code;
};

/** Just the flag emoji (or a globe for unknown / all). */
export const marketFlag = (code: string) => MARKETS[code]?.emoji ?? "🌍";

/** Adjective for headers, e.g. "South African". */
export const marketAdjective = (code: string) => MARKETS[code]?.adjective ?? code;

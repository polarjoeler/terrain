/** Country/market presentation — flag emoji, display name, and adjective — for
 *  the market selectors on the dashboard and insights. Shared so both agree. */

export const MARKETS: Record<string, { name: string; emoji: string; adjective: string }> = {
  ZA: { name: "South Africa", emoji: "🇿🇦", adjective: "South African" },
  NG: { name: "Nigeria", emoji: "🇳🇬", adjective: "Nigerian" },
  KE: { name: "Kenya", emoji: "🇰🇪", adjective: "Kenyan" },
  EG: { name: "Egypt", emoji: "🇪🇬", adjective: "Egyptian" },
  MA: { name: "Morocco", emoji: "🇲🇦", adjective: "Moroccan" },
  GH: { name: "Ghana", emoji: "🇬🇭", adjective: "Ghanaian" },
  TZ: { name: "Tanzania", emoji: "🇹🇿", adjective: "Tanzanian" },
  UG: { name: "Uganda", emoji: "🇺🇬", adjective: "Ugandan" },
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

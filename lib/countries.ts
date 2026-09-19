/** ISO2 → flag emoji, display name, and region — for the coverage matrix (170 countries).
 *  Names come from Intl.DisplayNames; emoji from the regional-indicator codepoints. */

// Region → the ISO2 codes we hold stores in. Inverted below into a lookup. A code not listed
// falls back to "Other" (harmless — only affects tiny territories).
const REGIONS: Record<string, string[]> = {
  Africa: ["ZA", "NG", "MA", "KE", "TN", "DZ", "EG", "TZ", "MU", "RE", "MZ", "AO", "CI", "CM", "GH",
    "BW", "CD", "NA", "MG", "SN", "ST", "RW", "ZM", "ZW", "ML", "MW", "BF", "LS", "GM", "GA", "SD",
    "DJ", "CV", "SC", "SZ", "TG", "BJ", "ET", "SO", "UG", "AC", "TF"],
  "Middle East": ["AE", "IL", "SA", "QA", "KW", "OM", "BH", "JO", "IQ", "SY", "PS"],
  Asia: ["IN", "PK", "JP", "SG", "CN", "KR", "TW", "HK", "VN", "LK", "LA", "BD", "TH", "ID", "MY",
    "PH", "NP", "MN", "KZ", "UZ", "TJ", "GE", "AM", "AZ", "MV", "TR"],
  Europe: ["UK", "DE", "FR", "NL", "IT", "ES", "SE", "CH", "PL", "DK", "RO", "BE", "NO", "AT", "PT",
    "FI", "IE", "CZ", "HU", "LT", "GR", "BG", "IS", "SK", "LV", "EE", "SI", "RS", "HR", "IM", "MK",
    "MT", "AL", "BA", "MD", "CY", "LU", "FO", "UA", "RU", "JE", "LI", "MC", "AD", "SM", "GI", "EU"],
  Americas: ["BR", "CA", "MX", "CL", "PE", "AR", "UY", "DO", "GT", "CR", "HN", "AG", "PA", "KY",
    "US", "VE", "GY", "PR", "SV", "BO", "BZ", "TT", "MS", "HT", "GD", "BM", "SX", "LC", "EC", "PY",
    "GL", "NI", "GS"],
  Oceania: ["AU", "NZ", "NU", "AS", "FJ", "WS", "VU", "CX", "PF", "WF", "NC"],
};

export const REGION_ORDER = ["Africa", "Middle East", "Asia", "Europe", "Americas", "Oceania", "Other"];

const REGION_OF = new Map<string, string>();
for (const [reg, codes] of Object.entries(REGIONS)) for (const c of codes) REGION_OF.set(c, reg);

export function regionOf(iso2: string): string {
  return REGION_OF.get(iso2.toUpperCase()) ?? "Other";
}

/** Flag emoji from the two regional-indicator codepoints (UK→GB so it renders the right flag). */
export function countryEmoji(iso2: string): string {
  const c = iso2.toUpperCase() === "UK" ? "GB" : iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "🏳️";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let _names: Intl.DisplayNames | null = null;
/** Full English country name (UK/EU special-cased; Intl for the rest, code as fallback). */
export function countryName(iso2: string): string {
  const c = iso2.toUpperCase();
  if (c === "UK") return "United Kingdom";
  if (c === "EU") return "European Union";
  try {
    _names = _names ?? new Intl.DisplayNames(["en"], { type: "region" });
    return _names.of(c) ?? c;
  } catch {
    return c;
  }
}

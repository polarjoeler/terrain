/** A user's FOCUS — what their onboarding answers say they care about, distilled for the two places
 *  that personalise from it: the Overview and the weekly digest.
 *
 *  Focus ranks and frames; it never hides. A store outside it is still in the dashboard and still a
 *  lead — it just isn't what the Overview leads with or what the digest talks about. Everything here
 *  degrades to "the whole market" when a user skipped setup or chose "all".
 *
 *  Pure + client-safe: profile rows in, plain values out (lib/profile.ts reads the rows).
 */
import type { CompanyType, Goal, SizeBand, Targeting, TechProduct } from "./onboarding";
import { marketLabel } from "./markets";
import { platformFromDbValue, platformLabel } from "./platforms";

export type Focus = {
  platforms: string[];          // ordered priority, lower-case platform ids; [] = no preference
  countries: string[];          // ISO2, upper-case; [] = all markets
  categories: string[];         // [] = any
  excludeCategories: string[];
  sizeBands: SizeBand[];        // [] = any size
  unknownSizeOk: boolean;       // most stores have no revenue estimate — don't drop them by default
  technologies: TechProduct[];  // the user's OWN product(s), for "how is my tech doing"
  goals: Goal[];
  companyType: CompanyType | null;
};

export const EMPTY_FOCUS: Focus = {
  platforms: [], countries: [], categories: [], excludeCategories: [], sizeBands: [],
  unknownSizeOk: true, technologies: [], goals: [], companyType: null,
};

type Row = Record<string, unknown> | null | undefined;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
const json = <T,>(v: unknown): T | null => {
  if (v == null) return null;
  if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return null; } }
  return v as T;
};

/** Build a focus from the org_profile + user_profile rows (either may be missing). The rich targeting
 *  written by the 5-stage profiler wins; the legacy columns (cms_focus, markets, lead_focus) fill in
 *  for accounts set up with the old short form. */
export function focusFromProfiles(org: Row, user: Row): Focus {
  const t = json<Targeting>(org?.targeting);
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  // Legacy answers are free-ish CMS words ("magento"); normalise them to registry ids.
  const legacyPlatforms = lower(arr(user?.lead_focus).length ? arr(user?.lead_focus) : arr(org?.cms_focus))
    .filter((p) => p !== "all").map((p) => platformFromDbValue(p)?.id ?? p);
  return {
    platforms: t ? (t.allPlatforms ? [] : lower(t.platforms ?? [])) : legacyPlatforms,
    countries: (t ? (t.allCountries ? [] : t.countries ?? []) : arr(org?.markets)).map((c) => c.toUpperCase()),
    categories: t && !t.allCategories ? t.categories ?? [] : [],
    excludeCategories: t?.excludeCategories ?? [],
    sizeBands: t && !t.sizeAny ? t.sizeBands ?? [] : [],
    unknownSizeOk: t?.unknownSizeOk ?? true,
    technologies: json<TechProduct[]>(org?.technologies) ?? [],
    goals: arr(org?.goals) as Goal[],
    companyType: (org?.company_type as CompanyType) ?? null,
  };
}

export const hasTargeting = (f: Focus): boolean =>
  f.platforms.length + f.countries.length + f.categories.length + f.sizeBands.length > 0;

/** The store fields focus matching looks at — satisfied by both Lead and the Overview launch rows. */
export type Matchable = {
  platform?: string | null; country?: string | null; category?: string | null;
  estMonthlySales?: number | null; productCount?: number | null;
};

const REV: Partial<Record<SizeBand, [number, number]>> = {
  rev_100k_plus: [100_000, Infinity], rev_25_100k: [25_000, 100_000], rev_5_25k: [5_000, 25_000],
  rev_1_5k: [1_000, 5_000], rev_under_1k: [0, 1_000],
};
// A store passes if it's IN any chosen band. It fails only when every chosen band is ruled out by
// data we hold; a band we can't evaluate (no revenue estimate — most stores) leaves it to
// unknownSizeOk. So "$5k–25k or 100+ products" keeps a 50-product store with no estimate.
// 2 = confirmed in a band, 1 = can't tell (and unknowns are allowed), 0 = out.
function sizeMatch(s: Matchable, bands: SizeBand[], unknownOk: boolean): 0 | 1 | 2 {
  if (!bands.length) return 2;
  const rev = s.estMonthlySales, n = s.productCount;
  let undecided = false;
  for (const b of bands) {
    if (b === "cat_large" || b === "cat_small") {
      if (n == null) { undecided = true; continue; }
      if (b === "cat_large" ? n >= 100 : n < 100) return 2;
    } else {
      if (rev == null) { undecided = true; continue; }
      const [lo, hi] = REV[b]!;
      if (rev >= lo && rev < hi) return 2;
    }
  }
  return undecided && unknownOk ? 1 : 0;
}
const catEq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
// The store's platform as a registry id (lib/platforms: "magento" → adobe_commerce), matching the ids
// onboarding saves. Unrecorded counts as Shopify — the pipeline's default, as in the launch trend.
const platformOf = (s: Matchable) => platformFromDbValue(s.platform ?? "shopify")?.id ?? (s.platform ?? "").toLowerCase();

/** How well a store fits the focus: 2 = every chosen dimension confirmed, 1 = fits except its size
 *  is unknown (most stores carry no revenue estimate), 0 = outside. Unchosen dimensions pass;
 *  excluded categories always fail; no platform recorded counts as Shopify (the pipeline default). */
export function matchLevel(s: Matchable, f: Focus): 0 | 1 | 2 {
  const cat = s.category ?? "";
  if (cat && f.excludeCategories.some((x) => catEq(x, cat))) return 0;
  if (f.platforms.length && !f.platforms.includes(platformOf(s))) return 0;
  if (f.countries.length && !f.countries.includes((s.country ?? "").toUpperCase())) return 0;
  if (f.categories.length && !(cat && f.categories.some((x) => catEq(x, cat)))) return 0;
  return sizeMatch(s, f.sizeBands, f.unknownSizeOk);
}
export const inFocus = (s: Matchable, f: Focus): boolean => matchLevel(s, f) > 0;

/** Order inside the focus: the user's platform ranking first (their #1 before their #2). */
export function focusRank(s: Matchable, f: Focus): number {
  const i = f.platforms.indexOf(platformOf(s));
  return i < 0 ? f.platforms.length : i;
}

/** Confirmed matches first, then size-unknown ones, each by platform rank (stable otherwise), then
 *  everything else — so a page never empties because the focus is narrow. `matched` counts both
 *  match levels, `confirmed` only the first. */
export function rankByFocus<T extends Matchable>(items: T[], f: Focus): { items: T[]; matched: number; confirmed: number } {
  if (!hasTargeting(f)) return { items, matched: 0, confirmed: 0 };
  const scored = items.map((s, i) => ({ s, i, m: matchLevel(s, f) }));
  const inside = scored.filter((x) => x.m > 0)
    .sort((a, b) => b.m - a.m || focusRank(a.s, f) - focusRank(b.s, f) || a.i - b.i);
  const set = new Set(inside.map((x) => x.s));
  return {
    items: [...inside.map((x) => x.s), ...items.filter((s) => !set.has(s))],
    matched: inside.length, confirmed: inside.filter((x) => x.m === 2).length,
  };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const country = (iso: string) => marketLabel(iso).replace(/^[^\p{L}]+/u, "");

const SIZE_WORD: Record<SizeBand, string> = {
  rev_100k_plus: "$100k+/mo", rev_25_100k: "$25–100k/mo", rev_5_25k: "$5–25k/mo", rev_1_5k: "$1–5k/mo",
  rev_under_1k: "under-$1k/mo", cat_large: "100+ product", cat_small: "small-catalogue",
};

/** "$100k+/mo Shopify Apparel stores in Kenya" — the focus as a noun phrase, for headlines and
 *  subjects. Each dimension is capped so a broad selection stays readable. */
export function focusPhrase(f: Focus, noun = "stores"): string {
  const size = f.sizeBands.length === 1 ? [SIZE_WORD[f.sizeBands[0]]] : [];  // two bands read badly in a subject line
  const plats = f.platforms.length && f.platforms.length <= 2 ? [list(f.platforms.map((p) => platformLabel(p)))] : [];
  const cats = f.categories.length && f.categories.length <= 2 ? [list(f.categories)] : [];
  const where = f.countries.length && f.countries.length <= 3 ? ` in ${list(f.countries.map(country))}` : "";
  return [...size, ...plats, ...cats, noun].join(" ") + where;
}

/** Does a store run this tech? Matches the user's typed product name against the store's detected
 *  payments + technologies, case-insensitively ("PayFast" ↔ "payfast"). */
export function runsTech(s: { payments?: string[]; technologies?: string | null }, name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length < 3) return false;
  return (s.payments ?? []).some((p) => p.toLowerCase().includes(n)) || (s.technologies ?? "").toLowerCase().includes(n);
}

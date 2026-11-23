/** LinkedIn link helpers.
 *
 * Two shapes ship to customers, and only two:
 *
 *   1. a COMPANY page the merchant published on their own site. First-party discovery
 *      (social-enrich reads the homepage, contact-enrich reads /pages/about + /pages/contact),
 *      so it is ours to resell under the data-ownership principle.
 *   2. a prefilled LinkedIn SEARCH deep-link, COMPUTED at render/export time from the store
 *      name. Nothing is stored, nothing is scraped, and it works for 100% of rows — which
 *      matters because even the ZA revenue top-1000 is only ~12% covered by a stored URL.
 *
 * Personal (/in/) profiles are deliberately NOT surfaced. They are personal data under POPIA,
 * GDPR and APPI (see the Japan corporate-only rule), and LinkedIn's terms forbid harvesting
 * profiles. scripts/linkedin-backfill.mjs keeps the flat `linkedin` column free of them; any
 * that were already captured survive only inside the `socials` JSONB, which is not exported.
 *
 * We never call LinkedIn. A deep-link is a URL we hand the user — their browser, their session.
 */

/** A LinkedIn URL that points at an organisation (company or school), not a person. */
export function isCompanyPage(url: string | null | undefined): boolean {
  if (!url) return false;
  return /linkedin\.com\/(company|school)\//i.test(url);
}

/** A LinkedIn URL that points at an individual's profile. Never exported. */
export function isPersonalProfile(url: string | null | undefined): boolean {
  if (!url) return false;
  return /linkedin\.com\/in\//i.test(url);
}

/** Strip a stored value down to what we are willing to ship: company/school pages only. */
export function publicLinkedin(url: string | null | undefined): string | null {
  return isCompanyPage(url) ? String(url) : null;
}

/** The registrable label of a hostname: "shop.asetos.co.za" -> "asetos". */
function domainLabel(domain: string | null | undefined): string {
  const d = (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!d) return "";
  // Drop the public suffix, which may be multi-part (.co.za, .com.ng, .ac.jp), then take the
  // last remaining label so subdomains like "shop." don't become the search term.
  const parts = d.split(".").filter(Boolean);
  const sld = ["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"];
  let end = parts.length - 1;
  if (end >= 2 && sld.includes(parts[end - 1])) end -= 1;
  return parts[end - 1] ?? parts[0] ?? "";
}

/** Best human-readable label for a store, for use as search keywords. */
function searchKeywords(name: string | null | undefined, domain: string | null | undefined): string {
  const n = (name ?? "").trim();
  // ~31k ZA rows carry a bare hostname in `name`. Searching LinkedIn for "shop.asetos.co.za"
  // returns nothing, so treat a domain-shaped name as no name at all.
  const nameIsDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(n) && !n.includes(" ");
  if (n && !nameIsDomain) return n;
  return domainLabel(domain);
}

/**
 * The "find me a human here" link.
 *
 * Prefers the company page's People tab when we know the company page — that lands on the
 * actual staff list. Otherwise falls back to a people search seeded with the store name,
 * which is the same query a salesperson would type by hand.
 *
 * Returns null only when we have neither a company page nor any usable name.
 */
export function linkedinPeopleUrl(
  storedLinkedin: string | null | undefined,
  name: string | null | undefined,
  domain: string | null | undefined,
): string | null {
  const company = publicLinkedin(storedLinkedin);
  if (company) return `${company.replace(/\/+$/, "")}/people/`;

  const kw = searchKeywords(name, domain);
  if (!kw) return null;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
}

/** Company-level search, for when the customer wants the organisation rather than its staff. */
export function linkedinCompanySearchUrl(
  name: string | null | undefined,
  domain: string | null | undefined,
): string | null {
  const kw = searchKeywords(name, domain);
  if (!kw) return null;
  return `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(kw)}`;
}

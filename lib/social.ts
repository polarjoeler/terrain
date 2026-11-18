/** Social handles are stored in two shapes, and anything that renders them has to cope.
 *
 *  Measured on published stores (2026-11-18): 700,205 of 1,011,013 Instagram values are full URLs
 *  rather than handles, 587,331 of 820,276 Facebook ones, 67,485 of 221,964 TikTok ones (plus
 *  1,036 carrying a leading @), and 51,303 of 51,594 LinkedIn ones. scripts/social-enrich.mjs
 *  writes whatever the storefront's markup gave it, so the column is a mix and always has been.
 *
 *  The drawer and the Explorer row both built their links by CONCATENATION —
 *  `https://instagram.com/${handle}` — which turns a stored URL into
 *  `https://instagram.com/https://www.instagram.com/wayupsports`: a dead link, and a label that
 *  overflows its row. Hence one normaliser, used by every reader, rather than a fix in each.
 *
 *  Deliberately NOT a migration of the column. Normalising on read is correct whatever the
 *  database holds, and keeps working if a writer regresses; cleaning the 1.3M stored values is a
 *  separate, reversible decision.
 */

type Network = "instagram" | "facebook" | "tiktok" | "linkedin";

/** Host patterns per network, so only that network's own URLs are unwrapped. A Linktree or a
 *  shortener is left exactly as stored — guessing a handle out of one would invent data. */
const HOSTS: Record<Network, RegExp> = {
  instagram: /^(?:https?:\/\/)?(?:[\w-]+\.)*instagram\.com\//i,
  facebook: /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:facebook\.com|fb\.com|fb\.me)\//i,
  tiktok: /^(?:https?:\/\/)?(?:[\w-]+\.)*tiktok\.com\//i,
  linkedin: /^(?:https?:\/\/)?(?:[\w-]+\.)*linkedin\.com\//i,
};

/** Paths that are a POST, a tag or a search rather than a profile. instagram.com/p/<id> is the
 *  single most common of these in our data (1,449 published rows stop at a bare `/p`). */
const NOT_A_PROFILE = /^(?:p|reel|reels|explore|stories|tags?|hashtag|search|share|login|posts?|photo|pages?|groups?|events?|watch|video|t|discover|music|effect|@?$)$/i;

/** The handle, or null when the value does not name a profile we can link to.
 *  Accepts a bare handle, "@handle", or a profile URL on that network. */
export function socialHandle(value: string | null | undefined, network: Network): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  let rest = raw;
  const host = HOSTS[network];
  if (host.test(raw)) {
    rest = raw.replace(host, "");
  } else if (/^(?:https?:)?\/\//i.test(raw) || /^[\w-]+\.[a-z]{2,}\//i.test(raw)) {
    // A URL, but not this network's — a Linktree, a shortener, someone else's site. Not a handle.
    return null;
  }
  // Drop a query string, a fragment and any trailing slash, then take the first path segment.
  rest = rest.split(/[?#]/)[0].replace(/\/+$/, "");
  // LinkedIn profiles are two segments (company/acme, in/jane) and the pair IS the handle.
  const segs = rest.split("/").filter(Boolean);
  if (!segs.length) return null;
  if (network === "linkedin") {
    const kind = segs[0].toLowerCase();
    if (kind === "company" || kind === "in" || kind === "school" || kind === "showcase") {
      return segs[1] ? `${kind}/${decodeURIComponent(segs[1]).replace(/^@/, "")}` : null;
    }
    // A bare value with no prefix is a company handle — how the column mostly stores them.
    return segs.length === 1 ? decodeURIComponent(segs[0]).replace(/^@/, "") : null;
  }
  const first = decodeURIComponent(segs[0]).replace(/^@/, "");
  if (!first || NOT_A_PROFILE.test(first)) return null;
  return first;
}

/** The profile URL for a stored value, or null if it does not name one. */
export function socialUrl(value: string | null | undefined, network: Network): string | null {
  const h = socialHandle(value, network);
  if (!h) return null;
  switch (network) {
    case "instagram": return `https://instagram.com/${h}`;
    case "facebook": return `https://facebook.com/${h}`;
    case "tiktok": return `https://tiktok.com/@${h}`;
    case "linkedin": return `https://www.linkedin.com/${h.includes("/") ? h : `company/${h}`}`;
  }
}

/** What to show in a cell: "@handle" for the networks that use one, the path for LinkedIn. */
export function socialLabel(value: string | null | undefined, network: Network): string | null {
  const h = socialHandle(value, network);
  if (!h) return null;
  return network === "linkedin" ? h : `@${h}`;
}

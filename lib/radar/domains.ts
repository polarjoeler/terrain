/** Domain & email intelligence — read side.
 *
 *  The sweep (scripts/radar-domain-watch.mjs) populates radar_domain_watches with
 *  live lookalike domains and writes each brand's SPF/DMARC posture back onto
 *  radar_brands. Here we read those for the customer dashboard, plus a couple of
 *  small classifiers that turn the raw signal into a risk label. */

import { db, ensureSchema } from "./db";
import { cleanDomain } from "./catalog";

export type DomainWatch = {
  brandDomain: string;
  lookalike: string;
  kind: string; // homoglyph|typo|tld|wordadd|hyphen
  hasSite: boolean;
  hasMail: boolean;
  ips: string[];
  firstSeen: string;
  lastSeen: string;
};

const KIND_LABEL: Record<string, string> = {
  homoglyph: "look-alike characters",
  typo: "misspelling",
  tld: "different domain ending",
  wordadd: "added word",
  hyphen: "hyphenated",
};
export const kindLabel = (k: string) => KIND_LABEL[k] ?? k;

/** Mail-configured lookalikes are the highest risk (they can send phishing as
 *  you); a resolving site is next; everything else is a watch item. */
export function watchRisk(w: DomainWatch): "high" | "medium" | "low" {
  if (w.hasMail) return "high";
  if (w.hasSite) return "medium";
  return "low";
}

/** Live lookalikes for a set of enrolled brands, most-recently-seen first. */
export async function domainWatchesForBrands(brandDomains: string[]): Promise<DomainWatch[]> {
  if (brandDomains.length === 0) return [];
  await ensureSchema();
  const domains = brandDomains.map(cleanDomain);
  const rows = await db()<
    {
      brand_domain: string;
      lookalike: string;
      kind: string | null;
      has_site: boolean;
      has_mail: boolean;
      ips: string[];
      first_seen_at: Date;
      last_seen_at: Date;
    }[]
  >`
    SELECT brand_domain, lookalike, kind, has_site, has_mail, ips, first_seen_at, last_seen_at
    FROM radar_domain_watches
    WHERE brand_domain = ANY(${db().array(domains)}) AND NOT dismissed
    ORDER BY has_mail DESC, has_site DESC, last_seen_at DESC`;
  return rows.map((r) => ({
    brandDomain: r.brand_domain,
    lookalike: r.lookalike,
    kind: r.kind ?? "typo",
    hasSite: r.has_site,
    hasMail: r.has_mail,
    ips: r.ips ?? [],
    firstSeen: new Date(r.first_seen_at).toISOString(),
    lastSeen: new Date(r.last_seen_at).toISOString(),
  }));
}

export type EmailPosture = {
  spfPresent: boolean | null;
  dmarcPolicy: string | null;
  checkedAt: string | null;
  spoofable: boolean; // no SPF, or DMARC missing / p=none → anyone can spoof your mail
  summary: string;
};

/** Turn the stored SPF/DMARC columns into a plain-English posture. */
export function emailPosture(b: {
  spfPresent: boolean | null;
  dmarcPolicy: string | null;
  emailCheckedAt: string | null;
}): EmailPosture {
  const checked = b.emailCheckedAt != null;
  const spoofable = checked && (!b.spfPresent || b.dmarcPolicy == null || b.dmarcPolicy === "none");
  let summary: string;
  if (!checked) summary = "Not checked yet";
  else if (!spoofable) summary = "Protected — SPF set and DMARC enforced";
  else if (b.dmarcPolicy == null) summary = "No DMARC record — anyone can send email as your domain";
  else if (b.dmarcPolicy === "none") summary = "DMARC is monitor-only (p=none) — spoofed mail still gets delivered";
  else summary = "SPF is missing — strengthens spoofing protection when set";
  return {
    spfPresent: b.spfPresent,
    dmarcPolicy: b.dmarcPolicy,
    checkedAt: b.emailCheckedAt,
    spoofable,
    summary,
  };
}

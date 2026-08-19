/** Takedown dossier — a ready-to-file evidence pack for one detection (a brand
 *  vs a clone). Pulls the match evidence, the brand's details, and a best-effort
 *  registrar lookup (RDAP), and the page assembles a DMCA notice from it. */

import { resolve4, resolveNs } from "node:dns/promises";
import { db, ensureSchema } from "./db";
import { cleanDomain, type MatchReport } from "./catalog";

export type Dossier = {
  brandDomain: string;
  brandName: string;
  officialDomains: string[];
  trademark: string | null;
  suspect: string;
  suspectName: string | null;
  verdict: MatchReport["verdict"];
  score: number;
  reasons: string[];
  firstSeen: string;
  lastSeen: string;
  registrar: string | null;
  registrarAbuse: string | null;
  nameservers: string[];
  ips: string[];
  generatedAt: string;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Best-effort registrar + abuse contact via RDAP (many ccTLDs, incl. .co.za,
 *  aren't in the RDAP bootstrap — the page always also links a manual WHOIS). */
async function rdapLookup(domain: string): Promise<{ registrar: string | null; abuse: string | null }> {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { registrar: null, abuse: null };
    const data: any = await res.json();
    let registrar: string | null = null;
    let abuse: string | null = null;
    const walk = (entities: any[] | undefined) => {
      for (const e of entities ?? []) {
        const roles: string[] = e.roles ?? [];
        const fn = (e.vcardArray?.[1] ?? []).find((v: any[]) => v[0] === "fn")?.[3] ?? null;
        const email = (e.vcardArray?.[1] ?? []).find((v: any[]) => v[0] === "email")?.[3] ?? null;
        if (roles.includes("registrar") && fn) registrar = fn;
        if (roles.includes("abuse") && email) abuse = email;
        walk(e.entities);
      }
    };
    walk(data.entities);
    return { registrar, abuse };
  } catch {
    return { registrar: null, abuse: null };
  }
}

export async function buildDossier(brandDomain: string, suspect: string): Promise<Dossier | null> {
  await ensureSchema();
  const brand = cleanDomain(brandDomain);
  const sus = cleanDomain(suspect);

  const [b] = await db()<
    { brand_name: string | null; official_domains: string[]; trademark: string | null }[]
  >`SELECT brand_name, official_domains, trademark FROM radar_brands WHERE brand_domain = ${brand}`;
  const [d] = await db()<
    {
      suspect_name: string | null;
      verdict: MatchReport["verdict"];
      score: number;
      reasons: string[];
      first_seen_at: Date;
      last_seen_at: Date;
    }[]
  >`SELECT suspect_name, verdict, score, reasons, first_seen_at, last_seen_at
    FROM radar_detections WHERE brand_domain = ${brand} AND suspect = ${sus}`;
  if (!d) return null;

  const [rd, ips, ns] = await Promise.all([
    rdapLookup(sus),
    resolve4(sus).catch(() => [] as string[]),
    resolveNs(sus).catch(() => [] as string[]),
  ]);

  return {
    brandDomain: brand,
    brandName: b?.brand_name || brand,
    officialDomains: b?.official_domains ?? [brand],
    trademark: b?.trademark ?? null,
    suspect: sus,
    suspectName: d.suspect_name ?? null,
    verdict: d.verdict,
    score: d.score,
    reasons: d.reasons ?? [],
    firstSeen: new Date(d.first_seen_at).toISOString(),
    lastSeen: new Date(d.last_seen_at).toISOString(),
    registrar: rd.registrar,
    registrarAbuse: rd.abuse,
    nameservers: ns,
    ips,
    generatedAt: new Date().toISOString(),
  };
}

/** The pre-filled DMCA takedown notice text (brand fills the bracketed fields). */
export function dmcaNotice(d: Dossier): string {
  const own = d.officialDomains.join(", ");
  return `To Whom It May Concern,

I am writing to notify you of copyright and trademark infringement under the Digital Millennium Copyright Act (DMCA).

RIGHTS HOLDER: ${d.brandName}
OFFICIAL WEBSITE(S): ${own}
${d.trademark ? `REGISTERED TRADEMARK: ${d.trademark}\n` : ""}
INFRINGING WEBSITE: ${d.suspect}

The website at ${d.suspect} has reproduced our original product catalogue without authorization. Evidence of infringement:
${d.reasons.map((r) => `  - ${r}`).join("\n")}

Match confidence: ${d.verdict} (${d.score}/100). First detected: ${d.firstSeen.slice(0, 10)}.

The material on ${d.suspect} is a direct reproduction of copyrighted product photography, descriptions and other original content owned by ${d.brandName}. This use is not authorized by us, our agents, or the law.

I have a good faith belief that the use of the material described above is not authorized by the copyright owner, its agent, or the law. I state, under penalty of perjury, that the information in this notice is accurate and that I am the copyright owner or authorized to act on the owner's behalf.

Please remove or disable access to the infringing material.

Name: [YOUR FULL NAME]
Title: [YOUR ROLE] on behalf of ${d.brandName}
Address: [YOUR ADDRESS]
Phone: [YOUR PHONE]
Email: [YOUR EMAIL]
Signature: [/s/ YOUR NAME]
Date: ${d.generatedAt.slice(0, 10)}`;
}

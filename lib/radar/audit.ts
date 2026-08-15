/** Brand Audit — the initial on-demand scan.
 *
 *  Given a brand's Shopify domain, fingerprint its catalogue and hunt for stores
 *  in our known South African universe that have reproduced it. Tractable by
 *  design: a cheap name/domain narrowing pass (both real clones we've caught —
 *  burntstudiospro, stevemaddenshoes — put the brand name in their domain) picks
 *  a short candidate list, and only those get the deep catalogue comparison.
 *
 *  The store universe is fetchLeads() filtered to the chosen market — the same
 *  feed grown via the /admin CSV import. Ongoing coverage of random-domain clones
 *  is the monitoring subscription's job (the CT-log firehose), not the audit.
 */

import { randomBytes } from "node:crypto";
import { db, ensureSchema } from "./db";
import { loadFingerprints } from "./fingerprints";
import { fetchLeads } from "../sheets";
import { marketOf, type Market } from "../prioritize";
import {
  buildFingerprint,
  cleanDomain,
  compare,
  fetchCatalog,
  type MatchReport,
} from "./catalog";

const MAX_LIVE = 24; // uncached stores we'll live-fetch as a fallback
const FETCH_CONCURRENCY = 6;

/* ---- brand-name matching (mirrors brandwatch.py's canon/homoglyph folding) -- */

const HOMOGLYPHS: [RegExp, string][] = [
  [/rn/g, "m"], [/vv/g, "w"], [/0/g, "o"], [/1/g, "l"], [/5/g, "s"], [/3/g, "e"],
];

function canon(s: string): string {
  let out = (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [re, to] of HOMOGLYPHS) out = out.replace(re, to);
  return out;
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);

/** Registrable label: 'stevemaddenshoes.co.za' -> 'stevemaddenshoes'. */
function registrableLabel(domain: string): string {
  const parts = cleanDomain(domain).split(".");
  if (parts.length > 1) parts.pop();
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(".");
}

/* ---- inputs / outputs ----------------------------------------------------- */

export type AuditInput = {
  brandDomain: string;
  brandName?: string;
  officialDomains?: string[]; // extra own-domains to never flag
  market?: Market;
  suspects?: string[]; // domains the brand already suspects
  email?: string;
  priorities?: string[]; // images / pricing / catalogue — tunes the report copy
  trademark?: string; // registered TM classes, for later dossiers
};

export type AuditResult = {
  id: string;
  brandDomain: string;
  brandName: string | null;
  market: string;
  brandProducts: number;
  candidates: number;
  copies: number;
  matches: MatchReport[];
  error?: string;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Run the scan. Never throws — failures come back on AuditResult.error. */
export async function runAudit(input: AuditInput): Promise<AuditResult> {
  const brandDomain = cleanDomain(input.brandDomain);
  const market = input.market ?? "South Africa";
  const id = randomBytes(9).toString("hex");

  const base: AuditResult = {
    id,
    brandDomain,
    brandName: input.brandName ?? null,
    market,
    brandProducts: 0,
    candidates: 0,
    copies: 0,
    matches: [],
  };

  // 1. Fingerprint the brand's own catalogue.
  const brandFp = buildFingerprint(brandDomain, await fetchCatalog(brandDomain));
  base.brandProducts = brandFp.nProducts;
  if (brandFp.nProducts === 0) {
    base.error =
      `No catalogue found at ${brandDomain}/products.json — check the domain is a live Shopify store.`;
    return base;
  }

  const own = new Set(
    [brandDomain, ...(input.officialDomains ?? [])].map(cleanDomain),
  );

  // 2. Compare against the cached fingerprint universe — instant, and covers
  //    the WHOLE market (so a clone on an unrelated domain is caught too).
  const cached = await loadFingerprints(market);
  const cachedDomains = new Set(cached.map((c) => c.domain));
  const cachedReports = cached
    .filter((c) => !own.has(c.domain))
    .map((c) => {
      const rep = compare(brandFp, c.fp);
      rep.suspectName = c.name ?? undefined;
      return rep;
    });

  // 3. Live fallback: user-supplied suspects + name/domain look-alikes not yet
  //    cached (so audits work while enrichment is still ramping up).
  const brandCanon = canon(input.brandName || registrableLabel(brandDomain));
  const { leads } = await fetchLeads();
  const universe = leads.filter((l) => marketOf(l) === market);
  const named =
    brandCanon.length >= 4
      ? universe
          .filter((l) => {
            const dc = canon(registrableLabel(l.domain));
            const nc = canon(l.name || "");
            return dc.includes(brandCanon) || (nc && nc.includes(brandCanon));
          })
          .map((l) => ({ domain: cleanDomain(l.domain), name: l.name }))
      : [];
  const nameByDomain = new Map(named.map((n) => [n.domain, n.name]));
  const suspects = (input.suspects ?? []).map(cleanDomain);
  const liveTargets = [...new Set([...suspects, ...named.map((n) => n.domain)])]
    .filter((d) => d && !own.has(d) && !cachedDomains.has(d))
    .slice(0, MAX_LIVE);

  const liveReports = await mapWithConcurrency(liveTargets, FETCH_CONCURRENCY, async (d) => {
    const fp = buildFingerprint(d, await fetchCatalog(d, 4));
    const rep = compare(brandFp, fp);
    rep.suspectName = nameByDomain.get(d);
    return rep;
  });

  base.candidates = cachedReports.length + liveReports.length;
  const matches = [...cachedReports, ...liveReports]
    .filter((r) => r.score >= 25)
    .sort((a, b) => b.score - a.score);
  base.matches = matches;
  base.copies = matches.filter((m) => m.verdict === "COPY" || m.verdict === "LIKELY").length;

  return base;
}

/* ---- persistence ---------------------------------------------------------- */

export async function saveAudit(input: AuditInput, result: AuditResult): Promise<void> {
  await ensureSchema();
  await db()`
    INSERT INTO radar_audits (
      id, brand_domain, brand_name, market, email,
      inputs_json, results_json, copies, candidates, status
    ) VALUES (
      ${result.id}, ${result.brandDomain}, ${result.brandName}, ${result.market},
      ${input.email ?? null},
      ${JSON.stringify(input)}, ${JSON.stringify(result)},
      ${result.copies}, ${result.candidates}, ${result.error ? "error" : "done"}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function getAudit(id: string): Promise<AuditResult | null> {
  await ensureSchema();
  const rows = await db()`SELECT results_json FROM radar_audits WHERE id = ${id} LIMIT 1`;
  if (!rows.length) return null;
  return JSON.parse(rows[0].results_json) as AuditResult;
}

export type AuditRow = {
  id: string;
  brandDomain: string;
  brandName: string | null;
  market: string;
  copies: number;
  candidates: number;
  status: string;
  createdAt: string;
};

export async function listAudits(limit = 100): Promise<AuditRow[]> {
  await ensureSchema();
  const rows = await db()<
    {
      id: string;
      brand_domain: string;
      brand_name: string | null;
      market: string;
      copies: number;
      candidates: number;
      status: string;
      created_at: Date;
    }[]
  >`
    SELECT id, brand_domain, brand_name, market, copies, candidates, status, created_at
    FROM radar_audits ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    brandDomain: r.brand_domain,
    brandName: r.brand_name,
    market: r.market,
    copies: r.copies,
    candidates: r.candidates,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export type Detection = {
  brandDomain: string;
  brandName: string | null;
  suspect: string;
  suspectName?: string;
  verdict: MatchReport["verdict"];
  score: number;
  reasons: string[];
  auditId: string;
  at: string;
};

/** Flatten every COPY/LIKELY/PARTIAL match across recent audits into a deduped
 *  detections list — the newest, highest-scoring hit per (brand, suspect). */
export async function listDetections(minScore = 25): Promise<Detection[]> {
  await ensureSchema();
  const rows = await db()<
    { id: string; results_json: string; created_at: Date }[]
  >`SELECT id, results_json, created_at FROM radar_audits ORDER BY created_at DESC LIMIT 300`;

  const byPair = new Map<string, Detection>();
  for (const row of rows) {
    let result: AuditResult;
    try {
      result = JSON.parse(row.results_json) as AuditResult;
    } catch {
      continue;
    }
    for (const m of result.matches || []) {
      if (m.score < minScore) continue;
      const key = `${result.brandDomain}→${m.suspect}`;
      const existing = byPair.get(key);
      if (existing && existing.score >= m.score) continue;
      byPair.set(key, {
        brandDomain: result.brandDomain,
        brandName: result.brandName,
        suspect: m.suspect,
        suspectName: m.suspectName,
        verdict: m.verdict,
        score: m.score,
        reasons: m.reasons,
        auditId: row.id,
        at: new Date(row.created_at).toISOString(),
      });
    }
  }
  return [...byPair.values()].sort((a, b) => b.score - a.score);
}

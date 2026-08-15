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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { fetchLeads } from "../sheets";
import { marketOf, type Market } from "../prioritize";
import {
  buildFingerprint,
  cleanDomain,
  compare,
  fetchCatalog,
  type MatchReport,
} from "./catalog";

const MAX_CANDIDATES = 24; // keep the deep pass inside the serverless budget
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

  // 2. Build the candidate list: user-supplied suspects + name/domain matches
  //    from the market universe. Never include the brand's own domains.
  const own = new Set(
    [brandDomain, ...(input.officialDomains ?? [])].map(cleanDomain),
  );
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
  const candidateDomains = [...new Set([...suspects, ...named.map((n) => n.domain)])]
    .filter((d) => d && !own.has(d))
    .slice(0, MAX_CANDIDATES);
  base.candidates = candidateDomains.length;

  // 3. Deep catalogue comparison on candidates only.
  const reports = await mapWithConcurrency(candidateDomains, FETCH_CONCURRENCY, async (d) => {
    const fp = buildFingerprint(d, await fetchCatalog(d, 4));
    const rep = compare(brandFp, fp);
    rep.suspectName = nameByDomain.get(d);
    return rep;
  });

  const matches = reports
    .filter((r) => r.score >= 25)
    .sort((a, b) => b.score - a.score);
  base.matches = matches;
  base.copies = matches.filter((m) => m.verdict === "COPY" || m.verdict === "LIKELY").length;

  return base;
}

/* ---- persistence ---------------------------------------------------------- */

let _sql: ReturnType<typeof postgres> | null = null;
let _ready: Promise<void> | null = null;

function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}
function ensure() {
  if (!_ready) {
    const ddl = readFileSync(join(process.cwd(), "lib", "schema.sql"), "utf8");
    _ready = db().unsafe(ddl).then(() => undefined);
  }
  return _ready;
}

export async function saveAudit(input: AuditInput, result: AuditResult): Promise<void> {
  await ensure();
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
  await ensure();
  const rows = await db()`SELECT results_json FROM radar_audits WHERE id = ${id} LIMIT 1`;
  if (!rows.length) return null;
  return JSON.parse(rows[0].results_json) as AuditResult;
}

/** Radar Watch — look-alike domains of top African stores (lookalike_candidates, written daily by
 *  scripts/lookalike-scan.mjs). Admin-only: a look-alike domain is a lead for a human to judge,
 *  never an accusation shown to a customer. Queries run sequentially on the shared pool. */
import { db } from "@/lib/db";

export type WatchStatus = "new" | "confirmed" | "benign" | "dismissed";

export type Candidate = {
  suspect: string; brand: string; brandRank: number | null; brandMarket: string | null;
  match: string; tier: string; score: number; signals: string[];
  seenAt: string | null; platform: string | null; live: string | null; published: boolean | null;
  catalogScore: number | null; catalogDetail: { error?: string; reasons?: string[]; sample?: string[]; suspect_products?: number } | null;
  catalogCheckedAt: string | null; evidenceAt: string | null;
  status: WatchStatus; reviewedAt: string | null; note: string | null; unpublishedLead: boolean;
};

export type WatchSummary = {
  open: number; newThisWeek: number; catalogueBacked: number; confirmed: number; tierB: number; lastRun: string | null;
};

export async function tableReady(): Promise<boolean> {
  const [{ t }] = await db()<{ t: string | null }[]>`SELECT to_regclass('public.lookalike_candidates')::text AS t`;
  return !!t;
}

export async function watchSummary(): Promise<WatchSummary> {
  const [r] = await db()<WatchSummary[]>`
    SELECT count(*) FILTER (WHERE tier = 'A' AND status = 'new')::int AS open,
           count(*) FILTER (WHERE tier = 'A' AND suspect_seen_at > now() - interval '7 days')::int AS "newThisWeek",
           count(*) FILTER (WHERE catalog_score >= 50 AND status <> 'dismissed' AND status <> 'benign')::int AS "catalogueBacked",
           count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
           count(*) FILTER (WHERE tier = 'B' AND status = 'new')::int AS "tierB",
           max(last_seen_at)::text AS "lastRun"
      FROM lookalike_candidates`;
  return r;
}

/** Tier-A look-alikes by the week we first saw the domain — the trend line. */
export async function weeklyTrend(weeks = 12): Promise<{ week: string; n: number; backed: number }[]> {
  return db()<{ week: string; n: number; backed: number }[]>`
    SELECT to_char(date_trunc('week', suspect_seen_at), 'YYYY-MM-DD') AS week, count(*)::int AS n,
           count(*) FILTER (WHERE catalog_score >= 50)::int AS backed
      FROM lookalike_candidates
     WHERE tier = 'A' AND status <> 'dismissed' AND status <> 'benign'
       AND suspect_seen_at > date_trunc('week', now()) - make_interval(weeks => ${weeks - 1}::int)
     GROUP BY 1 ORDER BY 1`;
}

export async function topBrands(limit = 12): Promise<{ brand: string; market: string | null; n: number; latest: string | null }[]> {
  return db()<{ brand: string; market: string | null; n: number; latest: string | null }[]>`
    SELECT brand, max(brand_market) AS market, count(*)::int AS n, max(suspect_seen_at)::text AS latest
      FROM lookalike_candidates WHERE tier = 'A' AND status <> 'dismissed' AND status <> 'benign'
     GROUP BY brand ORDER BY n DESC, latest DESC NULLS LAST LIMIT ${limit}`;
}

export async function tldMix(): Promise<{ tld: string; n: number }[]> {
  return db()<{ tld: string; n: number }[]>`
    SELECT substring(suspect from '\\.([a-z]+)$') AS tld, count(*)::int AS n
      FROM lookalike_candidates WHERE tier = 'A' AND status <> 'dismissed' AND status <> 'benign'
     GROUP BY 1 ORDER BY n DESC LIMIT 8`;
}

export async function listCandidates(opts: { tier?: string; status?: string; q?: string; limit?: number }): Promise<Candidate[]> {
  const tier = opts.tier === "B" ? "B" : opts.tier === "all" ? null : "A";
  const status = ["new", "confirmed", "benign", "dismissed"].includes(opts.status ?? "") ? opts.status! : opts.status === "all" ? null : "new";
  const q = (opts.q ?? "").trim().toLowerCase();
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  const sql = db();
  return sql<Candidate[]>`
    SELECT c.suspect, c.brand, c.brand_rank AS "brandRank", c.brand_market AS "brandMarket", c.match, c.tier, c.score, c.signals,
           c.suspect_seen_at::text AS "seenAt", c.suspect_platform AS platform, c.suspect_live AS live, s.published,
           c.catalog_score AS "catalogScore", c.catalog_detail AS "catalogDetail", c.catalog_checked_at::text AS "catalogCheckedAt",
           c.evidence_at::text AS "evidenceAt", c.status, c.reviewed_at::text AS "reviewedAt", c.note, c.unpublished_lead AS "unpublishedLead"
      FROM lookalike_candidates c LEFT JOIN imported_stores s ON s.domain = c.suspect
     WHERE (${tier}::text IS NULL OR c.tier = ${tier}::text)
       AND (${status}::text IS NULL OR c.status = ${status}::text)
       AND (${like}::text IS NULL OR c.suspect ILIKE ${like}::text OR c.brand ILIKE ${like}::text)
     ORDER BY (c.catalog_score >= 50) DESC NULLS LAST, c.suspect_seen_at DESC NULLS LAST, c.score DESC
     LIMIT ${opts.limit ?? 150}`;
}

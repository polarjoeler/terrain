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
  country: string | null; payments: string | null; name: string | null;
};

export type WatchSummary = {
  open: number; likely: number; newThisWeek: number; catalogueBacked: number; confirmed: number; tierB: number; lastRun: string | null;
  /** Tier-A suspects that stopped answering, and the median days from first seen to gone. */
  gone: number; medianDaysAlive: number | null;
};

export async function tableReady(): Promise<boolean> {
  const [{ t }] = await db()<{ t: string | null }[]>`SELECT to_regclass('public.lookalike_candidates')::text AS t`;
  return !!t;
}

export async function watchSummary(): Promise<WatchSummary> {
  const [r] = await db()<WatchSummary[]>`
    SELECT count(*) FILTER (WHERE tier = 'A' AND status = 'new')::int AS open,
           count(*) FILTER (WHERE tier = 'A' AND status = 'new' AND catalog_score >= 50)::int AS likely,
           count(*) FILTER (WHERE tier = 'A' AND suspect_seen_at > now() - interval '7 days')::int AS "newThisWeek",
           count(*) FILTER (WHERE catalog_score >= 50 AND status <> 'dismissed' AND status <> 'benign')::int AS "catalogueBacked",
           count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
           count(*) FILTER (WHERE tier = 'B' AND status = 'new')::int AS "tierB",
           max(last_seen_at)::text AS "lastRun",
           count(*) FILTER (WHERE tier = 'A' AND catalog_detail ? 'gone_at')::int AS gone,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (catalog_detail->>'gone_at')::timestamptz - suspect_seen_at) / 86400)
             FILTER (WHERE tier = 'A' AND catalog_detail ? 'gone_at' AND suspect_seen_at IS NOT NULL))::int AS "medianDaysAlive"
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

/** Overlap at or above this is catalogue evidence (memory: radar-cluster-classification). */
export const BACKED = 50;

export async function listCandidates(opts: { tier?: string; status?: string; q?: string; limit?: number; backed?: boolean }): Promise<Candidate[]> {
  const tier = opts.tier === "B" ? "B" : opts.tier === "all" ? null : "A";
  const status = ["new", "confirmed", "benign", "dismissed"].includes(opts.status ?? "") ? opts.status! : opts.status === "all" ? null : "new";
  const q = (opts.q ?? "").trim().toLowerCase();
  const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
  const backed = opts.backed === undefined ? null : opts.backed;
  const sql = db();
  return sql<Candidate[]>`
    SELECT c.suspect, c.brand, c.brand_rank AS "brandRank", c.brand_market AS "brandMarket", c.match, c.tier, c.score, c.signals,
           c.suspect_seen_at::text AS "seenAt", c.suspect_platform AS platform, c.suspect_live AS live, s.published,
           c.catalog_score AS "catalogScore", c.catalog_detail AS "catalogDetail", c.catalog_checked_at::text AS "catalogCheckedAt",
           c.evidence_at::text AS "evidenceAt", c.status, c.reviewed_at::text AS "reviewedAt", c.note, c.unpublished_lead AS "unpublishedLead",
           s.country, s.payments, s.name
      FROM lookalike_candidates c LEFT JOIN imported_stores s ON s.domain = c.suspect
     WHERE (${tier}::text IS NULL OR c.tier = ${tier}::text)
       AND (${status}::text IS NULL OR c.status = ${status}::text)
       AND (${like}::text IS NULL OR c.suspect ILIKE ${like}::text OR c.brand ILIKE ${like}::text)
       AND (${backed}::boolean IS NULL OR (coalesce(c.catalog_score, 0) >= ${BACKED}) = ${backed}::boolean)
     ORDER BY (c.catalog_score >= 50) DESC NULLS LAST, c.suspect_seen_at DESC NULLS LAST, c.score DESC
     LIMIT ${opts.limit ?? 150}`;
}

export type ConfirmedFake = {
  domain: string; name: string | null; country: string | null; platform: string | null;
  payments: string | null; live: string | null; reason: string; confirmedAt: string; by: string;
};

/** Every store a person has taken out of the lead list as a fake: Radar Watch confirmations and the
 *  hand-run takedowns (card-capture checkouts, the Springbok clones). The decision lives in
 *  store_edits, not lookalike_candidates — 59 of the first 59 confirmations were never look-alike
 *  rows at all — so this reads the audit trail. Only the LATEST published edit counts, and only
 *  while the store is still unpublished, so a reopened store drops out on its own. */
export async function confirmedFakes(q?: string, limit = 200): Promise<ConfirmedFake[]> {
  const like = q?.trim() ? `%${q.trim().toLowerCase().replace(/[%_]/g, "")}%` : null;
  return db()<ConfirmedFake[]>`
    SELECT e.domain, s.name, s.country, s.platform, s.payments, s.live_status AS live,
           substring(e.new_value from '^false \\((.*)\\)$') AS reason, e.edited_at::text AS "confirmedAt", e.editor AS "by"
      FROM (SELECT DISTINCT ON (domain) domain, new_value, edited_at, editor
              FROM store_edits WHERE field = 'published' ORDER BY domain, edited_at DESC, id DESC) e
      JOIN imported_stores s ON s.domain = e.domain
     WHERE NOT s.published
       AND e.new_value LIKE 'false (%'
       AND (e.new_value ILIKE '%clone%' OR e.new_value ILIKE '%fake%' OR e.new_value ILIKE '%card-capture%')
       AND (${like}::text IS NULL OR e.domain ILIKE ${like}::text OR e.new_value ILIKE ${like}::text)
     ORDER BY e.edited_at DESC, e.domain
     LIMIT ${limit}`;
}

/** Confirmed fakes by why they were taken down — the "what does fraud look like" summary. */
export function fakeKinds(rows: ConfirmedFake[]): { kind: string; n: number }[] {
  const kindOf = (r: string) =>
    /card-capture|sankee|public-payment/i.test(r) ? "Card-capture checkout"
    : /springbok/i.test(r) ? "Springbok clones"
    : /radar watch/i.test(r) ? "Look-alike domain"
    : "Other";
  const m = new Map<string, number>();
  for (const r of rows) m.set(kindOf(r.reason ?? ""), (m.get(kindOf(r.reason ?? "")) ?? 0) + 1);
  return [...m.entries()].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
}

/** Read/label the store pairs the fraud sweep saw but did NOT report.
 *
 *  Every pair that shares a catalogue lands either in radar_detections (judged
 *  impersonation) or here with the reason it was set aside. Labelling these is
 *  how the scoring in clone-score.mjs gets tuned against reality instead of
 *  judgement — there are currently no labelled positives anywhere in the data. */

import { db, ensureSchema } from "./db";

export type RelationshipLabel = "fraud" | "commerce" | "same-owner";

export type Relationship = {
  brandDomain: string;
  suspect: string;
  reason: string;
  detail: string | null;
  overlap: number | null;
  impersonation: number | null;
  shared: number | null;
  exclusive: number | null;
  label: RelationshipLabel | null;
  at: string;
};

/** Reasons worth a human's attention. `weak-overlap` is excluded by default —
 *  it's 3.7k pairs that barely share a catalogue, so a wrong call there costs
 *  nothing, while the buckets below are where a mistake actually hides fraud. */
export const REVIEW_REASONS = ["commerce", "domain-only", "same-brand-other-domain", "same-operator", "same-site"];

export async function listRelationships(
  { reason, onlyUnlabelled = false, limit = 100 }: { reason?: string; onlyUnlabelled?: boolean; limit?: number } = {},
): Promise<Relationship[]> {
  await ensureSchema();
  const sql = db();
  const reasons = reason ? [reason] : REVIEW_REASONS;
  const rows = await sql<{
    brand_domain: string; suspect: string; reason: string; detail: string | null;
    overlap_score: number | null; impersonation_score: number | null;
    shared: number | null; exclusive: number | null; label: string | null; last_seen_at: Date;
  }[]>`
    SELECT brand_domain, suspect, reason, detail, overlap_score, impersonation_score,
           shared, exclusive, label, last_seen_at
    FROM radar_relationships
    WHERE reason = ANY(${reasons}::text[])
      ${onlyUnlabelled ? sql`AND label IS NULL` : sql``}
    ORDER BY COALESCE(overlap_score, 0) DESC, COALESCE(shared, 0) DESC
    LIMIT ${limit}`.catch(() => []);
  return rows.map((r) => ({
    brandDomain: r.brand_domain, suspect: r.suspect, reason: r.reason, detail: r.detail,
    overlap: r.overlap_score, impersonation: r.impersonation_score,
    shared: r.shared, exclusive: r.exclusive,
    label: (r.label as RelationshipLabel) ?? null,
    at: new Date(r.last_seen_at).toISOString(),
  }));
}

/** Counts per reason, and how many of each you've already labelled. */
export async function relationshipCounts(): Promise<{ reason: string; total: number; labelled: number }[]> {
  await ensureSchema();
  const rows = await db()<{ reason: string; total: number; labelled: number }[]>`
    SELECT reason, COUNT(*)::int total, COUNT(label)::int labelled
    FROM radar_relationships GROUP BY 1 ORDER BY 2 DESC`.catch(() => []);
  return rows.map((r) => ({ reason: r.reason, total: Number(r.total), labelled: Number(r.labelled) }));
}

export async function setLabel(brandDomain: string, suspect: string, label: RelationshipLabel | null): Promise<boolean> {
  await ensureSchema();
  const rows = await db()`
    UPDATE radar_relationships SET label = ${label}
    WHERE brand_domain = ${brandDomain} AND suspect = ${suspect} RETURNING 1`;
  return rows.length > 0;
}

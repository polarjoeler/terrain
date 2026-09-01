/** Market-fraud read model — groups the flat fraud detections (radar_detections
 *  source='fraud') by VICTIM into clusters, and joins the victim's contact +
 *  enrolment so each cluster doubles as an outreach lead ("someone's copying
 *  you"). Populated by scripts/radar-fraud-sweep.mjs. */

import { db, ensureSchema } from "./db";
import type { MatchReport } from "./catalog";

export type FraudClone = {
  suspect: string;
  suspectName: string | null;
  verdict: MatchReport["verdict"];
  score: number;
  reasons: string[];
  at: string;         // last confirmed
  firstSeen: string;  // first detected
  newThisSweep: boolean; // first detected AFTER the previous sweep — genuinely new since you last looked
};

export type FraudCluster = {
  victim: string;
  victimName: string | null;
  victimEmail: string | null;
  estSales: number | null;
  victimPlus: boolean; // is the copied brand a Shopify Plus merchant? (higher stakes)
  enrolled: boolean;   // already a Radar customer?
  clones: FraudClone[];
  newCount: number;    // clones that are new since the previous sweep
  latestAt: string;    // most-recent detection in this cluster (ISO)
};

// "New this sweep" = first detected after the previous run's timestamp. When there's
// no previous run yet (first-ever sweep), fall back to a 7-day window so the very
// first load still highlights genuinely fresh detections rather than nothing.
const FALLBACK_NEW_DAYS = 7;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fraudClusters(minScore = 25, sinceRun?: string | null): Promise<FraudCluster[]> {
  const boundary = sinceRun
    ? new Date(sinceRun).getTime()
    : Date.now() - FALLBACK_NEW_DAYS * 864e5;
  const isNew = (iso: string) => new Date(iso).getTime() > boundary;
  await ensureSchema();
  const rows = await db()<any[]>`
    SELECT d.brand_domain AS victim, d.brand_name AS d_name, d.suspect, d.suspect_name,
           d.verdict, d.score, d.reasons, d.last_seen_at, d.first_seen_at,
           i.name AS i_name, i.email AS victim_email, i.estimated_monthly_sales AS est_sales,
           COALESCE(i.plus, false) AS victim_plus,
           (rb.brand_domain IS NOT NULL) AS enrolled
    FROM radar_detections d
    LEFT JOIN imported_stores i ON i.domain = d.brand_domain
    LEFT JOIN radar_brands rb   ON rb.brand_domain = d.brand_domain
    WHERE d.source = 'fraud' AND d.score >= ${minScore} AND NOT COALESCE(d.dismissed, false)
    ORDER BY d.score DESC, d.last_seen_at DESC`;

  const byVictim = new Map<string, FraudCluster>();
  for (const r of rows) {
    let c = byVictim.get(r.victim);
    if (!c) {
      c = {
        victim: r.victim,
        victimName: r.i_name ?? r.d_name ?? null,
        victimEmail: r.victim_email ?? null,
        estSales: r.est_sales != null ? Number(r.est_sales) : null,
        victimPlus: Boolean(r.victim_plus),
        enrolled: Boolean(r.enrolled),
        clones: [],
        newCount: 0,
        latestAt: new Date(0).toISOString(),
      };
      byVictim.set(r.victim, c);
    }
    const firstSeen = new Date(r.first_seen_at).toISOString();
    c.clones.push({
      suspect: r.suspect,
      suspectName: r.suspect_name ?? null,
      verdict: r.verdict,
      score: r.score,
      reasons: r.reasons ?? [],
      at: new Date(r.last_seen_at).toISOString(),
      firstSeen,
      newThisSweep: isNew(firstSeen),
    });
  }

  const clusters = [...byVictim.values()];
  for (const c of clusters) {
    // Newest first WITHIN a cluster, so the recent clone leads; and roll up
    // per-cluster recency (how many are new, and the latest detection).
    c.clones.sort((x, y) => +new Date(y.firstSeen) - +new Date(x.firstSeen));
    c.newCount = c.clones.filter((cl) => cl.newThisSweep).length;
    c.latestAt = c.clones.reduce((m, cl) => (cl.firstSeen > m ? cl.firstSeen : m), c.latestAt);
  }

  // Priority order the user asked for: Plus / noteworthy brands first, then the
  // ones with fresh detections, then by value and size. Recency breaks final ties.
  const noteworthy = (c: FraudCluster) => (c.victimPlus ? 2 : 0) + ((c.estSales ?? 0) >= 100_000 ? 1 : 0);
  return clusters.sort(
    (a, b) =>
      noteworthy(b) - noteworthy(a) ||
      (b.newCount > 0 ? 1 : 0) - (a.newCount > 0 ? 1 : 0) ||
      (b.estSales ?? 0) - (a.estSales ?? 0) ||
      b.clones.length - a.clones.length ||
      (b.latestAt > a.latestAt ? 1 : -1),
  );
}

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
  at: string;        // last confirmed
  firstSeen: string; // first detected
};

export type FraudCluster = {
  victim: string;
  victimName: string | null;
  victimEmail: string | null;
  estSales: number | null;
  enrolled: boolean; // already a Radar customer?
  clones: FraudClone[];
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fraudClusters(minScore = 25): Promise<FraudCluster[]> {
  await ensureSchema();
  const rows = await db()<any[]>`
    SELECT d.brand_domain AS victim, d.brand_name AS d_name, d.suspect, d.suspect_name,
           d.verdict, d.score, d.reasons, d.last_seen_at, d.first_seen_at,
           i.name AS i_name, i.email AS victim_email, i.estimated_monthly_sales AS est_sales,
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
        enrolled: Boolean(r.enrolled),
        clones: [],
      };
      byVictim.set(r.victim, c);
    }
    c.clones.push({
      suspect: r.suspect,
      suspectName: r.suspect_name ?? null,
      verdict: r.verdict,
      score: r.score,
      reasons: r.reasons ?? [],
      at: new Date(r.last_seen_at).toISOString(),
      firstSeen: new Date(r.first_seen_at).toISOString(),
    });
  }
  // Biggest clusters first, then most-copied by value.
  return [...byVictim.values()].sort(
    (a, b) => b.clones.length - a.clones.length || (b.estSales ?? 0) - (a.estSales ?? 0),
  );
}

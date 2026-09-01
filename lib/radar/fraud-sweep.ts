/** Market-wide fraud sweep as a callable function (mirrors scripts/radar-fraud-
 *  sweep.mjs) so it can be run on-demand from the admin UI, and records each run
 *  (radar_runs) with what changed. See the script for the method rationale. */

import { db, ensureSchema } from "./db";

const MIN_SHARED = 4;
const MAX_STEM_STORES = 15;
const MIN_PERSIST_SHARED = 10;

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);
function label(domain: string): string {
  const d = (domain || "").toLowerCase();
  if (d.endsWith(".myshopify.com")) return d.slice(0, -".myshopify.com".length);
  const parts = d.split(".");
  if (parts.length > 1) parts.pop();
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(".");
}
const HOMO: [RegExp, string][] = [[/rn/g, "m"], [/vv/g, "w"], [/0/g, "o"], [/1/g, "l"], [/5/g, "s"], [/3/g, "e"]];
function canon(s: string): string { let o = (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); for (const [re, to] of HOMO) o = o.replace(re, to); return o; }
function sameOwner(a: string, b: string): boolean {
  const ca = canon(label(a)), cb = canon(label(b));
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const [s, l] = ca.length < cb.length ? [ca, cb] : [cb, ca];
  return s.length >= 5 && l.includes(s);
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function scoreStore(s: any): number {
  let n = s.n_products || 0;
  if (s.est_sales) n += Math.min(50, s.est_sales / 1000);
  if (s.payments) n += 20;
  if (s.plus) n += 40;
  if (s.discovered) n -= 5;
  return n;
}

export type FraudSweepResult = {
  scanned: number;
  clusters: number;
  relationships: number;
  written: number;
  newDetections: number;
  ranAt: string;
};

export async function runFraudSweep(): Promise<FraudSweepResult> {
  await ensureSchema();
  const sql = db();

  const rows = await sql<any[]>`
    SELECT f.domain, f.image_stems, f.n_products,
           i.name, i.estimated_monthly_sales AS est_sales,
           i.plus, (i.payments IS NOT NULL AND i.payments <> '') AS payments,
           (i.discovered_at IS NOT NULL) AS discovered
    FROM store_fingerprints f
    LEFT JOIN imported_stores i ON i.domain = f.domain
    WHERE f.status = 'ok' AND f.n_products > 0`;

  const store = new Map<string, any>();
  for (const r of rows) store.set(r.domain, { ...r, stems: new Set<string>(r.image_stems || []) });

  const byStem = new Map<string, string[]>();
  for (const [domain, s] of store)
    for (const stem of s.stems) {
      if (!stem) continue;
      const arr = byStem.get(stem) ?? [];
      if (!byStem.has(stem)) byStem.set(stem, arr);
      arr.push(domain);
    }

  const pair = new Map<string, number>();
  for (const [, domains] of byStem) {
    if (domains.length < 2 || domains.length > MAX_STEM_STORES) continue;
    for (let i = 0; i < domains.length; i++)
      for (let j = i + 1; j < domains.length; j++) {
        const key = domains[i] < domains[j] ? `${domains[i]}|${domains[j]}` : `${domains[j]}|${domains[i]}`;
        pair.set(key, (pair.get(key) ?? 0) + 1);
      }
  }

  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (a: string, b: string) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  for (const [key, shared] of pair) { if (shared < MIN_SHARED) continue; const [a, b] = key.split("|"); union(a, b); }

  const clusters = new Map<string, string[]>();
  for (const d of parent.keys()) { const root = find(d); const arr = clusters.get(root) ?? []; if (!clusters.has(root)) clusters.set(root, arr); arr.push(d); }
  const groups = [...clusters.values()].filter((c) => c.length >= 2);

  type Det = { victim: string; victimName: string | null; clone: string; cloneName: string | null; shared: number; score: number; clusterSize: number };
  const detections: Det[] = [];
  for (const domains of groups) {
    const members = domains.map((d) => store.get(d)).sort((a, b) => scoreStore(b) - scoreStore(a));
    const victim = members[0];
    for (const c of members.slice(1)) {
      if (sameOwner(victim.domain, c.domain)) continue;
      let shared = 0;
      for (const stem of c.stems) if (victim.stems.has(stem)) shared++;
      const ratio = shared / Math.max(1, Math.min(victim.stems.size, c.stems.size));
      detections.push({ victim: victim.domain, victimName: victim.name, clone: c.domain, cloneName: c.name, shared, score: Math.min(100, Math.round(ratio * 100)), clusterSize: domains.length });
    }
  }
  const strong = detections.filter((d) => d.shared >= MIN_PERSIST_SHARED);

  // Which victim→clone pairs already exist? (to count what's genuinely new)
  const existing = new Set(
    (await sql<{ brand_domain: string; suspect: string }[]>`
      SELECT brand_domain, suspect FROM radar_detections WHERE source = 'fraud'`
    ).map((r) => `${r.brand_domain}|${r.suspect}`),
  );

  let written = 0, newDetections = 0;
  for (const d of strong) {
    const verdict = d.score >= 75 ? "COPY" : d.score >= 50 ? "LIKELY" : "PARTIAL";
    const reasons = [`${d.shared} identical product images shared with ${d.victim}`, `part of a ${d.clusterSize}-store catalogue-collision cluster`];
    if (!existing.has(`${d.victim}|${d.clone}`)) newDetections++;
    await sql`
      INSERT INTO radar_detections (brand_domain, suspect, brand_name, suspect_name, verdict, score, reasons, source, last_seen_at)
      VALUES (${d.victim}, ${d.clone}, ${d.victimName ?? d.victim}, ${d.cloneName ?? d.clone}, ${verdict}, ${d.score}, ${sql.json(reasons)}, 'fraud', now())
      ON CONFLICT (brand_domain, suspect) DO UPDATE SET
        verdict = EXCLUDED.verdict, score = EXCLUDED.score, reasons = EXCLUDED.reasons, source = 'fraud', last_seen_at = now()`;
    written++;
  }

  const summary = { scanned: rows.length, clusters: groups.length, relationships: detections.length, written, newDetections };
  await sql`INSERT INTO radar_runs (kind, summary) VALUES ('fraud', ${sql.json(summary)})`;
  return { ...summary, ranAt: new Date().toISOString() };
}

export type RadarRun = { kind: string; ranAt: string; summary: Record<string, number> };

/** The most recent run of a given kind, for the "last run" header. */
export async function lastRun(kind: string): Promise<RadarRun | null> {
  await ensureSchema();
  const [r] = await db()<{ ran_at: Date; summary: Record<string, number> }[]>`
    SELECT ran_at, summary FROM radar_runs WHERE kind = ${kind} ORDER BY ran_at DESC LIMIT 1`;
  return r ? { kind, ranAt: new Date(r.ran_at).toISOString(), summary: r.summary ?? {} } : null;
}

/** The last N runs of a kind, newest first — powers the run-history strip so you
 *  can see the cadence of sweeps and what each batch surfaced. */
export async function recentRuns(kind: string, n = 8): Promise<RadarRun[]> {
  await ensureSchema();
  const rows = await db()<{ ran_at: Date; summary: Record<string, number> }[]>`
    SELECT ran_at, summary FROM radar_runs WHERE kind = ${kind} ORDER BY ran_at DESC LIMIT ${n}`;
  return rows.map((r) => ({ kind, ranAt: new Date(r.ran_at).toISOString(), summary: r.summary ?? {} }));
}

/** Timestamp of the PREVIOUS run (the 2nd-most-recent) — the boundary for "new
 *  this sweep". Anything detected after this is fresh since you last looked.
 *  Null when there's only ever been one run (then everything is genuinely new). */
export async function previousRunAt(kind: string): Promise<string | null> {
  await ensureSchema();
  const [r] = await db()<{ ran_at: Date }[]>`
    SELECT ran_at FROM radar_runs WHERE kind = ${kind} ORDER BY ran_at DESC OFFSET 1 LIMIT 1`;
  return r ? new Date(r.ran_at).toISOString() : null;
}

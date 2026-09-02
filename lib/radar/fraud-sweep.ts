/** Market-wide fraud sweep, callable from the admin UI.
 *
 *  The algorithm lives in ./fraud-sweep-core.mjs and the scoring in
 *  ./clone-score.mjs — shared verbatim with scripts/radar-fraud-sweep.mjs, which
 *  the 4-hourly pipeline runs. This file is now just the typed entry point plus
 *  the run-history reads that power the sweep-history strip. */

import { db, ensureSchema } from "./db";
import { sweep } from "./fraud-sweep-core.mjs";

export type FraudSweepResult = {
  scanned: number;
  clusters: number;
  relationships: number;
  written: number;
  newDetections: number;
  retired: number;
  suppressed: number;
  ranAt: string;
};

export async function runFraudSweep(): Promise<FraudSweepResult> {
  await ensureSchema();
  return (await sweep(db(), { write: true })) as FraudSweepResult;
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

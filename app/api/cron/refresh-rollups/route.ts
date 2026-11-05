import { NextResponse } from "next/server";
import { aggAges, primeAgg } from "@/lib/agg-cache";
import { computeLeadersMarkets, computeLeadersReport } from "@/lib/leaders-report";
import { computeProviderMomentumByPeriod } from "@/lib/provider-insights";
import { computeTagCounts } from "@/lib/tags";

/** Warms the insights rollups that are NOT part of the typed insights_cache (lib/insights) — the
 *  market-leaders report, the leaders market picker, provider momentum and the tag counts.
 *
 *  Why a warmer at all, when agg_cache already serves stale-while-revalidate: SWR only helps once a
 *  row EXISTS. A genuinely cold key has to compute inline, and these computes measured 12-20s each,
 *  so the first viewer after a new deploy or a new market would pay the full scan. This guarantees
 *  the row is there before anyone looks.
 *
 *  Deliberately NOT every market: VISIBLE_MARKETS is 27 countries and warming all of them would be
 *  tens of minutes. The core markets cover almost every real page view; anything else warms lazily
 *  (one slow load, once ever, then SWR keeps it warm).
 *
 *  Keys already fresh are skipped, and the loop stops before the lambda deadline — so a run that
 *  cannot finish the list leaves the rest for the next one instead of being killed mid-compute. */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CORE_MARKETS = ["ZA", "KE", "NG"];
const COHORTS = [100, 500];
const FRESH_MS = 30 * 60 * 1000;   // skip anything refreshed within the last half hour
const BUDGET_MS = 270_000;         // leave headroom under maxDuration

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const token = new URL(req.url).searchParams.get("token");
    if (req.headers.get("authorization") !== `Bearer ${secret}` && token !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  const started = Date.now();

  // Cheapest first, so a tight budget still warms the highest-traffic keys.
  // Each `run` is the UNCACHED compute, never the cached wrapper. Passing the wrapper looks right
  // and silently defeats the warmer: on a stale key the wrapper returns the STALE value (scheduling
  // its own background refresh) and primeAgg would store that straight back with computed_at = now(),
  // so the key looks freshly computed for another whole TTL without having been recomputed.
  const jobs: { key: string; run: () => Promise<unknown> }[] = [
    { key: "tagcounts:v1", run: computeTagCounts },
    { key: "leaders:markets:v1:20", run: () => computeLeadersMarkets(20) },
  ];
  for (const c of CORE_MARKETS) {
    jobs.push({ key: `provmomentum:v1:${c}`, run: () => computeProviderMomentumByPeriod(c) });
    for (const n of COHORTS) jobs.push({ key: `leaders:v1:${c}:${n}`, run: () => computeLeadersReport(c, n) });
  }

  const ages = await aggAges(jobs.map((j) => j.key));
  const warmed: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let ranOut = false;

  // SEQUENTIAL on purpose: these are full-corpus aggregates and the postgres.js pool is tiny —
  // fanning them out is the Promise.all pool-deadlock class, and it is what saturates disk IO.
  for (const job of jobs) {
    const age = ages.get(job.key);
    if (age !== undefined && age < FRESH_MS) { skipped.push(job.key); continue; }
    if (Date.now() - started > BUDGET_MS) { ranOut = true; break; }
    try { await primeAgg(job.key, job.run); warmed.push(job.key); }
    catch { failed.push(job.key); }
  }

  return NextResponse.json({
    ok: failed.length === 0,
    warmed, skipped, failed,
    incomplete: ranOut || undefined,
    ms: Date.now() - started,
  });
}

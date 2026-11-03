/** Generic shared aggregate cache (pre-aggregation). Any expensive, viewer-agnostic rollup can be
 *  wrapped in `cachedAgg(key, freshMs, compute)`: it serves a fresh cached JSONB row (one indexed
 *  read, fast even on a cold serverless start), serves a stale row instantly while refreshing in the
 *  background (Next `after()`), and computes live only on a cold key. Powers /ops, /insights/africa,
 *  and the provider pages. (Insights has its own typed cache in lib/insights.ts.)
 *
 *  NOTE: values round-trip through JSONB, so Date fields come back as strings — only cache
 *  plain/JSON-safe shapes (numbers, strings, arrays, plain objects). */
import { db as sharedDb } from "./db";
import { after } from "next/server";

function db() {
  return sharedDb();
}

async function store(key: string, data: unknown): Promise<void> {
  await db()`
    INSERT INTO agg_cache (key, data, computed_at)
    VALUES (${key}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, computed_at = now()`.catch(() => {});
}

export async function cachedAgg<T>(key: string, freshMs: number, compute: () => Promise<T>): Promise<T> {
  let row: { data: T; computed_at: Date } | undefined;
  try {
    [row] = await db()<{ data: T; computed_at: Date }[]>`SELECT data, computed_at FROM agg_cache WHERE key = ${key}`;
  } catch { /* table missing / db hiccup → compute live */ }
  // postgres.js can return a jsonb column as a raw JSON string — parse defensively so callers always
  // get a real object, never a string.
  const parse = (d: T | string): T => (typeof d === "string" ? (JSON.parse(d) as T) : d);

  if (row && Date.now() - new Date(row.computed_at).getTime() < freshMs) return parse(row.data); // fresh → fast

  // STALE-WHILE-REVALIDATE: a stale row is served INSTANTLY and the refresh runs after the response
  // (Next after() → Vercel waitUntil), so no viewer ever waits on a recompute. Only a genuinely COLD
  // key (no row at all) computes inline. This is what keeps the paid insights pages fast even when
  // the aggregate itself is slow to build on the flaky pooler.
  if (row) {
    let scheduled = false;
    try {
      after(async () => { try { await store(key, await compute()); } catch { /* refresh best-effort */ } });
      scheduled = true;
    } catch { /* not in a request scope (e.g. a script/warmer) → fall through to inline refresh */ }
    if (scheduled) return parse(row.data);              // stale now, fresh next time
    try { const data = await compute(); await store(key, data); return data; }
    catch { return parse(row.data); }                    // inline refresh failed → serve stale
  }

  // Cold key → must compute inline (once ever per key; then SWR keeps it warm).
  try {
    const data = await compute();
    await store(key, data);
    return data;
  } catch (e) {
    throw e;
  }
}

/** Force-recompute a key and store the result, bypassing the read/SWR path entirely.
 *  For WARMERS (the cron routes): `cachedAgg` on a stale key schedules the refresh in `after()` and
 *  returns stale, which is right for a viewer but useless for a warmer — it would return without
 *  having warmed anything. This computes inline and writes through. Throws on failure so the caller
 *  can report which keys warmed. */
export async function primeAgg<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const data = await compute();
  await store(key, data);
  return data;
}

/** Drop a key so the next read recomputes from scratch. Use after a WRITE that invalidates a cached
 *  rollup (e.g. an admin applying a tag changes tagCounts) — without this the admin would stare at a
 *  stale count for the whole TTL and reasonably conclude the write failed. */
export async function invalidateAgg(key: string): Promise<void> {
  await db()`DELETE FROM agg_cache WHERE key = ${key}`.catch(() => {});
}

/** Age in ms of each given key, or absent from the map when the key has no row at all. One query,
 *  so a warmer can skip keys that are still fresh instead of recomputing the whole set every run. */
export async function aggAges(keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  try {
    const rows = await db()<{ key: string; age_ms: number }[]>`
      SELECT key, (EXTRACT(EPOCH FROM (now() - computed_at)) * 1000)::bigint AS age_ms
      FROM agg_cache WHERE key = ANY(${keys}::text[])`;
    for (const r of rows) out.set(r.key, Number(r.age_ms));
  } catch { /* table missing → treat every key as cold */ }
  return out;
}

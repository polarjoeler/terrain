/** Generic shared aggregate cache (pre-aggregation). Any expensive, viewer-agnostic rollup can be
 *  wrapped in `cachedAgg(key, freshMs, compute)`: it serves a fresh cached JSONB row (one indexed
 *  read, fast even on a cold serverless start), serves a stale row instantly while refreshing in the
 *  background (Next `after()`), and computes live only on a cold key. Powers /ops, /insights/africa,
 *  and the provider pages. (Insights has its own typed cache in lib/insights.ts.)
 *
 *  NOTE: values round-trip through JSONB, so Date fields come back as strings — only cache
 *  plain/JSON-safe shapes (numbers, strings, arrays, plain objects). */
import postgres from "postgres";
import { after } from "next/server";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
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

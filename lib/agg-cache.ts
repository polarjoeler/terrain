/** Generic shared aggregate cache (pre-aggregation). Any expensive, viewer-agnostic rollup can be
 *  wrapped in `cachedAgg(key, freshMs, compute)`: it serves a fresh cached JSONB row (one indexed
 *  read, fast even on a cold serverless start), serves a stale row instantly while refreshing in the
 *  background (Next `after()`), and computes live only on a cold key. Powers /ops, /insights/africa,
 *  and the provider pages. (Insights has its own typed cache in lib/insights.ts.)
 *
 *  NOTE: values round-trip through JSONB, so Date fields come back as strings — only cache
 *  plain/JSON-safe shapes (numbers, strings, arrays, plain objects). */
import postgres from "postgres";

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

async function backgroundRefresh<T>(key: string, compute: () => Promise<T>): Promise<void> {
  const run = async () => {
    const data = await compute().catch(() => null);
    if (data != null) await store(key, data);
  };
  try {
    const { after } = await import("next/server"); // run after the response is sent
    after(run);
  } catch {
    await run(); // no request context (script) — inline
  }
}

export async function cachedAgg<T>(key: string, freshMs: number, compute: () => Promise<T>): Promise<T> {
  let row: { data: T; computed_at: Date } | undefined;
  try {
    [row] = await db()<{ data: T; computed_at: Date }[]>`SELECT data, computed_at FROM agg_cache WHERE key = ${key}`;
  } catch { /* table missing / db hiccup → compute live */ }
  if (row) {
    const ageMs = Date.now() - new Date(row.computed_at).getTime();
    if (ageMs < freshMs) return row.data;          // fresh → fast
    void backgroundRefresh(key, compute);          // stale → serve stale, refresh async
    return row.data;
  }
  const data = await compute();                    // cold → compute + store
  await store(key, data);
  return data;
}

/** ONE shared postgres pool for the entire app request path.
 *
 *  Before this, ~20 lib modules each created their OWN postgres() pool. A single page touches
 *  several of them, so on a fresh serverless instance one request cold-connected N separate pools
 *  (~1s each, measured) before running a single query — a multi-second cold-start tax — and opened
 *  up to 20 × max:3 = 60 connections to the Supabase transaction pooler per instance, which is a
 *  prime suspect for the recurring pooler exhaustion / ENOTFOUND / CONNECT_TIMEOUT flakiness.
 *
 *  All modules now share this singleton: one cold connect per instance, reused across every query,
 *  and a bounded connection footprint. `prepare:false` is required by the transaction pooler;
 *  connect_timeout fails fast on a stalled pooler instead of hanging the request.
 *
 *  NOTE on concurrency: this is max:8, but the pool is still finite — do NOT Promise.all a large
 *  query fan-out on it (postgres.js queues past `max` and can deadlock the request). Run a page's
 *  heavy aggregates sequentially, or in small bounded batches. See lib/insights.ts. */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

// The transaction pooler (…pooler.supabase.com:6543) multiplexes thousands of clients and is the
// ONLY correct target for the app + fleet. The SESSION pooler (:5432) has a hard 15-client cap and
// throws EMAXCONNSESSION the moment any real concurrency hits it — a trap we fell into once via a
// stale dev-server env and misread as "the DB is too small" for days. Fail loud, never silent again.
function assertTransactionPooler(url: string): void {
  try {
    const port = new URL(url).port;
    if (port === "5432") {
      const msg =
        "DATABASE_URL points at the Supabase SESSION pooler (:5432, hard 15-client cap). " +
        "Use the TRANSACTION pooler (:6543) — the session pooler will throw EMAXCONNSESSION under load.";
      // Loud in every environment; hard-stop outside production so it's caught before it ships.
      console.error("⚠️  " + msg);
      if (process.env.NODE_ENV !== "production") throw new Error(msg);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("SESSION pooler")) throw e;
    /* URL parse failed → leave it to postgres() to surface */
  }
}

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    assertTransactionPooler(url);
    _sql = postgres(url, { prepare: false, max: 8, idle_timeout: 20, connect_timeout: 10 });
  }
  return _sql;
}

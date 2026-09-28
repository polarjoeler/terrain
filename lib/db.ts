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

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 8, idle_timeout: 20, connect_timeout: 10 });
  }
  return _sql;
}

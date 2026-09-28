<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Performance — keep it fast

The DB is a Supabase transaction pooler with ~200–300ms/query warm latency and ~1s cold connect; pages make many round-trips, so latency (not compute) is usually what's slow. Rules:

1. **One DB pool.** Import `db()` from `lib/db.ts` — never call `postgres(...)` in a lib module. (Standalone `scripts/` may keep their own.) Multiple pools = per-pool cold-connect tax on every serverless start + pooler connection exhaustion (the source of the recurring ENOTFOUND/CONNECT_TIMEOUT). Always pass `prepare: false` (the shared pool does) — the transaction pooler rejects prepared statements.
2. **Cache viewer-agnostic aggregates with `cachedAgg`** (`lib/agg-cache.ts`). Anything identical for every subscriber (insights, ops, provider stats) is a cached JSONB row, not a per-request recompute. It's stale-while-revalidate: a stale row serves instantly and refreshes in the background, so no viewer waits on a recompute.
3. **Minimize sequential round-trips**, but do NOT `Promise.all` a large fan-out on the pool — it queues past `max` and deadlocks the page. Combine into one query, or run heavy aggregates sequentially / in small bounded batches.
4. **`force-dynamic` only when the response is truly per-user.** Otherwise it can cache.
5. **Index-friendly SQL.** Match stored casing (`country = 'ZA'`, not `UPPER(country) = 'ZA'` — the wrapper defeats the index).
6. **Client-fetch heavy, non-critical widgets** (charts, tables) from a cached API so they stream in after the page shell instead of blocking it.

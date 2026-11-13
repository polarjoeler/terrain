// True once the slim store_work table (scripts/store-work.mjs) exists and its backfill has finished.
// Until then every reader keeps its old query on imported_stores, so the scripts work before and
// after the migration.
export async function workReady(sql) {
  const [r] = await sql`SELECT to_regclass('public.store_work') IS NOT NULL w,
    EXISTS (SELECT 1 FROM app_settings WHERE key = 'store-work.backfill') b`;
  return r.w && !r.b;
}
// True once build-rollups.mjs has written store_rollup within maxAgeMin minutes.
export async function rollupFresh(sql, maxAgeMin = 180) {
  const [r] = await sql`SELECT to_regclass('public.store_rollup') IS NOT NULL t`;
  if (!r.t) return false;
  const [b] = await sql`SELECT max(built_at) at FROM store_rollup`;
  return !!b?.at && Date.now() - new Date(b.at).getTime() < maxAgeMin * 60000;
}

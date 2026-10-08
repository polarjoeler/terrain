/** Refresh the committed homepage-map fallback (lib/africa-timeline-snapshot.json).
 *
 *  The home + /africa pages render the Africa timeline map. It's an ~8s aggregate, so it's served from
 *  the durable agg_cache (kept warm by the refresh-browse cron), with this committed JSON as the
 *  guaranteed fallback — the map NEVER renders blank, even on a cold cache or a DB outage.
 *
 *  This reads the current warm agg_cache row (so it never has to recompute the heavy aggregate here —
 *  and avoids importing the server-only timeline module) and writes it to the committed file. Run it
 *  occasionally to keep the baked-in fallback reasonably current:
 *
 *    node --env-file=.env.local scripts/snapshot-africa.mjs
 *
 *  If there's no cached row yet, warm it first — hit the homepage, or let the daily refresh-browse cron run.
 */
import postgres from "postgres";
import { writeFileSync } from "node:fs";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 10 });
try {
  const [row] = await sql`SELECT data FROM agg_cache WHERE key = 'africa:timeline:v3'`;
  if (!row) { console.error("No agg_cache row for africa:timeline:v3 — warm it first (visit the homepage, or run the refresh-browse cron)."); process.exit(1); }
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  if (!data?.months?.length) { console.error("Cached row is empty — not overwriting the committed fallback."); process.exit(1); }
  writeFileSync("lib/africa-timeline-snapshot.json", JSON.stringify(data));
  console.log(`Refreshed lib/africa-timeline-snapshot.json: ${data.months.length} months, ${Object.keys(data.countries ?? {}).length} countries, ${data.pulses?.length ?? 0} pulses.`);
} finally {
  await sql.end();
}

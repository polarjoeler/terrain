/** Weekly per-provider snapshot → provider_snapshots. Powers the "over time" trend
 *  lines on the shareable provider dashboards. Self-contained (no lib imports), so
 *  it runs from the pipeline like the other .mjs jobs. Idempotent per (provider,date).
 *
 *   node --env-file=.env.local scripts/snapshot-providers.mjs [--min 5]
 */
import postgres from "postgres";

const MIN = (() => { const i = process.argv.indexOf("--min"); return i > -1 ? Number(process.argv[i + 1]) : 5; })();
const norm = (s) => s.trim().toLowerCase();

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS provider_snapshots (
      provider TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'ALL', date DATE NOT NULL DEFAULT CURRENT_DATE,
      data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (provider, country, date))`;

    const rows = await sql`
      SELECT country, payments, discovered_at FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND payments IS NOT NULL AND payments <> ''`;

    // Aggregate per gateway: total / top-spot / exclusive / new-in-7d.
    const agg = new Map(); // provider(lower) -> {name,total,topSpot,exclusive,newLast7,rankSum}
    for (const r of rows) {
      const gws = String(r.payments).split(";").map((x) => x.trim()).filter(Boolean);
      const fresh = r.discovered_at != null && (Date.now() - new Date(r.discovered_at).getTime()) <= 7 * 864e5;
      gws.forEach((g, i) => {
        const k = norm(g);
        const a = agg.get(k) ?? { name: g, total: 0, topSpot: 0, exclusive: 0, newLast7: 0, rankSum: 0 };
        a.total++; a.rankSum += i + 1;
        if (i === 0) a.topSpot++;
        if (gws.length === 1) a.exclusive++;
        if (fresh) a.newLast7++;
        agg.set(k, a);
      });
    }

    let n = 0;
    for (const a of agg.values()) {
      if (a.total < MIN) continue;
      const data = {
        total: a.total, topSpot: a.topSpot, exclusive: a.exclusive, newLast7: a.newLast7,
        topSpotPct: Math.round((100 * a.topSpot) / a.total),
        exclusivePct: Math.round((100 * a.exclusive) / a.total),
        avgRank: Math.round((a.rankSum / a.total) * 10) / 10,
      };
      await sql`INSERT INTO provider_snapshots (provider, country, date, data)
        VALUES (${a.name}, ${"ALL"}, CURRENT_DATE, ${sql.json(data)})
        ON CONFLICT (provider, country, date) DO UPDATE SET data = EXCLUDED.data`;
      n++;
    }
    console.log(`✓ Snapshotted ${n} providers (≥${MIN} stores) for ${new Date().toISOString().slice(0, 10)}.`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

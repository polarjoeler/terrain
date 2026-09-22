/** Weekly/daily per-provider snapshot → provider_snapshots. Powers the "market
 *  share over time" chart on the shareable provider dashboards. Snapshots per
 *  country (ALL + each market) with the verified base, so share = total ÷ base is
 *  computable at every point. Self-contained; runs from the pipeline. Idempotent
 *  per (provider, country, date).
 *
 *   node --env-file=.env.local scripts/snapshot-providers.mjs [--min 5]
 */
import postgres from "postgres";

const MIN = (() => { const i = process.argv.indexOf("--min"); return i > -1 ? Number(process.argv[i + 1]) : 5; })();
const norm = (s) => s.trim().toLowerCase();
// CANONICAL RULE (payment market share): count ONLY stores whose payments WE probe-verified — our
// Shopify checkout probe (payments_source NULL) or Woo probe (woo_*). NEVER a vendor import
// (payments_source='storecensus'): its generic US-stack data misses local PSPs and pads the
// denominator, diluting every real provider's share (the KE incident). Keep this identical in
// lib/provider-insights.ts and lib/insights.ts — don't reintroduce vendor rows into a share base.
const isProbeVerified = (r) => r.payments_source !== "storecensus";

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS provider_snapshots (
      provider TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'ALL', platform TEXT NOT NULL DEFAULT 'all',
      date DATE NOT NULL DEFAULT CURRENT_DATE, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, country, platform, date))`;
    // One-time migration: older tables keyed (provider,country,date) — add platform to the PK so the
    // combined 'all' rows and the per-CMS rows can coexist. Existing rows default to platform='all'.
    const [pk] = await sql`SELECT count(*)::int c FROM information_schema.key_column_usage
      WHERE constraint_name = 'provider_snapshots_pkey' AND column_name = 'platform'`;
    if (!pk.c) {
      await sql`ALTER TABLE provider_snapshots ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'all'`;
      await sql`ALTER TABLE provider_snapshots DROP CONSTRAINT IF EXISTS provider_snapshots_pkey`;
      await sql`ALTER TABLE provider_snapshots ADD PRIMARY KEY (provider, country, platform, date)`;
    }

    const rows = await sql`
      SELECT country, platform, payments, discovered_at, payments_source FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND payments IS NOT NULL AND payments <> ''`;

    // Per (platform|country|gateway) counters + verified base per (platform|country). We roll a
    // combined 'all' platform (every CMS) AND each store's own CMS, and 'ALL' country AND its own
    // country — so the insights page stays combined by default yet drills into Shopify / Woo / … .
    const agg = new Map();          // "platform|country|gatewayLower" -> {name,total,...}
    const base = new Map();         // "platform|country" -> verified store count
    const bump = (plat, country, g, i, gws, fresh) => {
      const k = plat + "|" + country + "|" + norm(g);
      const a = agg.get(k) ?? { name: g, total: 0, topSpot: 0, exclusive: 0, newLast7: 0, rankSum: 0 };
      a.total++; a.rankSum += i + 1;
      if (i === 0) a.topSpot++;
      if (gws.length === 1) a.exclusive++;
      if (fresh) a.newLast7++;
      agg.set(k, a);
    };
    for (const r of rows) {
      if (!isProbeVerified(r)) continue; // only stores WE verified count toward market share
      const c = (r.country || "??").toUpperCase();
      const plat = (r.platform || "").toLowerCase() || "unknown";
      const gws = String(r.payments).split(";").map((x) => x.trim()).filter(Boolean);
      const fresh = r.discovered_at != null && (Date.now() - new Date(r.discovered_at).getTime()) <= 7 * 864e5;
      for (const P of new Set(["all", plat])) for (const C of new Set(["ALL", c])) {
        base.set(P + "|" + C, (base.get(P + "|" + C) ?? 0) + 1);
        gws.forEach((g, i) => bump(P, C, g, i, gws, fresh));
      }
    }

    let n = 0;
    for (const [key, a] of agg.entries()) {
      if (a.total < MIN) continue;
      const parts = key.split("|");
      const platform = parts[0], country = parts[1];
      const verifiedBase = base.get(platform + "|" + country) ?? a.total;
      const data = {
        total: a.total, topSpot: a.topSpot, exclusive: a.exclusive, newLast7: a.newLast7, verifiedBase,
        share: Math.round((10000 * a.total) / verifiedBase) / 100, // % market share, 2dp
        topSpotPct: Math.round((100 * a.topSpot) / a.total),
        exclusivePct: Math.round((100 * a.exclusive) / a.total),
        avgRank: Math.round((a.rankSum / a.total) * 10) / 10,
      };
      await sql`INSERT INTO provider_snapshots (provider, country, platform, date, data)
        VALUES (${a.name}, ${country}, ${platform}, CURRENT_DATE, ${sql.json(data)})
        ON CONFLICT (provider, country, platform, date) DO UPDATE SET data = EXCLUDED.data`;
      n++;
    }
    console.log(`✓ Snapshotted ${n} provider×country×platform rows (≥${MIN} stores) for ${new Date().toISOString().slice(0, 10)}.`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

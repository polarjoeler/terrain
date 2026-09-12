#!/usr/bin/env node
/**
 * Partner-graph P1 — normalize the who-uses-which-provider data into a queryable graph +
 * time-series. Materializes from what we already have (imported_stores.payments / apps /
 * shipping_providers / theme + payment_changes), so PSP-facing footprint / win-loss /
 * co-occurrence queries run off real tables instead of string-scanning every row.
 *
 *   node --env-file=.env.local scripts/partner-graph.mjs            # init + backfill + rollup
 *   node --env-file=.env.local scripts/partner-graph.mjs --rollup   # just refresh today's snapshots
 *
 * Scoped to target markets (Africa + JP) — the sellable universe. Global is banked, not graphed yet.
 */
import postgres from "postgres";

const args = process.argv.slice(2);
const only = (f) => args.includes(f);
const PHASES = ["--init", "--edges", "--events", "--backfill", "--rollup"];
const noPhase = !args.some((a) => PHASES.includes(a));
const doInit = only("--init") || noPhase;
const doEdges = only("--edges") || only("--backfill") || noPhase;
const doEvents = only("--events") || only("--backfill") || noPhase;
const doRollup = only("--rollup") || noPhase;

const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
// Payment rails/brands that render at checkout but aren't gateways — kept out of the payment graph.
const PAY_NOISE = new Set(["instant eft", "bank deposit", "eft", "bank transfer", "cash on delivery",
  "cod", "manual payment", "manual", "other", "credit card", "debit card", "card", "visa",
  "mastercard", "amex", "american express", "discover", "maestro", "diners club", "diners",
  "unionpay", "jcb"]);
const slugify = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const toks = (s) => (s ? String(s).split(";").map((t) => t.trim()).filter(Boolean) : []);

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 6 });

async function init() {
  await sql`CREATE TABLE IF NOT EXISTS partners (
    id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
    aliases TEXT[] DEFAULT '{}', metadata JSONB DEFAULT '{}', UNIQUE (kind, slug))`;
  await sql`CREATE TABLE IF NOT EXISTS store_partners (
    store_domain TEXT NOT NULL, partner_id BIGINT NOT NULL REFERENCES partners(id), kind TEXT NOT NULL,
    rank INT, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    active BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (store_domain, partner_id))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_store_partners_partner ON store_partners (partner_id, kind) WHERE active`;
  await sql`CREATE INDEX IF NOT EXISTS idx_store_partners_domain ON store_partners (store_domain)`;
  await sql`CREATE TABLE IF NOT EXISTS partner_events (
    id BIGSERIAL PRIMARY KEY, store_domain TEXT NOT NULL, partner_id BIGINT NOT NULL REFERENCES partners(id),
    kind TEXT NOT NULL, event TEXT NOT NULL, from_rank INT, to_rank INT, country TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS idx_partner_events_partner ON partner_events (partner_id, at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_partner_events_at ON partner_events (at DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS partner_snapshots (
    partner_id BIGINT NOT NULL REFERENCES partners(id), country TEXT NOT NULL, date DATE NOT NULL,
    merchants INT, share_pct NUMERIC, avg_rank NUMERIC, top_spot INT,
    gained_7d INT, lost_7d INT, net_7d INT, data JSONB DEFAULT '{}',
    PRIMARY KEY (partner_id, country, date))`;
  console.log("✓ schema ready (partners, store_partners, partner_events, partner_snapshots)");
}

/** Upsert a partner and return its id, cached in-process. */
const pcache = new Map();
async function partnerId(kind, token) {
  const slug = slugify(token);
  const key = `${kind}|${slug}`;
  if (pcache.has(key)) return pcache.get(key);
  const [r] = await sql`INSERT INTO partners (kind, slug, name) VALUES (${kind}, ${slug}, ${token.trim()})
    ON CONFLICT (kind, slug) DO UPDATE SET name = partners.name RETURNING id`;
  pcache.set(key, r.id);
  return r.id;
}

async function backfillEdges() {
  const stores = await sql`SELECT domain, payments, apps, shipping_providers, theme
    FROM imported_stores
    WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
      AND UPPER(country) = ANY(${MARKETS})`;
  console.log(`Backfilling partner edges for ${stores.length.toLocaleString()} target-market stores…`);

  let edges = 0;
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    // upsert edges; bump last_seen + reactivate on re-run
    await sql`INSERT INTO store_partners ${sql(batch, "store_domain", "partner_id", "kind", "rank")}
      ON CONFLICT (store_domain, partner_id)
      DO UPDATE SET last_seen_at = now(), active = true, rank = EXCLUDED.rank`;
    edges += batch.length;
    batch.length = 0;
  };

  for (const s of stores) {
    // payments — ordered → rank; drop rails/brand noise
    const pay = toks(s.payments).filter((t) => !PAY_NOISE.has(t.toLowerCase()));
    for (let i = 0; i < pay.length; i++) batch.push({ store_domain: s.domain, partner_id: await partnerId("payment", pay[i]), kind: "payment", rank: i + 1 });
    for (const a of toks(s.apps)) batch.push({ store_domain: s.domain, partner_id: await partnerId("app", a), kind: "app", rank: null });
    for (const sh of toks(s.shipping_providers)) batch.push({ store_domain: s.domain, partner_id: await partnerId("shipping", sh), kind: "shipping", rank: null });
    if (s.theme) batch.push({ store_domain: s.domain, partner_id: await partnerId("theme", s.theme), kind: "theme", rank: null });
    if (batch.length >= 500) await flush();
  }
  await flush();
  console.log(`✓ ${edges.toLocaleString()} edges · ${pcache.size.toLocaleString()} distinct partners`);
}

// Backfill payment switch history into partner_events — SET-BASED (one insert per event type,
// no per-row round-trips). partners already hold the payment slugs from the edge backfill.
async function backfillEvents() {
  const noise = [...PAY_NOISE];
  await sql`DELETE FROM partner_events WHERE kind = 'payment'`;
  for (const [col, event] of [["added", "added"], ["removed", "removed"]]) {
    const r = await sql`
      INSERT INTO partner_events (store_domain, partner_id, kind, event, country, at)
      SELECT pc.domain, p.id, 'payment', ${event}, UPPER(i.country), pc.changed_at
      FROM payment_changes pc
      JOIN imported_stores i USING (domain)
      CROSS JOIN LATERAL unnest(pc.${sql(col)}) AS a(tok)
      JOIN partners p ON p.kind = 'payment' AND p.slug = lower(btrim(a.tok))
      WHERE UPPER(i.country) = ANY(${MARKETS}) AND lower(btrim(a.tok)) <> ALL(${noise})`;
    console.log(`✓ ${event}: ${r.count.toLocaleString()} payment events`);
  }
}

async function rollup() {
  // Fully SET-BASED: one INSERT…SELECT builds every (partner × market) snapshot for today —
  // totals (for payment share%), per-partner aggregates, and 7-day gained/lost — in a single
  // round-trip. (Per-row inserts here were ~3 rows/sec.)
  const r = await sql`
    WITH tot AS (
      SELECT UPPER(i.country) c, COUNT(DISTINCT sp.store_domain) n
      FROM store_partners sp JOIN imported_stores i ON i.domain = sp.store_domain
      WHERE sp.active AND sp.kind = 'payment' AND UPPER(i.country) = ANY(${MARKETS}) GROUP BY 1),
    agg AS (
      SELECT sp.partner_id, sp.kind, UPPER(i.country) c,
        COUNT(*) merchants, AVG(sp.rank) avg_rank, COUNT(*) FILTER (WHERE sp.rank = 1) top_spot
      FROM store_partners sp JOIN imported_stores i ON i.domain = sp.store_domain
      WHERE sp.active AND UPPER(i.country) = ANY(${MARKETS}) GROUP BY 1, 2, 3),
    gl AS (
      SELECT partner_id, UPPER(country) c,
        COUNT(*) FILTER (WHERE event = 'added'   AND at >= now()-interval '7 days') gained,
        COUNT(*) FILTER (WHERE event = 'removed' AND at >= now()-interval '7 days') lost
      FROM partner_events WHERE country IS NOT NULL GROUP BY 1, 2)
    INSERT INTO partner_snapshots (partner_id, country, date, merchants, share_pct, avg_rank, top_spot, gained_7d, lost_7d, net_7d)
    SELECT a.partner_id, a.c, CURRENT_DATE, a.merchants,
      CASE WHEN a.kind = 'payment' AND t.n > 0 THEN round(100.0 * a.merchants / t.n, 2) END,
      round(a.avg_rank, 2), a.top_spot,
      COALESCE(g.gained, 0), COALESCE(g.lost, 0), COALESCE(g.gained, 0) - COALESCE(g.lost, 0)
    FROM agg a LEFT JOIN tot t ON t.c = a.c LEFT JOIN gl g ON g.partner_id = a.partner_id AND g.c = a.c
    ON CONFLICT (partner_id, country, date) DO UPDATE SET
      merchants = EXCLUDED.merchants, share_pct = EXCLUDED.share_pct, avg_rank = EXCLUDED.avg_rank,
      top_spot = EXCLUDED.top_spot, gained_7d = EXCLUDED.gained_7d, lost_7d = EXCLUDED.lost_7d, net_7d = EXCLUDED.net_7d`;
  console.log(`✓ rolled up ${r.count.toLocaleString()} (partner × market) snapshots for today`);
}

async function main() {
  if (doInit) await init();
  if (doEdges) await backfillEdges();
  if (doEvents) await backfillEvents();
  if (doRollup) await rollup();
  await sql.end();
}
main().catch((e) => { console.error("partner-graph failed:", e.message); process.exit(1); });

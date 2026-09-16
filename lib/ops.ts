/** Live operations status — the numbers + machine heartbeats behind the /ops dashboard.
 *  Read fresh on every request (no cache) so it's a real-time cross-device status page. */
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) _sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

const MK = ["AO", "BW", "CI", "CM", "DZ", "EG", "ET", "GH", "KE", "LS", "LY", "MA", "MU", "MW",
  "MZ", "NA", "NG", "RW", "SN", "SO", "SZ", "TN", "TZ", "UG", "ZA", "ZM", "ZW", "JP"];
const CORE = ["ZA", "KE", "NG"];

export type Heartbeat = { label: string; ageMins: number | null; ok: boolean; detail: string };
export type OpsStatus = {
  at: string;
  discovery: { today: number; yesterday: number };
  payments: { coverage: number; backlog: number; probed12h: number };
  launched: { since: number; filled12h: number };
  woo: { total: number; cohortConfirmed: number; cohortReal: number };
  machines: Heartbeat[];
};

const mins = (d: Date | null): number | null => (d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null);

export async function opsStatus(): Promise<OpsStatus> {
  const sql = db();
  const LAUNCH = sql`COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at)`;

  const [disc, pay, launch, woo, hb] = await Promise.all([
    sql<{ today: number; yest: number }[]>`
      SELECT count(*) FILTER (WHERE source='ct_tail' AND discovered_at=CURRENT_DATE)::int today,
             count(*) FILTER (WHERE source='ct_tail' AND discovered_at=CURRENT_DATE-1)::int yest
      FROM imported_stores`,
    sql<{ live: number; haspay: number; backlog: number; probed12h: number }[]>`
      SELECT count(*)::int live,
             count(*) FILTER (WHERE payments IS NOT NULL AND payments<>'')::int haspay,
             count(*) FILTER (WHERE payments_checked_at IS NULL)::int backlog,
             count(*) FILTER (WHERE payments_checked_at > now()-interval '12 hours')::int probed12h
      FROM imported_stores WHERE published AND platform='Shopify'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND country = ANY(${CORE})`,
    sql<{ since: number; filled12h: number }[]>`
      SELECT count(*) FILTER (WHERE country='ZA' AND platform IS DISTINCT FROM 'woocommerce' AND ${LAUNCH} >= '2026-07-30'::date)::int since,
             count(*) FILTER (WHERE launched_source='earliest_product' AND catalog_checked_at > now()-interval '12 hours')::int filled12h
      FROM imported_stores`,
    sql<{ total: number; confirmed: number; real: number }[]>`
      SELECT count(*) FILTER (WHERE platform='woocommerce')::int total,
             count(*) FILTER (WHERE platform='woocommerce' AND domain IN (SELECT domain FROM store_tags WHERE tag='woo-2019-sa'))::int confirmed,
             count(*) FILTER (WHERE platform='woocommerce' AND activity_tier IN ('selling','active','dormant') AND domain IN (SELECT domain FROM store_tags WHERE tag='woo-2019-sa'))::int real
      FROM imported_stores`,
    // heartbeats: last activity TIMESTAMP per machine role (created_at = row-insert time, a real
    // timestamptz — discovered_at is only a DATE so it can't heartbeat).
    sql<{ chad_pay: Date | null; vps_disc: Date | null; lucy_woo: Date | null; lucy_launch: Date | null }[]>`
      SELECT
        (SELECT max(payments_checked_at) FROM imported_stores)                                              chad_pay,
        (SELECT max(created_at) FROM imported_stores WHERE source='ct_tail')                                vps_disc,
        (SELECT max(created_at) FROM imported_stores WHERE source='woo_ct')                                 lucy_woo,
        (SELECT max(catalog_checked_at) FROM imported_stores WHERE launched_source='earliest_product')      lucy_launch`,
  ]);

  const p = pay[0]; const h = hb[0];
  const beat = (label: string, d: Date | null, freshMins: number, detail: string): Heartbeat => {
    const a = mins(d);
    return { label, ageMins: a, ok: a != null && a <= freshMins, detail };
  };

  return {
    at: new Date().toISOString(),
    discovery: { today: Number(disc[0].today), yesterday: Number(disc[0].yest) },
    payments: { coverage: p.live ? Math.round((100 * p.haspay) / p.live) : 0, backlog: Number(p.backlog), probed12h: Number(p.probed12h) },
    launched: { since: Number(launch[0].since), filled12h: Number(launch[0].filled12h) },
    woo: { total: Number(woo[0].total), cohortConfirmed: Number(woo[0].confirmed), cohortReal: Number(woo[0].real) },
    machines: [
      beat("Chad · payments", h.chad_pay, 120, "checkout probing"),
      beat("Discovery · VPS → landing", h.vps_disc, 360, "CT-log landings (4h cadence)"),
      beat("Lucy · launch dates", h.lucy_launch, 180, "fresh-IP launch enrichment"),
    ],
  };
}

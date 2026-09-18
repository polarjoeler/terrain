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
// Two tracks, per platform, over the CORE markets (ZA/KE/NG):
//   Track A (coverage) — how complete/fresh OUR dataset is (progress, always improving).
//   Track B (market)   — real movement on the market's clock (launched by launch date, churned
//                        by estimated death date). Kept apart so catch-up never reads as a crash.
export type PlatformTrack = {
  label: string;
  tracked: number; live: number; scanFreshPct: number; paymentPct: number; launchPct: number; // A
  launched30d: number; churned30d: number;                                                     // B
};
export type OpsStatus = {
  at: string;
  discovery: { today: number; yesterday: number };
  payments: { coverage: number; backlog: number; probed12h: number };
  launched: { since: number; filled12h: number };
  woo: { total: number; cohortConfirmed: number; cohortReal: number };
  platforms: PlatformTrack[];
  // RAW OPERATIONS (last 7d, our clock) — detection/operational counts, always accurate. Kept
  // separate from the market estimate so a backlog-detection wave never reads as a market crash.
  rawOps: { discovered: number; checked: number; foundDead: number; foundMigrated: number; paymentsProbed: number };
  machines: Heartbeat[];
};

const mins = (d: Date | null): number | null => (d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null);

// Per-machine worker heartbeats — each worker stamps (machine, task) at the start of every run
// (scripts/heartbeat.mjs on Chad, worker/heartbeat.py on Lucy), so we can SEE which machine is
// actually running what, instead of guessing from shared DB writes.
export type AgentBeat = { machine: string; task: string; ageMins: number | null; note: string };
export async function agentHeartbeats(): Promise<AgentBeat[]> {
  const rows = await db()<{ machine: string; task: string; last_run: Date; note: string | null }[]>`
    SELECT machine, task, last_run, note FROM agent_heartbeat ORDER BY machine, last_run DESC`.catch(() => []);
  return rows.map((r) => ({ machine: r.machine, task: r.task, ageMins: mins(r.last_run), note: r.note ?? "" }));
}

// A live activity event — a store the swarm touched in the last few minutes, labelled by which
// timestamp moved most recently. Derived from the trail the workers already write (no worker
// changes): created_at (discovered), live_checked_at (liveness), catalog_checked_at (launch date),
// payments_checked_at (payments). Powers the /ops live feed.
export type ActivityAction = "discovered" | "liveness" | "launch" | "payments";
export type ActivityEvent = {
  domain: string; country: string; platform: string | null;
  action: ActivityAction; detail: string; ts: string; ageSecs: number;
};

export async function recentActivity(limit = 60): Promise<ActivityEvent[]> {
  const sql = db();
  const G = sql`GREATEST(
    COALESCE(live_checked_at, 'epoch'::timestamptz),
    COALESCE(catalog_checked_at, 'epoch'::timestamptz),
    COALESCE(payments_checked_at, 'epoch'::timestamptz),
    COALESCE(created_at, 'epoch'::timestamptz))`;
  const rows = await sql<{
    domain: string; country: string; platform: string | null; payments: string | null;
    live_status: string | null; launched_at: Date | null;
    live_checked_at: Date | null; catalog_checked_at: Date | null;
    payments_checked_at: Date | null; created_at: Date | null; last_at: Date;
  }[]>`
    SELECT domain, country, platform, payments, live_status, launched_at,
           live_checked_at, catalog_checked_at, payments_checked_at, created_at, ${G} AS last_at
    FROM imported_stores
    WHERE country = ANY(${MK}) AND ${G} > now() - interval '15 minutes'
    ORDER BY last_at DESC
    LIMIT ${limit}`;
  const ms = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  return rows.map((r) => {
    const last = ms(r.last_at);
    let action: ActivityAction, detail: string;
    if (last === ms(r.payments_checked_at)) {
      action = "payments";
      detail = r.payments ? r.payments.split(";").map((x) => x.trim()).filter(Boolean).slice(0, 3).join(", ") : "no gateway found";
    } else if (last === ms(r.catalog_checked_at)) {
      action = "launch";
      detail = r.launched_at ? new Date(r.launched_at).toISOString().slice(0, 10) : "checked";
    } else if (last === ms(r.live_checked_at)) {
      action = "liveness";
      detail = r.live_status ?? "checked";
    } else {
      action = "discovered";
      detail = r.platform ?? "new store";
    }
    return {
      domain: r.domain, country: r.country, platform: r.platform,
      action, detail, ts: new Date(last).toISOString(), ageSecs: Math.max(0, Math.round((Date.now() - last) / 1000)),
    };
  });
}

// Run an array of query-thunks at most `n` at a time, preserving result order. The postgres.js
// pool is max:3, so firing all of opsStatus's full-table aggregates at once exhausts it — the
// overflow queues and stalls under write load, which is what made /ops crawl. 2-at-a-time keeps a
// connection free (e.g. for the live heartbeat read) and is still fast.
async function mapLimit<T extends readonly unknown[]>(
  thunks: readonly [...{ [K in keyof T]: () => Promise<T[K]> }],
  n: number,
): Promise<T> {
  const out: unknown[] = new Array(thunks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, async () => {
    while (i < thunks.length) { const idx = i++; out[idx] = await (thunks[idx] as () => Promise<unknown>)(); }
  }));
  return out as unknown as T;
}

// /ops auto-refreshes every 60s and can have several viewers, and each opsStatus() is ~9 full-table
// aggregate scans — so serve it from a short in-process cache (with an in-flight guard) instead of
// recomputing on every request. Heartbeats are read separately + uncached, so "is Lucy alive" stays
// live even while these rollups are cached.
type CachedOps = { at: number; data: OpsStatus };
const OPS_TTL_MS = 30 * 1000;
let _opsCache: CachedOps | null = null;
let _opsInflight: Promise<OpsStatus> | null = null;
export async function opsStatus(): Promise<OpsStatus> {
  if (_opsCache && Date.now() - _opsCache.at < OPS_TTL_MS) return _opsCache.data;
  if (!_opsInflight) {
    _opsInflight = opsStatusUncached()
      .then((d) => { _opsCache = { at: Date.now(), data: d }; _opsInflight = null; return d; })
      .catch((e) => { _opsInflight = null; if (_opsCache) return _opsCache.data; throw e; });
  }
  return _opsInflight;
}

async function opsStatusUncached(): Promise<OpsStatus> {
  const sql = db();
  const LAUNCH = sql`COALESCE((CASE WHEN first_product_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN left(first_product_at,10)::date END), launched_at)`;

  const [disc, pay, launch, woo, hb, platCov, mktChurn, rawStores, rawChurn] = await mapLimit([
    () => sql<{ today: number; yest: number }[]>`
      SELECT count(*) FILTER (WHERE source='ct_tail' AND discovered_at=CURRENT_DATE)::int today,
             count(*) FILTER (WHERE source='ct_tail' AND discovered_at=CURRENT_DATE-1)::int yest
      FROM imported_stores`,
    () => sql<{ live: number; haspay: number; backlog: number; probed12h: number }[]>`
      SELECT count(*)::int live,
             count(*) FILTER (WHERE payments IS NOT NULL AND payments<>'')::int haspay,
             count(*) FILTER (WHERE payments_checked_at IS NULL)::int backlog,
             count(*) FILTER (WHERE payments_checked_at > now()-interval '12 hours')::int probed12h
      FROM imported_stores WHERE published AND platform='Shopify'
        AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND country = ANY(${CORE})`,
    () => sql<{ since: number; filled12h: number }[]>`
      SELECT count(*) FILTER (WHERE country='ZA' AND platform IS DISTINCT FROM 'woocommerce' AND ${LAUNCH} >= '2026-07-30'::date)::int since,
             count(*) FILTER (WHERE launched_source='earliest_product' AND catalog_checked_at > now()-interval '12 hours')::int filled12h
      FROM imported_stores`,
    () => sql<{ total: number; confirmed: number; real: number }[]>`
      SELECT count(*) FILTER (WHERE platform='woocommerce')::int total,
             count(*) FILTER (WHERE platform='woocommerce' AND domain IN (SELECT domain FROM store_tags WHERE tag='woo-2019-sa'))::int confirmed,
             count(*) FILTER (WHERE platform='woocommerce' AND activity_tier IN ('selling','active','dormant') AND domain IN (SELECT domain FROM store_tags WHERE tag='woo-2019-sa'))::int real
      FROM imported_stores`,
    // heartbeats: last activity TIMESTAMP per machine role (created_at = row-insert time, a real
    // timestamptz — discovered_at is only a DATE so it can't heartbeat).
    () => sql<{ chad_pay: Date | null; vps_disc: Date | null; lucy_woo: Date | null; lucy_launch: Date | null }[]>`
      SELECT
        (SELECT max(payments_checked_at) FROM imported_stores)                                              chad_pay,
        (SELECT max(created_at) FROM imported_stores WHERE source='ct_tail')                                vps_disc,
        (SELECT max(created_at) FROM imported_stores WHERE source='woo_ct')                                 lucy_woo,
        (SELECT max(catalog_checked_at) FROM imported_stores WHERE launched_source='earliest_product')      lucy_launch`,
    // Track A + Track B per platform, over the CORE markets.
    () => sql<{ plat: string; tracked: number; live: number; checked30d: number; cov_pay: number; has_launch: number; launched30d: number }[]>`
      SELECT
        CASE WHEN platform='woocommerce' THEN 'WooCommerce' ELSE 'Shopify' END AS plat,
        count(*)::int tracked,
        count(*) FILTER (WHERE live_status IS NULL OR live_status NOT IN ('dead','migrated'))::int live,
        count(*) FILTER (WHERE live_checked_at > now()-interval '30 days')::int checked30d,
        count(*) FILTER (WHERE (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND payments IS NOT NULL AND payments<>'')::int cov_pay,
        count(*) FILTER (WHERE launched_at IS NOT NULL OR first_product_at ~ '^[0-9]{4}-')::int has_launch,
        count(*) FILTER (WHERE (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND ${LAUNCH} >= CURRENT_DATE-30)::int launched30d
      FROM imported_stores
      WHERE published AND country = ANY(${CORE}) AND platform IN ('Shopify','woocommerce')
      GROUP BY 1`,
    // Market churn (last 30d) by ESTIMATED DEATH DATE — churn_log has no platform (Shopify liveness).
    () => sql<{ churned30d: number }[]>`
      SELECT count(*) FILTER (WHERE died_at >= CURRENT_DATE-30)::int churned30d
      FROM churn_log WHERE COALESCE(historic,false)=false AND died_at IS NOT NULL AND country = ANY(${CORE})`,
    // RAW OPERATIONS (last 7d) — what the pipeline actually DID, by our clock (created_at /
    // checked_at / detection). Always accurate; the honest counterpart to the market estimate.
    () => sql<{ discovered: number; checked: number; probed: number }[]>`
      SELECT
        count(*) FILTER (WHERE source='ct_tail' AND created_at > now()-interval '7 days')::int discovered,
        count(*) FILTER (WHERE live_checked_at > now()-interval '7 days')::int checked,
        count(*) FILTER (WHERE payments_checked_at > now()-interval '7 days')::int probed
      FROM imported_stores WHERE country = ANY(${MK})`,
    () => sql<{ dead: number; migrated: number }[]>`
      SELECT
        count(*) FILTER (WHERE status='dead' AND churned_at > now()-interval '7 days')::int dead,
        count(*) FILTER (WHERE status='migrated' AND churned_at > now()-interval '7 days')::int migrated
      FROM churn_log WHERE country = ANY(${MK})`,
  ], 2);

  const p = pay[0]; const h = hb[0];
  const beat = (label: string, d: Date | null, freshMins: number, detail: string): Heartbeat => {
    const a = mins(d);
    return { label, ageMins: a, ok: a != null && a <= freshMins, detail };
  };
  const pctOf = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);
  // Build the per-platform two-track rows. All CORE-market churn is attributed to Shopify (that's
  // what churn_log tracks); WooCommerce market churn is not measured yet, shown as 0.
  const churn30 = Number(mktChurn[0]?.churned30d ?? 0);
  const order = ["Shopify", "WooCommerce"];
  const platforms: PlatformTrack[] = platCov
    .map((r) => ({
      label: r.plat,
      tracked: Number(r.tracked), live: Number(r.live),
      scanFreshPct: pctOf(Number(r.checked30d), Number(r.tracked)),
      paymentPct: pctOf(Number(r.cov_pay), Number(r.live)),
      launchPct: pctOf(Number(r.has_launch), Number(r.tracked)),
      launched30d: Number(r.launched30d),
      churned30d: r.plat === "Shopify" ? churn30 : 0,
    }))
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));

  return {
    at: new Date().toISOString(),
    discovery: { today: Number(disc[0].today), yesterday: Number(disc[0].yest) },
    payments: { coverage: p.live ? Math.round((100 * p.haspay) / p.live) : 0, backlog: Number(p.backlog), probed12h: Number(p.probed12h) },
    launched: { since: Number(launch[0].since), filled12h: Number(launch[0].filled12h) },
    woo: { total: Number(woo[0].total), cohortConfirmed: Number(woo[0].confirmed), cohortReal: Number(woo[0].real) },
    platforms,
    rawOps: {
      discovered: Number(rawStores[0]?.discovered ?? 0),
      checked: Number(rawStores[0]?.checked ?? 0),
      paymentsProbed: Number(rawStores[0]?.probed ?? 0),
      foundDead: Number(rawChurn[0]?.dead ?? 0),
      foundMigrated: Number(rawChurn[0]?.migrated ?? 0),
    },
    machines: [
      beat("Chad · payments", h.chad_pay, 120, "checkout probing"),
      beat("Discovery · VPS → landing", h.vps_disc, 360, "CT-log landings (4h cadence)"),
      beat("Lucy · launch dates", h.lucy_launch, 180, "fresh-IP launch enrichment"),
    ],
  };
}

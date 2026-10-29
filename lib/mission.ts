// Mission Control — real-time read of where Terrain stands against its priorities, for TWO scopes
// (Africa — all African countries — and Global — everything), each pillar showing:
//   • coverage + a GAP figure (never-done backlog = work that CLOSES knowledge gaps), separate from
//     re-checks (monitoring), so it's obvious whether we're gaining ground or just maintaining;
//   • a period DELTA (this window vs the prior equal window) = "more or less impactful than before".
// Reuses the live heartbeat machines (lib/fleet) + health alerts (lib/ops). One aggregate per scope,
// cached briefly. A daily snapshot is written to mission_snapshots so charts can accrue over time.
import { db } from "./db";
import { fleetMachines, type FleetMachine } from "./fleet";
import { healthAlerts } from "./ops";

// African ISO2 set — the "Africa" scope. Global = everything (incl. NULL country).
const AFRICA = ["ZA","NG","KE","GH","EG","MA","TZ","UG","RW","ZM","ET","CI","SN","CM","DZ","TN","AO","MZ","BW","NA","MU","ZW","MW","SL","LR","GM","SD","CD","CG","GA","BJ","BF","ML","NE","TG","GN","MR","CV","SZ","LS","MG","SC","ST"];

type M = Record<string, number>;
export type MetricRow = { label: string; africa: number; global: number; pct?: boolean; delta?: { africa: number | null; global: number | null }; gap?: boolean };
export type Pillar = { key: string; title: string; accent: "mint" | "cyan" | "lilac" | "amber"; headline: string; owners: string; rows: MetricRow[] };
export type Mission = { machines: FleetMachine[]; alerts: { check: string; detail: string }[]; pillars: Pillar[]; generatedAt: string };

const cache = new Map<string, { at: number; data: Mission }>(); // keyed by include-imports variant
let snapshotDay = ""; // guard: attempt the daily snapshot (incl. CREATE TABLE) at most once per process per day

// All pillar counters for one scope, in one aggregate. `scope` is a SQL predicate (Africa or TRUE).
async function scopeMetrics(sql: ReturnType<typeof db>, scope: ReturnType<ReturnType<typeof db>>): Promise<M> {
  const PUB = sql`published AND ${scope}`;
  const rows = await sql<M[]>`SELECT
    count(*) FILTER (WHERE ${PUB})::int tracked,
    count(DISTINCT platform) FILTER (WHERE ${PUB})::int cms_breadth,
    -- FIND (acquisition): new discoveries, this window vs prior
    count(*) FILTER (WHERE ${scope} AND discovered_at >= now()-interval '7 days')::int disc7,
    count(*) FILTER (WHERE ${scope} AND discovered_at >= now()-interval '14 days' AND discovered_at < now()-interval '7 days')::int disc7_prev,
    count(*) FILTER (WHERE ${scope} AND discovered_at >= now()-interval '30 days')::int disc30,
    count(*) FILTER (WHERE ${scope} AND NOT published)::int banked,
    -- ENRICH: coverage + gap (never-enriched) + launched this window vs prior
    count(*) FILTER (WHERE ${PUB} AND (coalesce(apps,'')<>'' OR coalesce(technologies,'')<>'' OR coalesce(plugins,'')<>''))::int tech_cov,
    count(*) FILTER (WHERE ${PUB} AND coalesce(apps,'')='' AND coalesce(technologies,'')='' AND coalesce(plugins,'')='')::int tech_gap,
    count(*) FILTER (WHERE ${PUB} AND launched_at IS NULL)::int launch_gap,
    count(*) FILTER (WHERE ${PUB} AND launched_at >= CURRENT_DATE-30)::int launched30,
    count(*) FILTER (WHERE ${PUB} AND launched_at >= CURRENT_DATE-60 AND launched_at < CURRENT_DATE-30)::int launched30_prev,
    -- CONTACT: reach + gap (never contacted) + crawled this window vs prior
    count(*) FILTER (WHERE ${PUB} AND contact_type IN ('named','role_targeted'))::int reach,
    count(*) FILTER (WHERE ${PUB} AND contact_checked_at IS NULL)::int contact_gap,
    count(*) FILTER (WHERE ${scope} AND contact_checked_at >= now()-interval '7 days')::int crawled7,
    count(*) FILTER (WHERE ${scope} AND contact_checked_at >= now()-interval '14 days' AND contact_checked_at < now()-interval '7 days')::int crawled7_prev,
    -- SCORE
    count(*) FILTER (WHERE ${PUB} AND estimated_monthly_sales IS NOT NULL)::int has_rev,
    count(*) FILTER (WHERE ${PUB} AND payments IS NOT NULL AND payments <> '')::int has_pay,
    -- TRACK: never-checked GAP vs re-checks this window vs prior; churn
    count(*) FILTER (WHERE ${PUB} AND live_checked_at IS NULL)::int live_never,
    count(*) FILTER (WHERE ${scope} AND live_checked_at >= now()-interval '7 days')::int live7,
    count(*) FILTER (WHERE ${scope} AND live_checked_at >= now()-interval '14 days' AND live_checked_at < now()-interval '7 days')::int live7_prev,
    count(*) FILTER (WHERE ${PUB} AND live_status='dead' AND live_checked_at >= now()-interval '30 days')::int churn30
    FROM imported_stores`;
  return rows[0] ?? ({} as M);
}

// Write one snapshot per day so charts can accrue. Opportunistic (first view of the day); also safe
// to call from a scheduled job. Never blocks the page.
async function captureSnapshot(sql: ReturnType<typeof db>, africa: M, global: M) {
  const today = new Date().toISOString().slice(0, 10);
  if (snapshotDay === today) return;           // already attempted today in this process
  snapshotDay = today;
  try {
    await sql`CREATE TABLE IF NOT EXISTS mission_snapshots (day date PRIMARY KEY, africa jsonb, global jsonb, captured_at timestamptz DEFAULT now())`;
    await sql`INSERT INTO mission_snapshots (day, africa, global) VALUES (CURRENT_DATE, ${sql.json(africa)}, ${sql.json(global)}) ON CONFLICT (day) DO NOTHING`;
  } catch { /* snapshot is best-effort — never fail the dashboard */ }
}

// Bought bulk-import sources (StoreCensus/StoreLeads/BuiltWith/CSV) — background data, not OUR
// discovery. "Our work only" excludes these so the numbers reflect what the pipeline actually found.
export async function missionControl(includeImports = true): Promise<Mission> {
  const key = includeImports ? "all" : "ours";
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 20_000) return cached.data;
  const sql = db();
  const imp = includeImports ? sql`` : sql`AND NOT (source ILIKE 'storecensus%' OR source ILIKE 'storeleads%' OR source ILIKE 'builtwith%' OR source = 'csv')`;
  const [machines, alerts, africa, global] = await Promise.all([
    fleetMachines().catch(() => [] as FleetMachine[]),
    healthAlerts().catch(() => [] as { check: string; detail: string }[]),
    scopeMetrics(sql, sql`country = ANY(${AFRICA}) ${imp}`).catch(() => ({} as M)),
    scopeMetrics(sql, sql`TRUE ${imp}`).catch(() => ({} as M)),
  ]);
  if (includeImports) void captureSnapshot(sql, africa, global);   // canonical daily snapshot = full view

  const g = (m: M, k: string) => Number(m[k] ?? 0);
  const delta = (cur: number, prev: number): number | null => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
  const row = (label: string, k: string, opts: { pct?: boolean; prevKey?: string; gap?: boolean } = {}): MetricRow => ({
    label, africa: g(africa, k), global: g(global, k), pct: opts.pct, gap: opts.gap,
    delta: opts.prevKey ? { africa: delta(g(africa, k), g(africa, opts.prevKey)), global: delta(g(global, k), g(global, opts.prevKey)) } : undefined,
  });

  const pillars: Pillar[] = [
    { key: "find", title: "Find — new coverage", accent: "mint",
      headline: `${g(africa, "disc7").toLocaleString()} new in Africa · 7d`,
      owners: "Rex + VPS (CT firehose, global)",
      rows: [
        row("Tracked", "tracked"),
        row("New · 7d", "disc7", { prevKey: "disc7_prev" }),
        row("New · 30d", "disc30"),
        row("CMS breadth", "cms_breadth"),
        row("Banked (unpublished)", "banked"),
      ] },
    { key: "enrich", title: "Enrich — tech & launch", accent: "cyan",
      headline: `${g(global, "launched30").toLocaleString()} launched · 30d (global)`,
      owners: "Rex (deep-enrich, cert/launch dates)",
      rows: [
        row("Tech-covered", "tech_cov"),
        row("Tech GAP (never enriched)", "tech_gap", { gap: true }),
        row("Launch-date GAP", "launch_gap", { gap: true }),
        row("Launched · 30d", "launched30", { prevKey: "launched30_prev" }),
      ] },
    { key: "contact", title: "Contact", accent: "lilac",
      headline: `${g(africa, "reach").toLocaleString()} reach a person (Africa)`,
      owners: "Rex (Shopify) · Lucy (non-Shopify, Rain)",
      rows: [
        row("Reach a person", "reach"),
        row("Contact GAP (never checked)", "contact_gap", { gap: true }),
        row("Crawled · 7d", "crawled7", { prevKey: "crawled7_prev" }),
      ] },
    { key: "score", title: "Score & surface", accent: "amber",
      headline: `${g(global, "has_rev").toLocaleString()} have a revenue estimate`,
      owners: "scoreLead · revenue model",
      rows: [
        row("Revenue estimate", "has_rev"),
        row("Payments known", "has_pay"),
      ] },
    { key: "track", title: "Track — liveness & churn", accent: "mint",
      headline: `${g(global, "live_never").toLocaleString()} never liveness-checked`,
      owners: "Rex · Lucy (liveness sweeps)",
      rows: [
        row("Never-checked GAP", "live_never", { gap: true }),
        row("Re-checked · 7d", "live7", { prevKey: "live7_prev" }),
        row("Churned · 30d", "churn30"),
      ] },
  ];

  const data: Mission = { machines, alerts, pillars, generatedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Mission Control — the five-pillar, real-time read of where Terrain stands against its priorities,
// over the focus markets (ZA/KE/NG). Reuses the live heartbeat machines from lib/fleet and the
// health alerts from lib/ops; the pillar metrics are one aggregate over imported_stores. Cached
// briefly so the 15s auto-refresh doesn't re-run the aggregate every tick.
import { db } from "./db";
import { fleetMachines, type FleetMachine } from "./fleet";
import { healthAlerts } from "./ops";

export type Metric = { label: string; value: number; pct?: number; tone?: "good" | "warn" | "bad" };
export type Pillar = {
  key: string; title: string; headline: string; accent: "mint" | "cyan" | "lilac" | "amber";
  metrics: Metric[]; owners: string; flag?: { text: string; tone: "good" | "warn" | "bad" };
};
export type Mission = { machines: FleetMachine[]; alerts: { check: string; detail: string }[]; pillars: Pillar[]; generatedAt: string };

let cache: { at: number; data: Mission } | null = null;

export async function missionControl(): Promise<Mission> {
  if (cache && Date.now() - cache.at < 20_000) return cache.data;
  const sql = db();
  const F = sql`country IN ('ZA','KE','NG')`;
  const PUB = sql`published AND country IN ('ZA','KE','NG')`;

  const [machines, alerts, rows] = await Promise.all([
    fleetMachines().catch(() => [] as FleetMachine[]),
    healthAlerts().catch(() => [] as { check: string; detail: string }[]),
    sql<Record<string, number>[]>`SELECT
      count(*) FILTER (WHERE ${PUB})::int tracked,
      count(DISTINCT platform) FILTER (WHERE ${PUB})::int cms_breadth,
      count(*) FILTER (WHERE ${F} AND discovered_at >= now()-interval '24 hours')::int disc24,
      count(*) FILTER (WHERE ${F} AND discovered_at >= now()-interval '7 days')::int disc7,
      count(*) FILTER (WHERE ${F} AND discovered_at >= now()-interval '30 days')::int disc30,
      count(*) FILTER (WHERE ${F} AND NOT published)::int banked,
      count(*) FILTER (WHERE ${PUB} AND (coalesce(apps,'')<>'' OR coalesce(technologies,'')<>'' OR coalesce(plugins,'')<>''))::int tech_cov,
      count(*) FILTER (WHERE ${PUB} AND launched_at IS NOT NULL)::int launch_cov,
      count(*) FILTER (WHERE ${PUB} AND launched_at >= CURRENT_DATE-30)::int launched30,
      count(*) FILTER (WHERE ${PUB} AND launched_at >= CURRENT_DATE-7)::int launched7,
      count(*) FILTER (WHERE ${PUB} AND deep_enriched_at >= now()-interval '7 days')::int deep7,
      count(*) FILTER (WHERE ${PUB} AND contact_type IN ('named','role_targeted'))::int reach,
      count(*) FILTER (WHERE ${PUB} AND contact_checked_at IS NOT NULL)::int contacted,
      count(*) FILTER (WHERE ${F} AND contact_checked_at >= now()-interval '24 hours')::int crawled24,
      count(*) FILTER (WHERE ${PUB} AND estimated_monthly_sales IS NOT NULL)::int has_rev,
      count(*) FILTER (WHERE ${PUB} AND payments IS NOT NULL AND payments <> '')::int has_pay,
      count(*) FILTER (WHERE ${F} AND live_checked_at >= now()-interval '24 hours')::int live24,
      count(*) FILTER (WHERE ${PUB} AND live_status='dead' AND live_checked_at >= now()-interval '30 days')::int churn30,
      count(*) FILTER (WHERE ${PUB} AND (live_checked_at IS NULL OR live_checked_at < now()-interval '60 days'))::int stale
      FROM imported_stores`,
  ]);
  const d = rows[0] ?? ({} as Record<string, number>);
  const n = (k: string) => Number(d[k] ?? 0);
  const T = Math.max(n("tracked"), 1);
  const pct = (x: number, base = T) => Math.round((x / Math.max(base, 1)) * 100);

  const pillars: Pillar[] = [
    {
      key: "find", title: "Find", accent: "mint",
      headline: `${n("disc24").toLocaleString()} new in 24h`,
      owners: "Rex · VPS (CT firehose)",
      metrics: [
        { label: "Tracked (focus)", value: n("tracked") },
        { label: "New · 7d", value: n("disc7") },
        { label: "New · 30d", value: n("disc30") },
        { label: "CMS breadth", value: n("cms_breadth") },
        { label: "Banked (unpublished)", value: n("banked") },
      ],
    },
    {
      key: "enrich", title: "Enrich — tech & launch", accent: "cyan",
      headline: `${n("launched30").toLocaleString()} launched in 30d`,
      owners: "Rex (deep-enrich, cert dates)",
      metrics: [
        { label: "Tech coverage", value: n("tech_cov"), pct: pct(n("tech_cov")) },
        { label: "Launch-dated", value: n("launch_cov"), pct: pct(n("launch_cov")) },
        { label: "Launched · 30d", value: n("launched30") },
        { label: "Deep-enriched · 7d", value: n("deep7") },
      ],
      flag: n("launched30") === 0 ? { text: "0 launched — launch-date capture stalled", tone: "bad" }
            : { text: "launch dates flowing", tone: "good" },
    },
    {
      key: "contact", title: "Contact", accent: "lilac",
      headline: `${pct(n("reach"))}% reach a person`,
      owners: "Rex (Shopify) · Lucy (non-Shopify, Rain)",
      metrics: [
        { label: "Reach a person", value: n("reach"), pct: pct(n("reach")) },
        { label: "Contact-checked", value: n("contacted"), pct: pct(n("contacted")) },
        { label: "Crawled · 24h", value: n("crawled24") },
      ],
    },
    {
      key: "score", title: "Score & surface", accent: "amber",
      headline: `${pct(n("has_rev"))}% have a revenue estimate`,
      owners: "scoreLead · revenue model",
      metrics: [
        { label: "Revenue estimate", value: n("has_rev"), pct: pct(n("has_rev")) },
        { label: "Payments known", value: n("has_pay"), pct: pct(n("has_pay")) },
      ],
      flag: pct(n("has_rev")) < 50 ? { text: "revenue coverage thin — scoring under-fed", tone: "warn" } : undefined,
    },
    {
      key: "track", title: "Track changes", accent: "mint",
      headline: `${n("live24").toLocaleString()} liveness checks in 24h`,
      owners: "Rex · Lucy (liveness sweeps)",
      metrics: [
        { label: "Liveness · 24h", value: n("live24") },
        { label: "Churned · 30d", value: n("churn30"), tone: "warn" },
        { label: "Launched · 30d", value: n("launched30") },
        { label: "Stale (>60d)", value: n("stale"), tone: n("stale") > T / 2 ? "warn" : undefined },
      ],
    },
  ];

  const data: Mission = { machines, alerts, pillars, generatedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

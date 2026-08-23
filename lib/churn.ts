/** Churn intelligence — read model over churn_log (a snapshot of each store the
 *  moment it was confirmed dead/migrated). Powers the /admin/churn report: who
 *  churned, and what the churned cohort was using (payments/shipping/platform…). */

import postgres from "postgres";
import type { InsightItem } from "./insights";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((100 * n) / d) : 0);
const items = (rows: { label: string; n: number }[], denom: number): InsightItem[] =>
  rows.filter((r) => r.label).map((r) => ({ label: r.label, count: Number(r.n), pct: pct(Number(r.n), denom) }));

export type ChurnedStore = {
  domain: string; name: string | null; status: string; migratedTo: string | null;
  churnedAt: string; category: string | null; city: string | null; theme: string | null;
  estMonthlySales: number | null; payments: string | null; shipping: string | null;
};

export type ChurnReport = {
  total: number; dead: number; migrated: number; last30: number; last90: number;
  byPlatform: InsightItem[];   // where migrated stores went
  byCategory: InsightItem[];
  byCity: InsightItem[];
  byTheme: InsightItem[];
  byPayment: InsightItem[];    // what churned stores were using
  byShipping: InsightItem[];
  recent: ChurnedStore[];
  // Historic die-off: stores that were dead at first contact (bulk-imported old
  // sites we never verified live). NOT counted in any metric above.
  historic: { total: number; byVintage: InsightItem[] };
};

export async function churnReport(country?: string): Promise<ChurnReport> {
  const sql = db();
  // Every "real churn" query is scoped to historic = false — stores we actually
  // verified live before they died. The one-time import's dead-on-arrival sites
  // (historic = true) are reported separately and never inflate these numbers.
  const WHERE = country ? sql`WHERE historic = false AND country = ${country}` : sql`WHERE historic = false`;
  const AND = country ? sql`AND historic = false AND country = ${country}` : sql`AND historic = false`;

  const [c] = await sql`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE status='dead')::int dead,
      COUNT(*) FILTER (WHERE status='migrated')::int migrated,
      COUNT(*) FILTER (WHERE churned_at >= now() - interval '30 days')::int last30,
      COUNT(*) FILTER (WHERE churned_at >= now() - interval '90 days')::int last90
    FROM churn_log ${WHERE}`;
  const total = Number(c.total);

  // Run these SEQUENTIALLY, not via Promise.all. The db() pool is small (max:3);
  // firing 6 concurrent queries queues 3 of them, and postgres.js deadlocks those
  // queued queries after a prior awaited query — the request then hangs forever.
  // Sequential never exceeds the pool, and total latency is still ~1.5s.
  type Agg = { label: string; n: number };
  const platform = await sql<Agg[]>`SELECT migrated_to AS label, COUNT(*)::int n FROM churn_log WHERE status='migrated' AND migrated_to IS NOT NULL ${AND} GROUP BY migrated_to ORDER BY n DESC`;
  const category = await sql<Agg[]>`SELECT category AS label, COUNT(*)::int n FROM churn_log WHERE category IS NOT NULL ${AND} GROUP BY category ORDER BY n DESC`;
  const city = await sql<Agg[]>`SELECT city AS label, COUNT(*)::int n FROM churn_log WHERE city IS NOT NULL AND city <> '' ${AND} GROUP BY city ORDER BY n DESC`;
  const theme = await sql<Agg[]>`SELECT theme AS label, COUNT(*)::int n FROM churn_log WHERE theme IS NOT NULL AND theme <> '' ${AND} GROUP BY theme ORDER BY n DESC`;
  const payment = await sql<Agg[]>`SELECT p AS label, COUNT(*)::int n FROM (
        SELECT trim(unnest(string_to_array(payments, ';'))) AS p FROM churn_log WHERE payments IS NOT NULL AND payments <> '' ${AND}
      ) x WHERE p <> '' GROUP BY p ORDER BY n DESC`;
  const shipping = await sql<Agg[]>`SELECT s AS label, COUNT(*)::int n FROM (
        SELECT trim(unnest(string_to_array(shipping_providers, ';'))) AS s FROM churn_log WHERE shipping_providers IS NOT NULL AND shipping_providers <> '' ${AND}
      ) x WHERE s <> '' GROUP BY s ORDER BY n DESC`;

  const migrated = Number(c.migrated);
  const withPay = payment.reduce((n, r) => n + Number(r.n), 0);
  const withShip = shipping.reduce((n, r) => n + Number(r.n), 0);

  const recent = await sql<ChurnedStore[]>`
    SELECT domain, name, status, migrated_to AS "migratedTo", churned_at AS "churnedAt",
           category, city, theme, estimated_monthly_sales AS "estMonthlySales", payments,
           shipping_providers AS shipping
    FROM churn_log ${WHERE} ORDER BY churned_at DESC, estimated_monthly_sales DESC NULLS LAST LIMIT 60`;

  // Historic die-off (dead at first contact) — reported separately. Break it down
  // by vintage (the site's first_seen year) so the legacy list-cleaning is legible.
  const histWhere = country ? sql`WHERE historic = true AND country = ${country}` : sql`WHERE historic = true`;
  const [h] = await sql`SELECT COUNT(*)::int total FROM churn_log ${histWhere}`;
  const histTotal = Number(h.total);
  const vintage = await sql<Agg[]>`
    SELECT LEFT(first_seen, 4) AS label, COUNT(*)::int n
    FROM churn_log ${histWhere} AND first_seen ~ '^[0-9]{4}'
    GROUP BY 1 ORDER BY label DESC`;

  return {
    total, dead: Number(c.dead), migrated, last30: Number(c.last30), last90: Number(c.last90),
    byPlatform: items(platform, migrated),
    byCategory: items(category, total),
    byCity: items(city, total),
    byTheme: items(theme, total),
    byPayment: items(payment, withPay),
    byShipping: items(shipping, withShip),
    recent: recent.map((r) => ({ ...r, churnedAt: new Date(r.churnedAt).toISOString(), estMonthlySales: r.estMonthlySales != null ? Number(r.estMonthlySales) : null })),
    historic: { total: histTotal, byVintage: items(vintage, histTotal) },
  };
}

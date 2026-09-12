#!/usr/bin/env node
/**
 * Weekly Admin recap — discovery, churn, new Plus, and week-over-week winners/losers on
 * payments, apps, themes and shipping. Reads the daily `insights_snapshots` (JSON with
 * per-label counts) and diffs the latest snapshot against the one ~7 days earlier, plus
 * live churn_log and global discovery from imported_stores.
 *
 *   node --env-file=.env.local scripts/weekly-recap.mjs [--md]
 *
 * Prints a plain-text recap by default; --md emits Markdown (for email/Slack).
 */
import postgres from "postgres";

const MD = process.argv.includes("--md");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false });

const asObj = (d) => (typeof d === "string" ? JSON.parse(d) : d);
// Merge case-variant labels (the snapshot stores e.g. "Dawn" and "dawn" separately),
// summing counts and keeping the nicest-looking display label.
function byLabel(arr) {
  const m = new Map();
  for (const r of arr || []) {
    const key = String(r.label).trim().toLowerCase();
    const prev = m.get(key);
    const display = prev ? (/[A-Z]/.test(prev.label) ? prev.label : r.label) : r.label;
    m.set(key, { label: display, count: (prev?.count || 0) + (r.count || 0) });
  }
  return m;
}

/** Top movers by absolute count change between two {label,count} lists. */
function movers(prevArr, curArr, n = 5) {
  const prev = byLabel(prevArr), cur = byLabel(curArr);
  const labels = new Set([...prev.keys(), ...cur.keys()]);
  const deltas = [...labels].map((k) => ({ label: (cur.get(k) || prev.get(k)).label, delta: (cur.get(k)?.count || 0) - (prev.get(k)?.count || 0), now: cur.get(k)?.count || 0 }));
  const winners = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, n);
  const losers = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, n);
  return { winners, losers };
}

async function main() {
  const snaps = await sql`SELECT date, data FROM insights_snapshots ORDER BY date DESC LIMIT 30`;
  if (snaps.length < 2) { console.log("Not enough snapshots yet for a week-over-week recap."); return; }
  const cur = asObj(snaps[0].data);
  const curDate = new Date(snaps[0].date);
  // prior = snapshot closest to 7 days before the latest (prefer the oldest within the window)
  const target = new Date(curDate.getTime() - 7 * 864e5);
  let prior = snaps[snaps.length - 1];
  for (const s of snaps) if (new Date(s.date) <= target) { prior = s; break; }
  const prev = asObj(prior.data);
  const prevDate = new Date(prior.date).toISOString().slice(0, 10);
  const curD = curDate.toISOString().slice(0, 10);

  // discovery + global
  const [g] = await sql`SELECT
    COUNT(*) FILTER (WHERE discovered_at >= now()-interval '7 days')::int new7,
    COUNT(*) FILTER (WHERE discovered_at >= now()-interval '7 days' AND UPPER(country) NOT IN ('ZA','KE','NG','JP'))::int newglobal
    FROM imported_stores WHERE published`;
  // Confirmed churn only, split by kind. `historic` (never-verified / unconfirmed) is excluded,
  // and the liveness detector now requires 2+ consecutive failed checks before logging either
  // state — so this reflects stores that ACTUALLY churned in the window, not single-check blips.
  const chn = await sql`SELECT status, COUNT(*)::int n FROM churn_log
    WHERE COALESCE(historic,false)=false AND churned_at >= now()-interval '7 days' GROUP BY status`;
  const churnDead = chn.find((r) => r.status === "dead")?.n || 0;
  const churnMigrated = chn.find((r) => r.status === "migrated")?.n || 0;
  const churnTotal = churnDead + churnMigrated;

  const dNew = (cur.newThisWeek ?? 0);
  const dPlus = (cur.plusNewThisWeek ?? 0);

  const L = [];
  const p = (s = "") => L.push(s);
  const h = (s) => p(MD ? `\n## ${s}` : `\n${s}\n${"─".repeat(s.length)}`);
  const bullet = (s) => p(MD ? `- ${s}` : `  • ${s}`);
  const moverLines = (title, m, unit = "stores") => {
    h(title);
    if (!m.winners.length && !m.losers.length) { bullet("no movement this week"); return; }
    p(MD ? "**Gaining:**" : " Gaining:");
    m.winners.forEach((w) => bullet(`${w.label}  +${w.delta.toLocaleString()} (now ${w.now.toLocaleString()} ${unit})`));
    if (m.losers.length) { p(MD ? "**Slipping:**" : " Slipping:"); m.losers.forEach((w) => bullet(`${w.label}  ${w.delta.toLocaleString()} (now ${w.now.toLocaleString()} ${unit})`)); }
  };

  p(MD ? `# Terrain — Weekly Admin Recap` : `TERRAIN — WEEKLY ADMIN RECAP`);
  p(`Week ${prevDate} → ${curD}`);

  h("Discovery");
  bullet(`${dNew.toLocaleString()} new stores in the target-market universe (snapshot)`);
  bullet(`${g.new7.toLocaleString()} new stores logged overall · ${g.newglobal.toLocaleString()} of them global (tracked, un-enriched until the market is enabled)`);
  bullet(`Store base: ${cur.storesTotal?.toLocaleString()} (was ${prev.storesTotal?.toLocaleString()})`);

  h("Churn (confirmed — 2+ consecutive failed checks)");
  bullet(`${churnTotal.toLocaleString()} stores actually churned this week`);
  bullet(`${churnDead.toLocaleString()} went dead — domain unreachable / gone`);
  bullet(`${churnMigrated.toLocaleString()} migrated off Shopify — reachable, but no longer on the platform`);

  h("New Shopify Plus");
  bullet(`${dPlus.toLocaleString()} new Plus stores this week · ${cur.plusTotal?.toLocaleString()} Plus total (was ${prev.plusTotal?.toLocaleString()})`);

  moverLines("Payments — winners & losers", movers(prev.paymentsByProvider, cur.paymentsByProvider), "merchants");
  moverLines("Apps — winners & losers", movers(prev.apps, cur.apps));
  moverLines("Themes — winners & losers", movers(prev.themes, cur.themes));
  moverLines("Shipping — winners & losers", movers(prev.shippingByProvider, cur.shippingByProvider), "merchants");

  p("");
  p(MD ? "---" : "─".repeat(52));
  p(MD ? "_Payments / apps / themes movers are week-over-week snapshot share. Snapshots" +
        " before the churn-logic fix (2026-09-12) still carry the false-migration artifact," +
        " so those movers settle over the next ~week of clean snapshots. Churn counts above" +
        " are already corrected._"
       : "Note: payments/apps/themes movers are WoW snapshot share; snapshots before the\n" +
        "churn-logic fix still carry the false-migration artifact and settle over ~1 week.\n" +
        "Churn counts above are already corrected.");
  console.log(L.join("\n"));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

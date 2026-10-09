/** "Terrain's read on the week" — the anomaly engine behind the Overview's AI-style insight panel.
 *
 *  Pure statistics, NOT an LLM: for each dimension we build the last ~10 ROLLING 7-day cohorts from
 *  launched_at (collection-neutral — a scan/import-heavy week can't move a launch-share), then flag
 *  where THIS week deviates from the distribution of the prior weeks (z-score + a minimum effect
 *  size). Deterministic, auditable, and free. Churn is the one check-dated signal (no died_at column),
 *  and is labelled as such.
 */
import { db as sharedDb } from "./db";
import { cachedAgg } from "./agg-cache";
import { FOCUS_MARKETS, marketLabel } from "./markets";
import { platformLabel } from "./insights";

function db() { return sharedDb(); }
const FOCUS = [...FOCUS_MARKETS];

export type Read = {
  key: string;
  title: string;          // bold claim
  detail: string;         // the supporting numbers
  magnitude: string;      // e.g. "+8pp", "2.3×"
  tone: "up" | "down" | "alert";
  confidence: "high" | "medium";
  href: string;
};

type Stat = { mean: number; sd: number; n: number };
function stat(xs: number[]): Stat {
  const n = xs.length;
  if (!n) return { mean: 0, sd: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 0;
  return { mean, sd, n };
}
const z = (cur: number, s: Stat) => (s.sd > 0 ? (cur - s.mean) / s.sd : 0);
const conf = (zAbs: number, n: number): "high" | "medium" => (zAbs >= 2 && n >= 5 ? "high" : "medium");

export async function weekRead(): Promise<Read[]> {
  return cachedAgg("overview:read:v1", 15 * 60 * 1000, async () => {
    const sql = db();
    // Rolling 7-day cohort index off launched_at: wk 0 = last 7 days, 1 = the 7 before, … (cap 10).
    const rows = await sql.begin(async (t) => {
      await t`SET LOCAL statement_timeout = '25s'`;
      const totals = await t<{ wk: number; n: number }[]>`
        SELECT (floor(extract(epoch from (now()-launched_at))/604800))::int wk, count(*)::int n
        FROM imported_stores WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '70 days'
        GROUP BY 1 HAVING (floor(extract(epoch from (now()-launched_at))/604800))::int < 10 ORDER BY 1`;
      const plat = await t<{ wk: number; k: string; n: number }[]>`
        SELECT (floor(extract(epoch from (now()-launched_at))/604800))::int wk,
               CASE WHEN platform IS NULL OR lower(platform)='shopify' THEN 'shopify' WHEN lower(platform)='woocommerce' THEN 'woocommerce' ELSE 'other' END k,
               count(*)::int n
        FROM imported_stores WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '70 days'
        GROUP BY 1,2 HAVING (floor(extract(epoch from (now()-launched_at))/604800))::int < 10`;
      const cat = await t<{ wk: number; k: string; n: number }[]>`
        SELECT (floor(extract(epoch from (now()-launched_at))/604800))::int wk, category k, count(*)::int n
        FROM imported_stores WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '70 days'
          AND category IS NOT NULL AND category <> '' AND category <> 'Unknown'
        GROUP BY 1,2 HAVING (floor(extract(epoch from (now()-launched_at))/604800))::int < 10`;
      const mkt = await t<{ wk: number; k: string; n: number }[]>`
        SELECT (floor(extract(epoch from (now()-launched_at))/604800))::int wk, upper(country) k, count(*)::int n
        FROM imported_stores WHERE published AND country = ANY(${FOCUS}) AND launched_at > now()-interval '70 days'
        GROUP BY 1,2 HAVING (floor(extract(epoch from (now()-launched_at))/604800))::int < 10`;
      const churn = await t<{ wk: number; n: number }[]>`
        SELECT (floor(extract(epoch from (now()-live_checked_at))/604800))::int wk, count(*)::int n
        FROM imported_stores WHERE country = ANY(${FOCUS}) AND live_status='dead' AND live_checked_at > now()-interval '70 days'
        GROUP BY 1 HAVING (floor(extract(epoch from (now()-live_checked_at))/604800))::int < 10 ORDER BY 1`;
      return { totals, plat, cat, mkt, churn };
    });

    const out: Read[] = [];
    const totalByWk = new Map(rows.totals.map((r) => [r.wk, r.n]));
    const curTotal = totalByWk.get(0) ?? 0;
    const priorTotals = rows.totals.filter((r) => r.wk >= 1).map((r) => r.n);
    if (curTotal < 20 || priorTotals.length < 3) return []; // not enough signal to be honest

    // 1 · Launch volume vs the norm
    {
      const s = stat(priorTotals);
      const zc = z(curTotal, s);
      const ratio = s.mean > 0 ? curTotal / s.mean : 1;
      if (s.mean > 0 && Math.abs(ratio - 1) >= 0.18 && Math.abs(zc) >= 1.2) {
        const up = ratio > 1;
        out.push({
          key: "volume", tone: up ? "up" : "down", confidence: conf(Math.abs(zc), s.n),
          title: up ? `New launches are running hot` : `New launches have cooled off`,
          detail: `${curTotal.toLocaleString()} stores launched this week vs ~${Math.round(s.mean).toLocaleString()} typical.`,
          magnitude: `${ratio.toFixed(1)}×`, href: "/dashboard?launched=7d",
        });
      }
    }

    // Share-deviation helper: biggest mover in a dimension (this week's share vs prior-weeks' share).
    const shareMover = (grp: { wk: number; k: string; n: number }[], minShare = 0.05) => {
      const keys = [...new Set(grp.map((r) => r.k))];
      let best: { k: string; cur: number; mean: number; z: number; n: number } | null = null;
      for (const k of keys) {
        const byWk = new Map(grp.filter((r) => r.k === k).map((r) => [r.wk, r.n]));
        const share = (wk: number) => (totalByWk.get(wk) ? (byWk.get(wk) ?? 0) / totalByWk.get(wk)! : 0);
        const cur = share(0);
        const prior = rows.totals.filter((r) => r.wk >= 1).map((r) => share(r.wk));
        const s = stat(prior);
        if (s.mean < minShare && cur < minShare) continue; // ignore tiny slivers
        const zz = z(cur, s);
        if (!best || Math.abs(zz) > Math.abs(best.z)) best = { k, cur, mean: s.mean, z: zz, n: s.n };
      }
      return best;
    };

    // 2 · Platform over/under-indexing
    {
      const b = shareMover(rows.plat, 0.03);
      if (b && Math.abs(b.cur - b.mean) >= 0.03 && Math.abs(b.z) >= 1.2) {
        const up = b.cur > b.mean;
        const name = platformLabel(b.k === "other" ? "other" : b.k);
        out.push({
          key: "platform", tone: up ? "up" : "down", confidence: conf(Math.abs(b.z), b.n),
          title: `${b.k === "other" ? "Other CMSs are" : name + " is"} ${up ? "over-indexing" : "under-indexing"} on new launches`,
          detail: `${Math.round(b.cur * 100)}% of this week's launches vs its usual ${Math.round(b.mean * 100)}%.`,
          magnitude: `${up ? "+" : "−"}${Math.round(Math.abs(b.cur - b.mean) * 100)}pp`, href: "/insights",
        });
      }
    }

    // 3 · Category surge
    {
      const b = shareMover(rows.cat, 0.04);
      if (b && b.cur > b.mean && Math.abs(b.cur - b.mean) >= 0.03 && b.z >= 1.3) {
        out.push({
          key: "category", tone: "up", confidence: conf(b.z, b.n),
          title: `${b.k} is having a moment`,
          detail: `${Math.round(b.cur * 100)}% of new launches this week vs its usual ${Math.round(b.mean * 100)}%.`,
          magnitude: `+${Math.round((b.cur - b.mean) * 100)}pp`, href: "/insights",
        });
      }
    }

    // 4 · Market punching above its weight
    {
      const b = shareMover(rows.mkt, 0.04);
      if (b && b.cur > b.mean && Math.abs(b.cur - b.mean) >= 0.03 && b.z >= 1.3) {
        const name = marketLabel(b.k).replace(/^[^\p{L}]+/u, "");
        out.push({
          key: "market", tone: "up", confidence: conf(b.z, b.n),
          title: `${name} is punching above its weight`,
          detail: `${Math.round(b.cur * 100)}% of this week's launches came from ${name}, vs its usual ${Math.round(b.mean * 100)}%.`,
          magnitude: `+${Math.round((b.cur - b.mean) * 100)}pp`, href: `/dashboard?country=${b.k}&launched=7d`,
        });
      }
    }

    // 5 · Churn (check-dated — labelled)
    {
      const cur = rows.churn.find((r) => r.wk === 0)?.n ?? 0;
      const prior = rows.churn.filter((r) => r.wk >= 1).map((r) => r.n);
      const s = stat(prior);
      const ratio = s.mean > 0 ? cur / s.mean : 1;
      const zc = z(cur, s);
      if (cur >= 10 && s.mean > 0 && (ratio >= 1.4 || ratio <= 0.6) && Math.abs(zc) >= 1.2) {
        const up = ratio > 1;
        out.push({
          key: "churn", tone: up ? "alert" : "up", confidence: conf(Math.abs(zc), s.n),
          title: up ? `Churn is running above normal` : `Churn has eased off`,
          detail: `${cur.toLocaleString()} stores confirmed dead this week vs ~${Math.round(s.mean).toLocaleString()} typical (by confirmation date).`,
          magnitude: `${ratio.toFixed(1)}×`, href: "/dashboard",
        });
      }
    }

    // Rank: high-confidence first, then biggest effect; cap at 4.
    const rank = (r: Read) => (r.confidence === "high" ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  }).catch(() => [] as Read[]);
}

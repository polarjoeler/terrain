#!/usr/bin/env node
/**
 * build-priority — one score per store saying how big it is, so every lane works biggest-first.
 *
 *   node --env-file=.env.local scripts/build-priority.mjs [--dry-run] [--show ZA] [--migrate]
 *
 * Writes the side table `store_priority` (one row per ranked store). It is rebuilt daily on Rex and
 * read by the payments queue, the contact lanes and the render lane, which order by it.
 *
 * The signals Joel chose on 2026-11-11, each scaled 0..1 on an absolute scale so a score means the
 * same thing in every market (a percentile would make the 500th ZA store look like the 500th US one):
 *   traffic  30  CrUX rank bucket (1k → 1.0 … 1M → 0.15); else the vendor visit estimate, discounted
 *   social   20  Instagram + Facebook followers, log scale (100 → 0, 1M → 1)
 *   team     15  LinkedIn / vendor employee count, log scale (1 → 0, ~3,000 → 1)
 *   plus     15  Shopify Plus = 1; Advanced-or-annual = 0.4
 *   revenue  15  revExpr() USD/month, log scale ($1k → 0, $1M → 1). Kept at low weight because traffic
 *                covers only ~1 in 5 ZA stores; without it most stores would rank on followers alone
 *   growth    5  CrUX trend up = 1, new to the list = 0.5
 * Product count is left out on purpose (Joel: misleading).
 *
 * Store groups (the LEGO case): stores run by one operator form one ACCOUNT. The account scores its
 * best store plus 4 points per doubling of its SITE count (distinct store_group_members.site — the
 * same store under www./shop./account./mail. counts once), and every store in it carries that
 * account score and rank, within each market. `market_rank` counts accounts, not sites, so "top 1,000" is 1,000 accounts.
 *
 * A signal we don't have is UNKNOWN, not zero: the score is the weighted mean of the signals we do
 * have, shrunk toward 60% of itself as more of them are missing (see the formula below). Plus only
 * applies to Shopify stores. Without this, Takealot and Checkers (traffic known, no follower or team
 * data collected yet) ranked ~#300 in ZA, below mid-size Plus stores with every field filled.
 *
 * Who is ranked: published, live (not dead/migrated), not not_a_store / dormant, not a foreign
 * storefront, showing it sells (Shopify, payments, products, an active/selling tier or a marquee seed),
 * not a .gov/.edu/.ac domain or an escort/gambling site, and with at least one size signal (traffic, followers, team or revenue). Stores with no signal at all have no row; lanes put them
 * after every ranked store.
 *
 * Cost: one read of the narrow columns of imported_stores (~2.9GB heap) per day, then an upsert that
 * rewrites only rows whose score or rank changed.
 */
import postgres from "postgres";
import { revExpr } from "../lib/fx.ts";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry-run");
const MIGRATE = process.argv.includes("--migrate");
const SHOW = (arg("--show", "ZA") || "ZA").toUpperCase();

const W = { traffic: 30, social: 20, team: 15, plus: 15, revenue: 15, growth: 5 };
const GROUP_BONUS = 4;   // points per doubling of an account's distinct SITE count

async function migrate(sql) {
  await sql`CREATE TABLE IF NOT EXISTS store_priority (
    domain        text PRIMARY KEY,
    country       text,
    platform      text,
    account       text NOT NULL,      -- store group id when the store is in a group, else the domain
    account_size  int  NOT NULL DEFAULT 1,  -- distinct SITES in the account, not domain rows (see the bonus below)
    score         real NOT NULL,      -- 0-100, this store's own signals
    account_score real NOT NULL,      -- 0-100, the account's best store + the group bonus
    market_rank   int,                -- account rank within the country (1 = biggest); NULL without a country
    traffic real, social real, team real, plus real, revenue real, growth real,
    built_at      timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS store_priority_market ON store_priority (country, market_rank)`;
  await sql`CREATE INDEX IF NOT EXISTS store_priority_account_score ON store_priority (account_score DESC)`;
  console.log("store_priority: table and indexes in place.");
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, idle_timeout: 20,
    connection: { statement_timeout: 900000, idle_in_transaction_session_timeout: 900000, lock_timeout: 10000 } });
  try {
    if (MIGRATE) { await migrate(sql); return; }
    const exists = (await sql`SELECT to_regclass('public.store_priority') t`)[0].t;
    if (!exists && !DRY) { console.error("store_priority is missing — run once with --migrate."); process.exit(1); }

    const t0 = Date.now();
    const result = await sql.begin(async (tx) => {
      // 1. Each store's own signals. The temp table lives only inside this transaction (the pooler is
      //    in transaction mode, so it could not outlive it anyway).
      await tx.unsafe(`CREATE TEMP TABLE pr_sig ON COMMIT DROP AS
        SELECT s.domain,
               upper(NULLIF(s.country, '')) AS country,
               lower(s.platform) AS platform,
               COALESCE(m.group_id, s.domain) AS account,
               -- each signal is 0..1 when we have it and NULL when we don't (NULL = unknown, not small)
               CASE WHEN s.crux_rank IS NOT NULL THEN
                      CASE WHEN s.crux_rank <= 1000 THEN 1 WHEN s.crux_rank <= 5000 THEN 0.85 WHEN s.crux_rank <= 10000 THEN 0.75
                           WHEN s.crux_rank <= 50000 THEN 0.6 WHEN s.crux_rank <= 100000 THEN 0.5 WHEN s.crux_rank <= 500000 THEN 0.3 ELSE 0.15 END
                    -- vendor visit estimate: 1k/month → 0, 10M → 0.8 (discounted: it's a model, CrUX is measured)
                    WHEN s.estimated_visits IS NOT NULL THEN 0.8 * GREATEST(0, LEAST(1, (log(GREATEST(s.estimated_visits, 1)::numeric) - 3) / 4))
               END::real AS traffic,
               CASE WHEN COALESCE(s.instagram_followers, 0) + COALESCE(s.facebook_followers, 0) > 0
                    THEN GREATEST(0, LEAST(1, (log((COALESCE(s.instagram_followers, 0) + COALESCE(s.facebook_followers, 0))::numeric) - 2) / 4))
               END::real AS social,
               CASE WHEN COALESCE(s.employee_count, 0) > 0
                    THEN LEAST(1, log(s.employee_count::numeric) / 3.5) END::real AS team,
               -- Plus applies to Shopify only; for other platforms it is left out of the score entirely
               CASE WHEN s.plan_tier = 'plus' OR s.plus THEN 1 WHEN s.plan_tier = 'advanced_or_annual' THEN 0.4
                    WHEN s.plan_tier IS NOT NULL THEN 0 END::real AS plus,
               (lower(s.platform) = 'shopify') AS plus_applies,
               -- The SITE this row belongs to. store_group_members.site already collapses the same
               -- store's several hostnames (www./shop./account./mail. variants, myshopify aliases)
               -- onto one key, which is what the group bonus below must count — see the acc CTE.
               COALESCE(m.site, s.domain) AS site,
               CASE WHEN ${revExpr()} IS NOT NULL
                    THEN GREATEST(0, LEAST(1, (log(GREATEST(${revExpr()}, 1)::numeric) - 3) / 3)) END::real AS revenue,
               CASE s.crux_trend WHEN 'up' THEN 1 WHEN 'new' THEN 0.5 WHEN 'flat' THEN 0 WHEN 'down' THEN 0 END::real AS growth
          FROM imported_stores s
          LEFT JOIN store_group_members m ON m.domain = s.domain
         WHERE s.published
           AND (s.live_status IS NULL OR s.live_status NOT IN ('dead', 'migrated'))
           AND (s.activity_tier IS NULL OR s.activity_tier NOT IN ('not_a_store', 'dormant'))
           AND NOT EXISTS (SELECT 1 FROM store_tags t WHERE t.domain = s.domain AND t.tag = 'foreign-storefront')
           -- it must show it sells. A WordPress site with the Woo plugin, a college or a government
           -- portal can carry a top CrUX rank; without this they filled KE's top 25.
           AND (lower(s.platform) = 'shopify' OR COALESCE(s.payments, '') <> '' OR COALESCE(s.product_count, 0) > 0
                OR s.activity_tier IN ('selling', 'active') OR s.source = 'manual_marquee')
           AND s.domain !~ '\\.(gov|go|gob|edu|ac|mil|police)(\\.[a-z]{2})?$'
           -- adult and gambling sites take Woo/M-Pesa payments and rank high on CrUX but are not leads
           AND s.domain !~ '(escort|casino|porn|xxx|betting|sportsbet|^bet[a-z0-9-]*\\.)'`);
      // a store needs at least one SIZE signal (Plus or a growth trend alone says nothing about size)
      await tx.unsafe(`DELETE FROM pr_sig WHERE traffic IS NULL AND social IS NULL AND team IS NULL AND revenue IS NULL`);
      // Score = weighted mean of the signals we HAVE, shrunk toward 60% when much is missing:
      //   score = 100 · Σ w·x / Σ w(known) · (0.6 + 0.4 · Σ w(known) / Σ w(applicable))
      // so Takealot (traffic + revenue known, no follower or team data yet) still ranks near the top
      // instead of below a mid-size store that happens to have every field filled.
      const known = (c, w) => `CASE WHEN ${c} IS NULL THEN 0 ELSE ${w} END`;
      const den = [["traffic", W.traffic], ["social", W.social], ["team", W.team], ["plus", W.plus], ["revenue", W.revenue], ["growth", W.growth]]
        .map(([c, w]) => known(c, w)).join(" + ");
      const num = Object.entries(W).map(([c, w]) => `${w} * COALESCE(${c}, 0)`).join(" + ");
      const app = `(${W.traffic + W.social + W.team + W.revenue + W.growth} + CASE WHEN plus_applies THEN ${W.plus} ELSE 0 END)`;
      await tx.unsafe(`ALTER TABLE pr_sig ADD COLUMN score real`);
      await tx.unsafe(`UPDATE pr_sig SET score = round((100.0 * (${num}) / (${den})
        * (0.6 + 0.4 * (${den})::numeric / ${app}))::numeric, 2)`);

      // 2. Accounts: best store + bonus per doubling of size, then rank accounts within each country.
      //    Size counts distinct SITES, not domain rows. Counting rows paid the bonus for the same
      //    store listed under several hostnames: ciovita scored 71.47 + 4·log2(5) = 80.76 off five
      //    rows that store_group_members calls two sites, so it ranked ZA #12 on a bonus it had not
      //    earned. Measured 2026-11-13: 253 of 990 multi-store accounts were inflated this way, by
      //    up to +8.00 points. Sites are what "one operator runs N stores" was ever meant to mean.
      await tx.unsafe(`CREATE TEMP TABLE pr ON COMMIT DROP AS
        WITH acc AS (
          -- per market: a group's US flagship must not lift its small Nigerian sites
          SELECT account, country, count(DISTINCT site) AS size,
                 LEAST(100, max(score) + ${GROUP_BONUS} * log(2, count(DISTINCT site)::numeric))::real AS account_score
            FROM pr_sig GROUP BY account, country),
        ranked AS (
          SELECT p.*, a.size AS account_size, round(a.account_score::numeric, 2)::real AS account_score
            FROM pr_sig p JOIN acc a ON a.account = p.account AND a.country IS NOT DISTINCT FROM p.country)
        SELECT r.*, CASE WHEN country IS NULL THEN NULL
                         ELSE dense_rank() OVER (PARTITION BY country ORDER BY account_score DESC, account) END::int AS market_rank
          FROM ranked r`);

      const [sum] = await tx.unsafe(`SELECT count(*)::int stores, count(DISTINCT account)::int accounts,
          count(*) FILTER (WHERE account_size > 1)::int grouped,
          count(*) FILTER (WHERE country = 'ZA')::int za FROM pr`);
      const top = await tx.unsafe(`SELECT market_rank, account, account_size, account_score,
          string_agg(domain, ', ' ORDER BY score DESC) FILTER (WHERE true) AS domains,
          max(traffic) t, max(social) s, max(team) e, max(plus) p, max(revenue) r
        FROM pr WHERE country = $1 AND market_rank <= 25
        GROUP BY market_rank, account, account_size, account_score ORDER BY market_rank`, [SHOW]);
      const tiers = await tx.unsafe(`SELECT country, count(DISTINCT account) FILTER (WHERE market_rank <= 1000)::int top1000,
          round(min(account_score) FILTER (WHERE market_rank <= 1000)::numeric, 1) cut1000,
          round(min(account_score) FILTER (WHERE market_rank <= 100)::numeric, 1) cut100
        FROM pr WHERE country IN ('ZA','KE','NG','US','GB','AU') GROUP BY country ORDER BY country`);

      // The sprint scorecard: what the top 1,000 accounts in each focus market still lack.
      const gaps = await tx.unsafe(`SELECT pr.country,
          count(*)::int stores,
          count(*) FILTER (WHERE pr.platform = 'shopify')::int shopify,
          count(*) FILTER (WHERE COALESCE(s.technologies, '') <> '' OR COALESCE(s.apps, '') <> '')::int tech,
          count(*) FILTER (WHERE COALESCE(s.payments, '') <> '')::int payments,
          count(*) FILTER (WHERE COALESCE(s.payments, '') = '' AND s.payments_checked_at IS NOT NULL)::int pay_tried_none,
          count(*) FILTER (WHERE COALESCE(s.contact_email, s.email, '') <> '')::int email,
          count(*) FILTER (WHERE s.contact_type = 'named')::int named,
          count(*) FILTER (WHERE pr.social IS NOT NULL)::int social,
          count(*) FILTER (WHERE pr.team IS NOT NULL)::int team
        FROM pr JOIN imported_stores s ON s.domain = pr.domain
        WHERE pr.country IN ('ZA','KE','NG') AND pr.market_rank <= 1000
        GROUP BY pr.country ORDER BY pr.country`);

      let written = 0, removed = 0;
      if (!DRY) {
        const up = await tx.unsafe(`INSERT INTO store_priority AS sp
            (domain, country, platform, account, account_size, score, account_score, market_rank,
             traffic, social, team, plus, revenue, growth, built_at)
          SELECT domain, country, platform, account, account_size, score, account_score, market_rank,
                 traffic, social, team, plus, revenue, growth, now() FROM pr
          ON CONFLICT (domain) DO UPDATE SET
            country = excluded.country, platform = excluded.platform, account = excluded.account,
            account_size = excluded.account_size, score = excluded.score, account_score = excluded.account_score,
            market_rank = excluded.market_rank, traffic = excluded.traffic, social = excluded.social,
            team = excluded.team, plus = excluded.plus, revenue = excluded.revenue, growth = excluded.growth,
            built_at = excluded.built_at
          WHERE (sp.country, sp.platform, sp.account, sp.account_size, sp.score, sp.account_score, sp.market_rank)
                IS DISTINCT FROM
                (excluded.country, excluded.platform, excluded.account, excluded.account_size, excluded.score,
                 excluded.account_score, excluded.market_rank)`);
        written = up.count;
        const del = await tx.unsafe(`DELETE FROM store_priority sp WHERE NOT EXISTS (SELECT 1 FROM pr WHERE pr.domain = sp.domain)`);
        removed = del.count;
        await tx`INSERT INTO app_settings (key, value) VALUES ('priority.built',
            ${JSON.stringify({ at: new Date().toISOString(), ...sum, written, removed, top1000: gaps })})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
      }
      return { sum, top, tiers, gaps, written, removed };
    });

    const { sum, top, tiers, gaps, written, removed } = result;
    console.log(`build-priority${DRY ? " [DRY RUN]" : ""}: ${sum.stores.toLocaleString()} ranked stores in ${sum.accounts.toLocaleString()} accounts`
      + ` (${sum.grouped.toLocaleString()} stores share an account) · ZA ${sum.za.toLocaleString()} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!DRY) console.log(`  ${written.toLocaleString()} rows written (changed) · ${removed.toLocaleString()} dropped (no longer ranked)`);
    console.log(`\n  score at rank 100 / 1,000 by market:`);
    for (const r of tiers) console.log(`    ${r.country}  #100 ≥ ${r.cut100}   #1000 ≥ ${r.cut1000 ?? "—"}  (${r.top1000} accounts)`);
    console.log(`\n  top 1,000 accounts — what they have (stores):`);
    for (const g of gaps) {
      const pct = (n) => `${n.toLocaleString()} (${Math.round((100 * n) / g.stores)}%)`;
      console.log(`    ${g.country}  ${g.stores.toLocaleString()} stores (${g.shopify} Shopify) · tech ${pct(g.tech)} · payments ${pct(g.payments)}`
        + ` [+${g.pay_tried_none} probed, none found] · email ${pct(g.email)} · named person ${pct(g.named)} · followers ${pct(g.social)} · team size ${pct(g.team)}`);
    }
    console.log(`\n  ${SHOW} top 25 accounts   [traffic social team plus revenue]`);
    for (const r of top) {
      const parts = [r.t, r.s, r.e, r.p, r.r].map((v) => (v == null ? " · " : Number(v).toFixed(1))).join(" ");
      const ds = r.domains.length > 70 ? r.domains.slice(0, 67) + "…" : r.domains;
      console.log(`    ${String(r.market_rank).padStart(3)}  ${Number(r.account_score).toFixed(1).padStart(5)}  [${parts}]  ${r.account_size > 1 ? `(${r.account_size} sites) ` : ""}${ds}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("build-priority failed:", e.message); process.exit(1); });

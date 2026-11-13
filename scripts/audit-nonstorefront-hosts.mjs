#!/usr/bin/env node
/**
 * audit-nonstorefront-hosts — published rows that are an INFRASTRUCTURE or CUSTOMER-ACCOUNT
 * hostname of a store we already track (mail./account./cpanel./staging. …), not a storefront
 * of their own. They are served to customers as leads, they inherit (and inflate) their
 * account's store_priority score, and each one burns a direct crawl on every lane pass.
 *
 *   node --env-file=.env.local scripts/audit-nonstorefront-hosts.mjs            # dry run (default)
 *   node --env-file=.env.local scripts/audit-nonstorefront-hosts.mjs --csv /tmp/hosts.csv
 *   node --env-file=.env.local scripts/audit-nonstorefront-hosts.mjs --execute  # Joel runs this
 *
 * HOW IT DECIDES — DNS only, never HTTP. Resolution is exempt from the single residential IP's
 * rate budget (see memory: residential-ip-rate-budget), so this audit costs no crawl budget at
 * all. The prefix alone is NEVER enough to tag a row: a real store can live on a bare subdomain,
 * so every candidate must also be shown by DNS to be the same site as its tracked parent:
 *
 *   shopify_alias  CNAME chain ends at shops.myshopify.com → served by the parent's Shopify shop
 *                  (this is what Shopify's "new customer accounts" provisions account.<domain> for,
 *                  which is why the CT tailer finds so many of them)
 *   parent_alias   CNAME to the parent, or exactly the parent's A records → same host, same site
 *   dead           no CNAME and no A record → resolves nowhere, cannot be a storefront
 *   distinct_host  resolves somewhere the parent does not → NEVER TAGGED. Could be a genuinely
 *                  separate site on an odd hostname. Listed for a human to look at.
 *
 * WHAT A WRITE DOES (only with --execute):
 *   activity_tier = 'not_a_store'   — the existing route. Already honoured by lib/browse.ts (the
 *                                     customer lead list), lib/insights.ts, lib/leaders-report.ts,
 *                                     lib/leads-explore.ts and scripts/build-priority.mjs, so one
 *                                     field fixes visibility, scoring and the lane queues at once.
 *   not_a_store_checked_at = now()  — WITHOUT this, scripts/reclassify-not-a-store.mjs picks the
 *                                     row up (it selects not_a_store rows with a NULL stamp), asks
 *                                     store_classifier.py, gets STORE back — because an alias DOES
 *                                     serve the parent's real catalogue — and sets it back to
 *                                     'active'. The stamp is what makes the fix stick.
 *   a store_edits row               — same audit trail as an admin drawer edit.
 *
 * It also SKIPS any row whose activity_tier a human has already edited (a store_edits row for that
 * field), honouring the re-enrich protection contract: a lane must not clobber a correction.
 *
 * TWO THINGS THIS DOES NOT FIX, both code, not data:
 *  1. The crawl. verify-liveness, payment-queue and catalog-enrich gate on published/live_status
 *     and never on activity_tier, so a tagged row is still probed. Each needs
 *     "AND activity_tier IS DISTINCT FROM 'not_a_store'" in its queue query.
 *  2. The score inflation in general. 253 of 990 multi-store accounts are inflated because
 *     build-priority.mjs sizes an account with count(*) over DOMAINS, while
 *     store_group_members.site already records which of them are ONE site. Tagging these 349
 *     repairs only 15 of the 253; the other 238 are plain www./alias duplicates. The fix is to
 *     size accounts by count(DISTINCT site) in build-priority.mjs.
 */
import postgres from "postgres";
import { promises as dns } from "node:dns";
import { writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const EXECUTE = process.argv.includes("--execute");
const CSV = arg("--csv", null);
const CONC = parseInt(arg("--concurrency", "24"), 10);   // DNS only — no HTTP, no IP budget

// Verbatim from lib/markets.ts VISIBLE_MARKETS. A store reaches a customer only when
// published=true AND country is in this set (see memory: dashboard-visibility-gate).
const VISIBLE_MARKETS = [
  "ZA", "KE", "NG", "EG", "MA", "GH", "TZ", "UG", "DZ", "TN", "CI", "SN", "MU", "MZ",
  "CM", "BW", "AO", "NA", "RW", "ZM", "ET", "ZW", "LY", "MW", "SO", "LS", "SZ",
];

// Leftmost labels that are never a storefront. shop./store./www. are deliberately NOT here:
// a real store does legitimately live on shop.brand.com.
const PREFIXES = ["mail", "portal", "account", "webmail", "cpanel", "smtp", "imap", "mx", "ftp",
  "admin", "vpn", "remote", "autodiscover", "calendar", "dev", "staging", "test"];

// registrable() — copied from scripts/build-store-groups.mjs so "parent" means exactly what a
// Level-1 SITE means there. Keep the two in step.
const SL2 = /^(co|com|org|net|edu|gov|ac|or|ne|go|sch|web|mil|nom|info|biz|ltd|plc|name)$/;
const PRIVATE_SL2 = new Set(["za.com", "za.net", "za.org", "co.com", "uk.com", "us.com", "eu.com", "de.com", "africa.com", "name.ng", "com.de"]);
function registrable(host) {
  if (!host) return null;
  const l = host.toLowerCase().trim().replace(/\.$/, "").replace(/^www\./, "").split(".");
  if (l.length < 2) return null;
  const two = l.slice(-2).join(".");
  return l.length >= 3 && ((l[l.length - 1].length === 2 && SL2.test(l[l.length - 2])) || PRIVATE_SL2.has(two))
    ? l.slice(-3).join(".") : two;
}

const bare = (d) => String(d).toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

async function resolveHost(host) {
  const out = { cname: null, a: [] };
  try { const c = await dns.resolveCname(host); out.cname = c[0] ? bare(c[0]) : null; } catch { /* no CNAME */ }
  try { out.a = (await dns.resolve4(host)).sort(); } catch { /* no A */ }
  return out;
}

/** Map one candidate to a class. Pure, so it can be reasoned about without DNS in hand. */
function classify(cand, parent) {
  const sameA = cand.a.length > 0 && parent.a.length > 0 && cand.a.join(",") === parent.a.join(",");
  if (cand.cname && /(^|\.)myshopify\.com$/.test(cand.cname)) return "shopify_alias";
  if (cand.cname && (cand.cname === cand.parentBare || cand.cname === cand.parentBare.replace(/^www\./, ""))) return "parent_alias";
  if (sameA) return "parent_alias";
  if (!cand.cname && cand.a.length === 0) return "dead";
  return "distinct_host";
}

const TAGGABLE = new Set(["shopify_alias", "parent_alias", "dead"]);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20,
  connection: { statement_timeout: 240000, idle_in_transaction_session_timeout: 240000, lock_timeout: 8000 } });

try {
  // 1. Candidates: the visibility gate + a non-storefront leftmost label. One scan, no function in
  //    the predicate (a correlated registrable() per row times out on 1.4M rows).
  const cand = await sql`
    SELECT domain, country, platform, activity_tier, live_status, payments, product_count,
           crux_rank, source, discovered_at
      FROM imported_stores
     WHERE published AND country = ANY(${VISIBLE_MARKETS})
       AND split_part(regexp_replace(lower(domain), '^www\\.', ''), '.', 1) = ANY(${PREFIXES})`;

  const rows = cand
    .map((r) => { const b = bare(r.domain); return { ...r, bare: b, prefix: b.split(".")[0], parentBare: registrable(r.domain) }; })
    .filter((r) => r.parentBare && r.parentBare !== r.bare);

  // 2. Is the registrable parent itself tracked? Exact-domain lookups ride the primary key.
  const parents = [...new Set(rows.map((r) => r.parentBare))];
  const pRows = await sql`
    SELECT regexp_replace(lower(domain), '^www\\.', '') AS bare, published
      FROM imported_stores WHERE domain = ANY(${[...parents, ...parents.map((p) => "www." + p)]})`;
  const tracked = new Map(pRows.map((p) => [p.bare, p]));

  const setB = rows.filter((r) => tracked.has(r.parentBare));
  console.log(`audit-nonstorefront-hosts${EXECUTE ? "" : "  [DRY RUN — nothing will be written]"}`);
  console.log(`  published + VISIBLE_MARKETS + non-storefront prefix : ${rows.length}`);
  console.log(`  ...of which the registrable parent is also tracked  : ${setB.length}  (${new Set(setB.map((r) => r.parentBare)).size} parents)`);
  if (!setB.length) { await sql.end(); process.exit(0); }

  // 3. Rows a human has already ruled on — never clobber a correction.
  const edited = new Set((await sql`
    SELECT DISTINCT domain FROM store_edits
     WHERE field = 'activity_tier' AND domain = ANY(${setB.map((r) => r.domain)})`.catch(() => [])).map((r) => r.domain));

  // 4. DNS, candidate and parent. Cached per parent so a group costs one lookup.
  const pCache = new Map();
  const parentOf = async (p) => { if (!pCache.has(p)) pCache.set(p, await resolveHost(p)); return pCache.get(p); };
  console.log(`\nresolving ${setB.length} hostnames + ${new Set(setB.map((r) => r.parentBare)).size} parents over DNS (no HTTP, no crawl budget)…`);
  const classified = await mapLimit(setB, CONC, async (r) => {
    const [c, p] = [await resolveHost(r.bare), await parentOf(r.parentBare)];
    return { ...r, a: c.a, cname: c.cname, parent_a: p.a, parent_cname: p.cname, klass: classify({ ...c, parentBare: r.parentBare }, p) };
  });

  // 5. Report
  const by = (arr, k) => { const m = new Map(); for (const r of arr) m.set(k(r), (m.get(k(r)) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  console.log(`\n--- DNS verdict ---`);
  for (const [k, n] of by(classified, (r) => r.klass))
    console.log(`  ${k.padEnd(15)} ${String(n).padStart(4)}${TAGGABLE.has(k) ? "" : "   ← left alone, needs a human"}`);

  const alreadyTagged = classified.filter((r) => r.activity_tier === "not_a_store");
  const toTag = classified.filter((r) => TAGGABLE.has(r.klass) && r.activity_tier !== "not_a_store" && !edited.has(r.domain));
  const review = classified.filter((r) => r.klass === "distinct_host" && r.activity_tier !== "not_a_store");

  console.log(`\n--- what --execute would change ---`);
  console.log(`  already activity_tier='not_a_store'        : ${alreadyTagged.length}  (left as they are)`);
  console.log(`  human already edited activity_tier         : ${classified.filter((r) => edited.has(r.domain)).length}  (skipped — correction protected)`);
  console.log(`  WOULD TAG not_a_store + stamp checked_at   : ${toTag.length}`);
  console.log(`  left for review (resolves off the parent)  : ${review.length}`);
  console.log(`  by prefix:`, by(toTag, (r) => r.prefix).map(([p, n]) => `${p}=${n}`).join("  "));
  console.log(`  by country:`, by(toTag, (r) => r.country).map(([p, n]) => `${p}=${n}`).join("  "));

  console.log(`\n  → tagging ${toTag.length} rows removes them from:`);
  console.log(`      the customer lead list (lib/browse.ts), insights, leaders-report, leads-explore`);
  console.log(`      store_priority entirely (build-priority excludes the tier) — no score, no rank,`);
  console.log(`        and the account's group bonus stops counting them`);
  console.log(`      contact-enrich's queue (it already filters the tier)`);
  console.log(`      render-enrich (it reads store_priority --top 1000)`);
  console.log(`  → but NOT from these, which filter published/live_status and never activity_tier:`);
  console.log(`      verify-liveness, payment-queue, catalog-enrich  ← the crawl budget is still spent.`);
  console.log(`      Each needs "AND activity_tier IS DISTINCT FROM 'not_a_store'" in its queue query.`);

  if (review.length) {
    console.log(`\n--- the ${review.length} to look at by hand (NOT tagged) ---`);
    for (const r of review.slice(0, 40))
      console.log(`  ${r.domain.padEnd(36)} ${String(r.country).padEnd(3)} → ${(r.cname || r.a[0] || "?").padEnd(26)} parent → ${r.parent_cname || r.parent_a[0] || "?"}`);
    if (review.length > 40) console.log(`  … and ${review.length - 40} more (use --csv for all)`);
  }

  if (CSV) {
    const head = ["domain", "klass", "would_tag", "country", "platform", "prefix", "parent", "parent_published",
      "activity_tier", "live_status", "has_payments", "product_count", "crux_rank", "source", "cname", "a", "parent_cname", "parent_a"];
    const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    writeFileSync(CSV, [head.join(","), ...classified.map((r) => [r.domain, r.klass,
      TAGGABLE.has(r.klass) && r.activity_tier !== "not_a_store" && !edited.has(r.domain) ? "yes" : "no",
      r.country, r.platform, r.prefix, r.parentBare, tracked.get(r.parentBare)?.published, r.activity_tier,
      r.live_status, r.payments ? "yes" : "", r.product_count, r.crux_rank, r.source,
      r.cname, r.a.join(" "), r.parent_cname, r.parent_a.join(" ")].map(esc).join(","))].join("\n") + "\n");
    console.log(`\ncsv → ${CSV}  (${classified.length} rows, every candidate and its DNS evidence)`);
  }

  if (!EXECUTE) {
    console.log(`\nDRY RUN — nothing written. Re-run with --execute to apply the ${toTag.length} tags.`);
  } else if (toTag.length) {
    // Batched, not row-at-a-time: the pooled instance is the throttle (memory: db-contention-limits).
    let done = 0;
    for (let i = 0; i < toTag.length; i += 200) {
      const slice = toTag.slice(i, i + 200);
      const domains = slice.map((r) => r.domain);
      await sql.begin(async (tx) => {
        const up = await tx`
          UPDATE imported_stores SET activity_tier = 'not_a_store', not_a_store_checked_at = now()
           WHERE domain = ANY(${domains}) AND activity_tier IS DISTINCT FROM 'not_a_store'`;
        done += up.count;
        await tx`CREATE TABLE IF NOT EXISTS store_edits (id bigserial PRIMARY KEY, domain text, editor text,
          field text, old_value text, new_value text, edited_at timestamptz NOT NULL DEFAULT now())`;
        for (const r of slice) {
          await tx`INSERT INTO store_edits (domain, editor, field, old_value, new_value)
            VALUES (${r.domain}, ${"audit-nonstorefront-hosts"}, ${"activity_tier"},
                    ${r.activity_tier ?? null}, ${"not_a_store:" + r.klass})`;
        }
      });
      console.log(`  …${Math.min(i + 200, toTag.length)}/${toTag.length}`);
    }
    console.log(`\n✓ tagged ${done} rows not_a_store (+ stamped not_a_store_checked_at, + ${toTag.length} store_edits rows).`);
    console.log(`  Next build-priority run drops them from every lane queue; the lead list hides them immediately.`);
  }
} finally { await sql.end(); }

#!/usr/bin/env node
/**
 * Merge the `www.` duplicate of every store into its bare twin, then delete the `www.` row.
 *
 * WHY THESE ROWS EXIST: every storefront TLS certificate lists both names the site answers on —
 * `shop.co.za` and `www.shop.co.za`. shopify-radar's ct_tail.py reads certificates as they are
 * issued and lands EVERY SAN as its own candidate: its `_destub()` maps infra subdomains
 * (cpanel./mail./account.) back to the apex, but `www` is in none of its three sets, so it falls
 * through to "keep as-is" and becomes a second store. 2,168,531 of the 2,168,660 `www.` rows in
 * imported_stores carry source='ct_tail'. One shop, two rows, enriched independently — so one ends
 * up with the contact email and the other with the revenue estimate, and a customer's lead list
 * contains the same business twice.
 *
 * WHAT THIS DOES, per pair:
 *   1. BACKUP   — every column of the `www.` row, streamed to gzipped JSONL. Nothing is deleted
 *                 before it is on disk, because there are no FKs and therefore no undo.
 *   2. MERGE    — fill the bare row's BLANK fields (NULL or '') from the www row. Never overwrite
 *                 a value the bare row already has. `published` is OR'd and `discovered_at` takes
 *                 the earlier of the two; see the note on those below.
 *   3. SIDE     — 24 tables key on `domain`. Each is either MOVED (a real signal that belongs to
 *                 the store) or DELETED (derived data a lane recomputes for free). See SIDE_TABLES.
 *   4. DELETE   — the `www.` row itself.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE:
 *   - `www.` rows with NO bare twin (189,511 of them). Renaming those would invent a row for a
 *     hostname we have never resolved. They are only a problem once ct_tail stops creating them.
 *   - churn_log rows for www domains whose bare twin is not a store row at all (41,080) — those
 *     belong to the orphan set above, not to any pair here.
 *
 * published IS OR'd, NOT taken from the bare row. 1,074 visible pairs have a bare twin that is
 * unpublished or carries no country, so a plain delete would quietly shrink the sellable base by
 * that much. The pair is ONE shop: if we were selling the www row, the shop is sellable — UNLESS a
 * person unpublished the bare row (latest store_edits 'published' edit is false). Then the human
 * decision wins and the www row's flag is ignored.
 *
 * RUN THE SOURCE FIX FIRST — THIS SCRIPT IS WORTHLESS WITHOUT IT. ct_tail re-inserts any domain
 * it no longer finds in the DB, so deleting the duplicates just makes 1.95M certificates look new
 * again. Measured on 2026-11-24: 32,073 `www.` rows with a bare twin were BACK within ~4 hours of
 * the bulk run finishing (~8k/hour), and the www share of ct_tail's inserts jumped from ~25%/hour
 * to ~70%/hour the moment the delete landed. The fix is shopify-radar PR #9 (`_destub()` collapses
 * `www.X` to `X`); it must be deployed AND `com.tembo.ct-tail` restarted on Rex before this runs.
 * Check it is live: ct_tail inserts after the restart should contain no `www.` row whose bare twin
 * already exists.
 *
 * Run it in phases, and prove it on the customer-visible slice first:
 *   node --env-file=.env.local scripts/dedupe-www.mjs --dry-run --visible-only
 *   node --env-file=.env.local scripts/dedupe-www.mjs --visible-only
 *   node --env-file=.env.local scripts/dedupe-www.mjs                 # the whole 1.98M
 * Restartable: MERGE only fills blanks (idempotent) and DELETE removes the rows the worklist is
 * built from, so a re-run picks up exactly what is left.
 */
import postgres from "postgres";
import { createWriteStream, mkdirSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = has("--dry-run");
const VISIBLE_ONLY = has("--visible-only");
const BATCH = Number(val("--batch", 2000));
const MAX = Number(val("--limit", 0));
const PHASES = val("--phases", "worklist,backup,merge,side,delete").split(",");
const BACKUP_DIR = val("--backup-dir", "/tmp/dedupe-www");

// Kept in sync with lib/markets.ts VISIBLE_MARKETS — the dashboard gate is `published AND
// country IN (…)`, so "customer-visible" means both halves of that, not published alone.
const VISIBLE_MARKETS = ["ZA","KE","NG","EG","MA","GH","TZ","UG","DZ","TN","CI","SN","MU","MZ",
  "CM","BW","AO","NA","RW","ZM","ET","ZW","LY","MW","SO","LS","SZ"];

/** How each table that keys on a domain is treated.
 *  move   — the row is real signal about the SHOP, so it should follow the shop to the bare domain.
 *           Moved only where the bare domain has no row for that key; otherwise the www copy is
 *           redundant and is dropped.
 *  delete — derived or re-derivable, so moving it would be work for nothing (and in two cases
 *           would be actively wrong):
 *           · store_dns  — a CNAME recorded for `www.shop.co.za` is not the bare domain's DNS.
 *             Re-deriving is free: DNS is rate-exempt and runs at 82-99/s.
 *           · churn_log  — 58,002 www churn records sit against a bare twin that is alive and
 *             published, i.e. the shop never died; the www hostname just stopped resolving. Those
 *             records are false, and half of all churn history is www rows, so deleting them makes
 *             the churn numbers more honest rather than less complete.
 *  imported_stores_tech is a VIEW over imported_stores and needs nothing. */
const SIDE_TABLES = [
  { table: "store_work", col: "domain", action: "delete" },
  { table: "store_dns", col: "domain", action: "delete" },
  { table: "store_priority", col: "domain", action: "delete" },
  { table: "churn_log", col: "domain", action: "delete" },
  { table: "store_not_trading", col: "domain", action: "delete" },
  { table: "store_catalog_fp", col: "domain", action: "delete" },
  { table: "store_fingerprints", col: "domain", action: "delete" },
  { table: "probe_checked", col: "domain", action: "delete" },
  { table: "woo_candidates", col: "domain", action: "delete" },
  // Traffic rank is per-ORIGIN and `www.shop.co.za` is a different CrUX origin from the bare name —
  // but it is this shop's traffic either way, only ~15% of stores have a rank at all, and
  // revenue banding reads it. Worth moving.
  { table: "crux_ranks", col: "domain", action: "move", conflict: ["domain", "month", "cc"] },
  { table: "store_vendors", col: "domain", action: "move", conflict: ["domain", "vendor_key"] },
  // The Black Friday deals page reads these two. A dangling row would point the live page at a
  // store row that no longer exists.
  { table: "store_promos", col: "domain", action: "move", conflict: ["domain", "offer_key"] },
  { table: "store_promo_scan", col: "domain", action: "move", conflict: ["domain"] },
  { table: "store_group_members", col: "domain", action: "move", conflict: ["domain"] },
  { table: "store_tags", col: "domain", action: "move", conflict: ["domain", "tag"] },
  // Hand edits. Never recomputable — the whole point is that a human knew better.
  { table: "store_edits", col: "domain", action: "move", conflict: null },
  { table: "store_partners", col: "store_domain", action: "move", conflict: ["store_domain", "partner_id"] },
];

const sql = postgres(process.env.DATABASE_URL, {
  ssl: { rejectUnauthorized: false },
  max: 1,                       // one writer. See memory: the pooler jams at ~25 conns and this
  idle_timeout: 30,             // box shares it with the web app and whatever lanes are up.
  connect_timeout: 30,
});

const fmt = (n) => Number(n).toLocaleString();
let totals = { pairs: 0, merged: 0, countryRescued: 0, moved: 0, sideDeleted: 0, deleted: 0, backedUp: 0 };

/** The pair worklist is MATERIALISED to a file once, then every phase reads it back.
 *  The finding that forced this: the keyset scan costs ~3s per 1,000 pairs (the visible-only
 *  variant filters on UPPER(country), which no index covers, so it walks ~68 index entries per
 *  hit). Re-running it for each of the 4 phases and each of the 18 side tables meant 20 scans of
 *  the same 2.17M rows — 266s for 4,000 pairs, which extrapolates to about 37 hours. One scan,
 *  written to disk, turns that back into minutes. */
const WORKLIST = `${BACKUP_DIR}/worklist-${VISIBLE_ONLY ? "visible" : "all"}.tsv`;

async function buildWorklist() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const out = createWriteStream(WORKLIST);
  let cursor = "", n = 0;
  for (;;) {
    const rows = VISIBLE_ONLY
      ? await sql`
          SELECT w.domain AS www, b.domain AS bare FROM imported_stores w
          JOIN imported_stores b ON b.domain = substring(w.domain from 5)
          WHERE w.domain LIKE 'www.%' AND w.domain > ${cursor}
            AND w.published AND UPPER(w.country) = ANY(${VISIBLE_MARKETS})
          ORDER BY w.domain LIMIT ${BATCH}`
      : await sql`
          SELECT w.domain AS www, b.domain AS bare FROM imported_stores w
          JOIN imported_stores b ON b.domain = substring(w.domain from 5)
          WHERE w.domain LIKE 'www.%' AND w.domain > ${cursor}
          ORDER BY w.domain LIMIT ${BATCH}`;
    if (!rows.length) break;
    cursor = rows[rows.length - 1].www;
    for (const r of rows) out.write(`${r.www}\t${r.bare}\n`);
    n += rows.length;
    if (n % 100000 < BATCH) console.log(`  worklist ${fmt(n)}…`);
    if (MAX && n >= MAX) break;
  }
  await new Promise((res) => out.end(res));
  console.log(`WORKLIST ${fmt(n)} pairs -> ${WORKLIST}`);
  return n;
}

/** Read the materialised worklist back in batches. */
async function* pairs() {
  const { createReadStream, existsSync } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  if (!existsSync(WORKLIST)) throw new Error(`worklist missing — run with --phases worklist,… first`);
  const rl = createInterface({ input: createReadStream(WORKLIST), crlfDelay: Infinity });
  let buf = [];
  for await (const line of rl) {
    if (!line) continue;
    const [www, bare] = line.split("\t");
    buf.push({ www, bare });
    if (buf.length >= BATCH) { yield buf; buf = []; }
  }
  if (buf.length) yield buf;
}

async function columnsToMerge() {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'imported_stores' AND table_schema = 'public'
    ORDER BY ordinal_position`;
  // domain is the key; published and discovered_at get their own rules below.
  return rows.map((r) => r.column_name).filter((c) => !["domain", "published", "discovered_at"].includes(c));
}

async function phaseBackup() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const path = `${BACKUP_DIR}/www-rows-${VISIBLE_ONLY ? "visible" : "all"}-${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
  if (DRY) { console.log(`BACKUP   would stream every www row to ${path}`); return; }
  const out = createWriteStream(path);
  const gz = createGzip();
  const feed = new Readable({ objectMode: false, read() {} });
  const done = pipeline(feed, gz, out);
  for await (const batch of pairs()) {
    const doms = batch.map((r) => r.www);
    const full = await sql`SELECT * FROM imported_stores WHERE domain = ANY(${doms})`;
    for (const row of full) feed.push(JSON.stringify(row) + "\n");
    totals.backedUp += full.length;
    if (totals.backedUp % 50000 < BATCH) console.log(`  backed up ${fmt(totals.backedUp)}…`);
  }
  feed.push(null);
  await done;
  console.log(`BACKUP   ${fmt(totals.backedUp)} rows -> ${path}`);
}

async function phaseMerge() {
  const cols = await columnsToMerge();
  // Fill blanks only. `::text = ''` is how a blank is spelled for the text columns and is simply
  // false for numbers and timestamps, so one form covers all 153 of them.
  const sets = cols
    .map((c) => `"${c}" = CASE WHEN b."${c}" IS NULL OR b."${c}"::text = '' THEN w."${c}" ELSE b."${c}" END`)
    .concat([
      // OR'd — except when a PERSON unpublished the bare row (its latest store_edits 'published'
      // row says false). That is a decision, not a gap: on 2026-11-24 the OR put 12 Springbok
      // clones taken down on 11-20 straight back into the lead list, because their www twin was
      // still published. store_edits is tiny (hundreds of rows), so the subquery costs nothing.
      `published = b.published OR (w.published AND b.domain NOT IN (
         SELECT h.domain FROM (SELECT DISTINCT ON (domain) domain, new_value FROM store_edits
                                WHERE field = 'published' ORDER BY domain, edited_at DESC, id DESC) h
          WHERE h.new_value LIKE 'false%'))`,
      `discovered_at = LEAST(b.discovered_at, w.discovered_at)`,
    ])
    .join(", ");
  for await (const batch of pairs()) {
    totals.pairs += batch.length;
    if (DRY) continue;
    const bare = batch.map((r) => r.bare);
    const r = await sql.unsafe(
      `UPDATE imported_stores b SET ${sets}
       FROM imported_stores w
       WHERE w.domain = 'www.' || b.domain AND b.domain = ANY($1)`,
      [bare],
    );
    totals.merged += r.count ?? 0;

    // COUNTRY, the one field where filling blanks is not enough. 78,436 pairs disagree outright
    // (e.g. www.1701luxury.com said ZA while 1701luxury.com said US), and in 490 of them the www
    // row is the customer-visible one while the bare row's country is outside VISIBLE_MARKETS — so
    // keeping the bare value would quietly drop a store we are selling out of the base.
    //
    // This does NOT try to adjudicate country in general: both sides usually carry a strong source
    // (shopify_country vs shop_meta in 124 cases) and this script has no better evidence than the
    // lanes do. It only rescues the visibility-losing cases, and clears country_checked_at on those
    // so meta-identify/country-enrich re-derive the country from /meta.json, which is the actual
    // truth for it. ~490 rows is a queue the hourly lane absorbs; the full 78k would have been
    // ~20 days of country-enrich at 4k/day and would have crowded out everything else.
    const c = await sql`
      UPDATE imported_stores b
         SET country = w.country, country_source = w.country_source, country_checked_at = NULL
        FROM imported_stores w
       WHERE w.domain = 'www.' || b.domain AND b.domain = ANY(${bare})
         AND w.country IS NOT NULL AND b.country IS NOT NULL
         AND UPPER(w.country) <> UPPER(b.country)
         AND UPPER(w.country) = ANY(${VISIBLE_MARKETS})
         AND NOT (UPPER(b.country) = ANY(${VISIBLE_MARKETS}))`;
    totals.countryRescued += c.count ?? 0;
    if (totals.merged % 50000 < BATCH) console.log(`  merged ${fmt(totals.merged)}…`);
  }
  console.log(`MERGE    ${fmt(totals.merged)} bare rows had blanks filled from their www twin`);
  console.log(`MERGE    ${fmt(totals.countryRescued)} took the www country (bare was outside VISIBLE_MARKETS), queued for re-check`);
}

async function phaseSide() {
  // Back the side rows up BEFORE deleting them. The first run of this script only backed up
  // imported_stores, so 58,002 churn_log rows (and ~4.2M other side rows) were deleted with no
  // copy on disk — they cannot be recovered. Nothing here has a foreign key, so this file is the
  // only undo. One stream for every table, each line tagged with `_table`.
  let sideGz = null, sideDone = null;
  if (!DRY) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const sidePath = `${BACKUP_DIR}/side-rows-${VISIBLE_ONLY ? "visible" : "all"}-${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
    sideGz = createGzip();
    sideDone = pipeline(sideGz, createWriteStream(sidePath));
    console.log(`SIDE     backing every deleted side row up to ${sidePath}`);
  }
  for (const t of SIDE_TABLES) {
    let moved = 0, dropped = 0;
    for await (const batch of pairs()) {
      const doms = batch.map((r) => r.www);
      if (DRY) {
        const c = await sql.unsafe(`SELECT count(*)::int n FROM ${t.table} WHERE ${t.col} = ANY($1)`, [doms]);
        dropped += c[0].n;
        continue;
      }
      if (t.action === "move") {
        // Move only where the bare domain has no row for the same key; the rest are redundant
        // copies of data the shop already has.
        const where = t.conflict
          ? `AND NOT EXISTS (SELECT 1 FROM ${t.table} x2 WHERE ${t.conflict
              .map((k) => (k === t.col ? `x2.${k} = substring(x.${t.col} from 5)` : `x2.${k} IS NOT DISTINCT FROM x.${k}`))
              .join(" AND ")})`
          : "";
        const up = await sql.unsafe(
          `UPDATE ${t.table} x SET ${t.col} = substring(x.${t.col} from 5)
           WHERE x.${t.col} = ANY($1) ${where}`,
          [doms],
        );
        moved += up.count ?? 0;
      }
      // Snapshot what is about to go, then delete it.
      const doomed = await sql.unsafe(`SELECT * FROM ${t.table} WHERE ${t.col} = ANY($1)`, [doms]);
      for (const row of doomed) {
        if (!sideGz.write(JSON.stringify({ _table: t.table, ...row }) + "\n")) {
          await new Promise((r) => sideGz.once("drain", r));
        }
      }
      const del = await sql.unsafe(`DELETE FROM ${t.table} WHERE ${t.col} = ANY($1)`, [doms]);
      dropped += del.count ?? 0;
    }
    totals.moved += moved;
    totals.sideDeleted += dropped;
    console.log(`SIDE     ${t.table.padEnd(22)} moved=${fmt(moved).padStart(9)}  removed=${fmt(dropped).padStart(10)}  (${t.action})`);
  }
  if (sideGz) { sideGz.end(); await sideDone; }
}

async function phaseDelete() {
  for await (const batch of pairs()) {
    const doms = batch.map((r) => r.www);
    if (DRY) { totals.deleted += doms.length; continue; }
    // Re-assert the twin here rather than trusting the worklist: this is the irreversible step.
    const r = await sql`
      DELETE FROM imported_stores w
      WHERE w.domain = ANY(${doms})
        AND EXISTS (SELECT 1 FROM imported_stores b WHERE b.domain = substring(w.domain from 5))`;
    totals.deleted += r.count ?? 0;
    if (totals.deleted % 50000 < BATCH) console.log(`  deleted ${fmt(totals.deleted)}…`);
  }
  console.log(`DELETE   ${fmt(totals.deleted)} www rows removed`);
}

const t0 = Date.now();
console.log(`dedupe-www  ${DRY ? "DRY RUN" : "LIVE"}  scope=${VISIBLE_ONLY ? "customer-visible only" : "every pair"}  batch=${BATCH}${MAX ? `  limit=${MAX}` : ""}`);
for (const p of PHASES) {
  if (p === "worklist") await buildWorklist();
  else if (p === "backup") await phaseBackup();
  else if (p === "merge") await phaseMerge();
  else if (p === "side") await phaseSide();
  else if (p === "delete") await phaseDelete();
  else throw new Error(`unknown phase: ${p}`);
}
console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)}s`, totals);
await sql.end();

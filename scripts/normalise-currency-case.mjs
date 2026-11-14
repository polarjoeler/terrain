/** One-off: normalise imported_stores.currency (and lead_overrides.currency) to the canonical
 *  ISO 4217 upper-case form, then lock in the invariant with a CHECK constraint.
 *
 *  WHY. The column was written by four lanes that each passed the vendor's casing straight through,
 *  so the same code was stored twice. Measured 2026-11-13 over 2,115,135 non-null rows:
 *
 *      lower-case   2,083,792      StoreCensus import (2.02M), plus every row it gap-filled
 *      upper-case      31,341      StoreLeads import (15.4k), the Sheet/VPS lane (15.8k)
 *      89 codes held in BOTH cases — usd/USD, eur/EUR, zar/ZAR …
 *
 *  ZAR was the worst split because its two lanes disagree: `currency = 'ZAR'` matched 15,764 South
 *  African stores and `currency = 'zar'` the other 7,761. Nothing was visibly broken — every SQL
 *  reader happened to wrap the column in upper() and every FX lookup .toUpperCase()s — but the next
 *  plain `WHERE currency = 'ZAR'` would have dropped a third of the market out of a customer-facing
 *  count, and two display sites (lib/digest.ts's money(), the admin drawer) already printed the raw
 *  code, so a lower-case row rendered "zar 45,000" instead of "R45,000".
 *
 *  Upper-case is canonical: ISO 4217 is, lib/fx.ts's FX and CCY_BY_COUNTRY tables are keyed that way
 *  (a lower-case code missing that table is the ~18.5x revenue bug in fx.ts's header), and `country`
 *  and `shop_currency` are already stored upper-case. It is the expensive direction — 2.08M rows
 *  rewritten against 31k the other way — but lower-case canonical would make the trap WORSE: the
 *  ISO code a developer actually types would then match nothing at all.
 *
 *  HOW, given the lock history. An unguarded statement against this table cost 10h of discovery
 *  once (see postgres-schema-check-lock). So:
 *    · batches walk the PRIMARY KEY, forward, with a cursor — not `WHERE currency <> upper(currency)
 *      LIMIT n` in a loop, which has no index to use and would re-seq-scan 3.2 GB per batch;
 *    · every statement runs inside a transaction with `SET LOCAL lock_timeout`, so it yields to the
 *      probes instead of queueing ahead of them (plain SET does not stick on the :6543 pooler);
 *    · lock_timeout / statement_timeout / deadlock are retried with backoff, never swallowed;
 *    · rows that already hold the canonical value are skipped by `IS DISTINCT FROM`, so no row is
 *      rewritten for nothing;
 *    · the CHECK constraint is added NOT VALID (brief lock, no scan) and then VALIDATEd, which takes
 *      only SHARE UPDATE EXCLUSIVE and does not block reads or writes.
 *
 *  It is resumable: the cursor is printed on every progress line and on failure.
 *
 *  Run:
 *    node --env-file=.env.local scripts/normalise-currency-case.mjs                  # dry run, reports
 *    node --env-file=.env.local scripts/normalise-currency-case.mjs --apply
 *    node --env-file=.env.local scripts/normalise-currency-case.mjs --apply --max-batches 5
 *    node --env-file=.env.local scripts/normalise-currency-case.mjs --apply --resume-from <domain>
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const PAGE = Number(arg("--page-size", 5000));
const SLEEP_MS = Number(arg("--sleep-ms", 100));
const MAX_BATCHES = Number(arg("--max-batches", 0)) || Infinity;
const RESUME = arg("--resume-from", "");
const SKIP_CONSTRAINT = process.argv.includes("--skip-constraint");
const LOCK_TIMEOUT = arg("--lock-timeout", "3s");
const STMT_TIMEOUT = arg("--statement-timeout", "60s");

// The canonical form, in SQL. Mirrors normalizeCcy() in lib/fx.ts: trim, upper-case, and anything
// that still isn't three letters is not a currency at all (the import carried "$", "id",
// "hantam88", "ريال سعودي") so it becomes NULL rather than a code nothing can price.
const CANON = "CASE WHEN upper(btrim(currency)) ~ '^[A-Z]{3}$' THEN upper(btrim(currency)) ELSE NULL END";

const RETRYABLE = new Set([
  "55P03", // lock_not_available — lock_timeout fired; a probe holds the row/table lock
  "57014", // query_canceled — statement_timeout fired (does not persist on the pooler; see memory)
  "40P01", // deadlock_detected
  "40001", // serialization_failure
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v).toLocaleString();

/** Run `fn` inside a transaction that yields rather than queues, retrying lock/timeout failures. */
async function guarded(sql, label, fn, tries = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '${STMT_TIMEOUT}'`);
        return await fn(tx);
      });
    } catch (e) {
      if (!RETRYABLE.has(e.code) || attempt >= tries) throw e;
      const back = Math.min(30000, 500 * 2 ** (attempt - 1));
      console.warn(`  ! ${label}: ${e.code} on attempt ${attempt}/${tries} — retrying in ${back}ms`);
      await sleep(back);
    }
  }
}

async function report(sql) {
  const [row] = await sql.unsafe(`
    SELECT count(*) FILTER (WHERE currency IS NOT NULL)                                      AS non_null,
           count(*) FILTER (WHERE currency IS NOT NULL AND currency IS DISTINCT FROM (${CANON})) AS needs_fix,
           count(*) FILTER (WHERE currency IS NOT NULL AND upper(btrim(currency)) !~ '^[A-Z]{3}$') AS junk
      FROM imported_stores`);
  console.log(`  imported_stores: ${n(row.non_null)} non-null currency · ${n(row.needs_fix)} need rewriting · ${n(row.junk)} not a currency code (→ NULL)`);
  const [lo] = await sql`SELECT count(*) FILTER (WHERE currency IS NOT NULL) AS non_null,
           count(*) FILTER (WHERE currency IS NOT NULL AND currency <> upper(btrim(currency))) AS needs_fix
      FROM lead_overrides`;
  console.log(`  lead_overrides:  ${n(lo.non_null)} non-null currency · ${n(lo.needs_fix)} need rewriting`);
  return Number(row.needs_fix);
}

/** Does this CHECK constraint already exist, and is it validated? */
async function constraintState(sql, table, name) {
  const rows = await sql`SELECT convalidated FROM pg_constraint
     WHERE conrelid = ${table}::regclass AND conname = ${name}`;
  return rows.length ? (rows[0].convalidated ? "valid" : "not_valid") : "absent";
}

async function addConstraint(sql, table, name) {
  const state = await constraintState(sql, table, name);
  if (state === "valid") { console.log(`  ${table}.${name}: already present and validated`); return; }

  if (state === "absent") {
    // NOT VALID takes ACCESS EXCLUSIVE but does NOT scan the table, so it is a sub-millisecond
    // hold — the danger is only ever QUEUEING for it, which lock_timeout caps.
    await guarded(sql, `${name} ADD NOT VALID`, (tx) =>
      tx.unsafe(`ALTER TABLE ${table}
         ADD CONSTRAINT ${name} CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$') NOT VALID`));
    console.log(`  ${table}.${name}: added NOT VALID (enforced on every write from now on)`);
  } else {
    console.log(`  ${table}.${name}: present but NOT VALID — validating`);
  }

  // VALIDATE scans the table under SHARE UPDATE EXCLUSIVE: concurrent reads AND writes continue.
  // It can take minutes on imported_stores, hence its own, longer statement_timeout.
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '30min'`);
        await tx.unsafe(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
      });
      console.log(`  ${table}.${name}: VALIDATED — the invariant is now enforced for existing rows too`);
      return;
    } catch (e) {
      if (e.code === "23514") {
        console.error(`  ! ${table}.${name}: validation FAILED — rows still violate it. ` +
          `Re-run the normalising pass (without --skip-constraint) before validating.`);
        throw e;
      }
      if (!RETRYABLE.has(e.code) || attempt >= 6) throw e;
      const back = Math.min(30000, 500 * 2 ** (attempt - 1));
      console.warn(`  ! VALIDATE ${name}: ${e.code} on attempt ${attempt}/6 — retrying in ${back}ms`);
      await sleep(back);
    }
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, idle_timeout: 20, onnotice: () => {} });
  try {
    console.log(`=== currency case normalisation (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
    console.log(`  canonical form: ISO 4217 upper-case · page=${n(PAGE)} · sleep=${SLEEP_MS}ms · lock_timeout=${LOCK_TIMEOUT}`);
    console.log("\nbefore:");
    const pending = await report(sql);

    if (!APPLY) {
      const [t] = await sql`SELECT reltuples::bigint est FROM pg_class WHERE relname = 'imported_stores'`;
      const batches = Math.ceil(Number(t.est) / PAGE);
      console.log(`\n  a full pass walks ~${n(batches)} primary-key pages of ${n(PAGE)} ` +
        `(~${n(Math.round(batches * SLEEP_MS / 1000))}s of pacing alone) and rewrites ${n(pending)} rows.`);
      console.log("  DRY RUN — nothing written. Re-run with --apply.");
      return;
    }

    // ---- the batched pass -------------------------------------------------------------------
    // Walk the primary key forward. Each batch does one index-only scan to find the page's upper
    // bound, then one bounded UPDATE over that key range. Both are small, so neither can sit on a
    // lock long enough to matter to the probes writing alongside us.
    let cursor = RESUME || "";
    let fixed = 0, batches = 0, touchedPages = 0;
    const t0 = Date.now();
    if (RESUME) console.log(`\nresuming after domain ${JSON.stringify(RESUME)}`);
    console.log("\nnormalising:");

    for (;;) {
      if (batches >= MAX_BATCHES) { console.log(`  stopping: --max-batches ${MAX_BATCHES} reached`); break; }

      const pageEnd = await guarded(sql, "page bound", async (tx) => {
        const [r] = await tx.unsafe(
          `SELECT max(domain) AS page_end FROM (
             SELECT domain FROM imported_stores WHERE domain > $1 ORDER BY domain LIMIT ${PAGE}
           ) t`, [cursor]);
        return r?.page_end ?? null;
      });
      if (!pageEnd) { console.log("  reached the end of the table"); break; }

      const res = await guarded(sql, `update ${cursor}..${pageEnd}`, (tx) =>
        tx.unsafe(`UPDATE imported_stores
             SET currency = (${CANON})
           WHERE domain > $1 AND domain <= $2
             AND currency IS NOT NULL
             AND currency IS DISTINCT FROM (${CANON})`, [cursor, pageEnd]));

      const rows = res.count ?? 0;
      fixed += rows;
      batches++;
      if (rows) touchedPages++;
      cursor = pageEnd;

      if (batches % 25 === 0 || rows) {
        const secs = Math.round((Date.now() - t0) / 1000);
        console.log(`  batch ${n(batches)} · +${n(rows)} · ${n(fixed)} rewritten · ${secs}s · cursor=${cursor}`);
      }
      if (SLEEP_MS) await sleep(SLEEP_MS);
    }

    console.log(`\n  rewrote ${n(fixed)} rows across ${n(batches)} pages (${n(touchedPages)} pages had work) in ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`  last cursor: ${JSON.stringify(cursor)}  (pass --resume-from that value to continue)`);

    // lead_overrides is small enough for one statement.
    const lo = await guarded(sql, "lead_overrides", (tx) =>
      tx.unsafe(`UPDATE lead_overrides SET currency = (${CANON})
                  WHERE currency IS NOT NULL AND currency IS DISTINCT FROM (${CANON})`));
    console.log(`  lead_overrides: rewrote ${n(lo.count ?? 0)} rows`);

    console.log("\nafter:");
    const left = await report(sql);

    // ---- the guard --------------------------------------------------------------------------
    if (SKIP_CONSTRAINT) {
      console.log("\n  --skip-constraint: CHECK constraints not touched.");
    } else if (left > 0 || batches >= MAX_BATCHES) {
      console.log(`\n  ${n(left)} rows still need rewriting (partial pass) — NOT adding the CHECK ` +
        `constraint yet. Finish the pass first, then re-run.`);
    } else {
      console.log("\nconstraints:");
      await addConstraint(sql, "imported_stores", "imported_stores_currency_iso");
      await addConstraint(sql, "lead_overrides", "lead_overrides_currency_iso");
      console.log("\n  Done. A non-canonical write now fails loudly instead of splitting the column again.");
      console.log("  Follow-up: the pass left ~2M dead tuples behind — let autovacuum catch up, or");
      console.log("  run VACUUM (ANALYZE) imported_stores off-peak to reclaim them and refresh stats.");
    }
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });

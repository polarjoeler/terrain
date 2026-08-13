#!/usr/bin/env node
/** Exercise lib/schema.sql and the subscriber queries against a real Postgres
 *  engine (PGlite = Postgres compiled to WASM), so the SQL is verified without
 *  needing a database server.
 *
 *    node scripts/test-schema.mjs
 */

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

const ddl = readFileSync(new URL("../lib/schema.sql", import.meta.url), "utf8");
const tableNames = async () => {
  const r = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
};

await db.exec(ddl);
let tables = await tableNames();
check("schema applies", tables.join(",") === "subscribers,used_tokens", tables.join(","));

await db.exec(ddl); // must not throw on a populated database
tables = await tableNames();
check("schema is idempotent (re-applied)", tables.length === 2);

// --- insert a trialing subscriber -------------------------------------------
const now = new Date().toISOString();
const trialEnd = new Date(Date.now() + 14 * 864e5).toISOString();
await db.query(
  `INSERT INTO subscribers (email, plan, status, trial_ends_at, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  ["joel@tembo.test", "starter", "trialing", trialEnd, now, now],
);
let r = await db.query(`SELECT * FROM subscribers WHERE email=$1`, ["joel@tembo.test"]);
check("insert + select", r.rows.length === 1 && r.rows[0].status === "trialing");

// --- upsert: convert to active, preserving codes via COALESCE ----------------
await db.query(
  `INSERT INTO subscribers (email, plan, status, trial_ends_at, customer_code,
     subscription_code, email_token, next_payment_date, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
   ON CONFLICT (email) DO UPDATE SET
     plan=EXCLUDED.plan, status=EXCLUDED.status,
     customer_code=COALESCE(EXCLUDED.customer_code, subscribers.customer_code),
     subscription_code=COALESCE(EXCLUDED.subscription_code, subscribers.subscription_code),
     email_token=COALESCE(EXCLUDED.email_token, subscribers.email_token),
     next_payment_date=EXCLUDED.next_payment_date, updated_at=EXCLUDED.updated_at`,
  ["joel@tembo.test", "pro", "active", trialEnd, "CUS_1", "SUB_1", "tok_1",
   new Date(Date.now() + 30 * 864e5).toISOString(), now, new Date().toISOString()],
);
r = await db.query(`SELECT * FROM subscribers WHERE email=$1`, ["joel@tembo.test"]);
check("upsert converts trial -> active", r.rows[0].status === "active" && r.rows[0].plan === "pro");
check("upsert stores paystack codes", r.rows[0].subscription_code === "SUB_1");

// a later webhook without codes must not wipe them
await db.query(
  `INSERT INTO subscribers (email, plan, status, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (email) DO UPDATE SET
     status=EXCLUDED.status,
     customer_code=COALESCE(EXCLUDED.customer_code, subscribers.customer_code),
     subscription_code=COALESCE(EXCLUDED.subscription_code, subscribers.subscription_code),
     updated_at=EXCLUDED.updated_at`,
  ["joel@tembo.test", "pro", "past_due", now, new Date().toISOString()],
);
r = await db.query(`SELECT * FROM subscribers WHERE email=$1`, ["joel@tembo.test"]);
check("codes survive a partial update", r.rows[0].subscription_code === "SUB_1", `status=${r.rows[0].status}`);

// only one row per email
r = await db.query(`SELECT count(*)::int AS n FROM subscribers`);
check("no duplicate rows", r.rows[0].n === 1);

// --- single-use tokens -------------------------------------------------------
const soon = new Date(Date.now() + 60_000).toISOString();
await db.query(`INSERT INTO used_tokens (jti, expires_at) VALUES ($1,$2)`, ["jti_a", soon]);
r = await db.query(`SELECT 1 FROM used_tokens WHERE jti=$1`, ["jti_a"]);
check("token recorded", r.rows.length === 1);

await db.query(
  `INSERT INTO used_tokens (jti, expires_at) VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING`,
  ["jti_a", soon],
);
r = await db.query(`SELECT count(*)::int AS n FROM used_tokens`);
check("replaying a token does not error or duplicate", r.rows[0].n === 1);

// expired tokens are pruned
await db.query(`INSERT INTO used_tokens (jti, expires_at) VALUES ($1,$2)`,
  ["jti_old", new Date(Date.now() - 60_000).toISOString()]);
await db.query(`DELETE FROM used_tokens WHERE expires_at < now()`);
r = await db.query(`SELECT jti FROM used_tokens`);
check("expired tokens pruned, live one kept",
  r.rows.length === 1 && r.rows[0].jti === "jti_a");

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);

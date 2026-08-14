#!/usr/bin/env node
/** Grant an email full access without going through Stripe (owner/comp accounts).
 *
 *   node scripts/grant-access.mjs you@example.com [pro|starter]
 *
 * Reads DATABASE_URL from .env.local, upserts the subscriber as active.
 */

import { readFileSync } from "node:fs";
import postgres from "postgres";

const email = (process.argv[2] || "").trim().toLowerCase();
const plan = process.argv[3] === "starter" ? "starter" : "pro";
if (!email) {
  console.error("usage: node scripts/grant-access.mjs you@example.com [pro|starter]");
  process.exit(1);
}

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "");
if (!url) { console.error("no DATABASE_URL in .env.local"); process.exit(1); }

const sql = postgres(url, { prepare: false, ssl: "require", max: 1 });
const now = new Date().toISOString();
await sql`
  INSERT INTO subscribers (email, plan, status, created_at, updated_at)
  VALUES (${email}, ${plan}, 'active', ${now}, ${now})
  ON CONFLICT (email) DO UPDATE SET status='active', plan=${plan}, updated_at=${now}
`;
console.log(`✓ ${email} granted active '${plan}' access`);
await sql.end();

#!/usr/bin/env node
/** Machine heartbeat (Node side, for Chad's storepulse jobs — Lucy uses worker/heartbeat.py).
 *  `node --env-file=.env.local scripts/heartbeat.mjs <task> [note]` — records that THIS machine ran
 *  <task> just now into agent_heartbeat, so /ops shows real per-machine activity. Best-effort. */
import { hostname } from "node:os";
import postgres from "postgres";

const task = process.argv[2] || "unknown";
const note = process.argv[3] || "";
const machine = hostname().split(".")[0].toLowerCase();

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
try {
  await sql`CREATE TABLE IF NOT EXISTS agent_heartbeat (
    machine TEXT, task TEXT, last_run TIMESTAMPTZ NOT NULL DEFAULT now(), note TEXT,
    PRIMARY KEY (machine, task))`;
  await sql`INSERT INTO agent_heartbeat (machine, task, last_run, note)
    VALUES (${machine}, ${task}, now(), ${note})
    ON CONFLICT (machine, task) DO UPDATE SET last_run = now(), note = ${note}`;
} catch (e) {
  console.error("heartbeat skipped:", e.message);
} finally {
  await sql.end();
}

#!/usr/bin/env node
/**
 * Market-wide fraud sweep — proactive, no enrolled brand needed.
 *
 * Every store is fingerprinted, so stores that SHARE a catalogue (same product
 * images) surface by the collision itself. But sharing a catalogue is normally
 * ORDINARY RETAIL — a distributor and its stockists, a brand and its resellers.
 * So a catalogue link alone is not reported: the sweep scores two independent
 * axes (overlap weighted by how rare the shared products are, and impersonation
 * evidence) and reports only pairs that are high on both. Everything else is
 * recorded in radar_relationships with the reason, for review.
 *
 * The implementation is shared with the admin "Run sweep" button — see
 * lib/radar/fraud-sweep-core.mjs and lib/radar/clone-score.mjs. Do not fork it
 * here; the two copies had already drifted once.
 *
 *   node --env-file=.env.local scripts/radar-fraud-sweep.mjs          # report
 *   node --env-file=.env.local scripts/radar-fraud-sweep.mjs --write  # persist
 */

import postgres from "postgres";
import { sweep } from "../lib/radar/fraud-sweep-core.mjs";

const WRITE = process.argv.includes("--write");

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    const r = await sweep(sql, { write: WRITE });

    console.log(`Scanned ${r.scanned.toLocaleString()} fingerprinted stores → ${r.clusters.toLocaleString()} catalogue clusters.`);
    console.log(`${r.relationships.toLocaleString()} store pairs share a catalogue.\n`);

    const bys = Object.entries(r).filter(([k]) => k.startsWith("suppressed_"));
    if (bys.length) {
      console.log(`Not reported (${r.suppressed.toLocaleString()} pairs — catalogue sharing that isn't impersonation):`);
      for (const [k, v] of bys.sort((a, b) => b[1] - a[1]))
        console.log(`  ${String(v).padStart(5)}  ${k.replace("suppressed_", "")}`);
      console.log("");
    }

    if (!WRITE) {
      console.log(`Would report ${r.detectionList.length.toLocaleString()} impersonation detections (dry run — pass --write to persist):`);
      for (const d of r.detectionList.sort((a, b) => b.score - a.score).slice(0, 20)) {
        console.log(`  ${d.verdict.padEnd(7)} ${String(d.score).padStart(3)}  (overlap ${d.overlap} · impersonation ${d.imp})  ${d.victim} ← ${d.suspect}`);
        for (const why of d.reasons) console.log(`             · ${why}`);
      }
    } else {
      console.log(`Wrote ${r.written} detections (${r.newDetections} new, ${r.retired} retired) and ${r.suppressed} relationships.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

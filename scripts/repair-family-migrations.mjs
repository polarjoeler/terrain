#!/usr/bin/env node
/** repair-family-migrations — undo "moves" that never left the stack.
 *
 *  WooCommerce, SureCart and WP eCommerce are WordPress PLUGINS (see lib/platform-canon.ts).
 *  verify-liveness detects a destination from homepage markers and tests Woo's before WordPress's,
 *  so a Woo store that defers its assets — or is showing an under-construction page — reads as
 *  "WordPress". Until the family guard landed, that counted as a migration.
 *
 *  Two shapes to repair, both written permanently into the table:
 *
 *   A · HEALED rows. scripts/backfill-migrations.mjs stamped migrated_from/migrated_at on every
 *     live_platform discrepancy, same-family included. Those rows now carry a recorded move and
 *     show up in the ?replatformed= lead filter as a store that "left WooCommerce for WordPress".
 *     Repair = clear migrated_from/migrated_at and restore `platform` to where the store actually
 *     is, which for a same-family row is the more specific of the two labels (WooCommerce over
 *     WordPress: the plugin is the fact, "WordPress" is just what the homepage happened to show).
 *
 *   B · A stuck terminal verdict with NOTHING to compare against. A non-Shopify store flagged
 *     live_status='migrated' with live_platform NULL — the Shopify-only probe gave up without
 *     recording what it saw, so there is no evidence of a move at all. repair-false-migrations.mjs
 *     matches structurally on platform = live_platform and cannot see these. Repair = clear the
 *     verdict (NOT assert 'active': we never established it was alive, only that we never
 *     established it wasn't) so the fixed probe re-queues it.
 *
 *  Dry run by default.
 *
 *    node --env-file=.env.local scripts/repair-family-migrations.mjs
 *    node --env-file=.env.local scripts/repair-family-migrations.mjs --write
 */
import postgres from "postgres";
import { WORDPRESS_FAMILY, platformFamily } from "../lib/platform-canon.ts";

const WRITE = process.argv.includes("--write");
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });

/** Within a family, the label that says the most. A store running the Woo plugin IS a Woo store;
 *  "WordPress" is the weaker observation, not a different destination. */
const SPECIFICITY = ["wp-ecommerce", "wpecommerce", "wp ecommerce", "surecart", "woocommerce"];
const moreSpecific = (a, b) => {
  const ia = SPECIFICITY.indexOf((a ?? "").toLowerCase());
  const ib = SPECIFICITY.indexOf((b ?? "").toLowerCase());
  return ib > ia ? b : a;
};

try {
  // ── A · healed same-family rows ───────────────────────────────────────────────────────────────
  const healed = await sql`SELECT domain, platform, migrated_from, country, published
    FROM imported_stores
    WHERE migrated_from IS NOT NULL
      AND lower(migrated_from) = ANY(${WORDPRESS_FAMILY})
      AND lower(COALESCE(platform,'')) = ANY(${WORDPRESS_FAMILY})`;
  const sameFam = healed.filter((r) => platformFamily(r.migrated_from) === platformFamily(r.platform));
  console.log(`A · healed rows recorded as a same-family move : ${sameFam.length}`);
  const byPair = {};
  for (const r of sameFam) {
    const k = `${r.migrated_from} -> ${r.platform}`;
    byPair[k] = (byPair[k] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(32)} ${n}`);
  const vis = sameFam.filter((r) => r.published).length;
  console.log(`    of which published: ${vis}`);

  // ── B · stuck terminal verdict with no evidence ───────────────────────────────────────────────
  const stuck = await sql`SELECT domain, platform, country, published FROM imported_stores
    WHERE live_status = 'migrated' AND live_platform IS NULL
      AND platform IS NOT NULL AND lower(platform) <> 'shopify'`;
  console.log(`\nB · non-Shopify rows flagged migrated with no live_platform at all : ${stuck.length}`);
  for (const r of stuck.slice(0, 10)) console.log(`    ${r.domain} (${r.platform}, ${r.country})`);

  if (!WRITE) {
    console.log("\nDry run — nothing written. Re-run with --write to repair.");
  } else {
    let a = 0;
    for (const r of sameFam) {
      const keep = moreSpecific(r.migrated_from, r.platform);
      const res = await sql`UPDATE imported_stores
        SET platform = ${keep}, migrated_from = NULL, migrated_at = NULL
        WHERE domain = ${r.domain} AND migrated_from IS NOT NULL`;
      a += res.count;
    }
    // The churn row claims the store left a platform it never left.
    const ch = await sql`DELETE FROM churn_log cl
      USING imported_stores i
      WHERE cl.domain = i.domain AND cl.status = 'migrated'
        AND i.migrated_from IS NULL AND lower(COALESCE(i.platform,'')) = ANY(${WORDPRESS_FAMILY})
        AND lower(COALESCE(cl.migrated_to,'')) = ANY(${WORDPRESS_FAMILY})`;
    const b = await sql`UPDATE imported_stores
      SET live_status = NULL, live_checked_at = NULL
      WHERE live_status = 'migrated' AND live_platform IS NULL
        AND platform IS NOT NULL AND lower(platform) <> 'shopify'`;
    console.log(`\nA · same-family moves cleared   : ${a}`);
    console.log(`    same-family churn rows removed: ${ch.count}`);
    console.log(`B · stuck verdicts re-queued    : ${b.count}`);
  }
} finally {
  await sql.end();
}

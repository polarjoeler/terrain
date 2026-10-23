/** harvest-plan-exact — backfill `plan_exact` from checkout pages we ALREADY banked.
 *
 *  The probe now harvests the leaked literal plan live (checkout_probe.py::_plan_exact), but
 *  pages banked before that only kept 1,200 chars of `raw` — except for ~2.6k records that
 *  stored a full page, which is where the leak is visible. This scans those and seeds the
 *  ground-truth set rather than waiting for a re-probe.
 *
 *  Mirrors checkout_probe.py::_plan_exact — keep the two in step if either changes.
 *
 *    node --env-file=.env.local scripts/harvest-plan-exact.mjs [cache ...] [--write]
 *  Defaults to a dry run.
 */
import postgres from "postgres";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { glob } from "node:fs/promises";

const WRITE = process.argv.includes("--write");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const STRONG = new Set(["shop_shopify_plan", "shopify_plan", "plan_display_name"]);
const MAP = {
  basic: "basic", "basic shopify": "basic", basic_shopify: "basic",
  professional: "grow", grow: "grow", shopify: "grow",
  unlimited: "advanced", advanced: "advanced", "advanced shopify": "advanced",
  plus: "plus", "shopify plus": "plus", shopify_plus: "plus", enterprise: "plus",
  starter: "starter", shopify_starter: "starter", npo_lite: "starter",
  trial: "trial", affiliate: "dev", partner_test: "dev", dev: "dev",
  staff: "staff", staff_business: "staff",
  cancelled: "cancelled", frozen: "frozen", fraudulent: "frozen", paused: "paused",
};
const AMBIGUOUS = new Set(["basic", "advanced", "starter", "shopify", "trial", "dev", "plus"]);
const KEY = /(shop_shopify_plan|shopify_plan|plan_display_name|plan_name)\\?"?\s*:\s*\\?"([A-Za-z0-9 _-]{3,30})\\?"/gi;
const MARKER = /myshopify\.com|shopify_charge_id|shop_id/i;

function planExact(page) {
  KEY.lastIndex = 0;
  for (let m; (m = KEY.exec(page)); ) {
    const key = m[1].toLowerCase(), raw = m[2].trim().toLowerCase(), tier = MAP[raw];
    if (!tier) continue;
    if (STRONG.has(key) || !AMBIGUOUS.has(raw)) return tier;
    if (MARKER.test(page.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400))) return tier;
  }
  return null;
}

const DOMAIN_LINE = /^ {2}"([^"]+)": \{/;
const found = new Map();
const caches = args.length ? args
  : (await Array.fromAsync(glob(join(homedir(), "shopify-radar", "checkout_cache.json*"))))
      .filter((f) => !f.includes(".corrupt")).sort();

for (const file of caches) {
  if (!existsSync(file)) { console.warn(`skip (missing): ${file}`); continue; }
  let domain = null;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const m = DOMAIN_LINE.exec(line);
    if (m) { domain = m[1]; continue; }
    // only full-page records can carry the leak; short lines are the truncated `raw`
    if (domain && line.length > 6000) {
      const tier = planExact(line);
      if (tier && !found.has(domain)) found.set(domain, tier);
      domain = null;
    }
  }
}
console.log(`scanned ${caches.length} cache file(s) — ${found.size} store(s) leak an exact plan`);
const byTier = {};
for (const t of found.values()) byTier[t] = (byTier[t] || 0) + 1;
console.table(byTier);
for (const [d, t] of [...found].sort()) console.log(`  ${d.padEnd(44)} ${t}`);

if (!WRITE) { console.log("\nDRY RUN — nothing written. Re-run with --write."); process.exit(0); }

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
try {
  await sql`SET lock_timeout = '4s'`;
  await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plan_exact TEXT`;
  let n = 0;
  // one statement per store (13-ish rows); the www/apex pair is matched like the payment sync
  for (const [d, tier] of found) {
    const bare = d.replace(/^www\./, "");
    const r = await sql`
      UPDATE imported_stores SET plan_exact = ${tier}
      WHERE domain = ANY(${[bare, `www.${bare}`]}::text[]) AND published
        AND COALESCE(plan_exact, '') = ''`;
    n += r.count;
  }
  console.log(`\nwrote plan_exact on ${n} row(s).`);
} finally { await sql.end(); }

#!/usr/bin/env node
/**
 * completeness — the systemic profile-completion coordinator.
 *
 * Per-STORE completeness, not per-field patchwork. A store is COMPLETE when every profile field is
 * RESOLVED — either FILLED (we have the value) or CHECKED-EMPTY (we looked and there's genuinely
 * nothing to get, e.g. a store with no shipping). The *_checked_at timestamps are that "we looked"
 * marker, so 100% is actually reachable: drive "unchecked → checked", not "empty → filled".
 *
 *   node --env-file=.env.local scripts/completeness.mjs [--country ZA]            # scorecard
 *   node --env-file=.env.local scripts/completeness.mjs --run --country ZA [--limit 5000]
 *
 * Two numbers per market: FILLED% (data richness) and COMPLETE% (resolved = filled OR checked-empty).
 * Payments/shipping come from the checkout_probe job; the coordinator drives the OWN-DOMAIN lanes
 * (deep-enrich→theme/apps/desc, hosting-enrich→hosting, contact-enrich→contact).
 */
import postgres from "postgres";
import { spawn } from "node:child_process";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RUN = process.argv.includes("--run");
const AUTO = process.argv.includes("--auto"); // ZA-first auto-advance: work the first market below 97% complete
const LIMIT = Number(arg("--limit", "5000"));
const FOCUS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const cArg = arg("--country", null);
const markets = cArg ? cArg.toUpperCase().split(",").map((s) => s.trim()) : FOCUS;

const HOSTED = "'shopify','wix','squarespace','bigcommerce','base','colorme','makeshop','cafe24','ec-cube','futureshop','ecwid','shopstar','shoplazza','shopline','bumpa','selar','catlog','salesforce commerce cloud'";

// Each field: `filled` (we have the value) and `check` (we looked — the *_checked_at marker).
// resolved = filled OR check. complete = all fields resolved.
const FIELDS = {
  payments:    { filled: "coalesce(payments,'') <> ''",            check: "payments_checked_at IS NOT NULL" },
  shipping:    { filled: "coalesce(shipping_providers,'') <> ''",  check: "payments_checked_at IS NOT NULL" }, // same checkout probe reads both
  theme:       { filled: "coalesce(theme,'') <> ''",               check: "deep_enriched_at IS NOT NULL" },
  // "apps" = the normalised tech stack, NOT the raw apps column. apps is Shopify-App-Store-only
  // (0% on non-Shopify by definition); a non-Shopify store's stack lives in technologies+plugins.
  // Counting all three is the true coverage — see lib/tech-stack.ts (the UI reads the same union).
  apps:        { filled: "(coalesce(apps,'') <> '' OR coalesce(technologies,'') <> '' OR coalesce(plugins,'') <> '')", check: "deep_enriched_at IS NOT NULL" },
  // hosted CMSs are hosted BY the platform → no independent host → auto-resolved.
  hosting:     { filled: `(coalesce(hosting_provider,'') <> '' OR lower(platform) IN (${HOSTED}))`, check: "hosting_checked_at IS NOT NULL" },
  contact:     { filled: "(coalesce(contact_email,'') <> '' OR coalesce(email,'') <> '')", check: "contact_checked_at IS NOT NULL" },
  description: { filled: "coalesce(description,'') <> ''",          check: "ai_enriched_at IS NOT NULL" },
};
const resolvedSql = (f) => `((${FIELDS[f].filled}) OR (${FIELDS[f].check}))`;
const COMPLETE = Object.keys(FIELDS).map(resolvedSql).join(" AND ");

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
const REAL = "published AND coalesce(activity_tier,'') NOT IN ('not_a_store','dormant')";

async function score(cc) {
  const cols = [];
  for (const f of Object.keys(FIELDS)) {
    cols.push(`count(*) FILTER (WHERE ${FIELDS[f].filled})::int AS ${f}_filled`);
    cols.push(`count(*) FILTER (WHERE ${resolvedSql(f)})::int AS ${f}_res`);
  }
  const [r] = await sql.unsafe(
    `SELECT count(*)::int n, count(*) FILTER (WHERE ${COMPLETE})::int complete, ${cols.join(", ")}
     FROM imported_stores WHERE ${REAL} AND upper(country) = '${cc}'`);
  return r;
}

async function main() {
  console.log(`profile: ${Object.keys(FIELDS).join(" · ")}   (COMPLETE = all resolved: filled OR checked-empty)\n`);
  for (const cc of markets) {
    const r = await score(cc);
    if (!r || !r.n) continue;
    const pct = (v) => Math.round((v / r.n) * 100);
    console.log(`[${cc}] ${r.n.toLocaleString()} real · COMPLETE ${pct(r.complete)}% (${r.complete.toLocaleString()})`);
    console.log("     " + Object.keys(FIELDS).map((f) => `${f} ${pct(r[f + "_filled"])}/${pct(r[f + "_res"])}`).join(" · ") + "   (filled/resolved%)");
  }
  if (!RUN && !AUTO) { await sql.end(); return; }

  // Pick the target market. --auto: ZA → KE → NG → rest of Africa by store count → JP, taking the
  // FIRST market still below 97% complete (finish ZA, then roll on). --run: the --country given.
  let cc = (cArg || "ZA").toUpperCase();
  if (AUTO) {
    const counts = await sql.unsafe(`SELECT upper(country) c, count(*)::int n FROM imported_stores WHERE ${REAL} AND upper(country) IN (${FOCUS.map((c) => `'${c}'`).join(",")}) GROUP BY 1`);
    const byN = new Map(counts.map((r) => [r.c, r.n]));
    const PRIMARY = ["ZA", "KE", "NG"];
    const order = [...PRIMARY, ...FOCUS.filter((c) => !PRIMARY.includes(c)).sort((a, b) => (byN.get(b) || 0) - (byN.get(a) || 0))];
    cc = null;
    for (const m of order) {
      const r = await score(m);
      if (r && r.n >= 50 && r.complete / r.n < 0.97) { cc = m; break; }
    }
    if (!cc) { console.log("\n✓ all focus markets ≥97% complete — nothing to coordinate."); await sql.end(); return; }
    console.log(`\n── AUTO target (ZA-first): ${cc} ──`);
  }
  console.log(`── coordinating own-domain lanes for ${cc} (limit ${LIMIT}) — drives unchecked→checked ──`);
  await sql.end();
  // hosting-enrich moved to Lucy's dedicated DNS lane (com.tembo.hosting-enrich) — it's rate-exempt
  // there and no longer overlaps here, freeing this coordinator for the edge-bound own-domain lanes.
  // hosting still counts toward completeness; Lucy's lane fills it, we just don't run it from here.
  // contact-enrich runs ONLY from the standalone agents, never here: com.tembo.contact-enrich (Rex's
  // hostname rule routes a *Studio* host to the NON-Shopify lane — merchants' own servers, no shared
  // ceiling, 6000 @ conc 6) and com.tembo.contact-enrich-shopify (CONTACT_LANE=shopify, paced 1,200 @
  // conc 2 / 1200ms — the ONE lane on the shared home IP's Shopify-edge budget). Running contact from
  // this coordinator, unpaced at --limit 4000 every 4h (~24k/day), was the sole Shopify-edge hammer
  // that drove the lane to ~89% rate-limited while Shopify clamped the IP progressively; removing it
  // without a Shopify agent left that lane with no owner. contact still counts toward completeness.
  for (const [lane, script] of [["deep-enrich", "deep-enrich.mjs"]]) {
    console.log(`\n▶ ${lane} --country ${cc} --limit ${LIMIT}`);
    await new Promise((res) => spawn("node", ["--env-file=.env.local", `scripts/${script}`, "--country", cc, "--limit", String(LIMIT)], { stdio: "inherit" }).on("close", res));
  }
  const s2 = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  const [r] = await s2.unsafe(`SELECT count(*)::int n, count(*) FILTER (WHERE ${COMPLETE})::int complete FROM imported_stores WHERE ${REAL} AND upper(country)='${cc}'`);
  console.log(`\n[${cc}] COMPLETE now: ${Math.round((r.complete / r.n) * 100)}% (${r.complete.toLocaleString()}/${r.n.toLocaleString()})`);
  await s2.end();
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

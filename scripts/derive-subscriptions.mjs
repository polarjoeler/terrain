/**
 * Derive subscription_tools from enrichment data WE ALREADY HAVE — zero HTTP, no rate budget, all
 * platforms, instant. Complements detect-subscriptions.mjs (the HTTP probe): that reads live
 * signals but is rate-limited on the Shopify edge and blind to Store-API-disabled Woo stores; THIS
 * reads the apps / plugins / technologies / description fields the pipeline already captured, so it
 * catches Woo-subscription plugins (no Store API needed) and app installs we logged earlier.
 *
 *   node --env-file=.env.local scripts/derive-subscriptions.mjs [--country ZA,KE] [--dry]
 *
 * Writes the UNION of what it derives with any existing subscription_tools (never nulls a value the
 * HTTP probe already set). It does NOT stamp subscriptions_checked_at — the HTTP probe still owns
 * that cadence, so a store can later gain a live-verified tool on top of the derived one.
 */
import postgres from "postgres";

const DRY = process.argv.includes("--dry");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const cArg = arg("--country", null);
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const countries = cArg ? cArg.split(",").map((c) => c.trim().toUpperCase()) : MARKETS;

// Each rule: a tool NAME + a regex matched (case-insensitive) against a joined text blob of the
// store's apps + plugins + technologies. Ordered specific→generic; a store can match several.
// Tuned against live ZA data to avoid the known false positives: email-marketing "subscription
// forms" (ActiveCampaign/Mailchimp newsletter capture) and membership-only plugins are NOT product
// subscriptions, so the generic "subscription" catch-all is deliberately omitted here — a bare
// "subscription" token in an app/plugin slug is too often a newsletter widget.
const TECH_RULES = [
  [/woocommerce[-_]subscriptions/i, "Woo Subscriptions"],
  [/yith[-_]woocommerce[-_]subscription/i, "YITH Subscriptions"],
  [/\bsubscriptio\b|sumo[-_]?subscriptions?/i, "Woo Subscriptions"],
  [/appstle/i, "Appstle"],
  [/rechargecdn|rechargepayments|recharge[-_]subscription|\brecharge\b/i, "Recharge"],
  [/boldapps\.net|bold[-_]subscriptions?/i, "Bold"],
  [/skio\.com|skio[-_]subscription|\bskio\b/i, "Skio"],
  [/loop[-_]subscriptions?/i, "Loop"],
  [/smartrr/i, "Smartrr"],
  [/sealsubscriptions|seal[-_]subscription/i, "Seal"],
  [/paywhirl/i, "PayWhirl"],
  [/ordergroove/i, "Ordergroove"],
  [/\bsubbly\b/i, "Subbly"],
];

// Description phrases that describe a SUBSCRIPTION BUSINESS (a store that sells on a recurring
// plan), not a newsletter. Deliberately phrase-level so "email subscription" / "newsletter
// subscription" don't match. A hit is recorded as the generic "Subscription (described)" — we know
// it's a subscription offer but not the tech behind it.
const DESC_RULES = [
  /subscription box(es)?/i,
  /subscribe (?:&|and) save/i,
  /\bsubscription service\b/i,
  /monthly (?:box|delivery|supply)/i,
  /(?:delivered|shipped) (?:monthly|every month)/i,
  /\bauto[-\s]?ship\b/i,
  /recurring (?:order|delivery|subscription)/i,
];

function deriveTools(row) {
  const tools = new Set();
  const tech = [row.apps, row.plugins, row.technologies].filter(Boolean).join(" ; ");
  for (const [re, name] of TECH_RULES) if (re.test(tech)) tools.add(name);
  if (row.description && DESC_RULES.some((re) => re.test(row.description))) {
    // Only add the generic descriptor if no concrete tool was found — a named tool is stronger.
    if (tools.size === 0) tools.add("Subscription (described)");
  }
  return [...tools];
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    const rows = await sql`
      SELECT domain, subscription_tools, apps, plugins, technologies, description
      FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND UPPER(country) = ANY(${countries})
        AND (apps IS NOT NULL OR plugins IS NOT NULL OR technologies IS NOT NULL OR description IS NOT NULL)`;
    console.log(`Scanning ${rows.length} store(s) across ${countries.length} market(s)${DRY ? " [DRY]" : ""}…`);

    let derived = 0, added = 0, unchanged = 0;
    const byTool = {};
    for (const r of rows) {
      const found = deriveTools(r);
      if (!found.length) continue;
      derived++;
      for (const t of found) byTool[t] = (byTool[t] || 0) + 1;
      // UNION with existing (never drop a probe-verified tool).
      const existing = (r.subscription_tools || "").split(";").map((s) => s.trim()).filter(Boolean);
      const union = [...new Set([...existing, ...found])];
      if (union.length === existing.length && existing.every((e) => union.includes(e))) { unchanged++; continue; }
      added++;
      if (!DRY) {
        await sql`UPDATE imported_stores SET subscription_tools = ${union.join(";")} WHERE domain = ${r.domain}`;
      }
    }
    console.log(`\nDone${DRY ? " [DRY — no writes]" : ""}. ${derived} store(s) with a derived signal · ${added} updated · ${unchanged} already had it.`);
    const breakdown = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
    console.log("By tool:");
    for (const [t, n] of breakdown) console.log(`  ${t.padEnd(24)} ${n}`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

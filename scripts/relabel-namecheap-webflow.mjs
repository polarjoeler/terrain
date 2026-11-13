/** relabel-namecheap-webflow — undo the bad Webflow fingerprint.
 *
 *  bulk_classify.py used to treat 63.250.43.0/24 as Webflow. It is AS22612 Namecheap shared hosting
 *  (shopify-radar#7 removes it), so WordPress sites hosted there were labelled "Webflow". The label
 *  also kept WooCommerce stores out of the Woo lanes, which select platform = 'WooCommerce'.
 *
 *  For every platform='Webflow' row, resolve apex + www; if either sits in that range, fetch the
 *  homepage once and relabel from what the page actually runs:
 *    WooCommerce markers → 'WooCommerce'   WordPress markers → 'WordPress'   Webflow markers → keep
 *    anything else (unreachable, cert error) → platform NULL + dns_checked_at NULL, so detect-builders
 *    and the WordPress re-probe look at it again from scratch.
 *  It never changes `published`: the Woo and WordPress lanes decide that the normal way.
 *  Re-runnable; rows only match while they still say Webflow and still resolve into the range.
 *
 *    node --env-file=.env.local scripts/relabel-namecheap-webflow.mjs           # show what it would do
 *    node --env-file=.env.local scripts/relabel-namecheap-webflow.mjs --apply   # write
 */
import postgres from "postgres";
import dns from "node:dns/promises";

const APPLY = process.argv.includes("--apply");
const BAD = "63.250.43.";   // the /24
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function inRange(resolver, domain) {
  const apex = domain.replace(/^www\./, "");
  for (const h of [apex, `www.${apex}`]) {
    try { if ((await resolver.resolve4(h)).some((ip) => ip.startsWith(BAD))) return true; } catch { /* no A */ }
  }
  return false;
}

async function verdict(domain) {
  try {
    const r = await fetch(`https://${domain}/`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const h = (await r.text()).slice(0, 1_000_000);
    if (/data-wf-site|assets\.website-files\.com|webflow\.js/i.test(h)) return "Webflow";
    if (/woocommerce|wc-blocks|wc-block-|[?&]add-to-cart=\d/i.test(h)) return "WooCommerce";
    if (/wp-content\/|wp-includes\/|\/wp-json\//i.test(h)) return "WordPress";   // also matches a WP error page
    return null;
  } catch { return null; }
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
try {
  const rows = await sql`SELECT domain, country, source, published FROM imported_stores WHERE platform = 'Webflow'`;
  const resolver = new dns.Resolver(); resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const hits = []; let i = 0;
  await Promise.all(Array.from({ length: 30 }, async () => {
    while (i < rows.length) { const r = rows[i++]; if (await inRange(resolver, r.domain)) hits.push(r); }
  }));
  console.log(`${rows.length} Webflow rows · ${hits.length} resolve into ${BAD}0/24${APPLY ? "" : "  [preview — pass --apply to write]"}`);
  const tally = {};
  for (const r of hits) {
    const v = await verdict(r.domain);   // one at a time: these all share one Namecheap host
    const to = v ?? "(unknown → re-detect)";
    tally[to] = (tally[to] || 0) + 1;
    console.log(`  ${r.domain.padEnd(36)} ${String(r.country ?? "—").padEnd(3)} ${r.published ? "published" : "banked   "}  Webflow → ${to}`);
    if (!APPLY || v === "Webflow") continue;
    await sql`UPDATE imported_stores SET
        platform = ${v},
        dns_checked_at = ${v ? sql`dns_checked_at` : null}
      WHERE domain = ${r.domain} AND platform = 'Webflow'`;
  }
  console.log("result:", JSON.stringify(tally));
} finally { await sql.end(); }

#!/usr/bin/env node
// Re-probe the banked generic-WordPress pool for ecommerce. These ~51.7k rows were landed as
// platform='WordPress' with NO plugin data (never fetched). Each WP homepage is on the merchant's
// OWN host (spread over tens of thousands of hosts → not Shopify-edge, not one-host), so this
// crawls at real concurrency. For each: fetch homepage → extract wp-content/plugins/<slug> → if a
// commerce plugin is present, relabel platform (WooCommerce/EDD/SureCart/…); else keep WordPress.
// Either way stamp live_status + live_checked_at (doubles as the "done" marker so re-runs drain the
// queue). Resilient writes (retry/backoff) per the Supabase posture.
//
// Run:  node --env-file=.env.local scripts/reprobe-wordpress.mjs --sample 30   # preview, no writes
//       node --env-file=.env.local scripts/reprobe-wordpress.mjs --limit 60000
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "60000"));
const CONC = Number(arg("--conc", "10"));
const DELAY = Number(arg("--delay", "120"));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Commerce plugin slug (or needle) → platform label. Order = priority (first match wins).
const COMMERCE = [
  ["WooCommerce", /wp-content\/plugins\/woocommerce[\/"']|generator["'][^>]*woocommerce|wc-ajax|\/wp-json\/wc\//i],
  ["Easy Digital Downloads", /plugins\/easy-digital-downloads|edd-add-to-cart|edd_ajax/i],
  ["SureCart", /plugins\/surecart|surecart\.com|data-sc-/i],
  ["WP eCommerce", /plugins\/wp-e-commerce|wpsc[-_]/i],
  ["MemberPress", /plugins\/memberpress|mepr-/i],
  ["Paid Memberships Pro", /plugins\/paid-memberships-pro|pmpro_/i],
  ["Jigoshop", /plugins\/jigoshop/i],
  ["WP EasyCart", /plugins\/wp-easycart|wpeasycart/i],
  ["Ecwid", /app\.ecwid\.com|plugins\/ecwid-shopping-cart/i],
];
const PLUGIN_RE = /wp-content\/plugins\/([a-z0-9][a-z0-9-]{1,40})/gi;
const HOLDING = /coming soon|under construction|account suspended|domain (is )?for sale|site will be available/i;

async function get(url, timeoutMs = 12000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ac.signal });
    const ct = r.headers.get("content-type") || "";
    if (r.status !== 200 || !/html/i.test(ct)) return { ok: false, status: r.status };
    return { ok: true, body: await r.text() };
  } catch { return { ok: false, status: 0 }; } finally { clearTimeout(t); }
}

function analyze(html) {
  const hay = html.toLowerCase();
  const plugins = [...new Set([...hay.matchAll(PLUGIN_RE)].map((m) => m[1]))].slice(0, 30);
  let platform = null;
  for (const [name, re] of COMMERCE) if (re.test(hay)) { platform = name; break; }
  const live = HOLDING.test(hay) ? "inactive" : "active";
  return { plugins, platform, live };
}

async function main() {
  console.log(`reprobe-wordpress${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC} · ${DELAY}ms`);
  // Hard per-connection timeouts so a wedged write self-terminates in seconds rather than holding a
  // row lock for minutes and freezing the table behind a queued ALTER (the 2026-10-29 lock jam).
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: Math.min(CONC + 2, 12),
    connection: { statement_timeout: 30000, idle_in_transaction_session_timeout: 60000, lock_timeout: 5000 } });
  try {
    const rows = await sql`SELECT domain FROM imported_stores
      WHERE platform = 'WordPress' AND live_checked_at IS NULL
      ORDER BY (country IN ('ZA','KE','NG','EG','MA','GH')) DESC, random() LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("nothing to re-probe — WordPress pool drained."); return; }
    console.log(`re-probing ${rows.length} WordPress site(s)…`);
    const found = {}; let cursor = 0, done = 0, commerce = 0, dead = 0, dbErrs = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const TRANSIENT = /lock timeout|statement timeout|canceling statement|timeout|connection|too many clients|ECONNRESET|terminating|deadlock/i;
    async function writeRow(q) { for (let a = 0; a < 4; a++) { try { await q(); return; } catch (e) { if (!TRANSIENT.test(e.message || "") || a === 3) { if (++dbErrs <= 8) console.log(`  ! db: ${e.message}`); return; } await sleep(400 * (a + 1) * (a + 1)); } } }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (cursor < rows.length) {
        const { domain } = rows[cursor++];
        const res = await get(`https://${domain}`);
        let platform = null, plugins = null, live = "dead";
        if (res.ok) { const a = analyze(res.body); platform = a.platform; plugins = a.plugins.join(";") || null; live = a.live; }
        else if (res.status === 0) { live = "dead"; } else { live = "inactive"; }
        if (platform) { commerce++; found[platform] = (found[platform] ?? 0) + 1; } else if (live === "dead") dead++;
        done++;
        if (SAMPLE) console.log(`  ${domain} → ${platform ?? "(WordPress)"} · ${live}${plugins ? ` · [${plugins.split(";").slice(0, 4).join(",")}]` : ""}`);
        else await writeRow(() => sql`UPDATE imported_stores SET
          platform = ${platform ?? "WordPress"},
          plugins = COALESCE(${plugins}, plugins),
          live_status = ${live}, live_checked_at = now(), live_platform = ${platform ?? "WordPress"}
          WHERE domain = ${domain}`);
        await sleep(DELAY);
      }
    }));
    console.log(`\ndone. ${done} probed · ${commerce} are commerce · ${dead} dead · db-errs: ${dbErrs}`);
    console.log("commerce breakdown:", found);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; } finally { await sql.end(); }
}
main();

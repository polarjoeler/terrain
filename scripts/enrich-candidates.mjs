/** enrich-candidates — phase 2 of the Service Partners flow: turn agencies we DISCOVERED from
 *  footer credits (partner_candidates) into directory listings, enriched from their own public
 *  site. Low-priority trickle — a handful of agency-site fetches, nothing to do with store
 *  discovery — so it never competes with Lucy.
 *
 *  Each promoted row is source='discovered' (a "Discovered" badge vs Fundi's "Verified"), keeps
 *  the store we already caught them building, and is picked up by attribute-partners on the next
 *  run (their domain now matches, so more of their footer credits attribute automatically).
 *
 *    node --env-file=.env.local scripts/enrich-candidates.mjs [--limit 20] [--dry-run]
 */
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "20"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +partner-enrich)";

const hostOf = (u) => { try { return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; } };
const countryOf = (h) => h.endsWith(".co.za") || h.endsWith(".za") ? "South Africa" : h.endsWith(".co.ke") || h.endsWith(".ke") ? "Kenya" : h.endsWith(".ng") ? "Nigeria" : h.endsWith(".gh") ? "Ghana" : null;
const SERVICE_KEYS = [
  [/shopify/i, "Shopify"], [/woocommerce|wordpress/i, "WooCommerce / WordPress"], [/e-?commerce|online store/i, "E-commerce"],
  [/web ?design|website design/i, "Web Design"], [/development|developer|custom build/i, "Development"],
  [/brand(ing)?|identity/i, "Branding & Design"], [/\bseo\b|search engine/i, "SEO & Marketing"],
  [/marketing|social media|ads?\b/i, "Marketing"], [/store setup|store management|migration/i, "Store Setup & Management"],
  [/support|maintenance|troubleshoot/i, "Support & Troubleshooting"],
];

async function get(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  try { return await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}
function extract(html) {
  const meta = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i) || [])[1] || null;
  const email = (html.match(/mailto:([^"'?]+@[^"'?]+)/i) || [])[1] || null;
  const services = [...new Set(SERVICE_KEYS.filter(([re]) => re.test(html)).map(([, n]) => n))].slice(0, 6);
  return { bio: meta ? meta.slice(0, 400) : null, email, services };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, idle_timeout: 20 });
  try {
    await sql`ALTER TABLE service_partners ADD COLUMN IF NOT EXISTS source text DEFAULT 'fundi'`;
    await sql`ALTER TABLE service_partners ADD COLUMN IF NOT EXISTS email text`;
    await sql`ALTER TABLE partner_candidates ADD COLUMN IF NOT EXISTS promoted boolean DEFAULT false`;

    // Existing identity — never duplicate a partner we already list (by site domain or name).
    const existing = await sql`SELECT name, website_url FROM service_partners`;
    const haveHost = new Set(existing.map((r) => r.website_url && hostOf(r.website_url)).filter(Boolean));
    const haveName = new Set(existing.map((r) => (r.name || "").toLowerCase().trim()));

    const cands = await sql`SELECT credit_name, credit_url, example_store, hits FROM partner_candidates
      WHERE NOT COALESCE(promoted, false) ORDER BY hits DESC LIMIT ${LIMIT}`;
    console.log(`${cands.length} candidates to consider${DRY ? " [DRY]" : ""}`);

    let promoted = 0, skipped = 0;
    for (const c of cands) {
      const host = hostOf(c.credit_url);
      if (!host || haveHost.has(host) || haveName.has(c.credit_name.toLowerCase().trim())) { skipped++; continue; }
      const r = await get(`https://${host}/`);
      const info = r && r.ok ? extract((await r.text().catch(() => "")).slice(0, 200_000)) : { bio: null, email: null, services: [] };
      const id = randomUUID();
      console.log(`  + ${c.credit_name} (${host}) — ${info.services.join(", ") || "no services parsed"}${info.email ? " · " + info.email : ""}`);
      if (DRY) { promoted++; continue; }
      await sql`INSERT INTO service_partners (id, name, type, country, website_url, bio, services, email, is_pro, source, stores_linked)
        VALUES (${id}, ${c.credit_name}, 'Agency', ${countryOf(host)}, ${c.credit_url}, ${info.bio}, ${info.services}, ${info.email}, false, 'discovered', 1)`;
      // Keep the store we caught them building.
      await sql`INSERT INTO partner_stores (partner_id, store_domain, source, confidence, evidence)
        VALUES (${id}, ${c.example_store.replace(/^www\./, "")}, 'footer', 'public_credit', 'discovered via footer credit')
        ON CONFLICT (partner_id, store_domain) DO NOTHING`;
      await sql`UPDATE partner_candidates SET promoted = true WHERE credit_name = ${c.credit_name}`;
      haveHost.add(host); haveName.add(c.credit_name.toLowerCase().trim());
      promoted++;
    }
    console.log(`${DRY ? "would promote" : "promoted"} ${promoted} discovered agencies; skipped ${skipped} (already listed).`);
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

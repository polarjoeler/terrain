/** Fingerprint scan — fetch each store's homepage and detect shipping/logistics
 *  apps that DON'T show up as a checkout carrier (Shiprazor, TUNL, duty tools…),
 *  by looking for their script/widget signatures in the page. Also grabs the
 *  CLEAN theme name from Shopify.theme while we're there. Footprint-free read.
 *
 *  Value-ranked, resumable, gentle (concurrency 4 + pause) to avoid 429s.
 *   node --env-file=.env.local scripts/logistics-scan.mjs [--limit 3000] [--all]
 */
import postgres from "postgres";

const ALL = process.argv.includes("--all");
const li = process.argv.indexOf("--limit");
const LIMIT = ALL ? 0 : li > -1 ? Number(process.argv[li + 1]) : 3000;
const POOL = 6, CONCURRENCY = 4, PAUSE_MS = 300;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// name -> distinctive needles (lowercased) to look for in the page HTML. Kept
// specific to avoid false positives (e.g. tunl.to, not a bare "tunl").
const FINGERPRINTS = {
  Shiprazor: ["shiprazor"],
  TUNL: ["tunl.to", "tunl.co", "cdn.tunl", "tunl-widget", "data-tunl", "app.tunl"],
  "Bob Go": ["bobgo", "bob-go", "bobgo.co.za"],
  Pargo: ["pargo.co.za", "widget.pargo", "pargo-"],
  "Parcel Perfect": ["parcelperfect"],
  Aramex: ["aramex"],
  "The Courier Guy": ["thecourierguy", "courierguy"],
  Fastway: ["fastway"],
  uAfrica: ["uafrica"],
  Shippo: ["goshippo"],
  ShipStation: ["shipstation"],
  Sendcloud: ["sendcloud"],
  Easyship: ["easyship.io", "easyship.com"],
  Zonos: ["zonos.com", "zonos-"],           // cross-border duty/tax
  Passport: ["passportshipping"],
};
const THEME_RE = /Shopify\.theme\s*=\s*\{[^}]*?"name"\s*:\s*"([^"]+)"/i;

async function scan(domain) {
  try {
    const res = await fetch(`https://${domain}/`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(15000), redirect: "follow",
    });
    if (res.status === 429 || res.status >= 500) return { retriable: true };
    if (!res.ok) return { retriable: false };
    const raw = await res.text();
    const html = raw.toLowerCase();
    const hits = [];
    for (const [name, needles] of Object.entries(FINGERPRINTS))
      if (needles.some((n) => html.includes(n))) hits.push(name);
    const tm = THEME_RE.exec(raw);               // raw preserves theme-name casing
    const theme = tm ? tm[1].trim().slice(0, 60) : null;

    // Own-sourced contact from the store's OWN page. Collect candidates, drop junk
    // (image sprites, trackers, template placeholders like xxx@xxx), prefer a real
    // business inbox (info@/sales@/support@…) over the first random match.
    const JUNK = /(@2x|\.png|\.jpg|\.gif|\.svg|\.webp|sentry|wixpress|example\.|@sentry|@email\b|domain\.com|placeholder|myshopify|\.wixpress|godaddy|x{3,}|@x+\.|^(?:example|you|your|yourname|youremail|email|name|username|user|test|sample|demo|firstname|lastname|johndoe|janedoe|no-?reply|donotreply)@)/i;
    const cands = [...new Set([...raw.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase()))]
      .filter((e) => !JUNK.test(e) && !/\.\./.test(e) && e.length < 80);
    const BIZ = /^(info|sales|hello|contact|support|admin|orders|shop|help|enquiries|hi|care|customercare|customerservice)@/;
    let email = cands.find((e) => BIZ.test(e)) || cands[0] || null;
    let phone = (/(?:tel:|href="tel:)\s*([+0-9][+0-9()\s.\-]{6,20})/.exec(raw) || [])[1] || null;
    if (phone) phone = phone.replace(/[^\d+]/g, "").slice(0, 20);
    if (phone && phone.replace(/\D/g, "").length < 8) phone = null;

    return { logistics: hits.join(";") || null, theme, email, phone, retriable: false };
  } catch (e) {
    return { retriable: e.name === "TimeoutError" };
  }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: POOL, idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS logistics_apps TEXT`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS logistics_checked_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND logistics_checked_at IS NULL
      ORDER BY estimated_monthly_sales DESC NULLS LAST, created_at DESC
      ${LIMIT > 0 ? sql`LIMIT ${LIMIT}` : sql``}`;
    console.log(`Fingerprint-scanning ${rows.length.toLocaleString()} homepages (concurrency ${CONCURRENCY})…`);

    let i = 0, found = 0, done = 0;
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        const r = await scan(domain);
        if (r.retriable) { await sleep(PAUSE_MS); continue; } // leave unchecked → retry next run
        // Clean theme only overwrites when it's a real theme-name shape.
        const cleanTheme = r.theme && /^[A-Za-z][A-Za-z &'-]{1,24}$/.test(r.theme) ? r.theme : null;
        // postgres.js rejects `undefined` params — coalesce every scanned value to null.
        await sql`UPDATE imported_stores SET
                    logistics_apps = ${r.logistics ?? null},
                    theme = COALESCE(${cleanTheme ?? null}, theme),
                    contact_email = COALESCE(${r.email ?? null}, contact_email),
                    contact_phone = COALESCE(${r.phone ?? null}, contact_phone),
                    logistics_checked_at = now()
                  WHERE domain = ${domain}`;
        if (r.logistics) found++;
        if (++done % 200 === 0) process.stdout.write(`\r  ${done}/${rows.length}  (${found} with a logistics app)`);
        await sleep(PAUSE_MS);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n✓ Done. ${found}/${rows.length} homepages referenced a logistics app.`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

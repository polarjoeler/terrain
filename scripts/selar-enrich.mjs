#!/usr/bin/env node
// selar-enrich — one PACED pass over banked Selar stores that, in a single store-page fetch, sets
// LIVENESS (active/inactive/dead), the real NAME, COUNTRY, and the seller's SOCIAL profiles
// (instagram/twitter/tiktok/facebook/youtube — the Rippl creator seed; see deriveSocials).
//
// Selar stores all live on ONE host (selar.com), so this is deliberately gentle (low concurrency +
// a delay between fetches) — not the fan-out the own-domain contact lane uses. And it's LOW-CADENCE
// by design: Selar is lower-value than Shopify, so run it monthly / on demand, not nightly.
//
// COUNTRY (done right): do NOT count currency strings in the rendered HTML — that picks up the
// switcher's DISPLAY default (ZAR) and mislabeled Nigerian sellers as ZA (verified 2026-10-29).
// The authoritative signal is the seller's `default_currency` in the Nuxt/devalue payload: the page
// embeds a flat array where integers are indices, so default_currency is an index whose value is
// the ISO code. Resolved correctly this reads NGN for Nigerian sellers, etc. We map only
// unambiguous single-country currencies to a country; USD/GBP/EUR and the multi-country CFA zones
// (XAF/XOF) stay NULL — USD is NEVER United States (African sellers price in USD).
//
// Run:  node --env-file=.env.local scripts/selar-enrich.mjs --sample 100   # validate, no writes
//       node --env-file=.env.local scripts/selar-enrich.mjs --limit 5000   # enrich a batch
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "0"));          // fetch N, print, NO writes (validation)
const DRY = process.argv.includes("--dry") || SAMPLE > 0;
const LIMIT = SAMPLE || Number(arg("--limit", "2000"));
const CONC = Number(arg("--conc", "2"));              // gentle: one host
const DELAY = Number(arg("--delay", "700"));          // ms between a worker's fetches
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Unambiguous single-country currencies → ISO2. USD/GBP/EUR and the multi-country CFA zones
// (XAF/XOF) are DELIBERATELY ABSENT → country stays NULL (unknown). USD is NOT United States.
const CCY_COUNTRY = {
  NGN: "NG", ZAR: "ZA", KES: "KE", GHS: "GH", UGX: "UG", TZS: "TZ", RWF: "RW", ZMW: "ZM",
  SLE: "SL", EGP: "EG", MAD: "MA", NAD: "NA", BWP: "BW", MUR: "MU", ETB: "ET", MWK: "MW",
  MZN: "MZ", AOA: "AO", INR: "IN",
};

async function get(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ac.signal });
    const body = await r.text();
    return { status: r.status, finalUrl: r.url, body };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Authoritative country from the devalue payload's default_currency (an index into the flat array).
function deriveCountry(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const s = scripts.find((x) => x.includes('"default_currency"') && x.includes("["));
  if (!s) return { country: null, currency: null };
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i < 0 || j <= i) return { country: null, currency: null };
  let arr; try { arr = JSON.parse(s.slice(i, j + 1)); } catch { return { country: null, currency: null }; }
  if (!Array.isArray(arr)) return { country: null, currency: null };
  const st = arr.find((e) => e && typeof e === "object" && !Array.isArray(e) && "default_currency" in e);
  if (!st) return { country: null, currency: null };
  const ccy = arr[st.default_currency];
  if (typeof ccy !== "string" || !/^[A-Z]{3}$/.test(ccy)) return { country: null, currency: null };
  return { country: CCY_COUNTRY[ccy] ?? null, currency: ccy };   // unmapped (USD/GBP/CFA) → null
}

// Canonical social URL formatters — kept identical to scripts/social-enrich.mjs so the `socials`
// JSONB and the per-platform columns read the same whichever lane filled them.
const SOCIAL_NORM = {
  facebook: (h) => `https://facebook.com/${h}`,
  instagram: (h) => `https://instagram.com/${h}`,
  twitter: (h) => `https://x.com/${h}`,          // twitter.com → x.com, to match social-enrich
  youtube: (h) => `https://youtube.com/${h}`,
  linkedin: (h) => `https://linkedin.com/${h}`,
  tiktok: (h) => `https://tiktok.com/@${h}`,
};
function socialHandle(platform, url) {
  try {
    const u = new URL(url);
    let p = u.pathname.replace(/^\/+|\/+$/g, "");
    if (platform === "youtube" || platform === "linkedin") return p || null;  // keep channel/in sub-path
    if (platform === "tiktok") p = p.replace(/^@/, "");
    p = p.split("/")[0].replace(/[?#].*$/, "");
    return p || null;
  } catch { return null; }
}
// Seller socials from the devalue payload. Selar stores `social` as an index into the flat array;
// its value is an object {facebook,twitter,instagram,youtube,linkedin,tiktok} where each field is
// either -1 (absent) or another index resolving to the full profile URL. We re-derive the handle
// and re-format canonically. Returns {} when none — the store simply listed no socials.
function deriveSocials(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const s = scripts.find((x) => x.includes('"default_currency"') && x.includes("["));
  if (!s) return {};
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i < 0 || j <= i) return {};
  let arr; try { arr = JSON.parse(s.slice(i, j + 1)); } catch { return {}; }
  if (!Array.isArray(arr)) return {};
  const st = arr.find((e) => e && typeof e === "object" && !Array.isArray(e) && "social" in e);
  if (!st || typeof st.social !== "number") return {};
  const node = arr[st.social];
  if (!node || typeof node !== "object" || Array.isArray(node)) return {};
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    const norm = SOCIAL_NORM[k];
    if (!norm) continue;
    const url = typeof v === "number" ? (v >= 0 ? arr[v] : null) : v;   // -1 (or any <0) = absent
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    const h = socialHandle(k, url);
    if (h) out[k] = norm(h);
  }
  return out;
}

function deriveName(html, slug) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const name = (og || title || "")
    .replace(/\s*(?:[|–—·-]|&middot;)\s*selar.*$/i, "")   // strip the " · Selar" suffix (any separator)
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  // Reject empties, bare "Selar", and 404/error titles — fall back to the handle (never persist junk).
  if (!name || /^selar$/i.test(name) || /page not found|not found|unavailable|error/i.test(name)) return slug;
  return name;
}

// A live Selar store page carries currency + the store scaffold; a deleted one 404s or bounces home.
function liveness({ status, finalUrl, body }) {
  if (status === 404 || status >= 500) return "dead";
  if (/\/m\//.test(finalUrl) === false) return "dead";                 // bounced off the /m/<slug> path
  if (/store (not found|unavailable|does not exist)|page not found/i.test(body)) return "dead";
  // A live storefront hydrates the devalue state (carries default_currency); a 404 shell does not.
  if (status === 200 && body.includes('"default_currency"')) return "active";
  return "inactive";
}

async function main() {
  console.log(`selar-enrich${SAMPLE ? ` [SAMPLE ${SAMPLE}]` : DRY ? " [DRY]" : ""} · conc ${CONC} · ${DELAY}ms`);
  const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: Math.min(CONC + 1, 6) });
  try {
    const rows = await sql`
      SELECT domain, name FROM imported_stores
      WHERE platform = 'Selar' AND source = 'selar_sitemap'
        AND (country IS NULL OR live_checked_at IS NULL OR social_checked_at IS NULL)
      ORDER BY last_alive_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("nothing to enrich — all Selar stores have country + a liveness check."); return; }
    console.log(`enriching ${rows.length} Selar store(s)…`);

    const tally = { active: 0, dead: 0, inactive: 0, countried: 0, unknown: 0, withSocials: 0 };
    let cursor = 0, dbErrs = 0, skipped = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Supabase is a shared, pooler-fronted instance — a write can lose a lock race under contention.
    // Retry transient errors with backoff (which also naturally sheds write pressure); never let one
    // failed row kill the run (the whole point — max work done without "messing with Supabase").
    const TRANSIENT = /lock timeout|statement timeout|canceling statement|timeout|connection|too many clients|ECONNRESET|terminating|deadlock/i;
    async function writeRow(q) {
      for (let a = 0; a < 4; a++) {
        try { await q(); return true; }
        catch (e) {
          if (!TRANSIENT.test(e.message || "") || a === 3) { dbErrs++; if (dbErrs <= 8) console.log(`  ! db: ${e.message}`); return false; }
          await sleep(400 * (a + 1) * (a + 1)); // 0.4s, 1.6s, 3.6s — back off so Supabase can recover
        }
      }
      return false;
    }
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (cursor < rows.length) {
        const { domain, name: slug } = rows[cursor++];
        try {
          const res = await get(`https://${domain}`);
          if (!res) { skipped++; await sleep(DELAY); continue; }
          const status = liveness(res);
          const name = deriveName(res.body, slug);
          const { country, currency } = deriveCountry(res.body);   // authoritative (devalue default_currency)
          const socials = deriveSocials(res.body);                 // seller's social profiles (creator seed)
          const hasSocial = Object.keys(socials).length > 0;
          tally[status]++; country ? tally.countried++ : tally.unknown++; if (hasSocial) tally.withSocials++;
          if (SAMPLE) console.log(`  ${domain}  →  ${status}  ${country ?? "??"}  (${currency ?? "no-ccy"})  "${name}"  ${hasSocial ? Object.keys(socials).join("+") : "no-social"}`);
          else if (!DRY) {
            // Only set country when resolved (COALESCE keeps existing/NULL otherwise). country_source
            // marks it as the Selar base-currency derivation, distinct from ccTLD/probe country.
            // socials: write the JSONB + per-platform columns (COALESCE keeps any prior value when
            // this pass found none); always stamp social_checked_at so the row drains from the gate.
            await writeRow(() => sql`UPDATE imported_stores SET
              country = COALESCE(${country}, country),
              country_source = ${country ? "selar_currency" : sql`country_source`},
              name = ${name},
              live_status = ${status},
              live_checked_at = now(),
              live_platform = 'Selar',
              socials = ${hasSocial ? sql.json(socials) : sql`socials`},
              instagram = COALESCE(${socials.instagram ?? null}, instagram),
              twitter = COALESCE(${socials.twitter ?? null}, twitter),
              tiktok = COALESCE(${socials.tiktok ?? null}, tiktok),
              facebook = COALESCE(${socials.facebook ?? null}, facebook),
              youtube = COALESCE(${socials.youtube ?? null}, youtube),
              social_checked_at = now()
              WHERE domain = ${domain}`);
          }
        } catch (e) { skipped++; if (skipped <= 8) console.log(`  ! ${domain}: ${e.message}`); }
        await sleep(DELAY);
      }
    }));
    console.log(`\ndone. ${tally.active} active / ${tally.inactive} inactive / ${tally.dead} dead · country set: ${tally.countried} · unknown: ${tally.unknown} · with-socials: ${tally.withSocials} · skipped: ${skipped} · db-errs: ${dbErrs}`);
  } catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
  finally { await sql.end(); }
}
main();

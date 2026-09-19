#!/usr/bin/env node
/**
 * Social-URL enricher — a store links its own social accounts in the footer/header, so one homepage
 * GET (a fetch we already make elsewhere, but standalone here for a backfill) yields the profile
 * URLs for all 8 networks. This captures the URLs only — follower COUNTS live on each platform and
 * are a separate, per-platform job (YouTube API easy; X/TikTok/LinkedIn/Meta hard). Own-domain GETs,
 * no Shopify-edge budget.
 *
 *   node --env-file=.env.local scripts/social-enrich.mjs [--limit 800] [--concurrency 10] [--dry-run]
 *
 * Writes a `socials` JSONB ({facebook, instagram, twitter, tiktok, youtube, linkedin, pinterest,
 * snapchat}) + social_checked_at (marks the attempt; net fails retry).
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "800"), 10);
const CONC = parseInt(arg("--concurrency", "10"), 10);
const DRY = process.argv.includes("--dry-run");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +social-enrichment)";

// network → [profile regex, canonical URL builder]. Negative lookaheads drop share/intent/asset
// links and post/permalink paths that aren't the brand's profile.
const NETWORKS = {
  facebook: [/(?:facebook|fb)\.com\/(?!sharer|share|plugins|tr\?|dialog|groups\/|events\/|permalink|story\.php|profile\.php|watch\/|hashtag\/|policies|help|login)([A-Za-z0-9_.-]{2,})/i, (h) => `https://facebook.com/${h}`],
  instagram: [/instagram\.com\/(?!p\/|reel\/|reels\/|explore\/|accounts\/|stories\/|tv\/)([A-Za-z0-9_.]{2,})/i, (h) => `https://instagram.com/${h}`],
  twitter: [/(?:twitter|x)\.com\/(?!intent\/|share|home|hashtag\/|search|i\/|explore|settings|privacy|tos)([A-Za-z0-9_]{2,15})/i, (h) => `https://x.com/${h}`],
  tiktok: [/tiktok\.com\/@([A-Za-z0-9_.]{2,})/i, (h) => `https://tiktok.com/@${h}`],
  youtube: [/youtube\.com\/(channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9_.-]+|user\/[A-Za-z0-9_.-]+|@[A-Za-z0-9_.-]+)/i, (h) => `https://youtube.com/${h}`],
  linkedin: [/linkedin\.com\/(company\/[A-Za-z0-9_.-]+|in\/[A-Za-z0-9_.-]+|school\/[A-Za-z0-9_.-]+)/i, (h) => `https://linkedin.com/${h}`],
  pinterest: [/pinterest\.[a-z.]{2,6}\/(?!pin\/|search\/|categories\/|ideas\/|_\/)([A-Za-z0-9_.-]{2,})/i, (h) => `https://pinterest.com/${h}`],
  snapchat: [/snapchat\.com\/add\/([A-Za-z0-9_.-]{2,})/i, (h) => `https://snapchat.com/add/${h}`],
};
// handles that are actually site sections / widgets / analytics, not a brand profile.
const JUNK = new Set(["share", "sharer", "home", "login", "help", "about", "privacy", "terms", "policy",
  "tr", "profile", "pages", "people", "watch", "events", "groups", "beacon", "widgets", "widget",
  "intent", "oauth", "settings", "signup", "search", "explore", "hashtag", "compose", "notifications",
  "messages", "account", "i", "wix", "www"]);

function extractSocials(html) {
  // Only look at real links (href="…") — matching raw HTML also catches analytics/widget URLs like
  // twitter.com/beacon buried in scripts, which aren't the brand's profile.
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const out = {};
  for (const [net, [re, build]] of Object.entries(NETWORKS)) {
    for (const href of hrefs) {
      const m = href.match(re);
      if (!m) continue;
      const h = (m[1] || "").replace(/[?#].*$/, "").replace(/\/$/, "").trim();
      if (!h || JUNK.has(h.toLowerCase().split("/")[0])) continue;
      out[net] = build(h);
      break;                         // first valid link for this network
    }
  }
  return out;
}

const TIMEOUT = 12000;
async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA } }); }
  catch { return null; } finally { clearTimeout(t); }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 6), idle_timeout: 20 });
  try {
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS socials JSONB`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS social_checked_at TIMESTAMPTZ`;
    const rows = await sql`
      SELECT domain FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND social_checked_at IS NULL AND country = ANY(${["ZA", "KE", "NG", "JP"]})
      ORDER BY discovered_at DESC NULLS LAST
      LIMIT ${LIMIT}`;
    console.log(`social-enrich: ${rows.length} stores (concurrency ${CONC})${DRY ? " [DRY RUN]" : ""}`);

    let i = 0, done = 0, withAny = 0, net = 0;
    const tally = new Map();
    async function worker() {
      while (i < rows.length) {
        const { domain } = rows[i++];
        let html = null;
        for (const u of [`https://${domain}/`, `https://www.${domain}/`]) {
          const r = await get(u);
          if (!r) { net++; break; }
          if (r.ok) { html = await r.text().catch(() => null); break; }
        }
        done++;
        if (html == null) { if (!DRY) await sql`UPDATE imported_stores SET social_checked_at = now() WHERE domain = ${domain}`.catch(() => {}); continue; }
        const socials = extractSocials(html.slice(0, 500_000));
        const keys = Object.keys(socials);
        if (keys.length) { withAny++; for (const k of keys) tally.set(k, (tally.get(k) ?? 0) + 1); }
        if (!DRY) await sql`UPDATE imported_stores SET socials = ${keys.length ? sql.json(socials) : null}, social_checked_at = now() WHERE domain = ${domain}`.catch(() => {});
        if (done % 50 === 0) process.stdout.write(`\r  ${done}/${rows.length}  with-socials ${withAny}, net-fail ${net}`);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log(`\ndone. ${withAny}/${rows.length} had ≥1 social, ${net} network-failed.`);
    console.log("by network:", [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", "));
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

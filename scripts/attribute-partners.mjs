/** attribute-partners — fill "stores linked" for Service Partners from PUBLIC signals only, and
 *  (optionally) push the verified count back to Fundi so both sites agree.
 *
 *  Signals (each labelled with its own source + confidence so a weak signal never masquerades as a
 *  strong one — and only strong signals land published=true; the rest land published=false until
 *  confirmed, per the bulk-import convention):
 *    1. PORTFOLIO    — Fundi portfolio_items.link (a partner's own self-declared work). Instant,
 *                      high confidence, no crawling.                         [published=true]
 *    2. FOOTER       — a tracked store's own homepage credits. Public, on the page:
 *         · linked "built/designed/developed/powered/site/web by <a href>X</a>"   public_credit  [true]
 *         · text-only "designed by X" (no link, matched to a known partner by name) text_credit   [false]
 *    3. META GENERATOR — <meta name="generator" content="X"> naming a known partner. generator_meta [false]
 *    4. THEME CREDIT   — "theme by/author X" (Shopify/Woo theme credit).            theme_author   [false]
 *    5. HTML COMMENT   — a code comment crediting an agency ("<!-- Built by X -->"). comment_credit [false]
 *  We only ever link a store we ALREADY track, and only to a partner we ALREADY know (so everything
 *  surfaced is public + enrichable). Unknown *linked* credits become partner_candidates — the
 *  directory-growth byproduct; text-only/generator/theme names without a link are used ONLY to match
 *  a known partner (never banked as a candidate — too noisy to seed the directory from).
 *
 *  Direct store fetches share ONE residential-IP budget (own-domain lane — proxies get bot-blocked
 *  there; see OPS.md). So this run is PACED (bounded concurrency + per-fetch jitter) and aborts if
 *  the 429 rate climbs, and is CAPPED per invocation (--footer N) + targetable (--country NG,KE) so a
 *  thin market can be drained in bounded daily passes instead of one burst.
 *
 *  Writes edges to partner_stores, recomputes service_partners.stores_linked, and — with
 *  --writeback + EXPERTS_SUPABASE_SERVICE_KEY — updates experts.verified_stores on Fundi.
 *
 *    node --env-file=.env.local scripts/attribute-partners.mjs [--country NG,KE] [--footer 3000]
 *         [--conc 5] [--delay 250] [--writeback] [--dry-run]
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FOOTER_N = parseInt(arg("--footer", "3000"), 10);
const CONC = Math.max(1, parseInt(arg("--conc", "3"), 10));          // own-domain lane: keep gentle
const DELAY = Math.max(0, parseInt(arg("--delay", "400"), 10));      // base ms between a worker's fetches
const COUNTRIES = arg("--country", "ZA,KE,NG").toUpperCase().split(",").map((c) => c.trim()).filter(Boolean);
const DRY = process.argv.includes("--dry-run");
const WRITEBACK = process.argv.includes("--writeback");
const UA = "Mozilla/5.0 (compatible; terrain-radar/1.0; +partner-attribution)";

function creds() {
  let url = process.env.EXPERTS_SUPABASE_URL, key = process.env.EXPERTS_SUPABASE_KEY, svc = process.env.EXPERTS_SUPABASE_SERVICE_KEY;
  try {
    const env = readFileSync("/Users/joel/africa-shopify-connect/.env", "utf8");
    const get = (k) => (env.match(new RegExp(`${k}=(.*)`)) || [])[1]?.trim().replace(/^["']|["']$/g, "");
    url = url || get("VITE_SUPABASE_URL"); key = key || get("VITE_SUPABASE_PUBLISHABLE_KEY");
  } catch { /* env optional */ }
  return { url, key, svc };
}

const hostOf = (u) => {
  try { return new URL(u.includes("://") ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return null; }
};

// Credit verbs shared across signals. "site/web/store/website/built/designed/developed/created/
// made/crafted/powered by" — the full set the task asks for, kept in one place.
const VERBS = "site|web|store|website|built|designed|developed|created|made|crafted|powered";
// Footer credit → crediting entity (name) + its link, where present.
const CREDIT_LINKED = new RegExp(`(?:${VERBS})\\s+by\\s*:?\\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{2,60})</a>`, "gi");
// Footer credit, text only (no anchor). First char letter/digit (agency names like "i22" / "shoptified"
// start lowercase or with a digit); this signal only ever matches a KNOWN partner by exact name, so a
// stray prose match ("made by hand") that doesn't equal a partner is harmless.
const CREDIT_TEXT = new RegExp(`(?:${VERBS})\\s+by\\s*:?\\s*([A-Za-z0-9][A-Za-z0-9&.\\-' ]{2,40})`, "g");
// <meta name="generator" content="X"> — usually the platform, occasionally a custom-theme agency.
const META_GEN = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{2,80})["']/i;
// Theme credit — "theme by/author/credit: X", optionally linked.
const THEME_CREDIT = /theme\s+(?:by|author|credits?)\s*:?\s*(?:<a[^>]+href=["']([^"']+)["'][^>]*>)?\s*([A-Za-z0-9&.\-' ]{2,40})/i;
// Credit phrasing inside a single HTML comment's text (run per-comment, so [\s\S] stays bounded).
const COMMENT_CREDIT = new RegExp(`(?:${VERBS}|design|development)\\s+by\\s*:?\\s*([A-Za-z0-9&.\\-' ]{2,50})`, "i");
const COMMENT_URL = /(https?:\/\/[^\s"'<>]+)/i;
// A captured credit name can trail into a URL or a separator ("OrderEazi https…", "Pixel Fusion |").
// Cut at the first url token and trim surrounding separators/quotes/whitespace.
const cleanName = (s) => (s || "")
  .replace(/\s+(?:https?:\/\/|www\.).*$/i, "")
  .replace(/^["'\s|·—–\-]+|["'\s|·—–\-]+$/g, "")
  .replace(/\s+/g, " ")
  .trim();

// Platform / CMS / theme / builder names that are NOT agencies — never an edge, never a candidate.
const PLATFORM_NOISE = new Set([
  "shopify", "wordpress", "woocommerce", "wix", "squarespace", "webflow", "elementor", "wp bakery",
  "wpbakery", "divi", "gutenberg", "drupal", "joomla", "bigcommerce", "prestashop", "magento", "opencart",
  "hugo", "gatsby", "next.js", "nextjs", "react", "html", "html5", "blogger", "ghost", "framer", "bubble",
  "shopstar", "bumpa", "selar", "catlog", "google", "cloudflare", "godaddy", "hubspot", "yoast seo",
  "yoast", "shogun", "pagefly", "gempages", "dawn", "debut", "brooklyn", "impulse", "prestige", "turbo",
  "flex", "motion", "warehouse", "the team", "us", "me", "admin", "support", "team",
]);
const platformNoise = (name) => {
  const n = (name || "").toLowerCase().trim();
  if (!n || n.length < 3) return true;
  if (PLATFORM_NOISE.has(n)) return true;
  // Theme vendors credit themselves as "theme by X" — not the agency that built the store.
  if (/\btheme(s)?\b/.test(n)) return true;
  // "generator"-style strings like "Shopify 2.0" / "WordPress 6.4" — leading platform token.
  return /^(shopify|wordpress|woocommerce|wix|squarespace|webflow|elementor|drupal|joomla|magento|prestashop|bigcommerce|ghost|hugo|gatsby|framer)\b/.test(n);
};
// Hosts that are platforms, theme/template vendors, Shopify/Woo apps or asset libraries — never the
// agency that built the store, so they are neither edges nor candidates.
const platformHost = (h) => h && /shopify|wix|squarespace|wordpress|woocommerce|godaddy|cloudflare|webflow|bigcommerce|prestashop|magento|framer|myshopify|wpastra|elegantthemes|outofthesandbox|outtheboxthemes|halothemes|themefreesia|bizbergthemes|cosmoswp|risethemes|rstheme|cleanthemes|svgrepo|smartsupp|spurpopups|shogun|pagefly/.test(h);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getDirect(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: "follow", headers: { "User-Agent": UA } });
    return { status: r.status, text: await r.text().catch(() => "") };
  } catch { return null; } finally { clearTimeout(t); }
}
// Hybrid egress: Shopify is served by Shopify's edge, which rate-limits per-IP — so route it through
// the Webshare proxy fleet (rotated) when one is configured, exactly like the Python Shopify-edge
// probes. Everything else is an own-domain lane (Woo/custom/builders) where datacenter proxies get
// bot-blocked harder, so those stay DIRECT on the home IP. Returns {status, html, lane} or null.
const PROXIES = loadProxies();   // [] when STORE_PROBE_PROXY_FILE is unset → everything goes direct
const isShopify = (p) => /shopify/i.test(p || "");
async function fetchStore(domain, platform) {
  if (PROXIES.length && isShopify(platform)) {
    const r = await fetchText(`https://${domain}/`, { proxy: pickProxy(PROXIES), ua: UA, timeoutMs: 12000, maxBytes: 400_000 });
    return r ? { status: r.status, html: r.text, lane: "proxy" } : null;
  }
  const r = await getDirect(`https://${domain}/`);
  return r ? { status: r.status, html: r.text, lane: "direct" } : null;
}
// Bounded-concurrency map with a per-fetch jittered delay — this is the own-domain residential lane,
// so workers self-pace (DELAY + up to DELAY jitter) rather than hammering.
async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      if (DELAY) await sleep(DELAY + Math.random() * DELAY);
    }
  }));
}

async function fetchPortfolio(url, key) {
  const r = await fetch(`${url}/rest/v1/portfolio_items?select=expert_id,link,title&link=not.is.null`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }).catch(() => null);
  return r && r.ok ? await r.json().catch(() => []) : [];
}

async function main() {
  const { url, key, svc } = creds();
  const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 4, idle_timeout: 20 });
  try {
    await sql`CREATE TABLE IF NOT EXISTS partner_stores (
      partner_id text, store_domain text, source text, confidence text, evidence text,
      published boolean NOT NULL DEFAULT false,
      first_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (partner_id, store_domain))`;
    // Widened signals add a published flag — the strong existing signals are confirmed, so stamp
    // them true once (idempotent). Weak/new signals land false until a human (or enrich-candidates)
    // confirms them.
    await sql`ALTER TABLE partner_stores ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false`;
    await sql`UPDATE partner_stores SET published = true
      WHERE NOT published AND (source = 'portfolio' OR (source = 'footer' AND confidence = 'public_credit'))`;
    // Purge edges pointing at a platform/CMS "partner" (e.g. a mis-imported row literally named
    // "Shopify") — "Powered by Shopify" is a platform badge, not a builder credit. Idempotent.
    await sql`DELETE FROM partner_stores ps USING service_partners sp
      WHERE ps.partner_id = sp.id
        AND lower(btrim(sp.name)) IN ('shopify','wordpress','woocommerce','wix','squarespace','webflow','bigcommerce','prestashop','magento','opencart','ghost')`;
    await sql`CREATE TABLE IF NOT EXISTS partner_candidates (
      credit_name text PRIMARY KEY, credit_url text, example_store text, hits int DEFAULT 1,
      first_seen_at timestamptz NOT NULL DEFAULT now())`;
    // Resumable marker so each capped run drains NEW stores instead of re-scanning the same
    // top-by-sales head. Stamped on every store we got a final (non-429) response from — processed
    // or dead — so only transient failures (429 / network) retry next pass. Guarded ALTER (runs only
    // when genuinely missing, so a no-op never takes an exclusive lock). Cheap nullable column.
    const [{ present }] = await sql`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_name='imported_stores' AND column_name='partner_checked_at') present`;
    if (!present) await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS partner_checked_at timestamptz`.catch(() => {});

    // Identity maps for matching credits → known partners.
    const partners = await sql`SELECT id, name, website_url FROM service_partners`;
    const byHost = new Map(), byName = new Map();
    for (const p of partners) {
      const h = p.website_url ? hostOf(p.website_url) : null;
      if (h) byHost.set(h, p.id);
      if (p.name) byName.set(p.name.toLowerCase().trim(), p.id);
    }
    // Domains we actually track — only attribute stores in our public directory.
    const trackedRows = await sql`SELECT domain, name FROM imported_stores WHERE published AND country = ANY(${COUNTRIES})`;
    const tracked = new Set(trackedRows.map((r) => r.domain.replace(/^www\./, "")));
    // Normalised store-name → domain, to resolve portfolio TITLES ("Crocs South Africa") when the
    // portfolio link points at the agency's own case-study page rather than the store.
    const normName = (s) => (s || "").toLowerCase().replace(/south africa|kenya|nigeria|\bsa\b|store|shop|online|official|\.co\.za|\.com/g, "").replace(/[^a-z0-9]/g, "");
    const byStoreName = new Map();
    for (const r of trackedRows) { const n = normName(r.name); if (n.length >= 4 && !byStoreName.has(n)) byStoreName.set(n, r.domain.replace(/^www\./, "")); }

    const edges = new Map();   // `${partner}\0${domain}` -> {partner_id, store_domain, source, confidence, evidence, published}
    const SEP = "\0";
    // Keep the strongest edge per (partner, store): published wins, then confidence rank.
    const CONF_RANK = { declared: 6, declared_title: 5, public_credit: 4, comment_credit: 3, theme_author: 2, text_credit: 1, generator_meta: 1 };
    const addEdge = (partner_id, store_domain, source, confidence, evidence, published) => {
      if (!tracked.has(store_domain)) return false;
      const k = `${partner_id}${SEP}${store_domain}`;
      const prev = edges.get(k);
      const better = !prev || (published && !prev.published) ||
        (published === prev.published && (CONF_RANK[confidence] ?? 0) > (CONF_RANK[prev.confidence] ?? 0));
      if (better) edges.set(k, { partner_id, store_domain, source, confidence, evidence, published });
      return true;
    };
    // Match a credited name/host to a known partner id.
    const matchPartner = (name, host) => (host && byHost.get(host)) || (name && byName.get(name.toLowerCase().trim())) || null;

    // ── Phase 1: portfolio (self-declared, public) ─────────────────────────────
    let portMatched = 0;
    if (url && key) {
      const agencyHosts = new Set([...byHost.keys()]);
      for (const it of await fetchPortfolio(url, key)) {
        const d = hostOf(it.link);
        if (d && !agencyHosts.has(d) && addEdge(it.expert_id, d, "portfolio", "declared", it.title || "portfolio", true)) { portMatched++; continue; }
        const brand = normName(String(it.title).split(/[|\-–—:,]/)[0]);
        let dom = brand.length >= 4 ? byStoreName.get(brand) : null;
        if (!dom && brand.length >= 5) {
          const apex = (x) => x.split(".")[0].replace(/[^a-z0-9]/g, "");
          let best = null;
          for (const x of tracked) { const a = apex(x); if (a === brand || a.startsWith(brand)) { if (!best || x.length < best.length) best = x; } }
          dom = best;
        }
        if (dom && addEdge(it.expert_id, dom, "portfolio", "declared_title", `portfolio: "${it.title}"`, true)) portMatched++;
      }
    }
    console.log(`portfolio: ${portMatched} store links matched to tracked stores`);

    // ── Phase 2: on-page credits (public, on the store) ────────────────────────
    // Skip stores we've already attributed. Done as a tiny in-memory set + JS filter, NOT a correlated
    // NOT EXISTS with regexp_replace — that per-row function call is non-indexable and blows the
    // pooler statement_timeout over a large market (NG ≈ 150k rows). Over-fetch a small margin so the
    // skips don't shrink the batch below the cap.
    const attributed = new Set((await sql`SELECT store_domain FROM partner_stores`).map((r) => r.store_domain.replace(/^www\./, "")));
    const stores = (await sql`
      SELECT domain, platform FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND country = ANY(${COUNTRIES})
        AND partner_checked_at IS NULL
      ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT ${FOOTER_N + attributed.size + 200}`)
      .filter((s) => !attributed.has(s.domain.replace(/^www\./, "")))
      .slice(0, FOOTER_N);
    console.log(`on-page queue: ${stores.length} stores (proxy lane ${stores.filter((s) => PROXIES.length && isShopify(s.platform)).length} shopify / direct lane ${stores.filter((s) => !(PROXIES.length && isShopify(s.platform))).length}); proxies loaded: ${PROXIES.length}`);
    let footMatched = 0, candidates = 0, fetched = 0, http429 = 0, httpErr = 0, direct429 = 0;
    const checked = [];   // stores that returned a final (non-429) response → stamp partner_checked_at
    const bySignal = {};
    const bump = (c) => { bySignal[c] = (bySignal[c] ?? 0) + 1; };
    const cand = new Map();
    const bankCandidate = (name, host, domain) => {
      if (!host || platformHost(host) || platformNoise(name)) return;
      const c = cand.get(name) ?? { credit_name: name, credit_url: `https://${host}`, example_store: domain, hits: 0 };
      c.hits++; cand.set(name, c); candidates++;
    };
    let aborted = false;
    await mapLimit(stores, CONC, async ({ domain, platform }) => {
      if (aborted) return;
      const r = await fetchStore(domain, platform);
      if (!r) { httpErr++; return; }
      if (r.status === 429) {
        http429++;
        // Only the DIRECT lane spends the home residential IP budget; abort on sustained 429s there.
        if (r.lane === "direct" && (++direct429, (fetched + direct429) >= 40 && direct429 / (fetched + direct429) > 0.2)) aborted = true;
        return;   // transient — leave unmarked so it retries next pass
      }
      checked.push(domain);   // got a final response (processed or dead) — drain it from future passes
      if (r.status < 200 || r.status >= 300) { httpErr++; return; }
      const html = r.html;
      if (!html) return;
      fetched++;
      const store = domain.replace(/^www\./, "");
      const head = html.slice(0, 80_000);   // generator/theme live in <head>
      const tail = html.slice(-120_000);    // footer credits live at the end

      // (a) footer linked credits — strongest on-page signal.
      for (const m of tail.matchAll(CREDIT_LINKED)) {
        const chost = hostOf(m[1]); const cname = cleanName(m[2]);
        if (platformNoise(cname) || platformHost(chost)) continue;   // "Powered by Shopify" etc. — not a builder
        const pid = matchPartner(cname, chost);
        if (pid) { if (addEdge(pid, store, "footer", "public_credit", `credited "${cname}"`, true)) { footMatched++; bump("public_credit"); } }
        else bankCandidate(cname, chost, domain);
      }
      // (b) footer text-only credits — match a KNOWN partner by name only (no banking).
      for (const m of tail.matchAll(CREDIT_TEXT)) {
        const cname = cleanName(m[1]);
        if (platformNoise(cname)) continue;
        const pid = byName.get(cname.toLowerCase());
        if (pid && addEdge(pid, store, "footer", "text_credit", `text credit "${cname}"`, false)) { footMatched++; bump("text_credit"); }
      }
      // (c) HTML comments crediting an agency.
      for (const cm of html.matchAll(/<!--([\s\S]{0,400}?)-->/g)) {
        const body = cm[1];
        const mm = COMMENT_CREDIT.exec(body);
        if (!mm) continue;
        const cname = cleanName(mm[1]);
        if (platformNoise(cname)) continue;
        const uhost = hostOf((COMMENT_URL.exec(body) || [])[1] || "");
        const pid = matchPartner(cname, uhost);
        if (pid) { if (addEdge(pid, store, "comment", "comment_credit", `html comment "${cname}"`, false)) { footMatched++; bump("comment_credit"); } }
        else if (uhost) bankCandidate(cname, uhost, domain);
      }
      // (d) <meta name="generator"> naming a known partner (rare but asked for).
      const gm = META_GEN.exec(head);
      if (gm) {
        const gname = cleanName(gm[1]);
        if (!platformNoise(gname)) {
          const pid = byName.get(gname.toLowerCase());
          if (pid && addEdge(pid, store, "generator", "generator_meta", `meta generator "${gname}"`, false)) { footMatched++; bump("generator_meta"); }
        }
      }
      // (e) theme author/credit.
      const tm = THEME_CREDIT.exec(head) || THEME_CREDIT.exec(tail);
      if (tm) {
        const thost = hostOf(tm[1] || ""); const tname = cleanName(tm[2] || "");
        if (!platformNoise(tname)) {
          const pid = matchPartner(tname, thost);
          if (pid) { if (addEdge(pid, store, "theme", "theme_author", `theme credit "${tname}"`, false)) { footMatched++; bump("theme_author"); } }
          else if (thost) bankCandidate(tname, thost, domain);
        }
      }
    });
    console.log(`on-page: fetched ${fetched}/${stores.length} (429:${http429} [direct:${direct429}] err:${httpErr}${aborted ? " — ABORTED on direct-lane 429 rate" : ""}), ${footMatched} credits matched known partners, ${cand.size} new agency candidates`);
    console.log("  matches by signal:", JSON.stringify(bySignal));

    if (DRY) {
      console.log(`[DRY] would write ${edges.size} edges (published: ${[...edges.values()].filter((e) => e.published).length}); top candidates:`,
        [...cand.values()].sort((a, b) => b.hits - a.hits).slice(0, 12).map((c) => `${c.credit_name}(${c.hits})`).join(", "));
      return;
    }

    // Stamp the resumable marker on every store we got a final response from, so the next capped run
    // advances past them. Bulk UPDATE in chunks (one write-RTT per 1000), not per-row.
    for (let i = 0; i < checked.length; i += 1000) {
      await sql`UPDATE imported_stores SET partner_checked_at = now()
        WHERE domain = ANY(${checked.slice(i, i + 1000)}) AND partner_checked_at IS NULL`.catch(() => {});
    }
    console.log(`marked ${checked.length} stores partner_checked_at`);

    // Persist edges + candidates, recompute counts.
    const eArr = [...edges.values()];
    for (let i = 0; i < eArr.length; i += 200) {
      await sql`INSERT INTO partner_stores ${sql(eArr.slice(i, i + 200), "partner_id", "store_domain", "source", "confidence", "evidence", "published")}
        ON CONFLICT (partner_id, store_domain) DO UPDATE SET source = EXCLUDED.source, confidence = EXCLUDED.confidence,
          evidence = EXCLUDED.evidence, published = partner_stores.published OR EXCLUDED.published`;
    }
    for (const c of cand.values()) {
      await sql`INSERT INTO partner_candidates (credit_name, credit_url, example_store, hits) VALUES (${c.credit_name}, ${c.credit_url}, ${c.example_store}, ${c.hits})
        ON CONFLICT (credit_name) DO UPDATE SET hits = partner_candidates.hits + ${c.hits}, credit_url = EXCLUDED.credit_url`.catch(() => {});
    }
    const counts = await sql`
      UPDATE service_partners sp SET stores_linked = c.n
      FROM (SELECT partner_id, count(DISTINCT store_domain)::int n FROM partner_stores WHERE published GROUP BY 1) c
      WHERE sp.id = c.partner_id RETURNING sp.id`;
    console.log(`wrote ${eArr.length} edges; stores_linked (published only) set on ${counts.length} partners; ${cand.size} candidates banked.`);

    // ── Optional write-back to Fundi (needs the service_role key) ──────────────
    if (WRITEBACK) {
      if (!svc || !url) { console.log("writeback skipped — set EXPERTS_SUPABASE_SERVICE_KEY (service_role) to push to Fundi."); return; }
      const linked = await sql`SELECT id, stores_linked FROM service_partners WHERE stores_linked IS NOT NULL AND stores_linked > 0`;
      let pushed = 0;
      for (const p of linked) {
        const res = await fetch(`${url}/rest/v1/experts?id=eq.${p.id}`, {
          method: "PATCH",
          headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ verified_stores: p.stores_linked }),
        });
        if (res.ok) pushed++;
      }
      console.log(`writeback: pushed verified_stores to ${pushed}/${linked.length} experts on Fundi.`);
    }
  } finally { closeAgents(); await sql.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

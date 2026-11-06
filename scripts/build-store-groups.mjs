/** build-store-groups — who runs which stores, derived from data we already hold (no crawling).
 *
 *  Two levels:
 *   1. SITE  — the same store under several hostnames: same registrable domain (www./shop./
 *              account. variants) or the same Shopify shop_id (alias domains, *.myshopify.com).
 *   2. GROUP — sites run by the same operator: the same contact email, a corporate email domain
 *              shared across sites or pointing at another site (policelifestyle@tregerbrands.co.za),
 *              the same Instagram / Facebook / TikTok handle, or the same phone number.
 *
 *  A value shared by more than HUB_CAP sites is boilerplate (hello@selar.com, a theme demo address,
 *  an agency footer), not common ownership, so it never links. Without that cap a single junk value
 *  (instagram.com/accounts) chains dozens of unrelated stores into one group.
 *
 *  Writes store_groups (one row per group of 2+ sites) and store_group_members (one row per store
 *  in such a group), replacing the previous build in one transaction. Small tables, read by the
 *  lead drawer; imported_stores is only read.
 *
 *    node --env-file=.env.local scripts/build-store-groups.mjs [--countries ZA,KE,NG] [--dry-run]
 */
import postgres from "postgres";
import { createHash } from "crypto";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : dflt; };
const COUNTRIES = arg("--countries", "ZA,KE,NG").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
const DRY = process.argv.includes("--dry-run");
// A value shared by more distinct sites than this is boilerplate, not an owner. A corporate email
// domain gets more room — a retail group runs a dozen brands off one domain — but an agency or
// web designer that puts its own address in every client's footer still trips it.
const HUB_CAP = { email: 8, maildom: 20, instagram: 6, facebook: 6, tiktok: 6, phone: 6 };
const REVIEW_SITES = 40;    // groups bigger than this are kept but marked for review, not shown to customers

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 15,
  connection: { statement_timeout: 180000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });

// ---------------------------------------------------------------- normalisers ---
// Registrable domain without a public-suffix list: a 2-letter ccTLD under a generic second level
// (co.za, com.ng, ac.ke, gov.ng …) keeps three labels, everything else two.
const SL2 = /^(co|com|org|net|edu|gov|ac|or|ne|go|sch|web|mil|nom|info|biz|ltd|plc)$/;
function registrable(host) {
  if (!host) return null;
  const l = host.toLowerCase().trim().replace(/\.$/, "").replace(/^www\./, "").split(".");
  if (l.length < 2) return null;
  return l.length >= 3 && l[l.length - 1].length === 2 && SL2.test(l[l.length - 2]) ? l.slice(-3).join(".") : l.slice(-2).join(".");
}
// Email domains that say nothing about ownership: freemail, ISPs, platforms that send on a merchant's behalf.
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|mweb|telkomsa|vodamail|webmail|lantic|iafrica|absamail|wol|proton|protonmail|pm|zoho|zohomail|gmx|mail|email|yandex|inbox|tutanota|hey)\.[a-z.]+$/;
const PLATFORM_MAIL = /(^|\.)(myshopify\.com|shopify\.com|shopstar\.co\.za|selar\.(com|co)|catlog\.shop|wix\.com|wixsite\.com|squarespace\.com|bumpa\.(shop|com)|takeapp\.(co|me)|mainstack\.(me|com)|godaddysites\.com|wordpress\.com|example\.(com|org)|sentry\.io|domain\.com|email\.com)$/;
const NON_OWNER_SUFFIX = /\.(edu|gov|ac|sch|mil)\.[a-z]{2}$|\.(gov|edu)$/;
function email(e) {
  if (!e) return null;
  e = String(e).trim().toLowerCase();
  if (!/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e)) return null;   // drops "ecom-swiper@11.css"-style junk
  const dom = e.split("@")[1];
  if (PLATFORM_MAIL.test(dom)) return null;
  return e;
}
const corporateDomain = (e) => {
  const dom = e.split("@")[1];
  return FREEMAIL.test(dom) || NON_OWNER_SUFFIX.test(dom) ? null : registrable(dom);
};
// Social handles arrive as bare handles or as URLs. Path words are not handles.
const NOT_A_HANDLE = new Set(["accounts", "account", "login", "sharer", "sharer.php", "share", "pages", "page", "profile.php", "people",
  "groups", "events", "watch", "reel", "reels", "explore", "p", "tr", "plugins", "dialog", "home", "en_us", "intent", "hashtag",
  "shopify", "wix", "woocommerce", "wordpress", "sitepad", "facebook", "instagram", "tiktok", "null", "undefined", "none", "yourpage",
  "yourusername", "username", "company", "brand", "store", "shop"]);
function handle(v) {
  if (!v) return null;
  let s = String(v).trim().toLowerCase().replace(/^https?:\/\/(www\.|m\.|web\.|mobile\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  s = s.replace(/^(instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com)\//, "").replace(/^@/, "");
  if (!/^[a-z0-9._-]+$/.test(s) || s.length < 4 || /^\d{1,6}$/.test(s) || NOT_A_HANDLE.has(s)) return null;
  return s;
}
// Last 9 digits = the national number for ZA/KE/NG whatever the prefix style (+27 / 0 / 27).
function phone(v) {
  if (!v) return null;
  const d = String(v).replace(/\D/g, "");
  if (d.length < 9) return null;
  const n = d.slice(-9);
  if (/^(\d)\1+$/.test(n) || "0123456789012345678".includes(n) || "9876543210987654321".includes(n)) return null;   // 111111111, 123456789…
  return n;
}

// ---------------------------------------------------------------- load ---
const t0 = Date.now();
const rows = await sql`
  SELECT domain, name, upper(country) AS cc, platform, shop_id::text AS shop_id, myshopify_domain,
         email, contact_email, instagram, facebook, tiktok, whatsapp, contact_phone,
         estimated_monthly_sales::float8 AS est, plus
  FROM imported_stores
  WHERE published AND upper(country) = ANY(${COUNTRIES})
    AND (live_status IS NULL OR live_status NOT IN ('dead', 'migrated'))
    AND activity_tier IS DISTINCT FROM 'not_a_store'`;

// ---------------------------------------------------------------- union-find ---
const parent = new Int32Array(rows.length).map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

// Level 1 — sites. A registrable domain carrying many different stores is a platform suffix
// (x.myshopify.com, za-x.glopalstore.com, x.selar.co), not one owner: there the full hostname is
// the site. Without this every Shopify store with a myshopify alias collapses into one "site".
const PLATFORM_SUFFIX = 6;
const hostsByReg = new Map();
for (const r of rows) { const g = registrable(r.domain); (hostsByReg.get(g) ?? hostsByReg.set(g, new Set()).get(g)).add(r.domain.replace(/^www\./, "")); }
const siteKey = (host) => {
  if (!host) return null;
  const h = host.toLowerCase().replace(/^www\./, ""), g = registrable(h);
  return /(^|\.)myshopify\.com$/.test(h) || (hostsByReg.get(g)?.size ?? 0) > PLATFORM_SUFFIX ? "host:" + h : "reg:" + g;
};
const firstBy = new Map();
const link = (key, i) => { if (!key) return; const j = firstBy.get(key); if (j === undefined) firstBy.set(key, i); else union(j, i); };
rows.forEach((r, i) => {
  link(siteKey(r.domain), i);
  if (r.shop_id) link("shop:" + r.shop_id, i);
  link(siteKey(r.myshopify_domain), i);   // alias domain ↔ its myshopify host
});
const siteOf = rows.map((_, i) => find(i));
const siteRegs = new Map();   // site root → set of registrable domains it owns
rows.forEach((r, i) => { const k = siteKey(r.domain); if (k.startsWith("reg:")) { const s = siteOf[i]; (siteRegs.get(s) ?? siteRegs.set(s, new Set()).get(s)).add(k.slice(4)); } });
const siteByReg = new Map(); for (const [s, regs] of siteRegs) for (const g of regs) siteByReg.set(g, s);

// Level 2 — operator signals, keyed per site so a site's www/apex twins don't count as "sharing".
const sitesBy = new Map();    // "kind|value" → Set(site)
const add = (kind, value, site) => { if (!value) return; const k = kind + "|" + value; (sitesBy.get(k) ?? sitesBy.set(k, new Set()).get(k)).add(site); };
rows.forEach((r, i) => {
  const s = siteOf[i];
  for (const raw of [r.email, r.contact_email]) {
    const e = email(raw); if (!e) continue;
    add("email", e, s);
    const corp = corporateDomain(e);
    if (corp) {
      add("maildom", corp, s);
      const owner = siteByReg.get(corp);            // the email lives on ANOTHER store's domain
      if (owner !== undefined && owner !== s) add("maildom", corp, owner);
    }
  }
  for (const [kind, v] of [["instagram", r.instagram], ["facebook", r.facebook], ["tiktok", r.tiktok]]) add(kind, handle(v), s);
  add("phone", phone(r.whatsapp), s);
  add("phone", phone(r.contact_phone), s);
});

const sitePar = new Map();
const sfind = (x) => { let p = sitePar.get(x) ?? x; if (p === x) return x; p = sfind(p); sitePar.set(x, p); return p; };
const sunion = (a, b) => { a = sfind(a); b = sfind(b); if (a !== b) sitePar.set(b, a); };
const reasons = new Map();    // site → Set(reason label)
const LABEL = { email: "Same contact email", maildom: "Email at {v}", instagram: "Same Instagram", facebook: "Same Facebook",
  tiktok: "Same TikTok", phone: "Same phone number" };
let hubs = 0; const linkCount = {};
for (const [k, set] of sitesBy) {
  if (set.size < 2) continue;
  const [kind, v] = k.split("|");
  if (set.size > HUB_CAP[kind]) { hubs++; continue; }
  linkCount[kind] = (linkCount[kind] || 0) + 1;
  const arr = [...set];
  for (let j = 1; j < arr.length; j++) sunion(arr[0], arr[j]);
  const label = LABEL[kind].replace("{v}", v);
  for (const s of arr) (reasons.get(s) ?? reasons.set(s, new Set()).get(s)).add(label);
}

// ---------------------------------------------------------------- assemble ---
const groups = new Map();     // group root → [rowIdx]
rows.forEach((_, i) => { const g = sfind(siteOf[i]); (groups.get(g) ?? groups.set(g, []).get(g)).push(i); });

const outGroups = []; const outMembers = [];
const sizes = { "2": 0, "3": 0, "4": 0, "5-9": 0, "10-40": 0, review: 0 };
for (const idx of groups.values()) {
  // A *.myshopify.com host that links to a group is that store's own alias, not another store.
  const sites = new Set(idx.filter((i) => !/\.myshopify\.com$/.test(rows[i].domain)).map((i) => siteOf[i]));
  if (sites.size < 2) continue;                    // one store on several hostnames — not a group
  const regs = [...new Set(idx.map((i) => siteKey(rows[i].domain).slice(5)))].sort();
  const gid = "g_" + createHash("md5").update(regs[0]).digest("hex").slice(0, 12);
  // Operator: a corporate email domain the members share that isn't itself one of their stores
  // (tregerbrands.co.za), else the biggest store's name.
  const maildoms = {};
  for (const s of sites) for (const r of reasons.get(s) ?? []) if (r.startsWith("Email at ")) { const d = r.slice(9); maildoms[d] = (maildoms[d] || 0) + 1; }
  const opDom = Object.entries(maildoms).filter(([d]) => !regs.includes(d)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const biggest = idx.slice().sort((a, b) => (rows[b].est || 0) - (rows[a].est || 0))[0];
  const review = sites.size > REVIEW_SITES;
  sizes[review ? "review" : sites.size >= 10 ? "10-40" : sites.size >= 5 ? "5-9" : String(sites.size)]++;
  outGroups.push({
    group_id: gid,
    label: opDom ?? (rows[biggest].name || rows[biggest].domain),
    operator_domain: opDom,
    n_sites: sites.size,
    n_stores: idx.length,
    est_sales_total: idx.reduce((s, i) => s + (rows[i].est || 0), 0) || null,
    countries: [...new Set(idx.map((i) => rows[i].cc))].sort(),
    review,
  });
  for (const i of idx) {
    const s = siteOf[i];
    const site = idx.filter((j) => siteOf[j] === s).map((j) => rows[j].domain).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    outMembers.push({ domain: rows[i].domain, group_id: gid, site, reasons: [...(reasons.get(s) ?? [])].sort() });
  }
}

console.log(`build-store-groups · ${COUNTRIES.join(",")} · ${rows.length.toLocaleString()} stores read in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  ${outGroups.length.toLocaleString()} groups · ${outMembers.length.toLocaleString()} stores in them · sizes (sites)`, sizes);
console.log(`  links by signal`, linkCount, `· ${hubs.toLocaleString()} boilerplate values skipped (shared by too many sites)`);
for (const g of outGroups.filter((g) => !g.review).sort((a, b) => (b.est_sales_total || 0) - (a.est_sales_total || 0)).slice(0, 12)) {
  const doms = outMembers.filter((m) => m.group_id === g.group_id && m.site === m.domain).map((m) => m.domain);
  console.log(`  ${String(g.n_sites).padStart(3)} · ${g.label} · ${doms.slice(0, 6).join(", ")}${doms.length > 6 ? " …" : ""}`);
}

if (DRY) { await sql.end({ timeout: 5 }); process.exit(0); }

// ---------------------------------------------------------------- write ---
try {
  // New, separate tables. Guarded so a normal run issues no DDL (see memory: postgres-schema-check-lock).
  const [t] = await sql`SELECT to_regclass('public.store_groups') AS g, to_regclass('public.store_group_members') AS m`;
  if (!t.g) {
    await sql`CREATE TABLE store_groups (
      group_id        text PRIMARY KEY,
      label           text,
      operator_domain text,
      n_sites         int NOT NULL,
      n_stores        int NOT NULL,
      est_sales_total numeric,
      countries       text[] NOT NULL DEFAULT '{}',
      review          boolean NOT NULL DEFAULT false,
      built_at        timestamptz NOT NULL DEFAULT now()
    )`;
    console.log("created table store_groups");
  }
  if (!t.m) {
    await sql`CREATE TABLE store_group_members (
      domain   text PRIMARY KEY,
      group_id text NOT NULL,
      site     text NOT NULL,
      reasons  text[] NOT NULL DEFAULT '{}',
      built_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE INDEX store_group_members_group_idx ON store_group_members (group_id)`;
    console.log("created table store_group_members");
  }
  // Replace the previous build atomically (DELETE, not TRUNCATE: no ACCESS EXCLUSIVE lock while the
  // drawer reads). Scoped to this run's countries so a later global build doesn't wipe this one.
  await sql.begin(async (tx) => {
    const old = await tx`SELECT group_id FROM store_groups WHERE countries && ${COUNTRIES}::text[]`;
    const oldIds = old.map((r) => r.group_id);
    for (let i = 0; i < oldIds.length; i += 5000) {
      const chunk = oldIds.slice(i, i + 5000);
      await tx`DELETE FROM store_group_members WHERE group_id = ANY(${chunk})`;
      await tx`DELETE FROM store_groups WHERE group_id = ANY(${chunk})`;
    }
    for (let i = 0; i < outGroups.length; i += 2000)
      await tx`INSERT INTO store_groups ${tx(outGroups.slice(i, i + 2000), "group_id", "label", "operator_domain", "n_sites", "n_stores", "est_sales_total", "countries", "review")}
        ON CONFLICT (group_id) DO UPDATE SET label = EXCLUDED.label, operator_domain = EXCLUDED.operator_domain, n_sites = EXCLUDED.n_sites,
          n_stores = EXCLUDED.n_stores, est_sales_total = EXCLUDED.est_sales_total, countries = EXCLUDED.countries, review = EXCLUDED.review, built_at = now()`;
    for (let i = 0; i < outMembers.length; i += 2000)
      await tx`INSERT INTO store_group_members ${tx(outMembers.slice(i, i + 2000), "domain", "group_id", "site", "reasons")}
        ON CONFLICT (domain) DO UPDATE SET group_id = EXCLUDED.group_id, site = EXCLUDED.site, reasons = EXCLUDED.reasons, built_at = now()`;
  });
  console.log(`  wrote ${outGroups.length.toLocaleString()} groups / ${outMembers.length.toLocaleString()} members in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await sql.end({ timeout: 5 });
}

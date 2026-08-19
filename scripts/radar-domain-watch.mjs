#!/usr/bin/env node
/**
 * Radar domain & email intelligence sweep — the second detection lane.
 *
 * For every enrolled brand this does two DNS-only jobs:
 *
 *   1. Typosquat / lookalike watch (#7) — generate dnstwist-style permutations of
 *      the brand's registrable label (omission / transposition / repetition /
 *      vowel-swap / homoglyph / hyphenation / word-adds) crossed with common TLDs,
 *      then DNS-check each. Any permutation that RESOLVES (has an A record) or is
 *      MAIL-CONFIGURED (has MX) is a live lookalike — recorded in
 *      radar_domain_watches. A resolving lookalike is a potential clone site; a
 *      mail-configured one is a potential phishing SENDER.
 *
 *   2. Email-spoofing posture (#8) — check the brand's OWN domain for SPF
 *      (v=spf1 TXT) and DMARC (_dmarc.<domain>, p= policy). A missing DMARC record
 *      or p=none means anyone can spoof mail as the brand. Stored back onto
 *      radar_brands (spf_present / dmarc_policy / email_checked_at).
 *
 *   node --env-file=.env.local scripts/radar-domain-watch.mjs
 *   node --env-file=.env.local scripts/radar-domain-watch.mjs --brand sovyn.co.za
 *
 * Pure DNS — no merchant fetches, no API keys — so it's cheap and cloud-safe.
 */

import postgres from "postgres";
import { resolve4, resolveMx, resolveTxt } from "node:dns/promises";

const brandArg = process.argv.indexOf("--brand");
const ONLY_BRAND = brandArg > -1 ? process.argv[brandArg + 1] : null;
const MAX_CANDIDATES = 500; // per brand — bounds the DNS fan-out

/* ---- domain helpers (mirror lib/radar/catalog.ts + audit.ts) --------------- */

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);

function cleanDomain(input) {
  return (input || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

/** 'sovyn.co.za' -> { label:'sovyn', tld:'co.za' } */
function splitDomain(domain) {
  const parts = cleanDomain(domain).split(".");
  const tldParts = [];
  if (parts.length > 1) tldParts.unshift(parts.pop());
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) tldParts.unshift(parts.pop());
  return { label: parts.join("."), tld: tldParts.join(".") };
}

/* ---- permutation generator (dnstwist-style) -------------------------------- */

const KEYBOARD = { a: "sqzw", b: "vghn", c: "xdfv", d: "sferc", e: "wrsdf", f: "dgrtvc",
  g: "fhtybv", h: "gjyubn", i: "ujko", j: "hkuinm", k: "jlimo", l: "kop", m: "njk",
  n: "bmhj", o: "iplk", p: "ol", q: "wa", r: "etdf", s: "adwxz", t: "rygf", u: "yihj",
  v: "cfgb", w: "qeas", x: "zsdc", y: "tugh", z: "asx" };
const HOMO = { o: ["0"], l: ["1", "i"], i: ["1", "l"], e: ["3"], s: ["5"], a: ["4"],
  b: ["8"], g: ["9"], m: ["rn"], w: ["vv"], u: ["v"], c: ["k"] };
const VOWELS = "aeiou";
const WORDS = ["shop", "store", "online", "sale", "outlet", "official", "sa", "za", "buy"];
const ALT_TLDS = ["co.za", "com", "shop", "store", "online", "net", "africa", "co"];

/** Return a Map<candidateDomain, kind>. */
function generateCandidates(domain) {
  const { label, tld } = splitDomain(domain);
  const out = new Map();
  if (!label || label.length < 3) return out;

  // label variant -> kind
  const variants = new Map();
  const add = (v, kind) => { if (v && v !== label && v.length >= 2 && !variants.has(v)) variants.set(v, kind); };

  const ch = [...label];
  // omission
  for (let i = 0; i < ch.length; i++) add(label.slice(0, i) + label.slice(i + 1), "typo");
  // transposition (adjacent swap)
  for (let i = 0; i < ch.length - 1; i++) {
    const a = [...ch]; [a[i], a[i + 1]] = [a[i + 1], a[i]]; add(a.join(""), "typo");
  }
  // repetition (double a char)
  for (let i = 0; i < ch.length; i++) add(label.slice(0, i + 1) + ch[i] + label.slice(i + 1), "typo");
  // vowel swap
  for (let i = 0; i < ch.length; i++) if (VOWELS.includes(ch[i]))
    for (const v of VOWELS) if (v !== ch[i]) add(label.slice(0, i) + v + label.slice(i + 1), "typo");
  // keyboard-adjacent replacement (bounded: one substitution per position)
  for (let i = 0; i < ch.length; i++) for (const k of KEYBOARD[ch[i]] || "")
    add(label.slice(0, i) + k + label.slice(i + 1), "typo");
  // homoglyph substitutions (reverse of canon folding)
  for (let i = 0; i < ch.length; i++) for (const g of HOMO[ch[i]] || [])
    add(label.slice(0, i) + g + label.slice(i + 1), "homoglyph");
  // hyphenation
  for (let i = 1; i < ch.length; i++) add(label.slice(0, i) + "-" + label.slice(i), "hyphen");
  // word adds
  for (const w of WORDS) { add(`${label}${w}`, "wordadd"); add(`${label}-${w}`, "wordadd"); add(`${w}${label}`, "wordadd"); add(`${w}-${label}`, "wordadd"); }

  // Cross label variants with the original TLD + .com (the common phishing homes).
  const variantTlds = [...new Set([tld, "com"])];
  for (const [v, kind] of variants) {
    for (const t of variantTlds) out.set(`${v}.${t}`, kind);
    if (out.size >= MAX_CANDIDATES) break;
  }
  // Original label on ALTERNATE TLDs (tld-swap squatting: brand.shop, brand.com…).
  for (const t of ALT_TLDS) if (t !== tld) out.set(`${label}.${t}`, "tld");

  return out;
}

/* ---- DNS checks ------------------------------------------------------------ */

async function checkDomain(domain) {
  const [a, mx] = await Promise.all([
    resolve4(domain).catch(() => []),
    resolveMx(domain).catch(() => []),
  ]);
  return { hasSite: a.length > 0, hasMail: mx.length > 0, ips: a };
}

/** SPF + DMARC posture of the brand's own domain. */
async function emailPosture(domain) {
  const [txt, dmarcTxt] = await Promise.all([
    resolveTxt(domain).catch(() => []),
    resolveTxt(`_dmarc.${domain}`).catch(() => []),
  ]);
  const flat = txt.map((r) => r.join("")).map((s) => s.trim());
  const spfPresent = flat.some((s) => /^v=spf1\b/i.test(s));
  const dmarc = dmarcTxt.map((r) => r.join("")).find((s) => /^v=DMARC1\b/i.test(s.trim()));
  let dmarcPolicy = null; // null = no DMARC record at all
  if (dmarc) {
    const m = dmarc.match(/\bp\s*=\s*(none|quarantine|reject)\b/i);
    dmarcPolicy = m ? m[1].toLowerCase() : "none"; // record present but no/blank p= behaves as none
  }
  return { spfPresent, dmarcPolicy };
}

/** Small concurrency pool over an array of async thunks. */
async function pool(items, worker, concurrency = 24) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ---- main ------------------------------------------------------------------ */

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    // Idempotent schema guards (mirror lib/schema.sql).
    await sql`ALTER TABLE radar_brands ADD COLUMN IF NOT EXISTS spf_present BOOLEAN`;
    await sql`ALTER TABLE radar_brands ADD COLUMN IF NOT EXISTS dmarc_policy TEXT`;
    await sql`ALTER TABLE radar_brands ADD COLUMN IF NOT EXISTS email_checked_at TIMESTAMPTZ`;
    await sql`
      CREATE TABLE IF NOT EXISTS radar_domain_watches (
        brand_domain  TEXT NOT NULL,
        lookalike     TEXT NOT NULL,
        kind          TEXT,
        has_site      BOOLEAN NOT NULL DEFAULT false,
        has_mail      BOOLEAN NOT NULL DEFAULT false,
        ips           JSONB NOT NULL DEFAULT '[]',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        dismissed     BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (brand_domain, lookalike)
      )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_domain_watches_brand ON radar_domain_watches(brand_domain)`;

    const brands = await sql`
      SELECT brand_domain, brand_name, official_domains
      FROM radar_brands WHERE monitoring
      ${ONLY_BRAND ? sql`AND brand_domain = ${cleanDomain(ONLY_BRAND)}` : sql``}`;
    if (!brands.length) { console.log("No monitored brands — nothing to watch."); return; }

    console.log(`Domain & email intel for ${brands.length} brand(s)…\n`);

    for (const b of brands) {
      const allow = new Set([b.brand_domain, ...(b.official_domains || [])].map(cleanDomain));

      // --- email posture (#8) --------------------------------------------------
      const post = await emailPosture(b.brand_domain);
      await sql`
        UPDATE radar_brands SET spf_present = ${post.spfPresent},
          dmarc_policy = ${post.dmarcPolicy}, email_checked_at = now()
        WHERE brand_domain = ${b.brand_domain}`;
      const dmarcLabel = post.dmarcPolicy === null ? "MISSING" : `p=${post.dmarcPolicy}`;
      const emailRisk = !post.spfPresent || post.dmarcPolicy === null || post.dmarcPolicy === "none";
      console.log(`${b.brand_domain}: SPF ${post.spfPresent ? "ok" : "MISSING"}, DMARC ${dmarcLabel}${emailRisk ? "  ⚠ spoofable" : ""}`);

      // --- lookalike watch (#7) ------------------------------------------------
      const candidates = [...generateCandidates(b.brand_domain)].filter(([d]) => !allow.has(d));
      const checks = await pool(candidates, async ([domain, kind]) => {
        const r = await checkDomain(domain);
        return (r.hasSite || r.hasMail) ? { domain, kind, ...r } : null;
      });
      const found = checks.filter(Boolean);

      for (const f of found) {
        await sql`
          INSERT INTO radar_domain_watches (brand_domain, lookalike, kind, has_site, has_mail, ips)
          VALUES (${b.brand_domain}, ${f.domain}, ${f.kind}, ${f.hasSite}, ${f.hasMail}, ${sql.json(f.ips)})
          ON CONFLICT (brand_domain, lookalike) DO UPDATE SET
            kind = EXCLUDED.kind, has_site = EXCLUDED.has_site,
            has_mail = EXCLUDED.has_mail, ips = EXCLUDED.ips, last_seen_at = now()`;
      }
      const mailers = found.filter((f) => f.hasMail).length;
      console.log(`  ${candidates.length} permutations checked → ${found.length} live lookalike(s)${mailers ? `, ${mailers} mail-configured` : ""}`);
      for (const f of found.slice(0, 12))
        console.log(`    ⚑ ${f.domain}  [${f.kind}${f.hasSite ? " site" : ""}${f.hasMail ? " mail" : ""}]`);
    }
    console.log("\nDone.");
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

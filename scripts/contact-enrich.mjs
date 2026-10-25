#!/usr/bin/env node
/**
 * Contact enrichment — turn "info@" leads into named, typed, rankable contacts.
 *
 * The customer complaint this exists to answer: competitor lead data is full of generic mailboxes
 * you can't open a conversation with. Our own first pass had the same shape by construction —
 * ai-enrich.mjs reads the HOMEPAGE only and keeps the FIRST email it matches, which is virtually
 * always the footer info@. Three cheap fixes, no paid data:
 *
 *   1. COLLECT, THEN RANK. Gather every address, classify the local-part (named person >
 *      owner/founder/accounts > info/hello/support), keep the whole ranked set.
 *   2. CRAWL THE CONTACT SURFACE. The legally-required policy pages and the about/contact pages
 *      carry the merchant's real inbox far more often than the shopfront footer does. Shopify
 *      guarantees these paths exist, so this is a handful of extra GETs with a high hit rate.
 *      /blogs/news.atom is the cheapest trick of all: <author><name> is a structured human name.
 *   3. NAME THE HUMAN. Anchored regex first (free); then, only if still unnamed, one LOCAL LLM
 *      call over the banked contact copy ($0 on the Mac Mini). Never the paid API by default.
 *
 * Writes a typed verdict (contact_type) so the product can offer "has a named contact" as a filter
 * instead of making the buyer discover the generic ones after they've burnt the send. Also lands
 * the channels that actually get answered in our markets — WhatsApp, Instagram, the contact form.
 *
 *   node --env-file=.env.local scripts/contact-enrich.mjs --migrate          # ONCE: add the columns
 *   node --env-file=.env.local scripts/contact-enrich.mjs --dry --domains a.co.za,b.co.za
 *   node --env-file=.env.local scripts/contact-enrich.mjs --country ZA --limit 500
 *   node --env-file=.env.local scripts/contact-enrich.mjs --offline --dry --domains x.co.za  # no DB
 *   node --env-file=.env.local scripts/contact-enrich.mjs --overwrite --domains x.co.za      # redo
 *
 * RATE BUDGET — the surprise, measured not assumed: the Webshare fleet is the WRONG lane here.
 * Two disjoint 10-store ZA Shopify samples, identical settings: via the fleet, 5/10 stores were
 * 429'd mid-crawl; direct from the residential IP, 10/10 completed with zero 429s. Shopify's edge
 * throttles datacenter ASNs on plain HTML much harder than on the checkout endpoints the Python
 * probes reach through that same fleet. So this runs DIRECT and SLOW (--proxy opts into the fleet
 * if that ever changes), and the real protection is pace: ≤4 workers, a jittered pause between a
 * store's pages, and a 429 anywhere aborts that store WITHOUT recording a verdict so it re-queues.
 * At the default pace a store costs ~8s of crawl across 2 workers, so 15.6k ZA stores is ~17h of
 * continuous crawling — which the nightly cron deliberately spreads over ~a fortnight rather than
 * monopolising the shared rate budget for a day.
 *
 * Re-runnable: contact_checked_at gates the queue; --reprobe-days re-opens stale stores. Banked
 * contact_text means a better extractor (or a better local model) can be re-run for free later.
 */
import postgres from "postgres";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const DRY = has("--dry");
const MIGRATE = has("--migrate");
const FORCE_DIRECT = has("--force-direct");
const NO_LLM = has("--no-llm");
const VERBOSE = has("--verbose");   // per-fetch trace: path, status, what each page yielded
const OFFLINE = has("--offline");   // crawl --domains with no DB at all (pure extractor check)
// Normally the person-level fields are written with COALESCE so a manual correction survives a
// re-crawl. That also preserves a BAD value once a bug has written one, which is the wrong
// trade-off when you have just fixed the extractor — --overwrite replaces them outright, nulls
// included. Use it for a corrective re-run over named --domains, not for the nightly sweep.
const OVERWRITE = has("--overwrite");
// Re-apply the current name validator to names ALREADY stored, nulling the ones that no longer
// pass. Free and instant: no network, no store is touched. The point of banking contact_text is
// that an extractor fix can be applied retroactively without re-crawling anything.
const REVALIDATE = has("--revalidate-names");
// The nightly sweep marches down the revenue list, so the long tail stays unmeasured for weeks.
// --sample takes a RANDOM slice of what is left instead: a few hundred stores is enough to tell
// us whether the tail behaves like the head, today, rather than at the end of the census.
const SAMPLE = has("--sample");
// Who is claiming rows. Coordination between machines CANNOT rest on two agents — or two people —
// remembering to pass matching flags: on 2026-10-22 Rex and Chad ran the same revenue-ordered queue
// at 01:15 and crawled the same stores twice. The queue now hands work out under a lease, so two
// runs are disjoint by construction regardless of who starts them or how.
const HOST = process.env.CONTACT_WORKER || os.hostname().split(".")[0];
const CLAIM_TTL = arg("--claim-ttl", "3 hours");   // a crashed run's rows return to the pool
// Split the queue BY PLATFORM, which is the only split that actually parallelises. A Shopify
// store's own domain is served by Shopify's edge, so every machine behind the home IP competes
// for one rate budget — running it on two boxes just shares the same ceiling. Every other CMS is
// fetched from the merchant's OWN server: no shared budget, no contention, so those can run on a
// second machine at high concurrency alongside the Shopify lane rather than instead of it.
//   --platform shopify      → the rate-limited lane (one machine only)
//   --platform non-shopify  → the free-running lane (Rex/Lucy, high concurrency)
const platArg = (arg("--platform", "") || "").toLowerCase() || null;
// Egress. Counter-intuitively the Webshare fleet is the WRONG lane for this crawl: measured on two
// disjoint 10-store ZA Shopify samples at identical settings, the fleet was rate-limited on 5/10
// stores while the direct residential IP completed 10/10 with zero 429s. Shopify's edge throttles
// datacenter ASNs on ordinary HTML far harder than it does the checkout endpoints the Python
// probes hit through that same fleet. So: direct and slow by default; --proxy to opt in.
const USE_PROXY = has("--proxy");
const LIMIT = Number(arg("--limit", 200));
const CONC = Number(arg("--concurrency", 3));
const REPROBE_DAYS = Number(arg("--reprobe-days", 180));
const MAX_FETCHES = Number(arg("--max-fetches", 8));       // per store, homepage + retries included
const DELAY_MS = Number(arg("--delay-ms", 1200));          // pause between a store's own page fetches
const DOMAINS = (arg("--domains", "") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");
const countries = (arg("--country", "") || "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || "";
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "qwen2.5:7b";
const ALLOW_PAID = process.env.ALLOW_PAID_ENRICH === "1";

const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 429/503 means the edge is shedding us, NOT that the store has no contact details. Treated as
// data it would write a false "no contact" verdict and stamp the store as checked for months —
// so a throttled store aborts its crawl and is left in the queue untouched.
const throttled = (r) => !!r && (r.status === 429 || r.status === 503);

/* ---- email classification ------------------------------------------------- */
// The whole point of the script: a verdict on how useful each address is for outreach.
// Shop-front mailboxes that reach a queue, not a person.
const ROLE_GENERIC = new Set(["info", "hello", "hallo", "hi", "hey", "contact", "contactus", "contact-us",
  "support", "help", "helpdesk", "sales", "orders", "order", "shop", "store", "enquiries", "enquiry",
  "inquiries", "inquiry", "admin", "administrator", "office", "team", "service", "services",
  "customerservice", "customercare", "care", "mail", "email", "post", "webshop", "web", "online",
  "general", "ask", "letstalk", "talktous", "query", "queries", "reception", "shoponline", "returns",
  "refunds", "shipping", "delivery", "bookings", "booking", "events", "newsletter", "subscribe",
  "social", "media1", "wholesaleenquiries", "customers", "clients", "feedback", "say", "connect"]);
// Still a role mailbox, but one a decision-maker actually reads — worth far more than info@.
const ROLE_TARGETED = new Set(["owner", "owners", "founder", "founders", "director", "directors",
  "ceo", "md", "managingdirector", "manager", "management", "accounts", "accounting", "finance",
  "billing", "invoices", "marketing", "press", "pr", "media", "wholesale", "b2b", "trade",
  "partnerships", "partners", "buying", "buyer", "procurement", "purchasing", "hr", "careers",
  "legal", "studio", "design", "creative", "boss", "head"]);
// Placeholder / vendor / template addresses that leak into theme markup — never a real contact.
// Theme/demo placeholders whose LOCAL part gives them away — example@mail.com sailed through a
// domain-only junk filter and was classified as a named person in testing.
const PLACEHOLDER_LOCAL = new Set(["example", "examples", "name", "yourname", "your-name", "firstname",
  "lastname", "fullname", "user", "username", "someone", "somebody", "anyone", "demo", "dummy",
  "foo", "bar", "baz", "test", "tester", "testing", "abc", "xyz", "aaa", "asdf", "qwerty",
  "myemail", "mymail", "myname", "address", "emailaddress", "changeme", "replaceme", "enter"]);
const EMAIL_JUNK = /(sentry|wixpress|example\.|godaddy|shopify\.com|myshopify|fakedomain|yourdomain|your@|youremail|email@example|no-?reply|donotreply|do-not-reply|placeholder|test@|sample@|domain\.com|sentry\.io|cloudflare|wordpress\.|squarespace|bigcommerce|mailchimp|klaviyo|gorgias|zendesk|intercom|\.png|\.jpe?g|\.gif|\.svg|\.webp|u002f|%40)/i;
// Free mail: for an SMB in our markets the owner's gmail IS the real contact, so these are
// accepted — but ONLY from the curated contact surface, never from homepage theme markup, where
// a third party's address is as likely as the merchant's.
const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|protonmail|proton|zoho|mail|gmx|webmail|telkomsa|vodamail|mweb|iafrica|absamail|yebo|naver|docomo|ezweb|au\.com|softbank|yahoo\.co\.jp)\./i;

const emailHost = (e) => { const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(e || ""); return m ? m[1].toLowerCase() : null; };
const sameOrg = (host, storeDomain) => {
  if (!host || !storeDomain) return false;
  const sd = String(storeDomain).toLowerCase().replace(/^www\./, "");
  return host === sd || host.endsWith("." + sd) || sd.endsWith("." + host);
};

// Brand-as-mailbox (hello@brand / brand@brand) reaches the shop, not a named person. The store's
// CATEGORY words count too: a bike shop's ebike@ is a product desk, not a person — that single
// addition fixed the one false "named" verdict in the first sample run.
// Labels that are suffix/platform noise rather than the brand.
const TLDISH = new Set(["com", "net", "org", "co", "za", "ke", "ng", "jp", "io", "biz", "info",
  "africa", "myshopify", "site", "app", "dev", "web", "www"]);
const brandTokens = (domain, name, category) => {
  const out = new Set();
  // EVERY label, not just the first: on checkout.underarmour.co.za the first label is "checkout",
  // so taking only that left the real brand unguarded and csunderarmour@ was read as a person.
  for (const label of clean(domain).split(".")) {
    if (label.length > 2 && !TLDISH.has(label)) {
      out.add(label);
      for (const p of label.split(/[-_]/)) if (p.length > 2) out.add(p);
    }
  }
  for (const src of [name, category]) {
    for (const w of String(src || "").toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2) out.add(w);
  }
  return out;
};

// Commerce vocabulary that passes "one alphabetic word" but is never a person. Without this the
// single-token rule promotes every product/function desk (ebike@, spares@, rentals@) to "named",
// which is precisely the false confidence the typed verdict exists to avoid.
const NOT_PERSON = new Set(["bike", "bikes", "ebike", "ebikes", "cycle", "cycles", "parts", "spares",
  "repairs", "repair", "rentals", "rental", "hire", "trade", "retail", "wholesales", "stock",
  "stockists", "dropship", "distributor", "distribution", "supply", "supplies", "supplier",
  "factory", "warehouse", "showroom", "quotes", "quote", "pricing", "prices", "quotations",
  "agent", "agents", "rep", "reps", "branch", "branches", "depot", "workshop", "clinic", "salon",
  "studios", "kitchen", "bakery", "cafe", "bar", "deli", "farm", "nursery", "gallery", "boutique",
  "clothing", "apparel", "fashion", "beauty", "skincare", "haircare", "jewellery", "jewelry",
  "coffee", "tea", "wine", "beer", "gifts", "gifting", "decor", "furniture", "lighting", "tools",
  "pets", "pet", "baby", "kids", "toys", "books", "music", "art", "prints", "photo", "photos",
  "events", "catering", "travel", "tours", "bookings", "reservations", "tickets", "classes",
  "courses", "training", "coaching", "therapy", "wellness", "fitness", "gym", "yoga", "spa",
  "payments", "payment", "invoice", "invoicing", "quotesa", "warranty", "guarantee", "claims",
  "tech", "it", "dev", "webmaster", "hostmaster", "postmaster", "abuse", "security", "privacy",
  "data", "gdpr", "popia", "compliance", "audit", "tax", "vat", "payroll", "recruitment", "jobs",
  "vacancies", "intern", "volunteer", "donate", "donations", "charity", "church", "school",
  // Mood/verb mailboxes a brand picks for warmth — relax@, glow@, ride@ — never a person.
  "relax", "unwind", "enjoy", "treat", "pamper", "glow", "shine", "thrive", "grow", "create",
  "build", "make", "play", "ride", "rock", "live", "love", "smile", "dream", "wander", "explore",
  "discover", "indulge", "savour", "savor", "taste", "sip", "brew", "bloom", "nourish", "heal",
  "guesthouse", "lodge", "hotel", "rooms", "venue", "restaurant", "takeaways", "frontdesk",
  // Product/system desks and automated senders — all seen misread as people in the first live batch.
  "product", "products", "item", "items", "goods", "catalogue", "catalog", "range", "collection",
  "ecom", "ecommerce", "digital", "updates", "update", "news", "alerts", "alert", "notifications",
  "system", "mailer", "bot", "auto", "automated", "robot", "noreply", "notify", "reply", "inbox",
  "message", "messages", "enquire", "hey", "howzit", "cheers", "regards"]);

// A mailbox built from the brand name, with or without a market/shop suffix — pawcarnivalsa@,
// shopbrand@, brand@ — reaches the shop, not a person. Matching on equality alone missed these
// and promoted them to "named", the exact mistake this script exists to stop.
const BRAND_AFFIX = /^(\d{1,4}|cs|sa|za|ke|ng|jp|rsa|shop|store|online|team|hq|co|sales|info|admin|mail|web|group|brand|official|the)$/;
function brandish(local, brands) {
  const bare = local.replace(/[^a-z0-9]/g, "");
  if (!bare) return false;
  for (const b of brands) {
    if (bare === b) return true;
    // Substring only for brand tokens long enough to be distinctive, and only when what's left
    // over is a known affix — otherwise "the" (from a store called "The …") would eat "Thembi".
    if (b.length >= 5 && bare.includes(b)) {
      const rest = bare.split(b).join("");
      if (!rest || BRAND_AFFIX.test(rest)) return true;
    }
  }
  return false;
}

/** named | role_targeted | role_generic — what kind of human (if any) is behind this address. */
function classifyEmail(email, brands) {
  const local = email.split("@")[0].toLowerCase().replace(/\+.*$/, "");
  const bare = local.replace(/[^a-z]/g, "");
  if (ROLE_TARGETED.has(local) || ROLE_TARGETED.has(bare)) return "role_targeted";
  if (ROLE_GENERIC.has(local) || ROLE_GENERIC.has(bare)) return "role_generic";
  if (brandish(local, brands)) return "role_generic";
  // Compound role mailboxes — onlinemanager@, salesteam@, headofbuying@ — are still roles. Only
  // tokens of 5+ characters are matched as substrings, so a surname can't be eaten by a short
  // role word ("md" inside "amanda" was the obvious trap).
  for (const r of ROLE_TARGETED) if (r.length >= 5 && bare.includes(r)) return "role_targeted";
  for (const r of ROLE_GENERIC) if (r.length >= 5 && bare.includes(r)) return "role_generic";
  for (const n of NOT_PERSON) if (n.length >= 6 && bare.includes(n)) return "role_generic";
  // first.last / first_last / f.last — two alpha tokens is a person almost every time.
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => /^[a-z]+$/.test(p)) && parts.some((p) => p.length >= 3)) {
    // owner.name@ style still reads as a role; a role token anywhere keeps it a role mailbox.
    if (parts.some((p) => ROLE_TARGETED.has(p))) return "role_targeted";
    if (parts.some((p) => ROLE_GENERIC.has(p))) return "role_generic";
    if (parts.some((p) => NOT_PERSON.has(p))) return "role_generic";
    return "named";
  }
  // A single plausible given name: alphabetic, 3-14 chars, not a role, not the brand, and not
  // commerce vocabulary. We can't prove it's a person without a name list, so this is the
  // honest floor — and contact_type is what the product filters on, so a wrong "named" is the
  // expensive error, not a conservative "role_generic".
  if (/^[a-z]{3,14}$/.test(local) && !NOT_PERSON.has(local)) return "named";
  return "role_generic";
}

const KIND_RANK = { named: 3, role_targeted: 2, role_generic: 1 };

/* ---- extraction ----------------------------------------------------------- */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

/** Every acceptable address on this page, in document order, with a mailto: bonus.
 *  `curated` = this page is a contact/about/policy page, where a freemail address is trustworthy. */
function emailsFrom(html, domain, curated) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const e = raw.trim().toLowerCase().replace(/[.,;:)\]}'"]+$/, "");
    if (seen.has(e) || !/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e)) return;
    if (EMAIL_JUNK.test(e)) return;
    if (PLACEHOLDER_LOCAL.has(e.split("@")[0].replace(/[^a-z-]/g, ""))) return;
    // Themes emit JSON-escaped markup, so an address scraped out of inline JSON can arrive with a
    // \u003e / \u0026 fragment welded to its local part (u003esupport@…). That is a mangled
    // duplicate of an address we already have, never a real mailbox.
    if (/u00[0-9a-f]{2}/i.test(e.split("@")[0])) return;
    const host = emailHost(e);
    const ours = sameOrg(host, domain);
    const free = FREEMAIL.test(e);
    // Own-domain always; freemail only off a curated page; anything else is a third party.
    if (!ours && !(free && curated)) return;
    seen.add(e);
    out.push(e);
  };
  // mailto: links first — an address someone deliberately linked beats one found in body copy.
  for (const m of html.matchAll(/mailto:([^"'?&<>\s]+)/gi)) push(decodeURIComponent(m[1]));
  for (const m of html.matchAll(EMAIL_RE)) push(m[0]);
  return out;
}

const digits = (s) => String(s || "").replace(/[^\d+]/g, "");
function whatsappFrom(html) {
  const m = html.match(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\/?([+\d]{7,20})/i);
  if (!m) return null;
  const d = digits(m[1]).replace(/^\+/, "");
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}
function phoneFrom(html) {
  const m = html.match(/tel:([+\d().\s-]{7,24})/i);
  if (!m) return null;
  const d = digits(m[1]);
  return d.replace(/\D/g, "").length >= 8 ? d : null;
}

const SOCIALS = {
  instagram: /instagram\.com\/([A-Za-z0-9_.]{2,30})/i,
  facebook: /facebook\.com\/([A-Za-z0-9_.-]{2,40})/i,
  tiktok: /tiktok\.com\/@([A-Za-z0-9_.]{2,30})/i,
  linkedin: /linkedin\.com\/(?:company|in)\/([A-Za-z0-9_.-]{2,60})/i,
};
const SOCIAL_JUNK = new Set(["sharer", "share", "intent", "tr", "plugins", "channel", "watch",
  "embed", "user", "c", "results", "hashtag", "p", "pin", "policy", "help", "login", "sharing"]);
function socialsFrom(html) {
  const out = {};
  for (const [net, re] of Object.entries(SOCIALS)) {
    const m = html.match(re);
    const v = m?.[1];
    if (v && !SOCIAL_JUNK.has(v.toLowerCase())) out[net] = v;
  }
  return out;
}

/** Visible text, scripts/styles stripped — what the name regexes and the local LLM read. */
function pageText(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&[a-z]{2,8};/gi, " ").replace(/\s+/g, " ").trim();
}

// A person's name: 1-3 capitalised words. Rejects the sentence-initial false positives that make
// naive "I'm X" matching useless ("I'm South African", "I'm So Glad").
const NAME = "([A-Z][a-z'’]{1,15}(?:\\s+(?:van|van der|von|de|du|le|la|da|dos|bin|al)\\s+)?(?:\\s[A-Z][a-z'’]{1,15}){0,2})";
const NAME_RULES = [
  new RegExp(`\\b(?:I'?m|I am)\\s+${NAME}`),
  new RegExp(`\\bmy name is\\s+${NAME}`, "i"),
  new RegExp(`\\b(?:founded|created|started|owned|run)\\s+by\\s+${NAME}`, "i"),
  new RegExp(`${NAME}\\s*[,–—-]\\s*(?:the\\s+)?(?:founder|owner|director|ceo|creator|maker)\\b`, "i"),
  new RegExp(`\\b(?:founder|owner|director|ceo|proprietor)\\s*[:–—-]\\s*${NAME}`, "i"),
];
// Words that pass the capitalisation test but are never a person.
const NOT_NAME = /^(South|North|East|West|New|The|Our|Your|My|This|That|All|Also|And|But|For|From|Here|Just|Made|Not|Now|One|Proudly|Really|Since|So|Still|Very|We|With|Africa|African|Cape|Johannesburg|Durban|Pretoria|Kenya|Nigeria|Japan|Shopify|Instagram|Facebook|Whatsapp|Covid|Welcome|Thank|Thanks|Please|Hello|Hi|Dear|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

// Anchored matches run off the end of the name ("founded by Jessica Timcke and her sister" →
// "Jessica Timcke and"). Trim the trailing connective words.
const tidyName = (v) => v.replace(/\s+(?:and|&|with|from|of|the|who|her|his|their|our)\b.*$/i, "").trim();

function nameFromText(text) {
  for (const re of NAME_RULES) {
    const m = text.match(re);
    const v = tidyName(m?.[1]?.trim() ?? "");
    if (v && !NOT_NAME.test(v) && v.length >= 3 && v.length <= 40) return v;
  }
  return null;
}
/** The Atom feed's <author><name> — a structured human name, one cheap GET, no guessing. */
function nameFromAtom(xml) {
  const m = xml.match(/<author>[\s\S]{0,200}?<name>([^<]{2,60})<\/name>/i);
  const v = m?.[1]?.trim();
  if (!v || NOT_NAME.test(v)) return null;
  // Feeds default the author to the store name — only keep what looks like a person.
  return /^[A-Z][a-z'’]+(\s+[A-Z][a-z'’]+){0,2}$/.test(v) ? v : null;
}
/** JSON-LD founder — structured, when a theme bothers to emit it. Deliberately NOT "author":
 *  on a store page that's a review or blog-post author (a CUSTOMER), and it produced a confident
 *  wrong name in testing. */
function nameFromJsonLd(html) {
  for (const m of html.matchAll(/"founder"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]{3,60})"/gi)) {
    const v = m[1].trim();
    if (!NOT_NAME.test(v) && /^[A-Z][a-z'’]+(\s+[A-Z][a-z'’]+){0,2}$/.test(v)) return v;
  }
  return null;
}
const ROLE_WORD = /\b(founder|co-?founder|owner|director|managing director|ceo|md|proprietor|creator|maker|buyer|manager)\b/i;

// Words that are never part of a person's name but turn up constantly in the page copy the
// extractors read. Measured, not imagined: every one of these appeared in a stored contact_name
// in the first live batch ("Details Call us", "built gaming rigs", "Egoli Gas", "Oak And Ore").
const NAME_STOP = new Set([
  "contact", "details", "detail", "call", "us", "we", "our", "your", "you", "my", "me", "the", "and",
  "or", "by", "to", "of", "for", "with", "from", "please", "click", "here", "more", "info",
  "information", "customer", "customers", "service", "services", "support", "help", "additional",
  "free", "shipping", "delivery", "returns", "subscribe", "newsletter", "sign", "email", "phone",
  "whatsapp", "address", "hours", "open", "closed", "legal", "age", "under", "over", "use", "using",
  "left", "right", "expand", "built", "build", "made", "new", "all", "shop", "store", "online",
  "order", "orders", "cart", "checkout", "price", "prices", "sale", "off", "gaming", "rigs",
  "parents", "tomorrow", "today", "resources", "unlimited", "sector", "gas", "oak", "ore", "pro",
  "auto", "rubber", "design", "designs", "synergy", "graphic", "graphics", "ebony", "wooden",
  "watch", "watches", "south", "north", "east", "west", "africa", "african", "cape", "town",
  "johannesburg", "durban", "pretoria", "kenya", "nigeria", "proudly", "quality", "premium",
  "best", "top", "official", "welcome", "thank", "thanks", "hello", "team", "founder", "owner",
  "director", "ceo", "manager", "staff", "group", "company", "brand", "brands", "collection",
  "leadership", "management", "sorry", "seasonal", "women", "womens", "mens", "ladies", "gents",
  "kids", "baby", "unisex",
  "size", "sizes", "colour", "color", "stock", "range", "gift", "gifts", "voucher",
]);
// Entity suffixes — if it carries one, it is a company, whatever shape the words are in.
const COMPANY_WORD = /\b(inc|ltd|limited|pty|cc|llc|plc|corp|corporation|co|gmbh|bv|nv|ou|oü|srl|sarl|holdings|enterprises|trading|supplies|supply|solutions|systems|industries|technologies|labs?|works|partners|associates|agency|studios?|collective|media|engineering|international|global)\b/i;
// Dutch/Afrikaans/Portuguese particles are legitimately lowercase inside an SA surname.
const PARTICLE = new Set(["van", "der", "den", "von", "de", "du", "le", "la", "da", "dos", "ter", "bin", "al"]);

/**
 * Does this read like an actual person's name? Applied to EVERY source, the local model's answer
 * included. Without it the permutation step was generating addresses like subscribe@, details@ and
 * legal@ from marketing copy the extractors had stored as people — guesses built on a bad name are
 * worse than no guess, because they look plausible in a CSV.
 */
/** Trim junk words off the ends of an extracted name. The holdout test found "Leadership Nicole
 *  Koopman" stored against a store whose real address was nicole@ — rejecting the whole string
 *  would have thrown away a correct answer, so strip the edges and judge what is left. */
function trimNameEdges(v) {
  let words = String(v || "").trim().split(/\s+/);
  const junk = (w) => NAME_STOP.has(w.toLowerCase().replace(/[^a-zà-ÿ'’-]/gi, ""));
  while (words.length > 1 && junk(words[0])) words.shift();
  while (words.length > 1 && junk(words[words.length - 1])) words.pop();
  return words.join(" ");
}

function looksLikePersonName(v) {
  if (!v) return false;
  if (/[0-9@&_/\\|:;,()<>"»«]/.test(v)) return false;          // punctuation/digits → not a name
  if (COMPANY_WORD.test(v)) return false;
  const words = v.trim().split(/\s+/);
  if (!words.length || words.length > 4) return false;
  const real = words.filter((w) => !PARTICLE.has(w.toLowerCase()));
  if (!real.length || real.length > 3) return false;
  for (const w of real) {
    // Title case, with a capital allowed after a hyphen or apostrophe: "Lerato", "O'Brien",
    // "Gert-Johan". Rejects "details" (lowercase start) and "SECTOR" (all caps) alike.
    if (w.length < 2 || w.length > 20) return false;
    if (!/^[A-ZÀ-Þ][a-zà-ÿ'’]{0,15}(?:[-'’][A-ZÀ-Þa-zà-ÿ][a-zà-ÿ'’]{0,15})*$/.test(w)) return false;
    if (NAME_STOP.has(w.toLowerCase())) return false;
  }
  return true;
}

/** A "person" whose every word is a brand token is the brand (anthonyleaps.com → "Anthony Leaps").
 *  Checked on EVERY name source, the local model's answer included — it was the model's one
 *  confident error in the validation sample.
 *
 *  `localParts` are the local-parts of the addresses we found on this store. A ONE-WORD name has
 *  to be corroborated by one of them (lerato@… backing "I'm Lerato"), because a lone capitalised
 *  word in body copy is as likely to be a product or a compound noun as a person — a German
 *  parts page yielded "Akkubetrieb" as a contact name before this guard. Two-word names stand on
 *  their own; they're far too specific a shape to appear by accident. */
function personName(v, brands, localParts = []) {
  if (!v) return null;
  v = trimNameEdges(v);
  if (!looksLikePersonName(v)) return null;
  const words = v.toLowerCase().split(/[^a-zà-ÿ]+/).filter((w) => w.length > 2);
  if (!words.length) return null;
  if (words.every((w) => brands.has(w))) return null;
  // Also catch the run-together form: "Anthony Leaps" against the domain token anthonyleaps.
  const joined = words.join("");
  for (const b of brands) if (b.length >= 5 && (b === joined || b.includes(joined) || joined.includes(b))) return null;
  if (words.length === 1) {
    const w = words[0];
    if (!localParts.some((lp) => lp === w || lp.startsWith(w) || w.startsWith(lp))) return null;
  }
  return v;
}

/* ---- the per-store crawl -------------------------------------------------- */
// Ordered contact surface. Shopify guarantees /pages/* and /policies/*; the bare /contact and
// /about cover every other CMS. Cheapest-and-richest first, because the fetch budget is small.
// `shaped` entries are the Shopify-shaped ones; we try them first on a Shopify store and last
// otherwise, and abandon them entirely after two 404s (the platform label was wrong, or the
// merchant renamed their pages) rather than spending the whole budget on a 404 page.
const SURFACE = [
  { path: "/pages/contact", curated: true, shaped: true },
  { path: "/policies/contact-information", curated: true, shaped: true },
  { path: "/pages/contact-us", curated: true, shaped: true },
  { path: "/pages/about", curated: true, shaped: true },
  { path: "/policies/refund-policy", curated: true, shaped: true },
  { path: "/blogs/news.atom", curated: false, atom: true, shaped: true },
  { path: "/pages/about-us", curated: true, shaped: true },
  { path: "/policies/terms-of-service", curated: true, shaped: true },
  { path: "/policies/legal_notice", curated: true, shaped: true },
  { path: "/contact", curated: true },
  { path: "/contact-us", curated: true },
  { path: "/about", curated: true },
  { path: "/about-us", curated: true },
];
const orderedSurface = (isShopify) => {
  const shaped = SURFACE.filter((s) => s.shaped), generic = SURFACE.filter((s) => !s.shaped);
  return isShopify ? [...shaped, ...generic] : [...generic, ...shaped];
};

/**
 * One store's crawl. `nextProxy()` is called PER FETCH, not per store: a store's pages are
 * requested in a recognisable sequence (/, /pages/contact, /policies/…) and running that whole
 * sequence down one egress IP is what triggered Shopify's 429s in testing. Rotating per fetch,
 * pausing between them, and retrying a 429 once on a fresh IP took the throttle rate from 75%
 * to usable.
 */
async function crawlStore(store, nextProxy) {
  const d = clean(store.domain);
  const brands = brandTokens(d, store.name, store.category);
  const found = new Map();          // email -> {kind, source}
  let name = null, nameSource = null, proseName = null, role = null, phone = null, wa = null, form = null, socials = {}, text = "";
  // Record a name only if it survives the brand check, and remember WHERE it came from: a name
  // lifted from the site's own copy is worth more to a customer than one a model inferred.
  const localParts = () => [...found.keys()].map((e) => e.split("@")[0].toLowerCase().replace(/[^a-z]/g, ""));
  const setName = (v, src) => {
    const ok = personName(v, brands, localParts());
    if (ok && !name) { name = ok; nameSource = src; }
  };
  let fetches = 0, reachable = false, rateLimited = false;

  // A GET that treats 429/503 as "come back on another IP", once.
  const grab = async (path) => {
    let r = await fetchText(`https://${d}${path}`, { proxy: nextProxy() });
    fetches++;
    if (throttled(r) || !r) {
      await sleep(1500 + Math.floor(Math.random() * 2000));
      r = await fetchText(`https://${d}${path}`, { proxy: nextProxy() });
      fetches++;
    }
    if (VERBOSE) console.log(`    [${d}] ${path}  ${r ? `status=${r.status} bytes=${r.text.length}` : "NULL"}`);
    return r;
  };

  const absorb = (html, path, curated) => {
    for (const e of emailsFrom(html, d, curated)) {
      if (!found.has(e)) found.set(e, { kind: classifyEmail(e, brands), source: path });
    }
    wa ??= whatsappFrom(html);
    phone ??= phoneFrom(html);
    for (const [k, v] of Object.entries(socialsFrom(html))) socials[k] ??= v;
    if (!name) setName(nameFromJsonLd(html), "jsonld");
    if (curated) {
      const t = pageText(html);
      if (t.length > 80) text = (text + " " + t).trim().slice(0, 8000);
      // NOT setName() — measured against ground truth (scripts/contact-name-eval.mjs) the prose
      // rules score 13% precision and 1% recall, i.e. 7 wrong names for every right one. They used
      // to run BEFORE the local model, so the worst source pre-empted the best. Held back as a
      // last resort for when no model is available at all.
      if (!proseName) proseName = nameFromText(t);
      if (name && !role) role = t.match(ROLE_WORD)?.[0]?.toLowerCase() ?? null;
    }
  };

  const bestKind = () => [...found.values()].reduce((b, v) => Math.max(b, KIND_RANK[v.kind] ?? 0), 0);
  const satisfied = () => bestKind() === 3 && !!name;

  // Homepage: cheap, and the only page many stores have. Not "curated" — theme markup here is
  // full of third-party addresses, so freemail found here is not trusted.
  // A null is a NETWORK failure, which at fleet scale is usually a dead proxy rather than a dead
  // store — so retry once on a different egress before writing the store off. Without this a
  // flaky proxy stamps contact_checked_at on a live store and it drops out of the queue for
  // months (measured: a reachable store reported unreachable on the first pass).
  const home = await grab("/");
  if (!home) return { domain: d, unreachable: true };
  if (throttled(home)) return { domain: d, throttled: true, fetches };
  // Record the storefront's HTTP status on every crawl. It costs nothing — we have already made
  // the request — and 402 in particular is Shopify's FROZEN-STORE code: the merchant has stopped
  // paying. Measured at ~3% of live-tagged ZA Shopify stores, so it is a real churn signal the
  // liveness lane isn't collecting. Deliberately NOT written to live_status/died_at: churn
  // accounting has historic-vs-forward rules that belong to that lane, so this just banks the
  // observation for it to act on.
  const storefrontHttp = home.status;
  // A frozen, locked or blocked storefront has no contact to find — it isn't "no contact
  // published", it's "not open". Recording it as a contact verdict would understate coverage.
  const CLOSED = new Set([401, 402, 403, 423, 451]);
  if (CLOSED.has(home.status)) return { domain: d, closed: true, storefrontHttp, fetches };
  if (home.status >= 200 && home.status < 400 && /html/i.test(home.contentType)) {
    reachable = true;
    absorb(home.text, "/", false);
  }

  const isShopify = (store.platform || "").toLowerCase() === "shopify";
  let shapedMisses = 0;
  for (const s of orderedSurface(isShopify)) {
    if (fetches >= MAX_FETCHES || satisfied()) break;
    if (s.shaped && shapedMisses >= 2) continue;     // not Shopify-shaped after all — stop guessing
    if (DELAY_MS) await sleep(DELAY_MS + Math.floor(Math.random() * DELAY_MS));
    const r = await grab(s.path);
    if (throttled(r)) { rateLimited = true; break; }  // stop; keep what we have, don't record a verdict
    if (!r || r.status < 200 || r.status >= 300) {
      // Only a real "no such page" is evidence about the store's shape. A 429 or a network null
      // says nothing, and counting it abandoned the Shopify paths on perfectly Shopify stores.
      if (s.shaped && r && (r.status === 404 || r.status === 410)) shapedMisses++;
      continue;
    }
    reachable = true;
    if (s.atom) { if (!name) setName(nameFromAtom(r.text), "atom"); continue; }
    if (!/html/i.test(r.contentType)) continue;
    if (/contact/.test(s.path) && !form) form = `https://${d}${s.path}`;
    absorb(r.text, s.path, s.curated);
  }

  // The store's own imported address is a candidate too — often the generic one, sometimes not.
  if (store.email) {
    const e = String(store.email).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e) && !EMAIL_JUNK.test(e) && !found.has(e)) {
      found.set(e, { kind: classifyEmail(e, brands), source: "import" });
    }
  }

  // Rank: kind first, then a curated page over the homepage footer, then discovery order.
  const srcRank = (s) => (s === "import" ? 0 : s === "/" ? 1 : 2);
  const contacts = [...found.entries()]
    .map(([email, v]) => ({ email, kind: v.kind, source: v.source }))
    .sort((a, b) => (KIND_RANK[b.kind] - KIND_RANK[a.kind]) || (srcRank(b.source) - srcRank(a.source)))
    .slice(0, 6);

  return {
    domain: d, reachable, fetches, contacts, name, nameSource, role, phone, wa, form, socials, text,
    brands, localParts: localParts(), proseName, storefrontHttp,
    best: contacts[0] ?? null,
    // Partial crawl: record nothing, re-queue. A verdict from a throttled crawl is a false negative.
    throttled: rateLimited && !contacts.length,
  };
}

/* ---- local-LLM name pass (free; never paid unless explicitly opted in) ----- */
function namePrompt(r) {
  return `Below is the contact/about copy from the website ${r.domain}.

"""
${r.text.slice(0, 3500)}
"""

Who is the individual person that runs this business, if the text names one?
Rules: use ONLY the text above. A brand, shop, product or place name is NOT a person. If no
individual is named, return null. Do not guess.
Respond with ONLY minified JSON: {"name": "<full name or null>", "role": "<their role or null>"}`;
}
function parseName(txt) {
  const p = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] ?? txt);
  const nm = typeof p.name === "string" && p.name.trim() && !/^(null|none|n\/a|unknown)$/i.test(p.name.trim())
    ? p.name.trim().slice(0, 60) : null;
  const role = typeof p.role === "string" && p.role.trim() && !/^(null|none|n\/a|unknown)$/i.test(p.role.trim())
    ? p.role.trim().toLowerCase().slice(0, 40) : null;
  return { name: nm && !NOT_NAME.test(nm) ? nm : null, role: nm ? role : null };
}
async function askLocal(r) {
  const res = await fetch(`${LOCAL_LLM_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: LOCAL_LLM_MODEL,
      messages: [{ role: "user", content: namePrompt(r) }],
      max_tokens: 120, temperature: 0,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`local LLM ${res.status}`);
  const data = await res.json();
  return parseName(data.choices?.[0]?.message?.content ?? "");
}

/* ---- verdict -------------------------------------------------------------- */
// What the product shows and filters on. `named` = an address that reaches a person;
// `role_targeted` = a decision-maker's role mailbox; `role_generic` = the info@ queue;
// `form_only` = no address but a reachable contact form; `none` = nothing to send to.
function contactType(r) {
  if (r.best) return r.best.kind;
  if (r.form) return "form_only";
  return "none";
}

/* ---- main ----------------------------------------------------------------- */
// Run ONCE via --migrate. Two deliberate choices, both learned the hard way on this table:
//  - lock_timeout: ALTER TABLE wants ACCESS EXCLUSIVE. If a long-running query holds a weaker
//    lock, the ALTER queues — and every statement arriving behind it queues too, which is how a
//    one-second schema change stalled the discovery pipeline for ten hours. Failing fast after
//    3s is strictly better: re-run it, don't block the fleet.
//  - CONCURRENTLY on the indexes: a plain CREATE INDEX on a 100k+ row table holds a write lock
//    for its whole build. CONCURRENTLY cannot run inside a transaction, which is why each
//    statement here is issued standalone.
const DDL = [
  "SET lock_timeout = '3s'",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contacts JSONB",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_type TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_name TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_role TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_name_source TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS whatsapp TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS linkedin TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_form_url TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_source TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_text TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_checked_at TIMESTAMPTZ",
  "RESET lock_timeout",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS storefront_http INTEGER",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS storefront_checked_at TIMESTAMPTZ",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_claimed_by TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_claimed_at TIMESTAMPTZ",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_is_contact_type ON imported_stores(contact_type) WHERE published",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_is_contact_checked ON imported_stores(contact_checked_at DESC NULLS LAST)",
];

async function main() {
  const pool = USE_PROXY ? loadProxies() : [];
  if (!DRY) {
    console.log(pool.length
      ? `egress: ${pool.length}-proxy fleet (--proxy) — expect 429s on Shopify HTML`
      : `egress: direct, ${CONC} workers × ${DELAY_MS}ms — the lane that measured clean`);
  }

  if (DOMAINS.length && OFFLINE) {
    // Pure-extractor path: crawl the given domains with no DB at all. --dry still goes through the
    // DB so a spot-check sees the real platform/name/email a store carries.
    for (const domain of DOMAINS) {
      const r = await crawlStore({ domain, platform: arg("--platform", "shopify") }, () => pickProxy(pool));
      if (r.unreachable) { console.log(`✗ ${domain}  unreachable`); continue; }
      if (r.throttled) { console.log(`~ ${domain}  rate-limited (429) — no verdict recorded`); continue; }
      if (r.closed) { console.log(`⊘ ${domain}  storefront closed (HTTP ${r.storefrontHttp}) — 402 means the merchant stopped paying`); continue; }
      console.log(`● ${r.domain}  [${r.fetches} fetches]  type=${contactType(r)}`);
      for (const c of r.contacts) console.log(`    ${c.kind.padEnd(14)} ${c.email}   (${c.source})`);
      console.log(`    name=${r.name ?? "-"}  role=${r.role ?? "-"}  wa=${r.wa ?? "-"}  phone=${r.phone ?? "-"}  form=${r.form ? "y" : "-"}  text=${r.text.length}ch`);
    }
    closeAgents();
    return;
  }

  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: Math.min(CONC + 1, 8), idle_timeout: 20 });
  try {
    if (REVALIDATE) {
      const rows = await sql`SELECT domain, contact_name, contact_name_source, contact_email, email
        FROM imported_stores WHERE contact_name IS NOT NULL`;
      let kept = 0, dropped = 0;
      const bySource = new Map();
      for (const r of rows) {
        const brands = brandTokens(r.domain, null, null);
        const localParts = [r.contact_email, r.email].filter(Boolean)
          .map((e) => String(e).split("@")[0].toLowerCase().replace(/[^a-z]/g, ""));
        const ok = personName(r.contact_name, brands, localParts);
        const tally = bySource.get(r.contact_name_source ?? "?") ?? { kept: 0, dropped: 0 };
        if (ok) {
          kept++; tally.kept++;
          // personName trims junk off the edges; persist the cleaned form, since the permutation
          // step reads this column and "Leadership Nicole Koopman" guesses leadership@.
          if (ok !== r.contact_name) {
            if (DRY) console.log(`  trim  ${r.domain.padEnd(34)} "${r.contact_name}" → "${ok}"`);
            else await sql`UPDATE imported_stores SET contact_name = ${ok} WHERE domain = ${r.domain}`.catch(() => {});
          }
        }
        else {
          dropped++; tally.dropped++;
          if (DRY) console.log(`  drop  ${String(r.contact_name_source ?? "?").padEnd(7)} ${r.domain.padEnd(34)} "${r.contact_name}"`);
          else await sql`UPDATE imported_stores SET contact_name = NULL, contact_role = NULL,
            contact_name_source = NULL WHERE domain = ${r.domain}`.catch(() => {});
        }
        bySource.set(r.contact_name_source ?? "?", tally);
      }
      console.log(`\nrevalidate${DRY ? " [DRY]" : ""}: ${kept} kept, ${dropped} dropped of ${rows.length}`);
      for (const [src, t] of [...bySource].sort((a, b) => b[1].kept + b[1].dropped - a[1].kept - a[1].dropped)) {
        const tot = t.kept + t.dropped;
        console.log(`  ${src.padEnd(8)} kept ${String(t.kept).padStart(3)}/${String(tot).padStart(3)}  (${Math.round(100 * t.kept / tot)}% precision)`);
      }
      return;
    }
    if (MIGRATE) {
      // DDL is deliberately opt-in: ALTER TABLE takes an ACCESS EXCLUSIVE lock and has stalled the
      // discovery pipeline for hours before. Run --migrate ONCE, in a quiet window, on its own.
      for (const q of DDL) {
        console.log(q.slice(0, 76) + (q.length > 76 ? "…" : ""));
        try { await sql.unsafe(q); }
        catch (e) {
          // A lock_timeout here means the table was busy, not that the migration is wrong.
          if (/lock timeout|canceling statement/i.test(e.message)) {
            console.error(`  ✗ ${e.message}\n  Table busy — nothing was changed by this statement. Re-run --migrate when the pipeline is idle.`);
            process.exit(4);
          }
          throw e;
        }
      }
      console.log("migrated.");
      return;
    }

    const rows = DOMAINS.length
      ? await sql`SELECT domain, name, email, platform, category FROM imported_stores WHERE domain = ANY(${DOMAINS})`
      : await sql`
        -- Atomic claim-and-take. FOR UPDATE SKIP LOCKED means two workers racing at the same
        -- instant get disjoint sets instead of the same rows; the claim timestamp means a worker
        -- that dies mid-run releases its rows after CLAIM_TTL rather than stranding them.
        UPDATE imported_stores s
           SET contact_claimed_by = ${HOST}, contact_claimed_at = now()
          FROM (
        SELECT domain FROM imported_stores
        WHERE published
          AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
          AND activity_tier IS DISTINCT FROM 'not_a_store'
          AND UPPER(country) = ANY(${countries.length ? countries : MARKETS})
          ${platArg === "shopify" ? sql`AND LOWER(platform) = 'shopify'`
            : platArg === "non-shopify" ? sql`AND (platform IS NULL OR LOWER(platform) <> 'shopify')`
            : platArg ? sql`AND LOWER(platform) = ${platArg}` : sql``}
          AND (contact_checked_at IS NULL OR contact_checked_at < now() - (${REPROBE_DAYS} || ' days')::interval)
          AND (contact_claimed_at IS NULL OR contact_claimed_at < now() - ${CLAIM_TTL}::interval)
        -- Worst-first by value: the stores a customer is most likely to pitch, and the ones where a
        -- generic-only contact costs us the most, get a named contact earliest.
        ORDER BY ${SAMPLE ? sql`random()` : sql`(contact_type IS NULL) DESC, estimated_monthly_sales DESC NULLS LAST`}
        LIMIT ${LIMIT}
        FOR UPDATE SKIP LOCKED
          ) c
         WHERE s.domain = c.domain
     RETURNING s.domain, s.name, s.email, s.platform, s.category`;

    if (!rows.length) { console.log("nothing to do — every candidate store has a fresh contact check."); return; }

    // The residential IP's Shopify-edge budget is shared with every other probe on this machine,
    // so the protection here is PACE, not egress spread: a few workers, a pause between pages.
    if (CONC > 4 && !FORCE_DIRECT) {
      console.error(`refusing --concurrency ${CONC}: this crawl shares one IP's Shopify-edge budget with the\n`
        + "payment probes. Keep it ≤4 (measured clean at 2), or pass --force-direct if you mean it.");
      process.exit(3);
    }

    console.log(`contact-enrich: ${rows.length} store(s) claimed by ${HOST}${platArg ? ` [${platArg}]` : ""}${DRY ? " [DRY]" : ""} · ≤${MAX_FETCHES} fetches each · conc ${CONC}`
      + `${NO_LLM || !LOCAL_LLM_URL ? "" : ` · local LLM ${LOCAL_LLM_MODEL}`}`);

    const tally = { named: 0, role_targeted: 0, role_generic: 0, form_only: 0, none: 0 };
    let done = 0, unreachable = 0, named = 0, llmCalls = 0, rateLimitHits = 0, closed = 0;

    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, rows.length) }, async () => {
      while (cursor < rows.length) {
        const store = rows[cursor++];
        let r;
        try { r = await crawlStore(store, () => pickProxy(pool)); }
        catch (e) { console.log(`  ! ${store.domain}: ${e.message}`); done++; continue; }

        if (r.closed) {
          closed++; done++;
          if (!DRY) {
            await sql`UPDATE imported_stores SET storefront_http = ${r.storefrontHttp},
              storefront_checked_at = now(), contact_checked_at = now()
              WHERE domain = ${store.domain}`.catch(() => {});
          }
          if (VERBOSE) console.log(`  ⊘ ${store.domain}: storefront closed (HTTP ${r.storefrontHttp})`);
          continue;
        }
        if (r.throttled) {
          rateLimitHits++; done++;
          if (VERBOSE || rateLimitHits === 1) console.log(`  ~ ${store.domain}: rate-limited (429) — left in the queue`);
          await sleep(2000 + Math.floor(Math.random() * 3000));   // back off this worker, don't dig in
          continue;
        }
        if (r.unreachable) {
          unreachable++; done++;
          // Stamp it so a dead domain doesn't re-queue every run; liveness owns the dead/alive call.
          if (!DRY) await sql`UPDATE imported_stores SET contact_checked_at = now() WHERE domain = ${store.domain}`.catch(() => {});
          continue;
        }

        // Only pay for the model when the free extractors came up empty AND there's copy to read.
        if (!NO_LLM && !r.name && r.text.length > 200 && (LOCAL_LLM_URL || ALLOW_PAID)) {
          if (!LOCAL_LLM_URL && ALLOW_PAID) {
            // Paid is opt-in for the category pass, not wired here: naming a person is exactly the
            // job the local box was bought for. Skip rather than silently bill.
          } else {
            try {
              const g = await askLocal(r);
              const ok = personName(g.name, r.brands, r.localParts);
              if (ok) { r.name = ok; r.nameSource = "llm"; r.role ??= g.role; }
              llmCalls++;
            }
            catch (e) { if (llmCalls === 0) console.log(`  ! local LLM unavailable (${e.message}) — regex only`); }
          }
        }

        // Last resort only: a weak name beats no name when there is no model, but it must never
        // outrank one.
        if (!r.name && r.proseName) {
          const ok = personName(r.proseName, r.brands, r.localParts);
          if (ok) { r.name = ok; r.nameSource = "copy"; }
        }

        const t = contactType(r);
        tally[t]++;
        if (t === "named") named++;
        done++;

        if (DRY) {
          console.log(`● ${r.domain}  ${t.padEnd(13)} ${r.best?.email ?? "-"}  name=${r.name ?? "-"}${r.nameSource ? `(${r.nameSource})` : ""}  wa=${r.wa ?? "-"}  [${r.fetches}f]`);
        } else {
          await sql`
            UPDATE imported_stores SET
              contacts          = ${r.contacts.length ? sql.json(r.contacts) : null},
              contact_type      = ${t},
              contact_email     = ${r.best?.email ?? null},
              contact_source    = ${r.best?.source ?? null},
              contact_name      = ${OVERWRITE ? sql`${r.name ?? null}` : sql`COALESCE(${r.name ?? null}, contact_name)`},
              contact_name_source = ${OVERWRITE ? sql`${r.nameSource ?? null}` : sql`COALESCE(${r.nameSource ?? null}, contact_name_source)`},
              contact_role      = ${OVERWRITE ? sql`${r.role ?? null}` : sql`COALESCE(${r.role ?? null}, contact_role)`},
              contact_phone     = COALESCE(${r.phone ?? null}, contact_phone),
              whatsapp          = COALESCE(${r.wa ?? null}, whatsapp),
              linkedin          = COALESCE(${r.socials.linkedin ?? null}, linkedin),
              instagram         = COALESCE(instagram, ${r.socials.instagram ?? null}),
              facebook          = COALESCE(facebook, ${r.socials.facebook ?? null}),
              tiktok            = COALESCE(tiktok, ${r.socials.tiktok ?? null}),
              contact_form_url  = COALESCE(${r.form ?? null}, contact_form_url),
              contact_text      = COALESCE(${r.text || null}, contact_text),
              storefront_http   = ${r.storefrontHttp ?? null},
              storefront_checked_at = now(),
              contact_checked_at = now()
            WHERE domain = ${r.domain}`.catch((e) => console.log(`  ! write ${r.domain}: ${e.message}`));
          console.log(`✓ ${r.domain}  →  ${t}${r.best ? `  ${r.best.email}` : ""}${r.name ? `  (${r.name})` : ""}`);
        }
        if (done % 25 === 0) console.log(`— ${done}/${rows.length}  named:${named}  unreachable:${unreachable}`);
      }
    }));

    const pct = (n) => (done ? `${Math.round((n / done) * 100)}%` : "0%");
    console.log(`\nDone. ${done} store(s), ${unreachable} unreachable, ${closed} closed storefronts (402/403/423), ${rateLimitHits} rate-limited (re-queued), ${llmCalls} local-LLM calls.`);
    if (rateLimitHits > done * 0.1) console.log("  ⚠ >10% rate-limited — raise --delay-ms, lower --concurrency, or check the proxy fleet.");
    console.log(`  named          ${String(tally.named).padStart(6)}  ${pct(tally.named)}   ← reaches a person`);
    console.log(`  role_targeted  ${String(tally.role_targeted).padStart(6)}  ${pct(tally.role_targeted)}   ← owner@/accounts@/press@`);
    console.log(`  role_generic   ${String(tally.role_generic).padStart(6)}  ${pct(tally.role_generic)}   ← info@/hello@`);
    console.log(`  form_only      ${String(tally.form_only).padStart(6)}  ${pct(tally.form_only)}`);
    console.log(`  none           ${String(tally.none).padStart(6)}  ${pct(tally.none)}`);
  } finally { await sql.end(); closeAgents(); }
}

// Exported so other scripts (the name evaluator, any future extractor) judge names by exactly the
// same rules this one does — a second copy of the validator would drift and the measurements
// would stop being comparable.
export { looksLikePersonName, trimNameEdges, personName, brandTokens, classifyEmail, pageText, nameFromText, nameFromJsonLd };

// Only crawl when run directly; importing this module must not kick off a sweep.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error("failed:", e.message); closeAgents(); process.exit(1); });
}

/** Clone-vs-commerce scoring — the single source of truth for how Radar decides
 *  that catalogue overlap is FRAUD rather than ordinary retail.
 *
 *  Imported by both sweep entry points (lib/radar/fraud-sweep.ts for the admin
 *  button, scripts/radar-fraud-sweep.mjs for the 4-hourly pipeline) so the two
 *  can never drift. Pure functions, no DB or network.
 *
 *  THE PROBLEM THIS SOLVES
 *  The original sweep scored purely on shared product images:
 *      score = sharedImages / min(victimImages, suspectImages)
 *  That measures "do these sell the same products", which in retail is normally
 *  yes and innocent. It flagged distributors against their own stockists
 *  (ruggeddistribution.com vs ass-savers.co.za), brands against their resellers
 *  (lattafaperfumes.co.za vs dubaiperfumesa.co.za) and companies against their
 *  own second store (fo-ti.co.za vs medicoherbs.co.za).
 *
 *  THE FIX — two independent axes, and both must be high:
 *    OVERLAP        how much catalogue is shared, weighted by how RARE those
 *                   products are. A product carried by 12 stores is a
 *                   distributed brand and proves nothing; one carried by
 *                   exactly 2 is exclusive and proves a lot.
 *    IMPERSONATION  evidence of intent to deceive — lookalike domain, victim's
 *                   brand in the suspect's name, duplicated theme, bulk-imported
 *                   catalogue, no real business stack, implausible pricing.
 *
 *  Sharing a catalogue is a RELATIONSHIP. Sharing a catalogue while pretending to
 *  be someone else is FRAUD. Only the second gets reported. */

export const TUNING = {
  MAX_STEM_STORES: 16,   // a product on more stores than this is a distributed brand
  MIN_SHARED: 4,         // raw shared images before a pair is even considered
  MIN_WEIGHTED: 2.5,     // rarity-weighted shared images required
  MIN_OVERLAP: 30,       // below this the catalogue link is too weak to matter
  MIN_IMPERSONATION: 35, // below this it's commerce, not fraud — suppressed
  MIN_CORROBORATION: 20,            // evidence beyond the domain itself
  MIN_CORROBORATION_SAME_NAME: 40,  // identical brand name on another TLD is usually the merchant's own
  COPY: { overlap: 60, impersonation: 60 },
  LIKELY: { overlap: 45, impersonation: 40 },
  HIGH: 40, MED: 20, LOW: 10,
};

/* ---------------------------------------------------------------- domains -- */

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "or", "ne"]);

/** Registrable label: "shop.burnt.co.za" -> "burnt" */
export function label(domain) {
  const d = (domain || "").toLowerCase();
  if (d.endsWith(".myshopify.com")) return d.slice(0, -".myshopify.com".length);
  const parts = d.split(".");
  if (parts.length > 1) parts.pop();
  if (parts.length > 1 && SECOND_LEVEL.has(parts[parts.length - 1])) parts.pop();
  return parts.join(".");
}

const HOMO = [[/rn/g, "m"], [/vv/g, "w"], [/0/g, "o"], [/1/g, "l"], [/5/g, "s"], [/3/g, "e"]];
/** Fold homoglyphs and punctuation so "b-urnt" and "burnt" compare equal. */
export function canon(s) {
  let o = (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [re, to] of HOMO) o = o.replace(re, to);
  return o;
}

/** Hosts that aren't independent storefronts — checkout.underarmour.co.za was
 *  being reported as a clone victim, which is just a subdomain of the real shop. */
const NON_STORE_SUB = new Set(["checkout", "cart", "pay", "payment", "admin", "api", "cdn", "assets", "static"]);
/** Registrable domain — "shop.mercianhockey.co.za" -> "mercianhockey.co.za".
 *  Two hosts under one registration are the same site, never a clone pair. */
export function registrable(domain) {
  const d = (domain || "").toLowerCase().replace(/^www\./, "");
  if (d.endsWith(".myshopify.com")) return d;
  const parts = d.split(".");
  if (parts.length <= 2) return d;
  const tail = parts.slice(-2);
  if (SECOND_LEVEL.has(tail[0])) return parts.slice(-3).join(".");
  return tail.join(".");
}

export function isNonStoreHost(domain) {
  const first = (domain || "").toLowerCase().split(".")[0];
  return NON_STORE_SUB.has(first);
}

const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s) => (s || "").replace(/\D/g, "");

/** Contact/social values that identify a THEME or PLATFORM rather than a merchant.
 *  Scraped footers leak these: info@stagheaddesigns.com appears on 56 stores (the
 *  theme author), instagram "shopify" on 79 (the default footer link),
 *  ecom-swiper@11.css is a CSS artifact mis-parsed as an email. */
const JUNK_VALUE = /^(shopify|instagram|facebook|tiktok|home|null|none|n\/a|xxx|test|example)$/i;
const JUNK_EMAIL = /@(\d|.*\.(css|js|png|jpg|svg)$)|^(xxx|test|example|no-?reply)@/i;
const IDENTITY_FIELDS = ["contact_email", "email", "contact_phone", "merchant_name", "instagram", "facebook", "tiktok"];

/** How many stores carry each identity value, so a value can be judged specific
 *  enough to prove common ownership. Same inverse-frequency idea as product
 *  rarity: a value on 56 stores identifies a supplier, not an owner. */
export function valueFanout(stores) {
  const fan = new Map();
  for (const st of stores)
    for (const f of IDENTITY_FIELDS) {
      const v = normValue(f, st[f]);
      if (!v) continue;
      const k = `${f}:${v}`;
      fan.set(k, (fan.get(k) ?? 0) + 1);
    }
  return fan;
}

function normValue(field, raw) {
  let v = (raw == null ? "" : String(raw)).trim().toLowerCase();
  if (!v) return null;
  if (field === "contact_phone") { v = v.replace(/\D/g, ""); return v.length >= 9 ? v : null; }
  v = v.replace(/^https?:\/\/(www\.)?(instagram|facebook|tiktok)\.com\//, "").replace(/\/+$/, "");
  v = v.replace(/^@/, "");
  if (!v || JUNK_VALUE.test(v)) return null;
  if (field.includes("email")) {
    if (!v.includes("@") || JUNK_EMAIL.test(v)) return null;
  } else if (v.length < 4) return null;
  return v;
}

/** Max stores an identity value may appear on and still prove common ownership. */
const MAX_IDENTITY_FANOUT = 3;

/** Same merchant running both stores — not a clone.
 *
 *  Deliberately does NOT treat a shared domain stem as proof of common ownership.
 *  The old rule ("one label contains the other, 5+ chars") suppressed
 *  burnt.co.za <- burntstudiospro.co.za — the one CONFIRMED fraud case — because
 *  "burntstudiospro" contains "burnt". Domain containment is ambiguous: it is
 *  either the same owner or someone wearing the brand's name. So ownership is
 *  decided only on corroborating identity we actually collect, and the domain
 *  relationship is scored as impersonation evidence instead (see lookalikeSignal).
 *
 *  `fanout` (from valueFanout) keeps shared theme-vendor contact details from
 *  being mistaken for shared ownership. */
export function sameOperator(a, b, fanout) {
  for (const f of IDENTITY_FIELDS) {
    const x = normValue(f, a[f]), y = normValue(f, b[f]);
    if (!x || x !== y) continue;
    if (fanout && (fanout.get(`${f}:${x}`) ?? 0) > MAX_IDENTITY_FANOUT) continue; // shared by many stores => not an owner
    return `shared ${f.replace("_", " ")} (${x})`;
  }
  return null;
}

/** How the suspect's domain relates to the victim's — the lookalike axis.
 *  Returns null, or { points, reason }. */
export function lookalikeSignal(victimDomain, suspectDomain) {
  const v = canon(label(victimDomain)), s = canon(label(suspectDomain));
  if (!v || !s || v.length < 4) return null;
  if (v === s) return { points: TUNING.HIGH, reason: `same brand name on a different domain (${label(suspectDomain)})` };
  if (s.includes(v)) return { points: TUNING.HIGH, reason: `domain wraps the brand name "${label(victimDomain)}"` };
  if (v.includes(s) && s.length >= 5) return { points: TUNING.MED, reason: `domain is a truncation of "${label(victimDomain)}"` };
  if (editDistance(v, s) <= (v.length >= 8 ? 2 : 1)) return { points: TUNING.HIGH, reason: `near-identical spelling to "${label(victimDomain)}"` };
  return null;
}

/** Bounded Levenshtein — only used on short domain labels. */
export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/* ---------------------------------------------------------------- overlap -- */

/** How many distinct stores carry each image stem. */
export function stemFanout(stores) {
  const fan = new Map();
  for (const s of stores) for (const stem of s.stems) if (stem) fan.set(stem, (fan.get(stem) ?? 0) + 1);
  return fan;
}

/** Rarity weight for a product carried by `n` stores. 2 stores -> 1.0 (exclusive),
 *  decaying to 0 at MAX_STEM_STORES where it's plainly a distributed catalogue. */
export function stemWeight(n) {
  if (!n || n < 2) return 0;
  if (n >= TUNING.MAX_STEM_STORES) return 0;
  return Math.max(0, 1 - Math.log2(n - 1) / Math.log2(TUNING.MAX_STEM_STORES - 1));
}

/** Catalogue-overlap analysis for one victim->suspect pair. */
export function overlapSignals(victim, suspect, fanout) {
  let shared = 0, weighted = 0, exclusive = 0;
  for (const stem of suspect.stems) {
    if (!victim.stems.has(stem)) continue;
    shared++;
    const n = fanout.get(stem) ?? 2;
    weighted += stemWeight(n);
    if (n <= 2) exclusive++;
  }
  const suspectSize = Math.max(1, suspect.stems.size);
  const victimSize = Math.max(1, victim.stems.size);
  const suspectContainment = shared / suspectSize;  // how much of the suspect is the victim's
  const victimContainment = shared / victimSize;
  const rarity = shared ? weighted / shared : 0;    // 0..1 — how exclusive the shared items are
  const score = Math.round(100 * suspectContainment * rarity);

  const reasons = [];
  if (shared) reasons.push(`${shared} identical product images shared with ${victim.domain}`);
  if (exclusive) reasons.push(`${exclusive} of them appear on no other store in the market`);
  if (rarity && rarity < 0.35) reasons.push(`shared products are widely distributed (rarity ${rarity.toFixed(2)}) — looks like a supply relationship`);
  if (suspectContainment >= 0.8) reasons.push(`${Math.round(100 * suspectContainment)}% of this store's catalogue comes from ${victim.domain}`);
  return { shared, weighted, exclusive, rarity, suspectContainment, victimContainment, score, reasons };
}

/* ---------------------------------------------------------- impersonation -- */

const TRADEMARK = /[®™]/;
const hasAny = (v) => Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
/** A social link that actually belongs to this merchant — "shopify" in the footer
 *  is the theme's default and 90% of stores carry one, so it proves nothing. */
const hasRealSocial = (st) => ["instagram", "facebook", "tiktok"].some((f) => normValue(f, st[f]) !== null);
const daysSince = (t) => (t ? (Date.now() - new Date(t).getTime()) / 864e5 : null);

/** Median of the suspect's price divided by the victim's, over shared handles.
 *  Resellers price near RRP; a scam clone undercuts implausibly. */
export function priceRatio(victim, suspect) {
  const a = victim.priceByHandle || {}, b = suspect.priceByHandle || {};
  const ratios = [];
  for (const h of Object.keys(b)) {
    const pv = Number(a[h]), ps = Number(b[h]);
    if (pv > 0 && ps > 0) ratios.push(ps / pv);
  }
  if (ratios.length < 3) return null;
  ratios.sort((x, y) => x - y);
  return { n: ratios.length, median: ratios[Math.floor(ratios.length / 2)] };
}

/** Evidence that the suspect is trying to pass as the victim, rather than merely
 *  selling the same goods. Ported from radar/fraudsignals.py (which was written
 *  from the confirmed burntstudiospro case but never wired into the sweep) and
 *  extended with the lookalike-domain and pricing axes. */
export function impersonationSignals(victim, suspect) {
  let score = 0, domainPoints = 0;
  const reasons = [];
  const add = (pts, why) => { score += pts; reasons.push(why); };

  // Domain resemblance is scored, but tracked separately: on its own it cannot
  // justify a detection. A near-identical domain is just as likely to be the
  // merchant's own second registration (ultimatechef.co.za / ultimate-chef.co.za,
  // infomedpharmacy .com / .co.za) as an impersonator. Only CORROBORATING
  // evidence — a duplicated theme, a bulk-imported catalogue, implausible
  // pricing, no business stack — separates the two.
  const look = lookalikeSignal(victim.domain, suspect.domain);
  if (look) { add(look.points, look.reason); domainPoints += look.points; }

  // Victim's brand name worn by the suspect's store name.
  const vBrand = canon(label(victim.domain));
  const sName = canon(suspect.name || "");
  if (vBrand.length >= 4 && sName.includes(vBrand) && !canon(suspect.domain).includes(vBrand))
    add(TUNING.HIGH, `store name claims "${victim.name || label(victim.domain)}" on an unrelated domain`);

  const theme = (suspect.theme || "").toLowerCase();
  if (theme.startsWith("copy of") || theme.startsWith("copy_of") || theme.startsWith("duplicate of"))
    add(TUNING.HIGH, `duplicated theme (${suspect.theme})`);

  if (suspect.name && TRADEMARK.test(suspect.name)) add(TUNING.LOW, "uses ®/™ in the store name");

  const n = Number(suspect.product_count || suspect.n_products || 0);
  const age = daysSince(suspect.first_product_at || suspect.launched_at || suspect.store_created);
  if (n >= 50 && age !== null && age <= 30) add(TUNING.MED, `${n} products on a store first stocked ${Math.round(age)} days ago`);
  else if (age !== null && age <= 30) add(TUNING.LOW, `store first stocked only ${Math.round(age)} days ago`);

  const social = hasRealSocial(suspect);
  const apps = hasAny(suspect.apps);
  if (n >= 50 && !apps && !social) add(TUNING.MED, "no apps and no social presence despite a large catalogue");
  else if (n >= 50 && !social) add(TUNING.LOW, "no social presence despite a large catalogue");

  if (!hasAny(suspect.payments)) add(TUNING.LOW, "no verified payment provider at checkout");

  const pr = priceRatio(victim, suspect);
  if (pr && pr.median <= 0.55)
    add(TUNING.MED, `undercuts ${victim.domain} by ${Math.round((1 - pr.median) * 100)}% on ${pr.n} shared products`);

  return { score: Math.min(100, score), reasons, domainPoints, corroboration: score - domainPoints };
}

/* ------------------------------------------------------------- verdict ----- */

/** Combine the two axes. `suppressed` means "a real relationship, not fraud" —
 *  worth counting so the sweep can report what it filtered, but not worth
 *  reporting to a customer as an impersonation of their brand. */
export function classify(victim, suspect, fanout, idFanout) {
  if (registrable(victim.domain) === registrable(suspect.domain))
    return { suppressed: "same-site", detail: `${suspect.domain} is a subdomain of ${registrable(victim.domain)}` };
  const owner = sameOperator(victim, suspect, idFanout);
  if (owner) return { suppressed: "same-operator", detail: owner };
  if (isNonStoreHost(suspect.domain) || isNonStoreHost(victim.domain))
    return { suppressed: "non-store-host", detail: `${isNonStoreHost(suspect.domain) ? suspect.domain : victim.domain} is not an independent storefront` };

  const overlap = overlapSignals(victim, suspect, fanout);
  if (overlap.shared < TUNING.MIN_SHARED || overlap.weighted < TUNING.MIN_WEIGHTED)
    return { suppressed: "weak-overlap", detail: `${overlap.shared} shared images, rarity-weighted ${overlap.weighted.toFixed(1)}`, overlap };
  if (overlap.score < TUNING.MIN_OVERLAP)
    return { suppressed: "weak-overlap", detail: `overlap score ${overlap.score}`, overlap };

  const imp = impersonationSignals(victim, suspect);
  if (imp.score < TUNING.MIN_IMPERSONATION)
    return { suppressed: "commerce", detail: `catalogue overlap ${overlap.score} but impersonation only ${imp.score} — reads as a supply or reseller relationship`, overlap, imp };

  // A similar domain with nothing behind it is a second storefront, not a clone.
  const sameName = canon(label(victim.domain)) === canon(label(suspect.domain));
  const needed = sameName ? TUNING.MIN_CORROBORATION_SAME_NAME : TUNING.MIN_CORROBORATION;
  if (imp.corroboration < needed)
    return {
      suppressed: sameName ? "same-brand-other-domain" : "domain-only",
      detail: `domain resemblance scored ${imp.domainPoints} but corroborating fraud evidence only ${imp.corroboration} (needs ${needed})`,
      overlap, imp,
    };

  const verdict =
    overlap.score >= TUNING.COPY.overlap && imp.score >= TUNING.COPY.impersonation ? "COPY"
    : overlap.score >= TUNING.LIKELY.overlap && imp.score >= TUNING.LIKELY.impersonation ? "LIKELY"
    : "PARTIAL";

  return {
    suppressed: null,
    verdict,
    score: Math.round(0.4 * overlap.score + 0.6 * imp.score), // intent weighted above overlap
    overlap, imp,
    reasons: [...imp.reasons, ...overlap.reasons],
  };
}

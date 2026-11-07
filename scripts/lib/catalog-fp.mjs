/**
 * Compact catalogue fingerprints — the store_catalog_fp table.
 *
 * Same normalisation as lib/radar/catalog.ts (the Brand Audit engine): image filename stems with
 * Shopify's size token stripped, SKUs, lower-cased handles, normalised titles, min variant price per
 * handle. The difference is storage: every value is a 32-bit FNV-1a hash in a sorted int4[] instead
 * of a JSON string list, which is ~4 bytes/value vs ~25 and lets Postgres GIN-index the arrays.
 * A random 32-bit collision across a few million values only ever adds a stray single match, and the
 * sweep needs several shared images/SKUs before it scores a pair at all.
 *
 *   import { buildFp, ensureFpTable, upsertFp } from "./lib/catalog-fp.mjs";
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Markets we fingerprint. Global is out of scope: ~985k catalogues / 373M products would need a
 *  bigger DB tier and far more proxy bandwidth (decided 2026-11-07). */
export const FP_MARKETS = ["ZA", "KE", "NG"];
/** Re-fingerprint after this many days — catalogues change slowly; new suspects are done on arrival. */
export const FP_STALE_DAYS = 30;
/** Per-kind cap so a 3,000-product catalogue can't bloat its row (and the GIN index) unboundedly. */
const CAP = 4000;

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0; // signed int32 — fits Postgres int4
}

// Shopify appends a size token before the extension (name_grande.jpg, name_1024x1024.png) and, when
// a filename is re-uploaded, a UUID (name_3f2a…-…-….jpg). Strip both so the same source image
// matches across stores — a clone that re-uploads stolen images gets exactly this UUID suffix.
const SIZE_SUFFIX = /_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|x\d+)$/i;
const UUID_SUFFIX = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function imageStem(src) {
  try {
    let base = new URL(src, "https://x").pathname.split("/").pop() || "";
    // Size token first (name_<uuid>_1024x1024), then the UUID, then a size token the UUID was hiding.
    base = base.replace(/\.[a-z0-9]+$/i, "").replace(SIZE_SUFFIX, "").replace(UUID_SUFFIX, "").replace(SIZE_SUFFIX, "");
    return base.toLowerCase().trim();
  } catch {
    return "";
  }
}
const normTitle = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const sortedUnique = (set) => Int32Array.from(set).sort().slice(0, CAP);

/** products.json products → { n, img, sku, handle, title, price } (sorted int arrays; price[i] is
 *  the min variant price in cents of handle[i], 0 when unknown). */
export function buildFp(products) {
  const img = new Set(), sku = new Set(), title = new Set();
  const priceByHandle = new Map();
  for (const p of products) {
    for (const im of p.images ?? []) {
      const s = im?.src ? imageStem(im.src) : "";
      if (s.length >= 4) img.add(fnv1a(s));
    }
    let min = null;
    for (const v of p.variants ?? []) {
      // Short SKUs ("1", "001", "S") are shared by chance, not by copying.
      const k = v?.sku ? String(v.sku).trim() : "";
      if (k.length >= 4) sku.add(fnv1a(k));
      const n = parseFloat(v?.price);
      if (!Number.isNaN(n) && (min == null || n < min)) min = n;
    }
    const h = (p.handle || "").toLowerCase();
    if (h) priceByHandle.set(fnv1a(h), min == null ? 0 : Math.round(min * 100));
    const t = normTitle(p.title);
    if (t) title.add(fnv1a(t));
  }
  const handle = Int32Array.from(priceByHandle.keys()).sort().slice(0, CAP);
  const price = Int32Array.from(handle, (h) => priceByHandle.get(h));
  return { n: products.length, img: sortedUnique(img), sku: sortedUnique(sku), handle, title: sortedUnique(title), price };
}

/** The old store_fingerprints JSONB row (Brand Audit, lib/radar/catalog.ts) → the same shape as
 *  buildFp. Its stems already lost extension + size token but kept the re-upload UUID, so strip
 *  that (then any size token it was hiding) to land on exactly what imageStem gives today. */
export function fpFromLegacy(row) {
  const img = new Set(), sku = new Set(), title = new Set();
  for (const s0 of row.image_stems ?? []) {
    const s = String(s0).replace(UUID_SUFFIX, "").replace(SIZE_SUFFIX, "").toLowerCase().trim();
    if (s.length >= 4) img.add(fnv1a(s));
  }
  for (const k0 of row.skus ?? []) { const k = String(k0).trim(); if (k.length >= 4) sku.add(fnv1a(k)); }
  for (const t0 of row.titles ?? []) { const t = normTitle(t0); if (t) title.add(fnv1a(t)); }
  const priceByHandle = new Map();
  for (const h0 of row.handles ?? []) { const h = String(h0).toLowerCase(); if (h) priceByHandle.set(fnv1a(h), 0); }
  for (const [h0, p] of Object.entries(row.price_by_handle ?? {})) {
    const n = Number(p);
    priceByHandle.set(fnv1a(String(h0).toLowerCase()), Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0);
  }
  const handle = Int32Array.from(priceByHandle.keys()).sort().slice(0, CAP);
  const price = Int32Array.from(handle, (h) => priceByHandle.get(h));
  return { n: row.n_products ?? handle.length, img: sortedUnique(img), sku: sortedUnique(sku), handle, title: sortedUnique(title), price };
}

/** Guarded create (to_regclass, not IF NOT EXISTS) so a routine run never takes a lock on a hot path. */
export async function ensureFpTable(sql) {
  const [{ t }] = await sql`SELECT to_regclass('public.store_catalog_fp') AS t`;
  if (t) return;
  await sql`CREATE TABLE store_catalog_fp (
    domain text PRIMARY KEY,
    n_products int NOT NULL,
    img int4[] NOT NULL, sku int4[] NOT NULL, handle int4[] NOT NULL, title int4[] NOT NULL,
    price int4[] NOT NULL,
    earliest_product date,
    fp_at timestamptz NOT NULL DEFAULT now())`;
  // "Who else hosts these images / SKUs" becomes an indexed overlap (&&) query, so a Brand Audit no
  // longer has to load every fingerprint into one serverless function.
  await sql`CREATE INDEX store_catalog_fp_img ON store_catalog_fp USING gin (img)`;
  await sql`CREATE INDEX store_catalog_fp_sku ON store_catalog_fp USING gin (sku)`;
}

/** Upsert one store's fingerprint. An empty fp (n=0) still writes a row: it stamps fp_at so a
 *  store that has gone non-Shopify isn't re-fetched every run (the probe-queue-zombie trap). */
export async function upsertFp(sql, domain, fp, earliest) {
  const arr = (a) => Array.from(a);
  await sql`INSERT INTO store_catalog_fp (domain, n_products, img, sku, handle, title, price, earliest_product, fp_at)
    VALUES (${domain}, ${fp.n}, ${arr(fp.img)}::int4[], ${arr(fp.sku)}::int4[], ${arr(fp.handle)}::int4[],
            ${arr(fp.title)}::int4[], ${arr(fp.price)}::int4[], ${earliest}::date, now())
    ON CONFLICT (domain) DO UPDATE SET n_products = EXCLUDED.n_products, img = EXCLUDED.img, sku = EXCLUDED.sku,
      handle = EXCLUDED.handle, title = EXCLUDED.title, price = EXCLUDED.price,
      earliest_product = COALESCE(EXCLUDED.earliest_product, store_catalog_fp.earliest_product), fp_at = now()`;
}

/** A store that refused (429/timeout) this time: back-date fp_at so it's due again in a few days.
 *  A new row gets n_products = -1 ("not measured") — the sweep only reads n_products > 0 — and an
 *  existing fingerprint keeps its arrays. */
export async function deferFp(sql, domain, ageDays) {
  await sql`INSERT INTO store_catalog_fp (domain, n_products, img, sku, handle, title, price, fp_at)
    VALUES (${domain}, -1, '{}', '{}', '{}', '{}', '{}', now() - make_interval(days => ${ageDays}))
    ON CONFLICT (domain) DO UPDATE SET fp_at = now() - make_interval(days => ${ageDays})`;
}

export const EMPTY_FP = { n: 0, img: [], sku: [], handle: [], title: [], price: [] };

// ---- Pair scoring (clone-sweep and one-off checks share this) ----
// Brand Audit weights (lib/radar/catalog.ts): image 34 / sku 26 / handle 22 / title 18,
// ×(1+0.15·price mirror), each kind's overlap as containment vs the smaller catalogue.
const W = { img: 34, sku: 26, handle: 22, title: 18 };
export const verdictFor = (s) => (s >= 75 ? "COPY" : s >= 50 ? "LIKELY" : s >= 25 ? "PARTIAL" : "clean");

// Sorted int-array intersection count.
function inter(a, b) {
  let i = 0, j = 0, n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { n++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return n;
}
// Share of handles present in both whose min price matches to the cent.
function priceMirror(a, b) {
  let i = 0, j = 0, both = 0, same = 0;
  while (i < a.handle.length && j < b.handle.length) {
    if (a.handle[i] === b.handle[j]) {
      if (a.price[i] > 0 && b.price[j] > 0) { both++; if (a.price[i] === b.price[j]) same++; }
      i++; j++;
    } else if (a.handle[i] < b.handle[j]) i++; else j++;
  }
  return both ? same / both : 0;
}

/** Score two fingerprints ({img, sku, handle, title, price} sorted arrays). `sus` is the suspected
 *  copier: `copied` is how much of ITS own catalogue the other store accounts for — high means a
 *  clone, low means a stockist carrying a slice of a bigger catalogue. */
export function scorePair(orig, sus) {
  const k = { img: inter(orig.img, sus.img), sku: inter(orig.sku, sus.sku), handle: inter(orig.handle, sus.handle), title: inter(orig.title, sus.title) };
  const ratio = (kind) => { const m = Math.min(orig[kind].length, sus[kind].length); return m ? k[kind] / m : 0; };
  const pm = priceMirror(orig, sus);
  const score = Math.min(100, Math.round((W.img * ratio("img") + W.sku * ratio("sku") + W.handle * ratio("handle") + W.title * ratio("title")) * (1 + 0.15 * pm)));
  const copied = Math.max(
    sus.img.length ? k.img / sus.img.length : 0,
    sus.handle.length ? k.handle / sus.handle.length : 0,
    sus.title.length ? k.title / sus.title.length : 0);
  const reasons = [];
  if (k.img) reasons.push(`${k.img} identical product images`);
  if (k.sku) reasons.push(`${k.sku} identical SKUs`);
  if (k.handle) reasons.push(`${k.handle} identical product handles`);
  if (k.title) reasons.push(`${k.title} identical product titles`);
  if (pm) reasons.push(`prices mirrored on ${Math.round(pm * 100)}% of shared products`);
  return { score, verdict: verdictFor(score), kind: copied >= 0.5 ? "clone" : "stockist", copied, pm, k, reasons };
}

/** Official domains from the brand watchlist (shopify-radar/brands.txt, `Brand | a.co.za,b.com`).
 *  These are the catalogues a clone would copy, so the --fp lane fingerprints them first. Missing
 *  file → [] (the Peach / Plus tiers still apply). Override the path with BRANDS_FILE. */
export function loadBrandDomains(file = process.env.BRANDS_FILE || path.join(os.homedir(), "shopify-radar", "brands.txt")) {
  try {
    const out = new Set();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("|")) continue;
      for (const d of t.split("|")[1].split(",")) {
        const dom = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
        if (dom) { out.add(dom); out.add(`www.${dom}`); }
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

// ---- Brand index: which brands (products.json `vendor`) each store sells ----
// Rides on the same download as the fingerprint. The vendor is what a clone gets wrong: it keeps
// "Burnt Studios" as the vendor on a domain that isn't burnt.co.za (memory: brand-abuse-monitoring).

// Placeholder vendors Shopify and importers leave behind — never a brand.
const JUNK_VENDORS = new Set(["", "default", "default vendor", "vendor", "unknown", "none", "n a", "na", "null",
  "test", "my store", "shopify", "store", "other", "others", "generic", "no brand", "unbranded", "brand"]);
const VENDOR_CAP = 200;   // marketplaces carry thousands; the long tail adds rows, not insight

/** Canonical brand key: "Steve Madden SA" / "STEVE MADDEN®" / "Steve-Madden (Pty) Ltd" → "steve madden".
 *  Strips marks, legal suffixes and a trailing market tag, so a store's own brand and a clone's
 *  "Brand SA" land on one key. Returns "" for placeholders. */
export function vendorKey(v) {
  // Marks first: NFKD would turn ™ into the letters "TM".
  const k0 = String(v ?? "").replace(/[®™©℠]/g, " ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  // Legal suffixes and a market tag only — never "store"/"shop", which are part of real names (The Body Shop).
  let k = k0;
  for (let i = 0; i < 3; i++) k = k.replace(/ (pty|ltd|limited|inc|llc|co|company|sa|za|south africa|kenya|nigeria)$/, "").trim();
  return JUNK_VENDORS.has(k0) || JUNK_VENDORS.has(k) || /^[0-9 ]+$/.test(k) ? "" : k;
}

/** products → [{ key, vendor, n }] — n = products under that brand; vendor = its commonest spelling. */
export function buildVendors(products) {
  const by = new Map();
  for (const p of products) {
    const raw = String(p?.vendor ?? "").trim();
    const key = vendorKey(raw);
    if (!key) continue;
    const e = by.get(key) ?? { key, n: 0, spell: new Map() };
    e.n++; e.spell.set(raw, (e.spell.get(raw) ?? 0) + 1);
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, VENDOR_CAP)
    .map((e) => ({ key: e.key, vendor: [...e.spell].sort((a, b) => b[1] - a[1])[0][0], n: e.n }));
}

export async function ensureVendorTable(sql) {
  const [{ t }] = await sql`SELECT to_regclass('public.store_vendors') AS t`;
  if (t) return;
  await sql`CREATE TABLE store_vendors (
    domain text NOT NULL, vendor_key text NOT NULL, vendor text NOT NULL, n_products int NOT NULL,
    seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (domain, vendor_key))`;
  await sql`CREATE INDEX store_vendors_key ON store_vendors (vendor_key)`;
}

/** Replace one store's brand list (a fresh catalogue is the whole truth; a dropped brand goes). */
export async function upsertVendors(sql, domain, vendors) {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM store_vendors WHERE domain = ${domain}`;
    if (vendors.length) await tx`INSERT INTO store_vendors ${tx(vendors.map((v) => ({ domain, vendor_key: v.key, vendor: v.vendor.slice(0, 200), n_products: v.n })))}`;
  });
}

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
    base = base.replace(/\.[a-z0-9]+$/i, "").replace(UUID_SUFFIX, "").replace(SIZE_SUFFIX, "");
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

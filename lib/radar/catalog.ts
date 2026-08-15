/** Catalog fingerprinting — the same engine as shopify-radar/radar/catalog.py,
 *  ported to TypeScript so a brand audit runs self-contained on Vercel.
 *
 *  Every Shopify store serves its whole catalogue at /products.json. That's the
 *  hole a clone exploits to bulk-import a brand's images, SKUs, prices and copy —
 *  and it's equally the strongest evidence the theft happened. We fingerprint a
 *  brand's catalogue, then measure how much of it a suspect reproduces.
 */

/** Strip 'https://', path, and leading www — leave the bare host. */
export function cleanDomain(input: string): string {
  let d = (input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return d;
}

// Shopify appends a size token before the extension: name_grande.jpg,
// name_1024x1024.png. Strip it so the same source image matches across stores.
const SIZE_SUFFIX =
  /_(?:pico|icon|thumb|small|compact|medium|large|grande|original|master|\d+x\d*|x\d+)$/i;

function imageStem(src: string): string {
  try {
    const path = new URL(src, "https://x").pathname;
    let base = path.split("/").pop() || "";
    base = base.replace(/\.[a-z0-9]+$/i, ""); // drop extension
    base = base.replace(SIZE_SUFFIX, "");
    return base.toLowerCase().trim();
  } catch {
    return "";
  }
}

function normTitle(t: string): string {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type Product = {
  handle: string;
  title: string;
  imageStems: string[];
  skus: string[];
  priceMin: number | null;
};

async function getJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseProduct(p: any): Product {
  const stems = new Set<string>();
  for (const img of p.images || []) {
    if (img?.src) {
      const s = imageStem(img.src);
      if (s) stems.add(s);
    }
  }
  const skus = new Set<string>();
  const prices: number[] = [];
  for (const v of p.variants || []) {
    if (v?.sku) skus.add(String(v.sku).trim());
    if (v?.price != null) {
      const n = parseFloat(v.price);
      if (!Number.isNaN(n)) prices.push(n);
    }
  }
  return {
    handle: (p.handle || "").toLowerCase(),
    title: p.title || "",
    imageStems: [...stems],
    skus: [...skus],
    priceMin: prices.length ? Math.min(...prices) : null,
  };
}

/** Pull a store's public catalogue via paginated /products.json. Returns [] for
 *  non-Shopify / empty / unreachable stores — a normal "nothing to compare". */
export async function fetchCatalog(domain: string, maxPages = 8): Promise<Product[]> {
  const base = `https://${cleanDomain(domain)}`;
  const products: Product[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = (await getJson(`${base}/products.json?limit=250&page=${page}`)) as
      | { products?: unknown[] }
      | null;
    const items = data?.products;
    if (!items || !Array.isArray(items) || items.length === 0) break;
    for (const it of items) products.push(parseProduct(it));
    if (items.length < 250) break;
  }
  return products;
}

export type Fingerprint = {
  domain: string;
  nProducts: number;
  handles: Set<string>;
  titles: Set<string>;
  imageStems: Set<string>;
  skus: Set<string>;
  priceByHandle: Map<string, number>;
};

export function buildFingerprint(domain: string, products: Product[]): Fingerprint {
  const fp: Fingerprint = {
    domain,
    nProducts: products.length,
    handles: new Set(),
    titles: new Set(),
    imageStems: new Set(),
    skus: new Set(),
    priceByHandle: new Map(),
  };
  for (const p of products) {
    if (p.handle) {
      fp.handles.add(p.handle);
      if (p.priceMin != null) fp.priceByHandle.set(p.handle, p.priceMin);
    }
    if (p.title) fp.titles.add(normTitle(p.title));
    for (const s of p.imageStems) fp.imageStems.add(s);
    for (const s of p.skus) fp.skus.add(s);
  }
  return fp;
}

/** Overlap relative to the SMALLER set — catches a partial clone that copied
 *  only some of the brand's catalogue. */
function containment(a: Set<string>, b: Set<string>): [number, number] {
  if (a.size === 0 || b.size === 0) return [0, 0];
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return [inter / small.size, inter];
}

export type Verdict = "COPY" | "LIKELY" | "PARTIAL" | "clean";

export type MatchReport = {
  brand: string;
  suspect: string;
  suspectName?: string;
  score: number;
  verdict: Verdict;
  reasons: string[];
  imageRatio: number;
  skuRatio: number;
  handleRatio: number;
  titleRatio: number;
  priceMirrorRatio: number;
  matchedCount: number;
};

const W_IMAGE = 34,
  W_SKU = 26,
  W_HANDLE = 22,
  W_TITLE = 18;

export function verdictFor(score: number): Verdict {
  if (score >= 75) return "COPY";
  if (score >= 50) return "LIKELY";
  if (score >= 25) return "PARTIAL";
  return "clean";
}

export function compare(brand: Fingerprint, suspect: Fingerprint): MatchReport {
  const rep: MatchReport = {
    brand: brand.domain,
    suspect: suspect.domain,
    score: 0,
    verdict: "clean",
    reasons: [],
    imageRatio: 0,
    skuRatio: 0,
    handleRatio: 0,
    titleRatio: 0,
    priceMirrorRatio: 0,
    matchedCount: 0,
  };
  if (brand.nProducts === 0 || suspect.nProducts === 0) return rep;

  const [imgR, imgN] = containment(brand.imageStems, suspect.imageStems);
  const [skuR, skuN] = containment(brand.skus, suspect.skus);
  const [hndR, hndN] = containment(brand.handles, suspect.handles);
  const [ttlR, ttlN] = containment(brand.titles, suspect.titles);
  rep.imageRatio = imgR;
  rep.skuRatio = skuR;
  rep.handleRatio = hndR;
  rep.titleRatio = ttlR;

  const matched: string[] = [];
  for (const h of brand.handles) if (suspect.handles.has(h)) matched.push(h);
  rep.matchedCount = matched.length;

  const priced = matched.filter(
    (h) => brand.priceByHandle.has(h) && suspect.priceByHandle.has(h),
  );
  if (priced.length) {
    const same = priced.filter(
      (h) => Math.abs(brand.priceByHandle.get(h)! - suspect.priceByHandle.get(h)!) < 0.01,
    ).length;
    rep.priceMirrorRatio = same / priced.length;
  }

  let score = W_IMAGE * imgR + W_SKU * skuR + W_HANDLE * hndR + W_TITLE * ttlR;
  score *= 1 + 0.15 * rep.priceMirrorRatio;
  rep.score = Math.min(100, Math.round(score));

  const pct = (r: number) => `${Math.round(r * 100)}%`;
  if (imgN) rep.reasons.push(`${imgN} identical product images (${pct(imgR)} of the smaller catalogue)`);
  if (skuN) rep.reasons.push(`${skuN} identical SKUs`);
  if (hndN) rep.reasons.push(`${hndN} identical product handles`);
  if (ttlN) rep.reasons.push(`${ttlN} identical product titles`);
  if (rep.priceMirrorRatio) rep.reasons.push(`prices mirrored on ${pct(rep.priceMirrorRatio)} of shared products`);

  rep.verdict = verdictFor(rep.score);
  return rep;
}

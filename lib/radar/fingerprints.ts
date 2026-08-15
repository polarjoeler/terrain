/** The store-fingerprint cache — what makes the audit fast and full-coverage.
 *
 *  Every store in our universe gets its catalogue fingerprinted once (at import /
 *  enrichment time) and cached. A Brand Audit then compares against these cached
 *  fingerprints instantly, across the WHOLE universe — so it catches clones on
 *  unrelated domains, not just name look-alikes.
 *
 *  Enrichment is batched so it stays inside the serverless budget: the admin UI
 *  calls enrichBatch() repeatedly until the universe is covered.
 */

import { db, ensureSchema } from "./db";
import { fetchLeads } from "../sheets";
import { marketOf, type Market } from "../prioritize";
import {
  buildFingerprint,
  cleanDomain,
  fetchCatalog,
  type Fingerprint,
} from "./catalog";

const STALE_DAYS = 30; // re-fingerprint stores older than this
const CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Fetch a store's catalogue, fingerprint it, and upsert the cache row. */
export async function enrichStore(
  domain: string,
  name: string | null,
  market: Market,
): Promise<"ok" | "empty"> {
  const d = cleanDomain(domain);
  const products = await fetchCatalog(d, 4);
  const fp = buildFingerprint(d, products);
  const status = fp.nProducts === 0 ? "empty" : "ok";
  await db()`
    INSERT INTO store_fingerprints (
      domain, name, market, n_products, image_stems, skus, handles, titles,
      price_by_handle, status, enriched_at
    ) VALUES (
      ${d}, ${name}, ${market}, ${fp.nProducts},
      ${db().json([...fp.imageStems])}, ${db().json([...fp.skus])},
      ${db().json([...fp.handles])}, ${db().json([...fp.titles])},
      ${db().json(Object.fromEntries(fp.priceByHandle))}, ${status}, now()
    )
    ON CONFLICT (domain) DO UPDATE SET
      name = EXCLUDED.name,
      market = EXCLUDED.market,
      n_products = EXCLUDED.n_products,
      image_stems = EXCLUDED.image_stems,
      skus = EXCLUDED.skus,
      handles = EXCLUDED.handles,
      titles = EXCLUDED.titles,
      price_by_handle = EXCLUDED.price_by_handle,
      status = EXCLUDED.status,
      enriched_at = now()
  `;
  return status;
}

export type Coverage = {
  universe: number;
  fingerprinted: number;
  remaining: number;
  withCatalogue: number; // status = ok
};

/** Which domains in `market` still need (re)fingerprinting? */
async function pendingDomains(
  market: Market,
): Promise<{ targets: { domain: string; name: string | null }[]; coverage: Coverage }> {
  const { leads } = await fetchLeads();
  const universe = leads
    .filter((l) => marketOf(l) === market)
    .map((l) => ({ domain: cleanDomain(l.domain), name: l.name ?? null }));
  const byDomain = new Map(universe.map((u) => [u.domain, u]));

  const rows = await db()<{ domain: string; enriched_at: Date; status: string }[]>`
    SELECT domain, enriched_at, status FROM store_fingerprints WHERE market = ${market}
  `;
  const staleBefore = Date.now() - STALE_DAYS * 864e5;
  const fresh = new Set<string>();
  let withCatalogue = 0;
  for (const r of rows) {
    if (byDomain.has(r.domain) && new Date(r.enriched_at).getTime() >= staleBefore) {
      fresh.add(r.domain);
      if (r.status === "ok") withCatalogue++;
    }
  }
  const targets = universe.filter((u) => !fresh.has(u.domain));
  return {
    targets,
    coverage: {
      universe: universe.length,
      fingerprinted: fresh.size,
      remaining: targets.length,
      withCatalogue,
    },
  };
}

export async function coverage(market: Market = "South Africa"): Promise<Coverage> {
  await ensureSchema();
  return (await pendingDomains(market)).coverage;
}

/** Enrich the next `limit` un-fingerprinted stores. Call repeatedly until
 *  coverage.remaining is 0. Returns what happened + fresh coverage. */
export async function enrichBatch(
  market: Market = "South Africa",
  limit = 20,
): Promise<{ processed: number; ok: number; empty: number; coverage: Coverage }> {
  await ensureSchema();
  const { targets } = await pendingDomains(market);
  const batch = targets.slice(0, limit);
  const results = await mapWithConcurrency(batch, CONCURRENCY, (t) =>
    enrichStore(t.domain, t.name, market).catch(() => "empty" as const),
  );
  const ok = results.filter((r) => r === "ok").length;
  return {
    processed: batch.length,
    ok,
    empty: batch.length - ok,
    coverage: (await pendingDomains(market)).coverage,
  };
}

export type CachedStore = { domain: string; name: string | null; fp: Fingerprint };

/** Load every cached fingerprint with a real catalogue, for comparison. */
export async function loadFingerprints(market: Market): Promise<CachedStore[]> {
  await ensureSchema();
  const rows = await db()<
    {
      domain: string;
      name: string | null;
      n_products: number;
      image_stems: string[];
      skus: string[];
      handles: string[];
      titles: string[];
      price_by_handle: Record<string, number>;
    }[]
  >`
    SELECT domain, name, n_products, image_stems, skus, handles, titles, price_by_handle
    FROM store_fingerprints
    WHERE market = ${market} AND status = 'ok'
  `;
  return rows.map((r) => ({
    domain: r.domain,
    name: r.name,
    fp: {
      domain: r.domain,
      nProducts: r.n_products,
      imageStems: new Set(r.image_stems),
      skus: new Set(r.skus),
      handles: new Set(r.handles),
      titles: new Set(r.titles),
      priceByHandle: new Map(Object.entries(r.price_by_handle)),
    },
  }));
}

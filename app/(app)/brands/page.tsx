import Link from "next/link";
import { brandCoverage, listBrands } from "@/lib/brands";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Brands" };

/** Brand index, customer side. Which brands each store sells, read from its own product catalogue
 *  (store_vendors). Two jobs: a seller or distributor finds every store stocking a brand; a brand
 *  sees where it is sold. Fakes and look-alikes are NOT shown here — those stay admin-only until a
 *  human has confirmed them (lib/radar/watch.ts). Auth + paywall come from the (app) layout. */
export default async function BrandsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim().slice(0, 60);
  // Sequential — the pool is small (lib/db).
  const brands = await listBrands(q || undefined, 90).catch(() => []);
  const cov = await brandCoverage().catch(() => ({ stores: 0, brands: 0 }));

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-2xl text-cream">Brands</h1>
      <p className="mt-1 max-w-2xl text-sm text-cream/55">
        Find every store that sells a brand. Read from each store&rsquo;s own product catalogue, so a brand
        shows up only where its products are actually listed.
      </p>

      <form action="/brands" className="mt-5 flex max-w-md gap-2">
        <input name="q" defaultValue={q} placeholder="Search a brand: Nike, Garmin, Volkano…" aria-label="Brand name"
          className="min-h-11 flex-1 rounded-full border border-cream/15 bg-transparent px-4 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50" />
        <button className="min-h-11 rounded-full bg-mint px-5 text-sm font-medium text-ink">Search</button>
      </form>

      <section className="mt-6 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/40">
          {q ? `Brands matching “${q}”` : "Most widely stocked"}
        </h2>
        {brands.length === 0 ? (
          <p className="mt-3 text-sm text-cream/50">
            {q ? "No brand by that name in the catalogues we've read yet. That means not read, not that nobody sells it." : "No brands indexed yet."}
          </p>
        ) : (
          <ul className="mt-2 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            {brands.map((b) => (
              <li key={b.key}>
                <Link href={`/brands/${encodeURIComponent(b.key)}`}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm text-cream/80 transition hover:bg-cream/[0.05] hover:text-cream">
                  <span className="truncate">{b.vendor}</span>
                  <span className="shrink-0 font-mono text-[11px] text-cream/40">{b.stores.toLocaleString()} {b.stores === 1 ? "store" : "stores"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-3 text-xs text-cream/40">
        Coverage so far: {cov.brands.toLocaleString()} brands across {cov.stores.toLocaleString()}{" "}stores whose catalogue we&rsquo;ve read.
        It grows every week as more catalogues are read.
      </p>
    </div>
  );
}

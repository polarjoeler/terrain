import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser, isAdmin } from "@/lib/auth";
import { getBrand, type BrandStore } from "@/lib/brands";
import { marketFlag } from "@/lib/markets";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  return { title: `Terrain — ${keyOf((await params).key)}` };
}

// Keys are [a-z0-9 ] (vendorKey in scripts/lib/catalog-fp.mjs); decode defensively anyway.
const keyOf = (raw: string) => { try { return decodeURIComponent(raw).toLowerCase(); } catch { return raw.toLowerCase(); } };
const pct = (n: number) => `${Math.round(n * 100)}%`;

function StoreRow({ s }: { s: BrandStore }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-cream/[0.06] py-3 first:border-t-0">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex items-center gap-2">
          <Link href={`/dashboard?q=${encodeURIComponent(s.domain)}`} className="truncate text-sm font-medium text-cream hover:underline">
            {s.name && s.name !== s.domain ? s.name : s.domain}
          </Link>
          {s.country && <span className="shrink-0 text-xs" title={s.country}>{marketFlag(s.country)}</span>}
        </div>
        <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="block truncate font-mono text-[11px] text-cream/40 hover:underline">{s.domain}</a>
      </div>
      <span className="w-24 shrink-0 text-xs text-cream/50">{s.platform ?? "—"}</span>
      <div className="w-44 shrink-0">
        <div className="flex justify-between font-mono text-[11px] text-cream/55">
          <span>{s.products.toLocaleString()} products</span>
          <span title="Share of the store's catalogue">{pct(s.share)}</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-cream/10" aria-hidden>
          <div className="h-1 rounded-full bg-orange-soft/70" style={{ width: pct(s.share) }} />
        </div>
      </div>
    </li>
  );
}

/** One brand: its likely own site, then every store listing it. A customer sees sellers only —
 *  no "impersonation" label. That judgement stays on /admin/brands until a person confirms it. */
export default async function BrandPage({ params }: { params: Promise<{ key: string }> }) {
  const key = keyOf((await params).key);
  const brand = await getBrand(key).catch(() => null);
  if (!brand) notFound();
  const email = await currentUser();
  const admin = !!email && isAdmin(email);

  const own = brand.stores.filter((s) => s.role === "official");
  const sellers = brand.stores.filter((s) => s.role !== "official");
  const products = brand.stores.reduce((n, s) => n + s.products, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/brands" className="text-xs text-cream/50 hover:text-cream">← All brands</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-3xl text-cream">{brand.vendor}</h1>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-cream/45">
            {brand.stores.length} {brand.stores.length === 1 ? "store" : "stores"} · {products.toLocaleString()} products
          </span>
          {admin && <Link href={`/admin/brands?b=${encodeURIComponent(key)}`} className="rounded-full border border-orange/30 px-3 py-1 text-[11px] text-orange hover:bg-orange/10">Admin view</Link>}
        </div>
      </div>

      <section className="mt-6 rounded-2xl border border-cyan/20 bg-gradient-to-b from-cyan/[0.06] to-transparent p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cyan/80">Likely the brand&rsquo;s own site</h2>
        {own.length ? (
          <ul className="mt-1">{own.map((s) => <StoreRow key={s.domain} s={s} />)}</ul>
        ) : (
          <p className="mt-2 text-sm text-cream/50">We haven&rsquo;t found a store named after this brand that mostly sells it. We may only see it through stockists.</p>
        )}
      </section>

      <section className="mt-4 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/40">Stores selling {brand.vendor} · {sellers.length}</h2>
        {sellers.length === 0
          ? <p className="mt-2 text-sm text-cream/50">No other store lists it yet.</p>
          : <ul className="mt-1">{sellers.map((s) => <StoreRow key={s.domain} s={s} />)}</ul>}
      </section>

      <p className="mt-3 text-xs text-cream/40">
        From the product catalogues we&rsquo;ve read. A store missing here may sell the brand but not have been read yet.
        Click a store to open it in Leads.
      </p>
    </div>
  );
}

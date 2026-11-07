import Link from "next/link";
import { redirect } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import { currentUser, isAdmin } from "@/lib/auth";
import { getBrand, getCatalogueCopies, listBrands, type BrandStore } from "@/lib/brands";
import { marketFlag } from "@/lib/markets";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Admin · Brand index" };

const pct = (n: number) => `${Math.round(n * 100)}%`;

function StoreRow({ s }: { s: BrandStore }) {
  return (
    <li className="flex items-center gap-3 border-t border-cream/[0.06] py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-cream">{s.name && s.name !== s.domain ? s.name : s.domain}</span>
          {s.country && <span className="shrink-0 text-xs">{marketFlag(s.country)}</span>}
        </div>
        <a href={`https://${s.domain}`} target="_blank" rel="noopener noreferrer" className="block truncate font-mono text-[11px] text-cream/40 hover:underline">{s.domain}</a>
      </div>
      <div className="w-40 shrink-0">
        <div className="flex justify-between font-mono text-[11px] text-cream/50">
          <span>{s.products.toLocaleString()} products</span><span>{pct(s.share)}</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-cream/10">
          <div className="h-1 rounded-full bg-orange-soft/70" style={{ width: pct(s.share) }} />
        </div>
      </div>
    </li>
  );
}

export default async function BrandIndex({ searchParams }: { searchParams: Promise<{ q?: string; b?: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const brands = await listBrands(q || undefined).catch(() => []);
  const brand = sp.b ? await getBrand(sp.b).catch(() => null) : null;
  const copies = brand?.official ? await getCatalogueCopies(brand.official.domain).catch(() => []) : [];
  const impersonators = brand?.stores.filter((s) => s.role === "impersonation") ?? [];
  const sisters = brand?.stores.filter((s) => s.role === "official" && s !== brand.official) ?? [];
  const stockists = brand?.stores.filter((s) => s.role === "stockist") ?? [];

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/admin" className="text-cream/60 hover:text-cream">← Admin</Link>
            <span className="rounded-full border border-orange/30 bg-orange/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-orange">Admin</span>
          </div>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Brand index</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Which brands each store sells, read from its product catalogue. A brand page shows the site
            that looks official, the stockists carrying it, and stores that use its name while mostly selling it.
            It fills as catalogue reads succeed, so coverage grows week by week.
          </p>
          <form className="mt-5 flex gap-2" action="/admin/brands">
            <input name="q" defaultValue={q} placeholder="Search a brand — nike, steve madden…"
              className="w-80 max-w-full rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50" />
            <button className="rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink">Search</button>
          </form>
        </header>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          {/* Brand list */}
          <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-cream/40">{q ? `Brands matching “${q}”` : "Most widely stocked"}</h2>
            {brands.length === 0 ? (
              <p className="mt-4 text-sm text-cream/45">{q ? "No brand by that name yet." : "No brands indexed yet — they arrive with the next catalogue reads."}</p>
            ) : (
              <ul className="mt-2">
                {brands.map((b) => (
                  <li key={b.key}>
                    <Link href={`/admin/brands?${new URLSearchParams({ ...(q ? { q } : {}), b: b.key })}`}
                      className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition ${brand?.key === b.key ? "bg-cyan/15 text-cream" : "text-cream/75 hover:bg-cream/[0.05]"}`}>
                      <span className="truncate">{b.vendor}</span>
                      <span className="shrink-0 font-mono text-[11px] text-cream/40">{b.stores.toLocaleString()} {b.stores === 1 ? "store" : "stores"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Brand detail */}
          <section className="min-w-0 space-y-4">
            {!brand ? (
              <div className="rounded-2xl border border-dashed border-cream/10 p-8 text-center text-sm text-cream/40">Pick a brand to see who sells it.</div>
            ) : (
              <>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <h2 className="font-display text-3xl text-cream">{brand.vendor}</h2>
                  <span className="font-mono text-xs text-cream/45">{brand.stores.length} {brand.stores.length === 1 ? "store" : "stores"} · {brand.stores.reduce((n, s) => n + s.products, 0).toLocaleString()} products</span>
                </div>

                <div className="rounded-2xl border border-cyan/20 bg-gradient-to-b from-cyan/[0.06] to-transparent p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-cyan/80">Looks official</h3>
                  {brand.official ? (
                    <ul className="mt-1"><StoreRow s={brand.official} />{sisters.map((s) => <StoreRow key={s.domain} s={s} />)}</ul>
                  ) : (
                    <p className="mt-2 text-sm text-cream/50">No store both carries this brand mostly and is named after it — likely a brand we only see through stockists.</p>
                  )}
                  {sisters.length > 0 && <p className="mt-2 text-[11px] text-cream/40">Sister sites run by the same operator are counted as official.</p>}
                </div>

                {impersonators.length > 0 && (
                  <div className="rounded-2xl border border-orange/25 bg-orange/[0.04] p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-orange">Uses the brand&rsquo;s name · not the official site</h3>
                    <p className="mt-1 text-xs text-cream/50">Named after {brand.vendor}, mostly sells it, and not run by the official site&rsquo;s operator. Could be an authorised single-brand reseller — or a copy. Worth a look.</p>
                    <ul className="mt-2">{impersonators.map((s) => <StoreRow key={s.domain} s={s} />)}</ul>
                  </div>
                )}

                {copies.length > 0 && (
                  <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-cream/40">Hosting its catalogue · clone sweep</h3>
                    <ul className="mt-2 space-y-2">
                      {copies.map((c) => (
                        <li key={c.suspect} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                          <a href={`https://${c.suspect}`} target="_blank" rel="noopener noreferrer" className="font-mono text-cream/80 hover:underline">{c.suspect}</a>
                          <span className="flex items-center gap-2 text-xs">
                            <span className={`rounded px-1.5 py-0.5 font-semibold ${c.kind === "clone" ? "bg-orange/15 text-orange" : "bg-cream/10 text-cream/60"}`}>{c.kind === "clone" ? `${c.verdict} · ${pct(c.copiedShare)} of its catalogue` : "stockist"}</span>
                            <span className="font-mono text-cream/35">since {c.firstSeenAt}</span>
                          </span>
                          <span className="w-full text-[11px] text-cream/40">{c.reasons.slice(0, 3).join(" · ")}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-cream/40">Stockists · {stockists.length}</h3>
                  {stockists.length === 0
                    ? <p className="mt-2 text-sm text-cream/45">No other stores carry it yet.</p>
                    : <ul className="mt-1">{stockists.map((s) => <StoreRow key={s.domain} s={s} />)}</ul>}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import {
  productDirectory, storesIn, baseIn, directoryCountries, PRODUCT_CATEGORIES,
  type ProductCategory, type ProductDirectory,
} from "@/lib/partner-directory";
import { VISIBLE_MARKETS } from "@/lib/markets";
import { CountryBar, Tabs, SearchBox, hrefWith, flag, marketName } from "../filters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Product Partners" };

const CAT: Record<ProductCategory, { label: string; blurb: string; noun: string }> = {
  payments: { label: "Payments", blurb: "Gateways, BNPL & alternative rails — verified at checkout. Rows open a full market report.", noun: "gateway" },
  apps: { label: "Apps", blurb: "The Shopify apps merchants install — integration & collab targets.", noun: "app" },
  shipping: { label: "Shipping", blurb: "Carriers detected at checkout (generic ‘Shopify’ rates excluded).", noun: "carrier" },
};
const TYPE_TONE: Record<string, string> = { PSP: "text-mint", BNPL: "text-orange", APM: "text-cyan" };
const PAGE = 25;

const empty: ProductDirectory = { rows: [], base: { payments: {}, apps: {}, shipping: {} }, computedAt: "" };

export default async function ProductPartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; cat?: string; q?: string; all?: string }>;
}) {
  const email = await currentUser();
  if (!email) redirect("/login");

  const sp = await searchParams;
  const cat: ProductCategory = PRODUCT_CATEGORIES.includes(sp.cat as ProductCategory) ? (sp.cat as ProductCategory) : "payments";
  const cc = sp.country?.toUpperCase();
  const country = cc && (VISIBLE_MARKETS as readonly string[]).includes(cc) ? cc : undefined;
  const q = sp.q?.trim() ?? "";
  const showAll = sp.all === "1";
  const cur = { country, cat, q: q || undefined, all: showAll ? "1" : undefined };
  const base = "/partners/products";

  const dir = await productDirectory().catch(() => empty);

  // Rows for the chosen market, ranked by stores there.
  const inMarket = (c: ProductCategory) =>
    dir.rows.filter((r) => r.cat === c).map((r) => ({ r, n: storesIn(r, country) })).filter((x) => x.n > 0);
  const ranked = inMarket(cat).sort((a, b) => b.n - a.n).map((x, i) => ({ ...x, rank: i + 1 }));
  const matches = q ? ranked.filter((x) => x.r.name.toLowerCase().includes(q.toLowerCase())) : ranked;
  const shown = showAll || q ? matches : matches.slice(0, PAGE);
  const denom = baseIn(dir, cat, country);
  const top = ranked[0]?.n ?? 1;

  const countries = directoryCountries(dir, cat).map((c) => ({ code: c.code, count: c.stores }));
  const where = country ? `${flag(country)} ${marketName(country)}` : "Africa";

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/partners" className="text-xs text-cream/40 hover:text-cream">← Partner Finder</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-cream">Product Partners</h1>
          <p className="mt-1 max-w-2xl text-xs text-cream/45">
            Who merchants in {where} actually run — ranked by live stores, so you can spot integration and collaboration targets.
          </p>
        </div>
        <Link href="/partners/services" className="shrink-0 rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">Service Partners →</Link>
      </div>

      <div className="mt-5">
        <CountryBar base={base} cur={cur} countries={countries} allCount={baseIn(dir, cat)} />
      </div>

      <div className="mt-5">
        <Tabs items={PRODUCT_CATEGORIES.map((c) => ({
          key: c, label: CAT[c].label, count: inMarket(c).length,
          href: hrefWith(base, cur, { cat: c, q: null, all: null }), on: c === cat,
        }))} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-cream/40">
          {CAT[cat].blurb}{" "}
          <span className="text-cream/55">{denom.toLocaleString()} live stores in {where} have {CAT[cat].label.toLowerCase()} detected.</span>
        </p>
        <SearchBox base={base} cur={cur} placeholder={`Search ${CAT[cat].noun}s…`} />
      </div>

      {dir.rows.length === 0 ? (
        <p className="mt-8 text-cream/50">No partner data available yet.</p>
      ) : shown.length === 0 ? (
        <p className="mt-8 text-sm text-cream/50">
          {q ? <>No {CAT[cat].noun} matching “{q}” in {where}.</> : <>No {CAT[cat].noun}s detected in {where} yet.</>}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                <th className="w-10 py-2 pl-3 pr-2 text-right">#</th>
                <th className="py-2 pr-3 text-left">{CAT[cat].label === "Apps" ? "App" : CAT[cat].label === "Shipping" ? "Carrier" : "Gateway"}</th>
                {cat === "payments" && <th className="py-2 pr-3 text-left">Type</th>}
                <th className="py-2 pr-3 text-right">Stores</th>
                <th className="w-40 py-2 pr-3 text-left">Share of stores</th>
                {!country && <th className="py-2 pr-4 text-right">Markets</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ r, n, rank }) => {
                const share = denom ? (n / denom) * 100 : 0;
                const markets = Object.keys(r.by).length;
                const href = r.slug ? `/p/${r.slug}${country ? `?country=${country}` : ""}` : null;
                return (
                  <tr key={r.name} className="border-b border-cream/[0.06] last:border-0 hover:bg-cream/[0.03]">
                    <td className="py-2.5 pl-3 pr-2 text-right text-xs tabular-nums text-cream/30">{rank}</td>
                    <td className="py-2.5 pr-3 text-sm text-cream/90">
                      {href ? (
                        <Link href={href} className="hover:text-cyan" title={`Open the ${r.name} market report`}>
                          {r.name}<span className="ml-2 text-[10px] uppercase tracking-wide text-cyan/70">report →</span>
                        </Link>
                      ) : r.name}
                    </td>
                    {cat === "payments" && (
                      <td className="py-2.5 pr-3">
                        {r.subtype
                          ? <span className={`text-[11px] font-semibold ${TYPE_TONE[r.subtype] ?? "text-cream/50"}`}>{r.subtype}</span>
                          : <span className="text-[11px] text-cream/30">—</span>}
                      </td>
                    )}
                    <td className="py-2.5 pr-3 text-right text-sm tabular-nums text-cream/85">{n.toLocaleString()}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                          <div className="h-full rounded-full bg-cyan/60" style={{ width: `${Math.max(2, (n / top) * 100)}%` }} />
                        </div>
                        <span className="w-10 text-right text-[11px] tabular-nums text-cream/50">{share >= 1 ? share.toFixed(0) : share.toFixed(1)}%</span>
                      </div>
                    </td>
                    {!country && <td className="py-2.5 pr-4 text-right text-sm tabular-nums text-cream/55">{markets}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!q && matches.length > PAGE && (
        <div className="mt-3 text-center">
          <Link href={hrefWith(base, cur, { all: showAll ? null : "1" })} className="text-xs text-cyan hover:underline">
            {showAll ? `Show top ${PAGE}` : `Show all ${matches.length.toLocaleString()} ${CAT[cat].noun}s`}
          </Link>
        </div>
      )}

      <p className="mt-6 text-[11px] leading-relaxed text-cream/40">
        Counts are live, published stores with the product detected (payments &amp; shipping verified at checkout; apps from installed-app data).
        Share = % of stores in this market where we detected any {CAT[cat].label.toLowerCase()}.
      </p>
    </div>
  );
}

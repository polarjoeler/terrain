import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { productDirectory, storesIn, directoryCountries, countryCode, PRODUCT_CATEGORIES, type ProductCategory } from "@/lib/partner-directory";
import { servicePartners } from "@/lib/service-partners";
import { flag, marketName } from "./filters";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Partner Finder" };

const CAT_LABEL: Record<ProductCategory, string> = { payments: "Payment gateways", apps: "Apps", shipping: "Shipping carriers" };

export default async function PartnerFinderPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  // Sequential: the directory is one cached row read; service partners is one small table.
  const dir = await productDirectory().catch(() => null);
  const services = await servicePartners();

  const cats = PRODUCT_CATEGORIES.map((c) => {
    const rows = (dir?.rows ?? []).filter((r) => r.cat === c).sort((a, b) => storesIn(b) - storesIn(a));
    return { c, count: rows.length, top: rows.slice(0, 3).map((r) => r.name) };
  });
  const productTotal = cats.reduce((s, x) => s + x.count, 0);
  const productMarkets = dir ? directoryCountries(dir).slice(0, 5) : [];

  const svcBy = new Map<string, number>();
  for (const p of services) { const k = countryCode(p.country); if (k) svcBy.set(k, (svcBy.get(k) ?? 0) + 1); }
  const svcMarkets = [...svcBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const verified = services.filter((p) => p.verified).length;

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="font-display text-2xl text-cream">Partner Finder</h1>
      <p className="mt-1 max-w-2xl text-xs text-cream/45">
        Two directories. <b className="text-cream/65">Product partners</b> are the payments, apps and carriers merchants run;
        <b className="text-cream/65"> service partners</b> are the agencies and pros who build the stores. Pick one, then narrow to a market.
      </p>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {/* Product Partners tile */}
        <div className="group relative flex flex-col rounded-3xl border border-cream/12 bg-cream/[0.02] p-6 transition hover:border-cyan/40 hover:bg-cream/[0.035]">
          <Link href="/partners/products" className="absolute inset-0 rounded-3xl" aria-label="Open Product Partners" />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan/80">Product Partners</div>
          <div className="mt-2 font-display text-4xl text-cream tabular-nums">{productTotal.toLocaleString()}</div>
          <div className="text-xs text-cream/45">products detected on live African stores</div>

          <div className="mt-5 space-y-2">
            {cats.map(({ c, count, top }) => (
              <Link key={c} href={`/partners/products?cat=${c}`}
                className="relative z-10 -mx-3 block rounded-xl px-3 py-2 hover:bg-cream/[0.05]">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-cream/85">{CAT_LABEL[c]}</span>
                  <span className="shrink-0 text-sm tabular-nums text-cream/60">{count.toLocaleString()}</span>
                </span>
                {top.length > 0 && <span className="mt-0.5 block truncate text-[11px] text-cream/35">Top: {top.join(" · ")}</span>}
              </Link>
            ))}
          </div>

          {productMarkets.length > 0 && (
            <div className="relative z-10 mt-auto flex flex-wrap gap-1.5 pt-5">
              {productMarkets.map((m) => (
                <Link key={m.code} href={`/partners/products?country=${m.code}`}
                  className="rounded-full border border-cream/12 px-2.5 py-0.5 text-[11px] text-cream/60 hover:border-cream/30 hover:text-cream">
                  {flag(m.code)} {marketName(m.code)}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Service Partners tile */}
        <div className="group relative flex flex-col rounded-3xl border border-cream/12 bg-cream/[0.02] p-6 transition hover:border-mint/40 hover:bg-cream/[0.035]">
          <Link href="/partners/services" className="absolute inset-0 rounded-3xl" aria-label="Open Service Partners" />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-mint/80">Service Partners</div>
          <div className="mt-2 font-display text-4xl text-cream tabular-nums">{services.length.toLocaleString()}</div>
          <div className="text-xs text-cream/45">agencies &amp; pros building stores · {verified} verified</div>

          <div className="mt-5 space-y-2">
            {svcMarkets.map(([cc, n]) => (
              <Link key={cc} href={`/partners/services?country=${cc}`}
                className="relative z-10 flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 -mx-3 hover:bg-cream/[0.05]">
                <span className="text-sm text-cream/85">{flag(cc)} {marketName(cc)}</span>
                <span className="text-sm tabular-nums text-cream/60">{n}</span>
              </Link>
            ))}
            {services.length - [...svcBy.values()].reduce((s, n) => s + n, 0) > 0 && (
              <Link href="/partners/services?country=other"
                className="relative z-10 flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 -mx-3 hover:bg-cream/[0.05]">
                <span className="text-sm text-cream/60">🌍 Pan-African / unplaced</span>
                <span className="text-sm tabular-nums text-cream/45">{services.length - [...svcBy.values()].reduce((s, n) => s + n, 0)}</span>
              </Link>
            )}
          </div>

          <div className="relative z-10 mt-auto pt-5 text-[11px] text-cream/40">Filter by market, platform focus or skill →</div>
        </div>
      </div>
    </div>
  );
}

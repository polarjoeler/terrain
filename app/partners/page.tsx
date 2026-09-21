import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import { productPartners, type ProductPartner, type PartnerCategory } from "@/lib/provider-insights";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Product Partners" };

const CAT_ORDER: PartnerCategory[] = ["Payments", "Apps", "Shipping"];
const CAT_META: Record<PartnerCategory, { blurb: string; color: string }> = {
  Payments: { blurb: "Gateways, BNPL & alternative rails, by live-store adoption", color: "#95BF47" },
  Apps: { blurb: "The apps merchants install — integration & collab targets", color: "#96588a" },
  Shipping: { blurb: "Carriers detected at checkout (generic ‘Shopify’ rates excluded)", color: "#8fb0c4" },
};
const TYPE_TONE: Record<string, string> = { PSP: "text-mint", BNPL: "text-orange", APM: "text-cyan" };

function Row({ p, rank }: { p: ProductPartner; rank: number }) {
  const inner = (
    <>
      <td className="py-2.5 pl-3 pr-2 text-right text-xs tabular-nums text-cream/30">{rank}</td>
      <td className="py-2.5 pr-3 text-sm text-cream/90">
        {p.name}
        {p.slug && <span className="ml-2 text-[10px] uppercase tracking-wide text-cyan/70">report →</span>}
      </td>
      <td className="py-2.5 pr-3 text-left">
        {p.subtype
          ? <span className={`text-[11px] font-semibold ${TYPE_TONE[p.subtype] ?? "text-cream/50"}`}>{p.subtype}</span>
          : <span className="text-[11px] text-cream/30">—</span>}
      </td>
      <td className="py-2.5 pr-3 text-right text-sm tabular-nums text-cream/85">{p.stores.toLocaleString()}</td>
      <td className="py-2.5 pr-4 text-right text-sm tabular-nums text-cream/55">{p.countries}</td>
    </>
  );
  return p.slug ? (
    <tr className="border-b border-cream/[0.06] transition hover:bg-cream/[0.03]">
      <td colSpan={5} className="p-0">
        <Link href={`/p/${p.slug}`} className="grid grid-cols-[2.5rem_1fr_5rem_5rem_5rem] items-center hover:text-cyan" title={`Open the ${p.name} market report`}>
          {inner}
        </Link>
      </td>
    </tr>
  ) : (
    <tr className="border-b border-cream/[0.06]">{inner}</tr>
  );
}

export default async function PartnersPage() {
  const email = await currentUser();
  if (!email) redirect("/login");

  const partners = await productPartners().catch(() => [] as ProductPartner[]);
  const byCat = new Map<PartnerCategory, ProductPartner[]>();
  for (const p of partners) (byCat.get(p.category) ?? byCat.set(p.category, []).get(p.category)!).push(p);

  const totalStores = (rows: ProductPartner[]) => rows.reduce((s, r) => s + r.stores, 0);

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">Product Partners</h1>
            <p className="mt-1 max-w-2xl text-xs text-cream/45">
              The who’s-who of payment, app &amp; shipping products in-market — ranked by how many live stores run each,
              so you can scan the landscape for integration and collaboration targets. Payment rows open a full market report.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link href="/partners/services" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">Service Partners →</Link>
            <Link href="/insights" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">Insights →</Link>
          </div>
        </div>

        {partners.length === 0 && (
          <p className="mt-8 text-cream/50">No partner data available yet.</p>
        )}

        {CAT_ORDER.filter((c) => byCat.has(c)).map((cat) => {
          const rows = byCat.get(cat)!;
          return (
            <section key={cat} className="mt-7">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="flex items-baseline gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: CAT_META[cat].color }} />
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/70">{cat}</h2>
                  <span className="text-[11px] text-cream/35">{CAT_META[cat].blurb}</span>
                </div>
                <span className="text-[11px] text-cream/35">{rows.length} · {totalStores(rows).toLocaleString()} store-links</span>
              </div>
              <div className="overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
                <table className="w-full min-w-[560px] border-collapse">
                  <thead>
                    <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                      <th className="py-2 pl-3 pr-2 text-right">#</th>
                      <th className="py-2 pr-3 text-left">Partner</th>
                      <th className="py-2 pr-3 text-left">Type</th>
                      <th className="py-2 pr-3 text-right">Stores</th>
                      <th className="py-2 pr-4 text-right">Countries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p, i) => <Row key={`${cat}:${p.name}`} p={p} rank={i + 1} />)}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

        <p className="mt-6 text-[11px] leading-relaxed text-cream/40">
          Counts are live, published stores with the product detected (payments &amp; shipping verified at checkout; apps from installed-app data).
          This is the <b className="text-cream/60">Product</b> directory. See the <Link href="/partners/services" className="text-cyan hover:underline">Service Partners</Link> directory for the agencies &amp; pros building these stores.
        </p>
      </div>
    </main>
  );
}

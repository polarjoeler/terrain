import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth";
import { coverageMatrix, type CoverageRow, type PlatCoverage } from "@/lib/ops";
import { countryEmoji, countryName, regionOf, REGION_ORDER } from "@/lib/countries";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terrain — Coverage" };

const SHOP = "#95BF47", WOO = "#96588a";

// A coverage cell: a small bar + the %, colour-coded per metric.
function Cov({ pct, tone }: { pct: number; tone: string }) {
  const c = tone === "mint" ? "bg-mint" : tone === "cyan" ? "bg-cyan" : "bg-lilac";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-cream/10">
        <div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-cream/70">{pct}%</span>
    </div>
  );
}

// One store count per platform: tracked (bold) with discovered dimmed beneath.
function PlatCount({ p, color }: { p: PlatCoverage | null; color: string }) {
  if (!p || p.discovered === 0) return <span className="text-cream/20">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={`${p.tracked.toLocaleString()} tracked · ${p.discovered.toLocaleString()} discovered`}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="tabular-nums text-cream/85">{p.tracked.toLocaleString()}</span>
      {p.discovered !== p.tracked && <span className="tabular-nums text-[10px] text-cream/30">/{p.discovered.toLocaleString()}</span>}
    </span>
  );
}

const OTHER = "#8fb0c4";
function CountryRow({ r }: { r: CoverageRow }) {
  return (
    <tr className={`border-b border-cream/[0.06] ${r.focus ? "bg-cream/[0.03]" : ""}`}>
      <td className="py-2.5 pl-3 pr-2">
        <Link href={`/ops/coverage/${r.country}`} className="text-sm text-cream/85 hover:text-cyan hover:underline" title="See every CMS in this country">
          {countryEmoji(r.country)} {countryName(r.country)}
        </Link>
        {r.focus && <span className="ml-2 rounded-full border border-mint/25 bg-mint/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-mint">focus</span>}
      </td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.shopify} color={SHOP} /></td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.woo} color={WOO} /></td>
      <td className="py-2.5 pr-3 text-right text-sm"><PlatCount p={r.other} color={OTHER} /></td>
      <td className="py-2.5 pr-3 text-right text-sm tabular-nums" title="Unconfirmed candidates (platform not yet verified, unpublished) — the Woo worker probes these and publishes the real ones">
        {r.pending > 0 ? <span className="text-cream/40">{r.pending.toLocaleString()}</span> : <span className="text-cream/20">—</span>}
      </td>
      <td className="py-2.5 pr-3"><Cov pct={r.combined.payPct} tone="mint" /></td>
      <td className="py-2.5 pr-3"><Cov pct={r.combined.launchPct} tone="cyan" /></td>
      <td className="py-2.5 pr-3"><Cov pct={r.combined.checkedPct} tone="lilac" /></td>
    </tr>
  );
}

export default async function CoveragePage() {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const m = await coverageMatrix().catch(() => null);
  if (!m) return <main className="grid min-h-screen place-items-center text-cream/50">Couldn&rsquo;t load coverage.</main>;

  // Group rows by region, in REGION_ORDER; keep the focus-first / size ordering inside each.
  const byRegion = new Map<string, CoverageRow[]>();
  for (const r of m.rows) {
    const reg = regionOf(r.country);
    (byRegion.get(reg) ?? byRegion.set(reg, []).get(reg)!).push(r);
  }

  const GrandCard = ({ label, color, p }: { label: string; color: string; p: PlatCoverage }) => (
    <div className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className="flex items-baseline gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-sm font-semibold text-cream">{label}</span>
        <span className="ml-auto font-display text-2xl tabular-nums text-cream">{p.tracked.toLocaleString()}</span>
        <span className="text-[11px] text-cream/35">tracked</span>
      </div>
      <div className="mt-3 space-y-2">
        {([["Payments", p.payPct, "mint"], ["Launch date", p.launchPct, "cyan"], ["Liveness", p.checkedPct, "lilac"]] as const).map(([l, v, t]) => (
          <div key={l} className="flex items-center gap-2 text-[11px] text-cream/50">
            <span className="w-20">{l}</span>
            <Cov pct={v} tone={t} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">Enrichment Coverage</h1>
            <p className="mt-1 text-xs text-cream/40">
              {m.discovered.toLocaleString()} discovered · {m.tracked.toLocaleString()} tracked · {m.pending.toLocaleString()} pending · {m.totalCountries} countries
            </p>
          </div>
          <Link href="/ops" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">← Ops</Link>
        </div>

        {/* Grand totals per platform */}
        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          <GrandCard label="Shopify" color={SHOP} p={m.grand.shopify} />
          <GrandCard label="WooCommerce" color={WOO} p={m.grand.woo} />
          <GrandCard label="Other CMS" color={OTHER} p={m.grand.other} />
        </section>

        {/* What the numbers mean */}
        <section className="mt-4 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4 text-[11px] leading-relaxed text-cream/55">
          <div className="mb-1.5 font-semibold uppercase tracking-wide text-cream/40">How to read this</div>
          <ul className="space-y-1">
            <li><b className="text-cream/80">Stores</b> — the bold number is <b className="text-cream/80">tracked</b> (published &amp; live — the set we present and enrich, and what Insights counts); the dim <span className="text-cream/40">/number</span> is everything <b className="text-cream/80">discovered</b> (incl. unpublished imports and stores we&rsquo;ve since confirmed dead or migrated off-platform).</li>
            <li><span className="text-mint">■</span> <b className="text-cream/80">Payments</b> — % of tracked stores with ≥1 payment gateway verified at checkout (Shopify checkout probe; Woo Store API / plugins).</li>
            <li><span className="text-cyan">■</span> <b className="text-cream/80">Launch date</b> — % with a real launch date on record (earliest product, StoreLeads launch, or first SSL cert).</li>
            <li><span className="text-lilac">■</span> <b className="text-cream/80">Liveness</b> — % with a liveness check on record (we&rsquo;ve confirmed alive/dead status at least once).</li>
            <li><b className="text-cream/80">Other</b> — every CMS that isn&rsquo;t Shopify or Woo (Wix, Squarespace, Magento, BigCommerce, Webflow, PrestaShop, Odoo, Ecwid…), rolled up. Captured but not yet surfaced in insights.</li>
            <li><b className="text-cream/80">Pending</b> — candidate domains we&rsquo;ve imported but not yet confirmed (platform unverified, unpublished). The Woo worker probes these and publishes the real ones, moving them into the Woo column.</li>
          </ul>
          <p className="mt-2 text-cream/40">Coverage % is over tracked stores. Focus markets (🇿🇦 🇰🇪 🇳🇬 🇯🇵) are actively enriched; the rest of the world is discovered &amp; banked but only lightly enriched. <b className="text-cream/70">Click any country</b> to see every CMS in it.</p>
        </section>

        {/* Region sections */}
        {REGION_ORDER.filter((reg) => byRegion.has(reg)).map((reg) => {
          const rows = byRegion.get(reg)!;
          const tracked = rows.reduce((s, r) => s + r.tracked, 0);
          return (
            <section key={reg} className="mt-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-cream/60">{reg}</h2>
                <span className="text-[11px] text-cream/35">{rows.length} countries · {tracked.toLocaleString()} tracked</span>
              </div>
              <div className="overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead>
                    <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                      <th className="py-2 pl-3 pr-2 text-left">Country</th>
                      <th className="py-2 pr-3 text-right">Shopify</th>
                      <th className="py-2 pr-3 text-right">Woo</th>
                      <th className="py-2 pr-3 text-right">Other</th>
                      <th className="py-2 pr-3 text-right">Pending</th>
                      <th className="py-2 pr-3 text-right">Payments</th>
                      <th className="py-2 pr-3 text-right">Launch</th>
                      <th className="py-2 pr-3 text-right">Liveness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => <CountryRow key={r.country} r={r} />)}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

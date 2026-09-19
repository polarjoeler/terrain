import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/auth";
import { countryCoverage, type CmsCoverage } from "@/lib/ops";
import { countryEmoji, countryName } from "@/lib/countries";

export const dynamic = "force-dynamic";

const PLATFORM_COLOR: Record<string, string> = {
  Shopify: "#95BF47", WooCommerce: "#96588a", Wix: "#faad4d", Squarespace: "#c9c9c9",
  Magento: "#f26322", BigCommerce: "#34313f", Webflow: "#4353ff", PrestaShop: "#df0067",
  Odoo: "#714b67", Ecwid: "#1fb7ff",
};

function Bar({ pct, tone }: { pct: number; tone: string }) {
  const c = tone === "mint" ? "bg-mint" : tone === "cyan" ? "bg-cyan" : "bg-lilac";
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-cream/10"><div className={`h-full rounded-full ${c}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <span className="w-9 text-right text-xs tabular-nums text-cream/70">{pct}%</span>
    </div>
  );
}

export default async function CountryCoveragePage({ params }: { params: Promise<{ country: string }> }) {
  const email = await currentUser();
  if (!email) redirect("/login");
  if (!isAdmin(email)) redirect("/dashboard");

  const { country } = await params;
  const cc = country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) notFound();
  const rows: CmsCoverage[] = await countryCoverage(cc).catch(() => []);
  const totalDiscovered = rows.reduce((s, r) => s + r.discovered, 0);
  const totalTracked = rows.reduce((s, r) => s + r.tracked, 0);

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl text-cream">{countryEmoji(cc)} {countryName(cc)} — every CMS</h1>
            <p className="mt-1 text-xs text-cream/40">{totalDiscovered.toLocaleString()} discovered · {totalTracked.toLocaleString()} tracked · {rows.length} platforms seen</p>
          </div>
          <Link href="/ops/coverage" className="rounded-full border border-cream/15 px-3 py-1 text-sm text-cream/60 hover:text-cream">← Coverage</Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-sm text-cream/40">No stores recorded for this country yet.</p>
        ) : (
          <section className="mt-5 overflow-x-auto rounded-3xl border border-cream/12 bg-cream/[0.02]">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
                  <th className="py-2.5 pl-4 pr-2 text-left">Platform</th>
                  <th className="py-2.5 pr-3 text-right">Tracked</th>
                  <th className="py-2.5 pr-3 text-right">Discovered</th>
                  <th className="py-2.5 pr-3 text-right">Payments</th>
                  <th className="py-2.5 pr-3 text-right">Launch</th>
                  <th className="py-2.5 pr-3 text-right">Liveness</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.platform} className="border-b border-cream/[0.06]">
                    <td className="py-2.5 pl-4 pr-2">
                      <span className="inline-flex items-center gap-2 text-sm text-cream/85">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[r.platform] ?? "#8fb0c4" }} />
                        {r.platform}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-display text-base tabular-nums text-cream">{r.tracked.toLocaleString()}</td>
                    <td className="py-2.5 pr-3 text-right text-xs tabular-nums text-cream/40">{r.discovered.toLocaleString()}</td>
                    <td className="py-2.5 pr-3"><Bar pct={r.payPct} tone="mint" /></td>
                    <td className="py-2.5 pr-3"><Bar pct={r.launchPct} tone="cyan" /></td>
                    <td className="py-2.5 pr-3"><Bar pct={r.checkedPct} tone="lilac" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <p className="mt-4 text-[11px] text-cream/35">
          Tracked = published &amp; live; coverage % is over tracked. Platforms other than Shopify/Woo (Wix, Magento, Squarespace…) are captured but not yet surfaced in insights. &ldquo;(unconfirmed)&rdquo; = candidates awaiting a probe.
        </p>
      </div>
    </main>
  );
}

import { jpStats } from "@/lib/jp";
import { t } from "@/lib/jp-i18n";
import { jpLocale } from "./locale";

export const dynamic = "force-dynamic";

const PCOLOR: Record<string, string> = {
  Shopify: "#95BF47", WooCommerce: "#96588a", BASE: "#00b900", Cafe24: "#0a6add",
  "EC-CUBE": "#e8622c", Wix: "#faad4d", "Salesforce Commerce Cloud": "#6fc0c8",
  Magento: "#f26322", Squarespace: "#c9c9c9", Webflow: "#4a7cf7",
};
const pc = (p: string) => PCOLOR[p] ?? "#8fb0c4";

export default async function JpOverview() {
  const locale = await jpLocale();
  const s = await jpStats();
  const maxPlat = Math.max(1, ...s.byPlatform.map((p) => p.n));
  const maxYear = Math.max(1, ...s.byYear.map((y) => y.n));
  const maxPay = Math.max(1, ...s.topPayments.map((p) => p.n));

  const Stat = ({ v, l, tone = "text-cream" }: { v: string | number; l: string; tone?: string }) => (
    <div className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
      <div className={`font-display text-3xl tabular-nums ${tone}`}>{typeof v === "number" ? v.toLocaleString() : v}</div>
      <div className="mt-1 text-[12px] text-cream/50">{l}</div>
    </div>
  );

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <h1 className="font-display text-2xl text-cream sm:text-3xl">{t("tagline", locale)}</h1>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat v={s.total} l={t("stat_stores", locale)} />
        <Stat v={`${s.total ? Math.round((100 * s.dated) / s.total) : 0}%`} l={t("stat_dated", locale)} tone="text-cyan" />
        <Stat v={`${s.paidPct}%`} l={t("stat_payments", locale)} tone="text-mint" />
        <Stat v={s.newThisQuarter} l={t("stat_newq", locale)} tone="text-lilac" />
      </section>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {/* Platforms */}
        <section className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
          <h2 className="font-display text-lg text-cream">{t("h_platform", locale)}</h2>
          <p className="mt-0.5 text-xs text-cream/45">{t("h_platform_sub", locale)}</p>
          <div className="mt-4 space-y-2.5">
            {s.byPlatform.slice(0, 8).map((p) => (
              <div key={p.label} className="flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 truncate text-cream/80">{p.label}</span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                  <div className="h-full rounded-full" style={{ width: `${(p.n / maxPlat) * 100}%`, background: pc(p.label) }} />
                </div>
                <span className="w-12 text-right tabular-nums text-cream/60">{p.n.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Launches by year */}
        <section className="rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
          <h2 className="font-display text-lg text-cream">{t("h_launches", locale)}</h2>
          <p className="mt-0.5 text-xs text-cream/45">{t("h_launches_sub", locale)}</p>
          <div className="mt-5 flex h-40 items-end gap-1.5">
            {s.byYear.map((y) => (
              <div key={y.year} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${y.year}: ${y.n.toLocaleString()}`}>
                <div className="w-full rounded-t bg-gradient-to-t from-mint/40 to-mint" style={{ height: `${Math.max(2, (y.n / maxYear) * 100)}%` }} />
                <span className="text-[9px] tabular-nums text-cream/40">{y.year.slice(2)}</span>
              </div>
            ))}
            {s.byYear.length === 0 && <span className="text-sm text-cream/40">—</span>}
          </div>
        </section>
      </div>

      {/* Density by prefecture — the JP answer to the Africa country map */}
      <section className="mt-6 rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
        <h2 className="font-display text-lg text-cream">{t("h_cities", locale)}</h2>
        <p className="mt-0.5 text-xs text-cream/45">{t("h_cities_sub", locale)}</p>
        {s.byCity.length ? (
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
            {s.byCity.map((c) => {
              const maxCity = Math.max(1, ...s.byCity.map((x) => x.n));
              return (
                <div key={c.label} className="flex items-center gap-3 text-sm">
                  <span className="w-24 shrink-0 truncate text-cream/80">{c.label}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                    <div className="h-full rounded-full bg-gradient-to-r from-orange/60 to-orange" style={{ width: `${(c.n / maxCity) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right tabular-nums text-cream/60">{c.n.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 text-sm text-cream/40">{t("cities_coming", locale)}</p>
        )}
      </section>

      {/* Payments */}
      <section className="mt-6 rounded-2xl border border-cream/12 bg-cream/[0.02] p-5">
        <h2 className="font-display text-lg text-cream">{t("h_payments", locale)}</h2>
        <p className="mt-0.5 text-xs text-cream/45">{t("h_payments_sub", locale)}</p>
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {s.topPayments.map((p) => (
            <div key={p.label} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 truncate text-cream/80">{p.label}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-cream/[0.06]">
                <div className="h-full rounded-full bg-cyan" style={{ width: `${(p.n / maxPay) * 100}%` }} />
              </div>
              <span className="w-12 text-right tabular-nums text-cream/60">{p.n.toLocaleString()}</span>
            </div>
          ))}
          {s.topPayments.length === 0 && <span className="text-sm text-cream/40">{t("none", locale)}</span>}
        </div>
      </section>
    </main>
  );
}

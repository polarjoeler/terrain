"use client";
import { useMemo, useState } from "react";
import { t, type Locale } from "@/lib/jp-i18n";
import type { JpLead } from "@/lib/jp";

const PCOLOR: Record<string, string> = {
  Shopify: "#95BF47", WooCommerce: "#96588a", BASE: "#00b900", Cafe24: "#0a6add",
  "EC-CUBE": "#e8622c", Wix: "#faad4d", "Salesforce Commerce Cloud": "#6fc0c8", Magento: "#f26322",
};
const pc = (p: string | null) => (p && PCOLOR[p]) || "#8fb0c4";

export function JpLeadsTable({ leads, locale }: { leads: JpLead[]; locale: Locale }) {
  const [q, setQ] = useState("");
  const [plat, setPlat] = useState("");
  const platforms = useMemo(() => [...new Set(leads.map((l) => l.platform).filter(Boolean))] as string[], [leads]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leads.filter((l) =>
      (!plat || l.platform === plat) &&
      (!needle || l.name.toLowerCase().includes(needle) || l.domain.toLowerCase().includes(needle) || (l.category ?? "").toLowerCase().includes(needle)),
    );
  }, [leads, q, plat]);

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-2xl text-cream">{t("leads_title", locale)}</h1>
          <p className="mt-1 text-xs text-cream/45">{t("leads_sub", locale)}</p>
        </div>
        <span className="text-sm tabular-nums text-cream/50">{rows.length.toLocaleString()} {t("leads_count", locale)}</span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("leads_search", locale)}
          className="min-w-[220px] flex-1 rounded-full border border-cream/15 bg-cream/[0.03] px-4 py-1.5 text-sm text-cream placeholder:text-cream/30 focus:border-cream/40 focus:outline-none" />
        <select value={plat} onChange={(e) => setPlat(e.target.value)}
          className="rounded-full border border-cream/15 bg-cream/[0.03] px-3 py-1.5 text-sm text-cream focus:outline-none">
          <option value="">{t("leads_all", locale)}</option>
          {platforms.map((p) => <option key={p} value={p} className="bg-ink">{p}</option>)}
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-cream/12 bg-cream/[0.02]">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-cream/12 text-[10px] font-semibold uppercase tracking-wide text-cream/40">
              <th className="py-2.5 pl-4 pr-3 text-left">{t("col_store", locale)}</th>
              <th className="py-2.5 pr-3 text-left">{t("col_platform", locale)}</th>
              <th className="py-2.5 pr-3 text-left">{t("col_launched", locale)}</th>
              <th className="py-2.5 pr-3 text-left">{t("col_payments", locale)}</th>
              <th className="py-2.5 pr-3 text-left">{t("col_location", locale)}</th>
              <th className="py-2.5 pr-4 text-right">{t("col_products", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.domain} className="border-b border-cream/[0.06] hover:bg-cream/[0.03]">
                <td className="py-2.5 pl-4 pr-3">
                  <a href={`https://${l.domain}`} target="_blank" rel="noopener noreferrer" className="text-sm text-cream/90 hover:text-cyan hover:underline">{l.name}</a>
                  <div className="text-[11px] text-cream/35">{l.domain}{l.category ? ` · ${l.category}` : ""}</div>
                </td>
                <td className="py-2.5 pr-3">
                  {l.platform
                    ? <span className="inline-flex items-center gap-1.5 text-xs text-cream/75"><span className="h-2 w-2 rounded-full" style={{ background: pc(l.platform) }} />{l.platform}</span>
                    : <span className="text-cream/25">—</span>}
                </td>
                <td className="py-2.5 pr-3 text-sm tabular-nums text-cream/70">{l.launched ?? <span className="text-cream/25">{t("no_date", locale)}</span>}</td>
                <td className="py-2.5 pr-3">
                  {l.payments.length
                    ? <span className="flex flex-wrap gap-1">{l.payments.map((p) => <span key={p} className="rounded-full border border-cream/12 px-1.5 py-0.5 text-[10px] text-cream/60">{p}</span>)}</span>
                    : <span className="text-cream/25">—</span>}
                </td>
                <td className="py-2.5 pr-3 text-sm text-cream/60">{l.city ?? <span className="text-cream/25">—</span>}</td>
                <td className="py-2.5 pr-4 text-right text-sm tabular-nums text-cream/60">{l.productCount != null ? l.productCount.toLocaleString() : <span className="text-cream/25">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

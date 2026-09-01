"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";

export type ProviderRow = {
  provider: string;
  stores: number;
  type: PayType;
  slug: string;
  token: string;
};

const TYPE_LABEL: Record<PayType, string> = { PSP: "PSP", BNPL: "BNPL", APM: "Wallet / APM" };
const TYPE_TONE: Record<PayType, string> = {
  PSP: "border-orange/30 bg-orange/10 text-orange",
  BNPL: "border-mint/30 bg-mint/10 text-mint",
  APM: "border-lilac/30 bg-lilac/10 text-lilac",
};

export function ProvidersView({ rows }: { rows: ProviderRow[] }) {
  const [type, setType] = useState<PayType | "">("");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!type || r.type === type) && (!needle || r.provider.toLowerCase().includes(needle)));
  }, [rows, type, q]);

  const copy = (r: ProviderRow) => {
    const url = `${window.location.origin}/p/${r.slug}${r.token ? `?t=${encodeURIComponent(r.token)}` : ""}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(r.provider);
      setTimeout(() => setCopied((c) => (c === r.provider ? null : c)), 2000);
    });
  };

  const counts = useMemo(() => {
    const m = new Map<PayType, number>();
    for (const r of rows) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setType("")}
          className={`rounded-full px-3.5 py-1.5 text-sm ${!type ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}
        >
          All {rows.length}
        </button>
        {PAY_TYPES.filter((t) => counts.get(t)).map((t) => (
          <button
            key={t}
            onClick={() => setType(type === t ? "" : t)}
            className={`rounded-full px-3.5 py-1.5 text-sm ${type === t ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}
          >
            {TYPE_LABEL[t]} {counts.get(t)}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search gateways…"
          className="ml-auto w-48 rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/30 focus:border-cream/50"
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-3xl border border-cream/12">
        <table className="w-full text-left text-sm">
          <thead className="bg-cream/[0.04] text-xs uppercase tracking-wide text-cream/45">
            <tr>
              <th className="px-5 py-3 font-semibold">Gateway</th>
              <th className="px-5 py-3 font-semibold">Type</th>
              <th className="px-5 py-3 text-right font-semibold">Stores</th>
              <th className="px-5 py-3 text-right font-semibold">Report</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.provider} className="border-t border-cream/8 hover:bg-cream/[0.03]">
                <td className="px-5 py-3">
                  <Link href={`/p/${r.slug}`} className="font-medium text-cream hover:underline">{r.provider}</Link>
                  <div className="text-xs text-cream/35">/p/{r.slug}</div>
                </td>
                <td className="px-5 py-3">
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TYPE_TONE[r.type]}`}>
                    {TYPE_LABEL[r.type]}
                  </span>
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-cream/80">{r.stores.toLocaleString()}</td>
                <td className="px-5 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Link href={`/p/${r.slug}`} className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/70 transition hover:border-cream/40 hover:text-cream">
                      Open
                    </Link>
                    {r.token && (
                      <button
                        onClick={() => copy(r)}
                        className="rounded-full border border-cyan/40 px-3 py-1 text-xs text-cyan transition hover:bg-cyan/10"
                      >
                        {copied === r.provider ? "✓ Copied" : "Copy share link"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="px-5 py-6 text-cream/50">No gateways match.</p>}
      </div>
    </>
  );
}

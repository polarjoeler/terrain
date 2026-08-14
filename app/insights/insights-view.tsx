"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";
import { classify, PAY_TYPES, type PayType } from "@/lib/payments-taxonomy";
import type { InsightSnapshot, Share } from "@/lib/sheets";

/* ---- fallback sample data (used only when no live snapshot exists) -------- */
const MOCK: InsightSnapshot = {
  date: "",
  stores_total: 531,
  new_this_week: 46,
  plus_total: 31,
  plus_new_this_week: 8,
  payments_verified_stores: 240,
  payments_by_provider: [
    { label: "PayFast", pct: 60 }, { label: "Yoco", pct: 32 },
    { label: "Payflex", pct: 28 }, { label: "Mobicred", pct: 22 },
    { label: "Shop Pay", pct: 14 }, { label: "Apple Pay", pct: 12 },
    { label: "PayPal", pct: 9 },
  ],
  payments_by_type: { PSP: 95, BNPL: 43, APM: 67 },
  first_at_checkout: [
    { label: "PayFast", pct: 60 }, { label: "Yoco", pct: 24 },
    { label: "Peach Payments", pct: 4 }, { label: "Ozow", pct: 3 },
  ],
  themes: [
    { label: "Dawn", pct: 34 }, { label: "Impulse", pct: 18 },
    { label: "Refresh", pct: 12 }, { label: "Custom / agency", pct: 27 },
  ],
  apps: [
    { label: "Meta Pixel", pct: 71 }, { label: "Klaviyo", pct: 44 },
    { label: "Judge.me", pct: 33 }, { label: "Recharge", pct: 12 },
  ],
};

const PERIODS = ["Week", "Month", "Quarter", "Year"] as const;
const COMPARISON: Record<(typeof PERIODS)[number], string> = {
  Week: "WoW", Month: "MoM", Quarter: "QoQ", Year: "YoY",
};

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="text-cream/30">—</span>;
  const up = v >= 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲" : "▼"} {Math.abs(v)}%
    </span>
  );
}

function Bar({ label, pct, tone = "orange" }: Share & { tone?: string }) {
  const fill = tone === "mint" ? "bg-mint" : tone === "lilac" ? "bg-lilac" : "bg-orange";
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 truncate text-sm text-cream/70">{label}</div>
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-cream/10">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="w-10 shrink-0 text-right text-sm tabular-nums text-cream/60">{pct}%</div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <h3 className="text-lg font-semibold">{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-cream/45">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

function TrendLine({ data }: { data: number[] }) {
  const w = 520, h = 180;
  const max = Math.max(...data, 1);
  const step = w / Math.max(data.length - 1, 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 20)] as const);
  const line = pts.map((p) => p.join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="var(--color-orange)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--color-orange)" strokeWidth="3" strokeLinejoin="round" />
      {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="4" fill="var(--color-orange)" />)}
    </svg>
  );
}

export function InsightsView({
  snapshot,
  history,
  live,
}: {
  snapshot: InsightSnapshot | null;
  history: InsightSnapshot[];
  live: boolean;
}) {
  const [platform, setPlatform] = useState("Shopify");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("Week");
  const d = snapshot ?? MOCK;

  // WoW delta vs the previous snapshot, when we have one.
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const delta = (cur: number, key: keyof InsightSnapshot) =>
    prev && typeof prev[key] === "number" && (prev[key] as number) > 0
      ? Math.round((100 * (cur - (prev[key] as number))) / (prev[key] as number))
      : null;

  // Group providers by PSP/BNPL/APM for the segmented view.
  const byType: Record<PayType, Share[]> = { PSP: [], BNPL: [], APM: [] };
  for (const p of d.payments_by_provider) byType[classify(p.label)].push(p);

  // Cumulative Plus trend from history (falls back to a single point).
  const plusTrend = history.length ? history.map((h) => h.plus_total) : [d.plus_total];

  const tiles = [
    { n: `${d.stores_total}`, label: "stores tracked", del: delta(d.stores_total, "stores_total"), tone: "outline" },
    { n: `+${d.new_this_week}`, label: `new this ${period.toLowerCase()}`, del: null, tone: "mint" },
    { n: `${d.plus_total}`, label: "Shopify Plus", del: delta(d.plus_total, "plus_total"), tone: "lilac" },
    { n: `${d.payments_verified_stores}`, label: "checkout-verified", del: null, tone: "outline" },
  ];

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/"><Wordmark size="text-xl" /></Link>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${live ? "border-mint/25 bg-mint/10 text-mint" : "border-cream/20 text-cream/50"}`}>
            {live ? "Live data" : "Preview / mockup"}
          </span>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Market Insights</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Where the African Shopify market is heading — payment stacks, themes,
            apps and enterprise adoption, tracked over time.
          </p>
        </header>

        {/* filters */}
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Platform</span>
            <button onClick={() => setPlatform("Shopify")} className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${platform === "Shopify" ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"}`}>
              <span className="h-2 w-2 rounded-full bg-[#95BF47]" /> Shopify
            </button>
            <button disabled className="cursor-not-allowed rounded-full border border-cream/10 px-3.5 py-1.5 text-sm text-cream/30">WooCommerce · soon</button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">Period</span>
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setPeriod(p)} className={`rounded-full px-3.5 py-1.5 text-sm ${period === p ? "bg-orange text-cream" : "border border-cream/15 text-cream/60"}`}>{p}</button>
            ))}
            <span className="ml-1 rounded-full border border-cream/15 px-3 py-1.5 text-xs text-cream/50">vs last · {COMPARISON[period]}</span>
          </div>
        </div>

        {/* stat tiles */}
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {tiles.map((s) => (
            <div key={s.label} className={`rounded-3xl px-5 py-6 ${s.tone === "mint" ? "bg-mint text-ink" : s.tone === "lilac" ? "bg-lilac text-ink" : "border border-cream/12 text-cream"}`}>
              <div className="font-display text-5xl leading-none">{s.n}</div>
              <div className="mt-2 flex items-center justify-between">
                <span className={`text-xs font-medium uppercase tracking-wide ${s.tone === "outline" ? "text-cream/45" : "opacity-70"}`}>{s.label}</span>
                <span className="text-xs font-semibold"><Delta v={s.del} /></span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Card title="Payment providers by type" subtitle="Share of checkout-verified stores">
            <div className="space-y-6">
              {PAY_TYPES.map((t) => byType[t].length ? (
                <div key={t}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-cream/80">{t}</span>
                    <span className="text-[11px] text-cream/40">{t === "PSP" ? "Payment service providers" : t === "BNPL" ? "Buy now, pay later" : "Alternative payment methods"} · {d.payments_by_type[t] ?? 0}% of stores</span>
                  </div>
                  <div className="space-y-3">
                    {byType[t].map((i) => <Bar key={i.label} {...i} tone={t === "PSP" ? "orange" : t === "BNPL" ? "mint" : "lilac"} />)}
                  </div>
                </div>
              ) : null)}
            </div>
          </Card>

          <div className="space-y-5">
            <Card title="Shopify Plus adoption" subtitle="Cumulative total over time">
              <TrendLine data={plusTrend} />
              <p className="pt-3 text-sm text-cream/45">
                {d.plus_new_this_week} new this week · {d.plus_total} total.
                {history.length < 2 && " Trend builds as weekly snapshots accumulate."}
              </p>
            </Card>
            <Card title="First at checkout" subtitle="The default / primary gateway">
              <div className="space-y-3">
                {d.first_at_checkout.map((f) => <Bar key={f.label} {...f} />)}
              </div>
            </Card>
          </div>

          <Card title="Theme market share" subtitle="Most-used storefront themes">
            <div className="space-y-3">{d.themes.map((t) => <Bar key={t.label} {...t} tone="mint" />)}</div>
          </Card>

          <Card title="Top apps installed" subtitle="Marketing & conversion stack">
            <div className="space-y-3">{d.apps.map((a) => <Bar key={a.label} {...a} tone="lilac" />)}</div>
          </Card>
        </div>

        <p className="mt-8 text-center text-xs text-cream/40">
          {live
            ? `Live Terrain data · snapshot ${d.date}`
            : "Mockup with sample figures · charts will be driven by live Terrain data"}
        </p>
      </div>
    </div>
  );
}

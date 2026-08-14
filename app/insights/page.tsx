"use client";

import { useState } from "react";
import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

/* ------------------------------------------------------------ mock data --- */

// Payment providers now carry a type: PSP, BNPL or APM.
const payments = {
  PSP: [
    { label: "PayFast", pct: 62 },
    { label: "Yoco", pct: 41 },
    { label: "Peach Payments", pct: 18 },
    { label: "Ozow", pct: 17 },
  ],
  BNPL: [
    { label: "Payflex", pct: 28 },
    { label: "Mobicred", pct: 22 },
    { label: "Float", pct: 7 },
  ],
  APM: [
    { label: "Shop Pay", pct: 14 },
    { label: "Apple Pay", pct: 12 },
    { label: "SnapScan", pct: 11 },
    { label: "PayPal", pct: 9 },
  ],
};

// Which provider appears FIRST at checkout (the default/primary gateway).
const firstAtCheckout = [
  { label: "PayFast", pct: 54 },
  { label: "Yoco", pct: 21 },
  { label: "Peach Payments", pct: 11 },
  { label: "Ozow", pct: 8 },
  { label: "Other", pct: 6 },
];

const themeShare = [
  { label: "Dawn", pct: 34 },
  { label: "Impulse", pct: 18 },
  { label: "Refresh", pct: 12 },
  { label: "Prestige", pct: 9 },
  { label: "Custom / agency", pct: 27 },
];

const topApps = [
  { label: "Meta Pixel", pct: 71 },
  { label: "Klaviyo", pct: 44 },
  { label: "Judge.me", pct: 33 },
  { label: "Bold Upsell", pct: 19 },
  { label: "Recharge", pct: 12 },
];

const categories = [
  { label: "Fashion & Apparel", pct: 31 },
  { label: "Home & Living", pct: 19 },
  { label: "Beauty & Skincare", pct: 17 },
  { label: "Food & Beverage", pct: 14 },
  { label: "Electronics", pct: 10 },
  { label: "Other", pct: 9 },
];

// Shopify Plus: new per month + cumulative.
const plusNew = [4, 2, 3, 2, 3, 5, 4, 8];
const plusCumulative = plusNew.reduce<number[]>((a, n) => {
  a.push((a[a.length - 1] ?? 0) + n);
  return a;
}, []);

const PERIODS = ["Week", "Month", "Quarter", "Year"] as const;
const COMPARISON: Record<(typeof PERIODS)[number], string> = {
  Week: "WoW",
  Month: "MoM",
  Quarter: "QoQ",
  Year: "YoY",
};

/* --------------------------------------------------------- components ----- */

function Delta({ v }: { v: number }) {
  const up = v >= 0;
  return (
    <span className={up ? "text-mint" : "text-orange"}>
      {up ? "▲" : "▼"} {Math.abs(v)}%
    </span>
  );
}

function Bar({ label, pct, tone = "orange" }: { label: string; pct: number; tone?: string }) {
  const fill =
    tone === "mint" ? "bg-mint" : tone === "lilac" ? "bg-lilac" : "bg-orange";
  return (
    <div className="flex items-center gap-3">
      <div className="w-36 shrink-0 text-sm text-cream/70">{label}</div>
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-cream/10">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-10 shrink-0 text-right text-sm tabular-nums text-cream/60">
        {pct}%
      </div>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
      <h3 className="text-lg font-semibold">{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-cream/45">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}

/** Bars (new per period) + cumulative line, in one chart. */
function PlusCombo() {
  const w = 520;
  const h = 190;
  const pad = 16;
  const maxCum = Math.max(...plusCumulative);
  const maxNew = Math.max(...plusNew);
  const bw = (w - pad * 2) / plusNew.length;
  const linePts = plusCumulative
    .map((v, i) => `${pad + bw * i + bw / 2},${h - (v / maxCum) * (h - 30)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      {plusNew.map((v, i) => {
        const bh = (v / maxNew) * (h - 60);
        return (
          <rect
            key={i}
            x={pad + bw * i + 4}
            y={h - bh}
            width={bw - 8}
            height={bh}
            rx="3"
            fill="var(--color-lilac)"
            opacity="0.85"
          />
        );
      })}
      <polyline
        points={linePts}
        fill="none"
        stroke="var(--color-orange)"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {plusCumulative.map((v, i) => (
        <circle
          key={i}
          cx={pad + bw * i + bw / 2}
          cy={h - (v / maxCum) * (h - 30)}
          r="3.5"
          fill="var(--color-orange)"
        />
      ))}
    </svg>
  );
}

function PaymentSegment({
  type,
  items,
  tone,
}: {
  type: string;
  items: { label: string; pct: number }[];
  tone: string;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-cream/80">
          {type}
        </span>
        <span className="text-[11px] text-cream/40">
          {type === "PSP"
            ? "Payment service providers"
            : type === "BNPL"
              ? "Buy now, pay later"
              : "Alternative payment methods"}
        </span>
      </div>
      <div className="space-y-3">
        {items.map((i) => (
          <Bar key={i.label} {...i} tone={tone} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- page ------ */

export default function Insights() {
  const [platform, setPlatform] = useState("Shopify");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("Week");

  return (
    <div className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-6xl">
        <nav className="flex items-center justify-between">
          <Link href="/">
            <Wordmark size="text-xl" />
          </Link>
          <span className="rounded-full border border-mint/25 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-mint">
            Preview / mockup
          </span>
        </nav>

        <header className="mt-10">
          <h1 className="font-display text-4xl md:text-5xl">Market Insights</h1>
          <p className="mt-2 max-w-2xl text-cream/60">
            Where the African Shopify market is heading — payment stacks, themes,
            apps, categories and enterprise adoption, tracked over time.
          </p>
        </header>

        {/* filter bar: platform + period/comparison */}
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-3xl border border-cream/12 bg-cream/[0.03] px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">
              Platform
            </span>
            <button
              onClick={() => setPlatform("Shopify")}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ${
                platform === "Shopify" ? "bg-cream text-ink" : "border border-cream/15 text-cream/60"
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-[#95BF47]" /> Shopify
            </button>
            <button
              disabled
              className="cursor-not-allowed rounded-full border border-cream/10 px-3.5 py-1.5 text-sm text-cream/30"
            >
              WooCommerce · soon
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-cream/40">
              Period
            </span>
            {PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`rounded-full px-3.5 py-1.5 text-sm ${
                  period === p ? "bg-orange text-cream" : "border border-cream/15 text-cream/60"
                }`}
              >
                {p}
              </button>
            ))}
            <span className="ml-1 rounded-full border border-cream/15 px-3 py-1.5 text-xs text-cream/50">
              vs last · {COMPARISON[period]}
            </span>
          </div>
        </div>

        {/* stat tiles with deltas */}
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {[
            { n: "531", label: "SA stores tracked", d: 9, tone: "outline" },
            { n: "+46", label: `new this ${period.toLowerCase()}`, d: 12, tone: "mint" },
            { n: "31", label: "Shopify Plus", d: 8, tone: "lilac" },
            { n: "$21k", label: "median est. revenue", d: -3, tone: "outline" },
          ].map((s) => (
            <div
              key={s.label}
              className={`rounded-3xl px-5 py-6 ${
                s.tone === "mint"
                  ? "bg-mint text-ink"
                  : s.tone === "lilac"
                    ? "bg-lilac text-ink"
                    : "border border-cream/12 text-cream"
              }`}
            >
              <div className="font-display text-5xl leading-none">{s.n}</div>
              <div className="mt-2 flex items-center justify-between">
                <span
                  className={`text-xs font-medium uppercase tracking-wide ${
                    s.tone === "outline" ? "text-cream/45" : "opacity-70"
                  }`}
                >
                  {s.label}
                </span>
                <span className="text-xs font-semibold">
                  <Delta v={s.d} />
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Card
            title="Payment providers by type"
            subtitle={`Share of stores · ${COMPARISON[period]} view`}
          >
            <div className="space-y-6">
              <PaymentSegment type="PSP" items={payments.PSP} tone="orange" />
              <PaymentSegment type="BNPL" items={payments.BNPL} tone="mint" />
              <PaymentSegment type="APM" items={payments.APM} tone="lilac" />
            </div>
          </Card>

          <div className="space-y-5">
            <Card
              title="Shopify Plus adoption"
              subtitle="Bars = new this period · line = cumulative"
            >
              <PlusCombo />
              <p className="pt-3 text-sm text-cream/45">
                8 new Plus stores this month · 31 total — the replatforming wave
                is accelerating.
              </p>
            </Card>
            <Card
              title="First at checkout"
              subtitle="Which provider is the default / primary gateway"
            >
              <div className="space-y-3">
                {firstAtCheckout.map((f) => (
                  <Bar key={f.label} {...f} />
                ))}
              </div>
            </Card>
          </div>

          <Card title="Theme market share" subtitle="Most-used storefront themes">
            <div className="space-y-3">
              {themeShare.map((t) => (
                <Bar key={t.label} {...t} tone="mint" />
              ))}
            </div>
          </Card>

          <Card title="Top apps installed" subtitle="Marketing & conversion stack">
            <div className="space-y-3">
              {topApps.map((a) => (
                <Bar key={a.label} {...a} tone="lilac" />
              ))}
            </div>
          </Card>

          <Card title="Store categories" subtitle="What new merchants are selling">
            <div className="space-y-3">
              {categories.map((c) => (
                <Bar key={c.label} {...c} />
              ))}
            </div>
          </Card>

          <div className="flex flex-col justify-center rounded-[2rem] bg-orange p-8 text-ink-deep">
            <div className="font-display text-3xl md:text-4xl">
              Know the market before your competitors do.
            </div>
            <p className="mt-3 text-ink-deep/70">
              Every trend updates as Terrain discovers new stores — filter by
              week, month, quarter or year and watch the shifts.
            </p>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-cream/40">
          Mockup with sample figures · charts will be driven by live Terrain data
        </p>
      </div>
    </div>
  );
}

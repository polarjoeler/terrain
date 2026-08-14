import Link from "next/link";
import { Wordmark } from "@/app/components/logo";

export const metadata = {
  title: "Terrain — Market Insights (preview)",
};

/* ------------------------------------------------------------ mock data --- */

const paymentShare = [
  { label: "PayFast", pct: 62, tone: "orange" },
  { label: "Yoco", pct: 41, tone: "mint" },
  { label: "Payflex", pct: 28, tone: "mint" },
  { label: "Mobicred", pct: 22, tone: "mint" },
  { label: "Ozow", pct: 17, tone: "mint" },
  { label: "Shop Pay", pct: 14, tone: "lilac" },
  { label: "PayPal", pct: 9, tone: "lilac" },
];

const themeShare = [
  { label: "Dawn", pct: 34 },
  { label: "Impulse", pct: 18 },
  { label: "Refresh", pct: 12 },
  { label: "Prestige", pct: 9 },
  { label: "Custom / agency", pct: 27 },
];

const topApps = [
  { label: "Klaviyo", pct: 44 },
  { label: "Meta Pixel", pct: 71 },
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

// Plus-store count over the last 8 months.
const plusTrend = [4, 6, 9, 11, 14, 19, 23, 31];

/* --------------------------------------------------------- components ----- */

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
      <div className="mt-6 space-y-3.5">{children}</div>
    </div>
  );
}

function TrendLine({ data }: { data: number[] }) {
  const w = 520;
  const h = 180;
  const max = Math.max(...data);
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 20)] as const);
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      <polygon points={area} fill="var(--color-orange)" opacity="0.12" />
      <polyline
        points={line}
        fill="none"
        stroke="var(--color-orange)"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="4" fill="var(--color-orange)" />
      ))}
    </svg>
  );
}

const stats = [
  { n: "531", label: "SA stores tracked", tone: "outline" },
  { n: "+46", label: "new this week", tone: "mint" },
  { n: "31", label: "Shopify Plus", tone: "lilac" },
  { n: "$21k", label: "median est. revenue", tone: "outline" },
];

export default function Insights() {
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
            Where the South African Shopify market is heading — payment stacks,
            themes, apps, categories and enterprise adoption, tracked over time.
          </p>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-4">
          {stats.map((s) => (
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
              <div
                className={`mt-2 text-xs font-medium uppercase tracking-wide ${
                  s.tone === "outline" ? "text-cream/45" : "opacity-70"
                }`}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <Card
            title="Payment provider market share"
            subtitle="% of tracked stores offering each provider at checkout"
          >
            {paymentShare.map((p) => (
              <Bar key={p.label} {...p} />
            ))}
          </Card>

          <Card
            title="Shopify Plus adoption"
            subtitle="Enterprise stores detected, last 8 months"
          >
            <TrendLine data={plusTrend} />
            <p className="pt-2 text-sm text-cream/45">
              Up 675% since January — the replatforming wave is accelerating.
            </p>
          </Card>

          <Card title="Theme market share" subtitle="Most-used storefront themes">
            {themeShare.map((t) => (
              <Bar key={t.label} {...t} tone="mint" />
            ))}
          </Card>

          <Card title="Top apps installed" subtitle="Marketing & conversion stack">
            {topApps.map((a) => (
              <Bar key={a.label} {...a} tone="lilac" />
            ))}
          </Card>

          <Card
            title="Store categories"
            subtitle="What new merchants are selling"
          >
            {categories.map((c) => (
              <Bar key={c.label} {...c} />
            ))}
          </Card>

          <div className="flex flex-col justify-center rounded-[2rem] bg-orange p-8 text-ink-deep">
            <div className="font-display text-3xl md:text-4xl">
              Know the market before your competitors do.
            </div>
            <p className="mt-3 text-ink-deep/70">
              Every trend here updates as Terrain discovers and enriches new
              stores — payment shifts, theme moves, app adoption, category
              momentum.
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

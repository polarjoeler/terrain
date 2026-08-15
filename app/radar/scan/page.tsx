"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const MARKETS = [
  { value: "South Africa", label: "🇿🇦 South Africa", ready: true },
  { value: "Nigeria", label: "🇳🇬 Nigeria", ready: false },
  { value: "Kenya", label: "🇰🇪 Kenya", ready: false },
  { value: "Egypt", label: "🇪🇬 Egypt", ready: false },
];

const PRIORITIES = ["Product images", "Pricing", "Full catalogue", "Brand name / domain"];

const SCAN_STEPS = [
  "Fingerprinting your catalogue…",
  "Loading the South African store universe…",
  "Narrowing to look-alike stores…",
  "Comparing images, SKUs and prices…",
  "Scoring matches…",
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-cream/90">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-cream/45">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-cream/15 bg-cream/[0.04] px-4 py-2.5 text-cream " +
  "placeholder:text-cream/30 outline-none focus:border-cyan/50";

export default function ScanForm() {
  const router = useRouter();
  const [brandDomain, setBrandDomain] = useState("");
  const [brandName, setBrandName] = useState("");
  const [officialDomains, setOfficialDomains] = useState("");
  const [market, setMarket] = useState("South Africa");
  const [suspects, setSuspects] = useState("");
  const [priorities, setPriorities] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [trademark, setTrademark] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStep((s) => (s + 1) % SCAN_STEPS.length), 1800);
    return () => clearInterval(t);
  }, [busy]);

  function togglePriority(p: string) {
    setPriorities((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!brandDomain.trim()) {
      setErr("Your store domain is required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/radar/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandDomain,
          brandName,
          officialDomains,
          market,
          suspects,
          priorities,
          email,
          trademark,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.id) {
        setErr(data.error || "Scan failed — please try again.");
        setBusy(false);
        return;
      }
      router.push(`/radar/scan/${data.id}`);
    } catch {
      setErr("Network error — please try again.");
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <main className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-6 text-center">
        <div className="relative mb-8 h-24 w-24">
          <div className="absolute inset-0 rounded-full border border-cyan/20" />
          <div className="absolute inset-3 rounded-full border border-cyan/20" />
          <div
            className="radar-sweep absolute inset-0 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, transparent 300deg, rgba(76,201,212,0.55) 360deg)",
            }}
          />
          <div className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan" />
        </div>
        <h1 className="font-display text-3xl tracking-tight">Scanning for clones…</h1>
        <p className="mt-3 text-cream/60">{SCAN_STEPS[step]}</p>
        <p className="mt-6 text-xs text-cream/40">
          This can take a minute — we&apos;re checking your brand against every store we know.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <Link href="/radar" className="text-sm text-cream/50 hover:text-cream">
        ← Radar
      </Link>
      <div className="mt-6">
        <span className="inline-block rounded-full border border-cyan/30 bg-cyan/10 px-4 py-1.5 text-xs font-medium text-cyan">
          ◎ Free brand audit
        </span>
        <h1 className="mt-5 font-display text-4xl leading-tight tracking-tight md:text-5xl">
          Is someone copying your brand?
        </h1>
        <p className="mt-4 text-cream/60">
          Tell us about your store and we&apos;ll scan it against every South
          African Shopify store we know — checking for stolen images, SKUs,
          pricing and copy. Takes about a minute.
        </p>
      </div>

      <form onSubmit={submit} className="mt-10 space-y-6">
        <Field label="Your store domain" hint="The Shopify store we should protect. Required.">
          <input
            className={inputCls}
            placeholder="mystore.co.za"
            value={brandDomain}
            onChange={(e) => setBrandDomain(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label="Brand name" hint="Helps us spot look-alike store names.">
          <input
            className={inputCls}
            placeholder="My Store"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
          />
        </Field>

        <Field label="Market" hint="Where you sell. More markets coming soon.">
          <div className="flex flex-wrap gap-2">
            {MARKETS.map((m) => (
              <button
                type="button"
                key={m.value}
                disabled={!m.ready}
                onClick={() => m.ready && setMarket(m.value)}
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  market === m.value
                    ? "border-cyan bg-cyan text-cyan-deep"
                    : m.ready
                      ? "border-cream/15 text-cream/80 hover:border-cyan/40"
                      : "cursor-not-allowed border-cream/10 text-cream/25"
                }`}
              >
                {m.label}
                {!m.ready && " · soon"}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="Stores you already suspect"
          hint="Optional. One domain per line — we'll check these directly."
        >
          <textarea
            className={`${inputCls} min-h-20`}
            placeholder="knockoff-store.co.za"
            value={suspects}
            onChange={(e) => setSuspects(e.target.value)}
          />
        </Field>

        <Field label="What matters most to protect?" hint="Optional — tunes your report.">
          <div className="flex flex-wrap gap-2">
            {PRIORITIES.map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => togglePriority(p)}
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  priorities.includes(p)
                    ? "border-cyan bg-cyan/15 text-cyan"
                    : "border-cream/15 text-cream/70 hover:border-cyan/40"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </Field>

        <details className="rounded-xl border border-cream/12 px-4 py-3">
          <summary className="cursor-pointer text-sm text-cream/70">
            Additional details (optional)
          </summary>
          <div className="mt-4 space-y-6">
            <Field
              label="Other official domains"
              hint="Your own regional stores — so we never flag them. One per line."
            >
              <textarea
                className={`${inputCls} min-h-16`}
                placeholder="mystore.com"
                value={officialDomains}
                onChange={(e) => setOfficialDomains(e.target.value)}
              />
            </Field>
            <Field label="Registered trademark" hint="Classes / registration no. — strengthens future takedowns.">
              <input
                className={inputCls}
                placeholder="e.g. Class 25 (apparel), TM2024/12345"
                value={trademark}
                onChange={(e) => setTrademark(e.target.value)}
              />
            </Field>
          </div>
        </details>

        <Field label="Email for your report" hint="Optional — where we send results and alerts.">
          <input
            className={inputCls}
            type="email"
            placeholder="you@mystore.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        {err && <p className="text-sm text-orange">{err}</p>}

        <button
          type="submit"
          className="w-full rounded-full bg-cyan py-3.5 font-medium text-cyan-deep transition hover:brightness-110"
        >
          Run my free brand audit →
        </button>
        <p className="text-center text-xs text-cream/40">
          Free during launch. No card required.
        </p>
      </form>
    </main>
  );
}

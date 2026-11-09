"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { marketLabel } from "@/lib/markets";
import type { Cluster, ClusterKind } from "@/lib/radar/clusters";

/** Radar's four lenses. Same classified clusters, four different questions — because the thing a
 *  payment processor needs ("who on my rail is doing this") and the thing an agency needs ("is
 *  anyone copying my client") are the same evidence pivoted differently, not four products. */

export type Lens = "rail" | "brand" | "platform" | "market";

const LENSES: { key: Lens; label: string; who: string; ask: string }[] = [
  { key: "rail", label: "My payment rail", who: "Payment providers and acquirers",
    ask: "Which stores processing on your rail are selling someone else's catalogue?" },
  { key: "brand", label: "A brand I protect", who: "Agencies, brand owners and legal teams",
    ask: "Is anyone copying this brand's catalogue?" },
  { key: "platform", label: "My platform", who: "Commerce platforms and hosts",
    ask: "Which stores on your platform are clones of another merchant?" },
  { key: "market", label: "Whole market", who: "Regulators, banks and risk teams",
    ask: "Where is catalogue fraud concentrated right now?" },
];

const KIND: Record<ClusterKind, { label: string; cls: string; blurb: string }> = {
  clone: { label: "Copying", cls: "bg-orange/15 text-orange border-orange/30",
    blurb: "One store selling another's catalogue, with no sign they're the same business." },
  network: { label: "Network", cls: "bg-cyan/15 text-cyan border-cyan/30",
    blurb: "Several stores sharing one catalogue — a dropship or distributor ring." },
  unclear: { label: "Needs a look", cls: "bg-cream/10 text-cream/70 border-cream/20",
    blurb: "Related names, shared catalogue, no proof of common ownership. A human call." },
  operator: { label: "One business", cls: "bg-cream/5 text-cream/45 border-cream/10",
    blurb: "Multiple storefronts of the same operator. Not fraud." },
};

/** Many stores carry their own host as `name`, so printing both renders the domain twice
 *  ("lego-gybc.co.za  www.lego-gybc.co.za"). Only show a name that adds something. */
const usefulName = (name: string | null, domain: string) => {
  if (!name) return null;
  const n = name.trim().toLowerCase().replace(/^www\./, "");
  const d = domain.toLowerCase().replace(/^www\./, "");
  return n === d || n === d.split(".")[0] ? null : name.trim();
};

const money = (n: number | null) =>
  n == null ? null : n >= 1000 ? `R${Math.round(n / 1000)}k/mo` : `R${Math.round(n)}/mo`;

export function RadarView({
  clusters, rails, platforms, lens: initialLens, rail: initialRail,
  brand: initialBrand, platform: initialPlatform, coverage,
}: {
  clusters: Cluster[];
  rails: { rail: string; clusters: number }[];
  platforms: { platform: string; published: number; fingerprinted: number }[];
  lens: Lens;
  rail: string; brand: string; platform: string;
  coverage: { fingerprinted: number; published: number };
}) {
  const [lens, setLens] = useState<Lens>(initialLens);
  const [rail, setRail] = useState(initialRail);
  const [brand, setBrand] = useState(initialBrand);
  const [platform, setPlatform] = useState(initialPlatform);
  const [showBenign, setShowBenign] = useState(false);

  const active = LENSES.find((l) => l.key === lens)!;

  const shown = useMemo(() => {
    let out = clusters;
    if (lens === "rail" && rail) out = out.filter((c) => c.rails.some((r) => r.toLowerCase().includes(rail.toLowerCase())));
    if (lens === "platform" && platform) out = out.filter((c) => c.platforms.includes(platform));
    if (lens === "brand" && brand.trim()) {
      const d = brand.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      out = out.filter((c) => c.members.some((m) => m.domain.toLowerCase().replace(/^www\./, "").includes(d)));
    }
    if (!showBenign) out = out.filter((c) => c.kind !== "operator");
    return out;
  }, [clusters, lens, rail, brand, platform, showBenign]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of shown) c[x.kind] = (c[x.kind] ?? 0) + 1;
    return c;
  }, [shown]);

  const sel = "rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none focus:border-cream/50";

  return (
    <div className="mt-6">
      {/* lens picker */}
      <div className="flex flex-wrap gap-2">
        {LENSES.map((l) => (
          <button key={l.key} onClick={() => setLens(l.key)}
            className={`rounded-full px-4 py-2 text-sm transition ${
              lens === l.key ? "bg-mint text-ink font-medium" : "border border-cream/15 text-cream/65 hover:text-cream"}`}>
            {l.label}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
        <p className="text-cream/80">{active.ask}</p>
        <p className="mt-1 text-xs text-cream/40">{active.who}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {lens === "rail" && (
            <select value={rail} onChange={(e) => setRail(e.target.value)} className={sel} aria-label="Payment provider">
              <option value="">Every rail</option>
              {rails.map((r) => <option key={r.rail} value={r.rail} className="text-ink">{r.rail} ({r.clusters})</option>)}
            </select>
          )}
          {lens === "platform" && (
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={sel} aria-label="Platform">
              <option value="">Every platform</option>
              {platforms.map((p) => <option key={p.platform} value={p.platform} className="text-ink">{p.platform}</option>)}
            </select>
          )}
          {lens === "brand" && (
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="yourbrand.co.za"
              aria-label="Brand domain" className={`${sel} w-64`} />
          )}
          <label className="ml-auto flex items-center gap-2 text-xs text-cream/45">
            <input type="checkbox" checked={showBenign} onChange={(e) => setShowBenign(e.target.checked)} className="accent-mint" />
            Show same-business groups
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          {(["clone", "network", "unclear", "operator"] as ClusterKind[])
            .filter((k) => counts[k])
            .map((k) => (
              <span key={k} className="flex items-center gap-2 text-cream/70">
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND[k].cls}`}>
                  {KIND[k].label}
                </span>
                {counts[k]}
              </span>
            ))}
          {!shown.length && <span className="text-cream/45">Nothing matches this view.</span>}
        </div>
      </div>

      {lens === "platform" && (
        <p className="mt-3 text-xs text-cream/45">
          Detection needs a catalogue fingerprint, and today those come from Shopify&rsquo;s product
          feed: {coverage.fingerprinted.toLocaleString()} of {coverage.published.toLocaleString()} published
          stores are fingerprinted. A store we haven&rsquo;t fingerprinted cannot be matched, so read an
          empty platform as &ldquo;not yet covered&rdquo;, never as &ldquo;clean&rdquo;.
        </p>
      )}

      <div className="mt-5 space-y-4">
        {shown.map((c) => <ClusterCard key={c.id} c={c} />)}
      </div>
    </div>
  );
}

function ClusterCard({ c }: { c: Cluster }) {
  const [open, setOpen] = useState(false);
  const k = KIND[c.kind];
  const stolen = Math.max(...c.edges.map((e) => Math.max(e.sharedHandles, e.sharedSkus)));

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${k.cls}`}>
              {k.label}
            </span>
            <span className="text-xs text-cream/40">
              {stolen.toLocaleString()} shared products · strongest match {c.topScore}/100
            </span>
          </div>
          <p className="mt-2 text-sm text-cream/75">{c.why}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-cream/40">
          <div>first seen {new Date(c.firstSeen).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>
          {c.countries.length > 0 && <div className="mt-0.5">{c.countries.map(marketLabel).join(" · ")}</div>}
        </div>
      </div>

      <ul className="mt-4 space-y-1.5">
        {c.members.map((m) => (
          <li key={m.domain} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <a href={`https://${m.domain}`} target="_blank" rel="noopener noreferrer nofollow"
              className="font-mono text-cream hover:text-mint">{m.domain}</a>
            {usefulName(m.name, m.domain) && (
              <span className="truncate text-cream/45">{usefulName(m.name, m.domain)}</span>
            )}
            {m.rails.length > 0 && <span className="text-xs text-cream/40">{m.rails.join(" · ")}</span>}
            {money(m.estMonthlySales) && <span className="text-xs text-cream/55">{money(m.estMonthlySales)}</span>}
          </li>
        ))}
      </ul>

      <button onClick={() => setOpen((v) => !v)} className="mt-4 text-xs text-cream/45 hover:text-cream">
        {open ? "Hide evidence" : `Evidence (${c.edges.length} pair${c.edges.length === 1 ? "" : "s"})`} {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-cream/10 pt-3">
          {c.edges.map((e, i) => (
            <div key={i} className="text-xs text-cream/60">
              <div className="font-mono text-cream/80">{e.original} → {e.suspect}</div>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-cream/50">
                {e.reasons.map((r, j) => <li key={j}>› {r}</li>)}
              </ul>
              {e.ownership.length > 0 && (
                <p className="mt-1 text-mint/70">Shared identity: {e.ownership.join(", ")}</p>
              )}
              <Link href={`/radar/dossier/${encodeURIComponent(e.original)}/${encodeURIComponent(e.suspect)}`}
                className="mt-1 inline-block text-cream/45 hover:text-mint">Takedown dossier →</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

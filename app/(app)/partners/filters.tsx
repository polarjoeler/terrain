import Link from "next/link";
import { MARKETS } from "@/lib/markets";

/** Build a URL for the current page with some params changed (null drops one). */
export function hrefWith(base: string, cur: Record<string, string | undefined>, patch: Record<string, string | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

export const flag = (cc: string) => MARKETS[cc]?.emoji ?? "🌍";
export const marketName = (cc: string) => MARKETS[cc]?.name ?? cc;

const chip = (on: boolean) =>
  `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition ${
    on ? "border-cyan/50 bg-cyan/10 text-cream" : "border-cream/12 text-cream/60 hover:border-cream/25 hover:text-cream"
  }`;

/** Country filter: "All Africa" + the biggest markets as chips, the long tail in a dropdown. */
export function CountryBar({
  base, cur, countries, allLabel = "All Africa", allCount, visible = 6,
}: {
  base: string;
  cur: Record<string, string | undefined>;
  countries: { code: string; count: number; label?: string }[];
  allLabel?: string;
  allCount?: number;
  visible?: number;
}) {
  const active = cur.country ?? "";
  const head = countries.slice(0, visible);
  const tail = countries.slice(visible);
  const activeInTail = tail.find((c) => c.code === active);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link href={hrefWith(base, cur, { country: null, all: null })} className={chip(!active)}>
        {allLabel}
        {allCount != null && <span className="tabular-nums text-cream/40">{allCount.toLocaleString()}</span>}
      </Link>
      {head.map((c) => (
        <Link key={c.code} href={hrefWith(base, cur, { country: c.code, all: null })} className={chip(active === c.code)}>
          <span>{c.code === "other" ? "🌍" : flag(c.code)}</span>
          {c.label ?? marketName(c.code)}
          <span className="tabular-nums text-cream/40">{c.count.toLocaleString()}</span>
        </Link>
      ))}
      {tail.length > 0 && (
        <details className="relative">
          <summary className={`${chip(!!activeInTail)} cursor-pointer list-none`}>
            {activeInTail ? <>{flag(activeInTail.code)} {activeInTail.label ?? marketName(activeInTail.code)}</> : <>+{tail.length} more</>}
            <span className="text-cream/40">▾</span>
          </summary>
          <div className="absolute left-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-cream/12 bg-ink p-1 shadow-xl">
            {tail.map((c) => (
              <Link key={c.code} href={hrefWith(base, cur, { country: c.code, all: null })}
                className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs hover:bg-cream/[0.06] ${active === c.code ? "text-cream" : "text-cream/65"}`}>
                <span>{flag(c.code)} {c.label ?? marketName(c.code)}</span>
                <span className="tabular-nums text-cream/40">{c.count.toLocaleString()}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Underlined tabs (category / platform focus). */
export function Tabs({ items }: { items: { key: string; label: string; count?: number; href: string; on: boolean }[] }) {
  return (
    <div className="flex gap-5 overflow-x-auto border-b border-cream/10">
      {items.map((t) => (
        <Link key={t.key} href={t.href}
          className={`-mb-px whitespace-nowrap border-b-2 pb-2 text-sm transition ${t.on ? "border-cyan text-cream" : "border-transparent text-cream/50 hover:text-cream"}`}>
          {t.label}
          {t.count != null && <span className="ml-1.5 text-xs tabular-nums text-cream/35">{t.count.toLocaleString()}</span>}
        </Link>
      ))}
    </div>
  );
}

/** Plain GET search form — keeps the other filters as hidden fields, no client JS. */
export function SearchBox({ base, cur, placeholder }: { base: string; cur: Record<string, string | undefined>; placeholder: string }) {
  return (
    <form action={base} method="get" className="flex w-full sm:w-64">
      {Object.entries(cur).filter(([k, v]) => v && k !== "q" && k !== "all").map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input name="q" defaultValue={cur.q ?? ""} placeholder={placeholder}
        className="w-full rounded-full border border-cream/12 bg-cream/[0.03] px-3.5 py-1.5 text-sm text-cream placeholder:text-cream/30 focus:border-cyan/50 focus:outline-none" />
    </form>
  );
}

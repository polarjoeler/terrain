"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import {
  COMPANY_TYPES, GOALS, ROLES, TECH_CATEGORIES, SIZE_BANDS, CHANNELS, CHANNEL_READY, STAGES, isFraudEligible,
  progress, stageProgress, stageApplies, summary, emptyState, emptyTargeting, emptyDelivery,
  type OnboardingState, type CompanyType, type Role, type Goal, type TechCategory, type StageIndex,
  type Targeting, type SizeBand, type CmsDigest, type CountryDigest, type TechDeepDive, type FraudMonitoring,
  type Channel, type DigestCadence, type Delivery,
} from "@/lib/onboarding";

type Props = {
  email: string; firstUser: boolean; orgName: string;
  initialState: OnboardingState | null;
  platforms: { id: string; label: string }[];
  categories: string[];
  markets: { iso: string; label: string }[];
};

/* ----------------------------------------------------------------- UI atoms --- */
function SelectCard({ title, desc, selected, onClick, multi }: { title: string; desc?: string; selected: boolean; onClick: () => void; multi?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={`group relative flex w-full flex-col items-start gap-1 rounded-2xl border p-4 text-left transition
        ${selected ? "border-mint bg-mint/[0.07]" : "border-cream/12 bg-cream/[0.02] hover:border-cream/30 hover:bg-cream/[0.04]"}`}>
      <span className={`absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold transition
        ${selected ? "border-mint bg-mint text-ink" : "border-cream/20 text-transparent"} ${multi ? "" : "rounded-full"}`}>✓</span>
      <span className="pr-6 font-medium text-cream">{title}</span>
      {desc && <span className="text-xs leading-snug text-cream/50">{desc}</span>}
    </button>
  );
}

function Pill({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={`rounded-full border px-4 py-1.5 text-sm transition
        ${selected ? "border-mint bg-mint/15 text-cream" : "border-cream/15 text-cream/70 hover:border-cream/40 hover:text-cream"}`}>
      {label}
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-cream/45">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-cream/35">{hint}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-xl border border-cream/15 bg-cream/[0.03] px-4 py-2.5 text-sm text-cream placeholder:text-cream/30 outline-none transition focus:border-mint/60 focus:bg-cream/[0.05]";

/* ------------------------------------------------------------- the flow --- */
export function OnboardingFlow({ email, firstUser, orgName, initialState, platforms, categories, markets }: Props) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(() => ({ ...emptyState(), ...(initialState ?? {}), companyName: initialState?.companyName ?? orgName }));
  const [view, setView] = useState<StageIndex>((initialState?.stage as StageIndex) || 1);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false); // mobile collapse
  const platLabels = useMemo(() => Object.fromEntries(platforms.map((p) => [p.id, p.label])), [platforms]);
  const summaryLines = useMemo(() => summary(state, platLabels), [state, platLabels]);
  const prog = useMemo(() => progress(state), [state]);

  // Debounced resumable save on every change.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch("/api/onboarding/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state, stage: view }) }).catch(() => {});
    }, 700);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [state, view]);

  const patch = useCallback((p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p })), []);
  const toggleGoal = (g: Goal) => setState((s) => ({ ...s, goals: s.goals.includes(g) ? s.goals.filter((x) => x !== g) : [...s.goals, g] }));

  // Which stages are in the flow for this user's answers (stage 1,4,5 always; 2,3 conditional).
  const stageList: StageIndex[] = ([1, 2, 3, 4, 5] as StageIndex[]).filter((st) => st === 1 || st === 4 || st === 5 || stageApplies(state, st));
  const idx = stageList.indexOf(view);
  const goNext = () => { const n = stageList[idx + 1]; if (n) { setView(n); patch({ stage: Math.max(state.stage, n) }); window.scrollTo({ top: 0, behavior: "smooth" }); } };
  const goBack = () => { const p = stageList[idx - 1]; if (p) { setView(p); window.scrollTo({ top: 0, behavior: "smooth" }); } };

  const launch = async () => {
    setLaunching(true); setErr(null);
    try {
      const res = await fetch("/api/onboarding/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); setErr(j.error || "Could not launch — try again."); return; }
      router.push("/dashboard");
    } finally { setLaunching(false); }
  };

  const sp = stageProgress(state, view);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">
      <div className="flex items-center justify-between">
        <Wordmark size="text-xl" tone="cream" />
        <span className="text-xs text-cream/40">{email}</span>
      </div>

      {/* Stepper */}
      <nav aria-label="Progress" className="mt-8 flex flex-wrap items-center gap-x-2 gap-y-3">
        {stageList.map((st, i) => {
          const done = i < idx, current = st === view;
          return (
            <div key={st} className="flex items-center">
              <button onClick={() => (i <= idx ? setView(st) : undefined)} disabled={i > idx}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition
                  ${current ? "border-mint bg-mint/10 text-cream" : done ? "border-mint/30 text-mint hover:bg-mint/5" : "border-cream/10 text-cream/35"}`}>
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${current ? "bg-mint text-ink" : done ? "bg-mint/25 text-mint" : "bg-cream/10 text-cream/40"}`}>{done ? "✓" : i + 1}</span>
                <span className="hidden sm:inline">{STAGES[st - 1]}</span>
              </button>
              {i < stageList.length - 1 && <span className="mx-1 hidden h-px w-5 bg-cream/10 sm:block" />}
            </div>
          );
        })}
        <span className="ml-auto text-xs text-cream/40">{prog.answered}/{prog.total} answered · {prog.pct}%</span>
      </nav>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-cream/10"><div className="h-full rounded-full bg-mint transition-all duration-500" style={{ width: `${prog.pct}%` }} /></div>

      <div className="mt-8 grid gap-6 md:grid-cols-[1fr_320px]">
        {/* Main question panel */}
        <section className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-6 md:p-8">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-mint/80">
            {STAGES[view - 1]} {sp.total > 0 && <span className="text-cream/30">· {sp.answered} of {sp.total}</span>}
          </div>

          {view === 1 && <Stage1 state={state} patch={patch} toggleGoal={toggleGoal} firstUser={firstUser} />}
          {view === 2 && <Stage2 state={state} patch={patch} platforms={platforms} categories={categories} markets={markets} />}
          {view === 3 && <Stage3 state={state} patch={patch} platforms={platforms} markets={markets} />}
          {view === 4 && <Stage4 state={state} patch={patch} email={email} />}
          {view === 5 && <Stage5Review state={state} firstUser={firstUser} patch={patch} platLabels={platLabels} summaryLines={summaryLines} />}

          {err && <p className="mt-4 rounded-xl border border-orange/30 bg-orange/10 px-4 py-2 text-sm text-orange">{err}</p>}

          <div className="mt-8 flex items-center justify-between gap-3">
            <button onClick={goBack} disabled={idx === 0} className="rounded-full border border-cream/15 px-5 py-2 text-sm text-cream/70 transition hover:border-cream/40 hover:text-cream disabled:opacity-30">← Back</button>
            {view === 5 ? (
              <button onClick={launch} disabled={launching} className="rounded-full bg-mint px-6 py-2.5 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-60">
                {launching ? "Launching…" : "Launch my workspace →"}
              </button>
            ) : (
              <button onClick={goNext} className="rounded-full bg-mint px-6 py-2.5 text-sm font-semibold text-ink transition hover:brightness-105">Continue →</button>
            )}
          </div>
        </section>

        {/* Live summary (desktop) / collapsible (mobile) */}
        <aside>
          <button onClick={() => setShowSummary((v) => !v)} className="mb-2 flex w-full items-center justify-between rounded-2xl border border-cream/10 bg-cream/[0.02] px-4 py-3 text-sm text-cream/80 md:hidden">
            Your Terrain workspace <span className="text-cream/40">{showSummary ? "▲" : "▼"}</span>
          </button>
          <div className={`${showSummary ? "block" : "hidden"} md:block rounded-3xl border border-cream/10 bg-gradient-to-b from-mint/[0.04] to-transparent p-5 md:sticky md:top-6`}>
            <h3 className="font-display text-lg text-cream">Your Terrain workspace</h3>
            <p className="mt-1 text-xs text-cream/40">Updates as you answer. Previews are illustrative until your workspace launches.</p>
            <ul className="mt-4 space-y-2.5">
              {summaryLines.length === 0 && <li className="text-sm text-cream/35">Answer a few questions and your setup appears here.</li>}
              {summaryLines.map((l) => (
                <li key={l.key} className="flex items-start gap-2 text-sm text-cream/85 animate-[fadeIn_.3s_ease]">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />{l.text}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

/* ------------------------------------------------------------- Stage 1 --- */
function Stage1({ state, patch, toggleGoal, firstUser }: { state: OnboardingState; patch: (p: Partial<OnboardingState>) => void; toggleGoal: (g: Goal) => void; firstUser: boolean }) {
  const [techName, setTechName] = useState("");
  const [techCat, setTechCat] = useState<TechCategory>("payments");
  const wantsTech = (["my_tech_performance", "fraud_monitoring"] as Goal[]).some((g) => state.goals.includes(g));
  const fraudEligible = isFraudEligible(state.companyType);
  const addTech = () => { const n = techName.trim(); if (!n) return; patch({ technologies: [...state.technologies, { name: n, category: techCat }] }); setTechName(""); };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-2xl text-cream">Tell us about your company</h2>
        <p className="mt-1 text-sm text-cream/50">So Terrain shows you the right merchants and market intelligence.</p>
      </div>

      {firstUser && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name"><input className={inputCls} value={state.companyName ?? ""} onChange={(e) => patch({ companyName: e.target.value })} placeholder="Acme Payments" /></Field>
          <Field label="Website"><input className={inputCls} value={state.website ?? ""} onChange={(e) => patch({ website: e.target.value })} placeholder="acme.com" /></Field>
        </div>
      )}

      {firstUser && (
        <div>
          <div className="mb-3 text-sm font-medium text-cream/80">What type of company are you?</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COMPANY_TYPES.map((c) => (
              <SelectCard key={c.id} title={c.label} desc={c.desc} selected={state.companyType === c.id} onClick={() => patch({ companyType: c.id as CompanyType })} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-3 text-sm font-medium text-cream/80">What's your role or team?</div>
        <div className="flex flex-wrap gap-2">
          {ROLES.map((r) => <Pill key={r} label={r} selected={state.role === r} onClick={() => patch({ role: r as Role })} />)}
        </div>
      </div>

      <div>
        <div className="mb-1 text-sm font-medium text-cream/80">What would you like Terrain to help you with?</div>
        <p className="mb-3 text-xs text-cream/40">Pick everything that applies — we'll tailor the rest to these.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {GOALS.filter((g) => g.id !== "fraud_monitoring" || fraudEligible).map((g) => (
            <SelectCard key={g.id} title={g.label} desc={g.desc} multi selected={state.goals.includes(g.id)} onClick={() => toggleGoal(g.id)} />
          ))}
        </div>
        {state.goals.includes("fraud_monitoring") && (
          <p className="mt-2 text-xs text-cream/40">Fraud monitoring flags suspicious clone/abuse signals across your customer base for review — it doesn't make definitive determinations, and needs a customer domain list to activate (you can set that up later).</p>
        )}
      </div>

      {wantsTech && (
        <div>
          <div className="mb-1 text-sm font-medium text-cream/80">Which of your products should we analyse?</div>
          <p className="mb-3 text-xs text-cream/40">Name the technology and pick its category.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1"><input className={inputCls} value={techName} onChange={(e) => setTechName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTech()} placeholder="e.g. Paystack" /></div>
            <select className={inputCls + " w-auto"} value={techCat} onChange={(e) => setTechCat(e.target.value as TechCategory)}>
              {TECH_CATEGORIES.map((c) => <option key={c.id} value={c.id} className="text-ink">{c.label}</option>)}
            </select>
            <button onClick={addTech} className="rounded-xl border border-mint/40 px-4 py-2.5 text-sm text-mint transition hover:bg-mint/10">+ Add</button>
          </div>
          {state.technologies.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {state.technologies.map((t, i) => (
                <span key={i} className="flex items-center gap-2 rounded-full border border-cream/15 bg-cream/[0.04] px-3 py-1 text-sm text-cream/85">
                  {t.name} <span className="text-cream/35">· {TECH_CATEGORIES.find((c) => c.id === t.category)?.label}</span>
                  <button onClick={() => patch({ technologies: state.technologies.filter((_, j) => j !== i) })} className="text-cream/40 hover:text-orange">×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- shared stage sub-atoms --- */
function StageHead({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="font-display text-2xl text-cream">{title}</h2>
      <p className="mt-1 text-sm text-cream/50">{desc}</p>
    </div>
  );
}
function Toggle({ label, desc, on, onChange }: { label: string; desc?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition
        ${on ? "border-mint bg-mint/[0.07]" : "border-cream/12 bg-cream/[0.02] hover:border-cream/30"}`}>
      <span>
        <span className="block text-sm font-medium text-cream">{label}</span>
        {desc && <span className="mt-0.5 block text-xs text-cream/45">{desc}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-mint" : "bg-cream/15"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-cream transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}
function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-sm font-medium text-cream/80">{children}</div>;
}

/* A searchable multi-select over a data-derived list (categories). */
function CategoryPicker({ all, selected, options, onToggleAll, onToggle }: {
  all: boolean; selected: string[]; options: string[]; onToggleAll: (v: boolean) => void; onToggle: (c: string) => void;
}) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return options.filter((o) => (!needle || o.toLowerCase().includes(needle)) && !selected.includes(o)).slice(0, 10);
  }, [q, options, selected]);
  return (
    <div>
      <Toggle label="All product categories" desc="No category preference — show every vertical" on={all} onChange={onToggleAll} />
      {!all && (
        <div className="mt-3 space-y-3">
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search categories — e.g. Fashion, Health, Electronics" />
          {q.trim() && matches.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {matches.map((m) => <Pill key={m} label={`+ ${m}`} selected={false} onClick={() => { onToggle(m); setQ(""); }} />)}
            </div>
          )}
          {selected.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selected.map((c) => (
                <span key={c} className="flex items-center gap-2 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 text-sm text-cream">
                  {c}<button onClick={() => onToggle(c)} className="text-cream/50 hover:text-orange">×</button>
                </span>
              ))}
            </div>
          )}
          {selected.length === 0 && !q.trim() && <p className="text-xs text-cream/35">Search and add the categories you sell into. Leave empty to keep all.</p>}
        </div>
      )}
    </div>
  );
}

/* A market (country) multi-select over the covered markets. */
function MarketPicker({ markets, selected, onToggle }: { markets: { iso: string; label: string }[]; selected: string[]; onToggle: (iso: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {markets.map((m) => <Pill key={m.iso} label={m.label} selected={selected.includes(m.iso)} onClick={() => onToggle(m.iso)} />)}
    </div>
  );
}

/* ------------------------------------------------------------- Stage 2 --- */
function Stage2({ state, patch, platforms, categories, markets }: {
  state: OnboardingState; patch: (p: Partial<OnboardingState>) => void;
  platforms: { id: string; label: string }[]; categories: string[]; markets: { iso: string; label: string }[];
}) {
  const t: Targeting = state.targeting ?? emptyTargeting();
  const setT = (p: Partial<Targeting>) => patch({ targeting: { ...t, ...p } });
  // Commit a default targeting object so the slice exists even if the user accepts defaults.
  useEffect(() => { if (!state.targeting) patch({ targeting: emptyTargeting() }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const platLabel = (id: string) => platforms.find((p) => p.id === id)?.label ?? id;
  const unranked = platforms.filter((p) => !t.platforms.includes(p.id));
  const move = (i: number, dir: -1 | 1) => {
    const next = [...t.platforms]; const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]]; setT({ platforms: next });
  };
  const toggleArr = (arr: string[], v: string) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  const estBands = SIZE_BANDS.filter((b) => b.basis === "estimated");
  const obsBands = SIZE_BANDS.filter((b) => b.basis === "observed");

  return (
    <div className="space-y-8">
      <StageHead title="Your ideal merchants" desc="Who counts as a good lead? This shapes the leads you see first and every digest." />

      {/* Platform priority */}
      <div>
        <GroupLabel>Which ecommerce platforms matter most?</GroupLabel>
        <Toggle label="No preference — rank by fit across all platforms" on={t.allPlatforms} onChange={(v) => setT({ allPlatforms: v })} />
        {!t.allPlatforms && (
          <div className="mt-3 space-y-3">
            {t.platforms.length > 0 && (
              <ol className="space-y-2">
                {t.platforms.map((id, i) => (
                  <li key={id} className="flex items-center gap-3 rounded-xl border border-mint/30 bg-mint/[0.06] px-3 py-2">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-mint/20 text-xs font-bold text-mint">{i + 1}</span>
                    <span className="flex-1 text-sm text-cream">{platLabel(id)}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded-md px-2 py-1 text-cream/50 transition hover:bg-cream/10 hover:text-cream disabled:opacity-20" aria-label="Move up">↑</button>
                      <button onClick={() => move(i, 1)} disabled={i === t.platforms.length - 1} className="rounded-md px-2 py-1 text-cream/50 transition hover:bg-cream/10 hover:text-cream disabled:opacity-20" aria-label="Move down">↓</button>
                      <button onClick={() => setT({ platforms: t.platforms.filter((x) => x !== id) })} className="rounded-md px-2 py-1 text-cream/40 transition hover:text-orange" aria-label="Remove">×</button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {unranked.length > 0 && (
              <div>
                <p className="mb-2 text-xs text-cream/40">{t.platforms.length ? "Add more (in priority order)" : "Tap to add in priority order — your first pick ranks highest"}</p>
                <div className="flex flex-wrap gap-2">
                  {unranked.map((p) => <Pill key={p.id} label={`+ ${p.label}`} selected={false} onClick={() => setT({ platforms: [...t.platforms, p.id] })} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Size */}
      <div>
        <GroupLabel>What size of merchant are you after?</GroupLabel>
        <Toggle label="Any size" on={t.sizeAny} onChange={(v) => setT({ sizeAny: v })} />
        {!t.sizeAny && (
          <div className="mt-3 space-y-4">
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-cream/35">Estimated monthly revenue <span className="normal-case text-cream/30">· modelled</span></p>
              <div className="flex flex-wrap gap-2">
                {estBands.map((b) => <Pill key={b.id} label={b.label} selected={t.sizeBands.includes(b.id)} onClick={() => setT({ sizeBands: toggleArr(t.sizeBands, b.id) as SizeBand[] })} />)}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-cream/35">Catalogue size <span className="normal-case text-cream/30">· observed</span></p>
              <div className="flex flex-wrap gap-2">
                {obsBands.map((b) => <Pill key={b.id} label={b.label} selected={t.sizeBands.includes(b.id)} onClick={() => setT({ sizeBands: toggleArr(t.sizeBands, b.id) as SizeBand[] })} />)}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-cream/60">
              <input type="checkbox" checked={t.unknownSizeOk} onChange={(e) => setT({ unknownSizeOk: e.target.checked })} className="accent-mint" />
              Include stores we couldn&apos;t size yet
            </label>
          </div>
        )}
      </div>

      {/* Categories */}
      <div>
        <GroupLabel>Any product categories to focus on?</GroupLabel>
        <CategoryPicker all={t.allCategories} selected={t.categories} options={categories}
          onToggleAll={(v) => setT({ allCategories: v })} onToggle={(c) => setT({ categories: toggleArr(t.categories, c) })} />
      </div>

      {/* Countries */}
      <div>
        <GroupLabel>Which markets?</GroupLabel>
        <Toggle label="All covered markets" on={t.allCountries} onChange={(v) => setT({ allCountries: v })} />
        {!t.allCountries && (
          <div className="mt-3">
            <MarketPicker markets={markets} selected={t.countries} onToggle={(iso) => setT({ countries: toggleArr(t.countries, iso) })} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Stage 3 --- */
function CadencePicker({ value, onChange }: { value: DigestCadence; onChange: (c: DigestCadence) => void }) {
  return (
    <div className="flex gap-2">
      {(["weekly", "monthly"] as DigestCadence[]).map((c) => (
        <Pill key={c} label={c === "weekly" ? "Weekly" : "Monthly"} selected={value === c} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}
function DigestBlock({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5">
      <div className="text-sm font-semibold text-cream">{title}</div>
      <p className="mt-0.5 mb-3 text-xs text-cream/45">{desc}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function Stage3({ state, patch, platforms, markets }: {
  state: OnboardingState; patch: (p: Partial<OnboardingState>) => void;
  platforms: { id: string; label: string }[]; markets: { iso: string; label: string }[];
}) {
  const has = (g: Goal) => state.goals.includes(g);
  const toggleArr = (arr: string[], v: string) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  const fraudEligible = isFraudEligible(state.companyType);

  // CMS digest
  const cms: CmsDigest = state.cmsDigest ?? { allPlatforms: true, platforms: [], allCountries: true, countries: [], cadence: "weekly", reuseTargeting: has("find_leads") };
  const setCms = (p: Partial<CmsDigest>) => patch({ cmsDigest: { ...cms, ...p } });
  // Country digest
  const cd: CountryDigest = state.countryDigest ?? { countries: [] };
  const setCd = (p: Partial<CountryDigest>) => patch({ countryDigest: { ...cd, ...p } });
  // Tech deep dive
  const dd: TechDeepDive = state.techDeepDive ?? { techs: state.technologies.map((x) => x.name), allMarkets: true, markets: [], recurring: true, cadence: "monthly" };
  const setDd = (p: Partial<TechDeepDive>) => patch({ techDeepDive: { ...dd, ...p } });
  // Fraud
  const fraud: FraudMonitoring = state.fraud ?? { enabled: false, status: "pending_setup" };

  // Commit sensible defaults for each applicable goal so accepting them (without touching a control)
  // still captures the digest in the summary and the saved profile.
  useEffect(() => {
    const p: Partial<OnboardingState> = {};
    if (has("track_cms") && !state.cmsDigest) p.cmsDigest = cms;
    if (has("country_performance") && !state.countryDigest) p.countryDigest = cd;
    if (has("my_tech_performance") && !state.techDeepDive) p.techDeepDive = dd;
    if (has("fraud_monitoring") && fraudEligible && !state.fraud) p.fraud = fraud;
    if (Object.keys(p).length) patch(p);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <StageHead title="Your intelligence" desc="Tailored to the goals you picked. Each becomes a recurring briefing in your workspace." />

      {has("track_cms") && (
        <DigestBlock title="Platform activity digest" desc="New stores, migrations and platform adoption as it happens.">
          {has("find_leads") && <Toggle label="Match my ideal-merchant filters" desc="Reuse the platforms and markets from the previous step" on={cms.reuseTargeting} onChange={(v) => setCms({ reuseTargeting: v })} />}
          {!(has("find_leads") && cms.reuseTargeting) && (
            <>
              <div>
                <p className="mb-2 text-xs text-cream/45">Platforms</p>
                <Toggle label="All platforms" on={cms.allPlatforms} onChange={(v) => setCms({ allPlatforms: v })} />
                {!cms.allPlatforms && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {platforms.map((p) => <Pill key={p.id} label={p.label} selected={cms.platforms.includes(p.id)} onClick={() => setCms({ platforms: toggleArr(cms.platforms, p.id) })} />)}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs text-cream/45">Markets</p>
                <Toggle label="All covered markets" on={cms.allCountries} onChange={(v) => setCms({ allCountries: v })} />
                {!cms.allCountries && (
                  <div className="mt-2"><MarketPicker markets={markets} selected={cms.countries} onToggle={(iso) => setCms({ countries: toggleArr(cms.countries, iso) })} /></div>
                )}
              </div>
            </>
          )}
          <div><p className="mb-2 text-xs text-cream/45">How often</p><CadencePicker value={cms.cadence} onChange={(c) => setCms({ cadence: c })} /></div>
        </DigestBlock>
      )}

      {has("country_performance") && (
        <DigestBlock title="Country performance" desc="Weekly market-level ecommerce activity for the countries you track.">
          <MarketPicker markets={markets} selected={cd.countries} onToggle={(iso) => setCd({ countries: toggleArr(cd.countries, iso) })} />
          {cd.countries.length === 0 && <p className="text-xs text-cream/35">Pick at least one market.</p>}
        </DigestBlock>
      )}

      {has("my_tech_performance") && (
        <DigestBlock title="Your technology deep-dive" desc="Where your product is winning and losing across the merchant base.">
          {state.technologies.length > 0 ? (
            <div>
              <p className="mb-2 text-xs text-cream/45">Products to analyse</p>
              <div className="flex flex-wrap gap-2">
                {state.technologies.map((p) => <Pill key={p.name} label={p.name} selected={dd.techs.includes(p.name)} onClick={() => setDd({ techs: toggleArr(dd.techs, p.name) })} />)}
              </div>
            </div>
          ) : (
            <p className="text-xs text-cream/40">Add a product in step 1 to tailor this — otherwise we&apos;ll cover your category broadly.</p>
          )}
          <div>
            <p className="mb-2 text-xs text-cream/45">Markets</p>
            <Toggle label="All covered markets" on={dd.allMarkets} onChange={(v) => setDd({ allMarkets: v })} />
            {!dd.allMarkets && <div className="mt-2"><MarketPicker markets={markets} selected={dd.markets} onToggle={(iso) => setDd({ markets: toggleArr(dd.markets, iso) })} /></div>}
          </div>
          <Toggle label="Send this on a recurring basis" desc="Off = a single one-off deep-dive" on={dd.recurring} onChange={(v) => setDd({ recurring: v })} />
          {dd.recurring && <div><p className="mb-2 text-xs text-cream/45">How often</p><CadencePicker value={dd.cadence} onChange={(c) => setDd({ cadence: c })} /></div>}
        </DigestBlock>
      )}

      {has("fraud_monitoring") && fraudEligible && (
        <DigestBlock title="Suspected-fraud monitoring" desc="Flags clone/abuse signals across your customer base for your review.">
          <Toggle label="Enable fraud monitoring" desc="Needs a customer domain list to activate — we'll help you set that up after launch" on={fraud.enabled} onChange={(v) => patch({ fraud: { enabled: v, status: "pending_setup" } })} />
          <p className="text-xs text-cream/35">Monitoring flags signals for human review — it never makes definitive fraud determinations.</p>
        </DigestBlock>
      )}

      {!has("track_cms") && !has("country_performance") && !has("my_tech_performance") && !(has("fraud_monitoring") && fraudEligible) && (
        <p className="text-sm text-cream/40">No recurring intelligence selected — your goals are covered by the live workspace. Continue to delivery.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- Stage 4 --- */
function Stage4({ state, patch, email }: { state: OnboardingState; patch: (p: Partial<OnboardingState>) => void; email: string }) {
  const d: Delivery = state.delivery ?? { ...emptyDelivery(), email };
  const setD = (p: Partial<Delivery>) => patch({ delivery: { ...d, ...p } });
  // Commit the default delivery (email, weekly 08:00, local tz) so accepting it is captured.
  useEffect(() => { if (!state.delivery) patch({ delivery: { ...emptyDelivery(), email } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const setSched = (p: Partial<Delivery["schedule"]>) => setD({ schedule: { ...d.schedule, ...p } });
  const toggleChannel = (c: Channel) => setD({ channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : [...d.channels, c] });
  const weekly = state.cmsDigest?.cadence !== "monthly"; // show a weekday picker if anything is weekly
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  return (
    <div className="space-y-8">
      <StageHead title="Delivery preferences" desc="Where and when your briefings land. Email is live today; other channels save as pending." />

      <div>
        <GroupLabel>How should we deliver your intelligence?</GroupLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {CHANNELS.map((c) => {
            const ready = CHANNEL_READY[c.id];
            const sel = d.channels.includes(c.id);
            return (
              <button key={c.id} type="button" onClick={() => toggleChannel(c.id)} aria-pressed={sel}
                className={`relative flex flex-col items-start gap-1 rounded-2xl border p-4 text-left transition
                  ${sel ? "border-mint bg-mint/[0.07]" : "border-cream/12 bg-cream/[0.02] hover:border-cream/30"}`}>
                <span className={`absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full border text-[10px] font-bold transition ${sel ? "border-mint bg-mint text-ink" : "border-cream/20 text-transparent"}`}>✓</span>
                <span className="flex items-center gap-2 pr-6 font-medium text-cream">{c.label}
                  {!ready && <span className="rounded-full border border-cream/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cream/45">Requires setup</span>}
                  {ready && <span className="rounded-full border border-mint/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-mint">Live</span>}
                </span>
                <span className="text-xs text-cream/45">{c.scope === "org" ? "Workspace-wide" : "Just for you"}</span>
              </button>
            );
          })}
        </div>
        {d.channels.some((c) => !CHANNEL_READY[c]) && (
          <p className="mt-2 text-xs text-cream/40">We&apos;ll save your pending channels and help you connect them after launch — nothing sends there until you do.</p>
        )}
      </div>

      {d.channels.includes("email") && (
        <Field label="Email address" hint="Where email briefings are sent.">
          <input className={inputCls} type="email" value={d.email ?? ""} onChange={(e) => setD({ email: e.target.value })} placeholder={email} />
        </Field>
      )}

      {d.channels.includes("whatsapp") && (
        <div className="space-y-3 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4">
          <Field label="WhatsApp number" hint="Saved as pending — WhatsApp delivery isn't wired yet.">
            <input className={inputCls} value={d.whatsappNumber ?? ""} onChange={(e) => setD({ whatsappNumber: e.target.value })} placeholder="+27 …" />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-cream/60">
            <input type="checkbox" checked={!!d.whatsappConsent} onChange={(e) => setD({ whatsappConsent: e.target.checked })} className="accent-mint" />
            I consent to receive briefings on WhatsApp
          </label>
        </div>
      )}

      <div>
        <GroupLabel>When?</GroupLabel>
        <div className="grid gap-4 sm:grid-cols-3">
          {weekly && (
            <Field label="Day of week">
              <select className={inputCls} value={d.schedule.day ?? "Monday"} onChange={(e) => setSched({ day: e.target.value })}>
                {DAYS.map((day) => <option key={day} value={day} className="text-ink">{day}</option>)}
              </select>
            </Field>
          )}
          <Field label="Time">
            <input className={inputCls} type="time" value={d.schedule.time ?? "08:00"} onChange={(e) => setSched({ time: e.target.value })} />
          </Field>
          <Field label="Timezone">
            <input className={inputCls} value={d.schedule.tz} onChange={(e) => setSched({ tz: e.target.value })} placeholder="Africa/Johannesburg" />
          </Field>
        </div>
      </div>

      <Toggle label="Use these settings for every digest" desc="Turn off later to tune each briefing separately" on={d.useForAllDigests} onChange={(v) => setD({ useForAllDigests: v })} />
    </div>
  );
}

/* ------------------------------------------------------------- Stage 5 --- */
function Stage5Review({ state, firstUser, patch, summaryLines }: { state: OnboardingState; firstUser: boolean; patch: (p: Partial<OnboardingState>) => void; platLabels: Record<string, string>; summaryLines: { key: string; text: string }[] }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-2xl text-cream">Review &amp; launch</h2>
        <p className="mt-1 text-sm text-cream/50">Here's what your workspace will be set up with.</p>
      </div>

      <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5">
        <ul className="space-y-2.5">
          {summaryLines.length === 0 && <li className="text-sm text-cream/40">Add your company and goals in step 1 to launch.</li>}
          {summaryLines.map((l) => <li key={l.key} className="flex items-start gap-2 text-sm text-cream/85"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />{l.text}</li>)}
        </ul>
      </div>

      {firstUser && (
        <div className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5">
          <div className="text-sm font-medium text-cream/80">Team seats</div>
          <p className="mt-1 text-xs text-cream/45">How many seats do you need in total (including yours)?</p>
          <div className="mt-3 flex items-center gap-3">
            <input type="number" min={1} value={state.seats?.count ?? 1} onChange={(e) => patch({ seats: { count: Math.max(1, Number(e.target.value) || 1), includesSelf: true, pending: true } })}
              className={inputCls + " w-28"} />
            <span className="text-xs text-cream/40">includes your own seat</span>
          </div>
          <p className="mt-2 text-xs text-cream/35">Seat billing isn't set up yet — we'll save your requested count and follow up before any charge. No card required to launch.</p>
        </div>
      )}

      <p className="text-xs text-cream/35">Launching sets up your workspace now. Anything that needs a connection (Slack, WhatsApp, fraud monitoring, billing) will be clearly marked as pending — nothing is charged or connected until you complete it.</p>
    </div>
  );
}

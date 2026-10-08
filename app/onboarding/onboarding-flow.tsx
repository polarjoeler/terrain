"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/app/components/logo";
import {
  COMPANY_TYPES, GOALS, ROLES, TECH_CATEGORIES, STAGES, isFraudEligible,
  progress, stageProgress, stageApplies, summary, emptyState,
  type OnboardingState, type CompanyType, type Role, type Goal, type TechCategory, type StageIndex,
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
          {view === 2 && <Placeholder title="Your ideal merchants" note="Platform priority, size, categories and markets — building next." />}
          {view === 3 && <Placeholder title="Your intelligence" note="CMS, country, and technology digests tailored to your goals — building next." />}
          {view === 4 && <Placeholder title="Delivery preferences" note="Channels, schedule and timezone — building next (email is the live channel)." />}
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
  const wantsTech = (["my_tech_performance", "my_tech_adoption_churn", "fraud_monitoring"] as Goal[]).some((g) => state.goals.includes(g));
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

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="space-y-3 py-6">
      <h2 className="font-display text-2xl text-cream">{title}</h2>
      <p className="max-w-md text-sm text-cream/50">{note}</p>
      <p className="text-xs text-cream/30">You can Continue through for now — your answers so far are saved and you can launch your workspace from the final step.</p>
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

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const COMPANY = [
  ["payments", "Payments company"], ["app_developer", "App developer"], ["shipping", "Shipping / logistics"],
  ["agency", "Agency / service partner"], ["investor", "Investor"], ["researcher", "Researcher"], ["other", "Other"],
] as const;
const CMS = [["shopify", "Shopify"], ["woocommerce", "WooCommerce"], ["magento", "Magento"], ["wix", "Wix"], ["all", "All / not sure"]] as const;
const CADENCE = [["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]] as const;
const INGEST = [["crm", "Into my CRM"], ["csv", "CSV export"], ["api", "API / webhook"], ["in_app", "Just browse in-app"]] as const;

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full px-3.5 py-1.5 text-sm transition ${on ? "bg-cream text-ink" : "border border-cream/20 text-cream/70 hover:text-cream"}`}>
      {children}
    </button>
  );
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="text-sm font-semibold text-cream/90">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-cream/45">{hint}</div>}
      <div className="mt-2.5 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function OnboardingForm({ firstUser }: { firstUser: boolean }) {
  const router = useRouter();
  const [companyType, setCompanyType] = useState<string>("");
  const [cmsFocus, setCmsFocus] = useState<string[]>([]);
  const [trackOwn, setTrackOwn] = useState(false);
  const [leadCadence, setLeadCadence] = useState("weekly");
  const [leadFocus, setLeadFocus] = useState<string[]>([]);
  const [ingestion, setIngestion] = useState("csv");
  const [digest, setDigest] = useState(true);
  const [extras, setExtras] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  // A provider-type company gets the "track your own performance" option.
  const isProvider = ["payments", "app_developer", "shipping"].includes(companyType);
  const canSubmit = (!firstUser || companyType) && leadCadence && ingestion;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyType: firstUser ? companyType : undefined,
          cmsFocus: firstUser ? cmsFocus : undefined,
          trackOwnPerformance: firstUser ? trackOwn : undefined,
          extras: firstUser ? extras : undefined,
          leadCadence, leadFocus, ingestion, digest,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Something went wrong");
      router.push("/dashboard");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message); setBusy(false);
    }
  }

  return (
    <div className="mt-8 rounded-2xl border border-cream/12 bg-cream/[0.02] p-5 md:p-6">
      {firstUser && (
        <>
          <Field label="What kind of company are you?" hint="We tailor the dashboard to what you care about.">
            {COMPANY.map(([v, l]) => <Chip key={v} on={companyType === v} onClick={() => setCompanyType(v)}>{l}</Chip>)}
          </Field>
          <Field label="Which platforms do you focus on?" hint="Pick any that matter to you.">
            {CMS.map(([v, l]) => <Chip key={v} on={cmsFocus.includes(v)} onClick={() => toggle(cmsFocus, setCmsFocus, v)}>{l}</Chip>)}
          </Field>
          {isProvider && (
            <Field label="Track your own performance?" hint="See how your product is adopted across the market, with a weekly digest.">
              <Chip on={trackOwn} onClick={() => setTrackOwn(true)}>Yes, track us</Chip>
              <Chip on={!trackOwn} onClick={() => setTrackOwn(false)}>Not now</Chip>
            </Field>
          )}
        </>
      )}

      <Field label="How often do you want leads?">
        {CADENCE.map(([v, l]) => <Chip key={v} on={leadCadence === v} onClick={() => setLeadCadence(v)}>{l}</Chip>)}
      </Field>
      <Field label="Which leads?" hint="Platforms or segments you want in your feed (optional).">
        {CMS.map(([v, l]) => <Chip key={v} on={leadFocus.includes(v)} onClick={() => toggle(leadFocus, setLeadFocus, v)}>{l}</Chip>)}
      </Field>
      <Field label="How will you ingest leads?" hint="We'll guide the handoff — CRM, CSV or API.">
        {INGEST.map(([v, l]) => <Chip key={v} on={ingestion === v} onClick={() => setIngestion(v)}>{l}</Chip>)}
      </Field>
      <Field label="Weekly digest email?">
        <Chip on={digest} onClick={() => setDigest(true)}>Yes, send it</Chip>
        <Chip on={!digest} onClick={() => setDigest(false)}>No thanks</Chip>
      </Field>

      {firstUser && (
        <div className="mt-6">
          <div className="text-sm font-semibold text-cream/90">Anything else you want from Terrain?</div>
          <textarea value={extras} onChange={(e) => setExtras(e.target.value)} rows={2}
            placeholder="e.g. Slack alerts on competitor switches, an API for our data team…"
            className="mt-2.5 w-full rounded-xl border border-cream/15 bg-cream/[0.03] px-3 py-2 text-sm text-cream placeholder:text-cream/30 focus:border-cream/40 focus:outline-none" />
        </div>
      )}

      {err && <p className="mt-4 text-sm text-orange">{err}</p>}
      <button onClick={submit} disabled={!canSubmit || busy}
        className="mt-7 w-full rounded-full bg-cream px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-cream/90 disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Saving…" : "Start using Terrain →"}
      </button>
    </div>
  );
}

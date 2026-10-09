"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDigestAction, setCadenceAction } from "./actions";

type Props = {
  subscribed: boolean;
  cadence: string;
  email: string;
  workspace: string;
  contents: { title: string; desc: string }[];
};

const CADENCES: { id: string; label: string }[] = [
  { id: "daily", label: "Daily" }, { id: "weekly", label: "Weekly" }, { id: "monthly", label: "Monthly" },
];

export function DigestsManager({ subscribed, cadence, email, workspace, contents }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [on, setOn] = useState(subscribed);
  const [cad, setCad] = useState(cadence);
  const [err, setErr] = useState<string | null>(null);

  const toggle = () => start(async () => {
    const next = !on;
    setOn(next); setErr(null);
    const r = await setDigestAction(next);
    if (!r.ok) { setOn(!next); setErr(r.error); } else router.refresh();
  });
  const pick = (c: string) => start(async () => {
    const prev = cad;
    setCad(c); setErr(null);
    const r = await setCadenceAction(c);
    if (!r.ok) { setCad(prev); setErr(r.error); } else router.refresh();
  });

  const cadenceWord = CADENCES.find((c) => c.id === cad)?.label ?? "Weekly";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="font-display text-2xl text-cream">Your digests</h1>
        <p className="mt-1 text-sm text-cream/50">Recurring market briefings for {workspace}, delivered on your schedule.</p>
      </div>

      {/* Subscription + cadence */}
      <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-cream">Market digest</div>
            <div className="mt-0.5 text-xs text-cream/45">{on ? `On · ${cadenceWord.toLowerCase()} by email` : "Off — you won't receive briefings"}</div>
          </div>
          <button role="switch" aria-checked={on} aria-label="Toggle digest subscription" onClick={toggle} disabled={pending}
            className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60 ${on ? "bg-mint" : "bg-cream/15"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-cream transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </div>

        <div className={`mt-5 transition-opacity ${on ? "" : "pointer-events-none opacity-40"}`}>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-cream/45">Frequency</div>
          <div className="flex gap-2">
            {CADENCES.map((c) => (
              <button key={c.id} onClick={() => pick(c.id)} disabled={pending || !on} aria-pressed={cad === c.id}
                className={`rounded-full border px-4 py-1.5 text-sm transition ${cad === c.id ? "border-mint bg-mint/15 text-cream" : "border-cream/15 text-cream/65 hover:border-cream/40 hover:text-cream"}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {err && <p className="mt-3 text-xs text-orange">{err}</p>}
      </section>

      {/* Delivery */}
      <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
        <h2 className="font-display text-lg text-cream">Delivery</h2>
        <div className="mt-4 space-y-2.5">
          <div className="flex items-center justify-between rounded-xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
            <div>
              <div className="text-sm text-cream">Email</div>
              <div className="mt-0.5 text-xs text-cream/45">{email}</div>
            </div>
            <span className="rounded-full border border-mint/30 bg-mint/10 px-2.5 py-0.5 text-[11px] font-medium text-mint">Live</span>
          </div>
          {["Slack", "WhatsApp"].map((ch) => (
            <div key={ch} className="flex items-center justify-between rounded-xl border border-cream/10 bg-cream/[0.02] px-4 py-3">
              <div className="text-sm text-cream/70">{ch}</div>
              <span className="rounded-full border border-cream/15 px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-cream/45">Requires setup</span>
            </div>
          ))}
        </div>
      </section>

      {/* What's in it */}
      <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
        <h2 className="font-display text-lg text-cream">What&apos;s in your {cadenceWord.toLowerCase()} digest</h2>
        <ul className="mt-4 space-y-3">
          {contents.map((c) => (
            <li key={c.title} className="flex items-start gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-mint" />
              <div>
                <div className="text-sm text-cream">{c.title}</div>
                <div className="text-xs text-cream/45">{c.desc}</div>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-cream/35">
          Automated sending is being finalised — your preferences are saved and applied the moment digests go live. Nothing is sent until then.
        </p>
      </section>
    </div>
  );
}

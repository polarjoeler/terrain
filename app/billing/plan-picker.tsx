"use client";

import { useState } from "react";
import { PLANS, PLAN_ORDER, ADDON_RADAR_PARTNERS_USD, EXTRA_SEAT_USD, EXTRA_SEAT_ANNUAL_USD, MAX_EXTRA_SEATS, type PlanKey } from "@/lib/plans";

/** What each tier unlocks beyond the row count, in the customer's words. The entitlements
 *  themselves live in lib/plans.ts — this is only how they READ. */
const INSIGHTS_COPY: Record<PlanKey, string> = {
  leads: "No insight reports",
  intelligence: "Country-level insight reports",
  partner: "Every insight report, incl. provider deep-dives",
};

export function PlanPicker({ currentPlan, canAnnual = true }: {
  /** The plan this account is already on, so we don't invite them to buy it again. */
  currentPlan?: PlanKey;
  canAnnual?: boolean;
}) {
  const [period, setPeriod] = useState<"month" | "year">("month");
  const [extraSeats, setExtraSeats] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Seats are billed per interval, so the price shown has to follow the toggle.
  const seatUsd = period === "year" ? EXTRA_SEAT_ANNUAL_USD : EXTRA_SEAT_USD;

  async function subscribe(plan: PlanKey) {
    setBusy(plan);
    setError("");
    try {
      // Leads has no annual price; asking for one would 502 on the server, so send the
      // period the plan actually offers.
      const p = PLANS[plan].annualUsd == null ? "month" : period;
      const res = await fetch("/api/checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, period: p, extraSeats }),
      });
      const json = await res.json();
      if (!res.ok || !json.url) {
        setError(json.error ?? "Could not start checkout");
        setBusy(null);
        return;
      }
      window.location.href = json.url;
    } catch {
      setError("Network error — try again");
      setBusy(null);
    }
  }

  return (
    <>
      {canAnnual && (
        <div className="mt-8 flex justify-center">
          <div className="inline-flex rounded-full border border-cream/15 bg-cream/[0.03] p-1 text-sm">
            {(["month", "year"] as const).map((p) => (
              <button key={p} onClick={() => setPeriod(p)}
                className={`rounded-full px-4 py-1.5 transition ${period === p ? "bg-cream text-ink" : "text-cream/60 hover:text-cream"}`}>
                {p === "month" ? "Monthly" : "Annual · 4 months free"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-center">
        <div className="inline-flex items-center gap-4 rounded-full border border-cream/15 bg-cream/[0.03] px-5 py-2 text-sm">
          <span className="text-cream/60">Extra seats</span>
          <span className="inline-flex items-center gap-1">
            <button type="button" aria-label="One fewer seat" onClick={() => setExtraSeats((n) => Math.max(0, n - 1))}
              disabled={extraSeats === 0}
              className="grid h-6 w-6 place-items-center rounded-full border border-cream/20 text-cream/70 transition hover:border-cream/50 hover:text-cream disabled:opacity-30">−</button>
            <span className="w-7 text-center tabular-nums text-cream">{extraSeats}</span>
            <button type="button" aria-label="One more seat" onClick={() => setExtraSeats((n) => Math.min(MAX_EXTRA_SEATS, n + 1))}
              disabled={extraSeats >= MAX_EXTRA_SEATS}
              className="grid h-6 w-6 place-items-center rounded-full border border-cream/20 text-cream/70 transition hover:border-cream/50 hover:text-cream disabled:opacity-30">+</button>
          </span>
          <span className="text-cream/40">${seatUsd.toLocaleString()}{period === "year" ? "/yr" : "/mo"} each</span>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {PLAN_ORDER.map((key) => {
          const plan = PLANS[key];
          const annual = period === "year" && plan.annualUsd != null;
          const amount = annual ? plan.annualUsd! : plan.monthlyUsd;
          const isCurrent = currentPlan === key;
          // Partner is the only tier without a platform ceiling — the spine of the ladder is
          // platform SCOPE, so that is what the badge says. Worth calling out rather than
          // inventing a "most popular" we can't support.
          const feature = key === "partner";

          return (
            <div key={key}
              className={`flex flex-col rounded-[2rem] p-7 ${feature ? "bg-paper text-ink ring-2 ring-mint" : "bg-paper text-ink"}`}>
              <div className="flex items-baseline justify-between">
                <div className="text-sm font-semibold uppercase tracking-wide opacity-55">{plan.label}</div>
                {feature && <span className="rounded-full bg-mint/25 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink/70">Every platform</span>}
              </div>

              <div className="mt-2 font-display text-4xl">
                ${amount.toLocaleString()}
                <span className="text-base opacity-50">{annual ? " /year" : " /month"}</span>
              </div>
              <div className="mt-1 text-xs text-ink/45">
                {annual
                  ? `$${plan.monthlyUsd.toLocaleString()}/mo billed monthly · 2027 promotional rate`
                  : plan.annualUsd != null
                    ? `or $${plan.annualUsd.toLocaleString()}/year — 4 months free`
                    : "Monthly only"}
              </div>
              {extraSeats > 0 && (
                <div className="mt-1 text-xs font-medium text-ink/70">
                  + ${(extraSeats * (annual ? EXTRA_SEAT_ANNUAL_USD : EXTRA_SEAT_USD)).toLocaleString()} for {extraSeats} extra seat{extraSeats === 1 ? "" : "s"} ={" "}
                  ${(amount + extraSeats * (annual ? EXTRA_SEAT_ANNUAL_USD : EXTRA_SEAT_USD)).toLocaleString()}{annual ? "/year" : "/month"}
                </div>
              )}

              <ul className="mt-5 space-y-2 text-sm text-ink/70">
                <li>{plan.platforms ? plan.platforms.join(" + ") : "Every platform we track"}</li>
                <li>{plan.exportLimit == null ? "Unlimited lead exports" : `${plan.exportLimit.toLocaleString()} lead exports/month`}</li>
                <li>
                  {plan.seats + extraSeats} seat{plan.seats + extraSeats === 1 ? "" : "s"}
                  {extraSeats > 0 ? ` (${plan.seats} included + ${extraSeats})` : ` · $${plan.extraSeatUsd}/mo each after`}
                </li>
                <li>{INSIGHTS_COPY[key]}</li>
              </ul>

              <button
                onClick={() => subscribe(key)}
                disabled={busy !== null || isCurrent}
                className={`mt-6 w-full rounded-full px-6 py-3 text-sm font-medium transition disabled:opacity-60 ${feature ? "bg-ink text-cream hover:bg-ink-deep" : "bg-orange text-cream hover:brightness-95"}`}>
                {isCurrent ? "Your current plan" : busy === key ? "Redirecting…" : `Choose ${plan.label}`}
              </button>
            </div>
          );
        })}
      </div>

      {error && <p className="mt-5 text-center text-sm text-orange">{error}</p>}

      <p className="mt-8 text-center text-sm text-cream/45">
        Radar brand monitoring + the Partners directory: <span className="text-cream/70">+${ADDON_RADAR_PARTNERS_USD}/month</span> on any plan.
      </p>
      <p className="mt-2 text-center text-xs text-cream/35">
        Secure payment via Stripe · 7-day free trial · Cancel anytime
      </p>
    </>
  );
}

"use client";

import { PLANS, PLAN_ORDER, resolvePlan, type PlanKey } from "@/lib/plans";

/** Next tier in the ladder, wrapping at the top. */
const nextPlan = (raw: string | null | undefined): PlanKey =>
  PLAN_ORDER[(PLAN_ORDER.indexOf(resolvePlan(raw)) + 1) % PLAN_ORDER.length];

import { useMemo, useState } from "react";
// The action list is imported, not mirrored: this file used to restate it, and a type-only import
// costs the client bundle nothing while making an action the server rejects a compile error here.
import type { Subscriber, SubscriberAction as Action } from "@/lib/subscriptions";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-mint/20 text-mint",
  comped: "bg-lilac/20 text-lilac",       // full access, billed to nobody — distinct from active on sight
  trialing: "bg-cyan/20 text-cyan",
  past_due: "bg-orange/20 text-orange",
  cancelled: "bg-cream/10 text-cream/50",
  expired: "bg-cream/10 text-cream/40",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function SubscribersTable({ initial }: { initial: Subscriber[] }) {
  const [subs, setSubs] = useState(initial);
  const [q, setQ] = useState("");
  const [grant, setGrant] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  // Invite-link builder: an email plus the access to pre-authorise.
  const [invEmail, setInvEmail] = useState("");
  const [invPlan, setInvPlan] = useState<PlanKey>("intelligence");
  const [invDays, setInvDays] = useState(14);
  const [invUrl, setInvUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? subs.filter((s) => s.email.includes(needle)) : subs;
  }, [subs, q]);

  async function run(email: string, action: Action) {
    setBusy(email + action);
    setMsg("");
    try {
      const res = await fetch("/api/admin/subscriber", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, action }),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error ?? "Action failed");
        return;
      }
      const updated = j.subscriber as Subscriber;
      setSubs((prev) => {
        const i = prev.findIndex((s) => s.email === updated.email);
        if (i === -1) return [updated, ...prev];
        const next = [...prev];
        next[i] = updated;
        return next;
      });
      setMsg(`${updated.email}: ${updated.plan}/${updated.status}`);
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(null);
    }
  }

  async function makeInvite() {
    setBusy("invite"); setMsg(""); setInvUrl(""); setCopied(false);
    try {
      const res = await fetch("/api/admin/invite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: invEmail.trim(), plan: invPlan, days: invDays }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(data.error ?? "Could not create the link"); return; }
      setInvUrl(data.url);
      setMsg(`Link ready for ${data.email} — ${PLANS[invPlan].label}, ${data.days} days.`);
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(null);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invUrl);
      setCopied(true);
    } catch {
      setMsg("Couldn't copy — select the link and copy it manually.");
    }
  }

  const btn =
    "rounded-full border border-cream/20 px-2.5 py-1 text-xs text-cream/70 transition hover:border-cream/50 hover:text-cream disabled:opacity-40";

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email…"
          className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50"
        />
        {/* Grant access to an email not yet in the list (e.g. before first login). */}
        <div className="flex items-center gap-2">
          <input
            value={grant}
            onChange={(e) => setGrant(e.target.value)}
            placeholder="email to grant a trial…"
            className="rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50"
          />
          <button
            onClick={() => grant.includes("@") && run(grant, "trial")}
            disabled={!grant.includes("@") || busy !== null}
            className="rounded-full bg-mint px-4 py-1.5 text-sm font-medium text-ink transition hover:brightness-95 disabled:opacity-40"
          >
            Grant 7-day Intelligence trial
          </button>
        </div>
      </div>
      {/* Sign-up link builder. Creating a link writes nothing — the plan and trial length ride
          inside the signed token and are applied when the recipient opens it, so the trial starts
          when they sign in rather than now. */}
      <div className="mt-4 rounded-2xl border border-cream/12 bg-cream/[0.02] p-4">
        <div className="text-sm font-semibold text-cream/90">Create a sign-up link</div>
        <p className="mt-1 text-xs text-cream/45">
          Signs this address in and starts the trial you choose. Single-use, expires in 7 days, and
          it authenticates as that address — send it like a password reset, not a marketing link.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={invEmail}
            onChange={(e) => setInvEmail(e.target.value)}
            placeholder="their@email.com"
            className="min-w-[14rem] flex-1 rounded-full border border-cream/15 bg-transparent px-4 py-1.5 text-sm text-cream outline-none placeholder:text-cream/35 focus:border-cream/50"
          />
          <select
            value={invPlan}
            onChange={(e) => setInvPlan(e.target.value as PlanKey)}
            className="rounded-full border border-cream/15 bg-ink px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50"
          >
            {PLAN_ORDER.map((k) => (
              <option key={k} value={k}>{PLANS[k].label} — ${PLANS[k].monthlyUsd}/mo</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <input
              type="number" min={1} max={90} value={invDays}
              onChange={(e) => setInvDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              className="w-16 rounded-full border border-cream/15 bg-transparent px-3 py-1.5 text-sm text-cream outline-none focus:border-cream/50"
            />
            <span className="text-xs text-cream/45">days</span>
          </div>
          <button
            onClick={makeInvite}
            disabled={!invEmail.includes("@") || busy !== null}
            className="rounded-full bg-cyan px-4 py-1.5 text-sm font-medium text-ink transition hover:brightness-95 disabled:opacity-40"
          >
            {busy === "invite" ? "Creating…" : "Create link"}
          </button>
        </div>
        {invUrl && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              readOnly value={invUrl} onFocus={(e) => e.currentTarget.select()}
              className="min-w-[18rem] flex-1 rounded-xl border border-cream/15 bg-cream/[0.03] px-3 py-1.5 font-mono text-xs text-cream/80 outline-none"
            />
            <button onClick={copyInvite} className={btn}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
        )}
      </div>

      {msg && <p className="mt-3 text-xs text-cream/50">{msg}</p>}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm text-cream/80">
          <thead className="text-xs uppercase tracking-wide text-cream/40">
            <tr>
              <th className="pb-3 pr-4">Email</th>
              <th className="pb-3 pr-4">Plan</th>
              <th className="pb-3 pr-4">Status</th>
              <th className="pb-3 pr-4">Trial ends</th>
              <th className="pb-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.email} className="border-t border-cream/10 align-middle">
                <td className="py-3 pr-4 font-mono text-cream">{s.email}</td>
                <td className="py-3 pr-4 uppercase text-cream/60">{s.plan}</td>
                <td className="py-3 pr-4">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[s.status] ?? "bg-cream/10 text-cream/50"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="py-3 pr-4 text-cream/55">{fmtDate(s.trialEndsAt)}</td>
                <td className="py-3">
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => run(s.email, "trial")} disabled={busy !== null} className={btn}>
                      +7d trial
                    </button>
                    <button onClick={() => run(s.email, "activate")} disabled={busy !== null} className={btn}>
                      Activate
                    </button>
                    {/* Full access at the plan shown, with no billing and no expiry — for pilots
                        and reference customers. Separate from Activate so the paying count stays
                        true. Both keep the plan they find, so set the tier first. */}
                    <button onClick={() => run(s.email, "comp")} disabled={busy !== null} className={btn}>
                      Comp
                    </button>
                    {/* Cycle through the tiers — one button rather than a pair, so a new
                        plan needs no new control. */}
                    <button onClick={() => run(s.email, `setPlan:${nextPlan(s.plan)}`)} disabled={busy !== null} className={btn}>
                      → {PLANS[nextPlan(s.plan)].label}
                    </button>
                    <button onClick={() => run(s.email, "cancel")} disabled={busy !== null} className={`${btn} hover:border-orange/60 hover:text-orange`}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="py-10 text-center text-cream/50">
            {subs.length === 0 ? "No subscribers yet." : "No subscribers match that search."}
          </p>
        )}
      </div>
    </div>
  );
}

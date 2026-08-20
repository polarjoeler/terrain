"use client";

import { useMemo, useState } from "react";
import type { Subscriber } from "@/lib/subscriptions";

type Action = "trial" | "activate" | "cancel" | "makePro" | "makeStarter";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-mint/20 text-mint",
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
            Grant 7-day Pro trial
          </button>
        </div>
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
                    <button onClick={() => run(s.email, s.plan === "pro" ? "makeStarter" : "makePro")} disabled={busy !== null} className={btn}>
                      {s.plan === "pro" ? "→ Starter" : "→ Pro"}
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

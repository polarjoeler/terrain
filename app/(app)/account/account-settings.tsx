"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { AccountInfo, Member, Invite } from "@/lib/account";
import { saveProfileAction, saveWorkspaceAction, inviteMemberAction, cancelInviteAction, setSeatsAction } from "./actions";
import { EXTRA_SEAT_ANNUAL_USD, MAX_EXTRA_SEATS } from "@/lib/plans";

type Seats = {
  capacity: number;
  used: number;
  extraSeats: number;
  included: number;
  seatUsd: number;
  canManage: boolean;
  viaSeat: string | null;
};

type Props = {
  account: AccountInfo;
  members: Member[];
  invites: Invite[];
  plan: { label: string; status: string; used: number; limit: number | null; remaining: number | null } | null;
  seats: Seats | null;
};

const inputCls = "w-full rounded-xl border border-cream/15 bg-cream/[0.03] px-4 py-2.5 text-sm text-cream placeholder:text-cream/30 outline-none transition focus:border-mint/60 focus:bg-cream/[0.05]";

function Section({ title, desc, children, aside }: { title: string; desc?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-cream/10 bg-cream/[0.02] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-cream">{title}</h2>
          {desc && <p className="mt-1 text-sm text-cream/50">{desc}</p>}
        </div>
        {aside}
      </div>
      <div className="mt-5">{children}</div>
    </section>
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

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    owner: "border-mint/30 bg-mint/10 text-mint",
    admin: "border-lilac/30 bg-lilac/10 text-lilac",
    member: "border-cream/15 bg-cream/[0.04] text-cream/60",
  };
  return <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium capitalize ${map[role] ?? map.member}`}>{role}</span>;
}

export function AccountSettings({ account, members, invites, plan, seats }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(account.name);
  const [workspace, setWorkspace] = useState(account.workspace);
  const [extraSeats, setExtraSeats] = useState(seats?.extraSeats ?? 0);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [msg, setMsg] = useState<{ k: string; ok: boolean; text: string } | null>(null);

  const flash = (k: string, ok: boolean, text: string) => { setMsg({ k, ok, text }); if (ok) setTimeout(() => setMsg((m) => (m?.k === k ? null : m)), 2500); };

  const saveProfile = () => start(async () => {
    const r = await saveProfileAction(name);
    if (r.ok) { flash("profile", true, "Saved."); router.refresh(); } else flash("profile", false, r.error);
  });
  const saveWorkspace = () => start(async () => {
    const r = await saveWorkspaceAction(workspace);
    if (r.ok) { flash("workspace", true, "Saved."); router.refresh(); } else flash("workspace", false, r.error);
  });
  const sendInvite = () => start(async () => {
    const r = await inviteMemberAction(inviteEmail, inviteRole);
    if (r.ok) { flash("invite", true, "Invited — they get in as soon as they sign in. Tell them; we don't email it yet."); setInviteEmail(""); router.refresh(); }
    else flash("invite", false, r.error);
  });
  const saveSeats = () => start(async () => {
    const r = await setSeatsAction(extraSeats);
    if (r.ok) { flash("seats", true, "Seats updated — your next invoice is prorated."); router.refresh(); }
    else flash("seats", false, r.error);
  });
  const cancel = (id: string) => start(async () => {
    const r = await cancelInviteAction(id);
    if (r.ok) router.refresh(); else flash("invite", false, r.error);
  });

  const Msg = ({ k }: { k: string }) =>
    msg?.k === k ? <p className={`mt-2 text-xs ${msg.ok ? "text-mint" : "text-orange"}`}>{msg.text}</p> : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="font-display text-2xl text-cream">Account &amp; workspace</h1>
        <p className="mt-1 text-sm text-cream/50">Your profile, your workspace, and who&apos;s on the team.</p>
      </div>

      {/* Profile */}
      <Section title="Your profile" desc="How you appear across Terrain.">
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-orange text-base font-semibold text-cream">{account.initials}</span>
          <div className="min-w-0 flex-1 space-y-4">
            <Field label="Display name">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={80} />
            </Field>
            <Field label="Email" hint="Your sign-in address — contact support to change it.">
              <input className={`${inputCls} cursor-not-allowed opacity-70`} value={account.email} readOnly />
            </Field>
            <div className="flex items-center gap-3">
              <button onClick={saveProfile} disabled={pending || name.trim() === account.name}
                className="rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-50">
                {pending ? "Saving…" : "Save profile"}
              </button>
              <Msg k="profile" />
            </div>
          </div>
        </div>
      </Section>

      {/* Workspace */}
      <Section title="Workspace" desc="The shared account your team's data lives under."
        aside={plan && <span className="rounded-full border border-cream/15 bg-cream/[0.04] px-3 py-1 text-xs text-cream/70">{plan.label} · {plan.status}</span>}>
        <div className="space-y-4">
          <Field label="Workspace name" hint={account.isOwner ? undefined : "Only the workspace owner can rename it."}>
            <input className={`${inputCls} ${account.isOwner ? "" : "cursor-not-allowed opacity-70"}`} value={workspace} onChange={(e) => setWorkspace(e.target.value)} readOnly={!account.isOwner} maxLength={80} />
          </Field>
          {account.domain && (
            <Field label="Domain" hint="Teammates on this domain share this workspace — but a seat comes from an invite below, not from the domain alone.">
              <input className={`${inputCls} cursor-not-allowed opacity-70`} value={account.domain} readOnly />
            </Field>
          )}
          {plan && (
            <Field label="Exports this month" hint="Counts every lead row downloaded as CSV or sent to Google Sheets. Resets on the 1st.">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-lg font-semibold text-cream">{plan.used.toLocaleString()}</span>
                <span className="text-sm text-cream/50">
                  {plan.limit == null
                    ? `leads exported · unlimited on ${plan.label}`
                    : `of ${plan.limit.toLocaleString()} leads · ${(plan.remaining ?? 0).toLocaleString()} left on ${plan.label}`}
                </span>
              </div>
              {plan.limit != null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cream/10">
                  <div className="h-full rounded-full bg-mint transition-all"
                    style={{ width: `${Math.min(100, Math.round((plan.used / plan.limit) * 100))}%` }} />
                </div>
              )}
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {account.isOwner && (
              <button onClick={saveWorkspace} disabled={pending || workspace.trim() === account.workspace}
                className="rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-50">
                {pending ? "Saving…" : "Save workspace"}
              </button>
            )}
            <Link href="/billing" className="text-sm text-cream/55 underline-offset-2 transition hover:text-cream hover:underline">Manage billing &amp; plan →</Link>
            <Msg k="workspace" />
          </div>
        </div>
      </Section>

      {/* Seats */}
      {seats && (
        <Section title="Seats" desc="Each seat is one person who can sign in and use this workspace."
          aside={<span className="rounded-full border border-cream/15 bg-cream/[0.04] px-3 py-1 text-xs text-cream/70">{seats.used} of {seats.capacity} used</span>}>
          <div className="space-y-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-cream/10">
              <div className="h-full rounded-full bg-mint transition-all"
                style={{ width: `${Math.min(100, Math.round((seats.used / Math.max(1, seats.capacity)) * 100))}%` }} />
            </div>
            <p className="text-xs text-cream/40">
              {seats.included} included with your plan{seats.extraSeats > 0 ? ` + ${seats.extraSeats} bought` : ""}.
            </p>

            {seats.canManage ? (
              <div className="rounded-xl border border-cream/10 bg-cream/[0.02] p-4">
                <div className="mb-3 text-sm font-medium text-cream/80">Extra seats</div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1">
                    <button type="button" aria-label="One fewer seat" onClick={() => setExtraSeats((n) => Math.max(0, n - 1))}
                      disabled={pending || extraSeats === 0}
                      className="grid h-7 w-7 place-items-center rounded-full border border-cream/20 text-cream/70 transition hover:border-cream/50 hover:text-cream disabled:opacity-30">−</button>
                    <span className="w-8 text-center text-sm tabular-nums text-cream">{extraSeats}</span>
                    <button type="button" aria-label="One more seat" onClick={() => setExtraSeats((n) => Math.min(MAX_EXTRA_SEATS, n + 1))}
                      disabled={pending || extraSeats >= MAX_EXTRA_SEATS}
                      className="grid h-7 w-7 place-items-center rounded-full border border-cream/20 text-cream/70 transition hover:border-cream/50 hover:text-cream disabled:opacity-30">+</button>
                  </span>
                  <button onClick={saveSeats} disabled={pending || extraSeats === seats.extraSeats}
                    className="rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105 disabled:opacity-50">
                    {pending ? "Updating…" : extraSeats > seats.extraSeats ? `Add ${extraSeats - seats.extraSeats} seat${extraSeats - seats.extraSeats === 1 ? "" : "s"}` : extraSeats < seats.extraSeats ? `Remove ${seats.extraSeats - extraSeats}` : "Update seats"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-cream/35">
                  ${seats.seatUsd}/mo each, or ${EXTRA_SEAT_ANNUAL_USD}/yr on an annual plan. Changes apply to your live
                  subscription straight away and are prorated by Stripe.
                </p>
                {/* inline rather than <Msg>: that helper trips react-hooks/immutability, and the
                    three existing uses are enough of that without adding a fourth. */}
                {msg?.k === "seats" && <p className={`mt-2 text-xs ${msg.ok ? "text-mint" : "text-orange"}`}>{msg.text}</p>}
              </div>
            ) : (
              <p className="text-xs text-cream/40">
                {seats.viaSeat
                  ? `You're on a seat paid for by ${seats.viaSeat} — they manage seats for this workspace.`
                  : "Extra seats are added to a live subscription. Start one on the billing page and they'll appear here."}
              </p>
            )}
          </div>
        </Section>
      )}

      {/* Team */}
      <Section title="Team" desc={account.isCompanyOrg ? "People in your workspace." : "Personal workspace — sign in with a company email to invite a team."}>
        {account.isCompanyOrg ? (
          <div className="space-y-5">
            <ul className="divide-y divide-cream/10">
              {members.map((m) => (
                <li key={m.email} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cream/10 text-xs font-semibold text-cream/80">{(m.name[0] || "?").toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm text-cream">{m.name}{m.you && <span className="ml-1.5 text-xs text-cream/40">(you)</span>}</div>
                      <div className="truncate text-xs text-cream/40">{m.email}</div>
                    </div>
                  </div>
                  <RoleBadge role={m.role} />
                </li>
              ))}
            </ul>

            {invites.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-cream/40">Invited</div>
                <ul className="space-y-2">
                  {invites.map((iv) => (
                    <li key={iv.id} className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-cream/15 px-4 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-cream/80">{iv.email}</span>
                        <RoleBadge role={iv.role} />
                        <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${iv.status === "accepted" ? "bg-mint/10 text-mint/80" : "bg-cream/5 text-cream/40"}`}>
                          {iv.status === "accepted" ? "Signed in" : "Not yet signed in"}
                        </span>
                      </div>
                      <button onClick={() => cancel(iv.id)} disabled={pending} className="shrink-0 text-xs text-cream/45 transition hover:text-orange disabled:opacity-50">Cancel</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-xl border border-cream/10 bg-cream/[0.02] p-4">
              <div className="mb-3 text-sm font-medium text-cream/80">Invite a teammate</div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[200px] flex-1">
                  <input className={inputCls} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@company.com" onKeyDown={(e) => e.key === "Enter" && inviteEmail && sendInvite()} />
                </div>
                <select className={`${inputCls} w-auto`} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  <option value="member" className="text-ink">Member</option>
                  <option value="admin" className="text-ink">Admin</option>
                </select>
                <button onClick={sendInvite} disabled={pending || !inviteEmail.trim()}
                  className="rounded-full border border-mint/40 px-5 py-2.5 text-sm font-medium text-mint transition hover:bg-mint/10 disabled:opacity-50">
                  {pending ? "Saving…" : "Save invite"}
                </button>
              </div>
              <p className="mt-2 text-xs text-cream/35">An invite takes one of your seats and lets them in as soon as they sign in at heyterrain.com/login. We don&apos;t email it yet, so tell them yourself.</p>
              <Msg k="invite" />
            </div>
          </div>
        ) : (
          <p className="text-sm text-cream/45">You&apos;re on a personal workspace. When you sign in with a company email address, teammates on that domain share one workspace and you can invite others here.</p>
        )}
      </Section>
    </div>
  );
}

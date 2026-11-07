"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteListAction } from "./actions";

type ListCard = { id: string; name: string; count: number | null; createdAt: string; summary: string };

export function ListsView({ lists }: { lists: ListCard[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<string | null>(null);

  const remove = (id: string) => start(async () => {
    const r = await deleteListAction(id);
    setConfirm(null);
    if (r.ok) router.refresh();
  });

  const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  if (lists.length === 0) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="rounded-3xl border border-cream/10 bg-cream/[0.02] p-8 text-center">
          <h2 className="font-display text-2xl text-cream">Saved lists</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-cream/55">
            Filter the Leads table to the stores you care about, hit <b className="text-cream">☆ Save list</b>, and it lands here —
            a reusable view for a campaign, a territory, or a watchlist.
          </p>
          <Link href="/dashboard" className="mt-5 inline-block rounded-full bg-mint px-5 py-2 text-sm font-semibold text-ink transition hover:brightness-105">
            Browse leads →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl text-cream">Saved lists</h1>
          <p className="mt-1 text-sm text-cream/50">{lists.length} saved view{lists.length === 1 ? "" : "s"} — open one to re-apply its filters.</p>
        </div>
        <Link href="/dashboard" className="rounded-full border border-cream/15 px-4 py-2 text-sm text-cream/70 transition hover:border-cream/40 hover:text-cream">Browse leads →</Link>
      </div>

      <ul className="space-y-2.5">
        {lists.map((l) => (
          <li key={l.id} className="group flex items-center gap-3 rounded-2xl border border-cream/10 bg-cream/[0.02] p-4 transition hover:border-cream/20">
            <Link href={`/dashboard?list=${l.id}`} className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium text-cream">{l.name}</span>
                {l.count != null && <span className="shrink-0 rounded-full bg-cream/[0.06] px-2 py-0.5 text-[11px] tabular-nums text-cream/55">{l.count.toLocaleString()} leads</span>}
              </div>
              <div className="mt-1 truncate text-xs text-cream/45">{l.summary}</div>
              <div className="mt-0.5 text-[11px] text-cream/30">Saved {when(l.createdAt)}</div>
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              <Link href={`/dashboard?list=${l.id}`} className="rounded-full border border-mint/30 px-3 py-1.5 text-xs font-medium text-mint transition hover:bg-mint/10">Open</Link>
              {confirm === l.id ? (
                <span className="flex items-center gap-1 text-xs">
                  <button onClick={() => remove(l.id)} disabled={pending} className="rounded-full bg-orange/15 px-2.5 py-1.5 font-medium text-orange transition hover:bg-orange/25 disabled:opacity-50">{pending ? "…" : "Delete"}</button>
                  <button onClick={() => setConfirm(null)} className="rounded-full px-2 py-1.5 text-cream/45 hover:text-cream">Cancel</button>
                </span>
              ) : (
                <button onClick={() => setConfirm(l.id)} aria-label={`Delete ${l.name}`} className="rounded-full px-2.5 py-1.5 text-xs text-cream/40 transition hover:text-orange">Delete</button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

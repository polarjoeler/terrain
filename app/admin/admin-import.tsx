"use client";

import { useRef, useState } from "react";

type Sample = { domain: string; name: string | null };

export function AdminImport({
  initialPending,
  initialPublished,
  sample,
}: {
  initialPending: number;
  initialPublished: number;
  sample: Sample[];
}) {
  const [pending, setPending] = useState(initialPending);
  const [published, setPublished] = useState(initialPublished);
  const [rows, setRows] = useState<Sample[]>(sample);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setMsg("");
    try {
      const text = await file.text();
      const res = await fetch("/api/admin/import", { method: "POST", body: text });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error ?? "Import failed");
        return;
      }
      setMsg(`Imported ${j.inserted} stores (${j.skipped} skipped). Review below, then publish.`);
      setPending((p) => p + j.inserted);
    } catch {
      setMsg("Could not read file");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function act(action: "publish" | "discard") {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg(j.error ?? "Failed"); return; }
      if (action === "publish") {
        setPublished((p) => p + (j.published ?? 0));
        setMsg(
          `Published ${j.published} stores into the live feed. Fingerprinting them for Radar…`,
        );
        // Kick off Radar enrichment so the new stores are audit-ready.
        if (j.published) window.dispatchEvent(new Event("radar:enrich"));
      } else {
        setMsg(`Discarded ${j.discarded} pending stores.`);
      }
      setPending(0);
      setRows([]);
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-5">
      {/* counts */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-3xl border border-cream/12 px-5 py-6">
          <div className="font-display text-5xl">{pending}</div>
          <div className="mt-1 text-xs font-semibold uppercase tracking-wide text-cream/50">
            pending review
          </div>
        </div>
        <div className="rounded-3xl bg-mint px-5 py-6 text-ink">
          <div className="font-display text-5xl">{published}</div>
          <div className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            published to feed
          </div>
        </div>
      </div>

      {/* upload */}
      <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
        <h3 className="text-lg font-semibold">Upload CSV</h3>
        <p className="mt-1 text-sm text-cream/50">
          Needs a <code className="text-cream/70">domain</code> column. Optional:
          name, country, email, products, price_min, price_max, currency, theme,
          plus, payments, first_product_at, first_seen.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          className="mt-4 block w-full text-sm text-cream/70 file:mr-4 file:rounded-full file:border-0 file:bg-cream file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink hover:file:bg-paper"
        />
      </div>

      {/* review + publish */}
      {pending > 0 && (
        <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">Review pending ({pending})</h3>
            <div className="flex gap-2">
              <button
                onClick={() => act("discard")}
                disabled={busy}
                className="rounded-full border border-cream/20 px-4 py-2 text-sm text-cream/70 hover:border-cream/50 disabled:opacity-40"
              >
                Discard
              </button>
              <button
                onClick={() => act("publish")}
                disabled={busy}
                className="rounded-full bg-orange px-5 py-2 text-sm font-medium text-cream hover:brightness-95 disabled:opacity-40"
              >
                Publish to feed
              </button>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 text-sm text-cream/70">
            {rows.map((r) => (
              <li key={r.domain}>
                <span className="font-medium">{r.name ?? r.domain}</span>{" "}
                <span className="text-cream/40">{r.domain}</span>
              </li>
            ))}
            {rows.length < pending && (
              <li className="text-cream/40">…and {pending - rows.length} more</li>
            )}
          </ul>
        </div>
      )}

      {msg && <p className="text-sm text-mint">{msg}</p>}
    </div>
  );
}

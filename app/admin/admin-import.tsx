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
  const [preview, setPreview] = useState(""); // extracted CSV awaiting review
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  // Commit CSV text through the shared import path (used by CSV upload + the
  // reviewed screenshot extraction).
  async function importText(text: string): Promise<boolean> {
    const res = await fetch("/api/admin/import", { method: "POST", body: text });
    const j = await res.json();
    if (!res.ok) { setMsg(j.error ?? "Import failed"); return false; }
    setMsg(`Imported ${j.inserted} stores (${j.skipped} skipped). Review below, then publish.`);
    setPending((p) => p + j.inserted);
    return true;
  }

  async function upload(file: File) {
    setBusy(true);
    setMsg("");
    try {
      await importText(await file.text());
    } catch {
      setMsg("Could not read file");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const toBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]+,/, ""));
      fr.onerror = () => reject(new Error("read failed"));
      fr.readAsDataURL(file);
    });

  // One or more screenshots → Claude vision → merged, editable CSV preview.
  // Uploads ACCUMULATE: select several at once, or add more in a later upload —
  // every extracted row piles into the same CSV (use Cancel to start over).
  async function extractFromImages(files: FileList) {
    const list = Array.from(files);
    setBusy(true);
    // Seed from whatever is already in the preview so new images append to it.
    const existing = preview.trim() ? preview.trim().split("\n") : [];
    let header = existing[0] ?? "";
    const dataLines: string[] = existing.slice(1);
    const startCount = dataLines.length;
    const failures: string[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        setMsg(`Reading screenshot ${i + 1} of ${list.length}…`);
        try {
          const base64 = await toBase64(list[i]);
          const res = await fetch("/api/admin/import-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64, mediaType: list[i].type }),
          });
          const j = await res.json();
          if (!res.ok) { failures.push(`#${i + 1}: ${j.error ?? "failed"}`); continue; }
          const lines = String(j.csv).trim().split("\n");
          if (!header) header = lines[0];
          dataLines.push(...lines.slice(1)); // drop each file's header row
        } catch {
          failures.push(`#${i + 1}: read error`);
        }
      }
      if (!header) {
        setMsg(`No rows extracted. ${failures.join(" · ")}`);
        return;
      }
      setPreview([header, ...dataLines].join("\n"));
      const added = dataLines.length - startCount;
      const note = failures.length ? ` (${failures.length} failed)` : "";
      setMsg(
        `Added ${added} row${added === 1 ? "" : "s"} from ${list.length} image${list.length === 1 ? "" : "s"}${note} — ${dataLines.length} total. Add more images or review and import below.`,
      );
    } finally {
      setBusy(false);
      if (imgRef.current) imgRef.current.value = "";
    }
  }

  async function importPreview() {
    setBusy(true);
    try {
      if (await importText(preview)) setPreview("");
    } finally {
      setBusy(false);
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

        {/* Screenshot → CSV via Claude vision */}
        <div className="mt-6 border-t border-cream/10 pt-6">
          <h3 className="text-lg font-semibold">…or extract from a screenshot</h3>
          <p className="mt-1 text-sm text-cream/50">
            Select several images at once (⌘/Ctrl-click), or keep adding more —
            every store table (StoreLeads grid, spreadsheet, listing) is read and
            its rows <span className="text-cream/70">accumulate into one CSV</span> to
            review before importing.
          </p>
          <input
            ref={imgRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            disabled={busy}
            onChange={(e) => e.target.files?.length && extractFromImages(e.target.files)}
            className="mt-4 block w-full text-sm text-cream/70 file:mr-4 file:rounded-full file:border-0 file:bg-cyan file:px-4 file:py-2 file:text-sm file:font-medium file:text-cyan-deep hover:file:brightness-110"
          />
        </div>

        {/* Editable extracted-CSV preview */}
        {preview && (
          <div className="mt-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-cream/70">Review extracted rows (editable)</span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPreview("")}
                  disabled={busy}
                  className="rounded-full border border-cream/20 px-4 py-1.5 text-sm text-cream/70 hover:border-cream/50 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={importPreview}
                  disabled={busy}
                  className="rounded-full bg-cyan px-4 py-1.5 text-sm font-medium text-cyan-deep hover:brightness-110 disabled:opacity-40"
                >
                  Import these rows
                </button>
              </div>
            </div>
            <textarea
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              spellCheck={false}
              rows={12}
              className="w-full rounded-2xl border border-cream/15 bg-ink-deep/60 p-4 font-mono text-xs leading-relaxed text-cream/85 outline-none focus:border-cream/40"
            />
          </div>
        )}
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

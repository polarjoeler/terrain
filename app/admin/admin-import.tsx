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
  const [dupes, setDupes] = useState<Set<string>>(new Set()); // already in the DB
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  // Domains from a CSV (first column, header dropped), normalised like the importer.
  function csvDomains(csv: string): string[] {
    return csv.trim().split("\n").slice(1).map((l) =>
      (l.split(",")[0] ?? "").trim().replace(/^"|"$/g, "").toLowerCase()
        .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""),
    ).filter((d) => d.includes("."));
  }

  // Check the current preview's domains against the DB (what's already imported).
  async function checkDupes(csv: string) {
    const domains = csvDomains(csv);
    if (!domains.length) { setDupes(new Set()); return; }
    setChecking(true);
    try {
      const res = await fetch("/api/admin/import-check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains }),
      });
      const j = await res.json();
      setDupes(new Set(res.ok ? (j.existing ?? []) : []));
    } catch {
      setDupes(new Set());
    } finally {
      setChecking(false);
    }
  }

  // Strip rows already in the DB + within-preview repeats (keep first), re-check.
  function removeDuplicates() {
    const lines = preview.trim().split("\n");
    const header = lines[0];
    const seen = new Set<string>();
    const kept = lines.slice(1).filter((l) => {
      const d = (l.split(",")[0] ?? "").trim().replace(/^"|"$/g, "").toLowerCase()
        .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
      if (!d.includes(".")) return true;
      if (dupes.has(d) || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
    const next = [header, ...kept].join("\n");
    setPreview(next);
    checkDupes(next);
  }

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
        const kind = list[i].type === "application/pdf" ? "PDF" : "screenshot";
        setMsg(`Reading ${kind} ${i + 1} of ${list.length}…`);
        try {
          const base64 = await toBase64(list[i]);
          // The host caps request bodies at ~4.5MB; base64 inflates ~33%, so bail
          // early with a clear message instead of a mystery network failure.
          if (base64.length > 4_400_000) {
            const mb = (list[i].size / 1_048_576).toFixed(1);
            failures.push(`#${i + 1}: ${kind} too big to upload (${mb}MB — max ~3MB). Split it into fewer pages.`);
            continue;
          }
          const res = await fetch("/api/admin/import-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64, mediaType: list[i].type }),
          });
          // A platform-level rejection (413 too-large, 504 timeout) returns HTML,
          // not JSON — read as text first so we surface the real status.
          const raw = await res.text();
          let j: { csv?: string; rows?: number; error?: string } = {};
          try { j = JSON.parse(raw); } catch { /* non-JSON error page */ }
          if (!res.ok) {
            const why = j.error
              ?? (res.status === 413 ? "file too large for the server (max ~4.5MB request)"
                : res.status === 504 || res.status === 502 ? "timed out — try a PDF with fewer pages"
                : `server error ${res.status}`);
            failures.push(`#${i + 1}: ${why}`);
            continue;
          }
          const lines = String(j.csv ?? "").trim().split("\n");
          if (!header) header = lines[0];
          dataLines.push(...lines.slice(1)); // drop each file's header row
        } catch (e) {
          const why = e instanceof Error ? e.message : "read error";
          failures.push(`#${i + 1}: ${why}`);
        }
      }
      if (!header) {
        setMsg(`No rows extracted. ${failures.join(" · ")}`);
        return;
      }
      const nextCsv = [header, ...dataLines].join("\n");
      setPreview(nextCsv);
      checkDupes(nextCsv);
      const added = dataLines.length - startCount;
      const note = failures.length ? ` (${failures.length} failed)` : "";
      setMsg(
        `Added ${added} row${added === 1 ? "" : "s"} from ${list.length} file${list.length === 1 ? "" : "s"}${note} — ${dataLines.length} total. Add more files or review and import below.`,
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

  const previewDomains = csvDomains(preview);
  const dupeCount = previewDomains.filter((d) => dupes.has(d)).length;
  const newCount = previewDomains.length - dupeCount;

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

        {/* Screenshot / PDF → CSV via Claude vision */}
        <div className="mt-6 border-t border-cream/10 pt-6">
          <h3 className="text-lg font-semibold">…or extract from screenshots or a PDF</h3>
          <p className="mt-1 text-sm text-cream/50">
            Select several images at once (⌘/Ctrl-click), drop in a{" "}
            <span className="text-cream/70">multi-page PDF</span> (every page is read),
            or keep adding more — every store table (StoreLeads grid, spreadsheet,
            listing) is read and its rows{" "}
            <span className="text-cream/70">accumulate into one CSV</span> to review
            before importing.
          </p>
          <input
            ref={imgRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf"
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
            {/* new-vs-duplicate summary */}
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
              <span className="text-cream/60">
                {previewDomains.length} row{previewDomains.length === 1 ? "" : "s"} ·{" "}
                <span className="font-semibold text-mint">{newCount} new</span>
                {dupeCount > 0 && <> · <span className="font-semibold text-orange">{dupeCount} already in your DB</span></>}
                {checking && <span className="text-cream/40"> · checking…</span>}
              </span>
              {dupeCount > 0 && (
                <button
                  onClick={removeDuplicates}
                  disabled={busy}
                  className="rounded-full border border-orange/40 px-3 py-1 font-medium text-orange transition hover:border-orange disabled:opacity-40"
                >
                  Remove {dupeCount} duplicate{dupeCount === 1 ? "" : "s"}
                </button>
              )}
            </div>
            <textarea
              value={preview}
              onChange={(e) => setPreview(e.target.value)}
              onBlur={(e) => checkDupes(e.target.value)}
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
            <h3 className="text-lg font-semibold">
              Review pending ({pending}) ·{" "}
              <a href="/admin/pending" className="text-sm font-normal text-cyan hover:underline">
                review &amp; pick individually →
              </a>
            </h3>
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

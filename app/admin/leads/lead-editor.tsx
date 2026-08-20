"use client";

import { useState } from "react";

type Current = Record<string, unknown> | null;
type Override = Record<string, unknown> | null;

const TEXT_FIELDS: [string, string][] = [
  ["name", "Name"],
  ["email", "Email"],
  ["country", "Country (ZA)"],
  ["currency", "Currency (ZAR)"],
  ["category", "Category"],
  ["theme", "Theme"],
  ["plan", "Plan"],
  ["city", "City"],
  ["payments", "Payments (semicolon-separated)"],
  ["technologies", "Technologies"],
  ["instagram", "Instagram handle"],
  ["facebook", "Facebook"],
  ["tiktok", "TikTok handle"],
  ["first_product_at", "First product (YYYY-MM-DD)"],
  ["first_seen", "First seen (YYYY-MM-DD)"],
  ["discovered_at", "Discovered (YYYY-MM-DD)"],
];
const NUM_FIELDS: [string, string][] = [
  ["product_count", "Products"],
  ["price_min", "Price min"],
  ["price_max", "Price max"],
  ["estimated_monthly_sales", "Est. monthly sales (USD)"],
  ["products_sold", "Products sold"],
  ["instagram_followers", "Instagram followers"],
  ["facebook_followers", "Facebook followers"],
];
// Long free-text — rendered as a full-width textarea below the grid.
const AREA_FIELDS: [string, string][] = [["description", "Description"]];

const inputCls =
  "w-full rounded-xl border border-cream/15 bg-cream/[0.04] px-3 py-2 text-cream placeholder:text-cream/25 outline-none focus:border-mint/50";

export function LeadEditor() {
  const [domain, setDomain] = useState("");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [current, setCurrent] = useState<Current>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  function setField(k: string, v: string | boolean) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function load(e?: React.FormEvent) {
    e?.preventDefault();
    const d = domain.trim().toLowerCase();
    if (!d) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/admin/lead-override?domain=${encodeURIComponent(d)}`);
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "Load failed"); return; }
      setCurrent(data.current);
      const o: Override = data.override;
      const next: Record<string, string | boolean> = {};
      for (const [k] of [...TEXT_FIELDS, ...NUM_FIELDS, ...AREA_FIELDS])
        next[k] = o && o[k] != null ? String(o[k]) : "";
      next.plus = o && o.plus != null ? Boolean(o.plus) : false;
      next.hidden = o ? Boolean(o.hidden) : false;
      next.note = o && o.note != null ? String(o.note) : "";
      setForm(next);
      setLoaded(data.domain);
      if (!data.current && !o) setMsg("No record found — you can still add a correction that applies at read time.");
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!loaded) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/lead-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: loaded, ...form }),
      });
      const data = await res.json();
      setMsg(res.ok ? "Saved. The correction now wins everywhere." : data.error ?? "Save failed");
    } catch { setMsg("Network error"); } finally { setBusy(false); }
  }

  async function clearOverride() {
    if (!loaded) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/lead-override?domain=${encodeURIComponent(loaded)}`, { method: "DELETE" });
      setMsg("Override cleared — reverted to source.");
      load();
    } catch { setMsg("Network error"); } finally { setBusy(false); }
  }

  const cur = (k: string) => (current && current[k] != null ? String(current[k]) : "—");

  return (
    <div className="mt-8 max-w-2xl">
      <form onSubmit={load} className="flex gap-2">
        <input
          className={inputCls}
          placeholder="store-domain.co.za"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-xl bg-cream px-5 py-2 text-sm font-medium text-ink disabled:opacity-50"
        >
          Load
        </button>
      </form>

      {loaded && (
        <div className="mt-6 space-y-4 rounded-[2rem] border border-cream/12 bg-cream/[0.03] p-6">
          <div className="text-sm text-cream/50">
            Editing <span className="font-mono text-cream">{loaded}</span>
            {current?.estimated_monthly_sales != null && (
              <> · est ${Number(current.estimated_monthly_sales).toLocaleString()}/mo</>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map(([k, label]) => (
              <label key={k} className="block">
                <span className="text-xs text-cream/60">{label}</span>
                <input
                  className={inputCls}
                  value={form[k] as string ?? ""}
                  placeholder={cur(k)}
                  onChange={(e) => setField(k, e.target.value)}
                />
              </label>
            ))}
            {NUM_FIELDS.map(([k, label]) => (
              <label key={k} className="block">
                <span className="text-xs text-cream/60">{label}</span>
                <input
                  className={inputCls}
                  type="number"
                  value={form[k] as string ?? ""}
                  placeholder={cur(k)}
                  onChange={(e) => setField(k, e.target.value)}
                />
              </label>
            ))}
          </div>

          {AREA_FIELDS.map(([k, label]) => (
            <label key={k} className="block">
              <span className="text-xs text-cream/60">{label}</span>
              <textarea
                className={inputCls}
                rows={3}
                value={(form[k] as string) ?? ""}
                placeholder={cur(k)}
                onChange={(e) => setField(k, e.target.value)}
              />
            </label>
          ))}

          <label className="block">
            <span className="text-xs text-cream/60">Note (why corrected)</span>
            <input className={inputCls} value={(form.note as string) ?? ""} onChange={(e) => setField("note", e.target.value)} />
          </label>

          <div className="flex flex-wrap items-center gap-5 pt-1">
            <label className="flex items-center gap-2 text-sm text-cream/80">
              <input type="checkbox" checked={Boolean(form.plus)} onChange={(e) => setField("plus", e.target.checked)} />
              Shopify Plus
            </label>
            <label className="flex items-center gap-2 text-sm text-orange">
              <input type="checkbox" checked={Boolean(form.hidden)} onChange={(e) => setField("hidden", e.target.checked)} />
              Hide this lead (remove from feed)
            </label>
          </div>

          <p className="text-xs text-cream/40">
            Leave a field blank to keep the source value. Fill it to override. The
            placeholder shows the current source value.
          </p>

          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={busy} className="rounded-full bg-mint px-6 py-2.5 text-sm font-medium text-ink disabled:opacity-50">
              Save correction
            </button>
            <button onClick={clearOverride} disabled={busy} className="rounded-full border border-cream/20 px-5 py-2.5 text-sm text-cream/70 hover:border-cream/50 disabled:opacity-50">
              Clear override
            </button>
          </div>
        </div>
      )}

      {msg && <p className="mt-4 text-sm text-mint">{msg}</p>}
    </div>
  );
}

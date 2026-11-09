"use client";

import { useEffect, useRef, useState } from "react";
import { tagLabel } from "@/lib/tag-defs";
import { marketLabel } from "@/lib/markets";
import { cohortCountsAction, type CohortCounts } from "./connections-actions";

/** The Connections panel — connect an outreach tool, then push a cohort of leads into it.
 *  Shared by /connections (customers) and /admin/integrations (cohort tags, unmetered).
 *
 *  Shape: ONE cohort picker at the top, then a card per tool. The admin panel used to carry a
 *  market selector inside every card, which meant six copies of the same choice and six identical
 *  count queries. Choosing the cohort once and then choosing where to send it is both the way
 *  people actually work and one query instead of six.
 *
 *  The panel's job is to make the two things a push spends visible BEFORE the click: export rows
 *  off the monthly allowance, and the customer's sending reputation. Hence the live reachable/
 *  contactable split (on the measured ZA head only ~17% of contactable stores reach a person) and
 *  a push button that names the number it will actually send after every ceiling applies. */

export type ConnectField = { key: string; label: string; placeholder?: string };
export type PanelProvider = {
  key: string; label: string; hint: string;
  secretLabel?: string; fields?: ConnectField[]; maxPerPush?: number;
};
export type Allowance = { used: number; limit: number | null; remaining: number | null };
type Campaign = { id: string; name: string };
type Quality = "reachable" | "all";

const API = "/api/integrations";
const fmt = (n: number) => n.toLocaleString();

export function ConnectionsPanel({
  providers, connected, countries, cohorts, allowance, initialCounts, pushBlocked, scopeNote,
}: {
  providers: PanelProvider[];
  connected: { provider: string; config: Record<string, unknown> }[];
  countries: { country: string; stores: number }[];
  /** Curated cohort tags. Admin-only vocabulary — omit for customers. */
  cohorts?: { tag: string; count: number }[];
  /** Export allowance this month. null limit = unmetered (admins pass null entirely). */
  allowance: Allowance | null;
  initialCounts: CohortCounts;
  /** Why pushing is unavailable (trial, no plan) — connecting stays open regardless. */
  pushBlocked?: string | null;
  /** "Your plan covers Shopify…" — shown when the plan's platform ceiling narrows the cohort. */
  scopeNote?: string | null;
}) {
  const map = new Map(connected.map((c) => [c.provider, c.config]));

  const [country, setCountry] = useState("");
  const [tag, setTag] = useState("");
  const [quality, setQuality] = useState<Quality>("reachable");
  const [limit, setLimit] = useState("");
  const [counts, setCounts] = useState<CohortCounts>(initialCounts);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  // Rows left shrinks as pushes land, so the panel tracks it rather than re-reading the page.
  const [remaining, setRemaining] = useState<number | null>(allowance?.remaining ?? null);

  // Re-size the cohort when the selection changes. Guarded with a request token: the selects fire
  // faster than the query returns, and a stale reply must not overwrite a newer count.
  const token = useRef(0);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; } // initialCounts already match ""/""
    const mine = ++token.current;
    setCounting(true); setCountError(null);
    cohortCountsAction(country || undefined, tag || undefined).then((r) => {
      if (mine !== token.current) return;
      if (r.ok) setCounts(r.counts); else setCountError(r.error);
      setCounting(false);
    });
  }, [country, tag]);

  const selected = quality === "reachable" ? counts.reachable : counts.all;
  const asked = Number.parseInt(limit, 10);
  const unmetered = allowance ? allowance.limit == null : true;

  /** What this provider would actually send: the cohort, narrowed by every ceiling in play. */
  const sendCount = (p: PanelProvider) =>
    Math.min(
      selected,
      p.maxPerPush ?? 1000,
      Number.isFinite(asked) && asked > 0 ? asked : Infinity,
      unmetered ? Infinity : Math.max(0, remaining ?? 0),
    );

  const sel = "rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none focus:border-cream/50";

  return (
    <div className="mt-8 space-y-5">
      {/* ---- cohort picker ------------------------------------------------- */}
      <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
        <h2 className="font-display text-xl text-cream">Who to send</h2>
        <p className="mt-1 text-xs text-cream/45">
          Pick the cohort once, then push it to any connected tool.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {countries.length > 1 && (
            <select value={country} onChange={(e) => setCountry(e.target.value)} className={sel} aria-label="Market">
              <option value="">All markets</option>
              {countries.map((c) => (
                <option key={c.country} value={c.country} className="text-ink">{marketLabel(c.country)}</option>
              ))}
            </select>
          )}
          {cohorts?.length ? (
            <select value={tag} onChange={(e) => setTag(e.target.value)} className={sel} aria-label="Cohort">
              <option value="">All contactable</option>
              {cohorts.map((c) => (
                <option key={c.tag} value={c.tag} className="text-ink">{tagLabel(c.tag)} ({fmt(c.count)})</option>
              ))}
            </select>
          ) : null}
          <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className={sel} aria-label="Contact quality">
            <option value="reachable" className="text-ink">Reaches a person</option>
            <option value="all" className="text-ink">Every contactable store</option>
          </select>
          <label className="flex items-center gap-2 text-xs text-cream/45">
            Up to
            <input
              value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric" placeholder="max" aria-label="Maximum leads to send"
              className={`${sel} w-24`}
            />
          </label>
        </div>

        {/* the number that matters, and what it costs */}
        <div className="mt-4 rounded-2xl border border-cream/10 p-4">
          {countError ? (
            <p className="text-sm text-orange/90">{countError}</p>
          ) : (
            <p className={`text-sm text-cream/70 ${counting ? "opacity-50" : ""}`}>
              <strong className="font-display text-xl text-cream">{fmt(counts.reachable)}</strong>
              {" "}of {fmt(counts.all)} contactable stores reach a person
              {counts.all > 0 && (
                <span className="text-cream/45"> ({Math.round((counts.reachable / counts.all) * 100)}%)</span>
              )}
            </p>
          )}
          <p className="mt-1.5 text-xs text-cream/45">
            {quality === "reachable"
              ? "A named owner or a role mailbox we've verified, skipping domains with no mail server. The generic info@ queue is excluded."
              : "Includes the generic info@ / hello@ queue. Reply rates there are low and bounces cost your sending domain — widen only when you have a reason to."}
          </p>
          {scopeNote && <p className="mt-2 text-xs text-cream/45">{scopeNote}</p>}
        </div>

        {allowance && (
          <p className="mt-3 text-xs text-cream/45">
            A push spends export rows, same as a CSV.{" "}
            {allowance.limit == null
              ? <span className="text-cream/70">Your plan is unmetered.</span>
              : <span className="text-cream/70">{fmt(Math.max(0, remaining ?? 0))} of {fmt(allowance.limit)} rows left this month.</span>}
          </p>
        )}
        {pushBlocked && (
          <p className="mt-3 rounded-2xl border border-orange/30 bg-orange/10 p-3 text-xs text-orange">{pushBlocked}</p>
        )}
      </div>

      {/* ---- one card per tool -------------------------------------------- */}
      {providers.map((p) => (
        <ProviderCard
          key={p.key}
          provider={p}
          initialConnected={map.has(p.key)}
          initialConfig={map.get(p.key) ?? {}}
          cohort={{ country, tag, quality, limit: Number.isFinite(asked) && asked > 0 ? asked : undefined }}
          sendCount={sendCount(p)}
          cohortSize={selected}
          pushBlocked={pushBlocked ?? null}
          onCharged={(r) => { if (r != null) setRemaining(r); }}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  provider, initialConnected, initialConfig, cohort, sendCount, cohortSize, pushBlocked, onCharged,
}: {
  provider: PanelProvider;
  initialConnected: boolean;
  initialConfig: Record<string, unknown>;
  cohort: { country: string; tag: string; quality: Quality; limit?: number };
  sendCount: number;
  cohortSize: number;
  pushBlocked: string | null;
  onCharged: (remaining: number | null) => void;
}) {
  const [connected, setConnected] = useState(initialConnected);
  const [apiKey, setApiKey] = useState("");
  const [fieldVals, setFieldVals] = useState<Record<string, string>>({});
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>(String(initialConfig.campaignId ?? ""));
  const [campaignName, setCampaignName] = useState<string>(String(initialConfig.campaignName ?? ""));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function call(body: Record<string, unknown>, path = API) {
    const res = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider.key, ...body }),
    });
    return { ok: res.ok, j: await res.json() };
  }

  async function connect() {
    if (!apiKey.trim()) return;
    const fields = provider.fields ?? [];
    const missing = fields.find((f) => !fieldVals[f.key]?.trim());
    if (missing) { setMsg(`${missing.label} is required.`); return; }
    const config = Object.fromEntries(fields.map((f) => [f.key, (fieldVals[f.key] ?? "").trim()]));
    setBusy(true); setMsg("Verifying…");
    const { ok, j } = await call({ action: "connect", apiKey, config });
    if (!ok) { setMsg(j.error ?? "Failed"); setBusy(false); return; }
    const found: Campaign[] = j.campaigns ?? [];
    setConnected(true); setCampaigns(found); setApiKey(""); setFieldVals({});
    // Single-target tools (Slack/WhatsApp/HubSpot/Clay) expose one pseudo-campaign — auto-select it.
    if (found.length === 1) await saveCampaign(found[0].id, found);
    setMsg(found.length === 1 ? `Connected — ${found[0].name}.` : `Connected — ${found.length} campaigns found.`);
    setBusy(false);
  }
  async function loadCampaigns() {
    setBusy(true);
    const { ok, j } = await call({ action: "campaigns" });
    if (ok) setCampaigns(j.campaigns ?? []);
    else setMsg(j.error ?? "Couldn't load campaigns");
    setBusy(false);
  }
  async function disconnect() {
    setBusy(true);
    await call({ action: "disconnect" });
    setConnected(false); setCampaigns([]); setCampaignId(""); setCampaignName(""); setMsg("Disconnected.");
    setBusy(false);
  }
  async function saveCampaign(id: string, from: Campaign[] = campaigns) {
    const name = from.find((c) => c.id === id)?.name ?? "";
    setCampaignId(id); setCampaignName(name);
    await call({ action: "config", config: { campaignId: id, campaignName: name } });
  }
  async function push() {
    if (!campaignId) { setMsg("Pick a campaign first."); return; }
    setBusy(true); setMsg("Pushing leads…");
    const { ok, j } = await call({
      campaignId, quality: cohort.quality,
      country: cohort.country || undefined,
      tag: cohort.tag || undefined,
      limit: cohort.limit,
    }, `${API}/push`);
    if (!ok) { setMsg(j.error ?? "Push failed"); setBusy(false); return; }
    onCharged(typeof j.remaining === "number" ? j.remaining : null);
    setMsg(
      [
        `Pushed ${fmt(j.pushed ?? 0)}${j.sent && j.sent !== j.pushed ? ` of ${fmt(j.sent)}` : ""} lead${j.pushed === 1 ? "" : "s"}`,
        campaignName ? ` into ${campaignName}` : "",
        j.truncated ? ` — capped at ${fmt(j.truncated.cap)} of ${fmt(j.truncated.matched)} matched` : "",
        typeof j.remaining === "number" ? ` · ${fmt(j.remaining)} rows left this month` : "",
        j.note ? ` — ${j.note}` : "",
        j.error ? ` — ${j.error}` : "",
      ].join("") + ".",
    );
    setBusy(false);
  }

  const inp = "rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none focus:border-cream/50";
  const canPush = !!campaignId && !pushBlocked && sendCount > 0 && !busy;

  return (
    <div className="rounded-[2rem] border border-cream/12 bg-cream/[0.02] p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-xl text-cream">{provider.label}</h2>
          <p className="text-xs text-cream/45">{provider.hint}</p>
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-mint/15 px-3 py-1 text-xs font-semibold text-mint">
            <span className="h-1.5 w-1.5 rounded-full bg-mint" /> Connected
          </span>
        ) : (
          <span className="rounded-full border border-cream/15 px-3 py-1 text-xs text-cream/40">Not connected</span>
        )}
      </div>

      {!connected ? (
        <div className="mt-4 space-y-2">
          {(provider.fields ?? []).map((f) => (
            <input
              key={f.key}
              value={fieldVals[f.key] ?? ""}
              onChange={(e) => setFieldVals((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder ? `${f.label} — ${f.placeholder}` : f.label}
              className={`${inp} w-full`}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Paste ${provider.secretLabel ?? "API key"}`} className={`${inp} flex-1`} />
            <button onClick={connect} disabled={busy}
              className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-cyan-deep disabled:opacity-50">Connect</button>
          </div>
          <p className="text-[11px] text-cream/35">Stored encrypted. Shared with your workspace, so a teammate can push to the same campaign.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-cream/40">Campaign</span>
            <select value={campaignId} onChange={(e) => saveCampaign(e.target.value)} className={inp} aria-label="Target campaign">
              <option value="">{campaigns.length ? "Select…" : campaignName || "Load campaigns →"}</option>
              {campaigns.map((c) => <option key={c.id} value={c.id} className="text-ink">{c.name}</option>)}
            </select>
            {!campaigns.length && (
              <button onClick={loadCampaigns} disabled={busy}
                className="rounded-full border border-cream/20 px-3 py-1.5 text-xs text-cream/70">Load campaigns</button>
            )}
            <button onClick={disconnect} disabled={busy} className="ml-auto text-xs text-cream/40 hover:text-orange">Disconnect</button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={push} disabled={!canPush}
              className="rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">
              {sendCount > 0 ? `→ Push ${fmt(sendCount)} to ${provider.label}` : "→ Push"}
            </button>
            {/* Say which ceiling bit, so a number smaller than the cohort never looks like a bug. */}
            {sendCount > 0 && sendCount < cohortSize && (
              <span className="text-xs text-cream/45">
                of {fmt(cohortSize)} matched
                {provider.maxPerPush === sendCount ? ` — ${provider.label} takes ${fmt(provider.maxPerPush)} per push` : ""}
              </span>
            )}
            {sendCount === 0 && !pushBlocked && (
              <span className="text-xs text-cream/45">
                {cohortSize === 0 ? "No leads match that cohort." : "No export rows left this month."}
              </span>
            )}
          </div>
        </div>
      )}
      {msg && <p className="mt-3 text-xs text-cream/60">{msg}</p>}
    </div>
  );
}

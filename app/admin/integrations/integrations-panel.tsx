"use client";

import { useState } from "react";
import { tagLabel } from "@/lib/tag-defs";
import { marketLabel } from "@/lib/markets";

type Provider = { key: string; label: string; hint: string };
type Campaign = { id: string; name: string };

function ProviderCard({
  provider, initialConnected, initialConfig, cohorts, countries,
}: {
  provider: Provider;
  initialConnected: boolean;
  initialConfig: Record<string, unknown>;
  cohorts: { tag: string; count: number }[];
  countries: { country: string; stores: number }[];
}) {
  const [connected, setConnected] = useState(initialConnected);
  const [apiKey, setApiKey] = useState("");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>(String(initialConfig.campaignId ?? ""));
  const [cohort, setCohort] = useState("");   // "" = all contactable
  const [country, setCountry] = useState("");  // "" = all markets
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function call(body: Record<string, unknown>, path = "/api/admin/integrations") {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: provider.key, ...body }) });
    return { ok: res.ok, j: await res.json() };
  }

  async function connect() {
    if (!apiKey.trim()) return;
    setBusy(true); setMsg("Verifying…");
    const { ok, j } = await call({ action: "connect", apiKey });
    if (!ok) { setMsg(j.error ?? "Failed"); setBusy(false); return; }
    setConnected(true); setCampaigns(j.campaigns ?? []); setApiKey("");
    setMsg(`Connected — ${(j.campaigns ?? []).length} campaigns found.`);
    setBusy(false);
  }
  async function loadCampaigns() {
    setBusy(true);
    const { ok, j } = await call({ action: "campaigns" });
    if (ok) setCampaigns(j.campaigns ?? []);
    else setMsg(j.error ?? "Failed to load campaigns");
    setBusy(false);
  }
  async function disconnect() {
    setBusy(true);
    await call({ action: "disconnect" });
    setConnected(false); setCampaigns([]); setCampaignId(""); setMsg("Disconnected.");
    setBusy(false);
  }
  async function saveCampaign(id: string) {
    setCampaignId(id);
    await call({ action: "config", config: { campaignId: id, campaignName: campaigns.find((c) => c.id === id)?.name } });
  }
  async function push() {
    if (!campaignId) { setMsg("Pick a campaign first."); return; }
    setBusy(true); setMsg("Pushing leads…");
    const { ok, j } = await call({ campaignId, tag: cohort || undefined, country: country || undefined }, "/api/admin/integrations/push");
    setMsg(ok ? `Pushed ${j.pushed}/${j.total} leads${j.note ? ` — ${j.note}` : ""}.` : (j.error ?? "Push failed"));
    setBusy(false);
  }

  const inp = "rounded-full border border-cream/15 bg-transparent px-4 py-2 text-sm text-cream outline-none focus:border-cream/50";

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
        <div className="mt-4 flex flex-wrap gap-2">
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste API key" className={`${inp} flex-1`} />
          <button onClick={connect} disabled={busy} className="rounded-full bg-cyan px-5 py-2 text-sm font-medium text-cyan-deep disabled:opacity-50">Connect</button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-cream/40">Campaign</span>
            <select value={campaignId} onChange={(e) => saveCampaign(e.target.value)} className={inp}>
              <option value="">{campaigns.length ? "Select…" : "Load campaigns →"}</option>
              {campaigns.map((c) => <option key={c.id} value={c.id} className="text-ink">{c.name}</option>)}
            </select>
            {!campaigns.length && <button onClick={loadCampaigns} disabled={busy} className="rounded-full border border-cream/20 px-3 py-1.5 text-xs text-cream/70">Load campaigns</button>}
            <button onClick={disconnect} disabled={busy} className="ml-auto text-xs text-cream/40 hover:text-orange">Disconnect</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-cream/10 p-3">
            <span className="text-xs uppercase tracking-wide text-cream/40">Push</span>
            <select value={cohort} onChange={(e) => setCohort(e.target.value)} className={inp}>
              <option value="">All contactable</option>
              {cohorts.map((c) => <option key={c.tag} value={c.tag} className="text-ink">{tagLabel(c.tag)} ({c.count})</option>)}
            </select>
            {countries.length > 1 && (
              <select value={country} onChange={(e) => setCountry(e.target.value)} className={inp}>
                <option value="">All markets</option>
                {countries.map((c) => <option key={c.country} value={c.country} className="text-ink">{marketLabel(c.country)}</option>)}
              </select>
            )}
            <button onClick={push} disabled={busy || !campaignId} className="rounded-full bg-mint px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">
              → Push to campaign
            </button>
          </div>
        </div>
      )}
      {msg && <p className="mt-3 text-xs text-cream/60">{msg}</p>}
    </div>
  );
}

export function IntegrationsPanel({
  providers, connected, cohorts, countries,
}: {
  providers: Provider[];
  connected: { provider: string; config: Record<string, unknown> }[];
  cohorts: { tag: string; count: number }[];
  countries: { country: string; stores: number }[];
}) {
  const map = new Map(connected.map((c) => [c.provider, c.config]));
  return (
    <div className="mt-8 space-y-5">
      {providers.map((p) => (
        <ProviderCard
          key={p.key}
          provider={p}
          initialConnected={map.has(p.key)}
          initialConfig={map.get(p.key) ?? {}}
          cohorts={cohorts}
          countries={countries}
        />
      ))}
    </div>
  );
}

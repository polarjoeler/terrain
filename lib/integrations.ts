/** Outreach integrations — the shared "Connections" spine. Stores each tool's
 *  API key ENCRYPTED (AES-256-GCM, key derived from AUTH_SECRET), and exposes a
 *  uniform adapter interface (list campaigns, push leads) so each new tool is a
 *  thin addition. Currently: Instantly, Smartlead. */

import postgres from "postgres";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL not set");
    _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  }
  return _sql;
}
async function ensure() {
  await db()`CREATE TABLE IF NOT EXISTS integrations (
    owner TEXT NOT NULL, provider TEXT NOT NULL, secret TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (owner, provider))`;
}

/* ---- credential encryption ------------------------------------------------ */
const cryptoKey = () => createHash("sha256").update(process.env.AUTH_SECRET ?? "dev-secret").digest();
function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", cryptoKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/* ---- providers ------------------------------------------------------------ */
export type ProviderKey = "instantly" | "smartlead";
export const PROVIDERS: { key: ProviderKey; label: string; hint: string }[] = [
  { key: "instantly", label: "Instantly.ai", hint: "API key from Settings → Integrations → API" },
  { key: "smartlead", label: "Smartlead", hint: "API key from Settings → API Keys" },
];

export type PushLead = { email: string; company?: string | null; website?: string | null };
export type Campaign = { id: string; name: string };

type Adapter = {
  listCampaigns: (apiKey: string) => Promise<Campaign[]>;
  pushLeads: (apiKey: string, campaignId: string, leads: PushLead[]) => Promise<{ pushed: number; error?: string }>;
};

const ADAPTERS: Record<ProviderKey, Adapter> = {
  // Instantly v2 — Bearer auth. https://developer.instantly.ai/
  instantly: {
    async listCampaigns(apiKey) {
      const res = await fetch("https://api.instantly.ai/api/v2/campaigns?limit=100", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`Instantly ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return (j.items ?? j.data ?? []).map((c: { id: string; name: string }) => ({ id: String(c.id), name: c.name }));
    },
    async pushLeads(apiKey, campaignId, leads) {
      let pushed = 0;
      for (const l of leads) {
        const res = await fetch("https://api.instantly.ai/api/v2/leads", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ campaign: campaignId, email: l.email, company_name: l.company ?? undefined, website: l.website ?? undefined }),
        });
        if (res.ok) pushed++;
        else if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); }
      }
      return { pushed };
    },
  },
  // Smartlead v1 — api_key query param. https://api.smartlead.ai/reference
  smartlead: {
    async listCampaigns(apiKey) {
      const res = await fetch(`https://server.smartlead.ai/api/v1/campaigns?api_key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) throw new Error(`Smartlead ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return (Array.isArray(j) ? j : j.data ?? []).map((c: { id: number | string; name: string }) => ({ id: String(c.id), name: c.name }));
    },
    async pushLeads(apiKey, campaignId, leads) {
      const lead_list = leads.map((l) => ({ email: l.email, company_name: l.company ?? undefined, website: l.website ?? undefined }));
      let pushed = 0;
      for (let i = 0; i < lead_list.length; i += 100) {
        const res = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${campaignId}/leads?api_key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lead_list: lead_list.slice(i, i + 100) }),
        });
        if (res.ok) pushed += Math.min(100, lead_list.length - i);
      }
      return { pushed };
    },
  },
};

/* ---- connection store ----------------------------------------------------- */
export type ConnectionInfo = { provider: ProviderKey; config: Record<string, unknown>; connectedAt: string };

export async function setConnection(owner: string, provider: ProviderKey, apiKey: string, config: Record<string, unknown> = {}) {
  await ensure();
  await db()`
    INSERT INTO integrations (owner, provider, secret, config)
    VALUES (${owner.toLowerCase()}, ${provider}, ${encrypt(apiKey)}, ${db().json(config as Record<string, string | number | boolean | null>)})
    ON CONFLICT (owner, provider) DO UPDATE SET secret = EXCLUDED.secret, config = EXCLUDED.config, updated_at = now()`;
}

export async function updateConfig(owner: string, provider: ProviderKey, config: Record<string, unknown>) {
  await ensure();
  await db()`UPDATE integrations SET config = ${db().json(config as Record<string, string | number | boolean | null>)}, updated_at = now()
    WHERE owner = ${owner.toLowerCase()} AND provider = ${provider}`;
}

export async function deleteConnection(owner: string, provider: ProviderKey) {
  await ensure();
  await db()`DELETE FROM integrations WHERE owner = ${owner.toLowerCase()} AND provider = ${provider}`;
}

/** Connected providers for an owner (never returns the decrypted key). */
export async function listConnections(owner: string): Promise<ConnectionInfo[]> {
  await ensure();
  const rows = await db()<{ provider: ProviderKey; config: Record<string, unknown>; created_at: Date }[]>`
    SELECT provider, config, created_at FROM integrations WHERE owner = ${owner.toLowerCase()}`;
  return rows.map((r) => ({ provider: r.provider, config: r.config ?? {}, connectedAt: new Date(r.created_at).toISOString() }));
}

async function apiKeyFor(owner: string, provider: ProviderKey): Promise<string | null> {
  await ensure();
  const [r] = await db()<{ secret: string }[]>`SELECT secret FROM integrations WHERE owner = ${owner.toLowerCase()} AND provider = ${provider}`;
  return r ? decrypt(r.secret) : null;
}

/* ---- actions (used by the API routes) ------------------------------------- */
export async function listCampaigns(owner: string, provider: ProviderKey): Promise<Campaign[]> {
  const key = await apiKeyFor(owner, provider);
  if (!key) throw new Error("Not connected");
  return ADAPTERS[provider].listCampaigns(key);
}

export async function pushLeads(owner: string, provider: ProviderKey, campaignId: string, leads: PushLead[]): Promise<{ pushed: number; error?: string }> {
  const key = await apiKeyFor(owner, provider);
  if (!key) throw new Error("Not connected");
  if (!leads.length) return { pushed: 0 };
  return ADAPTERS[provider].pushLeads(key, campaignId, leads);
}

/** Verify a key works (used at connect time) — returns campaigns or throws. */
export async function verifyKey(provider: ProviderKey, apiKey: string): Promise<Campaign[]> {
  return ADAPTERS[provider].listCampaigns(apiKey);
}

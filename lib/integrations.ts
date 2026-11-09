/** Outreach integrations — the shared "Connections" spine. Stores each tool's
 *  API key ENCRYPTED (AES-256-GCM, key derived from AUTH_SECRET), and exposes a
 *  uniform adapter interface (list campaigns, push leads) so each new tool is a
 *  thin addition. Currently: Instantly, Smartlead, Slack, WhatsApp, HubSpot, Clay.
 *
 *  A connection belongs to the ORG, not the address that made it: lib/onboarding
 *  already scopes Slack and CRM as `scope: "org"`, and a seat holder who connects
 *  Slack must not create a connection the payer can neither see nor revoke. So every
 *  entry point here funnels `owner` through orgKey() — the same resolution seats use
 *  (see lib/profile.ts). A consumer inbox resolves to itself, so personal accounts are
 *  unaffected and no backfill is needed for them. */

import { db as sharedDb } from "./db";
import { orgKey } from "./profile";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function db() {
  return sharedDb();
}

/** Every read and write is keyed on this, never on the raw address. */
const ownerKey = (owner: string) => orgKey(owner);

// Once per process — not per request (see lib/tags.ts). The DDL takes ACCESS EXCLUSIVE.
let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (_ensured ??= db()`CREATE TABLE IF NOT EXISTS integrations (
    owner TEXT NOT NULL, provider TEXT NOT NULL, secret TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (owner, provider))`
    .then(() => {})
    .catch((e) => { _ensured = null; throw e; }));
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
export type ProviderKey = "instantly" | "smartlead" | "slack" | "whatsapp" | "hubspot" | "clay";

/** Fields a provider needs at connect time beyond the single secret. The panel
 *  renders one input per field; their values are stored (unencrypted) in config. */
export type ConnectField = { key: string; label: string; placeholder?: string };

/** Ceiling on one push, per provider. This is a DELIVERY limit, not a commercial one — the
 *  plan's row allowance is enforced separately in lib/export-gate. It exists because the
 *  adapters below differ by an order of magnitude in cost per lead: Instantly and Clay issue
 *  one sequential HTTP request PER lead, so a few thousand would exceed the route's 300s
 *  maxDuration and time out HALF-DELIVERED — and a half-delivered push that charged for the
 *  whole cohort is the worst outcome available. Smartlead and HubSpot batch 100 at a time, so
 *  they can take far more. Slack and WhatsApp are notification channels whose own message
 *  limits (50 and 20 lines shown) make a bulk dump pointless. */
const DEFAULT_MAX_PER_PUSH = 1_000;

/** Slack and WhatsApp are notification channels: they render a fixed number of lines and the rest
 *  of the batch is simply gone. Now that a push is metered as an export (see lib/export-gate), a
 *  ceiling above the display limit would charge for leads the channel never showed — 200 rows off
 *  a $69 plan's 500 to put 50 names in a channel. So the ceiling IS the display limit, from one
 *  constant each, and the adapters report the shown count as delivered rather than the batch size.
 *  Belt and braces on purpose: the ceiling keeps the UI honest about what it will send, the
 *  adapters' count keeps the charge honest for any caller that didn't clamp. */
const SLACK_LINES = 50;
const WHATSAPP_LINES = 20; // the Twilio message body is capped at 1600 characters

export const PROVIDERS: { key: ProviderKey; label: string; hint: string; secretLabel?: string; fields?: ConnectField[]; maxPerPush?: number }[] = [
  { key: "instantly", label: "Instantly.ai", hint: "API key from Settings → Integrations → API", maxPerPush: 1_000 },
  { key: "smartlead", label: "Smartlead", hint: "API key from Settings → API Keys", maxPerPush: 5_000 },
  { key: "slack", label: "Slack", hint: "Incoming Webhook URL — Slack → Apps → Incoming Webhooks → Add to a channel", maxPerPush: SLACK_LINES },
  {
    key: "whatsapp", label: "WhatsApp (Twilio)",
    hint: "Sends your lead list to a WhatsApp number via your own Twilio account. Twilio charges per message; sends run on your account.",
    secretLabel: "Twilio Auth Token", maxPerPush: WHATSAPP_LINES,
    fields: [
      { key: "accountSid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      { key: "from", label: "From (WhatsApp sender)", placeholder: "+14155238886 (Twilio sandbox or approved sender)" },
      { key: "to", label: "To (your WhatsApp number)", placeholder: "+2771xxxxxxx" },
    ],
  },
  {
    key: "hubspot", label: "HubSpot",
    hint: "Private App token — HubSpot → Settings → Integrations → Private Apps. Needs crm.objects.contacts.write.",
    secretLabel: "Private App token", maxPerPush: 5_000,
  },
  {
    key: "clay", label: "Clay",
    hint: "Webhook URL — in a Clay table: Add source → Import data from Webhook → copy the URL. Each lead lands as a row to enrich.",
    secretLabel: "Clay webhook URL", maxPerPush: 1_000,
  },
];

/** Delivery ceiling for one push to this provider. */
export const maxPerPush = (provider: ProviderKey): number =>
  PROVIDERS.find((p) => p.key === provider)?.maxPerPush ?? DEFAULT_MAX_PER_PUSH;

export type PushLead = { email: string; company?: string | null; website?: string | null };
export type Campaign = { id: string; name: string };
export type Config = Record<string, unknown>;

type Adapter = {
  listCampaigns: (secret: string, config: Config) => Promise<Campaign[]>;
  pushLeads: (secret: string, campaignId: string, leads: PushLead[], config: Config) => Promise<{ pushed: number; error?: string }>;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

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
  // Slack — the "API key" is an Incoming Webhook URL. No campaigns: we post the lead list straight to
  // the channel the webhook is bound to. https://api.slack.com/messaging/webhooks
  slack: {
    async listCampaigns(webhookUrl, _config) {
      if (!/^https:\/\/hooks\.slack\.com\/services\//.test(webhookUrl)) {
        throw new Error("Not a Slack Incoming Webhook URL (expected https://hooks.slack.com/services/…)");
      }
      // posting confirms the webhook is live + shows the user it's connected
      const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ":white_check_mark: *Terrain connected* — leads you push will land in this channel." }) });
      if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return [{ id: "channel", name: "This channel" }];
    },
    async pushLeads(webhookUrl, _campaignId, leads) {
      const site = (w?: string | null) => (w || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const shown = leads.slice(0, SLACK_LINES);
      const lines = shown.map((l) => {
        const name = l.company || site(l.website) || l.email;
        const web = site(l.website);
        return `• *${name}*${web ? ` — <https://${web}|${web}>` : ""}${l.email ? ` · ${l.email}` : ""}`;
      });
      const more = leads.length > shown.length ? `\n…and ${leads.length - shown.length} more.` : "";
      const text = `:dart: *${leads.length} lead${leads.length === 1 ? "" : "s"} from Terrain*\n${lines.join("\n")}${more}`;
      const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      // shown.length, not leads.length — the lines past the cap were never delivered and must not be charged.
      return res.ok ? { pushed: shown.length } : { pushed: 0, error: `Slack ${res.status}` };
    },
  },
  // WhatsApp via Twilio — secret = Auth Token; config = { accountSid, from, to }. No campaigns:
  // we send the lead list as one WhatsApp message to config.to, from config.from. Twilio bills the
  // user's own account per message. https://www.twilio.com/docs/whatsapp/api
  whatsapp: {
    async listCampaigns(authToken, config) {
      const { accountSid, to } = twilioCfg(config);
      if (!accountSid.startsWith("AC")) throw new Error("Account SID should start with 'AC'.");
      // verify creds without sending — fetch the account resource (free, read-only).
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`, {
        headers: { Authorization: twilioAuth(accountSid, authToken) },
      });
      if (res.status === 401) throw new Error("Twilio rejected the Account SID / Auth Token.");
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return [{ id: "whatsapp", name: to ? `WhatsApp → ${to}` : "WhatsApp" }];
    },
    async pushLeads(authToken, _campaignId, leads, config) {
      const { accountSid, from, to } = twilioCfg(config);
      if (!accountSid || !from || !to) return { pushed: 0, error: "Missing Account SID, From or To." };
      const site = (w?: string | null) => (w || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const shown = leads.slice(0, WHATSAPP_LINES);
      const lines = shown.map((l) => {
        const name = l.company || site(l.website) || l.email;
        const web = site(l.website);
        return `• ${name}${web ? ` — ${web}` : ""}${l.email ? ` · ${l.email}` : ""}`;
      });
      const more = leads.length > shown.length ? `\n…and ${leads.length - shown.length} more.` : "";
      const body = `🎯 ${leads.length} lead${leads.length === 1 ? "" : "s"} from Terrain\n${lines.join("\n")}${more}`.slice(0, 1550);
      const form = new URLSearchParams({ From: waNum(from), To: waNum(to), Body: body });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: twilioAuth(accountSid, authToken), "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (res.ok) return { pushed: shown.length }; // see the Slack note — only the shown lines were delivered
      // Twilio returns a helpful JSON { message, code } — surface it (e.g. 63016 = outside the 24h window → needs a template).
      let detail = `Twilio ${res.status}`;
      try { const j = await res.json(); if (j?.message) detail = `${j.message}${j.code ? ` (${j.code})` : ""}`; } catch {}
      return { pushed: 0, error: detail };
    },
  },
  // HubSpot CRM — secret = Private App token (Bearer). We upsert the leads as Contacts (email is the
  // natural key; company + website as properties). https://developers.hubspot.com/docs/api/crm/contacts
  hubspot: {
    async listCampaigns(token, _config) {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts?limit=1", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Error("HubSpot rejected the token.");
      if (res.status === 403) throw new Error("Token is missing the crm.objects.contacts scope.");
      if (!res.ok) throw new Error(`HubSpot ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return [{ id: "contacts", name: "Contacts" }];
    },
    async pushLeads(token, _campaignId, leads, _config) {
      const site = (w?: string | null) => (w || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      // batch upsert by email — idEmail avoids duplicate-contact errors on re-push.
      let pushed = 0;
      for (let i = 0; i < leads.length; i += 100) {
        const inputs = leads.slice(i, i + 100).map((l) => ({
          idProperty: "email",
          id: l.email,
          properties: {
            email: l.email,
            ...(l.company ? { company: l.company } : {}),
            ...(l.website ? { website: site(l.website) } : {}),
          },
        }));
        const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ inputs }),
        });
        if (res.ok) pushed += inputs.length;
        else if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); i -= 100; } // retry this batch
        else { const t = (await res.text()).slice(0, 160); return { pushed, error: `HubSpot ${res.status}: ${t}` }; }
      }
      return { pushed };
    },
  },
  // Clay — the "API key" is a Clay webhook-source URL (Clay table → Add source → Import from Webhook).
  // We POST one JSON object per lead; each becomes a row Clay can then enrich. The unguessable URL is
  // the credential (no separate token). https://www.clay.com/university/guide/import-data-via-webhook
  clay: {
    async listCampaigns(webhookUrl, _config) {
      if (!/^https:\/\/[a-z0-9.-]*clay\.com\//i.test(webhookUrl)) {
        throw new Error("Not a Clay webhook URL (expected https://api.clay.com/… from a table's Webhook source).");
      }
      // A webhook has no health check, so confirm connectivity with one clearly-marked test row.
      const res = await fetch(webhookUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _terrain: "connection_test", company: "Terrain — connection test", note: "Safe to delete this row." }),
      });
      if (!res.ok) throw new Error(`Clay ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return [{ id: "table", name: "Clay table" }];
    },
    async pushLeads(webhookUrl, _campaignId, leads, _config) {
      const site = (w?: string | null) => (w || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      let pushed = 0;
      for (const l of leads) {
        const res = await fetch(webhookUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: site(l.website) || undefined, company: l.company ?? undefined, email: l.email || undefined, website: l.website ?? undefined, source: "Terrain" }),
        });
        if (res.ok) pushed++;
        else if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); } // Clay throttle — brief pause, skip this one
      }
      return { pushed };
    },
  },
};

/* ---- Twilio helpers ------------------------------------------------------- */
function twilioCfg(config: Config) {
  return { accountSid: str(config.accountSid), from: str(config.from), to: str(config.to) };
}
const twilioAuth = (sid: string, token: string) => `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
const waNum = (n: string) => (n.startsWith("whatsapp:") ? n : `whatsapp:${n}`);

/* ---- connection store ----------------------------------------------------- */
export type ConnectionInfo = { provider: ProviderKey; config: Record<string, unknown>; connectedAt: string };

export async function setConnection(owner: string, provider: ProviderKey, apiKey: string, config: Record<string, unknown> = {}) {
  await ensure();
  await db()`
    INSERT INTO integrations (owner, provider, secret, config)
    VALUES (${ownerKey(owner)}, ${provider}, ${encrypt(apiKey)}, ${db().json(config as Record<string, string | number | boolean | null>)})
    ON CONFLICT (owner, provider) DO UPDATE SET secret = EXCLUDED.secret, config = EXCLUDED.config, updated_at = now()`;
}

export async function updateConfig(owner: string, provider: ProviderKey, config: Record<string, unknown>) {
  await ensure();
  await db()`UPDATE integrations SET config = ${db().json(config as Record<string, string | number | boolean | null>)}, updated_at = now()
    WHERE owner = ${ownerKey(owner)} AND provider = ${provider}`;
}

export async function deleteConnection(owner: string, provider: ProviderKey) {
  await ensure();
  await db()`DELETE FROM integrations WHERE owner = ${ownerKey(owner)} AND provider = ${provider}`;
}

/** Connected providers for an owner (never returns the decrypted key). */
export async function listConnections(owner: string): Promise<ConnectionInfo[]> {
  await ensure();
  const rows = await db()<{ provider: ProviderKey; config: Record<string, unknown>; created_at: Date }[]>`
    SELECT provider, config, created_at FROM integrations WHERE owner = ${ownerKey(owner)}`;
  return rows.map((r) => ({ provider: r.provider, config: r.config ?? {}, connectedAt: new Date(r.created_at).toISOString() }));
}

async function credsFor(owner: string, provider: ProviderKey): Promise<{ secret: string; config: Config } | null> {
  await ensure();
  const [r] = await db()<{ secret: string; config: Config }[]>`SELECT secret, config FROM integrations WHERE owner = ${ownerKey(owner)} AND provider = ${provider}`;
  return r ? { secret: decrypt(r.secret), config: r.config ?? {} } : null;
}

/* ---- actions (used by the API routes) ------------------------------------- */
export async function listCampaigns(owner: string, provider: ProviderKey): Promise<Campaign[]> {
  const c = await credsFor(owner, provider);
  if (!c) throw new Error("Not connected");
  return ADAPTERS[provider].listCampaigns(c.secret, c.config);
}

export async function pushLeads(owner: string, provider: ProviderKey, campaignId: string, leads: PushLead[]): Promise<{ pushed: number; error?: string }> {
  const c = await credsFor(owner, provider);
  if (!c) throw new Error("Not connected");
  if (!leads.length) return { pushed: 0 };
  return ADAPTERS[provider].pushLeads(c.secret, campaignId, leads, c.config);
}

/** Verify a key works (used at connect time) — returns campaigns or throws. */
export async function verifyKey(provider: ProviderKey, apiKey: string, config: Config = {}): Promise<Campaign[]> {
  return ADAPTERS[provider].listCampaigns(apiKey, config);
}

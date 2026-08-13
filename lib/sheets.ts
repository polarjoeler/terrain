/** Server-side reader for the live Terrain feed (Google Sheet).
 *
 * The discovery pipeline writes one raw tab per TLD plus an "Enriched" tab that
 * the Mac agent maintains. This reads Enriched — the full lead record — and
 * normalises it into the shape the UI wants.
 *
 * Sheets is the store of record for now; when this moves to Postgres, only this
 * file changes.
 */

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Lead } from "./leads";

const SHEET_ID = process.env.TERRAIN_SHEET_ID;
const ENRICHED_TAB = "Enriched";

// Column order written by enrich_from_sheet.py
const COL = {
  domain: 0,
  name: 1,
  country: 2,
  productCount: 3,
  priceMin: 4,
  priceMax: 5,
  currency: 6,
  email: 7,
  phone: 8,
  theme: 9,
  plus: 10,
  payments: 11,
  firstProductAt: 12,
  latestProductAt: 13,
  apps: 14,
  socials: 15,
  firstSeen: 16,
  finalUrl: 17,
  note: 18,
} as const;

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length ? s : null;
}

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64url");

let cachedToken: { token: string; expires: number } | null = null;

/** Mint a Google access token from the service-account key.
 *
 * Deliberately dependency-free: the `googleapis` SDK's HTTP stack breaks Next's
 * response streaming ("ArrayBuffer is not detachable"), so we sign the JWT with
 * node:crypto and use plain fetch.
 */
/** The service-account key, from an env var (Vercel) or a file (local dev).
 *  Serverless has no persistent files, so production sets the JSON inline in
 *  GOOGLE_SERVICE_ACCOUNT_JSON; locally we still read the key file path. */
async function loadServiceKey(): Promise<{ client_email: string; private_key: string }> {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) return JSON.parse(inline);
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath) return JSON.parse(await readFile(keyPath, "utf8"));
  throw new Error("No Google credentials: set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS");
}

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const key = await loadServiceKey();

  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: iat + 3600,
    iat,
  };
  const unsigned =
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
    "." +
    b64url(JSON.stringify(claim));

  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const jwt = unsigned + "." + signer.sign(key.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
  return json.access_token;
}

async function readRange(range: string): Promise<string[][]> {
  const token = await accessToken();
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
    encodeURIComponent(range);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`sheets ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { values?: string[][] };
  return json.values ?? [];
}

export async function fetchLeads(): Promise<{ leads: Lead[]; live: boolean }> {
  const hasCreds =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!SHEET_ID || !hasCreds) {
    return { leads: [], live: false };
  }
  try {
    const rows = await readRange(`${ENRICHED_TAB}!A2:S`);

    const leads: Lead[] = rows
      .filter((r) => r[COL.domain])
      .map((r) => ({
        domain: r[COL.domain],
        name: str(r[COL.name]) ?? r[COL.domain],
        productCount: num(r[COL.productCount]),
        priceMin: num(r[COL.priceMin]),
        priceMax: num(r[COL.priceMax]),
        email: str(r[COL.email]),
        firstProductAt: str(r[COL.firstProductAt])?.slice(0, 10) ?? null,
        plus: Boolean(str(r[COL.plus])),
        firstSeen: str(r[COL.firstSeen])?.slice(0, 10) ?? "",
        country: str(r[COL.country]),
        currency: str(r[COL.currency]),
        payments: str(r[COL.payments])?.split(";").filter(Boolean) ?? [],
        theme: str(r[COL.theme]),
        finalUrl: str(r[COL.finalUrl]),
      }))
      // newest discoveries first
      .sort((a, b) => (b.firstSeen ?? "").localeCompare(a.firstSeen ?? ""));

    return { leads, live: true };
  } catch (err) {
    console.error("[terrain] sheet read failed:", err);
    return { leads: [], live: false };
  }
}

export function summarise(leads: Lead[]) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return {
    storesTracked: leads.length,
    newThisWeek: leads.filter((l) => l.firstSeen >= weekAgo).length,
    withEmail: leads.filter((l) => l.email).length,
    plusFlagged: leads.filter((l) => l.plus).length,
    withPayments: leads.filter((l) => (l.payments?.length ?? 0) > 0).length,
  };
}

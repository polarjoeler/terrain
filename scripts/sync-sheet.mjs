#!/usr/bin/env node
/**
 * Sync the cert-transparency discovery feed (Google Sheet "Enriched" tab) into
 * Postgres — the pipeline's step 1. Self-contained like the other cron scripts
 * (node + .env.local), so it needs no web app, no CRON_SECRET, no Vercel:
 *
 *   node --env-file=.env.local scripts/sync-sheet.mjs
 *
 * - Backfills discovered_at (= Sheet first_seen, the genuine "found first" date)
 *   and first_product_at onto existing rows WITHOUT touching their enrichment.
 * - Inserts freshly-found ZA stores that aren't in Postgres yet (published, so
 *   they surface immediately; the enrichment passes fill them in later).
 *
 * Mirrors lib/imported.ts syncFromSheet() + the Sheet auth in lib/sheets.ts.
 */

import postgres from "postgres";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const SHEET_ID = process.env.TERRAIN_SHEET_ID;
const ENRICHED_TAB = "Enriched";
// Column order written by the discovery pipeline (enrich_from_sheet.py).
const COL = {
  domain: 0, name: 1, country: 2, productCount: 3, priceMin: 4, priceMax: 5,
  currency: 6, email: 7, theme: 9, plus: 10, payments: 11, firstProductAt: 12,
  firstSeen: 16,
};

const b64url = (b) => Buffer.from(b).toString("base64url");

function loadServiceKey() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) return JSON.parse(inline);
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (p) return JSON.parse(readFileSync(p, "utf8"));
  throw new Error("No Google credentials (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)");
}

async function accessToken() {
  const key = loadServiceKey();
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: iat + 3600,
    iat,
  };
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify(claim));
  const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function readEnriched() {
  const token = await accessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${ENRICHED_TAB}!A2:S`)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sheets ${res.status}: ${await res.text()}`);
  return (await res.json()).values ?? [];
}

const str = (v) => { const s = (v ?? "").toString().trim(); return s.length ? s : null; };
const num = (v) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
const date = (v) => { const s = str(v); return s && s.length >= 8 ? s.slice(0, 10) : null; };

function isZa(domain, country) {
  const d = (domain || "").toLowerCase();
  const c = (country || "").toLowerCase();
  return d.endsWith(".za") || c === "za" || c.includes("south africa");
}

async function main() {
  if (!SHEET_ID) throw new Error("TERRAIN_SHEET_ID not set");
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3, onnotice: () => {} });
  try {
    await sql`SELECT 1`;
    await sql`ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS discovered_at DATE`;

    const rows = await readEnriched();
    const zaRows = rows.filter((r) => r[COL.domain] && isZa(r[COL.domain], r[COL.country]));
    console.log(`sheet rows: ${rows.length}, ZA: ${zaRows.length}`);

    const existing = new Set(
      (await sql`SELECT domain FROM imported_stores`).map((r) => r.domain),
    );

    const records = zaRows.map((r) => ({
      domain: r[COL.domain].trim().toLowerCase(),
      name: str(r[COL.name]) ?? r[COL.domain],
      country: "ZA",
      email: str(r[COL.email]),
      theme: str(r[COL.theme]),
      plus: Boolean(str(r[COL.plus])),
      payments: str(r[COL.payments]),
      product_count: num(r[COL.productCount]),
      price_min: num(r[COL.priceMin]),
      price_max: num(r[COL.priceMax]),
      currency: str(r[COL.currency]),
      first_seen: date(r[COL.firstSeen]),
      first_product_at: date(r[COL.firstProductAt]),
      discovered_at: date(r[COL.firstSeen]),
      published: true,
      source: "discovery",
    }));

    const cols = [
      "domain", "name", "country", "email", "theme", "plus", "payments",
      "product_count", "price_min", "price_max", "currency", "first_seen",
      "first_product_at", "discovered_at", "published", "source",
    ];
    let updated = 0, inserted = 0;
    for (let i = 0; i < records.length; i += 400) {
      const batch = records.slice(i, i + 400);
      await sql`
        INSERT INTO imported_stores ${sql(batch, ...cols)}
        ON CONFLICT (domain) DO UPDATE SET
          discovered_at    = COALESCE(EXCLUDED.discovered_at, imported_stores.discovered_at),
          first_product_at = COALESCE(EXCLUDED.first_product_at, imported_stores.first_product_at)`;
      for (const r of batch) (existing.has(r.domain) ? updated++ : inserted++);
    }
    console.log(`sync done: ${updated} updated, ${inserted} inserted`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

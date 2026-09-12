#!/usr/bin/env node
/**
 * Publish a provider's digest lead lists to a fresh, link-shareable Google Sheet — one tab
 * per list — so they open in Sheets with zero import. Prints the shareable URL.
 *
 *   node --env-file=.env.local scripts/publish-digest-sheet.mjs --provider Paystack --markets ZA,NG,KE,GH
 *
 * Needs the same Google service-account creds as sync-sheet.mjs, but WRITE scopes
 * (spreadsheets + drive) — the service account creates & owns the sheet, then it's shared
 * "anyone with the link can view".
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROVIDER = opt("--provider", "Paystack");
const MARKETS = opt("--markets", "ZA,NG,KE,GH").split(",").map((s) => s.trim().toUpperCase());
const DATE = new Date().toISOString().slice(0, 10);
const b64url = (b) => Buffer.from(b).toString("base64url");

function loadKey() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inline) return JSON.parse(inline);
  return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
}
async function token() {
  const k = loadKey();
  const iat = Math.floor(Date.now() / 1000);
  const claim = { iss: k.client_email, scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", exp: iat + 3600, iat };
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify(claim));
  const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(k.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

const COLS = ["domain", "name", "country", "city", "category", "est_monthly_sales", "currency", "plus", "payments", "discovered_at", "email"];
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false });
const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
const IN_MK = sql`UPPER(country) = ANY(${MARKETS})`;
const HAS_PROV = sql`EXISTS (SELECT 1 FROM unnest(string_to_array(lower(payments),';')) g WHERE btrim(g) LIKE ${'%' + PROVIDER.toLowerCase() + '%'})`;
const grid = (rows) => [COLS, ...rows.map((r) => [r.domain, r.name, r.country, r.city, r.category,
  r.estimated_monthly_sales, r.currency, r.plus, r.payments, r.discovered_at, r.email].map((v) => v == null ? "" : String(v)))];

async function main() {
  const launched = await sql`SELECT domain,name,country,city,category,estimated_monthly_sales,currency,plus,payments,discovered_at,email
    FROM imported_stores WHERE ${LIVE} AND ${IN_MK} AND discovered_at >= now()-interval '7 days' ORDER BY estimated_monthly_sales DESC NULLS LAST`;
  const noGw = await sql`SELECT domain,name,country,city,category,estimated_monthly_sales,currency,plus,payments,discovered_at,email
    FROM imported_stores WHERE ${LIVE} AND ${IN_MK} AND payments_checked_at IS NOT NULL AND (payments IS NULL OR payments='') ORDER BY estimated_monthly_sales DESC NULLS LAST`;
  const poach = await sql`SELECT domain,name,country,city,category,estimated_monthly_sales,currency,plus,payments,discovered_at,email
    FROM imported_stores WHERE ${LIVE} AND ${IN_MK} AND payments IS NOT NULL AND payments<>'' AND NOT ${HAS_PROV} ORDER BY estimated_monthly_sales DESC NULLS LAST LIMIT 250`;
  await sql.end();

  const tabs = [
    { title: `Launched last week (${launched.length})`, values: grid(launched) },
    { title: `No gateway yet (${noGw.length})`, values: grid(noGw) },
    { title: `Poaching targets (${poach.length})`, values: grid(poach) },
  ];

  const t = await token();
  const H = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  // 1) create the spreadsheet with the three tabs + a bold frozen header row each
  const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", { method: "POST", headers: H,
    body: JSON.stringify({
      properties: { title: `${PROVIDER} — Digest leads (${DATE})` },
      sheets: tabs.map((tb, i) => ({ properties: { sheetId: i, title: tb.title,
        gridProperties: { frozenRowCount: 1 } } })),
    }) });
  if (!createRes.ok) throw new Error(`create ${createRes.status}: ${await createRes.text()}`);
  const doc = await createRes.json();
  const id = doc.spreadsheetId;

  // 2) write each tab's values
  const data = tabs.map((tb) => ({ range: `${tb.title}!A1`, majorDimension: "ROWS", values: tb.values }));
  const putRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    method: "POST", headers: H, body: JSON.stringify({ valueInputOption: "RAW", data }) });
  if (!putRes.ok) throw new Error(`values ${putRes.status}: ${await putRes.text()}`);

  // 3) share: anyone with the link can view (store domains are public business data)
  const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
    method: "POST", headers: H, body: JSON.stringify({ role: "reader", type: "anyone" }) });
  const shared = permRes.ok;

  console.log(`✓ Published: ${PROVIDER} digest leads → Google Sheet`);
  console.log(`  tabs: ${tabs.map((tb) => tb.title).join(" · ")}`);
  console.log(`  link-share (anyone with link): ${shared ? "ON" : "FAILED — " + await permRes.text()}`);
  console.log(`\n  ${`https://docs.google.com/spreadsheets/d/${id}/edit`}`);
}
main().catch((e) => { console.error("publish-digest-sheet failed:", e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * VPS-output check — "how did the VPS do today?" straight from the Google Sheet, so the
 * answer does NOT depend on the (SentinelOne-stalled) Mac's landing pipeline or DB. Reads
 * the Enriched tab and counts rows by first_seen date. Runs anywhere with the Sheet creds
 * (ideally ON the VPS itself, which already writes to the Sheet).
 *
 *   node --env-file=.env.local scripts/vps-stats.mjs
 *
 * Needs TERRAIN_SHEET_ID + Google creds (GOOGLE_APPLICATION_CREDENTIALS or
 * GOOGLE_SERVICE_ACCOUNT_JSON), the same as sync-sheet.mjs.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const SHEET_ID = process.env.TERRAIN_SHEET_ID;
const ENRICHED_TAB = "Enriched";
const COL = { domain: 0, country: 2, firstSeen: 16 };
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
  const claim = { iss: key.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", exp: iat + 3600, iat };
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify(claim));
  const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function readRows() {
  if (!SHEET_ID) throw new Error("TERRAIN_SHEET_ID not set");
  const token = await accessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${ENRICHED_TAB}!A2:S`)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sheets ${res.status}: ${await res.text()}`);
  return (await res.json()).values ?? [];
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const parseDay = (v) => {
  const s = (v ?? "").toString().trim();
  if (!s) return null;
  const d = new Date(s.replace(/\//g, "-").slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : isoDay(d);
};

const rows = await readRows();
const withDomain = rows.filter((r) => r[COL.domain]);
const today = isoDay(new Date());
const yday = isoDay(new Date(Date.now() - 864e5));
const cut7 = isoDay(new Date(Date.now() - 7 * 864e5));
const isVis = (r) => ["ZA", "KE", "NG"].includes((r[COL.country] ?? "").toString().trim().toUpperCase());

let tToday = 0, tYday = 0, t7 = 0, undated = 0, visToday = 0, vis7 = 0;
const perDay = {};
for (const r of withDomain) {
  const d = parseDay(r[COL.firstSeen]);
  if (!d) { undated++; continue; }
  if (d === today) { tToday++; if (isVis(r)) visToday++; }
  if (d === yday) tYday++;
  if (d >= cut7) { t7++; if (isVis(r)) vis7++; perDay[d] = (perDay[d] ?? 0) + 1; }
}

console.log(`Sheet total: ${withDomain.length.toLocaleString()} stores  (${undated.toLocaleString()} with no first_seen date)`);
console.log(`\nVPS output (by first_seen — direct from the Sheet, no DB/landing needed):`);
console.log(`  Today (${today}):      ${tToday}   (${visToday} in ZA/KE/NG)`);
console.log(`  Yesterday (${yday}):  ${tYday}`);
console.log(`  Last 7 days:            ${t7}   (${vis7} in ZA/KE/NG)  ≈ ${(t7 / 7).toFixed(0)}/day`);
console.log(`\n  daily (last 7d):`);
for (const d of Object.keys(perDay).sort()) console.log(`    ${d}  ${perDay[d]}`);

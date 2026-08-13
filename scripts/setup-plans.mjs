#!/usr/bin/env node
/** One-off: create the Terrain plans in your Paystack account.
 *
 *   PAYSTACK_SECRET_KEY=sk_test_xxx node scripts/setup-plans.mjs
 *
 * Prints the plan codes to paste into .env.local. Safe to re-run: it reuses a
 * plan with the same name instead of creating a duplicate.
 */

const KEY = process.env.PAYSTACK_SECRET_KEY;
if (!KEY) {
  console.error("Set PAYSTACK_SECRET_KEY first (use your sk_test_ key to trial this).");
  process.exit(1);
}

// ZAR amounts are in CENTS.
const PLANS = [
  { name: "Terrain Starter", amount: 49900, interval: "monthly",
    description: "Weekly digest, CSV export, contact emails" },
  { name: "Terrain Pro", amount: 99900, interval: "monthly",
    description: "Live dashboard, Plus flags, same-day alerts" },
];

async function api(path, init) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || !json.status) {
    throw new Error(`${path}: ${json.message ?? res.status}`);
  }
  return json.data;
}

const existing = await api("/plan?perPage=100");
const byName = new Map(existing.map((p) => [p.name, p]));
const out = {};

for (const spec of PLANS) {
  const found = byName.get(spec.name);
  if (found) {
    console.log(`= ${spec.name} already exists (${found.plan_code})`);
    out[spec.name] = found.plan_code;
    continue;
  }
  const created = await api("/plan", {
    method: "POST",
    body: { ...spec, currency: "ZAR" },
  });
  console.log(`+ created ${spec.name} (${created.plan_code})`);
  out[spec.name] = created.plan_code;
}

console.log("\nAdd these to .env.local:\n");
console.log(`PAYSTACK_PLAN_STARTER=${out["Terrain Starter"]}`);
console.log(`PAYSTACK_PLAN_PRO=${out["Terrain Pro"]}`);

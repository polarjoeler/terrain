#!/usr/bin/env node
/**
 * Measure how well a local model names the person behind a store — against GROUND TRUTH, free.
 *
 * The test set builds itself. For every store where the crawl already found a genuinely named
 * address (carlo@elevenpast.co.za), we know the answer: the person's first name is in the mailbox.
 * So we hide it, hand the model only the banked contact copy, and ask who runs the business. If it
 * comes back "Carlo", it was right. No labelling, no annotation, no API bill.
 *
 * It reads BANKED text (imported_stores.contact_text), so it touches no store and uses none of the
 * Shopify rate budget — the whole point of banking the copy was to make experiments like this free
 * and repeatable.
 *
 *   node --env-file=.env.local scripts/contact-name-eval.mjs --model qwen2.5:3b --limit 150
 *   node --env-file=.env.local scripts/contact-name-eval.mjs --model qwen2.5:7b --limit 150
 *   node --env-file=.env.local scripts/contact-name-eval.mjs --model regex --limit 150   # no LLM
 *
 * Scores three ways, because they trade off:
 *   correct  — named the right person
 *   wrong    — named someone/something else (the expensive error: it ends up in a customer's CSV)
 *   abstain  — returned nothing. Not a failure; silence beats a confident wrong name.
 */
import postgres from "postgres";
import { looksLikePersonName, trimNameEdges, nameFromText } from "./contact-enrich.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODEL = arg("--model", "qwen2.5:3b");
const LIMIT = Number(arg("--limit", 150));
const VERBOSE = process.argv.includes("--verbose");
const LLM = (process.env.LOCAL_LLM_URL || "").replace(/\/$/, "");

const strip = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

function prompt(domain, text) {
  return `Below is the contact/about copy from the website ${domain}.

"""
${text.slice(0, 3500)}
"""

Who is the individual person that runs this business, if the text names one?
Rules: use ONLY the text above. A brand, shop, product or place name is NOT a person. If no
individual is named, return null. Do not guess.
Respond with ONLY minified JSON: {"name": "<full name or null>"}`;
}

async function askModel(domain, text) {
  const res = await fetch(`${LLM}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: "user", content: prompt(domain, text) }],
      max_tokens: 80, temperature: 0, response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const d = await res.json();
  const raw = d.choices?.[0]?.message?.content ?? "";
  let v = null;
  try { v = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw)?.name ?? null; } catch { /* unparseable */ }
  if (typeof v !== "string" || /^(null|none|n\/a|unknown)$/i.test(v.trim())) return null;
  return v.trim();
}

async function main() {
  if (MODEL !== "regex" && !LLM) { console.error("LOCAL_LLM_URL not set"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
  try {
    const rows = await sql`
      SELECT domain, contact_email, contact_text FROM imported_stores
      WHERE contact_type = 'named' AND contact_email IS NOT NULL
        AND contact_text IS NOT NULL AND length(contact_text) > 300
      ORDER BY domain
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("no labelled stores yet."); return; }
    console.log(`eval: ${MODEL} over ${rows.length} stores with a KNOWN named address (banked text, no network)\n`);

    let correct = 0, wrong = 0, abstain = 0, failed = 0;
    const t0 = Date.now();
    for (const r of rows) {
      const truth = strip(r.contact_email.split("@")[0]);
      let raw = null;
      if (MODEL === "regex") raw = nameFromText(r.contact_text);
      else {
        try { raw = await askModel(r.domain, r.contact_text); }
        catch { failed++; continue; }
      }
      const name = raw ? trimNameEdges(raw) : null;
      if (!name || !looksLikePersonName(name)) { abstain++; continue; }
      // The mailbox is the first name 96% of the time; accept either token matching it, so
      // "Daniel Yuen" scores against daniel@ and a surname mailbox is not punished.
      const toks = name.split(/\s+/).map(strip).filter(Boolean);
      const ok = toks.some((t) => t && (t === truth || truth.startsWith(t) || t.startsWith(truth)));
      if (ok) correct++; else { wrong++; if (VERBOSE) console.log(`  wrong  ${r.domain.padEnd(32)} said "${name}"  actual ${r.contact_email}`); }
    }
    const judged = correct + wrong;
    const secs = Math.round((Date.now() - t0) / 1000);
    const pc = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");
    console.log(`model            ${MODEL}`);
    console.log(`correct          ${String(correct).padStart(4)}   ${pc(correct, rows.length)} of all stores`);
    console.log(`wrong            ${String(wrong).padStart(4)}   ${pc(wrong, rows.length)} of all stores`);
    console.log(`abstained        ${String(abstain).padStart(4)}   ${pc(abstain, rows.length)} — returned nothing`);
    if (failed) console.log(`model errors     ${String(failed).padStart(4)}`);
    console.log(`\nprecision (correct of those it answered)  ${pc(correct, judged)}   ← the number that matters: a wrong name reaches a customer`);
    console.log(`recall    (correct of all stores)          ${pc(correct, rows.length)}`);
    console.log(`took ${secs}s  (${(secs / rows.length).toFixed(1)}s/store)`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

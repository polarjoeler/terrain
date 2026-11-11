#!/usr/bin/env node
/**
 * Step 4 — infer the personal address for a store where we know WHO to write to but only hold a
 * generic inbox. "Daniel Yuen" + montirex.com + info@montirex.com → daniel@montirex.com.
 *
 * MEASURED PRIOR, not a guessed permutation list. Across the 175 named addresses this crawl has
 * confirmed on real SA stores, the local-part shape is:
 *
 *     bare first name   96.0%     carlo@ · andrew@ · edward@ · lori@
 *     first.last         3.4%
 *     f.last / f_last    0.0%
 *
 * So the long permutation ladder every vendor sells is wrong for this market: candidate #1 is
 * right almost every time a personal address exists at all. That cuts verification volume ~5x —
 * the current candidate set is ~2 guesses each, not 5-8.
 *
 *   node --env-file=.env.local scripts/contact-permute.mjs --migrate    # ONCE
 *   node --env-file=.env.local scripts/contact-permute.mjs --dry        # generate + print
 *   node --env-file=.env.local scripts/contact-permute.mjs              # generate + store
 *   node --env-file=.env.local scripts/contact-permute.mjs --verify     # + paid verification
 *
 * INTEGRITY: a guess is NEVER written to contact_email and NEVER changes contact_type. It lands in
 * its own column with its own status, so "named" keeps meaning "the merchant published this" and a
 * customer can always tell the difference. An inferred address is a different kind of claim and the
 * product has to say so — that is the whole reason the contact_type verdict is worth anything.
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const DRY = has("--dry");
const MIGRATE = has("--migrate");
const VERIFY = has("--verify");
// Free accuracy check: on stores where the crawl ALREADY found a real named address, hide it,
// guess from the person's name, and see whether we would have got it. Costs nothing, needs no
// vendor, and is the only honest way to know the hit rate before paying to verify anything.
const HOLDOUT = has("--holdout");
const LIMIT = Number(arg("--limit", 5000));

// Verification vendor: left unset by default so a run can never silently spend. Any provider with
// a single-address GET endpoint fits by changing these two env vars.
const VENDOR = (arg("--vendor", process.env.EMAIL_VERIFY_VENDOR || "") || "").toLowerCase();
const MAILVERI = VENDOR === "mailveri";
// MailVeri's own docs contradict themselves — form field vs JSON body, Authorization: Bearer vs
// X-Api-Key — so the adapter below tries one shape and falls back, and --probe settles which is
// real on a single credit instead of discovering it 900 addresses into a batch.
const VERIFY_URL = process.env.EMAIL_VERIFY_URL
  || (MAILVERI ? "https://api.mailveri.com/v1/verify-mail/" : "");    // e.g. https://api.millionverifier.com/api/v3/?api=KEY&email=
const VERIFY_KEY = process.env.EMAIL_VERIFY_KEY || "";
const PROBE = arg("--probe", "");          // verify ONE address, dump the raw response, spend 1 credit
// Credits are a FINITE, non-replenishing pot. Without a cap a run walks the queue until the vendor
// cuts it off, having spent the whole balance on whatever happened to sort first. --max-credits
// stops cleanly while there is still budget left to aim.
const MAX_CREDITS = Number(arg("--max-credits", 0)) || Infinity;
// Guesses generated in an earlier pass had contact_guess_checked_at stamped even though nothing
// verified them, so the normal selection (checked_at IS NULL) can never see them again.
// --reverify targets exactly those stranded rows and tests the guess already stored.
const REVERIFY = has("--reverify");
let BALANCE = null;                        // vendor-reported credits remaining, if it tells us

// Guessing an address at gmail.com is meaningless — the local-part is not derived from the person's
// employer. Only ever permute against a domain the business controls.
const FREEMAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|protonmail|proton|zoho|mail|gmx|webmail|telkomsa|vodamail|mweb|iafrica|absamail|yebo|naver)\./i;

const clean = (d) => (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
const domainOf = (e) => { const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(e || "").trim().toLowerCase()); return m ? m[1] : null; };

// Dutch/Afrikaans/Portuguese particles are part of the surname, and SA surnames are full of them.
const PARTICLES = new Set(["van", "van der", "von", "de", "du", "le", "la", "da", "dos", "den", "ter"]);
/** "Francois le Roux" → {first:"francois", last:"leroux", lastBare:"roux"} */
function parseName(v) {
  const flat = String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const words = flat.split(/[^a-z]+/).filter(Boolean);
  if (words.length < 1) return null;
  const first = words[0];
  // A hyphenated given name is often kept intact in the mailbox — the holdout found Kay-Leigh
  // at kay-leigh@, which splitting on non-letters had reduced to kay@.
  const firstHyphen = (flat.split(/\s+/)[0] || "").replace(/[^a-z-]/g, "").replace(/^-|-$/g, "");
  if (first.length < 2) return null;
  const rest = words.slice(1);
  if (!rest.length) return { first, firstHyphen, last: null, lastBare: null };
  const lastBare = rest[rest.length - 1];
  const last = rest.filter((w) => !PARTICLES.has(w)).join("") || lastBare;
  return { first, firstHyphen, last: rest.join(""), lastBare: last === lastBare ? null : lastBare };
}

/** Candidates in measured-likelihood order. Short list ON PURPOSE — see the prior above. */
function candidates(name, domain) {
  const p = parseName(name);
  if (!p) return [];
  const out = [`${p.first}@${domain}`];                                   // 96%
  if (p.firstHyphen && p.firstHyphen !== p.first) out.push(`${p.firstHyphen}@${domain}`);
  if (p.last) {
    out.push(`${p.first}.${p.last}@${domain}`);                           // 3.4%
    if (p.lastBare) out.push(`${p.first}.${p.lastBare}@${domain}`);       // particle-stripped variant
  }
  return [...new Set(out)];
}

let POST_SHAPE = null;   // learned once: which body/auth combination this vendor actually accepts

async function callVendor(email, shape) {
  const headers = shape.auth === "x-api-key"
    ? { "X-Api-Key": VERIFY_KEY }
    : { Authorization: `Bearer ${VERIFY_KEY}` };
  let url = VERIFY_URL, init = { headers, signal: AbortSignal.timeout(20000) };
  if (shape.method === "POST") {
    init.method = "POST";
    if (shape.body === "form") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = new URLSearchParams({ mail: email }).toString();
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ email, mail: email });
    }
  } else {
    url = VERIFY_URL.includes("{email}")
      ? VERIFY_URL.replace("{email}", encodeURIComponent(email))
      : `${VERIFY_URL}${encodeURIComponent(email)}`;
  }
  return fetch(url, init);
}

async function verifyOne(email) {
  if (!VERIFY_URL) return { status: "unverified", raw: null };

  let res, body;
  if (MAILVERI) {
    // Try the shape that worked last time; otherwise walk the candidates once.
    // form + Bearer is what MailVeri's OWN Google Apps Script sends, so it leads. The rest stay
    // as fallback only because the public docs describe something different.
    const shapes = POST_SHAPE ? [POST_SHAPE] : [
      { method: "POST", body: "form", auth: "bearer" },
      { method: "POST", body: "json", auth: "bearer" },
      { method: "POST", body: "form", auth: "x-api-key" },
      { method: "POST", body: "json", auth: "x-api-key" },
    ];
    let lastErr = null;
    for (const shape of shapes) {
      res = await callVendor(email, shape);
      if (res.ok) { POST_SHAPE = shape; break; }
      // 400/401/415 means "wrong shape" — keep looking. Anything else is a real failure.
      if (![400, 401, 403, 415, 422].includes(res.status)) break;
      lastErr = `${res.status} on ${shape.body}/${shape.auth}`;
      res = null;
    }
    if (!res) throw new Error(`verify rejected every request shape (${lastErr})`);
    if (!res.ok) throw new Error(`verify ${res.status}`);
    body = await res.json();
  } else {
    res = await callVendor(email, { method: "GET" });
    if (!res.ok) throw new Error(`verify ${res.status}`);
    body = await res.json();
  }

  if (body && body.balance != null) BALANCE = body.balance;
  // error 2 = insufficient credits. Every further call is a guaranteed failure, so surface it as
  // a distinct condition the run can halt on rather than logging 800 identical errors.
  if (body && body.error === 2) { const e = new Error(`out of credits: ${body.message ?? ""}`); e.outOfCredits = true; throw e; }
  if (PROBE) console.log("  raw response: " + JSON.stringify(body));

  const raw = String(body.result ?? body.status ?? body.state ?? "").toLowerCase();
  // A catch-all domain accepts EVERYTHING, so a "valid" from one is not evidence — recording it as
  // valid would manufacture exactly the false confidence this whole lane exists to remove.
  // UNKNOWN is kept SEPARATE from catch-all: it means the vendor could not determine an answer,
  // which is a retryable non-result, not a statement about the domain.
  if (/catch.?all|accept.?all/.test(raw)) return { status: "catch_all", raw };
  // A guess that lands on a role inbox IS deliverable but is not the person we inferred, so it
  // must not be promoted as a personal address.
  if (/role.?account|role_account/.test(raw)) return { status: "role", raw };
  // FULL_INBOX is a full mailbox, which proves the mailbox EXISTS — that is what we are testing.
  if (/^(ok|valid|deliverable|full.?inbox)$/.test(raw)) return { status: "verified", raw };
  if (/invalid|undeliverable|disposable|reject/.test(raw)) return { status: "rejected", raw };
  return { status: "unverified", raw };
}

const DDL = [
  "SET lock_timeout = '3s'",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_email_guess TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_guess_status TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_guess_pattern TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_guess_checked_at TIMESTAMPTZ",
  "RESET lock_timeout",
];

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 4, idle_timeout: 20 });
  try {
    if (MIGRATE) {
      for (const q of DDL) {
        console.log(q.slice(0, 74));
        try { await sql.unsafe(q); }
        catch (e) {
          if (/lock timeout|canceling statement/i.test(e.message)) { console.error(`  ✗ busy: ${e.message}`); process.exit(4); }
          throw e;
        }
      }
      console.log("migrated."); return;
    }
    if (VERIFY && !VERIFY_URL) {
      console.error("--verify needs EMAIL_VERIFY_URL (and usually EMAIL_VERIFY_KEY). Refusing to pretend.");
      process.exit(3);
    }

    // --probe spends ONE credit to learn the vendor's real request/response contract before a
    // batch commits the rest. Prints the accepted request shape and the raw body verbatim.
    if (PROBE) {
      if (!VERIFY_URL) { console.error("--probe needs EMAIL_VERIFY_URL or --vendor mailveri."); process.exit(3); }
      if (!VERIFY_KEY) { console.error("--probe needs EMAIL_VERIFY_KEY."); process.exit(3); }
      console.log(`probing ${VERIFY_URL} with ${PROBE}`);
      const r = await verifyOne(PROBE);
      console.log(`  accepted shape: ${POST_SHAPE ? `${POST_SHAPE.method} ${POST_SHAPE.body}/${POST_SHAPE.auth}` : "GET"}`);
      console.log(`  vendor status:  ${r.raw}`);
      console.log(`  mapped to:      ${r.status}`);
      if (BALANCE != null) console.log(`  credits left:   ${BALANCE}`);
      return;
    }

    if (HOLDOUT) {
      const known = await sql`SELECT domain, contact_name, contact_email FROM imported_stores
        WHERE contact_type = 'named' AND contact_name IS NOT NULL AND contact_email IS NOT NULL`;
      let top = 0, inList = 0, wrong = 0, skipped = 0;
      for (const k of known) {
        const dom = domainOf(k.contact_email);
        if (!dom || FREEMAIL.test(dom)) { skipped++; continue; }   // never permuted in a real run
        const cands = candidates(k.contact_name, dom);
        if (!cands.length) { skipped++; continue; }
        const i = cands.indexOf(k.contact_email.trim().toLowerCase());
        if (i === 0) { top++; inList++; } else if (i > 0) { inList++; } else {
          wrong++;
          if (DRY) console.log(`  miss  ${k.contact_name.padEnd(24)} guessed ${cands[0].padEnd(36)} actual ${k.contact_email}`);
        }
      }
      const n = top + (inList - top) + wrong;
      if (!n) { console.log("holdout: no comparable stores yet."); return; }
      console.log(`\nholdout over ${known.length} stores whose real named address we already know`);
      console.log(`  ${skipped} not guessable (freemail domain) — a real run skips these too`);
      console.log(`  ${n} comparable:`);
      console.log(`    top guess exactly right   ${String(top).padStart(4)}  ${Math.round(100 * top / n)}%`);
      console.log(`    right somewhere in list   ${String(inList).padStart(4)}  ${Math.round(100 * inList / n)}%`);
      console.log(`    wrong                     ${String(wrong).padStart(4)}  ${Math.round(100 * wrong / n)}%`);
      console.log(`\n  At ~${(inList / n * 100).toFixed(0)}% accuracy a verification pass is worth running; below ~40% it is not.`);
      return;
    }

    const rows = REVERIFY
      ? await sql`
      SELECT domain, contact_name, contact_email, contact_type, email, contact_email_guess
      FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND contact_name IS NOT NULL
        AND contact_type IS DISTINCT FROM 'named'
        AND contact_mx_ok IS NOT FALSE        -- a domain that bounces makes every guess pointless
        AND contact_email_guess IS NOT NULL
        AND contact_guess_status = 'unverified'
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`
      : await sql`
      SELECT domain, contact_name, contact_email, contact_type, email, contact_email_guess
      FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND contact_name IS NOT NULL
        AND contact_type IS DISTINCT FROM 'named'
        AND contact_mx_ok IS NOT FALSE        -- a domain that bounces makes every guess pointless
        AND contact_guess_checked_at IS NULL
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${LIMIT}`;
    if (!rows.length) { console.log("no candidates — run contact-enrich first, or all are done."); return; }

    console.log(`contact-permute: ${rows.length} candidate(s)${DRY ? " [DRY]" : ""}`
      + `${VERIFY ? " · VERIFYING (paid)" : " · generate only (free; pass --verify to test them)"}`);

    let generated = 0, skipped = 0, verified = 0, rejected = 0, catchAll = 0, cost = 0, budgetStop = false;
    for (const r of rows) {
      // Permute against the business's own mail domain — the one its published address uses when
      // that is its own, else the store domain.
      const existingDom = domainOf(r.contact_email ?? r.email);
      const dom = existingDom && !FREEMAIL.test(existingDom) ? existingDom : clean(r.domain);
      if (!dom || FREEMAIL.test(dom)) { skipped++; continue; }

      const cands = candidates(r.contact_name, dom);
      const existingLocal = String(r.contact_email ?? r.email ?? "").split("@")[0].toLowerCase();
      const fresh = cands.filter((c) => c.split("@")[0] !== existingLocal);
      if (!fresh.length) { skipped++; continue; }

      // When re-verifying, test the address we already published into the column first: that is the
      // one downstream consumers have seen, so it is the one that needs a verdict.
      if (REVERIFY && r.contact_email_guess) {
        const g = String(r.contact_email_guess).toLowerCase();
        // A stored guess may sit on a domain belonging to a DIFFERENT business: when contact_email
        // was null the generator fell back to the vendor-imported `email`, which is not always this
        // store's. edgars.co.za inherited norman@stagheaddesigns.com that way. Verifying it would
        // spend a credit and, if it came back VALID, bolt a stranger's address onto the store.
        // A guess is only legitimate on the store's own domain or on the one its published
        // contact address already uses.
        const gDom = g.split("@")[1];
        const ok = gDom === dom || (existingDom && gDom === existingDom);
        if (!ok) {
          console.log(`  ~ ${r.domain}: stored guess ${g} is on an unrelated domain — skipped, not billed`);
          skipped++; continue;
        }
        fresh.sort((a, b) => (a === g ? -1 : b === g ? 1 : 0));
        if (!fresh.includes(g)) fresh.unshift(g);
      }

      let pick = fresh[0], status = "unverified", pattern = fresh[0].split("@")[0].includes(".") ? "first.last" : "first";
      if (VERIFY) {
        for (const c of fresh) {
          if (cost >= MAX_CREDITS) { budgetStop = true; break; }
          cost++;
          let v;
          try { v = await verifyOne(c); }
          catch (e) {
            console.log(`  ! ${c}: ${e.message}`);
            if (e.outOfCredits) { budgetStop = true; }
            break;
          }
          if (v.status === "verified") { pick = c; status = "verified"; verified++; break; }
          if (v.status === "catch_all") { pick = c; status = "catch_all"; catchAll++; break; }
          if (v.status === "rejected") { rejected++; continue; }
        }
        if (status === "unverified" && rejected) pick = fresh[0];
        pattern = pick.split("@")[0].includes(".") ? "first.last" : "first";
      }
      if (budgetStop) {
        console.log(`\n  stopped: hit the --max-credits ceiling of ${MAX_CREDITS}. Nothing further was billed.`);
        break;
      }
      generated++;
      if (DRY) {
        console.log(`● ${r.domain.padEnd(32)} ${r.contact_name.padEnd(22)} ${pick.padEnd(38)} ${status}  (have: ${r.contact_email ?? "-"})`);
      } else {
        await sql`UPDATE imported_stores SET
            contact_email_guess = ${pick}, contact_guess_status = ${status},
            contact_guess_pattern = ${pattern}, contact_guess_checked_at = now()
          WHERE domain = ${r.domain}`.catch((e) => console.log(`  ! write ${r.domain}: ${e.message}`));
      }
    }
    console.log(`\nDone. ${generated} guessed, ${skipped} skipped (freemail domain, or the guess is what we already hold).`);
    if (VERIFY) {
      console.log(`  verified ${verified} · catch-all ${catchAll} · rejected ${rejected} · ${cost} verification calls billed`);
      if (BALANCE != null) console.log(`  credits left at vendor: ${BALANCE}`);
    }
    else console.log(`  All stored as status='unverified' — a guess, labelled as one. Nothing claims these are real yet.`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

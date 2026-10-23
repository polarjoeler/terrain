#!/usr/bin/env node
/**
 * Deliverability check — can the contact address we hold actually receive mail?
 *
 * contact-enrich answers "who does this address reach". This answers the other half of what a
 * high-volume sender (Peach's complaint: bad emails) actually needs: will it bounce. An address
 * whose domain publishes no MX record is a guaranteed bounce no matter how good the local-part
 * looks, and a surprising number of scraped addresses sit on parked or migrated domains.
 *
 * FREE, and — unlike every other probe here — OUTSIDE the Shopify-edge rate budget: this is pure
 * DNS, never an HTTP request to the store. So it can run at high concurrency any time, including
 * alongside the payment probes, and can re-check the whole base cheaply.
 *
 *   node --env-file=.env.local scripts/contact-mx.mjs --migrate     # ONCE
 *   node --env-file=.env.local scripts/contact-mx.mjs --dry
 *   node --env-file=.env.local scripts/contact-mx.mjs --limit 5000
 *
 * Also lands two things that are free once you are looking at every address at once:
 *  - contact_mx_host: the mail provider (Google/Microsoft/cPanel/…). A merchant on Workspace is a
 *    different prospect from one on a reseller's shared cPanel.
 *  - contact_shared_count: how many OTHER stores we track use this exact address. >1 means an
 *    agency, a franchise head office or an aggregator — the mail reaches someone, but not this
 *    merchant, which is its own flavour of "bad email".
 */
import postgres from "postgres";
import { Resolver } from "node:dns/promises";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const DRY = has("--dry");
const MIGRATE = has("--migrate");
const RECHECK = has("--recheck");          // re-test addresses already checked
const LIMIT = Number(arg("--limit", 20000));
const CONC = Number(arg("--concurrency", 24));   // DNS only — no store is touched

// Public resolvers, so a flaky local DNS cache can't mark live domains undeliverable.
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

const MX_PROVIDER = [
  [/google|googlemail|gmail/i, "Google"], [/outlook|microsoft|office365|protection\.outlook/i, "Microsoft"],
  [/zoho/i, "Zoho"], [/yandex/i, "Yandex"], [/protonmail|proton\.me/i, "Proton"],
  [/mimecast/i, "Mimecast"], [/proofpoint|pphosted/i, "Proofpoint"], [/barracuda/i, "Barracuda"],
  [/cpanel|hostgator|bluehost|namecheap|privateemail/i, "cPanel/shared"],
  [/xneelo|hetzner\.co\.za/i, "xneelo"], [/afrihost/i, "Afrihost"], [/webafrica/i, "Web Africa"],
  [/registrar|parked|sedo/i, "Parked"],
];
const providerOf = (host) => MX_PROVIDER.find(([re]) => re.test(host))?.[1] ?? null;

const domainOf = (e) => { const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(e || "").trim().toLowerCase()); return m ? m[1] : null; };

/** @returns {{ok: boolean|null, host: string|null}} ok=null means "couldn't tell" (DNS failure),
 *  which is deliberately NOT the same as ok=false ("domain publishes no MX") — writing a
 *  transient resolver error as undeliverable would quietly condemn live addresses. */
async function checkMx(domain) {
  try {
    const recs = await resolver.resolveMx(domain);
    const live = recs.filter((r) => r.exchange && r.exchange !== ".");
    if (!live.length) return { ok: false, host: null };
    live.sort((a, b) => a.priority - b.priority);
    return { ok: true, host: live[0].exchange.toLowerCase().replace(/\.$/, "") };
  } catch (e) {
    // NODATA/NOTFOUND are real answers: the domain has no mail. Everything else is our problem.
    if (e.code === "ENODATA" || e.code === "ENOTFOUND" || e.code === "NXDOMAIN") return { ok: false, host: null };
    return { ok: null, host: null };
  }
}

const DDL = [
  "SET lock_timeout = '3s'",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_mx_ok BOOLEAN",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_mx_host TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_mx_provider TEXT",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_shared_count INTEGER",
  "ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS contact_mx_checked_at TIMESTAMPTZ",
  "RESET lock_timeout",
];

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set (--env-file=.env.local)"); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 6, idle_timeout: 20 });
  try {
    if (MIGRATE) {
      for (const q of DDL) {
        console.log(q.slice(0, 76));
        try { await sql.unsafe(q); }
        catch (e) {
          if (/lock timeout|canceling statement/i.test(e.message)) {
            console.error(`  ✗ ${e.message}\n  Table busy — re-run when the pipeline is idle.`); process.exit(4);
          }
          throw e;
        }
      }
      console.log("migrated."); return;
    }

    const best = "CASE WHEN contact_checked_at IS NOT NULL THEN COALESCE(contact_email, email) ELSE email END";
    const rows = await sql.unsafe(`
      SELECT domain, ${best} AS addr FROM imported_stores
      WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
        AND ${best} IS NOT NULL AND ${best} <> ''
        ${RECHECK ? "" : "AND contact_mx_checked_at IS NULL"}
      ORDER BY estimated_monthly_sales DESC NULLS LAST
      LIMIT ${Number(LIMIT)}`);
    if (!rows.length) { console.log("nothing to check."); return; }

    // How many tracked stores share each address — computed once over the whole base, not per row.
    const sharedRows = await sql.unsafe(`
      SELECT lower(btrim(${best})) AS addr, count(*)::int n FROM imported_stores
      WHERE published AND ${best} IS NOT NULL AND ${best} <> ''
      GROUP BY 1 HAVING count(*) > 1`);
    const shared = new Map(sharedRows.map((r) => [r.addr, r.n]));
    console.log(`contact-mx: ${rows.length} address(es)${DRY ? " [DRY]" : ""} · DNS only (no store touched) · conc ${CONC}`);
    console.log(`            ${shared.size} address(es) are reused across more than one store`);

    // One DNS lookup per DOMAIN, not per store — many stores share a mail domain.
    const byDomain = new Map();
    for (const r of rows) {
      const d = domainOf(r.addr);
      if (!d) continue;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(r);
    }
    const domains = [...byDomain.keys()];
    console.log(`            ${domains.length} distinct mail domains to resolve\n`);

    const verdicts = new Map();
    let i = 0, noMx = 0, unknown = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, domains.length) }, async () => {
      while (i < domains.length) {
        const d = domains[i++];
        const v = await checkMx(d);
        verdicts.set(d, v);
        if (v.ok === false) noMx++; else if (v.ok === null) unknown++;
        if (verdicts.size % 500 === 0) console.log(`— ${verdicts.size}/${domains.length} resolved`);
      }
    }));

    // Collect every row's verdict, then write in CHUNKS. One UPDATE per store is ~3k sequential
    // round-trips on a throttled pooler; at full base size that is the slowest part of the job by
    // an order of magnitude. Chunked rather than one giant statement because an unbounded array
    // parameter has caused its own trouble on this table.
    const tally = new Map();
    const pending = [];
    for (const [d, list] of byDomain) {
      const v = verdicts.get(d) ?? { ok: null, host: null };
      const provider = v.host ? providerOf(v.host) : null;
      if (provider) tally.set(provider, (tally.get(provider) ?? 0) + list.length);
      for (const r of list) {
        pending.push({
          domain: r.domain, ok: v.ok, host: v.host, provider,
          shared: shared.get(String(r.addr).trim().toLowerCase()) ?? 1,
        });
      }
    }
    let written = 0;
    const CHUNK = 500;
    for (let c = 0; !DRY && c < pending.length; c += CHUNK) {
      const batch = pending.slice(c, c + CHUNK);
      try {
        await sql`
          UPDATE imported_stores AS s SET
            contact_mx_ok = v.ok, contact_mx_host = v.host, contact_mx_provider = v.provider,
            contact_shared_count = v.shared, contact_mx_checked_at = now()
          FROM (SELECT * FROM unnest(
                  ${sql.array(batch.map((b) => b.domain))}::text[],
                  ${sql.array(batch.map((b) => b.ok))}::boolean[],
                  ${sql.array(batch.map((b) => b.host))}::text[],
                  ${sql.array(batch.map((b) => b.provider))}::text[],
                  ${sql.array(batch.map((b) => b.shared))}::int[]
                ) AS t(domain, ok, host, provider, shared)) AS v
          WHERE s.domain = v.domain`;
        written += batch.length;
      } catch (e) { console.log(`  ! batch ${c}-${c + batch.length}: ${e.message}`); }
      if (written % 2000 === 0) console.log(`— ${written}/${pending.length} written`);
    }

    const sharedStores = rows.filter((r) => (shared.get(String(r.addr).trim().toLowerCase()) ?? 1) > 1).length;
    console.log(`\nDone. ${domains.length} domains resolved, ${written} store rows updated.`);
    console.log(`  no MX (will bounce)     ${String(noMx).padStart(6)}  domains`);
    console.log(`  unresolvable (unknown)  ${String(unknown).padStart(6)}  domains — left null, re-checkable`);
    console.log(`  shared mailbox          ${String(sharedStores).padStart(6)}  stores pointing at an address another store also uses`);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) console.log(`  mail providers: ${top.map(([p, n]) => `${p}=${n}`).join("  ")}`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error("failed:", e.message); process.exit(1); });

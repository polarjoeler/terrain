/**
 * crux-sweep — find the world's stores we don't hold, from every CrUX country list.
 *
 * Measured 2026-11-18: the union of all 238 CrUX country lists is 13.56M sites, about 3.5M of them
 * stores (Woo ~1.9M, Shopify ~840k, then PrestaShop/Ecwid/Squarespace/Wix/Magento/OpenCart). We
 * held 85% of the Shopify ones but only 7% of the Woo and 2% of everything else. ingest-ranked.mjs
 * already does this for one market at a time; this is the same classifier over every market at
 * once, built to run for days on one machine.
 *
 * Two steps:
 *
 *   --build   Read every country list in a directory (cc.csv.gz, or cc/<month>.csv.gz), keep each
 *             site's best rank, drop what imported_stores already holds and the obvious non-stores
 *             (gov/edu/adult/global blocklist), and write a TSV of candidates: Africa first, then
 *             best rank. Country comes from evidence crux-country.mjs already trusts:
 *               a country-code domain              → that country      country_source 'cctld'
 *               clearly best-ranked in ONE list    → that country      'crux-home'
 *               tied at the top across lists       → none              'crux-global'
 *
 *   (run)     For each candidate: DNS first, free and outside every rate budget. A site in a hosted
 *             commerce platform's own range (Shopify's 23.227.38.0/24, BigCommerce, Ecwid, YouCan…,
 *             the shared table in lib/hosted-platforms.json) is a store on that platform: no page is
 *             fetched. That keeps Shopify's edge off this machine's IP entirely. A site that doesn't
 *             resolve is dead. Everything else gets ONE homepage GET (capped at 128KB, our normal UA,
 *             no retries past one redirect chain) through lib/storefront-classify.mjs.
 *
 * Stores land published=false, source='crux-sweep', with crux_rank and the country above, exactly
 * like every bulk import. confirm-other-cms treats 'crux-sweep' like 'crux-ranked' (country and
 * platform need evidence before anything publishes), and WooCommerce rows flow into woo-checkout,
 * which reads their gateways and currency. Non-stores are NOT written to the database: every verdict
 * goes to a local JSONL results file, which is also the resume point. Keep it for next month's delta.
 *
 *   node --max-old-space-size=8192 --env-file=.env.local scripts/crux-sweep.mjs --build ~/crux/202609 --month 202609 --out ~/crux/candidates.tsv
 *   node --env-file=.env.local scripts/crux-sweep.mjs --in ~/crux/candidates.tsv --results ~/crux/results.jsonl --month 202609 [--concurrency 48] [--limit N] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createGunzip } from "node:zlib";
import { Resolver } from "node:dns/promises";
import postgres from "postgres";
import { fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { classify, nonStoreDomain } from "./lib/storefront-classify.mjs";
import { loadHostedPlatforms, matchHosted } from "./lib/hosted-platforms.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const MONTH = arg("--month", "202609");
const DRY = has("--dry");

const AFRICA = new Set("DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW".split(" "));
// Country-code endings sold as generic names — not evidence of where a site is (same list as crux-country.mjs).
const VANITY = new Set("io co me tv ai cc ws fm gg to sh ly so la st gl vc ag nu tk ml ga cf gq gs su ac im eu asia".split(" "));
const ccOf = (host) => {
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (tld.length !== 2 || VANITY.has(tld)) return null;
  return tld === "uk" ? "GB" : tld.toUpperCase();
};
/** "https://www.Shop.co.za:443" → { domain: "shop.co.za", origin: "https://www.shop.co.za" } */
const parseOrigin = (o) => {
  const m = /^(https?):\/\/([^/:]+)/i.exec(o.trim());
  if (!m) return null;
  const host = m[2].toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes(".")) return null;
  return { domain: host.replace(/^www\./, ""), origin: `${m[1].toLowerCase()}://${host}` };
};

/* ---- build ---------------------------------------------------------------------------------- */
async function build() {
  const dir = arg("--build");
  const out = arg("--out", path.join(dir, "candidates.tsv"));
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && /^[a-z]{2}\.csv\.gz$/.test(e.name)) files.push([e.name.slice(0, 2).toUpperCase(), path.join(dir, e.name)]);
    else if (e.isDirectory() && /^[a-z]{2}$/.test(e.name) && fs.existsSync(path.join(dir, e.name, `${MONTH}.csv.gz`))) files.push([e.name.toUpperCase(), path.join(dir, e.name, `${MONTH}.csv.gz`)]);
  }
  if (!files.length) throw new Error(`no cc.csv.gz country lists in ${dir}`);
  // 13.5M sites: a Map to an index plus typed arrays, not an object per site.
  const idx = new Map();
  const origins = [];
  const CAP = 16_000_000;
  const best = new Int32Array(CAP).fill(0x7fffffff), bestCc = new Uint16Array(CAP), ties = new Uint8Array(CAP);
  const ccs = files.map(([cc]) => cc);
  for (const [k, [cc, file]] of files.entries()) {
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      const c = line.lastIndexOf(",");
      const rank = Number(line.slice(c + 1));
      if (!rank) continue;                                   // header
      const p = parseOrigin(line.slice(0, c));
      if (!p) continue;
      let i = idx.get(p.domain);
      if (i === undefined) { i = origins.length; idx.set(p.domain, i); origins.push(p.origin); }
      if (rank < best[i]) { best[i] = rank; bestCc[i] = k; ties[i] = 1; origins[i] = p.origin; }
      else if (rank === best[i] && bestCc[i] !== k) ties[i] = Math.min(255, ties[i] + 1);
    }
    if ((k + 1) % 40 === 0) console.log(`  ${k + 1}/${files.length} lists · ${idx.size.toLocaleString()} sites`);
  }
  console.log(`union: ${idx.size.toLocaleString()} sites across ${files.length} lists`);

  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connection: { statement_timeout: 120000 } });
  let held = 0, last = "";
  try {
    for (;;) {
      const rows = await sql`SELECT domain FROM imported_stores WHERE domain > ${last} ORDER BY domain LIMIT 100000`;
      if (!rows.length) break;
      for (const r of rows) if (idx.delete(String(r.domain).toLowerCase().replace(/^www\./, ""))) held++;
      last = rows[rows.length - 1].domain;
    }
  } finally { await sql.end({ timeout: 5 }); }

  const outRows = [];
  let blocked = 0;
  for (const [domain, i] of idx) {
    if (nonStoreDomain(domain)) { blocked++; continue; }
    const tld = ccOf(domain);
    const [cc, src] = tld ? [tld, "cctld"] : ties[i] === 1 ? [ccs[bestCc[i]], "crux-home"] : ["", "crux-global"];
    outRows.push([domain, origins[i], best[i], cc, src]);
  }
  outRows.sort((a, b) => (AFRICA.has(b[3]) - AFRICA.has(a[3])) || a[2] - b[2]);
  fs.writeFileSync(out, outRows.map((r) => r.join("\t")).join("\n") + "\n");
  const africa = outRows.filter((r) => AFRICA.has(r[3])).length;
  console.log(`✓ ${outRows.length.toLocaleString()} candidates → ${out}  (already held ${held.toLocaleString()} · blocklisted ${blocked.toLocaleString()} · Africa ${africa.toLocaleString()} first)`);
}

/* ---- sweep ---------------------------------------------------------------------------------- */
async function sweep() {
  const IN = arg("--in");
  const RESULTS = arg("--results", IN.replace(/\.tsv$/, "") + ".results.jsonl");
  const CONC = Number(arg("--concurrency", 48));
  const LIMIT = Number(arg("--limit", 0));
  const MAX_BYTES = Number(arg("--max-bytes", 131072));
  const table = loadHostedPlatforms();

  const done = new Set();
  if (fs.existsSync(RESULTS)) {
    const rl = readline.createInterface({ input: fs.createReadStream(RESULTS), crlfDelay: Infinity });
    for await (const line of rl) { const m = /"d":"([^"]+)"/.exec(line); if (m) done.add(m[1]); }
  }
  const sql = DRY ? null : postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 30, connect_timeout: 30,
    connection: { statement_timeout: 60000, lock_timeout: 10000 } });
  const resOut = DRY ? null : fs.createWriteStream(RESULTS, { flags: "a" });

  const st = { seen: 0, dead: 0, dnsStore: 0, store: 0, custom: 0, notStore: 0, closed: 0, net: 0, throttled: 0, written: 0, bytes: 0 };
  const byPlat = new Map();
  const pending = [];   // stores waiting for the batched insert
  let lines = [];       // verdicts read since the last insert — written to the results file only once it lands
  const flush = async () => {
    const b = pending.splice(0), l = lines; lines = [];
    if (DRY) return;
    if (b.length) {
      const col = (k) => b.map((x) => x[k]);
      const r = await sql`
        INSERT INTO imported_stores (domain, country, country_source, platform, hosting_provider, published, source, crux_rank, crux_rank_month, payments, discovered_at)
        SELECT d, nullif(c, ''), cs, p, nullif(h, ''), false, 'crux-sweep', r, ${MONTH}, nullif(pay, ''), now()
          FROM unnest(${col("domain")}::text[], ${col("cc")}::text[], ${col("csrc")}::text[], ${col("platform")}::text[],
                      ${col("host")}::text[], ${col("rank")}::int[], ${col("pay")}::text[]) AS t(d, c, cs, p, h, r, pay)
        ON CONFLICT (domain) DO NOTHING`;
      st.written += r.count;
    }
    if (l.length) resOut.write(l.join("\n") + "\n");
  };
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (!stopping) { stopping = true; console.log(`\n${sig}: finishing in-flight sites and writing results…`); } });

  // Stream the candidate file instead of holding millions of rows.
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  let taken = 0;
  const next = async () => {
    for (;;) {
      if (stopping || (LIMIT && taken >= LIMIT)) return null;
      const { value, done: end } = await it.next();
      if (end) return null;
      const [domain, origin, rank, cc, csrc] = value.split("\t");
      if (!domain || done.has(domain)) continue;
      taken++;
      return { domain, origin, rank: Number(rank), cc, csrc };
    }
  };
  let reading = Promise.resolve();
  const take = () => (reading = reading.then(next));      // one reader at a time

  const t0 = Date.now();
  const record = (c, v, extra = {}) => { lines.push(JSON.stringify({ d: c.domain, v, ...extra })); };
  const keep = (c, platform, how, pay = "", host = "") => {
    pending.push({ domain: c.domain, cc: c.cc, csrc: c.csrc, platform, host, rank: c.rank, pay });
    byPlat.set(platform, (byPlat.get(platform) || 0) + 1);
    if (DRY && pending.length <= 60) console.log(`  ✓ ${c.domain.padEnd(38)} ${platform.padEnd(14)} ${how}  ${c.cc || "-"} (${c.csrc}) rank ${c.rank}`);
  };

  const worker = async (w) => {
    const dns = new Resolver({ timeout: 3000, tries: 2 });
    dns.setServers(w % 2 ? ["1.1.1.1", "8.8.8.8"] : ["8.8.8.8", "1.1.1.1"]);
    for (let c = await take(); c; c = await take()) {
      const host = new URL(c.origin).hostname;
      const [ips, cnames] = await Promise.all([
        dns.resolve4(host).catch((e) => (e.code === "ENOTFOUND" || e.code === "ENODATA" ? [] : null)),
        dns.resolveCname(host).catch(() => []),
      ]);
      st.seen++;
      const hosted = ips ? matchHosted(table, host, cnames, ips) : null;
      if (ips && !ips.length && !cnames.length) { st.dead++; record(c, "dead"); }
      else if (hosted?.kind === "commerce") {
        // A store on that platform, named by DNS alone (the evidence confirm-other-cms looks for).
        st.dnsStore++; keep(c, hosted.name, "dns", "", hosted.name); record(c, "store", { p: hosted.name, how: "dns" });
      } else {
        const r = await fetchText(c.origin + "/", { timeoutMs: 12000, maxBytes: MAX_BYTES, redirects: 3 });
        if (!r) { st.net++; record(c, "unreachable"); }
        else if (r.status === 429) { st.throttled++; }      // not recorded: next run retries it
        else if (r.status >= 400) { st.closed++; record(c, "closed", { s: r.status }); }
        else {
          st.bytes += r.text.length;
          const v = classify(r.text);
          if (v.verdict === "store" || v.verdict === "custom") {
            v.verdict === "custom" ? st.custom++ : st.store++;
            // A builder named by DNS stays the platform's evidence for confirm-other-cms.
            keep(c, v.platform, "http", v.gateways.join("; "), hosted && hosted.name === v.platform ? hosted.name : "");
            record(c, v.verdict, { p: v.platform });
          } else { st.notStore++; record(c, "not_store", hosted ? { p: hosted.name } : {}); }
        }
      }
      if (pending.length >= 100 || lines.length >= 1000) await flush();
      if (st.seen % 2000 === 0) {
        const s = (Date.now() - t0) / 1000;
        console.log(`  ${st.seen.toLocaleString()} · ${(st.seen / s).toFixed(1)}/s · stores: dns ${st.dnsStore} · http ${st.store} · custom ${st.custom} | not_store ${st.notStore} · dead ${st.dead} · closed ${st.closed} · unreachable ${st.net} · 429 ${st.throttled} · written ${st.written} · ${(st.bytes / 1e9).toFixed(2)}GB`);
      }
    }
  };
  console.log(`crux-sweep: ${IN} · ${done.size.toLocaleString()} already done · concurrency ${CONC} · DIRECT · ≤${Math.round(MAX_BYTES / 1024)}KB/page${DRY ? " · DRY" : ""}`);
  try {
    await Promise.all(Array.from({ length: CONC }, (_, w) => worker(w)));
    await flush();
  } finally {
    resOut?.end();
    closeAgents();
    await sql?.end({ timeout: 5 });
  }
  const s = (Date.now() - t0) / 1000;
  console.log(`\n✓ ${stopping ? "Stopped" : "Done"}${DRY ? " (dry, nothing written)" : ""}. ${st.seen.toLocaleString()} sites in ${Math.round(s)}s (${(st.seen / s).toFixed(1)}/s) · stores ${st.dnsStore + st.store + st.custom} (dns ${st.dnsStore}, http ${st.store}, custom ${st.custom}) · not_store ${st.notStore} · dead ${st.dead} · closed ${st.closed} · unreachable ${st.net} · 429 ${st.throttled} · ${st.written} rows inserted`);
  console.log("by platform:", [...byPlat.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}=${n}`).join(", ") || "(none)");
}

(has("--build") ? build() : sweep()).catch((e) => { console.error("crux-sweep failed:", e.message); process.exit(1); });

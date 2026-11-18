/**
 * homepage-email-backfill — one-off: re-read the homepage of every live store in the visible markets
 * that AI enrichment already passed with no email, using the wider extractor (scripts/lib/homepage-emails.mjs).
 *
 * Why: ai-enrich took only the first own-domain address, and made its request directly from Rex, so
 * a blocked or throttled homepage gave nothing. On a 2026-11-18 sample, 16% of these stores had a
 * usable address on the page. New stores pick this up through ai-enrich itself; this script covers
 * the ~60k it already passed.
 *
 * One GET per store through the Webshare fleet (STORE_PROBE_PROXY_FILE), retried once on another
 * proxy after a network miss. Writes ONLY `email`, and only where it is still empty, so it never
 * overwrites a crawled or hand-edited address. contact_type / contact_email are untouched: those
 * are contact-enrich's verdict. Progress is kept in a local done-file, so a restart resumes.
 *
 *   node --env-file=.env.local scripts/homepage-email-backfill.mjs --dry --limit 50
 *   node --env-file=.env.local scripts/homepage-email-backfill.mjs [--concurrency 4] [--pause-ms 750] [--done FILE]
 */
import fs from "node:fs";
import postgres from "postgres";
import { loadProxies, pickProxy, fetchText, closeAgents } from "./lib/proxy-fetch.mjs";
import { homepageEmails } from "./lib/homepage-emails.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const LIMIT = Number(arg("--limit", 0));
const CONC = Number(arg("--concurrency", 4));
const PAUSE_MS = Number(arg("--pause-ms", 750));
const DONE_FILE = arg("--done", "/tmp/homepage-email-backfill.done");
const MARKETS = (arg("--countries", "") || "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW").split(",").map((c) => c.trim().toUpperCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 30,
    connection: { statement_timeout: 60000, lock_timeout: 10000 } });
  const pool = loadProxies();
  const done = new Set(fs.existsSync(DONE_FILE) ? fs.readFileSync(DONE_FILE, "utf8").split("\n").filter(Boolean) : []);
  const doneOut = DRY ? null : fs.createWriteStream(DONE_FILE, { flags: "a" });
  const pending = [];                       // {domain, email} waiting for the batched write
  let doneBuf = [];                         // domains read since the last write — marked done only once it lands
  const st = { seen: 0, own: 0, free: 0, none: 0, closed: 0, net: 0, throttled: 0, written: 0 };
  const flush = async () => {
    if (DRY) return;
    const b = pending.splice(0);
    const d = doneBuf; doneBuf = [];
    if (!b.length) { if (d.length) doneOut.write(d.join("\n") + "\n"); return; }
    const r = await sql`
      UPDATE imported_stores s SET email = v.e
        FROM (SELECT unnest(${b.map((x) => x.domain)}::text[]) d, unnest(${b.map((x) => x.email)}::text[]) e) v
       WHERE s.domain = v.d AND coalesce(s.email, '') = ''`;
    st.written += r.count;
    if (d.length) doneOut.write(d.join("\n") + "\n");
  };
  // A stop (Ctrl-C, kill) writes what's been found before exiting, so nothing read is lost.
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (!stopping) { stopping = true; console.log(`\n${sig}: writing pending results…`); } });
  try {
    const rows = (await sql`
      SELECT s.domain FROM imported_stores s LEFT JOIN store_priority p ON p.domain = s.domain
       WHERE s.published AND upper(s.country) = ANY(${MARKETS})
         AND coalesce(s.live_status, '') NOT IN ('dead', 'migrated') AND s.activity_tier IS DISTINCT FROM 'not_a_store'
         AND s.ai_enriched_at IS NOT NULL
         AND coalesce(s.email, '') = '' AND coalesce(s.contact_email, '') = ''
       ORDER BY p.score DESC NULLS LAST, s.domain`).filter((r) => !done.has(r.domain));
    const work = LIMIT ? rows.slice(0, LIMIT) : rows;
    console.log(`homepage-email-backfill: ${work.length.toLocaleString()} stores (${done.size.toLocaleString()} already done) · concurrency ${CONC} · ${pool.length ? `${pool.length} proxies` : "DIRECT"}${DRY ? " · DRY" : ""}`);

    let i = 0;
    const worker = async () => {
      while (i < work.length && !stopping) {
        const { domain } = work[i++];
        let r = await fetchText(`https://${domain}/`, { proxy: pickProxy(pool), timeoutMs: 15000, maxBytes: 1_500_000 });
        if (!r) { await sleep(PAUSE_MS); r = await fetchText(`https://${domain}/`, { proxy: pickProxy(pool), timeoutMs: 15000, maxBytes: 1_500_000 }); }
        st.seen++;
        if (r?.status === 429) { st.throttled++; await sleep(30000); continue; }   // not marked done: next run retries
        if (!r) st.net++;
        else if (r.status >= 400) st.closed++;
        else {
          const found = homepageEmails(r.text, domain);
          const best = found[0];
          if (!best) st.none++;
          else {
            best.kind === "own" ? st.own++ : st.free++;
            pending.push({ domain, email: best.email });
            if (DRY && st.own + st.free <= 40) console.log(`  ✓ ${domain.padEnd(36)} ${best.email}  (${best.kind}, ${best.how})`);
          }
        }
        doneBuf.push(domain);
        if (pending.length >= 50 || doneBuf.length >= 200) await flush();
        if (st.seen % 500 === 0) console.log(`  ${st.seen}/${work.length}  own ${st.own} · freemail ${st.free} · none ${st.none} · closed ${st.closed} · unreachable ${st.net} · 429 ${st.throttled} · written ${st.written}`);
        await sleep(PAUSE_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, work.length || 1) }, worker));
    await flush();
    const read = st.own + st.free + st.none;
    console.log(`\n✓ Done${DRY ? " (dry, nothing written)" : ""}. ${st.seen} fetched · ${read} read: own-domain ${st.own} · brand-matched freemail ${st.free} · none ${st.none} (${read ? Math.round(((st.own + st.free) / read) * 100) : 0}% hit) · closed ${st.closed} · unreachable ${st.net} · 429 ${st.throttled} · ${st.written} rows written`);
  } finally {
    doneOut?.end();
    closeAgents();
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("homepage-email-backfill failed:", e.message); process.exit(1); });

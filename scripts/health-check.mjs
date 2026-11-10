/**
 * health-check — catches SILENT failures: a probe that runs on schedule but produces nothing
 * (the 2026-09-24 checkout_cache bloat is the archetype — hourly job, logged errors, 0 throughput,
 * unnoticed 20h). "Did it run?" isn't enough; this watches actual DB throughput + known failure
 * modes, writes each verdict to agent_heartbeat (so /ops shows it), and exits non-zero if unhealthy
 * so a wrapper can alert.
 *
 *   node --env-file=.env.local scripts/health-check.mjs
 */
import postgres from "postgres";
import { statSync } from "fs";
import { homedir, hostname } from "os";
import { execFileSync } from "child_process";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
const mins = (d) => (d == null ? null : Math.round((Date.now() - new Date(d).getTime()) / 60000));
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. Throughput recency — the silent-failure catcher. Each probe should have written to its
//    timestamp column recently; if not, it's stalled even if the job "ran".
// One subquery per column so each is a single index probe; written as one max() list it was a
// full-table read every hour. woo_checkout_at has no index, so it rides on query 1b's scan below.
const [t] = await sql`SELECT
  (SELECT max(payments_checked_at) FROM imported_stores) pay, (SELECT max(live_checked_at) FROM imported_stores) live,
  (SELECT max(catalog_checked_at) FROM imported_stores) cat, (SELECT max(created_at) FROM imported_stores) ins`;
// cert-launch heartbeat (task='cert', written every run before it touches crt.sh) — so we can tell
// "the job ran" apart from "the job produced data", which matters for the catalog/launch check below.
const [hb] = await sql`SELECT max(last_run) cert FROM agent_heartbeat WHERE task = 'cert'`.catch(() => [{ cert: null }]);
const rule = (name, ageMin, limitMin) => add(name, ageMin != null && ageMin <= limitMin,
  ageMin == null ? "never" : `last write ${ageMin < 60 ? ageMin + "m" : Math.round(ageMin / 60) + "h"} ago (limit ${Math.round(limitMin / 60)}h)`);
rule("payments-probe", mins(t.pay), 150);      // hourly job → stale past ~2.5h
// woo-checkout moved below as a backlog-gated stallRule (2026-11-06): it runs 2-hourly, and when
// its queue is legitimately empty (e.g. after a full re-probe) "0 writes" is not a stall.
// catalog/launch: pass if the cert-launch JOB RAN (heartbeat) OR catalog data flowed. Its launch-dating
// leans on crt.sh — a flaky external SPOF whose outages aren't actionable and used to page falsely.
// Keyed on the fresher of {heartbeat, catalog write}, so only a genuinely STOPPED job (no heartbeat at
// all, like an unloaded plist) trips it — a crt.sh outage no longer does.
const catAge = [t.cat, hb?.cert].map(mins).filter((m) => m != null);
rule("catalog/launch", catAge.length ? Math.min(...catAge) : null, 60 * 26);
add("liveness", mins(t.live) != null && mins(t.live) <= 60 * 30, mins(t.live) == null ? "never" : `last check ${Math.round(mins(t.live) / 60)}h ago`);
// Discovery health = are NEW rows actually landing? Use created_at, a real insert timestamp.
// NOT discovered_at — that's a DATE (day granularity), so max(discovered_at) always reads 0-24h
// old regardless of whether anything is landing, and never signals a real stall (an earlier
// version of this check used it and was useless). Inserts run continuously (hundreds/hour), so
// 6h with no new row is a genuine landing stall.
add("discovery", mins(t.ins) != null && mins(t.ins) <= 60 * 6,
  mins(t.ins) == null ? "never" : `last store landed ${mins(t.ins) < 60 ? mins(t.ins) + "m" : Math.round(mins(t.ins) / 60) + "h"} ago`);
// 1b. Enrichment + contact lanes (added 2026-11-01). These are the lanes that keep silently
//     stalling (deep-enrich Oct 23–28, contact Oct 25–27). A batch lane that drained its queue
//     legitimately goes quiet, so a bare recency check would cry wolf — gate on BACKLOG: only
//     unhealthy when work is still pending AND nothing has been written within the limit.
const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
const [e] = await sql`SELECT
  max(deep_enriched_at) FILTER (WHERE platform ILIKE 'shopify%') enr_shop,
  max(deep_enriched_at) FILTER (WHERE platform NOT ILIKE 'shopify%' AND platform IS NOT NULL) enr_non,
  max(contact_checked_at) contact, max(woo_checkout_at) woo,
  count(*) FILTER (WHERE ${LIVE} AND platform ILIKE 'shopify%' AND deep_enriched_at IS NULL)::int shop_todo,
  count(*) FILTER (WHERE ${LIVE} AND platform NOT ILIKE 'shopify%' AND platform IS NOT NULL AND deep_enriched_at IS NULL)::int non_todo,
  count(*) FILTER (WHERE ${LIVE} AND contact_checked_at IS NULL AND UPPER(country) <> 'JP')::int contact_todo,
  -- exactly woo-checkout-probe.mjs's selection, so the gate means "stores are waiting"
  count(*) FILTER (WHERE lower(platform) = 'woocommerce' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))
    AND woo_checkout_at IS NULL AND (payments IS NULL OR payments = '' OR payments_source = 'woo_plugin'))::int woo_todo
  FROM imported_stores`;
const stallRule = (name, ageMin, limitMin, todo, minTodo = 1000) =>
  add(name, !(todo > minTodo && (ageMin == null || ageMin > limitMin)),
    `${ageMin == null ? "no writes yet" : `last write ${ageMin < 60 ? ageMin + "m" : Math.round(ageMin / 60) + "h"} ago`} · ${Number(todo).toLocaleString()} queued (limit ${Math.round(limitMin / 60)}h)`);
stallRule("deep-enrich-shopify", mins(e.enr_shop), 60 * 30, e.shop_todo);   // Lucy/Rain, ~daily
stallRule("deep-enrich-nonshop", mins(e.enr_non), 60 * 30, e.non_todo);     // Rex, ~daily
stallRule("contact-enrich", mins(e.contact), 60 * 26, e.contact_todo);      // runs through the day
stallRule("woo-checkout", mins(e.woo), 200, e.woo_todo, 50);               // 2-hourly → stale past ~3.3h

// 1c. CT discovery FRESHNESS (added 2026-11-06). "discovery" above only proves that SOMETHING
//     landed — VPS landings alone satisfy it — so a tailer that fell ~25 days behind and was reading
//     only the 2026 shards (new certs had moved to the 2027 ones) passed this board for a month.
//     ct_lag_check compares each log's HEAD cursor with its live tip, flags a stale state file, and
//     flags any current shard (per the official log list) the tailer isn't reading.
{
  let out = "";
  try {
    out = execFileSync(`${homedir()}/shopify-radar/.venv/bin/python`, ["ct_lag_check.py", "--json"],
      { cwd: `${homedir()}/shopify-radar`, timeout: 120000, encoding: "utf8" });
  } catch (err) {
    out = err.stdout ?? "";                  // exit 1 = unhealthy, the JSON is still on stdout
  }
  try {
    const j = JSON.parse(out.trim().split("\n").pop());
    const lagged = j.logs.filter((l) => l.status !== "OK");
    const maxLag = Math.max(0, ...j.logs.map((l) => l.lag ?? 0));
    const backfill = j.logs.reduce((s, l) => s + (l.backfill_remaining ?? 0), 0);
    add("ct-freshness", j.healthy,
      `${j.logs.length} logs · head lag max ${maxLag.toLocaleString()} · backfill ${backfill.toLocaleString()} to drain`
      + ` · state ${j.state_age_s}s old${lagged.length ? ` · ${lagged.map((l) => `${l.log}=${l.status}`).join(", ")}` : ""}`);
  } catch {
    add("ct-freshness", false, `ct_lag_check gave no readable result: ${out.slice(0, 120) || "no output"}`);
  }
}

// 1d. Woo discovery hand-off (added 2026-11-06). Rex hands Lucy its Woo candidates (via git until
//     today, now the woo_candidates table); when Rex lost its GitHub credentials the push failed
//     silently and Lucy idled on an empty feed for days. discover-more regenerates candidates every 6h, so there is always new
//     work — a long gap with no WordPress host probed means the hand-off (or Lucy) is broken.
{
  const [w] = await sql`SELECT max(checked_at) last FROM probe_checked`.catch(() => [{ last: null }]);
  const age = mins(w?.last);
  add("woo-discovery", age != null && age <= 60 * 36,
    age == null ? "no probes recorded" : `last WordPress host probed ${age < 60 ? age + "m" : Math.round(age / 60) + "h"} ago (limit 36h)`);
}


// 2. Known failure modes — oversized caches read whole into one string (the 512MB crash).
for (const p of ["shopify-radar/checkout_cache.json"]) {
  try { const mb = statSync(`${homedir()}/${p}`).size / 1048576; add(`cache:${p.split("/").pop()}`, mb < 450, `${mb.toFixed(0)}MB (crash at ~512MB)`); }
  catch { add(`cache:${p.split("/").pop()}`, true, "absent (fresh)"); }
}

// 3. Backlog sanity — a huge focus-market payment queue that isn't draining means the probe is stuck.
const FOCUS = ["ZA", "KE", "NG", "JP"];
const [q] = await sql`SELECT COUNT(*) FILTER (WHERE published AND UPPER(country)=ANY(${FOCUS}) AND (lower(platform)='shopify' OR platform IS NULL) AND payments_checked_at IS NULL AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')))::int n FROM imported_stores`;
add("payment-backlog", true, `${Number(q.n).toLocaleString()} focus stores unprobed (informational)`);

// Report + persist each verdict to agent_heartbeat so it surfaces on /ops.
const bad = checks.filter((c) => !c.ok);
for (const c of checks) {
  await sql`INSERT INTO agent_heartbeat (machine, task, last_run, note)
    VALUES ('health-check', ${c.name}, now(), ${(c.ok ? "OK · " : "⚠ ALERT · ") + c.detail})
    ON CONFLICT (machine, task) DO UPDATE SET last_run = now(), note = EXCLUDED.note`.catch(() => {});
}
console.log(`health-check ${new Date().toISOString()}`);
for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(18)} ${c.detail}`);
if (bad.length) console.log(`\n⚠ UNHEALTHY (${bad.length}): ${bad.map((c) => c.name).join(", ")}`);
else console.log("\n✅ all healthy");

// ── Proactive alerting ──────────────────────────────────────────────────────────────────────
// Email the owner the moment state goes unhealthy (and once when it recovers), so a silent stall
// doesn't wait for someone to open /ops. Cooldown state lives in agent_heartbeat task='__alert':
//   note     = signature of what we last alerted on ("clear" once recovered)
//   last_run = when we last actually sent an email  → drives the re-alert cooldown
// We only write that row when we send, so last_run is a true "last email" clock.
const ALERT_TO = process.env.ALERT_EMAIL;                 // set in .env.local (gitignored)
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM ?? "Terrain <onboarding@resend.dev>";
const COOLDOWN_H = 6;                                      // re-nag on the same problem at most this often
const sig = bad.length ? bad.map((c) => c.name).sort().join(",") : "clear";

const [prev] = await sql`SELECT note, last_run FROM agent_heartbeat WHERE machine='health-check' AND task='__alert'`.catch(() => [null]);
const prevSig = prev?.note ?? "clear";
const prevAgeH = prev?.last_run ? (Date.now() - new Date(prev.last_run).getTime()) / 3.6e6 : Infinity;

let fire = null; // "alert" | "recovered"
if (bad.length) {
  if (sig !== prevSig || prevAgeH >= COOLDOWN_H) fire = "alert"; // new/changed problem, or persisted past cooldown
} else if (prevSig !== "clear") {
  fire = "recovered";
}

async function sendResend(subject, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [ALERT_TO], subject, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

if (fire && ALERT_TO && RESEND_KEY) {
  const host = hostname();
  const subject = fire === "recovered"
    ? "✅ Terrain health recovered"
    : `⚠ Terrain health: ${bad.length} check${bad.length > 1 ? "s" : ""} failing`;
  const lines = fire === "recovered"
    ? [`All ${checks.length} health checks are green again.`, "", ...checks.map((c) => `  ✓ ${c.name} — ${c.detail}`)]
    : [
        `${bad.length} of ${checks.length} health checks are failing on ${host}:`,
        "",
        ...bad.map((c) => `  ✗ ${c.name} — ${c.detail}`),
        "",
        "Passing:",
        ...checks.filter((c) => c.ok).map((c) => `  ✓ ${c.name} — ${c.detail}`),
      ];
  const text = [...lines, "", `— health-check · ${new Date().toISOString()}`, "See https://heyterrain.com/ops for live status."].join("\n");
  try {
    await sendResend(subject, text);
    await sql`INSERT INTO agent_heartbeat (machine, task, last_run, note)
      VALUES ('health-check', '__alert', now(), ${fire === "recovered" ? "clear" : sig})
      ON CONFLICT (machine, task) DO UPDATE SET last_run = now(), note = EXCLUDED.note`.catch(() => {});
    console.log(`\n📧 alert email sent to ${ALERT_TO} (${fire})`);
  } catch (e) {
    console.error(`\n!! alert email failed: ${e.message}`);
  }
} else if (fire && !ALERT_TO) {
  console.log(`\n(alert suppressed — set ALERT_EMAIL in .env.local to enable email alerts)`);
}

await sql.end();
process.exit(bad.length ? 1 : 0);

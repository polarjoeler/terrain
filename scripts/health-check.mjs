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

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
const mins = (d) => (d == null ? null : Math.round((Date.now() - new Date(d).getTime()) / 60000));
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. Throughput recency — the silent-failure catcher. Each probe should have written to its
//    timestamp column recently; if not, it's stalled even if the job "ran".
const [t] = await sql`SELECT
  max(payments_checked_at) pay, max(woo_checkout_at) woo, max(live_checked_at) live,
  max(catalog_checked_at) cat, max(discovered_at) disc FROM imported_stores`;
const rule = (name, ageMin, limitMin) => add(name, ageMin != null && ageMin <= limitMin,
  ageMin == null ? "never" : `last write ${ageMin < 60 ? ageMin + "m" : Math.round(ageMin / 60) + "h"} ago (limit ${Math.round(limitMin / 60)}h)`);
rule("payments-probe", mins(t.pay), 150);      // hourly job → stale past ~2.5h
rule("woo-checkout", mins(t.woo), 200);        // 2-hourly → stale past ~3.3h
rule("catalog/launch", mins(t.cat), 60 * 26);  // slower cadence
add("liveness", mins(t.live) != null && mins(t.live) <= 60 * 30, mins(t.live) == null ? "never" : `last check ${Math.round(mins(t.live) / 60)}h ago`);
add("discovery", mins(t.disc) != null && mins(t.disc) <= 60 * 24, mins(t.disc) == null ? "never" : `last ${Math.round(mins(t.disc) / 60)}h ago`);

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

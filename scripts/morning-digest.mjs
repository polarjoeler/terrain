/**
 * morning-digest — a private ops brief emailed to the owner each morning (NOT the public Beehiiv
 * newsletter). Answers "how's the fleet doing?": new stores found (by machine), how many are
 * genuinely new launches, enrichment progress by country + CMS, and migrations / surprising tech
 * movements. Text + numbers, sent via the app's existing Resend setup to DIGEST_EMAIL (falls back
 * to ALERT_EMAIL). Read-only except the email send.
 *
 *   node --env-file=.env.local scripts/morning-digest.mjs [--print]   (--print = don't send, just log)
 */
import postgres from "postgres";
import { hostname } from "os";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
const PRINT_ONLY = process.argv.includes("--print");
const TO = process.env.DIGEST_EMAIL || process.env.ALERT_EMAIL;
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM ?? "Terrain <onboarding@resend.dev>";
const n = (x) => Number(x ?? 0).toLocaleString();

// Which machine owns each discovery source (by launchd job ownership). Best-effort mapping so the
// per-machine split is meaningful; it's job-ownership, not a hardware stamp on each row.
const MACHINE_OF = {
  ct_tail: "Chad", cms_dns: "Chad", discovery: "Chad", crtsh: "Chad", cert: "Chad", seed_discovery: "Chad",
  woo_ct: "Lucy", woo_probe_cms: "Lucy", woo_probe: "Lucy", woo: "Lucy",
};
const machineOf = (src) => MACHINE_OF[src] ?? "Import/other";

// ── Headline counts — one table scan, many FILTER aggregates ─────────────────────────────────
const [h] = await sql`SELECT
  count(*) FILTER (WHERE discovered_at > now()-interval '24 hours')::int disc24,
  count(*) FILTER (WHERE discovered_at > now()-interval '24 hours' AND launched_at > now()-interval '60 days')::int newnew,
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours')::int live24,
  count(*) FILTER (WHERE payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')::int pay24,
  count(*) FILTER (WHERE catalog_checked_at > now()-interval '24 hours')::int cat24,
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours' AND live_status='migrated')::int migrated24,
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours' AND live_status='dead')::int dead24
  FROM imported_stores`;

// ── Discovery by source (24h) — index-backed, fast ──────────────────────────────────────────
const bySrc = await sql`SELECT source, count(*)::int nn FROM imported_stores
  WHERE discovered_at > now()-interval '24 hours' GROUP BY source ORDER BY nn DESC`;
const byMachine = {};
for (const r of bySrc) { const m = machineOf(r.source); byMachine[m] = (byMachine[m] ?? 0) + r.nn; }

// ── Enrichment by country + by CMS (24h) ────────────────────────────────────────────────────
const byCountry = await sql`SELECT upper(country) c,
    count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours')::int live,
    count(*) FILTER (WHERE payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')::int pay
  FROM imported_stores
  WHERE (live_checked_at > now()-interval '24 hours' OR payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')
    AND country IS NOT NULL
  GROUP BY 1 ORDER BY (count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours') + count(*) FILTER (WHERE payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')) DESC LIMIT 8`;
const byCms = await sql`SELECT coalesce(lower(platform),'unknown') p,
    count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours')::int live,
    count(*) FILTER (WHERE payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')::int pay
  FROM imported_stores
  WHERE (live_checked_at > now()-interval '24 hours' OR payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours')
  GROUP BY 1 ORDER BY 2 DESC LIMIT 6`;

// ── Migrations & surprising tech (24h) ──────────────────────────────────────────────────────
const migrations = await sql`SELECT domain, live_platform, country FROM imported_stores
  WHERE live_checked_at > now()-interval '24 hours' AND live_status='migrated' ORDER BY live_checked_at DESC LIMIT 8`;
const switches = await sql`SELECT domain, old_primary, new_primary FROM payment_changes
  WHERE changed_at > now()-interval '24 hours' AND new_primary IS DISTINCT FROM old_primary
  ORDER BY changed_at DESC LIMIT 8`.catch(() => []);
const [switchN] = await sql`SELECT count(*)::int c FROM payment_changes WHERE changed_at > now()-interval '24 hours'`.catch(() => [{ c: 0 }]);

// ── Fleet activity by machine (real heartbeats, last 24h) ───────────────────────────────────
const fleet = await sql`SELECT machine, array_agg(task ORDER BY last_run DESC) tasks, max(last_run) recent
  FROM agent_heartbeat WHERE last_run > now()-interval '24 hours' AND machine <> 'health-check'
  GROUP BY machine ORDER BY recent DESC`;
const label = (m) => m === 'macbook-pro-7' ? 'Chad (Mac)' : m === 'peter-johns-macbook-pro-2' ? 'Lucy (Mac)' : m;

// ── Compose ─────────────────────────────────────────────────────────────────────────────────
const now = new Date();
const dateStr = now.toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Johannesburg' });
const timeStr = now.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });

const L = [];
L.push(`TERRAIN — MORNING DIGEST`);
L.push(`${dateStr} · ${timeStr} SAST · last 24 hours`);
L.push(``);
L.push(`── DISCOVERY ──`);
L.push(`${n(h.disc24)} new stores found · ${n(h.newnew)} genuinely new (launched in the last 60 days)`);
L.push(`By machine: ${Object.entries(byMachine).map(([m, v]) => `${m} ${n(v)}`).join(' · ') || '—'}`);
L.push(`By source:  ${bySrc.slice(0, 6).map((r) => `${r.source ?? '?'} ${n(r.nn)}`).join(' · ') || '—'}`);
L.push(``);
L.push(`── ENRICHMENT (24h) ──`);
L.push(`Liveness ${n(h.live24)} · Payments ${n(h.pay24)} · Catalog/launch ${n(h.cat24)}`);
L.push(`Top countries:`);
for (const r of byCountry) L.push(`   ${r.c.padEnd(4)} liveness ${n(r.live)}, payments ${n(r.pay)}`);
L.push(`By CMS:`);
for (const r of byCms) L.push(`   ${r.p.padEnd(12)} liveness ${n(r.live)}, payments ${n(r.pay)}`);
L.push(``);
L.push(`── MIGRATIONS & TECH ──`);
L.push(`${n(h.migrated24)} migrated off-platform · ${n(h.dead24)} found dead · ${n(switchN.c)} payment-provider changes`);
if (migrations.length) { L.push(`Recent migrations:`); for (const m of migrations) L.push(`   ${m.domain} → ${m.live_platform ?? 'elsewhere'}${m.country ? ` (${m.country})` : ''}`); }
if (switches.length) { L.push(`Gateway switches:`); for (const s of switches) L.push(`   ${s.domain}: ${s.old_primary ?? '—'} → ${s.new_primary ?? '—'}`); }
L.push(``);
L.push(`── FLEET (by machine, last 24h) ──`);
for (const f of fleet) L.push(`   ${label(f.machine)}: ${f.tasks.slice(0, 8).join(', ')}`);
if (!fleet.some((f) => /vps/i.test(f.machine))) L.push(`   VPS: no heartbeat in 24h — not reporting (add a heartbeat to attribute its work)`);
L.push(``);
L.push(`Machine split is by job ownership (which box runs each source), not a per-row stamp.`);
const text = L.join('\n');

const html = `<div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55;color:#0f2b2a;max-width:680px;white-space:pre-wrap">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`;

console.log(text);

if (PRINT_ONLY) { console.log('\n(--print: not sent)'); await sql.end(); process.exit(0); }
if (!TO || !KEY) { console.error('\n!! DIGEST_EMAIL/ALERT_EMAIL or RESEND_API_KEY missing — not sent'); await sql.end(); process.exit(1); }
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: [TO], subject: `Terrain digest · ${dateStr} · +${n(h.disc24)} stores`, text, html }),
});
console.log(res.ok ? `\n📧 sent to ${TO}` : `\n!! send failed ${res.status}: ${await res.text()}`);
await sql.end();
process.exit(res.ok ? 0 : 1);

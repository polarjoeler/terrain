/**
 * morning-digest — a private ops brief emailed to the owner each morning (NOT the public Beehiiv
 * newsletter). Rebuilt to answer the three questions that actually matter day to day:
 *
 *   1. DISCOVERY — how many stores we found, how many are genuinely NEW (just launched) vs LEGACY
 *      (old stores we only just discovered), and how many of this week's finds we've already scanned.
 *   2. COVERAGE — per market, are we getting MORE data on stores over time? (payments / tech coverage,
 *      with the change since last week — progress, not just a snapshot.)
 *   3. PIPELINE — how liveness / migrations / payment movement are tracking, vs yesterday & last week.
 *
 * Every number carries a vs-yesterday (flows) or vs-last-week (coverage) delta, read from a daily
 * `digest_snapshot` row this script writes each run. Read-only except the snapshot write + the email.
 *
 *   node --env-file=.env.local scripts/morning-digest.mjs [--print]   (--print = don't send, just log)
 */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 3 });
const PRINT_ONLY = process.argv.includes("--print");
const TO = process.env.DIGEST_EMAIL || process.env.ALERT_EMAIL;
const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM ?? "Terrain <onboarding@resend.dev>";
const n = (x) => Number(x ?? 0).toLocaleString();
const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
const pctS = (a, b) => (b > 0 ? Math.round((100 * a) / b) + "%" : "—");
// Flow delta vs yesterday (an absolute count): ▲+/▼−/±0.
const d = (now, then) => {
  if (then == null) return "";
  const x = now - then;
  return x > 0 ? `  ▲+${n(x)}` : x < 0 ? `  ▼−${n(Math.abs(x))}` : "  ±0";
};
// Coverage delta in percentage points vs last week.
const ppDelta = (nowA, nowB, snap, key) => {
  if (!snap || snap[key] == null || snap[key + "_base"] == null || snap[key + "_base"] === 0) return "";
  const then = pct(snap[key], snap[key + "_base"]);
  const now = pct(nowA, nowB);
  const x = now - then;
  if (Math.abs(x) < 0.05) return "  (flat vs last wk)";
  return x > 0 ? `  (▲+${x.toFixed(1)}pp vs last wk)` : `  (▼−${Math.abs(x).toFixed(1)}pp vs last wk)`;
};

const FOCUS_MARKETS = "AO,BW,CI,CM,DZ,EG,ET,GH,KE,LS,LY,MA,MU,MW,MZ,NA,NG,RW,SN,SO,SZ,TN,TZ,UG,ZA,ZM,ZW,JP".split(",");

// Snapshot store so every run can diff against yesterday + ~a week ago. Tiny (one row/day).
await sql`CREATE TABLE IF NOT EXISTS digest_snapshot (day date PRIMARY KEY, metrics jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`.catch(() => {});
const [yday] = await sql`SELECT metrics FROM digest_snapshot WHERE day < current_date ORDER BY day DESC LIMIT 1`.catch(() => []);
const [wago] = await sql`SELECT metrics FROM digest_snapshot WHERE day <= current_date - 6 ORDER BY day DESC LIMIT 1`.catch(() => []);
const Y = yday?.metrics ?? null; // nearest prior day (deltas for flows)
const W = wago?.metrics ?? null; // ~a week ago (deltas for coverage trends)

// ── 1. DISCOVERY — found, new vs legacy, and how much we've scanned ──────────────────────────
const [disc] = await sql`SELECT
  count(*) FILTER (WHERE discovered_at > now()-interval '24 hours')::int d24,
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days')::int d7,
  -- launch recency of this week's finds (truly new vs recent vs legacy/unknown)
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND launched_at > now()-interval '7 days')::int new7,
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND launched_at > now()-interval '90 days' AND launched_at <= now()-interval '7 days')::int recent7,
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND (launched_at IS NULL OR launched_at <= now()-interval '90 days'))::int legacy7,
  -- of this week's finds, how many have had each scan at least once
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND live_checked_at IS NOT NULL)::int sc_live,
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND (payments_checked_at IS NOT NULL OR woo_checkout_at IS NOT NULL))::int sc_pay,
  count(*) FILTER (WHERE discovered_at > now()-interval '7 days' AND catalog_checked_at IS NOT NULL)::int sc_cat
  FROM imported_stores`;

// ── 2. COVERAGE by market — the live base and how much of it carries data ────────────────────
const cov = await sql`SELECT upper(country) c,
    count(*)::int live,
    count(*) FILTER (WHERE discovered_at > now()-interval '7 days')::int new7,
    count(*) FILTER (WHERE payments IS NOT NULL AND payments <> '')::int pay,
    count(*) FILTER (WHERE theme IS NOT NULL OR deep_enriched_at IS NOT NULL)::int tech,
    count(*) FILTER (WHERE live_checked_at IS NOT NULL)::int live_seen
  FROM imported_stores
  WHERE published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated')) AND upper(country) = ANY(${FOCUS_MARKETS})
  GROUP BY 1 HAVING count(*) >= 50 ORDER BY live DESC LIMIT 10`.catch(() => []);
// Overall coverage across the focus markets (one headline progress number).
const tot = cov.reduce((a, r) => ({ live: a.live + r.live, pay: a.pay + r.pay, tech: a.tech + r.tech, new7: a.new7 + r.new7 }), { live: 0, pay: 0, tech: 0, new7: 0 });

// ── 3. PIPELINE — liveness / migrations / payments, with vs-yesterday ────────────────────────
const [pipe] = await sql`SELECT
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours')::int live24,
  count(*) FILTER (WHERE live_checked_at > now()-interval '7 days')::int live7,
  count(*) FILTER (WHERE (payments_checked_at > now()-interval '24 hours' OR woo_checkout_at > now()-interval '24 hours'))::int pay24,
  count(*) FILTER (WHERE (payments_checked_at > now()-interval '7 days' OR woo_checkout_at > now()-interval '7 days'))::int pay7,
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours' AND live_status='migrated')::int mig24,
  count(*) FILTER (WHERE live_checked_at > now()-interval '7 days' AND live_status='migrated')::int mig7,
  count(*) FILTER (WHERE live_checked_at > now()-interval '24 hours' AND live_status='dead')::int dead24,
  count(*) FILTER (WHERE live_checked_at > now()-interval '7 days' AND live_status='dead')::int dead7
  FROM imported_stores`;
const [sw] = await sql`SELECT
  count(*) FILTER (WHERE changed_at > now()-interval '24 hours')::int s24,
  count(*) FILTER (WHERE changed_at > now()-interval '7 days')::int s7
  FROM payment_changes`.catch(() => [{ s24: 0, s7: 0 }]);
const migs = await sql`SELECT domain, live_platform, upper(country) c FROM imported_stores
  WHERE live_checked_at > now()-interval '24 hours' AND live_status='migrated' ORDER BY live_checked_at DESC LIMIT 6`.catch(() => []);

// ── Build the snapshot we'll store for tomorrow's deltas ─────────────────────────────────────
const snap = {
  d24: disc.d24, d7: disc.d7, new7: disc.new7, recent7: disc.recent7, legacy7: disc.legacy7,
  sc_live: disc.sc_live, sc_pay: disc.sc_pay, sc_cat: disc.sc_cat,
  live24: pipe.live24, pay24: pipe.pay24, mig24: pipe.mig24, dead24: pipe.dead24, sw24: sw.s24,
  // coverage (raw counts + base, so % deltas are exact)
  cov_pay: tot.pay, cov_pay_base: tot.live, cov_tech: tot.tech, cov_tech_base: tot.live,
  markets: Object.fromEntries(cov.map((r) => [r.c, { pay: r.pay, pay_base: r.live, tech: r.tech, tech_base: r.live }])),
};

// ── Compose ──────────────────────────────────────────────────────────────────────────────────
const now = new Date();
const dateStr = now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Johannesburg" });
const timeStr = now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });

const L = [];
L.push(`TERRAIN — MORNING DIGEST`);
L.push(`${dateStr} · ${timeStr} SAST`);
L.push(Y ? `(▲/▼ = change vs yesterday; coverage = change vs last week)` : `(baseline run — day-to-day deltas start from tomorrow)`);
L.push(``);

// 1 · DISCOVERY
L.push(`━━ 1 · WHAT WE FOUND ━━`);
L.push(`Found: ${n(disc.d24)} in the last 24h${d(disc.d24, Y?.d24)}   ·   ${n(disc.d7)} this week`);
const liveLaunch = disc.new7 + disc.recent7;
L.push(`This week's ${n(disc.d7)} finds break down as:`);
L.push(`   • ${n(disc.new7)} genuinely NEW   — launched in the last 7 days`);
L.push(`   • ${n(disc.recent7)} recent        — launched 8–90 days ago`);
L.push(`   • ${n(disc.legacy7)} legacy        — older, or launch date unknown (backfill, not new market activity)`);
L.push(`Scanned so far (of this week's ${n(disc.d7)} finds):`);
L.push(`   liveness ${pctS(disc.sc_live, disc.d7)} (${n(disc.sc_live)})  ·  payments ${pctS(disc.sc_pay, disc.d7)} (${n(disc.sc_pay)})  ·  catalog ${pctS(disc.sc_cat, disc.d7)} (${n(disc.sc_cat)})`);
L.push(`   awaiting first liveness scan: ${n(Math.max(0, disc.d7 - disc.sc_live))}`);
L.push(``);

// 2 · COVERAGE PROGRESS
L.push(`━━ 2 · ARE WE FILLING IN THE DATA? (focus markets) ━━`);
L.push(`Overall live base ${n(tot.live)} (+${n(tot.new7)} this week).`);
L.push(`   payments coverage ${pctS(tot.pay, tot.live)}${ppDelta(tot.pay, tot.live, W, "cov_pay")}`);
L.push(`   tech coverage     ${pctS(tot.tech, tot.live)}${ppDelta(tot.tech, tot.live, W, "cov_tech")}`);
L.push(`By market  (live · +new/wk · payments% · tech%):`);
for (const r of cov) {
  const mW = W?.markets?.[r.c];
  const payDelta = mW ? ppDelta(r.pay, r.live, { m: mW.pay, m_base: mW.pay_base }, "m").replace(" vs last wk", "") : "";
  L.push(`   ${r.c.padEnd(4)} ${n(r.live).padStart(8)} · +${String(r.new7).padStart(4)}/wk · pay ${pctS(r.pay, r.live).padStart(4)}${payDelta} · tech ${pctS(r.tech, r.live).padStart(4)}`);
}
L.push(``);

// 3 · PIPELINE
L.push(`━━ 3 · PIPELINE — LIVENESS / MIGRATIONS / PAYMENTS ━━`);
L.push(`Liveness checks:   ${n(pipe.live24)} in 24h${d(pipe.live24, Y?.live24)}   ·   ${n(pipe.live7)} this week`);
L.push(`Payment checks:    ${n(pipe.pay24)} in 24h${d(pipe.pay24, Y?.pay24)}   ·   ${n(pipe.pay7)} this week`);
L.push(`Migrations found:  ${n(pipe.mig24)} in 24h${d(pipe.mig24, Y?.mig24)}   ·   ${n(pipe.mig7)} this week`);
L.push(`Gone dead:         ${n(pipe.dead24)} in 24h${d(pipe.dead24, Y?.dead24)}   ·   ${n(pipe.dead7)} this week`);
L.push(`Gateway changes:   ${n(sw.s24)} in 24h${d(sw.s24, Y?.sw24)}   ·   ${n(sw.s7)} this week`);
if (migs.length) { L.push(`Recent migrations:`); for (const m of migs) L.push(`   ${m.domain} → ${m.live_platform ?? "elsewhere"}${m.c ? ` (${m.c})` : ""}`); }
L.push(``);
L.push(`Coverage % = share of the live store base we hold that signal for. "Legacy" finds are backfill`);
L.push(`(old stores newly discovered), not new market activity — watch the NEW line for real momentum.`);

const text = L.join("\n");
const html = `<div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55;color:#0f2b2a;max-width:720px;white-space:pre-wrap">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`;
console.log(text);

// Persist today's snapshot (best-effort — never block the send on it).
await sql`INSERT INTO digest_snapshot (day, metrics) VALUES (current_date, ${sql.json(snap)})
  ON CONFLICT (day) DO UPDATE SET metrics = EXCLUDED.metrics, created_at = now()`.catch((e) => console.error("(snapshot write failed:", e.message, ")"));

if (PRINT_ONLY) { console.log("\n(--print: not sent)"); await sql.end(); process.exit(0); }
if (!TO || !KEY) { console.error("\n!! DIGEST_EMAIL/ALERT_EMAIL or RESEND_API_KEY missing — not sent"); await sql.end(); process.exit(1); }
const subj = `Terrain · ${dateStr} · +${n(disc.d24)} found (${n(disc.new7)} new/wk) · pay ${pctS(tot.pay, tot.live)}`;
const res = await fetch("https://api.resend.com/emails", {
  method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ from: FROM, to: [TO], subject: subj, text, html }),
});
console.log(res.ok ? `\n📧 sent to ${TO}` : `\n!! send failed ${res.status}: ${await res.text()}`);
await sql.end();
process.exit(res.ok ? 0 : 1);

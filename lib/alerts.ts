/** Market-event alerts — the low-latency half of the product, as distinct from the weekly digest.
 *
 *  A digest is a list you read on Monday. An alert is "a store you could have sold to just left
 *  Shopify", in the hour we see it. That latency is the whole value, it's what the homepage
 *  promises ("New-store and switch alerts in your channel"), and it's the one thing a scraper
 *  competitor can't copy from a monthly dump. So alerts are deliberately NOT metered as exports:
 *  an event is a notification about a store, not a bulk handover of contact data.
 *
 *  Source: churn_log, which is the right table for this and not an accident of convenience —
 *  `status`/`migrated_to` carry the from→to, `churned_at` is when WE detected it (what an alert
 *  feed needs), and `historic` exists precisely to keep a backlog sweep from dumping old die-off
 *  into "this week". The platform a store LEFT is not in churn_log, so it's joined back from
 *  imported_stores, whose row survives churn with live_status set (verified: 6,784/6,784 recent
 *  churn rows still present, platform known on 6,752).
 *
 *  Scoped to the ORG, matching how lib/onboarding scopes slack and crm, and how connections are
 *  keyed in lib/integrations.
 *
 *  One accepted trade-off: ordering by revenue NULLS LAST means a churned store with no estimate
 *  waits behind every store that has one. For a 25-slot channel post that is the right call — but
 *  it does mean the alert feed is not a complete record of churn, and the digest and the Insights
 *  churn track remain the place to see all of it.
 */

import { db as sharedDb } from "./db";
import { inFocus, type Focus, type Matchable } from "./focus";

function db() {
  return sharedDb();
}

/** Once per process, not per request — the DDL takes ACCESS EXCLUSIVE (see lib/tags.ts). */
let _ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  return (_ensured ??= db()`CREATE TABLE IF NOT EXISTS alert_log (
    org TEXT NOT NULL, event_key TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org, event_key))`
    .then(() => {})
    .catch((e) => { _ensured = null; throw e; }));
}

export type AlertKind = "switch" | "died";

export type AlertEvent = {
  kind: AlertKind;
  domain: string;
  name: string | null;
  country: string | null;
  category: string | null;
  estMonthlySales: number | null;
  /** The platform it was on while we tracked it — the one a customer's focus is about. */
  leftPlatform: string | null;
  /** Where it went. Only set for a switch. */
  movedTo: string | null;
  detectedAt: Date;
};

/** Stable across runs and independent of row ids, so a re-detection of the same event on the same
 *  day can't double-send and a churn_log rewrite can't resurrect an already-sent alert. */
export const eventKey = (e: AlertEvent): string =>
  `${e.kind}:${e.domain}:${e.detectedAt.toISOString().slice(0, 10)}`;

/** How far back a run will look. A bound, not the selector — alert_log is what prevents repeats.
 *  It matters when detection has been down: churn_log went quiet 2026-10-26, so whenever that lane
 *  resumes it may land a large backlog at once, and without a window every connected channel would
 *  get thousands of weeks-old events in one message. */
export const DEFAULT_WINDOW_DAYS = 14;
/** Per-run, per-org ceiling. A Slack post is a notification, not a report. */
export const MAX_PER_RUN = 25;

/** Candidate events in the window, newest and most valuable first. Not yet focus-filtered or
 *  deduped — both happen in TS, because focus matching is shared with the Overview and the digest
 *  (lib/focus) and must not be reimplemented in SQL where it would drift. */
export async function recentEvents(opts: { windowDays?: number; limit?: number } = {}): Promise<AlertEvent[]> {
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = opts.limit ?? 500;
  const rows = await db()<{
    domain: string; name: string | null; status: string; migrated_to: string | null;
    country: string | null; category: string | null; est: string | null;
    left_platform: string | null; churned_at: Date;
  }[]>`
    SELECT c.domain, c.name, c.status, c.migrated_to, c.country, c.category,
           c.estimated_monthly_sales AS est, i.platform AS left_platform, c.churned_at
      FROM churn_log c
      LEFT JOIN imported_stores i ON i.domain = c.domain
     WHERE NOT c.historic
       AND c.status IN ('dead','migrated')
       AND c.churned_at > now() - (${days} || ' days')::interval
       -- A store on a bare *.myshopify.com has never had a custom domain: overwhelmingly an
       -- abandoned trial or a dev store, and alerting on one is pure noise. Measured on the
       -- Oct window, these were a third of the top 25 by recency (d4b6f0.myshopify.com,
       -- monoxnosi.myshopify.com, …). The digest can still count them; a channel post can't
       -- afford them.
       AND c.domain NOT LIKE '%.myshopify.com'
     -- VALUE first, recency second — the opposite of the digest. With churned_at effectively
     -- day-granular, ordering by it put a dead R12/mo store above a R146k one simply because it
     -- was detected a day later, and the per-run cap then spent all 25 slots on the floor of the
     -- market. An alert is worth reading only if the biggest thing is at the top.
     ORDER BY c.estimated_monthly_sales DESC NULLS LAST, c.churned_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    kind: r.status === "migrated" ? "switch" : "died",
    domain: r.domain,
    name: r.name,
    country: r.country,
    category: r.category,
    estMonthlySales: r.est == null ? null : Number(r.est),
    leftPlatform: r.left_platform,
    movedTo: r.migrated_to,
    detectedAt: new Date(r.churned_at),
  }));
}

/** The focus view of an event is the store AS WE TRACKED IT — so a Shopify-focused customer hears
 *  about a Shopify store leaving, which is the whole point. Matching on where it moved TO would
 *  silently drop exactly the alerts they care about most. */
const matchable = (e: AlertEvent): Matchable => ({
  platform: e.leftPlatform,
  country: e.country,
  category: e.category,
  estMonthlySales: e.estMonthlySales,
  productCount: null,
});

/** Which of these events this org hasn't been told about yet, within its focus. */
export async function unsentFor(org: string, focus: Focus, events: AlertEvent[]): Promise<AlertEvent[]> {
  const inScope = events.filter((e) => inFocus(matchable(e), focus));
  if (!inScope.length) return [];
  await ensure();
  const keys = inScope.map(eventKey);
  const sent = await db()<{ event_key: string }[]>`
    SELECT event_key FROM alert_log WHERE org = ${org} AND event_key = ANY(${db().array(keys)})`;
  const seen = new Set(sent.map((r) => r.event_key));
  return inScope.filter((e) => !seen.has(eventKey(e)));
}

/** Record delivery. Called only after the channel accepted the message, so a failed post is
 *  retried on the next run rather than silently swallowed. */
export async function markSent(org: string, events: AlertEvent[]): Promise<void> {
  if (!events.length) return;
  await ensure();
  const keys = [...new Set(events.map(eventKey))];
  await db()`
    INSERT INTO alert_log (org, event_key)
    SELECT ${org}, k FROM unnest(${db().array(keys)}::text[]) AS k
    ON CONFLICT (org, event_key) DO NOTHING`;
}

/* ---- rendering ------------------------------------------------------------ */

const site = (d: string) => d.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Revenue in the compact form the digest uses. Estimates, so never more than one decimal. */
function money(v: number | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "";
  if (v >= 1_000_000) return `~R${(v / 1_000_000).toFixed(1)}m/mo`;
  if (v >= 1_000) return `~R${Math.round(v / 1_000)}k/mo`;
  return `~R${Math.round(v)}/mo`;
}

function line(e: AlertEvent): string {
  const d = site(e.domain);
  const label = e.name?.trim() || d;
  const move = e.kind === "switch"
    ? `${e.leftPlatform ?? "?"} → ${e.movedTo ?? "unknown"}`
    : `was on ${e.leftPlatform ?? "?"}`;
  const bits = [move, e.country, money(e.estMonthlySales)].filter(Boolean);
  return `• *<https://${d}|${label}>* — ${bits.join(" · ")}`;
}

/** Slack Block Kit. Sections, not one `text:` blob — a 25-line bullet list in a plain message
 *  renders as an unreadable wall, and blocks also degrade gracefully in the notification preview. */
export function slackMessage(events: AlertEvent[], opts: { siteUrl?: string; truncatedFrom?: number } = {}) {
  const switches = events.filter((e) => e.kind === "switch");
  const deaths = events.filter((e) => e.kind === "died");
  const parts: string[] = [];
  if (switches.length) parts.push(`${switches.length} platform switch${switches.length === 1 ? "" : "es"}`);
  if (deaths.length) parts.push(`${deaths.length} store${deaths.length === 1 ? "" : "s"} gone`);
  const headline = `:satellite_antenna: ${parts.join(" · ")} in your focus`;

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: parts.join(" · ") || "No changes", emoji: true } },
  ];
  for (const [title, group] of [["Switched platform", switches], ["No longer trading", deaths]] as const) {
    if (!group.length) continue;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${title}*\n${group.map(line).join("\n")}` } });
  }
  if (opts.truncatedFrom && opts.truncatedFrom > events.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${opts.truncatedFrom - events.length} more in this window.` }],
    });
  }
  if (opts.siteUrl) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${opts.siteUrl}/insights|Open Terrain> · you're seeing this because Slack is connected to your workspace.` }],
    });
  }
  // `text` is the notification/fallback string — Slack shows it on mobile and in the sidebar.
  return { text: headline, blocks };
}

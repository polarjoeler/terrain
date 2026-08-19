/** The weekly digest email — a polished, leads-first "market reader".
 *
 * Produces subject + HTML + text. HTML uses table layout + inline styles for
 * email-client compatibility. Leads are the star; a market-pulse line and a
 * "movers" nugget add actionable context without turning it into a newsletter.
 */

import type { Lead } from "./leads";
import type { InsightSnapshot } from "./sheets";
import { isNewLaunch, marketOf, priorityScore } from "./prioritize";

const C = {
  ink: "#0f2b2a",
  inkDeep: "#0a1f1e",
  cream: "#faf6ec",
  paper: "#ffffff",
  orange: "#e8622c",
  mint: "#cdeaa9",
  lilac: "#cabdf5",
  muted: "#6b7f7e",
};

function money(l: Lead): string {
  if (l.priceMin == null) return "";
  const sym = l.currency && l.currency !== "ZAR" ? l.currency + " " : "R";
  return `${sym}${l.priceMin}–${l.priceMax}`;
}

/** One-line reason this lead is worth attention. */
function whyItMatters(l: Lead): string {
  const bits: string[] = [];
  if (l.plus) bits.push("Shopify Plus — an enterprise merchant");
  if (isNewLaunch(l)) bits.push("just launched — reach them before anyone else");
  if ((l.productCount ?? 0) >= 100) bits.push("established catalogue");
  if (l.email) bits.push("direct contact on file");
  if (l.payments?.length) bits.push(`running ${l.payments.slice(0, 2).join(" + ")}`);
  return bits.slice(0, 2).join(" · ") || "new store worth a look";
}

function badge(text: string, bg: string, color = C.ink): string {
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:6px;">${text}</span>`;
}

function leadCard(l: Lead, siteUrl: string): string {
  const badges =
    (l.plus ? badge("PLUS", C.lilac) : "") +
    (isNewLaunch(l) ? badge("NEW", C.mint) : "");
  const stats = [
    l.productCount != null ? `${l.productCount} products` : "",
    money(l),
    marketOf(l),
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const mailto = l.email
    ? `<a href="mailto:${l.email}" style="color:${C.orange};text-decoration:none;font-weight:600;">${l.email}</a>`
    : `<span style="color:${C.muted};">no email found</span>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e2d4;border-radius:16px;margin-bottom:12px;">
    <tr><td style="padding:18px 20px;">
      <div style="font-size:16px;font-weight:700;color:${C.ink};">${l.name}${badges}</div>
      <a href="https://${l.domain}" style="color:${C.muted};text-decoration:none;font-size:13px;">${l.domain}</a>
      <div style="font-size:13px;color:${C.muted};margin-top:8px;">${stats}</div>
      <div style="font-size:13px;color:${C.ink};margin-top:8px;">➜ ${whyItMatters(l)}</div>
      <div style="font-size:13px;margin-top:8px;">${mailto}</div>
    </td></tr>
  </table>`;
}

export function buildDigest(opts: {
  leads: Lead[];
  insights: InsightSnapshot | null;
  siteUrl: string;
}): { subject: string; html: string; text: string } {
  const { insights, siteUrl } = opts;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  // "New this week" = entered Terrain in the last 7 days (addedAt/created_at).
  // firstSeen is the store's historical launch date, so it can't answer this.
  const fresh = opts.leads.filter((l) => (l.addedAt ?? l.firstSeen ?? "") >= weekAgo);
  // When nothing is genuinely new this week, fall back to the whole feed so the
  // email isn't empty — but drop the "new" framing (isFresh) so we never claim
  // thousands of stores are "new" when they aren't.
  const isFresh = fresh.length > 0;
  const pool = isFresh ? fresh : opts.leads;
  const ranked = [...pool].sort((a, b) => priorityScore(b) - priorityScore(a));
  const picks = ranked.slice(0, 3);
  const withEmail = pool.filter((l) => l.email).length;

  const dateLabel = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

  // Actionable pulse line.
  const topFirst = insights?.first_at_checkout?.[0];
  const pulse = [
    isFresh ? `${pool.length} new stores` : `${pool.length} stores tracked`,
    `${Math.round((100 * withEmail) / Math.max(pool.length, 1))}% with contact emails`,
    topFirst ? `${topFirst.label} leads checkout (${topFirst.pct}%)` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  // A "market movers" nugget from insights.
  const mover =
    insights?.themes?.[0] && insights?.apps?.[0]
      ? `Top theme this week: <b>${insights.themes[0].label}</b>. Most-installed app: <b>${insights.apps[0].label}</b>.`
      : "";

  const subject = isFresh
    ? `Terrain — ${pool.length} new African stores this week`
    : `Terrain — your African commerce brief`;

  const html = `<!-- digest -->
<div style="background:${C.cream};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
    <tr><td style="background:${C.inkDeep};border-radius:20px 20px 0 0;padding:26px 28px;">
      <div style="color:${C.cream};font-size:20px;font-weight:700;">▲ Terrain</div>
      <div style="color:#9db3b1;font-size:13px;margin-top:2px;">Your weekly African commerce brief · ${dateLabel}</div>
    </td></tr>

    <tr><td style="background:${C.orange};padding:16px 28px;color:${C.inkDeep};font-size:14px;font-weight:600;">
      ${pulse}
    </td></tr>

    <tr><td style="background:${C.paper};padding:26px 28px 8px;">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};margin-bottom:14px;">
        3 stores worth your attention
      </div>
      ${picks.map((l) => leadCard(l, siteUrl)).join("")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 0 4px;">
        <a href="${siteUrl}/dashboard" style="display:inline-block;background:${C.ink};color:${C.cream};text-decoration:none;font-weight:600;font-size:14px;padding:12px 26px;border-radius:999px;">
          View all ${pool.length} ${isFresh ? "new " : ""}stores →
        </a>
      </td></tr></table>
    </td></tr>

    ${mover ? `<tr><td style="background:${C.paper};padding:8px 28px 24px;">
      <table role="presentation" width="100%" style="border-top:1px solid #ece6d8;"><tr><td style="padding-top:16px;font-size:13px;color:${C.muted};">
        <span style="color:${C.ink};font-weight:700;">Market movers &nbsp;</span> ${mover}
      </td></tr></table>
    </td></tr>` : ""}

    <tr><td style="background:${C.paper};border-radius:0 0 20px 20px;padding:20px 28px;border-top:1px solid #ece6d8;">
      <div style="font-size:12px;color:${C.muted};">
        Terrain · part of the Tembo Commerce family · Built in Cape Town.<br>
        <a href="${siteUrl}/dashboard" style="color:${C.muted};">Manage your feed</a>
      </div>
    </td></tr>
  </table>
</div>`;

  const text =
    `Terrain — ${dateLabel}\n\n${pulse.replace(/&nbsp;·&nbsp;/g, " · ")}\n\n` +
    `3 stores worth your attention:\n` +
    picks.map((l) => `• ${l.name} (${l.domain}) — ${whyItMatters(l)}${l.email ? ` — ${l.email}` : ""}`).join("\n") +
    `\n\nView all ${pool.length}: ${siteUrl}/dashboard\n`;

  return { subject, html, text };
}

/** The PROVIDER weekly digest — the paid product's revenue engine.
 *
 *  A payment company (Paystack, PayFast, Peach, Yoco…) that subscribes to the Team/Pro tier gets a
 *  weekly actionable brief about THEIR gateway across THEIR markets — not a generic market newsletter:
 *
 *    • Market pulse   — how many live stores run them at checkout + their share of verified checkouts.
 *    • Poaching list  — the headline: live stores in their markets with a verified checkout that do NOT
 *                       use them yet, newest/biggest first, with the rival they run + a contact email.
 *                       ("100 stores with no provider" — the money shot.)
 *    • Won / lost     — stores that ADDED them vs DROPPED them in the last 7 days (real switches).
 *    • Competition    — the rival PSPs they sit alongside most, so they know who they're up against.
 *
 *  Everything is derived from the same probe-verified `imported_stores.payments` the provider pages use,
 *  scoped to the org's `markets[]`. Queries are bounded (the poaching/rival parses cap their row counts)
 *  because this runs in the weekly send cron, not on a page. See lib/digest.ts for the leads digest and
 *  lib/provider-insights.ts for the per-provider page model this complements.
 */
import { db as sharedDb } from "./db";
import { realPaymentsClause, platformClause, type PlatformSel } from "./insights";
import { canonicalProvider, providerVariants, cleanPayments, classify } from "./payments-taxonomy";

function db() {
  return sharedDb();
}

export type DigestTarget = {
  domain: string; name: string | null; country: string | null;
  rivals: string[]; email: string | null; revenueUsd: number | null;
};
export type DigestSwitch = { domain: string; country: string | null; date: string };
export type ProviderDigestData = {
  provider: string;
  markets: string[];
  platform: string;
  generatedAt: string;
  pulse: { atCheckout: number; verifiedBase: number; sharePct: number };
  targets: DigestTarget[];        // live stores with a verified checkout NOT using the provider (poach)
  targetsTotal: number;           // how many such stores exist in total (the list is the top slice)
  won: DigestSwitch[];            // added the provider in the last 7 days
  lost: DigestSwitch[];           // dropped the provider in the last 7 days
  rivals: { label: string; count: number; pct: number }[];
};

const MARKETS_DEFAULT = ["ZA", "KE", "NG"];
const TARGET_LIMIT = 15;

export async function buildProviderDigestData(
  provider: string, markets: string[] = MARKETS_DEFAULT, platform: PlatformSel = "all",
): Promise<ProviderDigestData> {
  const sql = db();
  const canonical = canonicalProvider(provider) || provider;
  const variants = providerVariants(canonical);
  const mk = (markets.length ? markets : MARKETS_DEFAULT).map((m) => m.toUpperCase());
  const LIVE = sql`published AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
  const VERIFIED = sql`payments IS NOT NULL AND payments <> '' AND payments_source IS DISTINCT FROM 'storecensus' AND ${realPaymentsClause(sql)}`;
  const INMKT = sql`country = ANY(${mk})`;
  const PLAT = platformClause(sql, platform);
  const hasProvider = sql`EXISTS (SELECT 1 FROM unnest(string_to_array(payments, ';')) g WHERE lower(btrim(g)) = ANY(${variants}::text[]))`;

  // Pulse: provider stores vs the verified-checkout base, in-market.
  const [counts] = await sql<{ base: number; mine: number }[]>`
    SELECT count(*)::int base, count(*) FILTER (WHERE ${hasProvider})::int mine
    FROM imported_stores WHERE ${LIVE} ${PLAT} AND ${INMKT} AND ${VERIFIED}`;
  const verifiedBase = Number(counts?.base ?? 0);
  const atCheckout = Number(counts?.mine ?? 0);

  // Poaching targets: verified-checkout stores in-market NOT running the provider. Biggest first
  // (est_revenue_usd), then richest signal. The list is a slice; targetsTotal is the whole pool.
  const targetRows = await sql<{
    domain: string; name: string | null; country: string | null; payments: string;
    email: string | null; est_revenue_usd: string | null;
  }[]>`
    SELECT domain, name, country, payments, email, est_revenue_usd
    FROM imported_stores
    WHERE ${LIVE} ${PLAT} AND ${INMKT} AND ${VERIFIED} AND NOT ${hasProvider}
    ORDER BY est_revenue_usd DESC NULLS LAST, product_count DESC NULLS LAST, discovered_at DESC NULLS LAST
    LIMIT ${TARGET_LIMIT}`;
  const targetsTotal = Math.max(0, verifiedBase - atCheckout);
  const targets: DigestTarget[] = targetRows.map((r) => ({
    domain: r.domain, name: r.name, country: r.country,
    rivals: cleanPayments(String(r.payments).split(";")).filter((g) => classify(g) === "PSP").slice(0, 3),
    email: r.email || null,
    revenueUsd: r.est_revenue_usd != null ? Number(r.est_revenue_usd) : null,
  }));

  // Won / lost this week — real switches from the change log, in-market.
  const switchRows = await sql<{ domain: string; country: string | null; changed_at: Date; added: string[] | null; removed: string[] | null }[]>`
    SELECT DISTINCT ON (pc.domain) pc.domain, i.country, pc.changed_at, pc.added, pc.removed
    FROM payment_changes pc JOIN imported_stores i ON i.domain = pc.domain
    WHERE pc.changed_at >= now() - interval '7 days' AND UPPER(i.country) = ANY(${mk})
      ${platformClause(sql, platform, "i.platform")}
      AND (
        EXISTS (SELECT 1 FROM unnest(pc.added) a WHERE lower(btrim(a)) = ANY(${variants}::text[]))
        OR EXISTS (SELECT 1 FROM unnest(pc.removed) x WHERE lower(btrim(x)) = ANY(${variants}::text[]))
      )
    ORDER BY pc.domain, pc.changed_at DESC`.catch(() => []);
  const won: DigestSwitch[] = [], lost: DigestSwitch[] = [];
  const inVariants = (arr: string[] | null) => (arr ?? []).some((t) => variants.includes(t.trim().toLowerCase()));
  for (const r of switchRows) {
    const d = { domain: r.domain, country: r.country, date: new Date(r.changed_at).toISOString().slice(0, 10) };
    if (inVariants(r.added)) won.push(d);
    else if (inVariants(r.removed)) lost.push(d);
  }

  // Competition: among the provider's own stores, which rival PSPs show up most. Bounded parse.
  const mineRows = await sql<{ payments: string }[]>`
    SELECT payments FROM imported_stores
    WHERE ${LIVE} ${PLAT} AND ${INMKT} AND ${VERIFIED} AND ${hasProvider}
    LIMIT 4000`.catch(() => []);
  const rivalTally = new Map<string, number>();
  const pNorm = canonical.toLowerCase();
  for (const r of mineRows) {
    const seen = new Set<string>();
    for (const g of cleanPayments(String(r.payments).split(";"))) {
      if (g.toLowerCase() === pNorm || classify(g) !== "PSP") continue;
      if (seen.has(g)) continue; seen.add(g);
      rivalTally.set(g, (rivalTally.get(g) ?? 0) + 1);
    }
  }
  const rivals = [...rivalTally.entries()]
    .map(([label, count]) => ({ label, count, pct: atCheckout ? Math.round((100 * count) / atCheckout) : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, 6);

  return {
    provider: canonical, markets: mk, platform: String(platform),
    generatedAt: new Date().toISOString(),
    pulse: { atCheckout, verifiedBase, sharePct: verifiedBase ? Math.round((1000 * atCheckout) / verifiedBase) / 10 : 0 },
    targets, targetsTotal, won, lost, rivals,
  };
}

/* ---- HTML render (email-safe: table layout + inline styles) --------------------------------- */
const C = { ink: "#0f2b2a", inkDeep: "#0a1f1e", cream: "#faf6ec", paper: "#ffffff", orange: "#e8622c", mint: "#cdeaa9", lilac: "#cabdf5", rose: "#f0a79a", muted: "#6b7f7e", line: "#ece6d8" };
const MK_NAME: Record<string, string> = { ZA: "South Africa", KE: "Kenya", NG: "Nigeria", EG: "Egypt", MA: "Morocco", GH: "Ghana", JP: "Japan" };
const marketsPhrase = (mk: string[]) => mk.map((m) => MK_NAME[m] ?? m).join(", ");
const compactUsd = (n: number | null): string => {
  if (n == null || n <= 0) return "";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M/mo`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k/mo`;
  return `$${Math.round(n)}/mo`;
};

function targetCard(t: DigestTarget): string {
  const rev = compactUsd(t.revenueUsd);
  const meta = [MK_NAME[t.country ?? ""] ?? t.country, rev, t.rivals.length ? `runs ${t.rivals.join(" + ")}` : "no PSP detected"].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const contact = t.email
    ? `<a href="mailto:${t.email}" style="color:${C.orange};text-decoration:none;font-weight:600;">${t.email}</a>`
    : `<span style="color:${C.muted};">no email on file</span>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px;margin-bottom:10px;">
    <tr><td style="padding:14px 18px;">
      <div style="font-size:15px;font-weight:700;color:${C.ink};">${t.name || t.domain}</div>
      <a href="https://${t.domain}" style="color:${C.muted};text-decoration:none;font-size:12px;">${t.domain}</a>
      <div style="font-size:12px;color:${C.muted};margin-top:6px;">${meta}</div>
      <div style="font-size:12px;margin-top:6px;">${contact}</div>
    </td></tr>
  </table>`;
}

function switchList(items: DigestSwitch[], color: string, emptyMsg: string): string {
  if (!items.length) return `<div style="font-size:13px;color:${C.muted};">${emptyMsg}</div>`;
  return items.slice(0, 10).map((s) =>
    `<div style="font-size:13px;color:${C.ink};padding:3px 0;"><span style="color:${color};font-weight:700;">${s.domain}</span> <span style="color:${C.muted};font-size:11px;">· ${MK_NAME[s.country ?? ""] ?? s.country ?? ""} · ${s.date}</span></div>`,
  ).join("");
}

export function renderProviderDigest(data: ProviderDigestData, siteUrl: string): { subject: string; html: string; text: string } {
  const { provider, markets, pulse, targets, targetsTotal, won, lost, rivals } = data;
  const dateLabel = new Date(data.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const scope = marketsPhrase(markets);
  const subject = targetsTotal > 0
    ? `${provider} — ${targetsTotal.toLocaleString()} stores to win this week`
    : `${provider} — your weekly market brief`;

  const pulseLine = `<b>${pulse.atCheckout.toLocaleString()}</b> stores run ${provider} at checkout &nbsp;·&nbsp; <b>${pulse.sharePct}%</b> of ${pulse.verifiedBase.toLocaleString()} verified checkouts in ${scope}`;
  const rivalRows = rivals.map((r) => {
    const w = Math.min(100, r.pct);
    return `<tr>
      <td style="font-size:13px;color:${C.ink};padding:4px 10px 4px 0;white-space:nowrap;">${r.label}</td>
      <td style="width:100%;padding:4px 0;"><div style="background:#eee9db;border-radius:999px;height:8px;"><div style="background:${C.orange};height:8px;border-radius:999px;width:${w}%;"></div></div></td>
      <td style="font-size:12px;color:${C.muted};padding:4px 0 4px 10px;white-space:nowrap;text-align:right;">${r.pct}%</td>
    </tr>`;
  }).join("");

  const html = `<!-- provider-digest -->
<div style="background:${C.cream};padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" align="center" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
    <tr><td style="background:${C.inkDeep};border-radius:20px 20px 0 0;padding:26px 28px;">
      <div style="color:${C.cream};font-size:20px;font-weight:700;">▲ Terrain</div>
      <div style="color:#9db3b1;font-size:13px;margin-top:2px;">${provider} · weekly market brief · ${dateLabel}</div>
    </td></tr>

    <tr><td style="background:${C.orange};padding:16px 28px;color:${C.inkDeep};font-size:14px;">${pulseLine}</td></tr>

    <tr><td style="background:${C.paper};padding:26px 28px 6px;">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};margin-bottom:4px;">Stores to win</div>
      <div style="font-size:15px;color:${C.ink};margin-bottom:14px;"><b>${targetsTotal.toLocaleString()}</b> stores in ${scope} have a verified checkout but aren&rsquo;t running ${provider} yet. The highest-value ${targets.length}:</div>
      ${targets.map(targetCard).join("") || `<div style="font-size:13px;color:${C.muted};">No open targets in your markets right now — you&rsquo;ve got the field.</div>`}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 0 4px;">
        <a href="${siteUrl}/p/${encodeURIComponent(provider.toLowerCase())}" style="display:inline-block;background:${C.ink};color:${C.cream};text-decoration:none;font-weight:600;font-size:14px;padding:12px 26px;border-radius:999px;">Open your full ${provider} report →</a>
      </td></tr></table>
    </td></tr>

    <tr><td style="background:${C.paper};padding:12px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};"><tr>
        <td valign="top" width="50%" style="padding:16px 12px 0 0;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#2e7d5b;margin-bottom:8px;">Won this week (+${won.length})</div>
          ${switchList(won, "#2e7d5b", "No new adds logged this week.")}
        </td>
        <td valign="top" width="50%" style="padding:16px 0 0 12px;border-left:1px solid ${C.line};">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${C.orange};margin-bottom:8px;">Lost this week (−${lost.length})</div>
          ${switchList(lost, C.orange, "No drops logged this week.")}
        </td>
      </tr></table>
    </td></tr>

    ${rivals.length ? `<tr><td style="background:${C.paper};padding:18px 28px 24px;">
      <table role="presentation" width="100%" style="border-top:1px solid ${C.line};"><tr><td style="padding-top:16px;">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};margin-bottom:10px;">Who you&rsquo;re up against</div>
        <div style="font-size:12px;color:${C.muted};margin-bottom:10px;">Rival PSPs most often alongside ${provider} at your stores&rsquo; checkouts.</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rivalRows}</table>
      </td></tr></table>
    </td></tr>` : ""}

    <tr><td style="background:${C.paper};border-radius:0 0 20px 20px;padding:20px 28px;border-top:1px solid ${C.line};">
      <div style="font-size:12px;color:${C.muted};">Terrain · part of the Tembo Commerce family · Built in Cape Town.<br>
      <a href="${siteUrl}/billing" style="color:${C.muted};">Manage your subscription</a></div>
    </td></tr>
  </table>
</div>`;

  const text =
    `${provider} — weekly market brief — ${dateLabel}\n\n` +
    `${pulse.atCheckout} stores run ${provider} at checkout · ${pulse.sharePct}% of ${pulse.verifiedBase} verified checkouts in ${scope}\n\n` +
    `STORES TO WIN (${targetsTotal} total; top ${targets.length}):\n` +
    targets.map((t) => `• ${t.name || t.domain} (${t.domain}) — ${MK_NAME[t.country ?? ""] ?? t.country ?? ""}${t.rivals.length ? ` — runs ${t.rivals.join(" + ")}` : ""}${t.email ? ` — ${t.email}` : ""}`).join("\n") +
    `\n\nWon this week (+${won.length}): ${won.slice(0, 10).map((s) => s.domain).join(", ") || "—"}\n` +
    `Lost this week (−${lost.length}): ${lost.slice(0, 10).map((s) => s.domain).join(", ") || "—"}\n\n` +
    `Full report: ${siteUrl}/p/${encodeURIComponent(provider.toLowerCase())}\n`;

  return { subject, html, text };
}

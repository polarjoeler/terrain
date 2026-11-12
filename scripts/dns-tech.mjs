#!/usr/bin/env node
/**
 * DNS tech scan — what a store's public DNS says about its stack, for every store, at no cost.
 *
 * Pure DNS: no HTTP request ever reaches the store, so it sits outside the Shopify-edge budget and
 * runs at high concurrency on Rex. Per store (apex) it reads:
 *   · MX                         → email provider (Google Workspace, Microsoft 365, Zoho, local hosts …)
 *   · TXT: SPF includes          → sending tools (Klaviyo, Mailchimp, SendGrid, HubSpot, Zendesk …)
 *   · TXT: site verifications    → accounts the merchant runs (Meta, Google, Klaviyo, Stripe, TikTok …)
 *   · DKIM CNAMEs (kl, k1, s1, selector1) → ESPs that sign mail as the store (Klaviyo, Mailchimp …)
 *   · A record → network (Team Cymru IP→ASN) → hosting provider; Shopify stores read "Shopify"
 * Results land in the side table `store_dns` (detail data stays out of the hot store table). Only
 * hosting is copied onto imported_stores, and only where it was never checked.
 *
 *   node --env-file=.env.local scripts/dns-tech.mjs --migrate                 # ONCE: creates store_dns
 *   node --env-file=.env.local scripts/dns-tech.mjs [--limit 20000] [--concurrency 48] [--dry-run]
 *   node --env-file=.env.local scripts/dns-tech.mjs --domains a.com,b.co.za --dry-run
 *
 * Work order without scanning the store table: each run first takes stores created since the last
 * run, then continues the backlog from a cursor walking created_at newest → oldest (idx_is_created),
 * kept in app_settings. When the backlog is exhausted the cursor restarts, which re-checks everyone.
 */
import postgres from "postgres";
import { Resolver } from "node:dns/promises";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg("--limit", "20000"), 10);
const CONC = parseInt(arg("--concurrency", "48"), 10);
const DOMAINS = arg("--domains", null);
const DRY = process.argv.includes("--dry-run");
const MIGRATE = process.argv.includes("--migrate");
const BATCH = 500;
const CURSOR_KEY = "dns-tech.cursor", SINCE_KEY = "dns-tech.since";

const res = new Resolver({ timeout: 3000, tries: 1 });
res.setServers(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);

// [pattern on a hostname or TXT token, tool, kind]. First match per pattern wins; a store can carry many.
const VENDORS = [
  [/google\.com$|googlemail\.com$|_spf\.google\.com/, "Google Workspace", "email"],
  [/outlook\.com$|protection\.outlook|spf\.protection/, "Microsoft 365", "email"],
  [/zoho\.(com|eu|in)/, "Zoho Mail", "email"],
  [/secureserver\.net$/, "GoDaddy Email", "email"],
  [/titan\.email$/, "Titan Email", "email"],
  [/mimecast/, "Mimecast", "email"],
  [/pphosted\.com$/, "Proofpoint", "email"],
  [/messagingengine\.com$/, "Fastmail", "email"],
  [/privateemail\.com$|registrar-servers\.com$/, "Namecheap Email", "email"],
  [/hostinger/, "Hostinger Email", "email"],
  [/afrihost/, "Afrihost", "email"],
  [/xneelo|konsoleh|host-h\.net/, "Xneelo", "email"],
  [/klaviyo/, "Klaviyo", "marketing"],
  [/mcsv\.net$|mailchimp|mandrillapp/, "Mailchimp", "marketing"],
  [/omnisend/, "Omnisend", "marketing"],
  [/sendinblue|brevo/, "Brevo", "marketing"],
  [/hubspot|hs-?email|hubspotemail/, "HubSpot", "marketing"],
  [/activecampaign|emsd1\.com/, "ActiveCampaign", "marketing"],
  [/constantcontact/, "Constant Contact", "marketing"],
  [/mailjet/, "Mailjet", "marketing"],
  [/drip(email)?\.com|getdrip/, "Drip", "marketing"],
  [/sendgrid/, "SendGrid", "sending"],
  [/mailgun/, "Mailgun", "sending"],
  [/amazonses/, "Amazon SES", "sending"],
  [/mtasv\.net$|postmarkapp/, "Postmark", "sending"],
  [/sparkpost/, "SparkPost", "sending"],
  [/zendesk/, "Zendesk", "support"],
  [/freshdesk|freshworks/, "Freshdesk", "support"],
  [/helpscout/, "Help Scout", "support"],
  [/intercom/, "Intercom", "support"],
  [/gorgias/, "Gorgias", "support"],
  [/salesforce|exacttarget/, "Salesforce", "crm"],
  [/shopify/, "Shopify Email", "sending"],
];
// TXT verification tokens → the account behind them
const VERIFY = [
  [/^facebook-domain-verification=/, "Meta Business"], [/^google-site-verification=/, "Google Search Console"],
  [/^klaviyo-site-verification=/, "Klaviyo"], [/^pinterest-site-verification=/, "Pinterest"],
  [/^apple-domain-verification=/, "Apple"], [/^tiktok-domain-verification=/, "TikTok"],
  [/^stripe-verification=/, "Stripe"], [/^MS=/, "Microsoft 365"], [/^atlassian-domain-verification=/, "Atlassian"],
  [/^hubspot-developer-verification=|^hubspot-domain-verification=/, "HubSpot"], [/^zoho-verification=/, "Zoho"],
  [/^brevo-code:|^sendinblue-code:/, "Brevo"], [/^canva-site-verification=/, "Canva"],
  [/^yandex-verification:/, "Yandex"], [/^ahrefs-site-verification_/, "Ahrefs"], [/^docusign=/, "DocuSign"],
  [/^adobe-idp-site-verification=/, "Adobe"], [/^dropbox-domain-verification=/, "Dropbox"],
];
const ASN_NAME = {
  62044: "Shopify", 13335: "Cloudflare", 16509: "AWS", 14618: "AWS", 8075: "Microsoft Azure", 15169: "Google Cloud",
  396982: "Google Cloud", 20940: "Akamai", 16625: "Akamai", 54113: "Fastly", 24940: "Hetzner", 14061: "DigitalOcean",
  20473: "Vultr", 16276: "OVH", 26496: "GoDaddy", 46606: "Unified Layer", 398101: "GoDaddy", 2635: "Automattic (WordPress.com)",
  328320: "Xneelo", 37153: "Xneelo", 10474: "Xneelo (ZA)", 37611: "Afrihost", 47583: "Hostinger", 22612: "Namecheap",
};
const DKIM_SELECTORS = ["kl", "k1", "s1", "selector1"];

// mail.example.co.za → example.co.za (two-letter country under a generic second level)
const baseDomain = (h) => {
  const p = h.replace(/\.$/, "").split(".");
  return p.slice(/^(co|com|org|net|ac|gov|edu)$/.test(p.at(-2) || "") && (p.at(-1) || "").length === 2 ? -3 : -2).join(".");
};

const vendorsIn = (names) => {
  const out = new Set();
  for (const n of names) for (const [rx, tool] of VENDORS) if (rx.test(n.toLowerCase())) out.add(tool);
  return out;
};

async function asnOf(ip) {
  try {
    const [t] = await res.resolveTxt(`${ip.split(".").reverse().join(".")}.origin.asn.cymru.com`);
    const asn = parseInt(t.join("").split("|")[0].trim(), 10);
    if (!asn) return null;
    let org = null;
    if (!ASN_NAME[asn]) {
      const [o] = await res.resolveTxt(`AS${asn}.asn.cymru.com`).catch(() => [[]]);
      org = (o.join("").split("|")[4] || "").trim().replace(/\s*,\s*[A-Z]{2}\s*$/, "") || null;
      if (org && org.includes(" - ")) org = org.split(" - ").slice(1).join(" - ").trim();
    }
    return { asn, name: ASN_NAME[asn] || org };
  } catch { return null; }
}

async function scan(domain) {
  const apex = domain.replace(/^www\./i, "").toLowerCase();
  const [mx, txt, a] = await Promise.all([
    res.resolveMx(apex).catch((e) => (e.code === "ENOTFOUND" ? null : [])),
    res.resolveTxt(apex).catch(() => []),
    res.resolve4(domain).catch(() => res.resolve4(apex).catch(() => [])),
  ]);
  if (mx === null && !a.length) return { domain, gone: true };
  const mxHosts = (mx || []).sort((x, y) => x.priority - y.priority).map((m) => m.exchange.toLowerCase());
  const records = txt.map((t) => t.join(""));
  const spf = records.filter((r) => /^v=spf1/i.test(r)).flatMap((r) => [...r.matchAll(/include:(\S+)/gi)].map((m) => m[1].toLowerCase()));
  const verified = new Set();
  for (const r of records) for (const [rx, name] of VERIFY) if (rx.test(r)) verified.add(name);
  const dkim = (await Promise.all(DKIM_SELECTORS.map((s) => res.resolveCname(`${s}._domainkey.${apex}`).catch(() => []))))
    .flat().map((h) => h.toLowerCase());
  const email = vendorsIn(mxHosts.slice(0, 1));
  const tools = vendorsIn([...mxHosts, ...spf, ...dkim]);
  for (const v of verified) if (VENDORS.some(([, t]) => t === v)) tools.add(v);
  // Shopify's storefront range is announced by Cloudflare's network, so name it before the ASN lookup
  const net = !a[0] ? null : a[0].startsWith("23.227.38.") ? { asn: 13335, name: "Shopify" } : await asnOf(a[0]);
  return {
    domain, mx: mxHosts.slice(0, 5), spf: spf.slice(0, 12), dkim, verified: [...verified],
    emailProvider: [...email][0] || (mxHosts[0] ? baseDomain(mxHosts[0]) : null),
    tools: [...tools], hosting: net?.name || null, asn: net?.asn || null,
  };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20,
    connection: { statement_timeout: 120000, idle_in_transaction_session_timeout: 120000, lock_timeout: 5000 } });
  try {
    if (MIGRATE) {
      await sql`CREATE TABLE IF NOT EXISTS store_dns (
        domain text PRIMARY KEY, email_provider text, tools text[], verified text[], mx text[], spf text[], dkim text[],
        hosting text, asn int, gone boolean NOT NULL DEFAULT false, checked_at timestamptz NOT NULL DEFAULT now())`;
      await sql`CREATE INDEX IF NOT EXISTS idx_store_dns_tools ON store_dns USING gin (tools)`;
      console.log("store_dns ready."); return;
    }
    const [{ ok }] = await sql`SELECT to_regclass('public.store_dns') IS NOT NULL ok`;
    if (!ok && !DRY) { console.error("dns-tech: store_dns missing — run with --migrate once."); process.exit(1); }

    // ── work order ────────────────────────────────────────────────────────────────────────────
    const started = new Date().toISOString();
    let rows, cursorNext = null;
    if (DOMAINS) {
      rows = DOMAINS.split(",").map((d) => ({ domain: d.trim() })).filter((r) => r.domain);
    } else {
      const live = sql`published AND activity_tier IS DISTINCT FROM 'not_a_store' AND (live_status IS NULL OR live_status NOT IN ('dead','migrated'))`;
      const setting = async (k) => (await sql`SELECT value FROM app_settings WHERE key = ${k}`.catch(() => []))[0]?.value || null;
      const since = await setting(SINCE_KEY);
      const fresh = since ? await sql`SELECT domain FROM imported_stores WHERE created_at > ${since}::timestamptz AND ${live}
        ORDER BY created_at DESC LIMIT ${Math.floor(LIMIT / 2)}` : [];
      const cursor = (await setting(CURSOR_KEY)) || started;
      const backlog = await sql`SELECT domain, created_at FROM imported_stores WHERE created_at < ${cursor}::timestamptz AND ${live}
        ORDER BY created_at DESC LIMIT ${LIMIT - fresh.length}`;
      // an empty backlog means a full pass is done: restart from the top next run (a refresh cycle)
      cursorNext = backlog.length ? new Date(backlog.at(-1).created_at).toISOString() : started;
      const seen = new Set(fresh.map((r) => r.domain));
      rows = [...fresh, ...backlog.filter((r) => !seen.has(r.domain))];
      console.log(`dns-tech: ${fresh.length.toLocaleString()} new since last run + ${backlog.length.toLocaleString()} from the backlog (cursor ${cursor.slice(0, 19)})`);
    }

    const out = [], tally = {}, hostTally = {};
    let i = 0, done = 0, gone = 0;
    const flush = async () => {
      const b = out.splice(0);
      if (DRY || !b.length) return;
      const vals = b.map((r) => [r.domain, r.emailProvider || null, r.tools || [], r.verified || [], r.mx || [], r.spf || [], r.dkim || [],
        r.hosting || null, r.asn || null, !!r.gone]);
      await sql`INSERT INTO store_dns (domain, email_provider, tools, verified, mx, spf, dkim, hosting, asn, gone, checked_at)
        SELECT v.domain, v.ep, v.tools::text[], v.verified::text[], v.mx::text[], v.spf::text[], v.dkim::text[], v.hosting, v.asn::int, v.gone::boolean, now()
        FROM (VALUES ${sql(vals)}) AS v(domain, ep, tools, verified, mx, spf, dkim, hosting, asn, gone)
        ON CONFLICT (domain) DO UPDATE SET email_provider = EXCLUDED.email_provider, tools = EXCLUDED.tools, verified = EXCLUDED.verified,
          mx = EXCLUDED.mx, spf = EXCLUDED.spf, dkim = EXCLUDED.dkim, hosting = EXCLUDED.hosting, asn = EXCLUDED.asn,
          gone = EXCLUDED.gone, checked_at = now()`.catch((e) => console.error("  store_dns write failed:", e.message));
      const host = b.filter((r) => r.hosting).map((r) => [r.domain, r.hosting, String(r.asn)]);
      if (host.length) await sql`UPDATE imported_stores s SET hosting_provider = v.h, hosting_asn = v.a::int, hosting_checked_at = now()
        FROM (VALUES ${sql(host)}) AS v(domain, h, a) WHERE s.domain = v.domain AND s.hosting_checked_at IS NULL`
        .catch((e) => console.error("  hosting write failed:", e.message));
    };

    await Promise.all(Array.from({ length: CONC }, async () => {
      while (i < rows.length) {
        const r = await scan(rows[i++].domain).catch(() => null);
        done++;
        if (!r) continue;
        if (r.gone) gone++;
        for (const t of r.tools || []) tally[t] = (tally[t] || 0) + 1;
        if (r.hosting) hostTally[r.hosting] = (hostTally[r.hosting] || 0) + 1;
        if (DRY && DOMAINS) console.log(`  ${r.domain}: ${r.gone ? "no DNS" : `email=${r.emailProvider} · tools=${(r.tools || []).join(", ") || "-"} · verified=${(r.verified || []).join(", ") || "-"} · host=${r.hosting}`}`);
        out.push(r);
        if (out.length >= BATCH) await flush();
        if (done % 5000 === 0) console.log(`  ${done.toLocaleString()} scanned`);
      }
    }));
    await flush();

    if (!DRY && !DOMAINS) {
      for (const [k, v] of [[CURSOR_KEY, cursorNext], [SINCE_KEY, started]]) {
        await sql`INSERT INTO app_settings (key, value, updated_at) VALUES (${k}, ${v}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch((e) => console.error("  cursor save failed:", e.message));
      }
    }
    const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(" · ");
    console.log(`dns-tech done: ${done.toLocaleString()} scanned · ${gone} with no DNS${DRY ? " · DRY RUN" : ""}`);
    console.log(`  tools: ${top(tally, 14)}`);
    console.log(`  hosting: ${top(hostTally, 8)}`);
  } finally { await sql.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });

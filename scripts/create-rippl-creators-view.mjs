#!/usr/bin/env node
// Create (or replace) the `rippl_creators` view — the creator-platform surface over imported_stores.
// Rippl is the SA/Africa creator index (deferred to 2027), so rather than stand up a second table
// and a sync job now, the creators live where they already are and this view is the clean, stable
// read surface the eventual Rippl app (and any ad-hoc query) points at.
//
// Scope = CREATOR-NATIVE platforms only (Selar/Catlog/Bumpa/Gumroad/Payhip/Paystack/Flutterwave) —
// individual sellers of digital goods & small commerce, who ARE creators. We deliberately do NOT
// include Shopify/Woo brands that merely list a social link (~1.3M of them) — a brand with an
// Instagram is not a creator in Rippl's sense. Selar sellers (socials filled by selar-enrich) are
// the bulk of the seed. Read-only; safe to re-run.
//
// Run:  node --env-file=.env.local scripts/create-rippl-creators-view.mjs
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || process.env.POSTGRES_URL, { ssl: "require", max: 1 });
try {
  await sql`CREATE OR REPLACE VIEW rippl_creators AS
    SELECT
      domain,
      name,
      country,
      platform              AS source_platform,
      instagram, tiktok, twitter, facebook, youtube,
      socials,
      instagram_followers, facebook_followers,
      live_status,
      last_alive_at,
      social_checked_at,
      -- how many distinct networks we hold for this creator (a cheap reach/quality proxy)
      ( (instagram IS NOT NULL)::int + (tiktok IS NOT NULL)::int + (twitter IS NOT NULL)::int
      + (facebook IS NOT NULL)::int + (youtube IS NOT NULL)::int ) AS social_count
    FROM imported_stores
    WHERE platform IN ('Selar','Catlog','Bumpa','Gumroad','Payhip',
                       'Paystack Storefront','Flutterwave Store')`;
  const [{ total }] = await sql`SELECT count(*)::int total FROM rippl_creators`;
  const [{ selar }] = await sql`SELECT count(*)::int selar FROM rippl_creators WHERE source_platform = 'Selar'`;
  const byPlat = await sql`SELECT source_platform, count(*)::int n FROM rippl_creators
                           GROUP BY source_platform ORDER BY n DESC LIMIT 8`;
  console.log(`rippl_creators view ready — ${total.toLocaleString()} creators (Selar: ${selar.toLocaleString()})`);
  console.table(byPlat.map((r) => ({ platform: r.source_platform, creators: r.n })));
} catch (e) { console.error("ERR", e.message); process.exitCode = 1; }
finally { await sql.end(); }

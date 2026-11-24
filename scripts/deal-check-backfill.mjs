/**
 * deal-check-backfill — pre-sale prices for the products in store_promo_products, from the Internet Archive.
 * For each product URL: the Wayback copy nearest 1 Oct (between 1 Aug last year and 9 Nov, so never a copy
 * of the sale itself), read its selling price (lib/price-from-page.mjs), store it in
 * store_promo_product_prices with source = 'wayback' and the snapshot's date.
 *
 * Measured 2026-11-24 on a 60-product sample: 57% had an archived copy, ~50% of those read a price.
 * Polite: one archive.org request at a time, ~1s apart; a 429 waits a minute. Resumable: a product that
 * already has a wayback row is skipped.
 *
 *   node --env-file=.env.local scripts/deal-check-backfill.mjs [--limit 500] [--dry]
 */
import postgres from "postgres";
import { priceFromPage } from "./lib/price-from-page.mjs";
import { ensurePriceHistory } from "./promo-products.mjs";

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = args.includes("--dry");
const LIMIT = Number(arg("--limit", 500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, connection: { statement_timeout: 60000 } });
try {
  if (!DRY) await ensurePriceHistory(sql);
  const todo = await sql`
    SELECT p.domain, p.handle, p.url FROM store_promo_products p
     WHERE p.status <> 'removed' AND NOT EXISTS (
       SELECT 1 FROM store_promo_product_prices h WHERE h.domain = p.domain AND h.handle = p.handle AND h.source = 'wayback')
     ORDER BY p.last_seen_at DESC LIMIT ${LIMIT}`;
  console.log(`deal-check-backfill: ${todo.length} products${DRY ? " · DRY" : ""}`);
  let got = 0;
  for (const r of todo) {
    try {
      const a = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(r.url)}&timestamp=${new Date().getFullYear()}1001`, { signal: AbortSignal.timeout(25000) });
      if (a.status === 429) { await sleep(60000); continue; }
      const s = (await a.json())?.archived_snapshots?.closest;
      const y = new Date().getFullYear();
      if (s?.available && s.timestamp >= `${y - 1}0801` && s.timestamp < `${y}1110`) {
        await sleep(800);
        const h = await fetch(`https://web.archive.org/web/${s.timestamp}id_/${r.url}`, { signal: AbortSignal.timeout(30000) });
        const p = h.ok ? priceFromPage(await h.text()) : null;
        if (p) {
          got++;
          const seen_on = `${s.timestamp.slice(0, 4)}-${s.timestamp.slice(4, 6)}-${s.timestamp.slice(6, 8)}`;
          if (DRY) console.log(`  ${r.domain} ${r.handle} R${p.price} on ${seen_on}`);
          else await sql`INSERT INTO store_promo_product_prices (domain, handle, seen_on, price, source)
                         VALUES (${r.domain}, ${r.handle}, ${seen_on}, ${p.price}, 'wayback') ON CONFLICT DO NOTHING`;
        }
      }
    } catch { /* network: skip, retried next run */ }
    await sleep(1100);
  }
  console.log(`deal-check-backfill done: ${got} pre-sale prices of ${todo.length}`);
} finally { await sql.end({ timeout: 5 }); }

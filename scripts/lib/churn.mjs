/** Shared churn_log writer.
 *
 *  churn_log holds ONE row per domain (domain is the PK; first churn wins via ON CONFLICT DO
 *  NOTHING) and it is the table Insights counts period churn from, by died_at. It lives here
 *  because THREE lanes confirm a death — verify-liveness (HTTP: frozen 402s, migrations),
 *  meta-identify (/meta.json: 402/423 frozen, 404/410/DNS-gone) and focus-liveness (DNS: NXDOMAIN)
 *  — and a hand-rolled copy of this INSERT per lane is exactly how write paths drift apart (the
 *  contact and LinkedIn lanes already did that to each other). All three called it identically.
 *
 *  It snapshots the store as it was at churn time, so the lead survives the store:
 *   · `historic` = we never verified it live before it died (e.g. a bulk-imported old site), so it
 *     is HISTORIC die-off and excluded from period churn rather than dumped into "this week".
 *   · `died_at` = the store's last_alive_at, the last time we confirmed it SELLING. The death is
 *     dated on the MARKET's clock, not on ours (churned_at keeps the raw detection time). NULL
 *     when we never confirmed it selling → undatable, also excluded from period churn.
 */
export async function logChurn(sql, domains, status, migratedTo = null) {
  // One domain or many. meta-identify flips a whole flush at once and must stay a single
  // statement (it writes in grouped batches on purpose), so the bulk form is the only form.
  const list = Array.isArray(domains) ? domains : [domains];
  if (!list.length) return;
  await sql`
    INSERT INTO churn_log (domain, name, country, status, migrated_to, first_seen,
      discovered_at, category, theme, city, estimated_monthly_sales, payments,
      shipping_providers, free_shipping, plus, historic, died_at)
    SELECT domain, name, country, ${status}, ${migratedTo}, first_seen,
      discovered_at, category, theme, city, estimated_monthly_sales, payments,
      shipping_providers, free_shipping, plus, (first_verified_live_at IS NULL),
      last_alive_at
    FROM imported_stores WHERE domain = ANY(${list})
    ON CONFLICT (domain) DO NOTHING`;
}

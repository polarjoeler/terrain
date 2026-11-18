/** Shared churn_log writer.
 *
 *  churn_log holds ONE row per domain (domain is the PK; first churn wins via ON CONFLICT DO
 *  NOTHING) and it is the table Insights counts period churn from, by died_at. It lives here
 *  because TWO lanes now confirm a death — verify-liveness (HTTP: frozen 402s, migrations) and
 *  focus-liveness (DNS: NXDOMAIN) — and a second hand-rolled copy of this INSERT is exactly how
 *  two write paths drift apart (the contact and LinkedIn lanes already did that to each other).
 *
 *  It snapshots the store as it was at churn time, so the lead survives the store:
 *   · `historic` = we never verified it live before it died (e.g. a bulk-imported old site), so it
 *     is HISTORIC die-off and excluded from period churn rather than dumped into "this week".
 *   · `died_at` = the store's last_alive_at, the last time we confirmed it SELLING. The death is
 *     dated on the MARKET's clock, not on ours (churned_at keeps the raw detection time). NULL
 *     when we never confirmed it selling → undatable, also excluded from period churn.
 */
export async function logChurn(sql, domain, status, migratedTo = null) {
  await sql`
    INSERT INTO churn_log (domain, name, country, status, migrated_to, first_seen,
      discovered_at, category, theme, city, estimated_monthly_sales, payments,
      shipping_providers, free_shipping, plus, historic, died_at)
    SELECT domain, name, country, ${status}, ${migratedTo}, first_seen,
      discovered_at, category, theme, city, estimated_monthly_sales, payments,
      shipping_providers, free_shipping, plus, (first_verified_live_at IS NULL),
      last_alive_at
    FROM imported_stores WHERE domain = ${domain}
    ON CONFLICT (domain) DO NOTHING`;
}

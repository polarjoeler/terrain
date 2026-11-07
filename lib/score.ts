/** Lead-fit score (0–100), as ONE SQL expression so the number that SORTS (ORDER BY) is the number
 *  that DISPLAYS (SELECT) — no JS/SQL drift. (The old JS `scoreLead` could only score the 50 rows a
 *  page already held, so the "score" sort fell back to raw revenue — which buried every store without
 *  a StoreLeads revenue row, i.e. ~all non-Shopify. See lib/browse.ts.)
 *
 *  The signals split cleanly by platform: Shopify carries `estimated_monthly_sales` (revenue) but no
 *  activity fields; non-Shopify carries `activity_tier` (100%) + `activity_score` (~87%) but no
 *  revenue. So the PRIMARY value term is the BEST of {revenue, activity_tier, activity_score, traffic}:
 *  each platform ranks on the signal it actually has, and a confirmed-selling WooCommerce store competes
 *  with a mid-revenue Shopify store instead of scoring zero. We deliberately do NOT fabricate a dollar
 *  revenue for the no-signal tail (that stays "New" in the band) — this only orders leads by merit.
 *
 *  Traffic (CrUX rank bucket) is in the GREATEST because it's a platform-agnostic value signal that is
 *  MORE predictive of revenue than the vendor estimate — corr(log crux_rank, log actual) = -0.725 vs
 *  the vendor's 0.332 on our ZA ground-truth anchors — and it's near-complete at the top (ZA $100k+/mo
 *  81% ranked). The per-bucket points track measured P(store >= $10k/mo | bucket): ZA top-5k 77%, 10k
 *  55%, 50k 36%, 100k 19%, 500k 12%. A high-traffic store with no vendor row now ranks on merit. The
 *  rank is a coarse log10 bucket, so it informs ORDERING, not a dollar figure (we never print one).
 *
 *  The rest are additive, platform-agnostic signals we have broadly and for free: a reachable email,
 *  a linked social profile (free off the homepage) plus follower counts where known, catalog depth,
 *  Shopify Plus, basket size (AOV), and recency of discovery.
 */
import { usdExpr, revExpr } from "./fx.ts";

export function scoreExpr(): string {
  const usd = revExpr();   // ballpark-first (modeled CrUX ladder), vendor estimate as fallback
  const aov = usdExpr("avg_product_price");
  return `LEAST(100, GREATEST(1, (
      GREATEST(
        LEAST(42, (log(10, GREATEST(${usd}, 0) + 1) / 7.0) * 42),
        CASE lower(activity_tier) WHEN 'selling' THEN 36 WHEN 'active' THEN 26 WHEN 'dormant' THEN 10 ELSE 0 END,
        LEAST(42, COALESCE(activity_score, 0) / 100.0 * 42),
        CASE  -- traffic: CrUX rank bucket → value (see header; tracks P(>=$10k/mo | bucket))
          WHEN crux_rank IS NULL THEN 0
          WHEN crux_rank <= 5000   THEN 42
          WHEN crux_rank <= 10000  THEN 38
          WHEN crux_rank <= 50000  THEN 32
          WHEN crux_rank <= 100000 THEN 24
          WHEN crux_rank <= 500000 THEN 16
          ELSE 10
        END
      )
      + CASE WHEN email IS NOT NULL AND email <> '' THEN 16 ELSE 0 END
      + CASE WHEN socials IS NOT NULL OR COALESCE(instagram,'') <> '' OR COALESCE(facebook,'') <> '' OR COALESCE(tiktok,'') <> '' THEN 6 ELSE 0 END
      + LEAST(6, (log(10, (COALESCE(instagram_followers,0) + COALESCE(facebook_followers,0)) + 1) / 6.0) * 6)
      + LEAST(10, (log(10, COALESCE(product_count,0) + 1) / 2.6) * 10)
      + CASE WHEN plus THEN 8 ELSE 0 END
      + CASE WHEN ${aov} >= 100 THEN 6 WHEN ${aov} >= 30 THEN 3 ELSE 0 END
      + CASE WHEN discovered_at >= now() - interval '30 days' THEN 8 ELSE 0 END
    )))::int`;
}

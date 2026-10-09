/** The Insights report library — every report, grouped into findable categories, each tagged with the
 *  plan that unlocks it. Pure data, shared by the dropdown nav (and, later, a library landing).
 *
 *  Gating is DECLARED here but not yet ENFORCED — the pricing tiers aren't locked, so for now the
 *  badges show the gating story while everything stays reachable (categorize-now, gate-later). When
 *  tiers finalise, a single hasInsightAccess(tier, plan) check wires enforcement in one place. */
export type Tier = "core" | "team" | "pro";
export type Report = { title: string; desc: string; href?: string; tier: Tier; soon?: boolean };
export type Category = { name: string; blurb: string; reports: Report[] };

export const INSIGHTS_CATALOG: Category[] = [
  {
    name: "Markets", blurb: "Where ecommerce is growing",
    reports: [
      { title: "Market overview", desc: "Launches, churn & coverage by country", href: "/insights", tier: "core" },
      { title: "Africa timeline", desc: "A decade of growth, replayed", href: "/insights/africa", tier: "core" },
      { title: "Country deep-dive", desc: "Slice any market on its own", href: "/insights", tier: "team" },
    ],
  },
  {
    name: "Platforms", blurb: "The CMS landscape",
    reports: [
      { title: "Platform share & growth", desc: "Shopify vs Woo vs the rest, over time", href: "/insights", tier: "team" },
      { title: "Migrations", desc: "Stores moving between platforms", tier: "pro", soon: true },
    ],
  },
  {
    name: "Payments", blurb: "Who's winning checkout",
    reports: [
      { title: "Payment providers", desc: "Every gateway ranked by adoption", href: "/insights/payments", tier: "team" },
      { title: "Leading at checkout", desc: "First gateway offered, by market", href: "/insights/leading", tier: "team" },
      { title: "Gateway switches", desc: "Stores adding or dropping a provider", href: "/insights/switches", tier: "team" },
      { title: "Subscription tools", desc: "Recurring-billing tech in use", href: "/insights/subscriptions", tier: "pro" },
    ],
  },
  {
    name: "Technology", blurb: "The stack merchants run",
    reports: [
      { title: "Themes", desc: "Storefront theme market share", href: "/insights/themes", tier: "team" },
      { title: "Apps", desc: "Most-installed apps & the gaps", href: "/insights/apps", tier: "team" },
      { title: "Categories", desc: "What merchants actually sell", href: "/insights/categories", tier: "team" },
      { title: "Shipping", desc: "Carriers winning at checkout", href: "/insights/shipping", tier: "team" },
      { title: "Cities", desc: "Where stores cluster", href: "/insights/cities", tier: "team" },
    ],
  },
  {
    name: "Competition", blurb: "Your product vs the market",
    reports: [
      { title: "Provider deep-dives", desc: "Any provider's full growth story", href: "/insights/payments", tier: "pro" },
      { title: "Your technology's market", desc: "Where your product wins & loses", tier: "pro", soon: true },
    ],
  },
];

export const TIER_LABEL: Record<Tier, string> = { core: "Core", team: "Team", pro: "Pro" };

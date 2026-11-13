/** Labels for two per-store signals that live in side tables, not on imported_stores. No DB access
 *  here, so the client components (Explorer, lead drawer) can import it.
 *
 *  store_dns          what the store's public DNS says (scripts/dns-tech.mjs): the mailbox provider
 *                     behind its MX, the tools in its SPF/DKIM records, and the accounts its TXT
 *                     verification tokens prove (Meta Business, Google Search Console, Klaviyo …).
 *  store_not_trading  why the checkout probe found nothing to buy (scripts/sync-checkout-payments.mjs,
 *                     from shopify-radar's checkout_cache.json notes).
 */

/** Tools dns-tech files under kind "email" (its VENDORS list). They are mailbox providers, which the
 *  email-provider field and facet already cover, so the DNS-tool facet and chips leave them out. */
export const EMAIL_TOOLS = [
  "Google Workspace", "Microsoft 365", "Zoho Mail", "GoDaddy Email", "Titan Email", "Mimecast",
  "Proofpoint", "Fastmail", "Namecheap Email", "Hostinger Email", "Afrihost", "Xneelo",
];
const EMAIL_TOOL_SET = new Set(EMAIL_TOOLS);

/** DNS tools worth showing next to the store's tech stack (mailbox providers removed). */
export const dnsStackTools = (tools: string[] | null | undefined): string[] =>
  (tools ?? []).filter((t) => !EMAIL_TOOL_SET.has(t));

/** When dns-tech doesn't recognise an MX host it stores the host's base domain ("ionos.de"). The
 *  frequent ones get a readable name here. The stored value stays the filter key; this is display. */
const MX_BASE_LABEL: Record<string, string> = {
  "hostedemail.com": "Tucows email forwarding",   // what a Shopify-registered domain gets by default
  "cloudflare.net": "Cloudflare Email Routing",
  "ppe-hosted.com": "Proofpoint Essentials",
  "ionos.de": "IONOS", "ionos.com": "IONOS", "ionos.fr": "IONOS", "ionos.co.uk": "IONOS", "ionos.es": "IONOS",
  "ovh.net": "OVH", "rzone.de": "Strato", "one.com": "one.com", "qq.com": "Tencent QQ Mail",
  "aliyun.com": "Alibaba Mail", "mailspamprotection.com": "SiteGround", "kasserver.com": "All-Inkl",
  "porkbun.com": "Porkbun forwarding", "lakennetwork.com": "Laken Network",
};

/** Display name for a stored email_provider. Pass the store's domain so mail served from the
 *  store's own domain (a cPanel box on the web host) reads as that, not as the domain again. */
export function emailProviderLabel(v: string, storeDomain?: string | null): string {
  const apex = (storeDomain ?? "").toLowerCase().replace(/^www\./, "");
  if (apex && v.toLowerCase() === apex) return "Own mail server";
  return MX_BASE_LABEL[v.toLowerCase()] ?? v;
}

/** Why the checkout probe could not find anything to buy. `hard` reasons say the store is not
 *  trading; the soft ones are weaker (the homepage didn't answer once, or no product was found). */
export const NOT_TRADING: Record<string, { label: string; short: string; hint: string; hard: boolean }> = {
  frozen: { label: "Frozen by Shopify", short: "Frozen", hard: true,
    hint: "Shopify answers 402 Payment Required: the store is suspended, usually for an unpaid Shopify bill" },
  password_page: { label: "Password page", short: "Password", hard: true,
    hint: "The storefront redirects to /password: not open to the public" },
  not_accepting_orders: { label: "Not accepting orders", short: "No orders", hard: true,
    hint: "Checkout says the store isn't set up to receive orders" },
  unreachable: { label: "Didn't answer", short: "Unreachable", hard: false,
    hint: "The homepage didn't answer when the checkout probe visited" },
  no_variant: { label: "No product found", short: "No product", hard: false,
    hint: "The storefront answered, but the checkout probe found no product to put in a cart" },
};

/** The reasons "Hide stores not trading" removes. */
export const HARD_NOT_TRADING = Object.entries(NOT_TRADING).filter(([, m]) => m.hard).map(([k]) => k);

export const notTradingLabel = (reason: string) => NOT_TRADING[reason]?.label ?? reason;

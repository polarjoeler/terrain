// Hosted-platform DNS fingerprints — the SAME table shopify-radar's ct_tail.py (CT_HOSTED_TAG) and
// bulk_classify.py use. Canonical copy: shopify-radar/hosted_platforms.json. This repo vendors it as
// scripts/lib/hosted-platforms.json (the two repos deploy separately — storepulse via deploy-main,
// shopify-radar via git pull — so a cross-repo import would break whenever one deployed first).
// To change a fingerprint: edit it in shopify-radar, then copy the file here. loadHostedPlatforms()
// warns when the vendored `version` differs from the local shopify-radar checkout, so drift is loud.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED = join(HERE, "hosted-platforms.json");
const RADAR_COPY = join(homedir(), "shopify-radar", "hosted_platforms.json");

function ip4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { const v = Number(x); if (!Number.isInteger(v) || v < 0 || v > 255) return null; n = n * 256 + v; }
  return n;
}
function parseCidr(c) {
  const [base, bits = "32"] = c.split("/");
  const b = Number(bits), n = ip4ToInt(base);
  if (n === null) return null;          // IPv6 rows (none today) are skipped here
  const size = 2 ** (32 - b);
  const start = Math.floor(n / size) * size;
  return { start, end: start + size - 1 };
}

export function loadHostedPlatforms(file = process.env.HOSTED_PLATFORMS_FILE || VENDORED) {
  const t = JSON.parse(readFileSync(file, "utf8"));
  try {
    const radar = JSON.parse(readFileSync(RADAR_COPY, "utf8"));
    if (radar.version !== t.version) {
      console.warn(`! hosted-platforms drift: using ${t.version} (${file}) but ~/shopify-radar has ${radar.version} — copy it over.`);
    }
  } catch { /* no shopify-radar checkout on this machine — fine */ }
  const platforms = t.platforms.map((p) => ({
    name: p.name,
    kind: p.kind || "builder",
    cnames: (p.cname || []).map((s) => s.toLowerCase().replace(/\.$/, "")),
    cidrs: (p.cidr || []).map(parseCidr).filter(Boolean),
    dsuffixes: (p.domain_suffix || []).map((s) => s.toLowerCase()),
  }));
  return { version: t.version, platforms };
}

const cnameHit = (chain, suf) => chain.some((n) => n === suf || n.endsWith("." + suf));

/** First platform whose domain-suffix, CNAME-suffix (label boundary) or IPv4 range fires, else null. */
export function matchHosted(table, domain, cnameChain, ips) {
  const d = String(domain).toLowerCase();
  const chain = cnameChain.map((c) => String(c).toLowerCase().replace(/\.$/, ""));
  const nums = ips.map(ip4ToInt).filter((n) => n !== null);
  for (const p of table.platforms) {
    if (p.dsuffixes.some((s) => d.endsWith(s))) return p;
    if (p.cnames.some((s) => cnameHit(chain, s))) return p;
    if (p.cidrs.length && nums.some((n) => p.cidrs.some((r) => n >= r.start && n <= r.end))) return p;
  }
  return null;
}

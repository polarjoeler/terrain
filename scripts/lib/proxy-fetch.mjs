/**
 * Zero-dependency HTTPS GET with optional rotation across the Webshare proxy fleet.
 *
 * Why this exists: every store HTTP probe we make shares ONE residential IP's Shopify-edge rate
 * budget, so a multi-page crawl over Shopify stores from this machine gets 429'd into uselessness.
 * The Python probes already spread egress across the fleet via STORE_PROBE_PROXY_FILE; this gives
 * the Node scripts the same lane. Node's global fetch() can't take a per-request proxy without
 * pulling in undici, so we drive node:https directly and tunnel through the proxy with CONNECT.
 *
 *   import { loadProxies, pickProxy, fetchText } from "./lib/proxy-fetch.mjs";
 *   const pool = loadProxies();                       // [] when unset → direct, unchanged behaviour
 *   const r = await fetchText(url, { proxy: pickProxy(pool) });
 *
 * Proxy list format is Webshare's export (`host:port:user:pass` per line, # comments allowed);
 * full http(s):// URLs on a line are taken as-is, matching shopify-radar/checkout_probe.py.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export function loadProxies(path = process.env.STORE_PROBE_PROXY_FILE) {
  if (!path || !fs.existsSync(path)) return [];
  const out = [];
  for (const raw of fs.readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("http")) { out.push(line); continue; }
    const [host, port, user, pw] = line.split(":");
    if (host && port && user && pw) out.push(`http://${user}:${pw}@${host}:${port}`);
  }
  return out;
}

export const pickProxy = (pool) => (pool.length ? pool[Math.floor(Math.random() * pool.length)] : null);

/* ---- CONNECT tunnelling agent -------------------------------------------- */
// One agent per proxy, reused: building a fresh Agent per request leaks sockets at fleet scale.
const agents = new Map();

class TunnelAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: true, maxSockets: 4 });
    this.p = new URL(proxyUrl);
  }
  createConnection(options, cb) {
    const auth = this.p.username
      ? { "Proxy-Authorization": "Basic " + Buffer.from(
          `${decodeURIComponent(this.p.username)}:${decodeURIComponent(this.p.password)}`).toString("base64") }
      : {};
    const req = http.request({
      host: this.p.hostname,
      port: Number(this.p.port) || 80,
      method: "CONNECT",
      path: `${options.host}:${options.port || 443}`,
      headers: { Host: `${options.host}:${options.port || 443}`, ...auth },
      timeout: 10_000,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      cb(null, tls.connect({ socket, servername: options.host, ALPNProtocols: ["http/1.1"] }));
    });
    req.once("timeout", () => { req.destroy(new Error("proxy CONNECT timeout")); });
    req.once("error", cb);
    req.end();
  }
}

const agentFor = (proxy) => {
  if (!proxy) return undefined;
  if (!agents.has(proxy)) agents.set(proxy, new TunnelAgent(proxy));
  return agents.get(proxy);
};

/** Close every pooled socket. Call before exit — keep-alive agents hold the process open. */
export function closeAgents() {
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

/* ---- the GET ------------------------------------------------------------- */
/**
 * @returns {Promise<{status:number, url:string, contentType:string, text:string}|null>}
 *          null on a network-level failure (DNS, TLS, timeout, dead proxy).
 *          A non-2xx response is RETURNED, not nulled — callers distinguish 404 from unreachable.
 */
export function fetchText(url, opts = {}) {
  const { proxy = null, timeoutMs = 10_000, maxBytes = 700_000, ua = DEFAULT_UA, redirects = 3 } = opts;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    const mod = u.protocol === "http:" ? http : https;
    // Plain http through a forward proxy uses an absolute-URI request; https uses the CONNECT agent.
    const viaPlainProxy = proxy && u.protocol === "http:";
    const pp = viaPlainProxy ? new URL(proxy) : null;
    const req = mod.request(
      viaPlainProxy
        ? {
            host: pp.hostname, port: Number(pp.port) || 80, method: "GET", path: u.href,
            headers: {
              Host: u.host, "User-Agent": ua, "Accept-Language": "en",
              ...(pp.username ? { "Proxy-Authorization": "Basic " + Buffer.from(
                `${decodeURIComponent(pp.username)}:${decodeURIComponent(pp.password)}`).toString("base64") } : {}),
            },
          }
        : {
            host: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443),
            method: "GET", path: u.pathname + u.search,
            headers: { "User-Agent": ua, "Accept-Language": "en", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
            agent: u.protocol === "http:" ? undefined : agentFor(proxy),
            servername: u.hostname,
          },
      (res) => {
        const loc = res.headers.location;
        if (loc && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          if (redirects <= 0) { resolve({ status: res.statusCode, url, contentType: "", text: "" }); return; }
          let next;
          try { next = new URL(loc, url).href; } catch { resolve(null); return; }
          resolve(fetchText(next, { ...opts, redirects: redirects - 1 }));
          return;
        }
        const chunks = [];
        let n = 0;
        res.on("data", (c) => {
          n += c.length;
          if (n <= maxBytes) chunks.push(c);
          else res.destroy();            // pathological page — keep what we have
        });
        const done = () => resolve({
          status: res.statusCode ?? 0,
          url,
          contentType: String(res.headers["content-type"] ?? ""),
          text: Buffer.concat(chunks).toString("utf8"),
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.once("error", () => resolve(null));
    req.end();
  });
}

/** Fleet monitor data — the live state behind /fleet: what each machine (Rex / Lucy / Chad) is
 *  doing now, and a machine-attributed feed of the sites the swarm just worked.
 *
 *  Machine status comes straight from agent_heartbeat (read fresh, uncached — "is Lucy alive" must
 *  be real-time). The activity feed is a union of small INDEXED per-lane reads (each lane's
 *  *_checked_at column is indexed), bounded to a recent window + LIMIT, and attributed to the
 *  machine that owns that lane. It's cached for a few seconds so several viewers polling every few
 *  seconds don't each re-run the reads. No worker changes — it reads the trail the jobs already
 *  write. */
import { db } from "./db";

// Heartbeat hostname -> the machine the team actually calls it. Anything not here (old hostnames,
// the health-check pseudo-machine) is ignored on the fleet view.
const MACHINES: Record<string, { key: FleetKey; name: string; hw: string; accent: string }> = {
  "joels-mac-studio": { key: "rex", name: "Rex", hw: "Mac Studio · always-on primary", accent: "mint" },
  "peter-johns-macbook-pro-2": { key: "lucy", name: "Lucy", hw: "MBP 2019 · freshness · Woo · hosting", accent: "cyan" },
  "macbook-pro-7": { key: "chad", name: "Chad", hw: "MBP 2024 · dev / control", accent: "lilac" },
};
const ORDER: FleetKey[] = ["rex", "lucy", "chad"];

export type FleetKey = "rex" | "lucy" | "chad";
export type FleetStatus = "active" | "idle" | "offline";
export type FleetTask = { task: string; ageMins: number | null; note: string };
export type FleetMachine = {
  key: FleetKey; name: string; host: string; hw: string; accent: string;
  status: FleetStatus; freshestMins: number | null; tasks: FleetTask[];
};

const mins = (d: Date | null): number | null =>
  d ? Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000)) : null;

export async function fleetMachines(): Promise<FleetMachine[]> {
  const rows = await db()<{ machine: string; task: string; last_run: Date | null; note: string | null }[]>`
    SELECT machine, task, last_run, note FROM agent_heartbeat ORDER BY machine, last_run DESC NULLS LAST`
    .catch(() => [] as { machine: string; task: string; last_run: Date | null; note: string | null }[]);

  const byKey = new Map<FleetKey, FleetTask[]>();
  for (const r of rows) {
    const m = MACHINES[r.machine];
    if (!m) continue;
    const arr = byKey.get(m.key) ?? [];
    arr.push({ task: r.task, ageMins: mins(r.last_run), note: (r.note ?? "").trim() });
    byKey.set(m.key, arr);
  }
  const hostOf = (key: FleetKey) => Object.keys(MACHINES).find((h) => MACHINES[h].key === key) ?? "";

  return ORDER.map((key) => {
    const def = Object.values(MACHINES).find((m) => m.key === key)!;
    const tasks = (byKey.get(key) ?? []).sort((a, b) => (a.ageMins ?? 1e9) - (b.ageMins ?? 1e9));
    const fresh = tasks.length ? tasks[0].ageMins : null;
    // Chad is the dev/control box — it heartbeats but isn't a pipeline worker, so never "active".
    let status: FleetStatus;
    if (key === "chad") status = "idle";
    else if (fresh == null) status = "offline";
    else status = fresh <= 10 ? "active" : fresh <= 240 ? "idle" : "offline";
    return { key, name: def.name, host: hostOf(key), hw: def.hw, accent: def.accent, status, freshestMins: fresh, tasks: tasks.slice(0, 6) };
  });
}

export type FleetEvent = { machine: FleetKey; lane: string; domain: string; detail: string; ts: string; ageSecs: number };

function cleanHost(p: string | null): string {
  if (!p) return "no DNS";
  return p.replace(/\s+(SP\s+)?\(PTY\).*$/i, "").replace(/\s+(Inc\.?|LLC|Ltd\.?|GmbH|AG)\.?$/i, "").trim().slice(0, 22);
}

let _cache: { at: number; data: FleetEvent[] } | null = null;
const TTL_MS = 8000;

export async function fleetActivity(limit = 40): Promise<FleetEvent[]> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.data.slice(0, limit);
  const sql = db();
  const W = "now() - interval '25 minutes'";
  type Row = { domain: string; d1: string | null; ts: Date };

  // Each read hits that lane's own index (ai_enriched_at / hosting_checked_at / discovered_at /
  // live_checked_at / text_mined_at), bounded to the recent window + LIMIT — all cheap.
  // Each read hits that lane's own index and is ~150ms. (text-mine / Chad is omitted until
  // text_mined_at is indexed — unindexed it full-scans 2.8M rows; re-add with the index when
  // Chad's lane goes live.)
  const [enrich, host, found, live] = await Promise.all([
    sql.unsafe(`SELECT domain, category AS d1, ai_enriched_at AS ts FROM imported_stores WHERE ai_enriched_at > ${W} ORDER BY ai_enriched_at DESC LIMIT 16`).catch(() => []) as Promise<Row[]>,
    sql.unsafe(`SELECT domain, hosting_provider AS d1, hosting_checked_at AS ts FROM imported_stores WHERE hosting_checked_at > ${W} ORDER BY hosting_checked_at DESC LIMIT 16`).catch(() => []) as Promise<Row[]>,
    sql.unsafe(`SELECT domain, platform AS d1, discovered_at AS ts FROM imported_stores WHERE discovered_at > ${W} ORDER BY discovered_at DESC LIMIT 10`).catch(() => []) as Promise<Row[]>,
    sql.unsafe(`SELECT domain, live_status AS d1, live_checked_at AS ts FROM imported_stores WHERE live_checked_at > ${W} ORDER BY live_checked_at DESC LIMIT 8`).catch(() => []) as Promise<Row[]>,
  ]);

  const now = Date.now();
  const ev = (rows: Row[], machine: FleetKey, lane: string, detail: (r: Row) => string): FleetEvent[] =>
    rows.map((r) => ({
      machine, lane, domain: r.domain, detail: detail(r),
      ts: new Date(r.ts).toISOString(), ageSecs: Math.max(0, Math.round((now - new Date(r.ts).getTime()) / 1000)),
    }));

  const all = [
    ...ev(enrich, "rex", "enrich", (r) => (r.d1 ? `→ ${r.d1}` : "thin · skipped")),
    ...ev(host, "lucy", "host", (r) => cleanHost(r.d1)),
    ...ev(found, "rex", "found", (r) => r.d1 || "new store"),
    ...ev(live, "rex", "live", (r) => r.d1 || "checked"),
  ].sort((a, b) => b.ts.localeCompare(a.ts));

  _cache = { at: Date.now(), data: all };
  return all.slice(0, limit);
}

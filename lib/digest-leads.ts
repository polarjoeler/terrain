/** Leads for a digest reader's focus — shared by the send job and the admin preview so both pick
 *  from the same set. Fetched once per platform and tagged with it (Lead has no platform field, and
 *  focus matching needs one). A platform's raw DB values vary ("magento" is Adobe Commerce), so each
 *  id loads all of its values. Server-only (DB). */
import type { DigestLead } from "./digest";
import type { Focus } from "./focus";
import { publishedLeads } from "./imported";
import { PLATFORMS } from "./platforms";

export function digestLeadLoader(): (focus: Focus) => Promise<DigestLead[]> {
  const cache = new Map<string, DigestLead[]>();
  const forPlatform = async (platform: string): Promise<DigestLead[]> => {
    if (!cache.has(platform)) {
      if (platform === "all") cache.set(platform, await publishedLeads());
      else {
        const values = [...new Set((PLATFORMS.find((p) => p.id === platform)?.dbValues ?? [platform]).map((v) => v.toLowerCase()))];
        const rows: DigestLead[] = [];
        for (const v of values) for (const l of await publishedLeads(undefined, v)) rows.push({ ...l, platform });
        cache.set(platform, rows);
      }
    }
    return cache.get(platform)!;
  };
  // Their platforms in their order when they named any, else the whole market; buildDigest narrows
  // further by market/category/size. A platform we hold nothing for falls back to the whole market.
  return async (focus) => {
    let leads: DigestLead[] = [];
    for (const p of focus.platforms) leads = leads.concat(await forPlatform(p));
    return leads.length ? leads : forPlatform("all");
  };
}

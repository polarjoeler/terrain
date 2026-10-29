// Alias of /api/cron/refresh-browse. Exists only so vercel.json can schedule an ADDITIONAL daily
// cron hit at a different hour: this account's plan caps cron FREQUENCY at once-per-day per path, so
// staggering several once-daily aliases is how we warm browse_cache multiple times a day. Same
// handler, no logic drift. See lib/browse.ts BROWSE_CACHE_TTL + the browse-cache-warm-starvation note.
export { GET } from "../refresh-browse/route";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

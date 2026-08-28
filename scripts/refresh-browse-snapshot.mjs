/** Recompute the browse snapshot (the single jsonb row the dashboard Explorer reads).
 *  Run from the pipeline AFTER enrichment so newly-captured catalog/contacts/launch
 *  dates flow into the browse view — while keeping the heavy 13k-row query off the
 *  request path, where it timed out under the enrichment jobs' concurrent DB load.
 *
 *    node --env-file=.env.local --experimental-strip-types scripts/refresh-browse-snapshot.mjs
 */
import { refreshBrowseSnapshot } from "../lib/leads-explore.ts";

const t = Date.now();
const n = await refreshBrowseSnapshot();
console.log(`✓ browse snapshot refreshed: ${n.toLocaleString()} leads in ${((Date.now() - t) / 1000).toFixed(1)}s`);
process.exit(0);

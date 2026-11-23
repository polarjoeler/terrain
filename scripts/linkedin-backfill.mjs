#!/usr/bin/env node
/**
 * LinkedIn backfill — reconciles the two places a LinkedIn URL can land, and drops the ones
 * we are not willing to ship.
 *
 * WHY THIS EXISTS. Two lanes discover LinkedIn and they write to different columns:
 *   - scripts/social-enrich.mjs  -> `socials` JSONB  (homepage read, 8 networks)
 *   - scripts/contact-enrich.mjs -> flat `linkedin`  (about/contact pages)
 * lib/browse.ts exports the FLAT column only, so every URL that arrived via social-enrich has
 * been invisible to customers. At the time of writing that was ~3.3k stores, ~3.2k of them in
 * the visible markets — roughly an 85% lift in LinkedIn coverage for ZA/KE/NG, on data we had
 * already paid the crawl for.
 *
 * It also strips personal (/in/) profiles out of the flat column. Those are personal data under
 * POPIA/GDPR/APPI and LinkedIn's terms forbid harvesting profiles; we ship company pages plus a
 * computed search deep-link instead (see lib/linkedin.ts). This is NOT destructive — the values
 * stay in the `socials` JSONB, which is not exported, so the step is reversible.
 *
 * Idempotent: re-running after a clean run does nothing. Batched because the pooler is shared
 * with the web app and two heavy writers (see AGENTS.md + the DB contention notes).
 *
 *   node --env-file=.env.local scripts/linkedin-backfill.mjs            # dry run, prints the plan
 *   node --env-file=.env.local scripts/linkedin-backfill.mjs --apply
 *   node --env-file=.env.local scripts/linkedin-backfill.mjs --apply --batch 1000
 *   node --env-file=.env.local scripts/linkedin-backfill.mjs --apply --only sync
 */
import postgres from "postgres";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes("--apply");
const BATCH = Math.min(parseInt(arg("--batch", "500"), 10), 2000);
const ONLY = arg("--only", "all"); // all | sync | strip

// A LinkedIn URL we are willing to put in front of a customer: an organisation, not a person.
const PERSONAL = "%/in/%";

// A value with no `linkedin.com/` in it is a bare handle written by the old contact-enrich regex,
// which used a NON-capturing `(?:company|in)` and so threw away the one token that said whether
// the URL was an organisation or a person. Three recoverable shapes:
//   - purely numeric        -> a LinkedIn company ID, safe to canonicalise
//   - trailing hex suffix   -> LinkedIn's personal-profile disambiguator, e.g. "-79280a408"
//   - anything else         -> genuinely ambiguous; only a re-crawl can tell us
const BARE = "linkedin NOT ILIKE '%linkedin.com/%'";

async function countRows(sql) {
  const [r] = await sql`
    SELECT
      count(*) FILTER (WHERE socials ? 'linkedin'
                       AND COALESCE(linkedin,'') = ''
                       AND socials->>'linkedin' NOT ILIKE ${PERSONAL})            AS to_sync,
      count(*) FILTER (WHERE linkedin ILIKE ${PERSONAL})                          AS to_strip,
      count(*) FILTER (WHERE COALESCE(linkedin,'') <> '')                         AS li_now,
      count(*) FILTER (WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)}
                       AND linkedin ~ '^[0-9]+$')                                 AS bare_numeric,
      count(*) FILTER (WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)}
                       AND linkedin ~ '-[0-9a-f]{6,}$')                           AS bare_personal,
      count(*) FILTER (WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)}
                       AND linkedin !~ '^[0-9]+$' AND linkedin !~ '-[0-9a-f]{6,}$') AS bare_ambiguous
    FROM imported_stores`;
  return r;
}

/** Run one batched UPDATE to completion. Returns rows touched. */
async function drain(sql, label, run) {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n) process.stdout.write(`\r  ${label}: ${total}`);
    if (n < BATCH) break;
  }
  if (total) process.stdout.write(`\r  ${label}: ${total}\n`);
  else console.log(`  ${label}: 0 (nothing to do)`);
  return total;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2, idle_timeout: 20 });
  try {
    const before = await countRows(sql);
    console.log(`linkedin-backfill ${APPLY ? "[APPLY]" : "[DRY RUN — pass --apply to write]"}`);
    console.log(`  flat column populated now : ${before.li_now}`);
    console.log(`  will sync  JSONB -> column: ${before.to_sync}`);
    console.log(`  will strip personal /in/  : ${before.to_strip}`);
    console.log(`  bare handles — numeric ID : ${before.bare_numeric}  (canonicalise to /company/)`);
    console.log(`  bare handles — personal   : ${before.bare_personal}  (quarantine)`);
    console.log(`  bare handles — ambiguous  : ${before.bare_ambiguous}  (LEFT ALONE — needs a re-crawl)`);

    if (!APPLY) {
      const sample = await sql`
        SELECT domain, socials->>'linkedin' AS incoming FROM imported_stores
        WHERE socials ? 'linkedin' AND COALESCE(linkedin,'') = ''
          AND socials->>'linkedin' NOT ILIKE ${PERSONAL}
        LIMIT 5`;
      if (sample.length) {
        console.log("\n  sample of the sync:");
        for (const s of sample) console.log(`    ${s.domain.padEnd(34)} ${s.incoming}`);
      }
      console.log("\nNo changes written.");
      return;
    }

    // STRIP FIRST, then sync. Doing it in this order means the sync never re-introduces a
    // profile URL that the strip just removed.
    if (ONLY === "all" || ONLY === "strip") {
      await drain(sql, "stripped /in/", async () => {
        const r = await sql`
          WITH batch AS (
            SELECT domain FROM imported_stores
            WHERE linkedin ILIKE ${PERSONAL}
            LIMIT ${BATCH}
          )
          UPDATE imported_stores s SET linkedin = NULL
          FROM batch b WHERE s.domain = b.domain`;
        return r.count ?? 0;
      });
    }

    if (ONLY === "all" || ONLY === "sync") {
      await drain(sql, "synced JSONB->col", async () => {
        const r = await sql`
          WITH batch AS (
            SELECT domain, socials->>'linkedin' AS li FROM imported_stores
            WHERE socials ? 'linkedin'
              AND COALESCE(linkedin,'') = ''
              AND socials->>'linkedin' NOT ILIKE ${PERSONAL}
            LIMIT ${BATCH}
          )
          UPDATE imported_stores s SET linkedin = b.li
          FROM batch b WHERE s.domain = b.domain`;
        return r.count ?? 0;
      });
    }

    if (ONLY === "all" || ONLY === "normalise") {
      // Numeric handles are company IDs — LinkedIn serves /company/<id> directly.
      await drain(sql, "canonicalised IDs", async () => {
        const r = await sql`
          WITH batch AS (
            SELECT domain, linkedin AS id FROM imported_stores
            WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)} AND linkedin ~ '^[0-9]+$'
            LIMIT ${BATCH}
          )
          UPDATE imported_stores s SET linkedin = 'https://linkedin.com/company/' || b.id
          FROM batch b WHERE s.domain = b.domain`;
        return r.count ?? 0;
      });

      // Personal handles move into the socials JSONB rather than being deleted: the export only
      // reads the flat column, so this takes them out of circulation while staying reversible.
      await drain(sql, "quarantined personal", async () => {
        const r = await sql`
          WITH batch AS (
            SELECT domain, linkedin AS handle FROM imported_stores
            WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)} AND linkedin ~ '-[0-9a-f]{6,}$'
            LIMIT ${BATCH}
          )
          UPDATE imported_stores s
          SET socials = COALESCE(s.socials, '{}'::jsonb)
                        || jsonb_build_object('linkedin_unverified', b.handle),
              linkedin = NULL
          FROM batch b WHERE s.domain = b.domain`;
        return r.count ?? 0;
      });
    }

    // The ambiguous remainder. Their type is unrecoverable from the stored value, so they are
    // parked the same reversible way and the column is cleared — which is also what lets a
    // re-crawl repopulate them, since contact-enrich writes linkedin with COALESCE and would
    // otherwise keep the old bad value. Pair this with:
    //   scripts/linkedin-recrawl.mjs   (feeds the parked domains back through contact-enrich)
    if (ONLY === "quarantine-ambiguous") {
      await drain(sql, "parked ambiguous", async () => {
        const r = await sql`
          WITH batch AS (
            SELECT domain, linkedin AS handle FROM imported_stores
            WHERE COALESCE(linkedin,'') <> '' AND ${sql.unsafe(BARE)}
              AND linkedin !~ '^[0-9]+$' AND linkedin !~ '-[0-9a-f]{6,}$'
            LIMIT ${BATCH}
          )
          UPDATE imported_stores s
          SET socials = COALESCE(s.socials, '{}'::jsonb)
                        || jsonb_build_object('linkedin_unverified', b.handle),
              linkedin = NULL
          FROM batch b WHERE s.domain = b.domain`;
        return r.count ?? 0;
      });
    }

    const after = await countRows(sql);
    console.log(`\ndone. flat column: ${before.li_now} -> ${after.li_now}`);
    console.log(`      remaining to sync ${after.to_sync}, remaining /in/ ${after.to_strip}`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

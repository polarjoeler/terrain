/** Seats — who, besides the person paying, may use a subscription.
 *
 *  Entitlement in Terrain is keyed on EMAIL (`subscribers.email` is the primary key), so before
 *  this a teammate who signed in got their own empty row, failed `hasAccess`, and was bounced to
 *  /billing. The extra seat in the price ladder was unsellable and, had it sold, inert.
 *
 *  The model here is deliberately narrow:
 *
 *    - A seat is granted by an EXPLICIT invite row (`team_invite`), never by matching the org's
 *      email domain. Domain-matching would hand a whole company access off one subscription —
 *      `orgKey()` resolves every @peachpayments.com address to the same org, and `listMembers`
 *      already lists anyone at the domain who has merely signed in. Workspace membership and a
 *      paid seat are different things, and only the second is sold.
 *    - Both 'pending' and 'accepted' invites hold a seat. Acceptance is cosmetic (it's what makes
 *      the "Pending" badge disappear once they first sign in); making it load-bearing would mean
 *      writing to the DB from the paywall read path for no entitlement gain.
 *    - The cap is enforced at READ time, by rank. Invites are ordered by (created_at, id) and only
 *      the first `capacity - 1` hold a seat — the owner always holds the first. So an invite list
 *      that somehow outgrew the paid seats downgrades the newest invitees rather than silently
 *      giving access away, and the ordering is stable rather than racy.
 *
 *  Nothing here imports lib/subscriptions.ts: that module composes these helpers inside
 *  getSubscriber(), and importing it back would be a cycle.
 */

import { db as sharedDb } from "./db";
import { seatsFor } from "./plans";

function db() { return sharedDb(); }

/** Total seats a subscription carries, the payer included. */
export function seatCapacity(plan: string | null | undefined, extraSeats: number | null | undefined): number {
  return seatsFor(plan) + Math.max(0, extraSeats ?? 0);
}

export type SeatInvite = {
  /** The org whose subscription this seat draws on. */
  org: string;
  /** 1-based position among that org's seat-holding invites; seat 1 belongs to the payer. */
  rank: number;
};

/** The invite that would give this address a seat, with its position in the queue.
 *
 *  Looked up BY EMAIL rather than by `orgKey(email)`, so an invite to a teammate on a different
 *  domain (a contractor on gmail, say) resolves to the inviting org rather than to themselves. */
export async function seatInviteFor(email: string): Promise<SeatInvite | null> {
  const e = email.trim().toLowerCase();
  try {
    const [row] = await db()<{ org: string; rank: number }[]>`
      WITH mine AS (
        SELECT org, created_at, id FROM team_invite
        WHERE email = ${e} AND status IN ('pending', 'accepted')
        ORDER BY created_at, id LIMIT 1
      )
      SELECT m.org,
             (SELECT count(*) FROM team_invite t
               WHERE t.org = m.org AND t.status IN ('pending', 'accepted')
                 AND (t.created_at, t.id) <= (m.created_at, m.id))::int AS rank
      FROM mine m`;
    return row ? { org: row.org, rank: Number(row.rank) } : null;
  } catch {
    return null;    // team_invite not created yet (lib/account.ts owns its DDL) → nobody holds a seat
  }
}

/** Subscriber addresses on an org's domain, oldest first — the candidates for "who is paying".
 *
 *  `subscribers` has no org column, so this matches on the email domain and the caller picks the
 *  first row that actually has access. Backed by idx_subscribers_domain. Only ever reached for an
 *  address that has no access of its own, so it costs a paying customer nothing. */
export async function orgSubscriberEmails(org: string): Promise<string[]> {
  if (org.includes("@")) return [];     // a personal workspace has no one else to draw on
  try {
    const rows = await db()<{ email: string }[]>`
      SELECT email FROM subscribers
      WHERE split_part(email, '@', 2) = ${org.trim().toLowerCase()}
      ORDER BY created_at`;
    return rows.map((r) => r.email);
  } catch {
    return [];
  }
}

export type SeatHolder = { email: string; status: string; createdAt: string };

/** Every invite holding (or queued for) a seat in an org, in seat order. */
export async function seatRoster(org: string): Promise<SeatHolder[]> {
  try {
    const rows = await db()<{ email: string; status: string; created_at: string }[]>`
      SELECT email, status, created_at FROM team_invite
      WHERE org = ${org} AND status IN ('pending', 'accepted')
      ORDER BY created_at, id`;
    return rows.map((r) => ({ email: r.email, status: r.status, createdAt: new Date(r.created_at).toISOString() }));
  } catch {
    return [];
  }
}

/** Mark this address's pending invites as accepted. Cosmetic — it drives the roster badge, not
 *  entitlement — so every caller treats failure as a no-op. */
export async function acceptInvites(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await db()`
    UPDATE team_invite SET status = 'accepted', accepted_at = now()
    WHERE email = ${e} AND status = 'pending'`;
}

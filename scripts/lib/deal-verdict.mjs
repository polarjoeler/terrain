/**
 * Is a Black Friday discount real? Compare today's price (and the "was" price the store shows) with a price
 * we saw for the same product before the sale (a Wayback Machine copy, or later our own daily history).
 *
 *   same    — today's price is no lower than the old price: the "sale" saves nothing.
 *   inflated — there is a saving, but the "was" price is higher than the product actually sold for.
 *   real    — today's price is lower than before, and the "was" price matches what it used to cost.
 *   null    — no usable old price (none archived, unreadable, or so far off it's a different pack/variant).
 */
export function dealVerdict({ price, regular, old, oldAt }) {
  if (!old || !price) return null;
  // A different pack size, variant or currency, not the same offer.
  if (old < price * 0.4 || old > Math.max(price, regular || 0) * 3) return null;
  const realPct = old > price ? Math.round((1 - price / old) * 100) : 0;
  const claimedPct = regular && regular > price ? Math.round((1 - price / regular) * 100) : null;
  let v;
  if (price >= old * 0.98) v = "same";
  else if (regular && regular > old * 1.05) v = "inflated";
  else v = "real";
  return { v, realPct, claimedPct, old, oldAt };
}

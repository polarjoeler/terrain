/** Demo data: real stores from the live discovery feed (2026-07-30 run). */

export type Lead = {
  domain: string;
  name: string;
  productCount: number | null;
  priceMin: number | null;
  priceMax: number | null;
  email: string | null;
  firstProductAt: string | null;
  plus: boolean;
  firstSeen: string;
  /** When the store entered Terrain (imported_stores.created_at), YYYY-MM-DD.
   *  Used for "new this week" — firstSeen is the store's historical launch date. */
  addedAt?: string | null;
  /** Genuine "found first" date from the cert-transparency discovery engine
   *  (imported_stores.discovered_at), YYYY-MM-DD. The real "newest" signal. */
  discoveredAt?: string | null;
  /** Present on live rows from the Sheet; absent in the bundled samples. */
  country?: string | null;
  currency?: string | null;
  payments?: string[];
  theme?: string | null;
  finalUrl?: string | null;
  /** Rich fields (present on imported base stores; null on discovery-feed rows). */
  category?: string | null;
  estMonthlySales?: number | null;
  productsSold?: number | null;
  city?: string | null;
  plan?: string | null;
  description?: string | null;
  technologies?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  instagramFollowers?: number | null;
  facebookFollowers?: number | null;
};

export const sampleLeads: Lead[] = [
  {
    domain: "pawcarnival.co.za",
    name: "Paw Carnival",
    productCount: 9,
    priceMin: null,
    priceMax: null,
    email: null,
    firstProductAt: "2026-07-30",
    plus: false,
    firstSeen: "2026-07-30",
  },
  {
    domain: "metaldeco.co.za",
    name: "Metal Deco",
    productCount: 250,
    priceMin: null,
    priceMax: null,
    email: null,
    firstProductAt: "2026-07-29",
    plus: false,
    firstSeen: "2026-07-29",
  },
  {
    domain: "lightswitches.co.za",
    name: "Light Switches",
    productCount: 250,
    priceMin: 84.7,
    priceMax: 14399,
    email: "info@lightswitches.co.za",
    firstProductAt: "2026-06-24",
    plus: true,
    firstSeen: "2026-07-28",
  },
  {
    domain: "sonyworld.co.za",
    name: "Sony World — Official Store",
    productCount: 89,
    priceMin: null,
    priceMax: null,
    email: null,
    firstProductAt: "2023-07-07",
    plus: true,
    firstSeen: "2026-07-27",
  },
  {
    domain: "factory72.co.za",
    name: "Factory-72",
    productCount: 250,
    priceMin: 1,
    priceMax: 470,
    email: "jake@factory72.co.za",
    firstProductAt: "2026-07-01",
    plus: false,
    firstSeen: "2026-07-26",
  },
  {
    domain: "bagworldza.co.za",
    name: "BagWorld ZA",
    productCount: 250,
    priceMin: null,
    priceMax: null,
    email: null,
    firstProductAt: "2026-07-17",
    plus: false,
    firstSeen: "2026-07-25",
  },
  {
    domain: "ariellesaphire.co.za",
    name: "Arielle Saphire Activewear",
    productCount: 6,
    priceMin: 200,
    priceMax: 999,
    email: "hello@ariellesaphire.co.za",
    firstProductAt: "2025-04-12",
    plus: false,
    firstSeen: "2026-07-24",
  },
];

export const feedStats = {
  storesTracked: 236,
  withEmail: 109,
  withPrices: 161,
  plusFlagged: 3,
  newThisWeek: 46,
};

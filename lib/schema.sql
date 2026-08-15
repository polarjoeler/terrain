-- Terrain subscriber schema. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS subscribers (
  email              TEXT PRIMARY KEY,
  plan               TEXT NOT NULL DEFAULT 'starter',
  status             TEXT NOT NULL DEFAULT 'trialing',
  trial_ends_at      TIMESTAMPTZ,
  customer_code      TEXT,
  subscription_code  TEXT,
  email_token        TEXT,
  next_payment_date  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Spent magic-link ids, so a forwarded link can't be replayed.
CREATE TABLE IF NOT EXISTS used_tokens (
  jti         TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_tokens_expiry ON used_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

-- Monthly CSV-export quota (Pro). export_month is 'YYYY-MM'; resets when it rolls.
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS export_month TEXT;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS export_used INTEGER NOT NULL DEFAULT 0;

-- Admin-imported "base" stores. Held in a separate pool until published, so a
-- messy import can't pollute the live feed.
CREATE TABLE IF NOT EXISTS imported_stores (
  domain           TEXT PRIMARY KEY,
  name             TEXT,
  country          TEXT,
  product_count    INTEGER,
  price_min        NUMERIC,
  price_max        NUMERIC,
  currency         TEXT,
  email            TEXT,
  theme            TEXT,
  plus             BOOLEAN DEFAULT false,
  payments         TEXT,
  first_product_at TEXT,
  first_seen       TEXT,
  published        BOOLEAN NOT NULL DEFAULT false,
  source           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_imported_published ON imported_stores(published);

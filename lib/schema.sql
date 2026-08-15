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

-- Rich fields from premium data exports (StoreLeads-style). Typed columns for
-- the high-value signals we rank/display on; `raw` keeps the full source row so
-- nothing is lost even though our own scraping is limited today.
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS merchant_name TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS estimated_monthly_sales NUMERIC;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS products_sold INTEGER;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS avg_product_price NUMERIC;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS rank INTEGER;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS apps TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS instagram_followers INTEGER;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS facebook_followers INTEGER;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS employee_count INTEGER;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS store_created TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS raw JSONB;
-- Rank stores by value for prioritised payment scanning / enrichment.
CREATE INDEX IF NOT EXISTS idx_imported_sales ON imported_stores(estimated_monthly_sales DESC NULLS LAST);

-- Radar Brand Audits — the on-demand initial scan of a brand against our known
-- store universe. One row per scan; results_json holds the full report so the
-- shareable /radar/scan/<id> page is a pure read.
CREATE TABLE IF NOT EXISTS radar_audits (
  id            TEXT PRIMARY KEY,
  brand_domain  TEXT NOT NULL,
  brand_name    TEXT,
  market        TEXT,
  email         TEXT,
  inputs_json   TEXT NOT NULL DEFAULT '{}',
  results_json  TEXT NOT NULL DEFAULT '{}',
  copies        INTEGER NOT NULL DEFAULT 0,
  candidates    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'done',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_audits_created ON radar_audits(created_at);

-- Cached catalogue fingerprints for the store universe. Computed at import /
-- enrichment time so a Brand Audit compares against them instantly — and can
-- scan the WHOLE universe (catching random-domain clones), not just name matches.
CREATE TABLE IF NOT EXISTS store_fingerprints (
  domain          TEXT PRIMARY KEY,
  name            TEXT,
  market          TEXT,
  n_products      INTEGER NOT NULL DEFAULT 0,
  image_stems     JSONB NOT NULL DEFAULT '[]',
  skus            JSONB NOT NULL DEFAULT '[]',
  handles         JSONB NOT NULL DEFAULT '[]',
  titles          JSONB NOT NULL DEFAULT '[]',
  price_by_handle JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'ok',   -- ok | empty | error
  enriched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_fp_market ON store_fingerprints(market);
CREATE INDEX IF NOT EXISTS idx_store_fp_enriched ON store_fingerprints(enriched_at);

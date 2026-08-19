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
-- Promoted from raw for cheap display (never SELECT the full raw jsonb per-request).
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS facebook TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS tiktok TEXT;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS technologies TEXT;
-- AI enrichment stamp: set once we've synthesised category/description from the
-- live site (via scripts/ai-enrich.mjs), so we never re-spend on the same store.
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS ai_enriched_at TIMESTAMPTZ;
-- Our own verified liveness (separate from the source's `status` snapshot).
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS live_status TEXT;      -- active | migrated | dead
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS live_platform TEXT;    -- detected platform when migrated
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS live_checked_at TIMESTAMPTZ;
ALTER TABLE imported_stores ADD COLUMN IF NOT EXISTS live_miss INTEGER NOT NULL DEFAULT 0;
-- Rank stores by value for prioritised payment scanning / enrichment.
CREATE INDEX IF NOT EXISTS idx_imported_sales ON imported_stores(estimated_monthly_sales DESC NULLS LAST);

-- Manual lead corrections. Applied LAST by fetchLeads (after Sheet + imported),
-- so a fix always wins regardless of source and survives re-enrichment. Any
-- NULL column means "no override for this field". `hidden` removes a bad lead.
CREATE TABLE IF NOT EXISTS lead_overrides (
  domain        TEXT PRIMARY KEY,
  name          TEXT,
  email         TEXT,
  country       TEXT,
  currency      TEXT,
  plus          BOOLEAN,
  theme         TEXT,
  product_count INTEGER,
  price_min     NUMERIC,
  price_max     NUMERIC,
  payments      TEXT,
  hidden        BOOLEAN NOT NULL DEFAULT false,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

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

-- Enrolled brands — the fingerprint-on-file that turns a one-off audit into
-- ongoing monitoring. Captured when a brand runs an audit: their catalogue
-- fingerprint becomes a persistent reference, and official_domains is the
-- allowlist that keeps their own stores from ever being flagged. The monitoring
-- side matches every newly-discovered store against these rows.
CREATE TABLE IF NOT EXISTS radar_brands (
  brand_domain     TEXT PRIMARY KEY,
  brand_name       TEXT,
  market           TEXT,
  email            TEXT,
  official_domains JSONB NOT NULL DEFAULT '[]',  -- allowlist (never flagged)
  trademark        TEXT,
  -- Reference fingerprint (same shape as store_fingerprints).
  n_products       INTEGER NOT NULL DEFAULT 0,
  image_stems      JSONB NOT NULL DEFAULT '[]',
  skus             JSONB NOT NULL DEFAULT '[]',
  handles          JSONB NOT NULL DEFAULT '[]',
  titles           JSONB NOT NULL DEFAULT '[]',
  price_by_handle  JSONB NOT NULL DEFAULT '{}',
  monitoring       BOOLEAN NOT NULL DEFAULT true,
  fingerprinted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_brands_monitoring ON radar_brands(monitoring);

-- Monitoring detections — clones found by the ongoing sweep (scripts/radar-
-- monitor.mjs) matching newly-fingerprinted stores against enrolled brands.
-- Distinct from audit matches (which live inside radar_audits.results_json):
-- these are the always-on alerts. One row per (brand, suspect); re-runs refresh
-- score/last_seen, so the table is a deduped live detection log.
CREATE TABLE IF NOT EXISTS radar_detections (
  brand_domain  TEXT NOT NULL,
  suspect       TEXT NOT NULL,
  brand_name    TEXT,
  suspect_name  TEXT,
  verdict       TEXT NOT NULL,
  score         INTEGER NOT NULL,
  reasons       JSONB NOT NULL DEFAULT '[]',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_domain, suspect)
);
CREATE INDEX IF NOT EXISTS idx_radar_detections_score ON radar_detections(score DESC);

-- Daily market-insights snapshots — one JSON blob per day, computed from
-- imported_stores by scripts/insights-snapshot.mjs. Powers the over-time trends
-- on /insights (Week/Month/Quarter/Year), which build up as days accrue.
CREATE TABLE IF NOT EXISTS insights_snapshots (
  date       DATE PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Small key/value settings store. Holds `insights_baseline_date` — the point
-- from which Insights trends & forward-churn are measured, so a bulk import can
-- be reset out (import lands as a level-shift, not fake growth/churn).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

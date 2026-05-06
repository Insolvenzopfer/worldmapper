-- Migration: add new columns to existing WorldMap installation
-- Run this if you already have a running instance:
-- docker exec -i worldmap2-db-1 psql -U worldmap worldmap < migrate.sql

ALTER TABLE maps
  ADD COLUMN IF NOT EXISTS map_scale_label      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS map_miles_width      DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS travel_miles_per_day DECIMAL(10,2) DEFAULT 24,
  ADD COLUMN IF NOT EXISTS travel_hours_per_day DECIMAL(10,2) DEFAULT 8;

ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'group';

-- Back-fill existing routes: routes with NULL group_id should be 'public'
UPDATE routes SET visibility = 'group' WHERE visibility IS NULL AND group_id IS NOT NULL;
UPDATE routes SET visibility = 'public' WHERE visibility IS NULL AND group_id IS NULL;

\echo 'Migration complete.'

-- Add custom POI icons table
CREATE TABLE IF NOT EXISTS custom_poi_icons (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  image_url  VARCHAR(1000) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Map locking feature
ALTER TABLE maps
  ADD COLUMN IF NOT EXISTS locked_by_editor INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

-- v2.6: Replace fog_canvas with fog_areas (polygon-based fog)
-- This drops the old stroke data; re-draw fog areas after migration.
DROP TABLE IF EXISTS fog_canvas;
CREATE TABLE IF NOT EXISTS fog_areas (
  id          SERIAL PRIMARY KEY,
  map_id      INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  name        VARCHAR(255) DEFAULT 'Bereich',
  coordinates JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
\echo 'v2.6 fog migration complete. Fog areas must be re-drawn.'

-- v0.8.0: Fix order_index to support fractional values for insert-before
ALTER TABLE route_waypoints ALTER COLUMN order_index TYPE DECIMAL(10,4);
\echo 'v0.8.0 migration complete.'

-- v0.8.0: Add thumbnail path to maps
ALTER TABLE maps ADD COLUMN IF NOT EXISTS thumb_path VARCHAR(500);

-- v0.8.1: Add owner_id to custom_poi_icons (NULL = global/superadmin)
ALTER TABLE custom_poi_icons ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
\echo 'v0.8.1 icon ownership migration done.'

-- v0.8.2: Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  username   VARCHAR(255),
  ip         VARCHAR(100),
  action     VARCHAR(255) NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_time_idx ON audit_log (created_at DESC);

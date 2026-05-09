CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email         VARCHAR(255),
  is_superadmin BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE maps (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(255) NOT NULL,
  description           TEXT,
  image_path            VARCHAR(500),
  image_width           INTEGER DEFAULT 2000,
  image_height          INTEGER DEFAULT 2000,
  share_token           VARCHAR(12) UNIQUE NOT NULL,
  owner_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  map_scale_label       VARCHAR(255),
  map_miles_width       DECIMAL(10,2),
  travel_miles_per_day  DECIMAL(10,2) DEFAULT 24,
  travel_hours_per_day  DECIMAL(10,2) DEFAULT 8,
  thumb_path            VARCHAR(500),
  locked_by_editor      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  locked_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE maps ADD COLUMN default_settings JSONB DEFAULT '{
  "label_font": "MorrisRoman-Black",
  "fog_opacity": 70,
  "poi_label_size": "22px",
  "poi_label_color": "#e2e8f0",
  "region_label_width": "210px",
  "poi_size": 30,
  "poi_min_size": 25,
  "poi_max_size": 80,
  "poi_border_color": "#bcbcbc",
  "ping_duration": 5
}'::jsonb;

CREATE TABLE map_admins (
  map_id  INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (map_id, user_id)
);

CREATE TABLE groups (
  id                 SERIAL PRIMARY KEY,
  map_id             INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  name               VARCHAR(255) NOT NULL,
  color              VARCHAR(50) DEFAULT '#3b82f6',
  visible            BOOLEAN DEFAULT true,
  fog_of_war_enabled BOOLEAN DEFAULT false,
  order_index        INTEGER DEFAULT 0,
  external_links     JSONB DEFAULT '[]',
  share_token        VARCHAR(12) UNIQUE NOT NULL
);

-- visibility: 'public' = all groups see it, 'group' = own group only, 'hidden' = admin only
-- bg_transparent: true = no background circle, icon emoji only
CREATE TABLE pois (
  id             SERIAL PRIMARY KEY,
  map_id         INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  lat            DECIMAL(10,4) NOT NULL,
  lng            DECIMAL(10,4) NOT NULL,
  icon           VARCHAR(50) DEFAULT 'circle',
  color          VARCHAR(50) DEFAULT '#3b82f6',
  bg_transparent BOOLEAN DEFAULT false,
  links          JSONB DEFAULT '[]',
  visibility     VARCHAR(20) DEFAULT 'group',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE routes (
  id          SERIAL PRIMARY KEY,
  map_id      INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  color       VARCHAR(50) DEFAULT '#ef4444',
  weight      INTEGER DEFAULT 3,
  line_style  VARCHAR(20) DEFAULT 'solid',
  smooth      BOOLEAN DEFAULT true,
  visibility  VARCHAR(20) DEFAULT 'group',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE route_waypoints (
  id          SERIAL PRIMARY KEY,
  route_id    INTEGER REFERENCES routes(id) ON DELETE CASCADE,
  lat         DECIMAL(10,4) NOT NULL,
  lng         DECIMAL(10,4) NOT NULL,
  title       VARCHAR(255),
  info        TEXT,
  order_index DECIMAL(10,4) DEFAULT 0
);

CREATE TABLE regions (
  id             SERIAL PRIMARY KEY,
  map_id         INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  group_id       INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  coordinates    JSONB NOT NULL DEFAULT '[]',
  color          VARCHAR(50) DEFAULT '#22c55e',
  fill_opacity   DECIMAL(3,2) DEFAULT 0.20,
  stroke_opacity DECIMAL(3,2) DEFAULT 0.80,
  visibility     VARCHAR(20) DEFAULT 'group',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Fog: strokes = [{lat, lng, radius}] (revealed circles)
-- Empty strokes array = fully covered by default
-- Fog of war: each row is a named revealed polygon area per group
CREATE TABLE fog_areas (
  id          SERIAL PRIMARY KEY,
  map_id      INTEGER REFERENCES maps(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  name        VARCHAR(255) DEFAULT 'Bereich',
  coordinates JSONB NOT NULL DEFAULT '[]',   -- [{lat, lng}, ...]
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Default superadmin  (password = admin123)
INSERT INTO users (username, password_hash, is_superadmin)
VALUES ('admin', '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FApkm/rzdCBM5y5TPBFVbGMGR6UOIXW', true);

-- Custom POI icons (superadmin=global, others=own icons only)
CREATE TABLE custom_poi_icons (
  id         SERIAL PRIMARY KEY,
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global (superadmin)
  name       VARCHAR(255) NOT NULL,   -- stored as username_name for non-superadmins
  image_url  VARCHAR(1000) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_log (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  username   VARCHAR(255),
  ip         VARCHAR(100),
  action     VARCHAR(255) NOT NULL,
  detail     TEXT
);
CREATE INDEX ON audit_log (created_at DESC);
CREATE INDEX ON audit_log (username);

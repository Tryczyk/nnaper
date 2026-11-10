CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================================
-- 1. UŻYTKOWNICY I PROFILE
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(64) NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name       VARCHAR(64) NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_profile_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id);

-- ============================================================================
-- 2. EPOKI TELEMETRYCZNE
-- ============================================================================

CREATE TABLE IF NOT EXISTS epochs (
    epoch_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id    UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    timestamp     TIMESTAMPTZ,
    geom          GEOMETRY(Point, 4326) NOT NULL,
    geom_snapped  GEOMETRY(Point, 4326),
    geom_line     GEOMETRY(LineString, 4326),
    speed_kmh     NUMERIC(7, 2) NOT NULL DEFAULT 0,
    g_x           NUMERIC(6, 3),
    g_y           NUMERIC(6, 3),
    g_z           NUMERIC(6, 3),
    CONSTRAINT uq_profile_timestamp UNIQUE (profile_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);
CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));
CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);

CREATE TABLE IF NOT EXISTS satellite (
    satellite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id     UUID NOT NULL REFERENCES epochs(epoch_id) ON DELETE CASCADE,
    prn          SMALLINT,
    elevation    SMALLINT,
    azimuth      SMALLINT
);

CREATE INDEX IF NOT EXISTS idx_satellite_epoch_id ON satellite (epoch_id);

-- ============================================================================
-- 3. USTAWIENIA UŻYTKOWNIKA, PRESETY WARSTW I RYSUNKI NA MAPIE
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS user_sessions (
    token      VARCHAR(128) PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS layer_presets (
    preset_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    name       VARCHAR(128) NOT NULL,
    config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_preset_name UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_layer_presets_user_id ON layer_presets (user_id);

CREATE TABLE IF NOT EXISTS map_drawings (
    drawing_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    profile_id   UUID REFERENCES profiles(profile_id) ON DELETE SET NULL,
    name         VARCHAR(128) NOT NULL DEFAULT 'Rysunek',
    drawing_type VARCHAR(32) NOT NULL DEFAULT 'polygon',
    color        VARCHAR(32) NOT NULL DEFAULT '#38bdf8',
    show_metrics BOOLEAN NOT NULL DEFAULT TRUE,
    area_m2      DOUBLE PRECISION NOT NULL DEFAULT 0,
    perimeter_m  DOUBLE PRECISION NOT NULL DEFAULT 0,
    length_m     DOUBLE PRECISION NOT NULL DEFAULT 0,
    coordinates  JSONB NOT NULL DEFAULT '[]'::jsonb,
    geom         GEOMETRY(Geometry, 4326),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_map_drawings_user_id ON map_drawings (user_id);
CREATE INDEX IF NOT EXISTS idx_map_drawings_geom ON map_drawings USING GIST (geom);

-- ============================================================================
-- 4. DANE Z PLIKU .OSM.PBF (INFRASTRUKTURA, POI, ADRESY, GRAF DRÓG, MGŁA WOJNY)
-- ============================================================================

CREATE TABLE IF NOT EXISTS osm_import_meta (
    file_name   VARCHAR(255) PRIMARY KEY,
    file_size   BIGINT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS osm_infrastructure (
    id          BIGSERIAL PRIMARY KEY,
    osm_id      BIGINT NOT NULL,
    osm_type    VARCHAR(16) NOT NULL,
    category    VARCHAR(64) NOT NULL,
    subtype     VARCHAR(64),
    name        TEXT,
    maxspeed    VARCHAR(32),
    tags        JSONB NOT NULL DEFAULT '{}'::jsonb,
    geom        GEOMETRY(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_infra_geom ON osm_infrastructure USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_infra_category ON osm_infrastructure (category);

CREATE TABLE IF NOT EXISTS osm_pois (
    id            BIGSERIAL PRIMARY KEY,
    osm_id        BIGINT NOT NULL,
    osm_type      VARCHAR(16) NOT NULL,
    category      VARCHAR(64) NOT NULL,
    subclass      VARCHAR(64),
    name          TEXT,
    opening_hours TEXT,
    street        TEXT,
    housenumber   TEXT,
    city          TEXT,
    postcode      TEXT,
    phone         TEXT,
    website       TEXT,
    cuisine       TEXT,
    operator      TEXT,
    brand         TEXT,
    tags          JSONB NOT NULL DEFAULT '{}'::jsonb,
    geom          GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_pois_geom ON osm_pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_pois_category ON osm_pois (category);

CREATE TABLE IF NOT EXISTS osm_addresses (
    id           BIGSERIAL PRIMARY KEY,
    osm_id       BIGINT NOT NULL,
    osm_type     VARCHAR(16) NOT NULL,
    place_type   VARCHAR(64) NOT NULL,
    name         TEXT,
    street       TEXT,
    housenumber  TEXT,
    city         TEXT,
    postcode     TEXT,
    state        TEXT NOT NULL DEFAULT 'Pomorskie',
    country      TEXT NOT NULL DEFAULT 'Polska',
    country_code VARCHAR(4) NOT NULL DEFAULT 'PL',
    search_text  TEXT NOT NULL,
    importance   SMALLINT NOT NULL DEFAULT 1,
    geom         GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_addresses_geom ON osm_addresses USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_addresses_importance ON osm_addresses (importance DESC);

CREATE TABLE IF NOT EXISTS osm_road_edges (
    edge_id         BIGSERIAL PRIMARY KEY,
    osm_way_id      BIGINT NOT NULL,
    source_node     BIGINT NOT NULL,
    target_node     BIGINT NOT NULL,
    oneway          SMALLINT NOT NULL DEFAULT 0,
    highway         VARCHAR(32) NOT NULL,
    name            TEXT,
    length_m        DOUBLE PRECISION NOT NULL,
    speed_kmh       DOUBLE PRECISION NOT NULL,
    duration_s      DOUBLE PRECISION NOT NULL,
    is_roundabout   BOOLEAN NOT NULL DEFAULT FALSE,
    speed_bumps     INT NOT NULL DEFAULT 0,
    crossings       INT NOT NULL DEFAULT 0,
    traffic_signals INT NOT NULL DEFAULT 0,
    is_intersection BOOLEAN NOT NULL DEFAULT FALSE,
    geom            GEOMETRY(LineString, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_osm_road_edges_geom ON osm_road_edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_osm_road_edges_nodes ON osm_road_edges (source_node, target_node);

CREATE TABLE IF NOT EXISTS fog_parcels (
    parcel_id   INT PRIMARY KEY,
    road_geom   GEOMETRY(LineString, 4326) NOT NULL,
    parcel_geom GEOMETRY(Polygon, 4326) NOT NULL,
    area_m2     DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fog_parcels_road_geom ON fog_parcels USING GIST (road_geom);
CREATE INDEX IF NOT EXISTS idx_fog_parcels_parcel_geom ON fog_parcels USING GIST (parcel_geom);

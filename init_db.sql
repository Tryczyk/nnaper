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
    epoch_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    timestamp  TIMESTAMPTZ NOT NULL,
    geom       GEOMETRY(Point, 4326) NOT NULL,
    altitude   NUMERIC(7, 2),
    speed_kmh  NUMERIC(7, 2) NOT NULL DEFAULT 0,
    g_x        NUMERIC(6, 3),
    g_y        NUMERIC(6, 3),
    g_z        NUMERIC(6, 3),
    CONSTRAINT uq_profile_timestamp UNIQUE (profile_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);

CREATE TABLE IF NOT EXISTS satellite (
    satellite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id     UUID NOT NULL REFERENCES epochs(epoch_id) ON DELETE CASCADE,
    prn          SMALLINT,
    elevation    SMALLINT,
    azimuth      SMALLINT
);

CREATE INDEX IF NOT EXISTS idx_satellite_epoch_id ON satellite (epoch_id);
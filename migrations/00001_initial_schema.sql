-- +goose Up
-- SQL in this section is executed when the migration is applied.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(64) NOT NULL UNIQUE,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url    TEXT,
    ui_settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
    profile_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID REFERENCES users(user_id) ON DELETE CASCADE,
    name         VARCHAR(64) NOT NULL,
    avatar_url   TEXT,
    epochs_count BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_user_profile_name UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id);

CREATE TABLE IF NOT EXISTS epochs (
    epoch_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id     UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    timestamp      TIMESTAMPTZ,
    geom           GEOMETRY(Point, 4326) NOT NULL,
    geom_snapped   GEOMETRY(Point, 4326),
    geom_line      GEOMETRY(LineString, 4326),
    speed_kmh      NUMERIC(7, 2) NOT NULL DEFAULT 0,
    altitude_m     NUMERIC(7, 2),
    hdop           NUMERIC(5, 2),
    num_satellites SMALLINT,
    fix_quality    SMALLINT,
    satellites     JSONB DEFAULT '[]'::jsonb,
    g_x            NUMERIC(6, 3),
    g_y            NUMERIC(6, 3),
    g_z            NUMERIC(6, 3),
    CONSTRAINT uq_profile_timestamp UNIQUE (profile_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);
CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));
CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_epochs_profile_ts ON epochs (profile_id, timestamp DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS user_sessions (
    token      VARCHAR(128) PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days')
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS parser_jobs (
    job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    profile_id      UUID REFERENCES profiles(profile_id) ON DELETE SET NULL,
    profile_name    VARCHAR(64),
    filename        TEXT NOT NULL,
    file_size       BIGINT NOT NULL DEFAULT 0,
    stage           VARCHAR(64) NOT NULL DEFAULT 'queued',
    status          VARCHAR(32) NOT NULL DEFAULT 'queued',
    percent         INTEGER NOT NULL DEFAULT 0,
    epochs          BIGINT NOT NULL DEFAULT 0,
    satellites      BIGINT NOT NULL DEFAULT 0,
    eta_str         VARCHAR(32),
    eta_seconds     BIGINT NOT NULL DEFAULT 0,
    speed_mb_s      NUMERIC(8, 2) NOT NULL DEFAULT 0,
    message         TEXT,
    error           TEXT,
    abort_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parser_jobs_user_id ON parser_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_parser_jobs_status ON parser_jobs (status);

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

-- +goose Down
-- SQL in this section is executed when the migration is rolled back.
DROP TABLE IF EXISTS map_drawings CASCADE;
DROP TABLE IF EXISTS layer_presets CASCADE;
DROP TABLE IF EXISTS parser_jobs CASCADE;
DROP TABLE IF EXISTS user_sessions CASCADE;
DROP TABLE IF EXISTS epochs CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS users CASCADE;

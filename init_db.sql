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
    epoch_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id       UUID NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
    terminator       VARCHAR(16),
    time_diff        NUMERIC(8, 3),
    distance         NUMERIC(10, 4),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    inactive_reasons TEXT[] NOT NULL DEFAULT '{}',
    latitude         NUMERIC(10, 6),
    longitude        NUMERIC(11, 6),
    geom             GEOMETRY(Point, 4326),
    timestamp        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_epochs_profile_id ON epochs (profile_id);
CREATE INDEX IF NOT EXISTS idx_epochs_is_active  ON epochs (is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_epochs_geom       ON epochs USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_epochs_timestamp  ON epochs (timestamp);

-- ============================================================================
-- 3. BAZOWA TABELA ZDAŃ NMEA
-- ============================================================================

CREATE TABLE IF NOT EXISTS sentence (
    sentence_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id    UUID NOT NULL REFERENCES epochs(epoch_id) ON DELETE CASCADE,
    raw         TEXT,
    checksum    CHAR(2),
    parts_count SMALLINT
);

CREATE INDEX IF NOT EXISTS idx_sentence_epoch_id ON sentence (epoch_id);

-- ============================================================================
-- 4. RAMKI SZCZEGÓŁOWE
-- ============================================================================

CREATE TABLE IF NOT EXISTS gsensord (
    sentence_id UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    g_x         NUMERIC(6, 3),
    g_y         NUMERIC(6, 3),
    g_z         NUMERIC(6, 3)
);

CREATE TABLE IF NOT EXISTS gprmc (
    sentence_id                   UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    time_utc                      TIME,
    status                        CHAR(1),
    latitude                      NUMERIC(10, 6),
    latitude_hemisphere           CHAR(1),
    longitude                     NUMERIC(11, 6),
    longitude_hemisphere          CHAR(1),
    speed_knots                   NUMERIC(6, 2),
    course                        NUMERIC(5, 2),
    date                          DATE,
    magnetic_variation            NUMERIC(5, 2),
    magnetic_variation_hemisphere CHAR(1),
    mode                          CHAR(1),
    latitude_new                  NUMERIC(10, 6),
    longitude_new                 NUMERIC(11, 6),
    CONSTRAINT uq_gprmc_date_time UNIQUE (date, time_utc)
);

CREATE TABLE IF NOT EXISTS gpvtg (
    sentence_id              UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    course_true              NUMERIC(5, 2),
    course_true_indicator    CHAR(1),
    course_magnetic          NUMERIC(5, 2),
    course_magnetic_indicator CHAR(1),
    speed_knots              NUMERIC(6, 2),
    speed_knots_indicator    CHAR(1),
    speed_kmh                NUMERIC(6, 2),
    speed_kmh_indicator      CHAR(1),
    mode                     CHAR(1)
);

CREATE TABLE IF NOT EXISTS gpgga (
    sentence_id            UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    time_utc               TIME,
    latitude               NUMERIC(10, 6),
    latitude_hemisphere    CHAR(1),
    longitude              NUMERIC(11, 6),
    longitude_hemisphere   CHAR(1),
    fix_quality            SMALLINT,
    satellites_used        SMALLINT,
    hdop                   NUMERIC(4, 2),
    altitude               NUMERIC(7, 2),
    altitude_units         CHAR(1),
    geoid_separation       NUMERIC(6, 2),
    geoid_separation_units CHAR(1),
    dgps_age               NUMERIC(5, 1),
    dgps_station_id        VARCHAR(32),
    latitude_new           NUMERIC(10, 6),
    longitude_new          NUMERIC(11, 6)
);

CREATE TABLE IF NOT EXISTS gpgsa (
    sentence_id   UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    mode1         CHAR(1),
    mode2         SMALLINT,
    satellite_1   SMALLINT,
    satellite_2   SMALLINT,
    satellite_3   SMALLINT,
    satellite_4   SMALLINT,
    satellite_5   SMALLINT,
    satellite_6   SMALLINT,
    satellite_7   SMALLINT,
    satellite_8   SMALLINT,
    satellite_9   SMALLINT,
    satellite_10  SMALLINT,
    satellite_11  SMALLINT,
    satellite_12  SMALLINT,
    pdop          NUMERIC(4, 2),
    hdop          NUMERIC(4, 2),
    vdop          NUMERIC(4, 2)
);

CREATE TABLE IF NOT EXISTS gpgsv (
    sentence_id        UUID PRIMARY KEY REFERENCES sentence(sentence_id) ON DELETE CASCADE,
    total_messages     SMALLINT,
    message_number     SMALLINT,
    satellites_in_view SMALLINT
);

CREATE TABLE IF NOT EXISTS satellite (
    satellite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sentence_id  UUID NOT NULL REFERENCES gpgsv(sentence_id) ON DELETE CASCADE,
    prn          SMALLINT,
    elevation    SMALLINT,
    azimuth      SMALLINT,
    snr          SMALLINT
);

CREATE INDEX IF NOT EXISTS idx_satellite_sentence_id ON satellite (sentence_id);
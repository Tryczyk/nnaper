-- +goose Up
-- SQL in this section is executed when the migration is applied.
DROP TABLE IF EXISTS satellite CASCADE;

-- +goose Down
-- SQL in this section is executed when the migration is rolled back.
CREATE TABLE IF NOT EXISTS satellite (
    satellite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    epoch_id     UUID NOT NULL REFERENCES epochs(epoch_id) ON DELETE CASCADE,
    prn          SMALLINT,
    elevation    SMALLINT,
    azimuth      SMALLINT
);
CREATE INDEX IF NOT EXISTS idx_satellite_epoch_id ON satellite (epoch_id);

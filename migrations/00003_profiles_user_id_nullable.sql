-- +goose Up
-- SQL in this section is executed when the migration is applied.
ALTER TABLE profiles ALTER COLUMN user_id DROP NOT NULL;

-- +goose Down
-- SQL in this section is executed when the migration is rolled back.
ALTER TABLE profiles ALTER COLUMN user_id SET NOT NULL;

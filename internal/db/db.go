package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DB struct {
	Pool *pgxpool.Pool
}

func Connect(ctx context.Context, connString string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, fmt.Errorf("błąd parsowania DB_URL: %w", err)
	}

	cfg.MaxConns = 32
	cfg.MinConns = 4
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("błąd łączenia z PostgreSQL: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	if err := pool.Ping(pingCtx); err != nil {
		return nil, fmt.Errorf("błąd pingowania bazy danych: %w", err)
	}

	database := &DB{Pool: pool}
	if err := database.EnsureSchema(ctx); err != nil {
		fmt.Printf("[DB WARNING] Błąd inicjalizacji schematu: %v\n", err)
	}

	return database, nil
}

func (d *DB) Close() {
	if d.Pool != nil {
		d.Pool.Close()
	}
}

func (d *DB) EnsureSchema(ctx context.Context) error {
	queries := []string{
		`CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
		`CREATE EXTENSION IF NOT EXISTS postgis;`,
		`CREATE TABLE IF NOT EXISTS users (
			user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			username      VARCHAR(64) NOT NULL UNIQUE,
			email         VARCHAR(255) UNIQUE,
			password_hash VARCHAR(255) NOT NULL,
			avatar_url    TEXT,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`,
		`ALTER TABLE users ALTER COLUMN email DROP NOT NULL;`,
		`CREATE TABLE IF NOT EXISTS profiles (
			profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
			name       VARCHAR(64) NOT NULL,
			avatar_url TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT uq_user_profile_name UNIQUE (user_id, name)
		);`,
		`CREATE TABLE IF NOT EXISTS user_sessions (
			token      VARCHAR(128) PRIMARY KEY,
			user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions (user_id);`,
		`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_snapped GEOMETRY(Point, 4326);`,
		`ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_line GEOMETRY(LineString, 4326);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_profile_id ON epochs (profile_id);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_profile_ts ON epochs (profile_id, timestamp DESC NULLS LAST);`,
		`CREATE INDEX IF NOT EXISTS idx_epochs_ts_desc ON epochs (timestamp DESC NULLS LAST);`,
		`UPDATE epochs SET profile_id = (SELECT profile_id FROM profiles ORDER BY created_at ASC LIMIT 1) WHERE profile_id IS NULL AND EXISTS (SELECT 1 FROM profiles);`,
		`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS epochs_count BIGINT NOT NULL DEFAULT 0;`,
		`UPDATE profiles p
		 SET epochs_count = sub.cnt
		 FROM (
		     SELECT profile_id, count(*) AS cnt
		     FROM epochs
		     GROUP BY profile_id
		 ) sub
		 WHERE p.profile_id = sub.profile_id AND p.epochs_count = 0;`,
	}

	for _, q := range queries {
		if _, err := d.Pool.Exec(ctx, q); err != nil {
			// Ignorujemy błędy przy istniejących już elementach
		}
	}
	return nil
}


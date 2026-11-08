package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBClient zarządza połączeniem z PostgreSQL i szybkim zapisem danych
type DBClient struct {
	pool *pgxpool.Pool
}

func NewDBClient(dbURL string) (*DBClient, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("błąd parsowania URL bazy: %w", err)
	}

	config.MaxConns = 16
	config.MinConns = 2
	config.MaxConnLifetime = 30 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("błąd łączenia z PostgreSQL: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("błąd ping PostgreSQL: %w", err)
	}

	// Optymalizacje parametrów transakcji
	_, _ = pool.Exec(ctx, "SET synchronous_commit = 'OFF'; SET work_mem = '64MB';")

	return &DBClient{pool: pool}, nil
}

func (db *DBClient) Close() {
	if db.pool != nil {
		db.pool.Close()
	}
}

// EnsureSchema tworzy brakujące indeksy i tabele
func (db *DBClient) EnsureSchema(ctx context.Context) error {
	queries := []string{
		"CREATE EXTENSION IF NOT EXISTS pgcrypto;",
		"CREATE EXTENSION IF NOT EXISTS postgis;",
		"ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_snapped GEOMETRY(Point, 4326);",
		"ALTER TABLE epochs ADD COLUMN IF NOT EXISTS geom_line GEOMETRY(LineString, 4326);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_profile_id ON epochs (profile_id);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);",
	}

	for _, q := range queries {
		if _, err := db.pool.Exec(ctx, q); err != nil {
			// Ignorujemy niekrytyczne błędy przy istniejących indeksach
		}
	}
	return nil
}

// GetLastPoint pobiera ostatni punkt profilu do wyliczania prędkości
func (db *DBClient) GetLastPoint(ctx context.Context, profileID string) (*time.Time, float64, float64, error) {
	row := db.pool.QueryRow(ctx, `
		SELECT timestamp, ST_Y(geom), ST_X(geom)
		FROM epochs
		WHERE profile_id = $1::uuid
		ORDER BY timestamp DESC NULLS LAST
		LIMIT 1
	`, profileID)

	var ts *time.Time
	var lat, lon *float64
	err := row.Scan(&ts, &lat, &lon)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, 0, 0, nil
		}
		return nil, 0, 0, err
	}

	if lat == nil || lon == nil {
		return ts, 0, 0, nil
	}
	return ts, *lat, *lon, nil
}

// SaveBatch zapisuje partię epok oraz powiązanych satelitów do bazy
func (db *DBClient) SaveBatch(ctx context.Context, epochs []*Epoch) error {
	if len(epochs) == 0 {
		return nil
	}

	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Wyłączenie synchronicznego commita w obrębie transakcji wsadowej
	_, _ = tx.Exec(ctx, "SET LOCAL synchronous_commit = 'OFF';")

	// Tabela tymczasowa dla stagingu
	_, err = tx.Exec(ctx, `
		CREATE TEMP TABLE staging_epochs (
			LIKE epochs INCLUDING DEFAULTS
		) ON COMMIT DROP;
	`)
	if err != nil {
		return fmt.Errorf("błąd create temp staging_epochs: %w", err)
	}

	// Przygotowanie wierszy do CopyFrom
	rows := make([][]interface{}, len(epochs))
	var satelliteRows [][]interface{}

	for i, ep := range epochs {
		var snappedGeom interface{} = nil
		if ep.GeomSnapped != "" {
			snappedGeom = ep.GeomSnapped
		}
		var lineGeom interface{} = nil
		if ep.GeomLine != "" {
			lineGeom = ep.GeomLine
		}

		rows[i] = []interface{}{
			ep.ID,
			ep.ProfileID,
			ep.Timestamp,
			ep.GeomWKT,
			ep.SpeedKmh,
			ep.GX,
			ep.GY,
			ep.GZ,
			snappedGeom,
			lineGeom,
		}

		for _, sat := range ep.Satellites {
			satelliteRows = append(satelliteRows, []interface{}{
				nil, // satellite_id DEFAULT gen_random_uuid()
				ep.ID,
				sat.PRN,
				sat.Elevation,
				sat.Azimuth,
			})
		}
	}

	// 1. Kopiowanie binarne do tabeli tymczasowej
	copyCols := []string{
		"epoch_id", "profile_id", "timestamp", "geom", "speed_kmh", "g_x", "g_y", "g_z", "geom_snapped", "geom_line",
	}
	_, err = tx.CopyFrom(
		ctx,
		pgx.Identifier{"staging_epochs"},
		copyCols,
		pgx.CopyFromRows(rows),
	)
	if err != nil {
		return fmt.Errorf("błąd CopyFrom staging_epochs: %w", err)
	}

	// 2. Scalenie z tabelą epochs z obsługą duplikatów
	_, err = tx.Exec(ctx, `
		INSERT INTO epochs (
			epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
		)
		SELECT
			epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
		FROM staging_epochs
		ON CONFLICT (profile_id, timestamp) DO UPDATE SET
			geom_snapped = EXCLUDED.geom_snapped,
			geom_line = EXCLUDED.geom_line;
	`)
	if err != nil {
		return fmt.Errorf("błąd INSERT INTO epochs ON CONFLICT: %w", err)
	}

	// 3. Zapis satelitów (jeśli obecne)
	if len(satelliteRows) > 0 {
		_, err = tx.Exec(ctx, `
			CREATE TEMP TABLE staging_satellite (
				LIKE satellite INCLUDING DEFAULTS
			) ON COMMIT DROP;
		`)
		if err == nil {
			satCols := []string{"satellite_id", "epoch_id", "prn", "elevation", "azimuth"}
			_, err = tx.CopyFrom(
				ctx,
				pgx.Identifier{"staging_satellite"},
				satCols,
				pgx.CopyFromRows(satelliteRows),
			)
			if err == nil {
				_, _ = tx.Exec(ctx, `
					INSERT INTO satellite (satellite_id, epoch_id, prn, elevation, azimuth)
					SELECT COALESCE(s.satellite_id, gen_random_uuid()), s.epoch_id, s.prn, s.elevation, s.azimuth
					FROM staging_satellite s
					JOIN epochs e ON s.epoch_id = e.epoch_id;
				`)
			}
		}
	}

	return tx.Commit(ctx)
}


package parser

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBClient zarządza połączeniem z PostgreSQL i szybkim zapisem danych
type DBClient struct {
	pool    *pgxpool.Pool
	ownPool bool
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

	_, _ = pool.Exec(ctx, "SET synchronous_commit = 'OFF'; SET work_mem = '64MB';")

	return &DBClient{pool: pool, ownPool: true}, nil
}

func NewDBClientFromPool(pool *pgxpool.Pool) *DBClient {
	return &DBClient{pool: pool, ownPool: false}
}

func (db *DBClient) Close() {
	if db.ownPool && db.pool != nil {
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
		"CREATE INDEX IF NOT EXISTS idx_epochs_profile_ts ON epochs (profile_id, timestamp DESC NULLS LAST);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom ON epochs USING GIST (geom);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_snapped ON epochs USING GIST (geom_snapped);",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_active ON epochs USING GIST (COALESCE(geom_snapped, geom));",
		"CREATE INDEX IF NOT EXISTS idx_epochs_geom_line ON epochs USING GIST (geom_line);",
	}

	for _, q := range queries {
		_, _ = db.pool.Exec(ctx, q)
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

	_, _ = tx.Exec(ctx, "SET LOCAL synchronous_commit = 'OFF';")

	_, err = tx.Exec(ctx, `
		CREATE TEMP TABLE staging_epochs (
			epoch_id     UUID,
			profile_id   UUID,
			timestamp    TIMESTAMPTZ,
			geom         TEXT,
			speed_kmh    NUMERIC,
			g_x          NUMERIC,
			g_y          NUMERIC,
			g_z          NUMERIC,
			geom_snapped TEXT,
			geom_line    TEXT
		) ON COMMIT DROP;
	`)
	if err != nil {
		return fmt.Errorf("błąd create temp staging_epochs: %w", err)
	}

	rows := make([][]interface{}, len(epochs))
	var satelliteRows [][]interface{}

	for i, ep := range epochs {
		if len(ep.ID) != 36 {
			ep.ID = NewUUID()
		}
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
				NewUUID(),
				ep.ID,
				sat.PRN,
				sat.Elevation,
				sat.Azimuth,
			})
		}
	}

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

	_, err = tx.Exec(ctx, `
		INSERT INTO epochs (
			epoch_id, profile_id, timestamp, geom, speed_kmh, g_x, g_y, g_z, geom_snapped, geom_line
		)
		SELECT DISTINCT ON (profile_id, timestamp)
			epoch_id,
			profile_id,
			timestamp,
			ST_GeomFromEWKT(geom),
			speed_kmh,
			g_x,
			g_y,
			g_z,
			CASE WHEN geom_snapped IS NOT NULL AND geom_snapped != '' THEN ST_GeomFromEWKT(geom_snapped) ELSE NULL END,
			CASE WHEN geom_line IS NOT NULL AND geom_line != '' THEN ST_GeomFromEWKT(geom_line) ELSE NULL END
		FROM staging_epochs
		WHERE timestamp IS NOT NULL
		ORDER BY profile_id, timestamp, (geom_snapped IS NOT NULL AND geom_snapped != '') DESC, epoch_id
		ON CONFLICT (profile_id, timestamp) DO UPDATE SET
			geom_snapped = COALESCE(EXCLUDED.geom_snapped, epochs.geom_snapped),
			geom_line = COALESCE(EXCLUDED.geom_line, epochs.geom_line);
	`)
	if err != nil {
		return fmt.Errorf("błąd INSERT INTO epochs ON CONFLICT: %w", err)
	}

	if len(satelliteRows) > 0 {
		_, err = tx.Exec(ctx, `
			CREATE TEMP TABLE staging_satellite (
				satellite_id UUID,
				epoch_id     UUID,
				prn          SMALLINT,
				elevation    SMALLINT,
				azimuth      SMALLINT
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
					SELECT DISTINCT ON (s.epoch_id, s.prn)
						s.satellite_id, s.epoch_id, s.prn, s.elevation, s.azimuth
					FROM staging_satellite s
					JOIN epochs e ON s.epoch_id = e.epoch_id
					ON CONFLICT DO NOTHING;
				`)
			}
		}
	}

	return tx.Commit(ctx)
}


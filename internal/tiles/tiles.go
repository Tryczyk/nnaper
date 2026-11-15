package tiles

import (
	"container/list"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type lruEntry struct {
	key   string
	value []byte
}

type LRUCache struct {
	capacity int
	mu       sync.RWMutex
	items    map[string]*list.Element
	evict    *list.List
}

func NewLRUCache(capacity int) *LRUCache {
	if capacity <= 0 {
		capacity = 8192
	}
	return &LRUCache{
		capacity: capacity,
		items:    make(map[string]*list.Element),
		evict:    list.New(),
	}
}

func (c *LRUCache) Get(key string) ([]byte, bool) {
	c.mu.RLock()
	elem, ok := c.items[key]
	if !ok {
		c.mu.RUnlock()
		return nil, false
	}
	val := elem.Value.(*lruEntry).value
	c.mu.RUnlock()

	c.mu.Lock()
	if elem, ok := c.items[key]; ok {
		c.evict.MoveToFront(elem)
	}
	c.mu.Unlock()

	return val, true
}

func (c *LRUCache) Set(key string, value []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.evict.MoveToFront(elem)
		elem.Value.(*lruEntry).value = value
		return
	}

	elem := c.evict.PushFront(&lruEntry{key: key, value: value})
	c.items[key] = elem

	if c.evict.Len() > c.capacity {
		oldest := c.evict.Back()
		if oldest != nil {
			c.evict.Remove(oldest)
			delete(c.items, oldest.Value.(*lruEntry).key)
		}
	}
}

func (c *LRUCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.items = make(map[string]*list.Element)
	c.evict.Init()
}

type Service struct {
	pool  *pgxpool.Pool
	cache *LRUCache
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{
		pool:  pool,
		cache: NewLRUCache(8192),
	}
}

func (s *Service) ClearCache() {
	s.cache.Clear()
}

func (s *Service) HandleClearCache(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(r.Context(), s.pool, token, authHeader)
	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"status":"unauthorized","error":"Wymagana autoryzacja"}`))
		return
	}

	s.ClearCache()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok","message":"Pamięć podręczna kafelków została wyczyszczona"}`))
}

func (s *Service) HandleGetTrackTile(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(r.Context(), s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		return
	}

	zStr := chi.URLParam(r, "z")
	xStr := chi.URLParam(r, "x")
	yStr := chi.URLParam(r, "y")

	z, errZ := strconv.Atoi(zStr)
	x, errX := strconv.Atoi(xStr)
	y, errY := strconv.Atoi(yStr)

	if errZ != nil || errX != nil || errY != nil || z < 0 || x < 0 || y < 0 || (z < 31 && (x >= (1<<z) || y >= (1<<z))) {
		http.Error(w, `{"detail":"Nieprawidłowe współrzędne kafelka"}`, http.StatusBadRequest)
		return
	}

	query := r.URL.Query()
	days := query.Get("days")
	snapped := query.Get("snapped") == "true"
	mode := query.Get("mode")
	if mode == "" {
		mode = "raw"
	}
	if snapped && mode == "raw" {
		mode = "snapped"
	}
	profileID := query.Get("profile_id")
	isAtomic := query.Get("atomic") == "true" || z >= 14

	cacheKey := fmt.Sprintf("%s:%s:%d:%d:%d:%s:%t:%s:%t", userID, profileID, z, x, y, days, snapped, mode, isAtomic)
	if cached, ok := s.cache.Get(cacheKey); ok {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "private, max-age=1800, stale-while-revalidate=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(cached)
		return
	}

	var dayList []string
	if days != "" && days != "__none__" && days != "none" && days != "empty" && days != "false" && days != "all" && days != "0" && days != "all-history" {
		for _, d := range strings.Split(days, ",") {
			d = strings.TrimSpace(d)
			if d != "" {
				dayList = append(dayList, d)
			}
		}
	}

	args := []interface{}{z, x, y}
	nextArg := 4

	var activeGeom, latLonFields string
	var whereClauses []string

	if mode == "osm" {
		activeGeom = "e.geom_line"
		whereClauses = append(whereClauses,
			"e.geom_line IS NOT NULL",
			"e.geom_snapped IS NOT NULL",
			"COALESCE(e.speed_kmh, 10) >= 3.5",
			"ST_Distance(e.geom, e.geom_snapped) <= 0.00018",
			"ST_Length(e.geom_line) BETWEEN 0.000015 AND 0.00042",
			"e.geom_line && ST_Transform(ST_TileEnvelope($1, $2, $3), 4326)",
		)
		latLonFields = "NULL::numeric AS latitude, NULL::numeric AS longitude,"
	} else if mode == "snapped" || snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
		whereClauses = append(whereClauses,
			fmt.Sprintf("%s && ST_Transform(ST_TileEnvelope($1, $2, $3), 4326)", activeGeom),
		)
		latLonFields = fmt.Sprintf("round(ST_Y(%s)::numeric, 6) AS latitude, round(ST_X(%s)::numeric, 6) AS longitude,", activeGeom, activeGeom)
	} else {
		activeGeom = "e.geom"
		whereClauses = append(whereClauses,
			fmt.Sprintf("%s && ST_Transform(ST_TileEnvelope($1, $2, $3), 4326)", activeGeom),
		)
		latLonFields = fmt.Sprintf("round(ST_Y(%s)::numeric, 6) AS latitude, round(ST_X(%s)::numeric, 6) AS longitude,", activeGeom, activeGeom)
	}

	if profileID != "" && profileID != "all" && profileID != "__all__" {
		whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1))
		args = append(args, profileID, userID)
		nextArg += 2
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg))
		args = append(args, userID)
		nextArg++
	}

	if days == "__none__" || days == "none" || days == "empty" || days == "false" {
		whereClauses = append(whereClauses, "FALSE")
	} else if days == "all" || days == "0" || days == "all-history" {
		// Brak filtra dat - zwracamy całą historię
	} else if len(dayList) > 0 {
		var validDates []string
		var yearList []string
		var monthList []string
		hasNullDate := false
		for _, d := range dayList {
			if d == "None" || d == "null" {
				hasNullDate = true
			} else if len(d) == 4 {
				yearList = append(yearList, d)
			} else if len(d) == 7 {
				monthList = append(monthList, d)
			} else if len(d) == 10 {
				validDates = append(validDates, d)
			}
		}

		var dateConditions []string
		if len(validDates) > 0 {
			minDate := validDates[0]
			maxDate := validDates[0]
			for _, vd := range validDates {
				if vd < minDate {
					minDate = vd
				}
				if vd > maxDate {
					maxDate = vd
				}
			}
			dateConditions = append(dateConditions, fmt.Sprintf("(e.timestamp::date = ANY($%d::date[]) AND e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 day'))", nextArg, nextArg+1, nextArg+2))
			args = append(args, validDates, minDate, maxDate)
			nextArg += 3
		}
		for _, y := range yearList {
			dateConditions = append(dateConditions, fmt.Sprintf("(e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 year'))", nextArg, nextArg))
			args = append(args, y+"-01-01")
			nextArg++
		}
		for _, m := range monthList {
			dateConditions = append(dateConditions, fmt.Sprintf("(e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 month'))", nextArg, nextArg))
			args = append(args, m+"-01")
			nextArg++
		}
		if hasNullDate {
			dateConditions = append(dateConditions, "(e.timestamp IS NULL)")
		}

		if len(dateConditions) > 0 {
			whereClauses = append(whereClauses, fmt.Sprintf("(%s)", strings.Join(dateConditions, " OR ")))
		} else {
			whereClauses = append(whereClauses, "FALSE")
		}
	}

	whereSQL := strings.Join(whereClauses, " AND ")

	var sqlQuery string
	if mode == "osm" {
		snapGrid := "0.00001"
		if z >= 15 {
			snapGrid = "0.00002"
		}
		sqlQuery = fmt.Sprintf(`
			WITH bounds AS (
				SELECT ST_TileEnvelope($1, $2, $3) AS geom
			),
			grouped_lines AS (
				SELECT
					min(e.epoch_id::text) AS epoch_id,
					COALESCE(e.timestamp::date::text, 'None') AS day,
					min(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS timestamp,
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None') AS h,
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None') AS m,
					min(COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS'), 'None')) AS s,
					NULL::numeric AS latitude,
					NULL::numeric AS longitude,
					ST_LineMerge(ST_SnapToGrid(ST_Collect(e.geom_line), %s)) AS continuous_geom
				FROM epochs e
				WHERE %s
				GROUP BY
					COALESCE(e.timestamp::date::text, 'None'),
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None'),
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None')
			),
			tile_features AS (
				SELECT
					epoch_id, day, timestamp, h, m, s, latitude, longitude,
					ST_AsMVTGeom(
						ST_Transform(continuous_geom, 3857),
						bounds.geom,
						4096,
						256,
						TRUE
					) AS geom
				FROM grouped_lines
				CROSS JOIN bounds
				WHERE continuous_geom IS NOT NULL AND NOT ST_IsEmpty(continuous_geom)
			)
			SELECT COALESCE(ST_AsMVT(tile_features, 'gps-track', 4096, 'geom'), ''::bytea)
			FROM tile_features
			WHERE geom IS NOT NULL;
		`, snapGrid, whereSQL)
	} else if !isAtomic {
		gridSize := 360.0 / (float64(uint64(1)<<z) * 1024.0)
		if z <= 7 {
			gridSize = 360.0 / (float64(uint64(1)<<z) * 512.0)
		}
		gridArg := nextArg
		args = append(args, gridSize)
		nextArg++

		sqlQuery = fmt.Sprintf(`
			WITH bounds AS (
				SELECT ST_TileEnvelope($1, $2, $3) AS geom
			),
			decimated AS (
				SELECT DISTINCT ON (
					ST_SnapToGrid(%s, $%d),
					COALESCE(e.timestamp::date::text, 'None')
				)
					COALESCE(e.timestamp::date::text, 'None') AS day,
					%s AS geom_pt
				FROM epochs e
				CROSS JOIN bounds
				WHERE %s
				ORDER BY ST_SnapToGrid(%s, $%d), COALESCE(e.timestamp::date::text, 'None'), e.timestamp ASC
			),
			tile_features AS (
				SELECT
					NULL::text AS epoch_id,
					day,
					NULL::text AS timestamp,
					NULL::text AS h,
					NULL::text AS m,
					NULL::text AS s,
					NULL::numeric AS latitude,
					NULL::numeric AS longitude,
					ST_AsMVTGeom(
						ST_Transform(geom_pt, 3857),
						bounds.geom,
						4096,
						256,
						TRUE
					) AS geom
				FROM decimated
				CROSS JOIN bounds
			)
			SELECT COALESCE(ST_AsMVT(tile_features, 'gps-track', 4096, 'geom'), ''::bytea)
			FROM tile_features
			WHERE geom IS NOT NULL;
		`, activeGeom, gridArg, activeGeom, whereSQL, activeGeom, gridArg)
	} else {
		sqlQuery = fmt.Sprintf(`
			WITH bounds AS (
				SELECT ST_TileEnvelope($1, $2, $3) AS geom
			),
			tile_features AS (
				SELECT
					e.epoch_id::text AS epoch_id,
					COALESCE(e.timestamp::date::text, 'None') AS day,
					to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24'), 'None') AS h,
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI'), 'None') AS m,
					COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS'), 'None') AS s,
					%s
					ST_AsMVTGeom(
						ST_Transform(%s, 3857),
						bounds.geom,
						4096,
						256,
						TRUE
					) AS geom
				FROM epochs e
				CROSS JOIN bounds
				WHERE %s
			)
			SELECT COALESCE(ST_AsMVT(tile_features, 'gps-track', 4096, 'geom'), ''::bytea)
			FROM tile_features
			WHERE geom IS NOT NULL;
		`, latLonFields, activeGeom, whereSQL)
	}

	ctx := r.Context()
	var tileBytes []byte

	err := s.pool.QueryRow(ctx, sqlQuery, args...).Scan(&tileBytes)
	if err != nil {
		// Log error and return empty MVT
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		return
	}

	if tileBytes == nil {
		tileBytes = []byte{}
	}

	s.cache.Set(cacheKey, tileBytes)

	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	w.Header().Set("Cache-Control", "public, max-age=1800, stale-while-revalidate=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(tileBytes)
}

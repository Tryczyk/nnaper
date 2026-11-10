package epochs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
	"nnaper/internal/tiles"
)

type Service struct {
	pool  *pgxpool.Pool
	tiles *tiles.Service
}

func NewService(pool *pgxpool.Pool, tilesService *tiles.Service) *Service {
	return &Service{
		pool:  pool,
		tiles: tilesService,
	}
}

func (s *Service) HandleGetEpoch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Brak autoryzacji"}`))
		return
	}

	epochID := chi.URLParam(r, "epoch_id")

	query := `
		SELECT json_build_object(
			'epoch_id', e.epoch_id,
			'profile_id', e.profile_id,
			'timestamp', e.timestamp,
			'latitude', round(ST_Y(e.geom)::numeric, 6),
			'longitude', round(ST_X(e.geom)::numeric, 6),
			'snapped_latitude', CASE WHEN e.geom_snapped IS NOT NULL THEN round(ST_Y(e.geom_snapped)::numeric, 6) ELSE NULL END,
			'snapped_longitude', CASE WHEN e.geom_snapped IS NOT NULL THEN round(ST_X(e.geom_snapped)::numeric, 6) ELSE NULL END,
			'altitude', NULL,
			'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 220.0),
			'g_x', e.g_x,
			'g_y', e.g_y,
			'g_z', e.g_z,
			'satellites', COALESCE(
				(SELECT json_agg(json_build_object(
					'prn', sat.prn,
					'elevation', sat.elevation,
					'azimuth', sat.azimuth
				) ORDER BY sat.prn)
				 FROM satellite sat
				 WHERE sat.epoch_id = e.epoch_id),
				'[]'::json
			)
		)::text
		FROM epochs e
		WHERE e.epoch_id = $1::uuid
		  AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid);
	`

	var epochJSON *string
	err := s.pool.QueryRow(ctx, query, epochID, userID).Scan(&epochJSON)
	if err != nil || epochJSON == nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"Epoch not found"}`))
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(*epochJSON))
}

func (s *Service) HandleDeleteEpoch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	epochID := chi.URLParam(r, "epoch_id")

	query := `
		DELETE FROM epochs
		WHERE epoch_id = $1::uuid
		  AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)
		RETURNING epoch_id;
	`

	var deletedID string
	err := s.pool.QueryRow(ctx, query, epochID, userID).Scan(&deletedID)
	if err != nil {
		http.Error(w, `{"detail":"Punkt nie istnieje lub brak uprawnień do jego usunięcia"}`, http.StatusNotFound)
		return
	}

	s.tiles.ClearCache()
	_, _ = s.pool.Exec(ctx, `UPDATE profiles p SET epochs_count = (SELECT count(*) FROM epochs WHERE profile_id = p.profile_id) WHERE p.user_id = $1::uuid`, userID)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"message":  "Punkt został trwale usunięty z bazy",
		"epoch_id": epochID,
	})
}

func (s *Service) HandleDeleteEpochsDay(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	day := r.URL.Query().Get("day")
	if day == "" {
		http.Error(w, `{"detail":"Brak parametru day"}`, http.StatusBadRequest)
		return
	}
	profileID := r.URL.Query().Get("profile_id")

	var whereProfile string
	var args []interface{}
	nextArg := 1

	if profileID != "" && profileID != "all" && profileID != "__all__" {
		whereProfile = fmt.Sprintf("profile_id = $%d::uuid AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1)
		args = append(args, profileID, userID)
		nextArg += 2
	} else {
		whereProfile = fmt.Sprintf("profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg)
		args = append(args, userID)
		nextArg++
	}

	var whereTime string
	if day == "None" || day == "null" {
		whereTime = "timestamp IS NULL"
	} else {
		if _, err := time.Parse("2006-01-02", day); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None."}`, http.StatusBadRequest)
			return
		}
		whereTime = fmt.Sprintf("timestamp >= $%d::date AND timestamp < ($%d::date + INTERVAL '1 day')", nextArg, nextArg)
		args = append(args, day)
		nextArg++
	}

	query := fmt.Sprintf(`
		DELETE FROM epochs
		WHERE %s
		  AND %s
		RETURNING epoch_id;
	`, whereProfile, whereTime)

	tag, err := s.pool.Exec(ctx, query, args...)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd bazy danych: %v"}`, err), http.StatusInternalServerError)
		return
	}

	s.tiles.ClearCache()
	_, _ = s.pool.Exec(ctx, `UPDATE profiles p SET epochs_count = (SELECT count(*) FROM epochs WHERE profile_id = p.profile_id) WHERE p.user_id = $1::uuid`, userID)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"deleted_count": tag.RowsAffected(),
		"day":           day,
	})
}

type BatchDeletePayload struct {
	EpochIDs []string `json:"epoch_ids"`
}

func (s *Service) HandleDeleteEpochsBatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	var payload BatchDeletePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"detail":"Niepoprawne dane JSON"}`, http.StatusBadRequest)
		return
	}

	if len(payload.EpochIDs) == 0 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"success":true,"deleted_count":0}`))
		return
	}

	query := `
		DELETE FROM epochs
		WHERE epoch_id = ANY($1::uuid[])
		  AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)
		RETURNING epoch_id;
	`

	tag, err := s.pool.Exec(ctx, query, payload.EpochIDs, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd bazy danych: %v"}`, err), http.StatusInternalServerError)
		return
	}

	s.tiles.ClearCache()
	_, _ = s.pool.Exec(ctx, `UPDATE profiles p SET epochs_count = (SELECT count(*) FROM epochs WHERE profile_id = p.profile_id) WHERE p.user_id = $1::uuid`, userID)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"deleted_count": tag.RowsAffected(),
	})
}

func (s *Service) HandlePlaybackDay(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	day := r.URL.Query().Get("day")
	if day == "" {
		http.Error(w, `{"detail":"Brak parametru day"}`, http.StatusBadRequest)
		return
	}

	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte("[]"))
		return
	}

	snapped := r.URL.Query().Get("snapped") == "true"
	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	if profileID == "undefined" || profileID == "null" || profileID == "all" || profileID == "__all__" || len(profileID) != 36 {
		profileID = ""
	}

	var whereProfile string
	var args []interface{}
	nextArg := 1

	if profileID != "" {
		whereProfile = fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1)
		args = append(args, profileID, userID)
		nextArg += 2
	} else {
		whereProfile = fmt.Sprintf("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg)
		args = append(args, userID)
		nextArg++
	}

	var whereTime, orderClauseCTE, orderClauseOuter string
	if day == "None" || day == "null" {
		whereTime = "e.timestamp IS NULL"
		orderClauseCTE = "e.epoch_id ASC"
		orderClauseOuter = "de.epoch_id ASC"
	} else {
		if _, err := time.Parse("2006-01-02", day); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None."}`, http.StatusBadRequest)
			return
		}
		whereTime = fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 day')", nextArg, nextArg)
		args = append(args, day)
		orderClauseCTE = "e.timestamp ASC"
		orderClauseOuter = "de.timestamp ASC"
		nextArg++
	}

	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	query := fmt.Sprintf(`
		WITH day_epochs AS (
			SELECT 
				e.epoch_id,
				to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
				round(ST_Y(%s)::numeric, 6) AS lat,
				round(ST_X(%s)::numeric, 6) AS lon,
				NULL::numeric AS altitude,
				LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
				e.g_x,
				e.g_y,
				e.g_z
			FROM epochs e
			WHERE %s
			  AND %s
			ORDER BY %s
		),
		day_satellites AS (
			SELECT 
				s.epoch_id,
				json_agg(json_build_object(
					'prn', s.prn,
					'elevation', s.elevation,
					'azimuth', s.azimuth
				) ORDER BY s.prn) AS sats
			FROM satellite s
			JOIN day_epochs de ON s.epoch_id = de.epoch_id
			GROUP BY s.epoch_id
		)
		SELECT COALESCE(json_agg(
			json_build_object(
				'epoch_id', de.epoch_id,
				'timestamp', de.timestamp,
				'lat', de.lat,
				'lon', de.lon,
				'altitude', de.altitude,
				'speed_kmh', de.speed_kmh,
				'g_x', de.g_x,
				'g_y', de.g_y,
				'g_z', de.g_z,
				'satellites', COALESCE(ds.sats, '[]'::json)
			) ORDER BY %s
		)::text, '[]')
		FROM day_epochs de
		LEFT JOIN day_satellites ds ON de.epoch_id = ds.epoch_id;
	`, activeGeom, activeGeom, whereProfile, whereTime, orderClauseCTE, orderClauseOuter)

	var resultJSON string
	err := s.pool.QueryRow(ctx, query, args...).Scan(&resultJSON)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd bazy danych: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(resultJSON))
}

type UpdateEpochPayload struct {
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	SpeedKMH  *float64 `json:"speed_kmh"`
	Timestamp *string  `json:"timestamp"`
	GX        *float64 `json:"g_x"`
	GY        *float64 `json:"g_y"`
	GZ        *float64 `json:"g_z"`
}

// HandleUpdateEpoch umożliwia manualną edycję pojedynczego punktu GPS (współrzędne, prędkość, czas, przeciążenia G).
func (s *Service) HandleUpdateEpoch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	epochID := chi.URLParam(r, "epoch_id")
	var payload UpdateEpochPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"detail":"Niepoprawny format JSON"}`, http.StatusBadRequest)
		return
	}

	var sets []string
	var args []interface{}
	nextArg := 1

	if payload.Latitude != nil && payload.Longitude != nil {
		lat := *payload.Latitude
		lon := *payload.Longitude
		if lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			http.Error(w, `{"detail":"Nieprawidłowe współrzędne geograficzne"}`, http.StatusBadRequest)
			return
		}
		sets = append(sets, fmt.Sprintf("geom = ST_SetSRID(ST_MakePoint($%d, $%d), 4326)", nextArg, nextArg+1))
		sets = append(sets, fmt.Sprintf("geom_snapped = ST_SetSRID(ST_MakePoint($%d, $%d), 4326)", nextArg, nextArg+1))
		args = append(args, lon, lat)
		nextArg += 2
	}

	if payload.SpeedKMH != nil {
		sets = append(sets, fmt.Sprintf("speed_kmh = $%d", nextArg))
		args = append(args, *payload.SpeedKMH)
		nextArg++
	}

	if payload.Timestamp != nil {
		tsStr := strings.TrimSpace(*payload.Timestamp)
		if tsStr == "" {
			sets = append(sets, "timestamp = NULL")
		} else {
			sets = append(sets, fmt.Sprintf("timestamp = $%d::timestamptz", nextArg))
			args = append(args, tsStr)
			nextArg++
		}
	}

	if payload.GX != nil {
		sets = append(sets, fmt.Sprintf("g_x = $%d", nextArg))
		args = append(args, *payload.GX)
		nextArg++
	}
	if payload.GY != nil {
		sets = append(sets, fmt.Sprintf("g_y = $%d", nextArg))
		args = append(args, *payload.GY)
		nextArg++
	}
	if payload.GZ != nil {
		sets = append(sets, fmt.Sprintf("g_z = $%d", nextArg))
		args = append(args, *payload.GZ)
		nextArg++
	}

	if len(sets) == 0 {
		http.Error(w, `{"detail":"Brak pól do aktualizacji"}`, http.StatusBadRequest)
		return
	}

	args = append(args, epochID, userID)
	query := fmt.Sprintf(`
		UPDATE epochs
		SET %s
		WHERE epoch_id = $%d::uuid
		  AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)
		RETURNING epoch_id;
	`, strings.Join(sets, ", "), nextArg, nextArg+1)

	var updatedID string
	if err := s.pool.QueryRow(ctx, query, args...).Scan(&updatedID); err != nil {
		http.Error(w, `{"detail":"Nie znaleziono punktu lub brak uprawnień"}`, http.StatusNotFound)
		return
	}

	s.tiles.ClearCache()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"epoch_id": updatedID,
		"message":  "Punkt GPS został zaktualizowany.",
	})
}

type CreateEpochPayload struct {
	ProfileID string   `json:"profile_id"`
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	SpeedKMH  float64  `json:"speed_kmh"`
	Timestamp *string  `json:"timestamp"`
	GX        *float64 `json:"g_x"`
	GY        *float64 `json:"g_y"`
	GZ        *float64 `json:"g_z"`
}

// HandleCreateEpoch pozwala ręcznie dodać nowy punkt GPS na mapie.
func (s *Service) HandleCreateEpoch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	var payload CreateEpochPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"detail":"Niepoprawny format JSON"}`, http.StatusBadRequest)
		return
	}

	if payload.Latitude < -90 || payload.Latitude > 90 || payload.Longitude < -180 || payload.Longitude > 180 {
		http.Error(w, `{"detail":"Nieprawidłowe współrzędne geograficzne"}`, http.StatusBadRequest)
		return
	}

	targetProfileID := strings.TrimSpace(payload.ProfileID)
	var validProfileID string
	if targetProfileID != "" && targetProfileID != "all" && targetProfileID != "__all__" {
		_ = s.pool.QueryRow(ctx, `SELECT profile_id FROM profiles WHERE profile_id = $1::uuid AND user_id = $2::uuid`, targetProfileID, userID).Scan(&validProfileID)
	}
	if validProfileID == "" {
		_ = s.pool.QueryRow(ctx, `SELECT profile_id FROM profiles WHERE user_id = $1::uuid ORDER BY created_at ASC LIMIT 1`, userID).Scan(&validProfileID)
	}
	if validProfileID == "" {
		http.Error(w, `{"detail":"Brak profilu użytkownika"}`, http.StatusBadRequest)
		return
	}

	var tsVal interface{}
	if payload.Timestamp != nil && strings.TrimSpace(*payload.Timestamp) != "" {
		tsVal = strings.TrimSpace(*payload.Timestamp)
	} else {
		tsVal = time.Now().UTC().Format(time.RFC3339)
	}

	var newEpochID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO epochs (profile_id, timestamp, geom, geom_snapped, speed_kmh, g_x, g_y, g_z)
		VALUES (
			$1::uuid,
			$2::timestamptz,
			ST_SetSRID(ST_MakePoint($3, $4), 4326),
			ST_SetSRID(ST_MakePoint($3, $4), 4326),
			$5, $6, $7, $8
		)
		ON CONFLICT (profile_id, timestamp) DO UPDATE
		SET geom = EXCLUDED.geom, geom_snapped = EXCLUDED.geom_snapped, speed_kmh = EXCLUDED.speed_kmh
		RETURNING epoch_id
	`, validProfileID, tsVal, payload.Longitude, payload.Latitude, payload.SpeedKMH, payload.GX, payload.GY, payload.GZ).Scan(&newEpochID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd tworzenia punktu: %v"}`, err), http.StatusInternalServerError)
		return
	}

	s.tiles.ClearCache()
	_, _ = s.pool.Exec(ctx, `UPDATE profiles p SET epochs_count = (SELECT count(*) FROM epochs WHERE profile_id = p.profile_id) WHERE p.user_id = $1::uuid`, userID)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"epoch_id": newEpochID,
	})
}

type BoxSelectPayload struct {
	MinLat    float64  `json:"min_lat"`
	MinLon    float64  `json:"min_lon"`
	MaxLat    float64  `json:"max_lat"`
	MaxLon    float64  `json:"max_lon"`
	ProfileID string   `json:"profile_id"`
	Snapped   bool     `json:"snapped"`
	Days      []string `json:"days"`
}

// HandleBoxSelectEpochs zwraca wszystkie punkty znajdujące się wewnątrz prostokąta zaznaczenia (jak na pulpicie).
func (s *Service) HandleBoxSelectEpochs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	var payload BoxSelectPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"detail":"Niepoprawny JSON"}`, http.StatusBadRequest)
		return
	}

	if payload.MinLat > payload.MaxLat {
		payload.MinLat, payload.MaxLat = payload.MaxLat, payload.MinLat
	}
	if payload.MinLon > payload.MaxLon {
		payload.MinLon, payload.MaxLon = payload.MaxLon, payload.MinLon
	}

	activeGeom := "e.geom"
	if payload.Snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	var conds []string
	args := []interface{}{payload.MinLon, payload.MinLat, payload.MaxLon, payload.MaxLat}
	nextArg := 5

	conds = append(conds, fmt.Sprintf("%s && ST_MakeEnvelope($1, $2, $3, $4, 4326)", activeGeom))

	pID := strings.TrimSpace(payload.ProfileID)
	if pID != "" && pID != "all" && pID != "__all__" && len(pID) == 36 {
		conds = append(conds, fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1))
		args = append(args, pID, userID)
		nextArg += 2
	} else {
		conds = append(conds, fmt.Sprintf("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg))
		args = append(args, userID)
		nextArg++
	}

	if len(payload.Days) > 0 {
		var validDates []string
		hasNull := false
		for _, d := range payload.Days {
			if d == "None" || d == "null" {
				hasNull = true
			} else if len(d) == 10 {
				validDates = append(validDates, d)
			}
		}
		var dateOr []string
		if len(validDates) > 0 {
			dateOr = append(dateOr, fmt.Sprintf("e.timestamp::date = ANY($%d::date[])", nextArg))
			args = append(args, validDates)
			nextArg++
		}
		if hasNull {
			dateOr = append(dateOr, "e.timestamp IS NULL")
		}
		if len(dateOr) > 0 {
			conds = append(conds, "(" + strings.Join(dateOr, " OR ") + ")")
		}
	}

	query := fmt.Sprintf(`
		SELECT
			e.epoch_id::text,
			round(ST_Y(%s)::numeric, 6) AS lat,
			round(ST_X(%s)::numeric, 6) AS lon,
			COALESCE(e.speed_kmh, 0) AS speed_kmh,
			COALESCE(to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS ts
		FROM epochs e
		WHERE %s
		ORDER BY e.timestamp ASC NULLS LAST
		LIMIT 25000;
	`, activeGeom, activeGeom, strings.Join(conds, " AND "))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd zapytania: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	type selectedPoint struct {
		EpochID   string  `json:"epoch_id"`
		Lat       float64 `json:"lat"`
		Lon       float64 `json:"lon"`
		SpeedKMH  float64 `json:"speed_kmh"`
		Timestamp string  `json:"timestamp"`
	}
	var points []selectedPoint
	for rows.Next() {
		var pt selectedPoint
		if err := rows.Scan(&pt.EpochID, &pt.Lat, &pt.Lon, &pt.SpeedKMH, &pt.Timestamp); err == nil {
			points = append(points, pt)
		}
	}
	if points == nil {
		points = []selectedPoint{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"count":  len(points),
		"points": points,
	})
}

type BatchTranslatePayload struct {
	EpochIDs []string `json:"epoch_ids"`
	DeltaLat float64  `json:"delta_lat"`
	DeltaLon float64  `json:"delta_lon"`
}

// HandleTranslateEpochsBatch przesuwa wszystkie zaznaczone punkty o zadany wektor (delta_lat, delta_lon),
// dzięki czemu każdy punkt przesuwa się o ten sam dystans i kierunek, zachowując kształt śladu.
func (s *Service) HandleTranslateEpochsBatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	var payload BatchTranslatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, `{"detail":"Niepoprawny JSON"}`, http.StatusBadRequest)
		return
	}

	if len(payload.EpochIDs) == 0 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"success":true,"updated_count":0}`))
		return
	}

	if payload.DeltaLat < -90 || payload.DeltaLat > 90 || payload.DeltaLon < -180 || payload.DeltaLon > 180 {
		http.Error(w, `{"detail":"Wektor przesunięcia poza dopuszczalnym zakresem"}`, http.StatusBadRequest)
		return
	}

	query := `
		UPDATE epochs
		SET geom = ST_Translate(geom, $1, $2),
		    geom_snapped = CASE WHEN geom_snapped IS NOT NULL THEN ST_Translate(geom_snapped, $1, $2) ELSE NULL END,
		    geom_line = CASE WHEN geom_line IS NOT NULL THEN ST_Translate(geom_line, $1, $2) ELSE NULL END
		WHERE epoch_id = ANY($3::uuid[])
		  AND profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $4::uuid);
	`

	tag, err := s.pool.Exec(ctx, query, payload.DeltaLon, payload.DeltaLat, payload.EpochIDs, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd przesuwania punktów: %v"}`, err), http.StatusInternalServerError)
		return
	}

	s.tiles.ClearCache()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"updated_count": tag.RowsAffected(),
		"delta_lat":     payload.DeltaLat,
		"delta_lon":     payload.DeltaLon,
	})
}

// HandleTimelapseSummary zwraca chronologiczną listę dni wraz z liczbą punktów i przyrostem dystansu
// na potrzeby funkcji Timelapse zapełniania się mapy.
func (s *Service) HandleTimelapseSummary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"days":[]}`))
		return
	}

	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	var whereProfile string
	var args []interface{}
	if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		whereProfile = "e.profile_id = $1::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)"
		args = []interface{}{profileID, userID}
	} else {
		whereProfile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $1::uuid)"
		args = []interface{}{userID}
	}

	query := fmt.Sprintf(`
		SELECT
			COALESCE(e.timestamp::date::text, 'None') AS day,
			count(*) AS epochs_count,
			COALESCE(round((sum(ST_Length(e.geom_line::geography)) / 1000.0)::numeric, 2), 0) AS distance_km,
			round(AVG(ST_Y(COALESCE(e.geom_snapped, e.geom)))::numeric, 5) AS center_lat,
			round(AVG(ST_X(COALESCE(e.geom_snapped, e.geom)))::numeric, 5) AS center_lon
		FROM epochs e
		WHERE %s
		GROUP BY COALESCE(e.timestamp::date::text, 'None')
		ORDER BY CASE WHEN COALESCE(e.timestamp::date::text, 'None') = 'None' THEN '9999-99-99' ELSE e.timestamp::date::text END ASC;
	`, whereProfile)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"days":[]}`))
		return
	}
	defer rows.Close()

	type daySummary struct {
		Day          string  `json:"day"`
		EpochsCount  int64   `json:"epochs_count"`
		DistanceKM   float64 `json:"distance_km"`
		CumulativeKM float64 `json:"cumulative_km"`
		CenterLat    float64 `json:"center_lat"`
		CenterLon    float64 `json:"center_lon"`
	}

	var days []daySummary
	var cumKM float64
	for rows.Next() {
		var d daySummary
		if err := rows.Scan(&d.Day, &d.EpochsCount, &d.DistanceKM, &d.CenterLat, &d.CenterLon); err == nil {
			cumKM += d.DistanceKM
			d.CumulativeKM = float64(int(cumKM*100+0.5)) / 100.0
			days = append(days, d)
		}
	}
	if days == nil {
		days = []daySummary{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"days": days,
	})
}


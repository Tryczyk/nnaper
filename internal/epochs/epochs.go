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

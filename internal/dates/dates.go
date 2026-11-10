package dates

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func isValidUUID(u string) bool {
	if len(u) != 36 {
		return false
	}
	for i, c := range u {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func (s *Service) HandleDatesTree(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)
	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))

	if profileID == "undefined" || profileID == "null" || profileID == "all" || profileID == "__all__" || !isValidUUID(profileID) {
		profileID = ""
	}

	var whereProfile string
	var args []interface{}
	nextArg := 1

	if userID != "" {
		if profileID != "" {
			var owns bool
			_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM profiles WHERE profile_id = $1::uuid AND user_id = $2::uuid)`, profileID, userID).Scan(&owns)
			if !owns {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				_, _ = w.Write([]byte("{}"))
				return
			}
			whereProfile = fmt.Sprintf("e.profile_id = $%d::uuid", nextArg)
			args = append(args, profileID)
			nextArg++
		} else {
			// Wszystkie profile danego użytkownika oraz ewentualne ślady z profile_id IS NULL
			whereProfile = fmt.Sprintf("(e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid) OR e.profile_id IS NULL)", nextArg)
			args = append(args, userID)
			nextArg++
		}
	} else {
		if profileID != "" {
			whereProfile = fmt.Sprintf("e.profile_id = $%d::uuid", nextArg)
			args = append(args, profileID)
			nextArg++
		} else {
			whereProfile = "1=1"
		}
	}

	query := fmt.Sprintf(`
		SELECT DISTINCT 
			EXTRACT(YEAR FROM e.timestamp)::int AS y,
			EXTRACT(MONTH FROM e.timestamp)::int AS m,
			EXTRACT(DAY FROM e.timestamp)::int AS d
		FROM epochs e
		WHERE %s
		ORDER BY y DESC NULLS LAST, m DESC NULLS LAST, d DESC NULLS LAST;
	`, whereProfile)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte("{}"))
		return
	}
	defer rows.Close()

	tree := make(map[string]map[string][]string)

	for rows.Next() {
		var y, m, d *int
		if err := rows.Scan(&y, &m, &d); err != nil {
			continue
		}

		var yStr, mStr, dStr string
		if y == nil || m == nil || d == nil {
			yStr = "None"
			mStr = "None"
			dStr = "None"
		} else {
			yStr = fmt.Sprintf("%04d", *y)
			mStr = fmt.Sprintf("%02d", *m)
			dStr = fmt.Sprintf("%02d", *d)
		}

		if tree[yStr] == nil {
			tree[yStr] = make(map[string][]string)
		}

		exists := false
		for _, dayVal := range tree[yStr][mStr] {
			if dayVal == dStr {
				exists = true
				break
			}
		}
		if !exists {
			tree[yStr][mStr] = append(tree[yStr][mStr], dStr)
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(tree)
}

func (s *Service) HandleTimeTree(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	day := r.URL.Query().Get("day")
	if day == "" {
		http.Error(w, `{"detail":"Brak parametru day"}`, http.StatusBadRequest)
		return
	}

	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)
	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	if profileID == "undefined" || profileID == "null" || profileID == "all" || profileID == "__all__" || !isValidUUID(profileID) {
		profileID = ""
	}

	var whereProfile string
	var args []interface{}
	nextArg := 1

	if userID != "" {
		if profileID != "" {
			whereProfile = fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1)
			args = append(args, profileID, userID)
			nextArg += 2
		} else {
			whereProfile = fmt.Sprintf("(e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid) OR e.profile_id IS NULL)", nextArg)
			args = append(args, userID)
			nextArg++
		}
	} else {
		if profileID != "" {
			whereProfile = fmt.Sprintf("e.profile_id = $%d::uuid", nextArg)
			args = append(args, profileID)
			nextArg++
		} else {
			whereProfile = "1=1"
		}
	}

	var whereTime string
	if day == "None" || day == "null" {
		whereTime = "e.timestamp IS NULL"
	} else {
		if _, err := time.Parse("2006-01-02", day); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD lub None."}`, http.StatusBadRequest)
			return
		}
		whereTime = fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 day')", nextArg, nextArg)
		args = append(args, day)
		nextArg++
	}

	query := fmt.Sprintf(`
		SELECT DISTINCT 
			to_char(e.timestamp, 'HH24') AS h,
			to_char(e.timestamp, 'MI') AS mi,
			to_char(e.timestamp, 'SS') AS s
		FROM epochs e
		WHERE %s
		  AND %s
		ORDER BY h DESC NULLS LAST, mi DESC NULLS LAST, s DESC NULLS LAST;
	`, whereProfile, whereTime)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
		return
	}
	defer rows.Close()

	tree := make(map[string]map[string][]string)

	for rows.Next() {
		var h, mi, sec *string
		if err := rows.Scan(&h, &mi, &sec); err != nil {
			continue
		}

		hStr := "None"
		if h != nil {
			hStr = *h
		}
		miStr := "None"
		if mi != nil {
			miStr = *mi
		}
		sStr := "None"
		if sec != nil {
			sStr = *sec
		}

		if tree[hStr] == nil {
			tree[hStr] = make(map[string][]string)
		}
		tree[hStr][miStr] = append(tree[hStr][miStr], sStr)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(tree)
}

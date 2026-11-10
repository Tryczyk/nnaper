package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/pbkdf2"
)

type User struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Email     *string   `json:"email"`
	AvatarURL *string   `json:"avatar_url"`
	CreatedAt time.Time `json:"created_at"`
}

type Profile struct {
	ProfileID   string  `json:"profile_id"`
	UserID      string  `json:"user_id"`
	Name        string  `json:"name"`
	AvatarURL   *string `json:"avatar_url"`
	CreatedAt   string  `json:"created_at"`
	EpochsCount int64   `json:"epochs_count"`
	DaysCount   int64   `json:"days_count"`
}

func HashPassword(password string) string {
	saltBytes := make([]byte, 16)
	_, _ = rand.Read(saltBytes)
	salt := hex.EncodeToString(saltBytes)

	key := pbkdf2.Key([]byte(password), []byte(salt), 100000, 32, sha256.New)
	return fmt.Sprintf("%s$%s", salt, hex.EncodeToString(key))
}

func VerifyPassword(password, hashed string) bool {
	if !strings.Contains(hashed, "$") {
		return false
	}
	parts := strings.SplitN(hashed, "$", 2)
	salt := parts[0]
	expectedHex := parts[1]

	key := pbkdf2.Key([]byte(password), []byte(salt), 100000, 32, sha256.New)
	actualHex := hex.EncodeToString(key)

	return subtle.ConstantTimeCompare([]byte(actualHex), []byte(expectedHex)) == 1
}

func GenerateToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func ExtractToken(r *http.Request) string {
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:])
	}
	return ""
}

func GetUserFromToken(ctx context.Context, pool *pgxpool.Pool, token string) (*User, error) {
	if token == "" {
		return nil, nil
	}

	var u User
	var email, avatar *string
	err := pool.QueryRow(ctx, `
		SELECT u.user_id, u.username, u.email, u.avatar_url, u.created_at
		FROM user_sessions s
		JOIN users u ON s.user_id = u.user_id
		WHERE s.token = $1
	`, token).Scan(&u.UserID, &u.Username, &email, &avatar, &u.CreatedAt)

	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	u.Email = email
	u.AvatarURL = avatar
	return &u, nil
}

func GetAuthUserID(ctx context.Context, pool *pgxpool.Pool, token, authHeader string) string {
	t := strings.TrimSpace(token)
	if t == "" && authHeader != "" {
		parts := strings.Split(authHeader, " ")
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			t = strings.TrimSpace(parts[1])
		}
	}
	if t == "" {
		return ""
	}
	user, err := GetUserFromToken(ctx, pool, t)
	if err != nil || user == nil {
		return ""
	}
	return user.UserID
}

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

func (s *Service) HandleRegister(w http.ResponseWriter, r *http.Request) {
	RegisterHandler(s.pool)(w, r)
}

func (s *Service) HandleLogin(w http.ResponseWriter, r *http.Request) {
	LoginHandler(s.pool)(w, r)
}

func (s *Service) HandleMe(w http.ResponseWriter, r *http.Request) {
	MeHandler(s.pool)(w, r)
}

func (s *Service) HandleAvatar(w http.ResponseWriter, r *http.Request) {
	AvatarHandler(s.pool)(w, r)
}

func (s *Service) HandleLogout(w http.ResponseWriter, r *http.Request) {
	LogoutHandler(s.pool)(w, r)
}

func (s *Service) HandleListProfiles(w http.ResponseWriter, r *http.Request) {
	ListProfilesHandler(s.pool)(w, r)
}

func (s *Service) HandleCreateProfile(w http.ResponseWriter, r *http.Request) {
	CreateProfileHandler(s.pool)(w, r)
}

func (s *Service) HandleDeleteProfile(w http.ResponseWriter, r *http.Request) {
	DeleteProfileHandler(s.pool, nil)(w, r)
}

func (s *Service) HandleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	UpdateSettingsHandler(s.pool)(w, r)
}

func (s *Service) HandleGetStats(w http.ResponseWriter, r *http.Request) {
	GetAccountStatsHandler(s.pool)(w, r)
}

func (s *Service) HandleListPresets(w http.ResponseWriter, r *http.Request) {
	ListPresetsHandler(s.pool)(w, r)
}

func (s *Service) HandleSavePreset(w http.ResponseWriter, r *http.Request) {
	SavePresetHandler(s.pool)(w, r)
}

func (s *Service) HandleDeletePreset(w http.ResponseWriter, r *http.Request) {
	DeletePresetHandler(s.pool)(w, r)
}

// Handlery HTTP

func RegisterHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		Username string  `json:"username"`
		Password string  `json:"password"`
		Email    *string `json:"email"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
			return
		}

		username := strings.TrimSpace(req.Username)
		password := strings.TrimSpace(req.Password)
		if len(username) < 3 || len(username) > 64 {
			http.Error(w, `{"detail":"Nazwa użytkownika musi mieć od 3 do 64 znaków."}`, http.StatusBadRequest)
			return
		}
		if len(password) < 4 {
			http.Error(w, `{"detail":"Hasło musi mieć co najmniej 4 znaki."}`, http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		pwHash := HashPassword(password)

		var userID string
		var avatarURL *string

		// Sprawdzenie czy istnieje user
		var existingID, existingHash string
		err := pool.QueryRow(ctx, `SELECT user_id, password_hash FROM users WHERE LOWER(username) = LOWER($1)`, username).Scan(&existingID, &existingHash)
		if err == nil {
			if existingHash == "placeholder_hash" {
				err = pool.QueryRow(ctx, `
					UPDATE users SET password_hash = $1 WHERE user_id = $2
					RETURNING user_id, avatar_url
				`, pwHash, existingID).Scan(&userID, &avatarURL)
				if err != nil {
					http.Error(w, `{"detail":"Błąd aktualizacji hasła"}`, http.StatusInternalServerError)
					return
				}
			} else {
				http.Error(w, `{"detail":"Użytkownik o takiej nazwie już istnieje."}`, http.StatusBadRequest)
				return
			}
		} else {
			if req.Email != nil && strings.TrimSpace(*req.Email) != "" {
				var dummy string
				errEmail := pool.QueryRow(ctx, `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1)`, strings.TrimSpace(*req.Email)).Scan(&dummy)
				if errEmail == nil {
					http.Error(w, `{"detail":"Konto z takim adresem email już istnieje."}`, http.StatusBadRequest)
					return
				}
			}

			err = pool.QueryRow(ctx, `
				INSERT INTO users (username, email, password_hash)
				VALUES ($1, $2, $3)
				RETURNING user_id, avatar_url
			`, username, req.Email, pwHash).Scan(&userID, &avatarURL)
			if err != nil {
				http.Error(w, `{"detail":"Błąd rejestracji w bazie danych"}`, http.StatusInternalServerError)
				return
			}

			_, _ = pool.Exec(ctx, `
				INSERT INTO profiles (user_id, name)
				VALUES ($1, $2)
				ON CONFLICT (user_id, name) DO NOTHING
			`, userID, username)
		}

		token := GenerateToken()
		_, err = pool.Exec(ctx, `INSERT INTO user_sessions (token, user_id) VALUES ($1, $2)`, token, userID)
		if err != nil {
			http.Error(w, `{"detail":"Błąd tworzenia sesji"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"token":  token,
			"user": map[string]interface{}{
				"user_id":    userID,
				"username":   username,
				"email":      req.Email,
				"avatar_url": avatarURL,
			},
		})
	}
}

func LoginHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
			return
		}

		ident := strings.TrimSpace(req.Username)
		password := strings.TrimSpace(req.Password)
		ctx := r.Context()

		var u User
		var pwHash string
		err := pool.QueryRow(ctx, `
			SELECT user_id, username, email, password_hash, avatar_url, created_at
			FROM users
			WHERE LOWER(username) = LOWER($1) OR (email IS NOT NULL AND LOWER(email) = LOWER($1))
		`, ident).Scan(&u.UserID, &u.Username, &u.Email, &pwHash, &u.AvatarURL, &u.CreatedAt)

		if err != nil {
			http.Error(w, `{"detail":"Nieprawidłowa nazwa użytkownika lub hasło."}`, http.StatusUnauthorized)
			return
		}

		if pwHash == "placeholder_hash" {
			newHash := HashPassword(password)
			_, _ = pool.Exec(ctx, `UPDATE users SET password_hash = $1 WHERE user_id = $2`, newHash, u.UserID)
		} else if !VerifyPassword(password, pwHash) {
			http.Error(w, `{"detail":"Nieprawidłowa nazwa użytkownika lub hasło."}`, http.StatusUnauthorized)
			return
		}

		token := GenerateToken()
		_, err = pool.Exec(ctx, `INSERT INTO user_sessions (token, user_id) VALUES ($1, $2)`, token, u.UserID)
		if err != nil {
			http.Error(w, `{"detail":"Błąd zapisu sesji"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"token":  token,
			"user": map[string]interface{}{
				"user_id":    u.UserID,
				"username":   u.Username,
				"email":      u.Email,
				"avatar_url": u.AvatarURL,
			},
		})
	}
}

func MeHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		w.Header().Set("Content-Type", "application/json")

		if err != nil || user == nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"authenticated": false,
				"user":          nil,
			})
			return
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"authenticated": true,
			"user": map[string]interface{}{
				"user_id":    user.UserID,
				"username":   user.Username,
				"email":      user.Email,
				"avatar_url": user.AvatarURL,
			},
		})
	}
}

func AvatarHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		AvatarURL *string `json:"avatar_url"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Brak autoryzacji."}`, http.StatusUnauthorized)
			return
		}

		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy format danych"}`, http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		_, _ = pool.Exec(ctx, `UPDATE users SET avatar_url = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`, req.AvatarURL, user.UserID)
		_, _ = pool.Exec(ctx, `UPDATE profiles SET avatar_url = $1 WHERE user_id = $2`, req.AvatarURL, user.UserID)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":     "ok",
			"avatar_url": req.AvatarURL,
		})
	}
}

func LogoutHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		if token != "" {
			_, _ = pool.Exec(r.Context(), `DELETE FROM user_sessions WHERE token = $1`, token)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	}
}

func ListProfilesHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		ctx := r.Context()
		rows, err := pool.Query(ctx, `
			SELECT 
				p.profile_id,
				p.user_id,
				p.name,
				p.avatar_url,
				p.created_at,
				COALESCE(p.epochs_count, 0) AS epochs_count,
				0 AS days_count
			FROM profiles p
			WHERE p.user_id = $1::uuid
			ORDER BY p.created_at ASC
		`, user.UserID)

		if err != nil {
			http.Error(w, `{"detail":"Błąd pobierania profili"}`, http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var list []Profile
		for rows.Next() {
			var p Profile
			var t time.Time
			if err := rows.Scan(&p.ProfileID, &p.UserID, &p.Name, &p.AvatarURL, &t, &p.EpochsCount, &p.DaysCount); err == nil {
				p.CreatedAt = t.Format(time.RFC3339)
				list = append(list, p)
			}
		}

		if list == nil {
			list = []Profile{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(list)
	}
}

func CreateProfileHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		Name string `json:"name"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
			return
		}

		name := strings.TrimSpace(req.Name)
		if len(name) < 1 || len(name) > 64 {
			http.Error(w, `{"detail":"Nazwa profilu musi mieć od 1 do 64 znaków."}`, http.StatusBadRequest)
			return
		}

		ctx := r.Context()
		var p Profile
		var t time.Time
		err = pool.QueryRow(ctx, `
			INSERT INTO profiles (user_id, name)
			VALUES ($1::uuid, $2)
			RETURNING profile_id, user_id, name, avatar_url, created_at
		`, user.UserID, name).Scan(&p.ProfileID, &p.UserID, &p.Name, &p.AvatarURL, &t)

		if err != nil {
			http.Error(w, `{"detail":"Profil o takiej nazwie już istnieje."}`, http.StatusBadRequest)
			return
		}

		p.CreatedAt = t.Format(time.RFC3339)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"profile": p,
		})
	}
}

func DeleteProfileHandler(pool *pgxpool.Pool, onDeleted func()) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		profileID := chi.URLParam(r, "profile_id")
		ctx := r.Context()

		// Usuwamy powiązane epoki profilu oraz sam profil
		_, _ = pool.Exec(ctx, `DELETE FROM epochs WHERE profile_id = $1::uuid`, profileID)

		res, err := pool.Exec(ctx, `DELETE FROM profiles WHERE profile_id = $1::uuid AND user_id = $2::uuid`, profileID, user.UserID)
		if err != nil || res.RowsAffected() == 0 {
			http.Error(w, `{"detail":"Profil nie został odnaleziony."}`, http.StatusNotFound)
			return
		}

		if onDeleted != nil {
			onDeleted()
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"message": "Profil oraz powiązane z nim ślady zostały usunięte.",
		})
	}
}

// UpdateSettingsHandler obsługuje panel ustawień konta:
// - zmianę Nicku (username)
// - zmianę adresu e-mail (email)
// - zmianę hasła (new_password)
// - zapis ustawień widoczności przełączników/sliderów (ui_settings)
func UpdateSettingsHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		Username        *string                `json:"username"`
		Email           *string                `json:"email"`
		CurrentPassword *string                `json:"current_password"`
		NewPassword     *string                `json:"new_password"`
		UISettings      map[string]interface{} `json:"ui_settings"`
	}

	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		ctx := r.Context()

		if r.Method == http.MethodGet {
			var uiRaw []byte
			_ = pool.QueryRow(ctx, `SELECT COALESCE(ui_settings, '{}'::jsonb) FROM users WHERE user_id = $1::uuid`, user.UserID).Scan(&uiRaw)
			var uiSettings map[string]interface{}
			_ = json.Unmarshal(uiRaw, &uiSettings)
			if uiSettings == nil {
				uiSettings = map[string]interface{}{}
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status":      "ok",
				"user":        user,
				"ui_settings": uiSettings,
			})
			return
		}

		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy format JSON"}`, http.StatusBadRequest)
			return
		}

		// 1. Zmiana Nicku
		if req.Username != nil {
			newNick := strings.TrimSpace(*req.Username)
			if len(newNick) < 3 || len(newNick) > 64 {
				http.Error(w, `{"detail":"Nick musi mieć od 3 do 64 znaków."}`, http.StatusBadRequest)
				return
			}
			if !strings.EqualFold(newNick, user.Username) {
				var existingID string
				errDup := pool.QueryRow(ctx, `SELECT user_id FROM users WHERE LOWER(username) = LOWER($1) AND user_id != $2::uuid`, newNick, user.UserID).Scan(&existingID)
				if errDup == nil {
					http.Error(w, `{"detail":"Użytkownik o takim nicku już istnieje."}`, http.StatusBadRequest)
					return
				}
			}
			_, err = pool.Exec(ctx, `UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2::uuid`, newNick, user.UserID)
			if err != nil {
				http.Error(w, `{"detail":"Błąd aktualizacji nicku"}`, http.StatusInternalServerError)
				return
			}
			user.Username = newNick
		}

		// 2. Zmiana Emaila
		if req.Email != nil {
			newEmail := strings.TrimSpace(*req.Email)
			if newEmail == "" {
				_, _ = pool.Exec(ctx, `UPDATE users SET email = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1::uuid`, user.UserID)
				user.Email = nil
			} else {
				var existingID string
				errDup := pool.QueryRow(ctx, `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) AND user_id != $2::uuid`, newEmail, user.UserID).Scan(&existingID)
				if errDup == nil {
					http.Error(w, `{"detail":"Ten adres e-mail jest już przypisany do innego konta."}`, http.StatusBadRequest)
					return
				}
				_, err = pool.Exec(ctx, `UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2::uuid`, newEmail, user.UserID)
				if err != nil {
					http.Error(w, `{"detail":"Błąd aktualizacji adresu e-mail"}`, http.StatusInternalServerError)
					return
				}
				user.Email = &newEmail
			}
		}

		// 3. Zmiana Hasła
		if req.NewPassword != nil && strings.TrimSpace(*req.NewPassword) != "" {
			newPass := strings.TrimSpace(*req.NewPassword)
			if len(newPass) < 4 {
				http.Error(w, `{"detail":"Nowe hasło musi mieć co najmniej 4 znaki."}`, http.StatusBadRequest)
				return
			}
			if req.CurrentPassword != nil && strings.TrimSpace(*req.CurrentPassword) != "" {
				var curHash string
				if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE user_id = $1::uuid`, user.UserID).Scan(&curHash); err == nil {
					if curHash != "placeholder_hash" && !VerifyPassword(strings.TrimSpace(*req.CurrentPassword), curHash) {
						http.Error(w, `{"detail":"Aktualne hasło jest nieprawidłowe."}`, http.StatusBadRequest)
						return
					}
				}
			}
			newHash := HashPassword(newPass)
			_, err = pool.Exec(ctx, `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2::uuid`, newHash, user.UserID)
			if err != nil {
				http.Error(w, `{"detail":"Błąd aktualizacji hasła"}`, http.StatusInternalServerError)
				return
			}
		}

		// 4. Ustawienia widoczności UI (przełączniki, slidery)
		var savedUISettings map[string]interface{}
		if req.UISettings != nil {
			uiBytes, _ := json.Marshal(req.UISettings)
			_, _ = pool.Exec(ctx, `UPDATE users SET ui_settings = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2::uuid`, string(uiBytes), user.UserID)
			savedUISettings = req.UISettings
		} else {
			var uiRaw []byte
			_ = pool.QueryRow(ctx, `SELECT COALESCE(ui_settings, '{}'::jsonb) FROM users WHERE user_id = $1::uuid`, user.UserID).Scan(&uiRaw)
			_ = json.Unmarshal(uiRaw, &savedUISettings)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":      "ok",
			"message":     "Ustawienia konta zostały zapisane.",
			"user":        user,
			"ui_settings": savedUISettings,
		})
	}
}

// GetAccountStatsHandler oblicza statystyki konta:
// - Max prędkość (max_speed_kmh)
// - Przejechane kilometry (total_km)
// - Przejechane unikalne kilometry wyłącznie ze zsnapowanych geometrii dróg geom_line (unique_km)
// - Min / Max Lat / Lon (min_lat, max_lat, min_lon, max_lon)
func GetAccountStatsHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		ctx := r.Context()
		profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))

		var whereProfile string
		var args []interface{}
		if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
			whereProfile = "e.profile_id = $1::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)"
			args = []interface{}{profileID, user.UserID}
		} else {
			whereProfile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $1::uuid)"
			args = []interface{}{user.UserID}
		}

		query := fmt.Sprintf(`
			WITH filtered AS (
				SELECT
					e.timestamp,
					COALESCE(e.geom_snapped, e.geom) AS pt,
					e.geom_snapped,
					e.geom_line,
					LEAST(COALESCE(e.speed_kmh, 0), 300.0) AS speed_kmh
				FROM epochs e
				WHERE %s
			)
			SELECT
				count(*) AS epochs_count,
				count(DISTINCT timestamp::date) AS days_count,
				COALESCE(round(max(speed_kmh)::numeric, 2), 0) AS max_speed_kmh,
				COALESCE(round((sum(ST_Length(geom_line) * 85.0))::numeric, 2), 0) AS snapped_total_km,
				COALESCE(round((count(DISTINCT CASE WHEN geom_snapped IS NOT NULL THEN ((floor(ST_X(geom_snapped) * 4000.0)::bigint << 32) | (floor(ST_Y(geom_snapped) * 4000.0)::bigint & 4294967295)) END) * 0.0235)::numeric, 2), 0) AS unique_km,
				round(min(ST_Y(pt))::numeric, 6) AS min_lat,
				round(max(ST_Y(pt))::numeric, 6) AS max_lat,
				round(min(ST_X(pt))::numeric, 6) AS min_lon,
				round(max(ST_X(pt))::numeric, 6) AS max_lon,
				max(ARRAY[ST_Y(pt), ST_X(pt)]) AS north_pt,
				min(ARRAY[ST_Y(pt), ST_X(pt)]) AS south_pt,
				max(ARRAY[ST_X(pt), ST_Y(pt)]) AS east_pt,
				min(ARRAY[ST_X(pt), ST_Y(pt)]) AS west_pt
			FROM filtered;
		`, whereProfile)

		var epochsCount, daysCount int64
		var maxSpeed, totalKM, uniqueKM float64
		var minLat, maxLat, minLon, maxLon *float64
		var northPt, southPt, eastPt, westPt []float64

		err = pool.QueryRow(ctx, query, args...).Scan(
			&epochsCount,
			&daysCount,
			&maxSpeed,
			&totalKM,
			&uniqueKM,
			&minLat,
			&maxLat,
			&minLon,
			&maxLon,
			&northPt,
			&southPt,
			&eastPt,
			&westPt,
		)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"detail":"Błąd obliczania statystyk: %v"}`, err), http.StatusInternalServerError)
			return
		}

		// Jeśli w bazie są punkty bez geom_line (zaimportowane bez snapa), doliczamy ich dystans całkowity
		if totalKM == 0 && epochsCount > 1 {
			fallbackDistQuery := fmt.Sprintf(`
				WITH ordered AS (
					SELECT
						COALESCE(e.geom_snapped, e.geom) AS pt,
						LAG(COALESCE(e.geom_snapped, e.geom)) OVER (PARTITION BY e.profile_id, e.timestamp::date ORDER BY e.timestamp ASC) AS prev_pt
					FROM epochs e
					WHERE %s
				)
				SELECT COALESCE(round((sum(ST_Distance(pt::geography, prev_pt::geography)) / 1000.0)::numeric, 2), 0)
				FROM ordered
				WHERE prev_pt IS NOT NULL AND ST_Distance(pt::geography, prev_pt::geography) < 2000;
			`, whereProfile)
			_ = pool.QueryRow(ctx, fallbackDistQuery, args...).Scan(&totalKM)
		}

		if uniqueKM > totalKM && totalKM > 0 {
			totalKM = uniqueKM
		}

		resp := map[string]interface{}{
			"epochs_count":  epochsCount,
			"days_count":    daysCount,
			"max_speed_kmh": maxSpeed,
			"total_km":      totalKM,
			"unique_km":     uniqueKM,
			"min_lat":       minLat,
			"max_lat":       maxLat,
			"min_lon":       minLon,
			"max_lon":       maxLon,
		}
		if len(northPt) == 2 {
			resp["north_point"] = map[string]float64{"lat": northPt[0], "lon": northPt[1]}
		}
		if len(southPt) == 2 {
			resp["south_point"] = map[string]float64{"lat": southPt[0], "lon": southPt[1]}
		}
		if len(eastPt) == 2 {
			resp["east_point"] = map[string]float64{"lat": eastPt[1], "lon": eastPt[0]}
		}
		if len(westPt) == 2 {
			resp["west_point"] = map[string]float64{"lat": westPt[1], "lon": westPt[0]}
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

type LayerPreset struct {
	PresetID  string                 `json:"preset_id"`
	Name      string                 `json:"name"`
	IsDefault bool                   `json:"is_default"`
	Config    map[string]interface{} `json:"config"`
	CreatedAt string                 `json:"created_at"`
}

func ListPresetsHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, _ := GetUserFromToken(r.Context(), pool, token)

		var list []LayerPreset
		if user != nil {
			rows, err := pool.Query(r.Context(), `
				SELECT preset_id::text, name, config, created_at
				FROM layer_presets
				WHERE user_id = $1::uuid
				ORDER BY created_at ASC
			`, user.UserID)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var p LayerPreset
					var cfgRaw []byte
					var t time.Time
					if err := rows.Scan(&p.PresetID, &p.Name, &cfgRaw, &t); err == nil {
						_ = json.Unmarshal(cfgRaw, &p.Config)
						p.CreatedAt = t.Format(time.RFC3339)
						list = append(list, p)
					}
				}
			}
		}
		if list == nil {
			list = []LayerPreset{}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"presets": list,
		})
	}
}

func SavePresetHandler(pool *pgxpool.Pool) http.HandlerFunc {
	type reqBody struct {
		Name   string                 `json:"name"`
		Config map[string]interface{} `json:"config"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}

		var req reqBody
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
			return
		}
		name := strings.TrimSpace(req.Name)
		if len(name) < 1 || len(name) > 120 {
			http.Error(w, `{"detail":"Nazwa presetu musi mieć od 1 do 120 znaków."}`, http.StatusBadRequest)
			return
		}

		cfgBytes, _ := json.Marshal(req.Config)
		var presetID string
		var createdAt time.Time
		err = pool.QueryRow(r.Context(), `
			INSERT INTO layer_presets (user_id, name, config)
			VALUES ($1::uuid, $2, $3::jsonb)
			ON CONFLICT (user_id, name) DO UPDATE
			SET config = EXCLUDED.config
			RETURNING preset_id::text, created_at
		`, user.UserID, name, string(cfgBytes)).Scan(&presetID, &createdAt)
		if err != nil {
			http.Error(w, `{"detail":"Błąd zapisu presetu"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "ok",
			"preset": LayerPreset{
				PresetID:  presetID,
				Name:      name,
				Config:    req.Config,
				CreatedAt: createdAt.Format(time.RFC3339),
			},
		})
	}
}

func DeletePresetHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ExtractToken(r)
		user, err := GetUserFromToken(r.Context(), pool, token)
		if err != nil || user == nil {
			http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
			return
		}
		presetID := chi.URLParam(r, "preset_id")
		_, err = pool.Exec(r.Context(), `DELETE FROM layer_presets WHERE preset_id = $1::uuid AND user_id = $2::uuid`, presetID, user.UserID)
		if err != nil {
			http.Error(w, `{"detail":"Błąd usuwania presetu"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}
}



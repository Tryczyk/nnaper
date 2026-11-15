package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
	"nnaper/internal/config"
)

// UpdateStatus reprezentuje aktualny stan i metadane harmonogramu aktualizacji PBF.
type UpdateStatus struct {
	FileName             string     `json:"file_name"`
	FileSize             int64      `json:"file_size"`
	FileModTime          *time.Time `json:"file_mod_time,omitempty"`
	LastSuccessfulUpdate *time.Time `json:"last_successful_update"`
	LastAttemptAt        *time.Time `json:"last_attempt_at"`
	LastStatus           string     `json:"last_status"` // IDLE, RUNNING, SUCCESS, FAILED
	LastError            *string    `json:"last_error"`
	ConsecutiveFailures  int        `json:"consecutive_failures"`
	IsUpdating           bool       `json:"is_updating"`
	AutoUpdateEnabled    bool       `json:"auto_update_enabled"`
	PreferredHour        int        `json:"preferred_hour"`
	RetryIntervalMin     int        `json:"retry_interval_minutes"`
	UpdaterTool          string     `json:"updater_tool"`
	NextCheckReason      string     `json:"next_check_reason,omitempty"`
}

// Updater zarządza pobieraniem przyrostowych zmian do pliku .osm.pbf
// oraz realizuje harmonogram typu anacron (okno nocne + nadrabianie zaległości przy starcie/awarii).
type Updater struct {
	pool       *pgxpool.Pool
	cfg        *config.Config
	pbfPath    string
	mu         sync.Mutex
	isUpdating bool
}

// NewUpdater tworzy instancję menedżera aktualizacji PBF.
func NewUpdater(pool *pgxpool.Pool, cfg *config.Config) *Updater {
	return &Updater{
		pool:    pool,
		cfg:     cfg,
		pbfPath: cfg.OSMPBFPath,
	}
}

// EnsureScheduleTable upewnia się, że tabela harmonogramu istnieje w PostGIS.
func (u *Updater) EnsureScheduleTable(ctx context.Context) error {
	query := `
		CREATE TABLE IF NOT EXISTS osm_update_schedule (
			id                     SERIAL PRIMARY KEY,
			file_name              VARCHAR(255) NOT NULL UNIQUE,
			last_successful_update TIMESTAMPTZ,
			last_attempt_at        TIMESTAMPTZ,
			last_status            VARCHAR(32) NOT NULL DEFAULT 'IDLE',
			last_error             TEXT,
			consecutive_failures   INT DEFAULT 0,
			updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`
	_, err := u.pool.Exec(ctx, query)
	return err
}

// DetectTool sprawdza dostępne w systemie narzędzia do nakładania diffów OSM.
func DetectTool() string {
	if p, err := exec.LookPath("osmupdate"); err == nil && p != "" {
		return "osmupdate"
	}
	if p, err := exec.LookPath("pyosmium-up-to-date"); err == nil && p != "" {
		return "pyosmium-up-to-date"
	}
	return "none"
}

// GetStatus zwraca bieżący stan pliku i harmonogramu aktualizacji.
func (u *Updater) GetStatus(ctx context.Context) (UpdateStatus, error) {
	fileName := filepath.Base(u.pbfPath)
	var fileSize int64
	var modTime *time.Time

	if fi, err := os.Stat(u.pbfPath); err == nil {
		fileSize = fi.Size()
		mt := fi.ModTime()
		modTime = &mt
	}

	st := UpdateStatus{
		FileName:            fileName,
		FileSize:            fileSize,
		FileModTime:         modTime,
		LastStatus:          "IDLE",
		AutoUpdateEnabled:   u.cfg.OSMAutoUpdate,
		PreferredHour:       u.cfg.OSMPreferredHour,
		RetryIntervalMin:    u.cfg.OSMRetryIntervalMin,
		UpdaterTool:         DetectTool(),
		ConsecutiveFailures: 0,
	}

	u.mu.Lock()
	st.IsUpdating = u.isUpdating
	u.mu.Unlock()

	var lastSuccess, lastAttempt *time.Time
	var lastStatus string
	var lastError *string
	var failures int

	err := u.pool.QueryRow(ctx, `
		SELECT last_successful_update, last_attempt_at, last_status, last_error, consecutive_failures
		FROM osm_update_schedule
		WHERE file_name = $1
	`, fileName).Scan(&lastSuccess, &lastAttempt, &lastStatus, &lastError, &failures)

	if err == nil {
		st.LastSuccessfulUpdate = lastSuccess
		st.LastAttemptAt = lastAttempt
		st.LastStatus = lastStatus
		st.LastError = lastError
		st.ConsecutiveFailures = failures
	}

	should, reason := ShouldRun(time.Now(), st)
	if should {
		st.NextCheckReason = "Kwalifikuje się do aktualizacji: " + reason
	} else {
		st.NextCheckReason = reason
	}

	return st, nil
}

// CalculateBackoff wylicza interwał oczekiwania po kolejnych błędach (exponential backoff).
func CalculateBackoff(failures int, baseMinutes int) time.Duration {
	if failures <= 1 {
		return time.Duration(baseMinutes) * time.Minute
	}
	multiplier := math.Pow(2, float64(failures-1))
	maxMinutes := 120.0 // maks 2 godziny
	minutes := math.Min(float64(baseMinutes)*multiplier, maxMinutes)
	return time.Duration(minutes) * time.Minute
}

// ShouldRun podejmuje deterministyczną decyzję, czy w danej chwili należy wykonać aktualizację.
// Obsługuje okno nocne, spóźnione aktualizacje (catch-up przy starcie/po awarii) oraz retry.
func ShouldRun(now time.Time, st UpdateStatus) (bool, string) {
	if st.IsUpdating {
		return false, "Aktualizacja jest już w toku"
	}
	if !st.AutoUpdateEnabled {
		return false, "Automatyczne aktualizacje są wyłączone w konfiguracji"
	}

	// 1. Warunek: Brak jakiejkolwiek wcześniejszej udanej aktualizacji (nowa instalacja lub brak logu)
	if st.LastSuccessfulUpdate == nil {
		if st.LastStatus == "FAILED" && st.LastAttemptAt != nil {
			backoff := CalculateBackoff(st.ConsecutiveFailures, st.RetryIntervalMin)
			if now.Sub(*st.LastAttemptAt) < backoff {
				return false, fmt.Sprintf("Oczekiwanie po błędzie (retry za %v)", (backoff - now.Sub(*st.LastAttemptAt)).Round(time.Second))
			}
		}
		return true, "Brak wcześniejszej aktualizacji (wymagany catch-up)"
	}

	// 2. Warunek: Catch-up (upłynęło > 24h od ostatniej udanej aktualizacji - np. serwer był wyłączony w nocy)
	timeSinceLastSuccess := now.Sub(*st.LastSuccessfulUpdate)
	if timeSinceLastSuccess >= 24*time.Hour {
		if st.LastStatus == "FAILED" && st.LastAttemptAt != nil {
			backoff := CalculateBackoff(st.ConsecutiveFailures, st.RetryIntervalMin)
			if now.Sub(*st.LastAttemptAt) < backoff {
				return false, fmt.Sprintf("Oczekiwanie po błędzie catch-up (retry za %v)", (backoff - now.Sub(*st.LastAttemptAt)).Round(time.Second))
			}
		}
		return true, fmt.Sprintf("Nadrabianie zaległej aktualizacji (od ostatniej minęło %.1f godz.)", timeSinceLastSuccess.Hours())
	}

	// 3. Warunek: Zaplanowane okno nocne (np. godzina 03:00)
	if now.Hour() == st.PreferredHour {
		y1, m1, d1 := st.LastSuccessfulUpdate.Date()
		y2, m2, d2 := now.Date()
		if y1 == y2 && m1 == m2 && d1 == d2 {
			return false, "Dzisiejsza aktualizacja nocna została już pomyślnie zrealizowana"
		}
		if st.LastStatus == "FAILED" && st.LastAttemptAt != nil {
			backoff := CalculateBackoff(st.ConsecutiveFailures, st.RetryIntervalMin)
			if now.Sub(*st.LastAttemptAt) < backoff {
				return false, fmt.Sprintf("Oczekiwanie na ponowienie w oknie nocnym (retry za %v)", (backoff - now.Sub(*st.LastAttemptAt)).Round(time.Second))
			}
		}
		return true, fmt.Sprintf("Okno nocne (godzina %02d:00)", st.PreferredHour)
	}

	return false, fmt.Sprintf("Plik aktualny. Następne okno nocne o %02d:00 (ostatnia udana: %s)",
		st.PreferredHour, st.LastSuccessfulUpdate.Format("2006-01-02 15:04"))
}

// ExecuteUpdate wykonuje pobranie różnic OSM i aplikuje je do pliku PBF.
func (u *Updater) ExecuteUpdate(ctx context.Context, force bool) error {
	u.mu.Lock()
	if u.isUpdating {
		u.mu.Unlock()
		return fmt.Errorf("inna aktualizacja jest już w toku")
	}
	u.isUpdating = true
	u.mu.Unlock()

	defer func() {
		u.mu.Lock()
		u.isUpdating = false
		u.mu.Unlock()
	}()

	fileName := filepath.Base(u.pbfPath)
	log.Printf("[OSM UPDATER] Rozpoczynanie procesu aktualizacji przyrostowej dla %s...", fileName)

	_ = u.recordStatus(ctx, fileName, "RUNNING", nil, false)

	// Sprawdzenie dostępności pliku źródłowego
	if _, err := os.Stat(u.pbfPath); err != nil {
		errStr := fmt.Sprintf("plik bazowy PBF nie istnieje pod ścieżką: %s", u.pbfPath)
		_ = u.recordStatus(ctx, fileName, "FAILED", &errStr, false)
		return fmt.Errorf("%s", errStr)
	}

	tool := DetectTool()
	if tool == "none" {
		errStr := "brak narzędzia aktualizującego w PATH (wymagane osmupdate z pakietu osmctools lub pyosmium)"
		_ = u.recordStatus(ctx, fileName, "FAILED", &errStr, false)
		return fmt.Errorf("%s", errStr)
	}

	// Wyznaczenie adresu bazowego aktualizacji (Geofabrik regional updates)
	updateBaseURL := u.cfg.OSMUpdateBaseURL
	if updateBaseURL == "" {
		region := strings.TrimSuffix(strings.TrimSuffix(fileName, ".osm.pbf"), ".pbf")
		updateBaseURL = fmt.Sprintf("https://download.geofabrik.de/europe/poland/%s-updates", region)
	}

	tmpPath := u.pbfPath + ".tmp"
	_ = os.Remove(tmpPath)

	var cmd *exec.Cmd
	if tool == "osmupdate" {
		args := []string{
			u.pbfPath,
			tmpPath,
			"--base-url=" + updateBaseURL,
			"--day",
			"--keep-tempfiles=0",
			"-v",
		}
		cmd = exec.CommandContext(ctx, "osmupdate", args...)
	} else {
		// pyosmium-up-to-date
		args := []string{"--server", updateBaseURL, "-o", tmpPath, u.pbfPath}
		cmd = exec.CommandContext(ctx, "pyosmium-up-to-date", args...)
	}

	output, err := cmd.CombinedOutput()
	outputStr := string(output)
	log.Printf("[OSM UPDATER] Wynik wykonania %s:\n%s", tool, outputStr)

	// Sprawdzenie czy plik był już aktualny
	if strings.Contains(strings.ToLower(outputStr), "already up to date") ||
		strings.Contains(strings.ToLower(outputStr), "up to date") {
		log.Printf("[OSM UPDATER] Plik %s jest już w najnowszej wersji.", fileName)
		_ = os.Remove(tmpPath)
		_ = u.recordStatus(ctx, fileName, "SUCCESS", nil, true)
		return nil
	}

	if err != nil {
		errStr := fmt.Sprintf("błąd %s: %v | Wyjście: %s", tool, err, strings.TrimSpace(outputStr))
		_ = u.recordStatus(ctx, fileName, "FAILED", &errStr, false)
		_ = os.Remove(tmpPath)
		return fmt.Errorf("%s", errStr)
	}

	// Weryfikacja pliku tymczasowego
	fi, err := os.Stat(tmpPath)
	if err != nil || fi.Size() < 100*1024 {
		// Jeśli brak pliku wynikowego, ale komenda zakończyła się sukcesem, dane mogły być już aktualne
		if strings.Contains(strings.ToLower(outputStr), "completed") || err == nil {
			_ = u.recordStatus(ctx, fileName, "SUCCESS", nil, true)
			return nil
		}
		errStr := "plik wyjściowy aktualizacji nie powstał lub jest zbyt mały (<100KB)"
		_ = u.recordStatus(ctx, fileName, "FAILED", &errStr, false)
		_ = os.Remove(tmpPath)
		return fmt.Errorf("%s", errStr)
	}

	// Atomowa podmiana pliku bazowego
	backupPath := u.pbfPath + ".bak"
	_ = os.Remove(backupPath)
	_ = os.Rename(u.pbfPath, backupPath)

	if err := os.Rename(tmpPath, u.pbfPath); err != nil {
		_ = os.Rename(backupPath, u.pbfPath) // rollback
		errStr := fmt.Sprintf("nie udało się podmienić pliku PBF: %v", err)
		_ = u.recordStatus(ctx, fileName, "FAILED", &errStr, false)
		return fmt.Errorf("%s", errStr)
	}
	_ = os.Remove(backupPath)

	log.Printf("[OSM UPDATER] Pomyślnie zaktualizowano plik %s (nowy rozmiar: %.1f MB).",
		fileName, float64(fi.Size())/(1024*1024))

	_ = u.recordStatus(ctx, fileName, "SUCCESS", nil, true)

	// Wyzwolenie asynchronicznej reindeksacji w PostGIS
	go func() {
		reindexCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		log.Printf("[OSM UPDATER] Uruchamianie reindeksacji PostGIS po aktualizacji PBF...")
		if err := EnsureIndexed(reindexCtx, u.pool, u.pbfPath); err != nil {
			log.Printf("[OSM UPDATER WARNING] Błąd reindeksacji po aktualizacji PBF: %v", err)
		} else {
			log.Printf("[OSM UPDATER] Reindeksacja PostGIS zakończona sukcesem.")
		}
	}()

	return nil
}

func (u *Updater) recordStatus(ctx context.Context, fileName, status string, lastErr *string, isSuccess bool) error {
	now := time.Now()
	query := `
		INSERT INTO osm_update_schedule (file_name, last_attempt_at, last_status, last_error, consecutive_failures, updated_at)
		VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'FAILED' THEN 1 ELSE 0 END, $2)
		ON CONFLICT (file_name) DO UPDATE SET
			last_attempt_at = EXCLUDED.last_attempt_at,
			last_status = EXCLUDED.last_status,
			last_error = EXCLUDED.last_error,
			consecutive_failures = CASE 
				WHEN EXCLUDED.last_status = 'SUCCESS' THEN 0 
				WHEN EXCLUDED.last_status = 'FAILED' THEN osm_update_schedule.consecutive_failures + 1
				ELSE osm_update_schedule.consecutive_failures
			END,
			last_successful_update = CASE 
				WHEN EXCLUDED.last_status = 'SUCCESS' THEN EXCLUDED.last_attempt_at 
				ELSE osm_update_schedule.last_successful_update 
			END,
			updated_at = EXCLUDED.updated_at
	`
	_, err := u.pool.Exec(ctx, query, fileName, now, status, lastErr)
	return err
}

// StartScheduler uruchamia w tle pętlę anacron sprawdzającą i wywołującą aktualizacje.
func (u *Updater) StartScheduler(ctx context.Context) {
	if err := u.EnsureScheduleTable(ctx); err != nil {
		log.Printf("[OSM UPDATER WARNING] Nie udało się zainicjalizować tabeli osm_update_schedule: %v", err)
	}

	go func() {
		log.Printf("[OSM UPDATER] Harmonogram uruchomiony (okno nocne: %02d:00, retry: %d min, auto: %t).",
			u.cfg.OSMPreferredHour, u.cfg.OSMRetryIntervalMin, u.cfg.OSMAutoUpdate)

		// Pierwsze sprawdzenie wykonujemy po 10 sekundach od startu aplikacji (Catch-Up)
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
			u.checkAndRun(ctx)
		}

		ticker := time.NewTicker(2 * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				log.Println("[OSM UPDATER] Zatrzymano harmonogram aktualizacji.")
				return
			case <-ticker.C:
				u.checkAndRun(ctx)
			}
		}
	}()
}

func (u *Updater) checkAndRun(ctx context.Context) {
	st, err := u.GetStatus(ctx)
	if err != nil {
		return
	}

	should, reason := ShouldRun(time.Now(), st)
	if !should {
		return
	}

	log.Printf("[OSM UPDATER] Wyzwalanie automatycznej aktualizacji PBF: %s", reason)
	if err := u.ExecuteUpdate(ctx, false); err != nil {
		log.Printf("[OSM UPDATER ERROR] Aktualizacja zakończona niepowodzeniem: %v", err)
	}
}

// HandleGetStatus to handler HTTP zwracający aktualny status PBF i harmonogramu.
func (u *Updater) HandleGetStatus(w http.ResponseWriter, r *http.Request) {
	st, err := u.GetStatus(r.Context())
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd pobierania statusu: %v"}`, err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(st)
}

// HandleTriggerUpdate to handler HTTP pozwalający na ręczne wymuszenie aktualizacji.
func (u *Updater) HandleTriggerUpdate(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(r.Context(), u.pool, token, authHeader)
	if userID == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status": "unauthorized",
			"detail": "Wymagana autoryzacja do uruchomienia aktualizacji",
		})
		return
	}

	u.mu.Lock()
	if u.isUpdating {
		u.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status": "conflict",
			"detail": "Aktualizacja jest już w toku",
		})
		return
	}
	u.mu.Unlock()

	go func() {
		updateCtx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
		defer cancel()
		_ = u.ExecuteUpdate(updateCtx, true)
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "accepted",
		"message": "Rozpoczęto proces aktualizacji pliku PBF w tle",
	})
}

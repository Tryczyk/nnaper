package jobs

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
	"nnaper/internal/config"
	"nnaper/internal/parser"
	"nnaper/internal/tiles"
)

type JobRecord struct {
	JobID          string  `json:"job_id"`
	UserID         string  `json:"user_id"`
	ProfileID      string  `json:"profile_id"`
	ProfileName    string  `json:"profile_name"`
	Filename       string  `json:"filename"`
	FileSize       int64   `json:"file_size"`
	ProcessedBytes int64   `json:"processed_bytes"`
	Status         string  `json:"status"` // queued, running, done, error
	Stage          string  `json:"stage"`
	Percent        int     `json:"percent"`
	Lines          int64   `json:"lines"`
	Epochs         int64   `json:"epochs"`
	Satellites     int64   `json:"satellites"`
	ETAStr         string  `json:"eta_str"`
	ETASec         int64   `json:"eta_seconds"`
	SpeedMbS       float64 `json:"speed_mb_s"`
	Message        string  `json:"message"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	AbortRequested bool    `json:"abort_requested"`
	Error          *string `json:"error"`
}

type FileHistoryItem struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Epochs      int64  `json:"epochs"`
	ProfileID   string `json:"profile_id"`
	ProfileName string `json:"profile_name"`
	ParsedAt    string `json:"parsed_at"`
}

type Manager struct {
	pool        *pgxpool.Pool
	cfg         *config.Config
	tiles       *tiles.Service
	parserEng   *parser.Engine
	mu          sync.RWMutex
	jobs        map[string]*JobRecord
	historyFile string
	jobsFile    string
}

func NewManager(pool *pgxpool.Pool, cfg *config.Config, tilesService *tiles.Service) *Manager {
	dbClient := parser.NewDBClientFromPool(pool)
	parserEng := parser.NewEngine(dbClient, cfg.OSRMURL, cfg.OSRMConcurrency, cfg.MatchChunkSize)
	jobsFile := filepath.Join(cfg.DataDir, "parser_jobs.json")

	mgr := &Manager{
		pool:        pool,
		cfg:         cfg,
		tiles:       tilesService,
		parserEng:   parserEng,
		jobs:        make(map[string]*JobRecord),
		historyFile: cfg.HistoryFile,
		jobsFile:    jobsFile,
	}
	mgr.loadJobs()
	return mgr
}

func (m *Manager) loadJobs() {
	if m.jobsFile == "" {
		return
	}
	data, err := os.ReadFile(m.jobsFile)
	if err != nil {
		return
	}
	var loaded map[string]*JobRecord
	if err := json.Unmarshal(data, &loaded); err == nil && loaded != nil {
		m.jobs = loaded
	}
}

func (m *Manager) saveJobsLocked() {
	if m.jobsFile == "" {
		return
	}
	data, err := json.MarshalIndent(m.jobs, "", "  ")
	if err == nil {
		_ = os.WriteFile(m.jobsFile, data, 0o644)
	}
}

func (m *Manager) getHistory(userID string) map[string]FileHistoryItem {
	m.mu.RLock()
	defer m.mu.RUnlock()

	res := make(map[string]FileHistoryItem)
	if data, err := os.ReadFile(m.historyFile); err == nil {
		var allHistory map[string]map[string]FileHistoryItem
		if err := json.Unmarshal(data, &allHistory); err == nil {
			if userHist, ok := allHistory[userID]; ok {
				return userHist
			}
		}
	}
	return res
}

func (m *Manager) recordHistory(userID, filename string, size, epochs int64, profileID, profileName string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var allHistory map[string]map[string]FileHistoryItem
	if data, err := os.ReadFile(m.historyFile); err == nil {
		_ = json.Unmarshal(data, &allHistory)
	}
	if allHistory == nil {
		allHistory = make(map[string]map[string]FileHistoryItem)
	}
	if allHistory[userID] == nil {
		allHistory[userID] = make(map[string]FileHistoryItem)
	}

	allHistory[userID][filename] = FileHistoryItem{
		Name:        filename,
		Size:        size,
		Epochs:      epochs,
		ProfileID:   profileID,
		ProfileName: profileName,
		ParsedAt:    time.Now().UTC().Format(time.RFC3339),
	}

	if data, err := json.MarshalIndent(allHistory, "", "  "); err == nil {
		_ = os.WriteFile(m.historyFile, data, 0o644)
	}
}

func (m *Manager) HandleUpload(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, m.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Musisz być zalogowany, aby importować dane GPS."}`, http.StatusUnauthorized)
		return
	}

	query := r.URL.Query()
	rawFilename := query.Get("filename")
	if rawFilename == "" {
		rawFilename = r.Header.Get("X-Filename")
	}
	if rawFilename == "" {
		rawFilename = "plik.txt"
	}
	realFilename, err := url.QueryUnescape(rawFilename)
	if err != nil {
		realFilename = rawFilename
	}

	snap := true
	if snapStr := query.Get("snap"); snapStr == "false" {
		snap = false
	}
	profileID := query.Get("profile_id")

	// Wygenerowanie losowego identyfikatora zadania
	rndBytes := make([]byte, 6)
	_, _ = rand.Read(rndBytes)
	jobID := fmt.Sprintf("job_%s", hex.EncodeToString(rndBytes))

	savedPath := filepath.Join(m.cfg.UploadDir, fmt.Sprintf("%s_%s_%s", userID, jobID, realFilename))
	outFile, err := os.Create(savedPath)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd zapisu pliku: %v"}`, err), http.StatusInternalServerError)
		return
	}

	// Szybki strumieniowy zapis pliku na dysk z buforem 2 MB
	bufWriter := bufio.NewWriterSize(outFile, 2*1024*1024)
	fileSize, copyErr := io.Copy(bufWriter, r.Body)
	if flushErr := bufWriter.Flush(); flushErr != nil && copyErr == nil {
		copyErr = flushErr
	}
	_ = outFile.Close()
	if copyErr != nil {
		_ = os.Remove(savedPath)
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd odczytu strumienia: %v"}`, copyErr), http.StatusInternalServerError)
		return
	}

	// Sprawdzenie lub utworzenie profilu użytkownika
	var targetProfileID, targetProfileName string
	if profileID != "" && profileID != "all" && profileID != "__all__" {
		_ = m.pool.QueryRow(ctx,
			"SELECT profile_id, name FROM profiles WHERE profile_id = $1::uuid AND user_id = $2::uuid",
			profileID, userID,
		).Scan(&targetProfileID, &targetProfileName)
	}

	if targetProfileID == "" {
		err := m.pool.QueryRow(ctx,
			"SELECT profile_id, name FROM profiles WHERE user_id = $1::uuid ORDER BY created_at ASC LIMIT 1",
			userID,
		).Scan(&targetProfileID, &targetProfileName)
		if err != nil {
			_ = m.pool.QueryRow(ctx,
				"INSERT INTO profiles (user_id, name) VALUES ($1::uuid, 'Główny') RETURNING profile_id, name",
				userID,
			).Scan(&targetProfileID, &targetProfileName)
		}
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	job := &JobRecord{
		JobID:       jobID,
		UserID:      userID,
		ProfileID:   targetProfileID,
		ProfileName: targetProfileName,
		Filename:    realFilename,
		FileSize:    fileSize,
		Status:      "queued",
		Stage:       "queued",
		Percent:     0,
		Lines:       0,
		Epochs:      0,
		Satellites:  0,
		ETAStr:      "--:--",
		SpeedMbS:    0.0,
		Message:     fmt.Sprintf("Plik przesłany. Zadanie przypisane do profilu '%s' oczekuje w kolejce...", targetProfileName),
		CreatedAt:   nowStr,
		UpdatedAt:   nowStr,
	}

	m.mu.Lock()
	m.jobs[jobID] = job
	m.saveJobsLocked()
	m.mu.Unlock()

	// Uruchomienie parsowania asynchronicznie w goroutine w tle
	go m.runBackgroundJob(jobID, savedPath, realFilename, userID, targetProfileID, targetProfileName, snap, fileSize)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"job_id":  jobID,
		"job":     job,
		"message": "Plik został pomyślnie przesłany i jest przetwarzany w tle na serwerze.",
	})
}

func (m *Manager) runBackgroundJob(jobID, filePath, filename, userID, profileID, profileName string, snap bool, fileSize int64) {
	defer func() {
		_ = os.Remove(filePath)
	}()

	m.mu.Lock()
	if job, ok := m.jobs[jobID]; ok {
		job.Status = "running"
		job.Stage = "parsing"
		job.Percent = 1
		job.Message = "Rozpoczęto odczyt i parsowanie danych GPS..."
		job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		m.saveJobsLocked()
	}
	m.mu.Unlock()

	ctx := context.Background()

	opts := parser.ParseOptions{
		FilePath:    filePath,
		ProfileID:   profileID,
		SnapToRoads: snap,
		AbortCheck: func() bool {
			m.mu.RLock()
			defer m.mu.RUnlock()
			if j, ok := m.jobs[jobID]; ok {
				return j.AbortRequested
			}
			return false
		},
		OnProgress: func(p parser.ProgressEvent) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if j, ok := m.jobs[jobID]; ok {
				if j.AbortRequested {
					return
				}
				stageChanged := j.Stage != p.Stage
				j.Percent = p.Percent
				j.Stage = p.Stage
				j.Lines = p.Lines
				j.Epochs = p.Epochs
				j.Satellites = p.Satellites
				j.ProcessedBytes = p.ProcessedBytes
				j.ETAStr = p.ETAStr
				j.ETASec = p.ETASec
				j.SpeedMbS = p.SpeedMbS
				j.Message = p.Message
				j.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
				if stageChanged || p.Percent%5 == 0 {
					m.saveJobsLocked()
				}
			}
		},
	}

	stats, err := m.parserEng.ParseFile(ctx, opts)
	m.mu.Lock()
	job := m.jobs[jobID]
	if job != nil {
		if err != nil {
			job.Status = "error"
			errStr := err.Error()
			job.Error = &errStr
			job.Message = fmt.Sprintf("Błąd parsowania: %v", err)
			job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		} else {
			job.Status = "done"
			job.Stage = "done"
			job.Percent = 100
			job.Epochs = stats.Epochs
			job.Satellites = stats.Satellites
			job.Lines = stats.Lines
			job.ETAStr = "00:00"
			job.Message = fmt.Sprintf("Zakończono pomyślnie. Zapisano %d epok.", stats.Epochs)
			job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		m.saveJobsLocked()
	}
	m.mu.Unlock()

	if err == nil {
		m.recordHistory(userID, filename, fileSize, stats.Epochs, profileID, profileName)
		m.tiles.ClearCache()
		_, _ = m.pool.Exec(context.Background(), `
			UPDATE profiles 
			SET epochs_count = (SELECT count(*) FROM epochs WHERE profile_id = $1::uuid)
			WHERE profile_id = $1::uuid
		`, profileID)
	}
}

func (m *Manager) HandleGetJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, m.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"active_jobs":[],"jobs":[],"history":{}}`))
		return
	}

	m.mu.RLock()
	var userJobs []*JobRecord
	for _, j := range m.jobs {
		if j.UserID == userID {
			userJobs = append(userJobs, j)
		}
	}
	m.mu.RUnlock()

	sort.Slice(userJobs, func(i, j int) bool {
		return userJobs[i].CreatedAt > userJobs[j].CreatedAt
	})

	if len(userJobs) > 20 {
		userJobs = userJobs[:20]
	}

	var activeJobs []*JobRecord
	for _, j := range userJobs {
		if j.Status == "queued" || j.Status == "running" {
			activeJobs = append(activeJobs, j)
		}
	}

	history := m.getHistory(userID)

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"jobs":        userJobs,
		"active_jobs": activeJobs,
		"history":     history,
	})
}

func (m *Manager) HandleAbortJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, m.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
		return
	}

	jobID := chi.URLParam(r, "job_id")

	m.mu.Lock()
	defer m.mu.Unlock()

	job, ok := m.jobs[jobID]
	if !ok || job.UserID != userID {
		http.Error(w, `{"detail":"Zadanie nie zostało znalezione."}`, http.StatusNotFound)
		return
	}

	job.AbortRequested = true
	job.Status = "error"
	errMsg := "Przerwano na życzenie użytkownika."
	job.Error = &errMsg
	job.Message = errMsg
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	m.saveJobsLocked()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write([]byte(`{"status":"ok","message":"Zadanie zostało przerwane."}`))
}

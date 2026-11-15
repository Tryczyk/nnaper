package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Port            int
	DBURL           string
	OSRMURL         string
	OSMPBFPath      string
	CORSOrigins     []string
	DataDir         string
	UploadDir       string
	HistoryFile     string
	MaxSpeedKMH         float64
	MatchChunkSize      int
	OSRMConcurrency     int
	OSMAutoUpdate       bool
	OSMPreferredHour    int
	OSMRetryIntervalMin int
	OSMUpdateBaseURL    string
}

func LoadConfig() *Config {
	loadDotEnv(".env")

	port := 8000
	if pStr := os.Getenv("PORT"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil {
			port = p
		}
	} else if pStr := os.Getenv("API_PORT"); pStr != "" {
		if p, err := strconv.Atoi(pStr); err == nil {
			port = p
		}
	}

	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		dbURL = "postgresql://nnaper:nnaper@localhost:5432/nnaper_db"
	}

	osrmURL := strings.TrimRight(os.Getenv("OSRM_URL"), "/")
	if osrmURL == "" {
		osrmURL = "http://localhost:5000"
	}

	corsRaw := os.Getenv("CORS_ORIGINS")
	var corsOrigins []string
	if corsRaw != "" {
		for _, o := range strings.Split(corsRaw, ",") {
			if trimmed := strings.TrimSpace(o); trimmed != "" {
				corsOrigins = append(corsOrigins, trimmed)
			}
		}
	}
	if len(corsOrigins) == 0 {
		corsOrigins = []string{
			"http://localhost:8000",
			"http://localhost:8080",
			"http://127.0.0.1:8000",
			"http://127.0.0.1:8080",
		}
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}

	uploadDir := filepath.Join(dataDir, "uploads")
	historyFile := filepath.Join(dataDir, "parsed_history.json")

	maxSpeed := 1000.0
	if sStr := os.Getenv("MAX_SPEED_KMH"); sStr != "" {
		if s, err := strconv.ParseFloat(sStr, 64); err == nil {
			maxSpeed = s
		}
	}

	chunkSize := 100
	if cStr := os.Getenv("MATCH_CHUNK_SIZE"); cStr != "" {
		if c, err := strconv.Atoi(cStr); err == nil {
			chunkSize = c
		}
	}

	concurrency := 24
	if cStr := os.Getenv("OSRM_CONCURRENCY"); cStr != "" {
		if c, err := strconv.Atoi(cStr); err == nil {
			concurrency = c
		}
	}

	_ = os.MkdirAll(uploadDir, 0o755)

	osmPbfPath := os.Getenv("OSM_PBF_PATH")
	if osmPbfPath == "" {
		osmFileName := os.Getenv("OSM_FILE_NAME")
		if osmFileName == "" {
			osmFileName = "pomorskie.osm.pbf"
		}
		osmPbfPath = filepath.Join("osm_data", osmFileName)
	}

	osmAutoUpdate := true
	if auStr := os.Getenv("OSM_AUTO_UPDATE_ENABLED"); auStr != "" {
		if val, err := strconv.ParseBool(auStr); err == nil {
			osmAutoUpdate = val
		}
	}

	osmPreferredHour := 3
	if phStr := os.Getenv("OSM_PREFERRED_HOUR"); phStr != "" {
		if val, err := strconv.Atoi(phStr); err == nil && val >= 0 && val <= 23 {
			osmPreferredHour = val
		}
	}

	osmRetryMin := 15
	if rmStr := os.Getenv("OSM_RETRY_INTERVAL_MINUTES"); rmStr != "" {
		if val, err := strconv.Atoi(rmStr); err == nil && val > 0 {
			osmRetryMin = val
		}
	}

	osmUpdateBaseURL := os.Getenv("OSM_UPDATE_BASE_URL")

	return &Config{
		Port:                port,
		DBURL:               dbURL,
		OSRMURL:             osrmURL,
		OSMPBFPath:          osmPbfPath,
		CORSOrigins:         corsOrigins,
		DataDir:             dataDir,
		UploadDir:           uploadDir,
		HistoryFile:         historyFile,
		MaxSpeedKMH:         maxSpeed,
		MatchChunkSize:      chunkSize,
		OSRMConcurrency:     concurrency,
		OSMAutoUpdate:       osmAutoUpdate,
		OSMPreferredHour:    osmPreferredHour,
		OSMRetryIntervalMin: osmRetryMin,
		OSMUpdateBaseURL:    osmUpdateBaseURL,
	}
}

func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if len(line) == 0 || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			k := strings.TrimSpace(parts[0])
			v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			if os.Getenv(k) == "" {
				_ = os.Setenv(k, v)
			}
		}
	}
}


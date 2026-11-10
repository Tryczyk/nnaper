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
	MaxSpeedKMH     float64
	MatchChunkSize  int
	OSRMConcurrency int
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
		corsOrigins = []string{"*"}
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

	return &Config{
		Port:            port,
		DBURL:           dbURL,
		OSRMURL:         osrmURL,
		OSMPBFPath:      osmPbfPath,
		CORSOrigins:     corsOrigins,
		DataDir:         dataDir,
		UploadDir:       uploadDir,
		HistoryFile:     historyFile,
		MaxSpeedKMH:     maxSpeed,
		MatchChunkSize:  chunkSize,
		OSRMConcurrency: concurrency,
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


package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	filePath := flag.String("file", "", "Ścieżka do pliku z danymi (NMEA, GPX, CSV)")
	profileID := flag.String("profile-id", "", "UUID profilu użytkownika")
	dbURL := flag.String("db-url", "postgresql://nnaper:nnaper@localhost:5432/nnaper_db", "Połączenie PostgreSQL")
	osrmURL := flag.String("osrm-url", "http://localhost:5000", "Adres serwera OSRM")
	snapToRoads := flag.Bool("snap", true, "Czy dociągać punkty do sieci dróg OSRM")
	concurrency := flag.Int("concurrency", 16, "Liczba równoległych workerów OSRM (goroutines)")
	chunkSize := flag.Int("chunk-size", 100, "Rozmiar pojedynczego chunka OSRM /match")
	jsonProgress := flag.Bool("json-progress", true, "Strumieniowanie postępu w formacie NDJSON na stdout")
	flag.Parse()

	if *filePath == "" {
		fmt.Fprintf(os.Stderr, "Błąd: Brak parametru -file. Użycie: nnaper-parser -file <ścieżka> [opcje]\n")
		os.Exit(1)
	}

	// Odczyt ze zmiennych środowiskowych jeśli nie podano w parametrach
	if envDB := os.Getenv("DB_URL"); envDB != "" && *dbURL == "postgresql://nnaper:nnaper@localhost:5432/nnaper_db" {
		*dbURL = envDB
	}
	if envOSRM := os.Getenv("OSRM_URL"); envOSRM != "" && *osrmURL == "http://localhost:5000" {
		*osrmURL = envOSRM
	}

	fileInfo, err := os.Stat(*filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Błąd: Nie można otworzyć pliku: %v\n", err)
		os.Exit(1)
	}
	totalBytes := fileInfo.Size()

	// 1. Inicjalizacja klienta bazy danych PostgreSQL
	db, err := NewDBClient(*dbURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Błąd bazy danych: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()

	ctx := context.Background()
	_ = db.EnsureSchema(ctx)

	// Pobranie ostatniego punktu do kalkulacji prędkości
	lastTs, lastLat, lastLon, _ := db.GetLastPoint(ctx, *profileID)

	// 2. Inicjalizacja wielowątkowego klienta OSRM
	osrmClient := NewOSRMClient(*osrmURL, *concurrency*2)

	// Funkcja obsługi postępu
	progressHandler := func(p ProgressEvent) {
		p.Filename = filepath.Base(*filePath)
		if *jsonProgress {
			data, _ := json.Marshal(p)
			fmt.Println(string(data))
		} else {
			fmt.Printf("[%3d%%] %s | Linii: %d | ETA: %s | Szybkość: %.1f MB/s\n",
				p.Percent, p.Stage, p.Lines, p.ETAStr, p.SpeedMbS)
		}
	}

	// Handler pojedynczej partii epok
	batchHandler := func(epochs []*Epoch) error {
		if *snapToRoads {
			osrmClient.SnapBatch(epochs, *chunkSize, *concurrency)
		} else {
			for _, ep := range epochs {
				ep.GeomSnapped = ep.GeomWKT
			}
		}
		return db.SaveBatch(ctx, epochs)
	}

	// 3. Wykrycie formatu pliku
	file, err := os.Open(*filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Błąd odczytu pliku: %v\n", err)
		os.Exit(1)
	}
	defer file.Close()

	sample := make([]byte, 2048)
	n, _ := file.Read(sample)
	_, _ = file.Seek(0, io.SeekStart)
	sampleStr := strings.ToLower(string(sample[:n]))
	ext := strings.ToLower(filepath.Ext(*filePath))

	startTime := time.Now()

	// 4. Uruchomienie wyspecjalizowanego parsera
	if ext == ".gpx" || strings.Contains(sampleStr, "<gpx") {
		err = ParseGPXStream(file, *profileID, totalBytes, batchHandler, progressHandler)
	} else if ext == ".csv" || (strings.Contains(sampleStr, "lat") && (strings.Contains(sampleStr, ",") || strings.Contains(sampleStr, ";"))) {
		err = ParseCSVStream(file, *profileID, totalBytes, batchHandler, progressHandler)
	} else {
		nmeaParser := NewNMEAParser(*profileID, lastTs, lastLat, lastLon, totalBytes)
		err = nmeaParser.ParseStream(file, batchHandler, progressHandler)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "Błąd podczas parsowania: %v\n", err)
		os.Exit(1)
	}

	elapsed := time.Since(startTime)
	if *jsonProgress {
		doneEv, _ := json.Marshal(ProgressEvent{
			Type:     "done",
			Stage:    "done",
			Percent:  100,
			Filename: filepath.Base(*filePath),
			Message:  fmt.Sprintf("Pomyślnie sparsowano i zapisano do PostgreSQL w %.1f sek.", elapsed.Seconds()),
		})
		fmt.Println(string(doneEv))
	} else {
		fmt.Printf("✓ Zakończono pomyślnie w %.2fs\n", elapsed.Seconds())
	}
}


package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"nnaper/internal/auth"
	"nnaper/internal/config"
	"nnaper/internal/dates"
	"nnaper/internal/db"
	"nnaper/internal/epochs"
	"nnaper/internal/export"
	"nnaper/internal/features"
	"nnaper/internal/jobs"
	"nnaper/internal/osm"
	"nnaper/internal/routing"
	"nnaper/internal/tiles"
)

func main() {
	log.Println("[NNAPER] Inicjalizacja serwera Go...")

	cfg := config.LoadConfig()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Połączenie z bazą PostgreSQL
	database, err := db.Connect(ctx, cfg.DBURL)
	if err != nil {
		log.Fatalf("[NNAPER FATAL] Nie można połączyć się z PostgreSQL: %v", err)
	}
	defer database.Close()
	log.Println("[NNAPER] Połączenie z PostgreSQL nawiązane pomyślnie.")

	// Inicjalizacja serwisów domenowych
	authService := auth.NewService(database.Pool)
	tilesService := tiles.NewService(database.Pool)
	datesService := dates.NewService(database.Pool)
	epochsService := epochs.NewService(database.Pool, tilesService)
	exportService := export.NewService(database.Pool)
	jobsManager := jobs.NewManager(database.Pool, cfg, tilesService)
	osmService := osm.NewService(database.Pool)
	featuresService := features.NewService(database.Pool)
	routingService := routing.NewService(database.Pool, cfg.OSRMURL)

	// Asynchroniczne indeksowanie pliku .osm.pbf (infrastruktura, POI, adresy offline, graf dróg, działki mgły wojny)
	go func() {
		if err := osm.EnsureIndexed(ctx, database.Pool, cfg.OSMPBFPath); err != nil {
			log.Printf("[NNAPER OSM WARNING] Indeksowanie PBF: %v\n", err)
		}
	}()

	// Konfiguracja routera Chi
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Konfiguracja CORS
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Filename", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link", "Content-Disposition"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Rejestracja endpointów API
	r.Route("/api", func(api chi.Router) {
		api.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})

		// Autoryzacja i profile
		api.Post("/auth/register", authService.HandleRegister)
		api.Post("/auth/login", authService.HandleLogin)
		api.Get("/auth/me", authService.HandleMe)
		api.Post("/auth/avatar", authService.HandleAvatar)
		api.Post("/auth/logout", authService.HandleLogout)
		api.Get("/auth/profiles", authService.HandleListProfiles)
		api.Post("/auth/profiles", authService.HandleCreateProfile)
		api.Delete("/auth/profiles/{profile_id}", authService.HandleDeleteProfile)
		api.Get("/auth/settings", authService.HandleUpdateSettings)
		api.Put("/auth/settings", authService.HandleUpdateSettings)
		api.Post("/auth/settings", authService.HandleUpdateSettings)

		// Statystyki konta i presety warstw
		api.Get("/stats", authService.HandleGetStats)
		api.Get("/presets", authService.HandleListPresets)
		api.Post("/presets", authService.HandleSavePreset)
		api.Delete("/presets/{preset_id}", authService.HandleDeletePreset)

		// Drzewo dat i godzin
		api.Get("/dates-tree", datesService.HandleDatesTree)
		api.Get("/time-tree", datesService.HandleTimeTree)

		// Pamięć podręczna kafelków
		api.Get("/cache/clear", tilesService.HandleClearCache)
		api.Post("/cache/clear", tilesService.HandleClearCache)

		// Dynamiczne kafelki wektorowe MVT (ślady GPS, infrastruktura drogowa, punkty POI)
		api.Get("/track/{z}/{x}/{y}.pbf", tilesService.HandleGetTrackTile)
		api.Get("/infrastructure/{z}/{x}/{y}.pbf", osmService.HandleGetInfrastructureTile)
		api.Get("/poi/{z}/{x}/{y}.pbf", osmService.HandleGetPOITile)
		api.Get("/poi/details", osmService.HandleGetPOIDetails)

		// Lokalny serwis geokodowania i wyszukiwania adresów (100% offline, kompatybilny z Photon)
		api.Get("/geocode/api", osmService.HandleGeocodeSearch)
		api.Get("/geocode/api/", osmService.HandleGeocodeSearch)
		api.Get("/geocode/search", osmService.HandleGeocodeSearch)
		api.Get("/geocode/reverse", osmService.HandleGeocodeReverse)

		// Punkty telemetryczne (epoki) — edycja manualna, batchowa, zaznaczanie ramką i timelapse
		api.Get("/epoch/{epoch_id}", epochsService.HandleGetEpoch)
		api.Put("/epoch/{epoch_id}", epochsService.HandleUpdateEpoch)
		api.Delete("/epoch/{epoch_id}", epochsService.HandleDeleteEpoch)
		api.Post("/epoch", epochsService.HandleCreateEpoch)
		api.Delete("/epochs/day", epochsService.HandleDeleteEpochsDay)
		api.Post("/epochs/delete-batch", epochsService.HandleDeleteEpochsBatch)
		api.Post("/epochs/box-select", epochsService.HandleBoxSelectEpochs)
		api.Post("/epochs/translate-batch", epochsService.HandleTranslateEpochsBatch)
		api.Get("/playback-day", epochsService.HandlePlaybackDay)
		api.Get("/timelapse", epochsService.HandleTimelapseSummary)

		// Heatmapa, Odkrywanie mapy (Mgła wojny) oraz Rysowanie po mapie
		api.Get("/heatmap/tiles/{z}/{x}/{y}.png", featuresService.HandleGetHeatmapTile)
		api.Get("/heatmap/grid", featuresService.HandleGetHeatmapGrid)
		api.Get("/fog-of-war", featuresService.HandleGetFogOfWar)
		api.Get("/drawings", featuresService.HandleListDrawings)
		api.Post("/drawings", featuresService.HandleSaveDrawing)
		api.Put("/drawings/{drawing_id}", featuresService.HandleUpdateDrawing)
		api.Delete("/drawings/{drawing_id}", featuresService.HandleDeleteDrawing)

		// Zaawansowane wyznaczanie tras (punkty unikania, suwaki niechęci, unikanie przebytych dróg, generator tras)
		api.Post("/route/plan", routingService.HandlePlanRoute)

		// Eksport danych
		api.Get("/export-data", exportService.HandleExportData)
		api.Get("/export/download", exportService.HandleExportDownload)

		// Import i parsowanie zadań w tle
		api.Post("/parser/upload", jobsManager.HandleUpload)
		api.Get("/parser/jobs", jobsManager.HandleGetJobs)
		api.Post("/parser/job/{job_id}/abort", jobsManager.HandleAbortJob)
	})

	// Obsługa statycznych plików UI (mapa, style, skrypty, kafelki PMTiles)
	workDir, _ := os.Getwd()
	mapsDir := filepath.Join(workDir, "maps")
	assetsDir := filepath.Join(workDir, "assets")
	osmDataDir := filepath.Join(workDir, "osm_data")

	fileServer(r, "/maps", http.Dir(mapsDir), false)
	fileServer(r, "/assets", http.Dir(assetsDir), false)
	fileServer(r, "/osm_data", http.Dir(osmDataDir), true)

	// Przekierowanie głównego adresu na mapę
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/maps/map.html", http.StatusMovedPermanently)
	})
	r.Get("/map.html", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/maps/map.html", http.StatusMovedPermanently)
	})

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 30 * time.Second,
		ReadTimeout:       0, // Bez limitu czasu na pobieranie wielusetmegabajtowych plików
		WriteTimeout:      0, // Bez limitu czasu na długie strumienie zapisu
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("[NNAPER] Serwer uruchomiony na http://%s\n", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[NNAPER FATAL] Błąd serwera HTTP: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[NNAPER] Zatrzymywanie serwera (graceful shutdown)...")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[NNAPER WARNING] Błąd zamykania serwera: %v\n", err)
	}
	log.Println("[NNAPER] Serwer zatrzymany.")
}

func fileServer(r chi.Router, path string, root http.FileSystem, isNoStore bool) {
	if strings.ContainsAny(path, "{}*") {
		panic("FileServer does not permit URL parameters.")
	}

	fs := http.StripPrefix(path, http.FileServer(root))

	if path != "/" && path[len(path)-1] != '/' {
		r.Get(path, http.RedirectHandler(path+"/", 301).ServeHTTP)
		path += "/"
	}
	pattern := path + "*"

	r.Get(pattern, func(w http.ResponseWriter, r *http.Request) {
		if isNoStore {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, ETag")
		}
		fs.ServeHTTP(w, r)
	})
}

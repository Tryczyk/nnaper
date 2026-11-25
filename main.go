package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	osmUpdater := osm.NewUpdater(database.Pool, cfg)
	featuresService := features.NewService(database.Pool)
	routingService := routing.NewService(database.Pool, cfg.OSRMURL)

	// Asynchroniczne indeksowanie pliku .osm.pbf (infrastruktura, POI, adresy offline, graf dróg, działki mgły wojny)
	go func() {
		if err := osm.EnsureIndexed(ctx, database.Pool, cfg.OSMPBFPath); err != nil {
			log.Printf("[NNAPER OSM WARNING] Indeksowanie PBF: %v\n", err)
		}
	}()

	// Uruchomienie harmonogramu automatycznych aktualizacji przyrostowych PBF (anacron / catch-up / nocne)
	osmUpdater.StartScheduler(ctx)

	// Okresowe czyszczenie wygasłych sesji użytkowników (co 1h)
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if deleted, err := auth.CleanupExpiredSessions(ctx, database.Pool); err == nil && deleted > 0 {
					log.Printf("[NNAPER AUTH] Usunięto %d wygasłych sesji użytkowników.", deleted)
				}
			}
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
		api.Use(auth.AuthMiddleware(database.Pool, false))

		// Rejestracja endpointów publicznych i z opcjonalną autoryzacją
		api.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})
		api.Post("/auth/register", authService.HandleRegister)
		api.Post("/auth/login", authService.HandleLogin)

		// Presety, drzewo dat i kafelki (dostępne publicznie lub personalizowane tokenem)
		api.Get("/presets", authService.HandleListPresets)
		api.Get("/dates-tree", datesService.HandleDatesTree)
		api.Get("/time-tree", datesService.HandleTimeTree)
		api.Get("/track/{z}/{x}/{y}.pbf", tilesService.HandleGetTrackTile)
		api.Get("/infrastructure/{z}/{x}/{y}.pbf", osmService.HandleGetInfrastructureTile)
		api.Get("/poi/{z}/{x}/{y}.pbf", osmService.HandleGetPOITile)
		api.Get("/poi/details", osmService.HandleGetPOIDetails)

		// Status aktualizacji OSM
		api.Get("/osm/update/status", osmUpdater.HandleGetStatus)

		// Lokalny serwis geokodowania i wyszukiwania adresów (100% offline, kompatybilny z Photon)
		api.Get("/geocode/api", osmService.HandleGeocodeSearch)
		api.Get("/geocode/api/", osmService.HandleGeocodeSearch)
		api.Get("/geocode/search", osmService.HandleGeocodeSearch)
		api.Get("/geocode/reverse", osmService.HandleGeocodeReverse)

		// Heatmapa, Odkrywanie mapy (Mgła wojny) oraz Routing
		api.Get("/heatmap/tiles/{z}/{x}/{y}.png", featuresService.HandleGetHeatmapTile)
		api.Get("/heatmap/grid", featuresService.HandleGetHeatmapGrid)
		api.Get("/fog-of-war", featuresService.HandleGetFogOfWar)
		api.Post("/route/plan", routingService.HandlePlanRoute)

		// Trasy chronione — wymagające aktywnej sesji / tokena (RequireAuth)
		api.Group(func(protected chi.Router) {
			protected.Use(auth.RequireAuth(database.Pool))

			// Profil i ustawienia konta
			protected.Get("/auth/me", authService.HandleMe)
			protected.Post("/auth/avatar", authService.HandleAvatar)
			protected.Delete("/auth/avatar", authService.HandleAvatar)
			protected.Post("/auth/logout", authService.HandleLogout)
			protected.Get("/auth/profiles", authService.HandleListProfiles)
			protected.Post("/auth/profiles", authService.HandleCreateProfile)
			protected.Delete("/auth/profiles/{profile_id}", authService.HandleDeleteProfile)
			protected.Delete("/auth/account", authService.HandleDeleteAccount)
			protected.Get("/auth/settings", authService.HandleUpdateSettings)
			protected.Put("/auth/settings", authService.HandleUpdateSettings)
			protected.Post("/auth/settings", authService.HandleUpdateSettings)

			// Statystyki konta i zarządzanie presetami
			protected.Get("/stats", authService.HandleGetStats)
			protected.Post("/presets", authService.HandleSavePreset)
			protected.Delete("/presets/{preset_id}", authService.HandleDeletePreset)

			// Pamięć podręczna kafelków
			protected.Get("/cache/clear", tilesService.HandleClearCache)
			protected.Post("/cache/clear", tilesService.HandleClearCache)

			// Ręczne wywołanie aktualizacji przyrostowych .osm.pbf
			protected.Post("/osm/update/trigger", osmUpdater.HandleTriggerUpdate)

			// Punkty telemetryczne (epoki) — edycja manualna, batchowa, zaznaczanie ramką i timelapse
			protected.Get("/epoch/{epoch_id}", epochsService.HandleGetEpoch)
			protected.Put("/epoch/{epoch_id}", epochsService.HandleUpdateEpoch)
			protected.Delete("/epoch/{epoch_id}", epochsService.HandleDeleteEpoch)
			protected.Post("/epoch", epochsService.HandleCreateEpoch)
			protected.Delete("/epochs/day", epochsService.HandleDeleteEpochsDay)
			protected.Post("/epochs/delete-batch", epochsService.HandleDeleteEpochsBatch)
			protected.Post("/epochs/box-select", epochsService.HandleBoxSelectEpochs)
			protected.Post("/epochs/translate-batch", epochsService.HandleTranslateEpochsBatch)
			protected.Get("/playback-day", epochsService.HandlePlaybackDay)
			protected.Get("/timelapse", epochsService.HandleTimelapseSummary)

			// Rysunki na mapie
			protected.Get("/drawings", featuresService.HandleListDrawings)
			protected.Post("/drawings", featuresService.HandleSaveDrawing)
			protected.Put("/drawings/{drawing_id}", featuresService.HandleUpdateDrawing)
			protected.Delete("/drawings/{drawing_id}", featuresService.HandleDeleteDrawing)

			// Eksport danych
			protected.Get("/export-data", exportService.HandleExportData)
			protected.Get("/export/download", exportService.HandleExportDownload)

			// Import i parsowanie zadań w tle
			protected.Post("/parser/upload", jobsManager.HandleUpload)
			protected.Get("/parser/jobs", jobsManager.HandleGetJobs)
			protected.Post("/parser/job/{job_id}/abort", jobsManager.HandleAbortJob)
		})
	})

	addr := fmt.Sprintf("0.0.0.0:%d", cfg.Port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Minute,
		WriteTimeout:      30 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("[NNAPER] Serwer API uruchomiony na http://%s\n", addr)
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

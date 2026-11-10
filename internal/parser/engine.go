package parser

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

type Engine struct {
	db          *DBClient
	osrm        *OSRMClient
	concurrency int
	chunkSize   int
}

func NewEngine(db *DBClient, osrmURL string, concurrency, chunkSize int) *Engine {
	if concurrency <= 0 {
		concurrency = 16
	}
	if chunkSize <= 0 {
		chunkSize = 100
	}
	return &Engine{
		db:          db,
		osrm:        NewOSRMClient(osrmURL, concurrency*2),
		concurrency: concurrency,
		chunkSize:   chunkSize,
	}
}

type ParseOptions struct {
	FilePath    string
	ProfileID   string
	SnapToRoads bool
	OnProgress  func(ProgressEvent)
	AbortCheck  func() bool
}

type ParseStats struct {
	Lines      int64
	Epochs     int64
	Satellites int64
	Duration   time.Duration
}

func (e *Engine) ParseFile(ctx context.Context, opts ParseOptions) (*ParseStats, error) {
	fileInfo, err := os.Stat(opts.FilePath)
	if err != nil {
		return nil, fmt.Errorf("błąd odczytu informacji o pliku: %w", err)
	}
	totalBytes := fileInfo.Size()

	file, err := os.Open(opts.FilePath)
	if err != nil {
		return nil, fmt.Errorf("błąd otwarcia pliku: %w", err)
	}
	defer file.Close()

	var totalEpochs int64
	var totalSats int64
	var totalLines int64
	startTime := time.Now()

	lastTs, lastLat, lastLon, _ := e.db.GetLastPoint(ctx, opts.ProfileID)

	progressCallback := func(p ProgressEvent) {
		p.Filename = filepath.Base(opts.FilePath)
		p.Epochs = atomic.LoadInt64(&totalEpochs)
		p.Satellites = atomic.LoadInt64(&totalSats)
		if p.Lines > 0 {
			atomic.StoreInt64(&totalLines, p.Lines)
		}
		if opts.OnProgress != nil {
			opts.OnProgress(p)
		}
	}

	batchHandler := func(batch []*Epoch) error {
		if opts.AbortCheck != nil && opts.AbortCheck() {
			return fmt.Errorf("zadanie przerwane przez użytkownika")
		}

		if opts.SnapToRoads {
			e.osrm.SnapBatch(batch, e.chunkSize, e.concurrency)
		} else {
			for _, ep := range batch {
				ep.GeomSnapped = ep.GeomWKT
			}
		}

		if err := e.db.SaveBatch(ctx, batch); err != nil {
			return err
		}

		atomic.AddInt64(&totalEpochs, int64(len(batch)))
		var satsInBatch int64
		for _, ep := range batch {
			satsInBatch += int64(len(ep.Satellites))
		}
		atomic.AddInt64(&totalSats, satsInBatch)

		return nil
	}

	sample := make([]byte, 2048)
	n, _ := file.Read(sample)
	_, _ = file.Seek(0, io.SeekStart)
	sampleStr := strings.ToLower(string(sample[:n]))
	ext := strings.ToLower(filepath.Ext(opts.FilePath))

	if ext == ".gpx" || strings.Contains(sampleStr, "<gpx") {
		err = ParseGPXStream(file, opts.ProfileID, totalBytes, batchHandler, progressCallback)
	} else if ext == ".csv" || (strings.Contains(sampleStr, "lat") && (strings.Contains(sampleStr, ",") || strings.Contains(sampleStr, ";"))) {
		err = ParseCSVStream(file, opts.ProfileID, totalBytes, batchHandler, progressCallback)
	} else {
		nmeaParser := NewNMEAParser(opts.ProfileID, lastTs, lastLat, lastLon, totalBytes)
		err = nmeaParser.ParseStream(file, batchHandler, progressCallback)
	}

	if err != nil {
		return nil, err
	}

	elapsed := time.Since(startTime)
	stats := &ParseStats{
		Lines:      atomic.LoadInt64(&totalLines),
		Epochs:     atomic.LoadInt64(&totalEpochs),
		Satellites: atomic.LoadInt64(&totalSats),
		Duration:   elapsed,
	}

	if opts.OnProgress != nil {
		opts.OnProgress(ProgressEvent{
			Type:       "done",
			Stage:      "done",
			Percent:    100,
			Filename:   filepath.Base(opts.FilePath),
			Epochs:     stats.Epochs,
			Satellites: stats.Satellites,
			Lines:      stats.Lines,
			ETAStr:     "00:00",
			SpeedMbS:   0,
			Message:    fmt.Sprintf("Pomyślnie przetworzono i zapisano %d epok w %.1fs", stats.Epochs, elapsed.Seconds()),
		})
	}

	return stats, nil
}


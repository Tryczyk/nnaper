package parser

import (
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strings"
	"time"
)

// GPXTrkPt struktura punktu trasy w pliku GPX
type GPXTrkPt struct {
	XMLName xml.Name `xml:"trkpt"`
	Lat     float64  `xml:"lat,attr"`
	Lon     float64  `xml:"lon,attr"`
	Time    string   `xml:"time"`
}

// ParseGPXStream strumieniowo parsuje punkty z pliku GPX
func ParseGPXStream(r io.Reader, profileID string, totalBytes int64, onBatch func([]*Epoch) error, onProgress func(ProgressEvent)) error {
	decoder := xml.NewDecoder(r)
	var batch []*Epoch
	batchSize := 4000
	var lines int64
	var processedBytes int64
	startTime := time.Now()
	lastYield := time.Now()

	for {
		token, err := decoder.Token()
		if err != nil {
			if err == io.EOF {
				break
			}
			return err
		}

		switch se := token.(type) {
		case xml.StartElement:
			if strings.EqualFold(se.Name.Local, "trkpt") {
				lines++
				var pt GPXTrkPt
				if err := decoder.DecodeElement(&pt, &se); err == nil {
					var ts *time.Time
					if pt.Time != "" {
						clean := strings.Replace(pt.Time, "Z", "+00:00", 1)
						for _, layout := range []string{
							time.RFC3339Nano,
							time.RFC3339,
							"2006-01-02 15:04:05",
							"2006-01-02T15:04:05",
						} {
							if t, parseErr := time.Parse(layout, clean); parseErr == nil {
								utc := t.UTC()
								ts = &utc
								break
							}
						}
					}

					p := Point{Lon: pt.Lon, Lat: pt.Lat}
					ep := &Epoch{
						ID:        NewUUID(),
						ProfileID: profileID,
						Timestamp: ts,
						Lat:       pt.Lat,
						Lon:       pt.Lon,
						GeomWKT:   p.WKT(),
					}
					batch = append(batch, ep)

					if len(batch) >= batchSize {
						if err := onBatch(batch); err != nil {
							return err
						}
						batch = nil

						if time.Since(lastYield) > 800*time.Millisecond {
							lastYield = time.Now()
							processedBytes = decoder.InputOffset()
							reportGenericProgress(onProgress, startTime, processedBytes, totalBytes, lines, "matching")
						}
					}
				}
			}
		}
	}

	if len(batch) > 0 {
		if err := onBatch(batch); err != nil {
			return err
		}
	}

	reportGenericProgress(onProgress, startTime, totalBytes, totalBytes, lines, "done")
	return nil
}

func reportGenericProgress(onProgress func(ProgressEvent), start time.Time, processed, total, lines int64, stage string) {
	if onProgress == nil {
		return
	}
	elapsed := time.Since(start).Seconds()
	var speedMB float64
	var etaSec int64
	var etaStr = "--:--"
	pct := 1

	if total > 0 {
		pct = int((float64(processed) / float64(total)) * 100)
		if pct < 1 && stage != "done" {
			pct = 1
		}
		if pct > 98 && stage != "done" {
			pct = 98
		}
	}
	if stage == "done" {
		pct = 100
	}

	if elapsed > 0.05 {
		bps := float64(processed) / elapsed
		speedMB = bps / (1024 * 1024)
		if bps > 0 && total > processed {
			rem := float64(total - processed)
			etaSec = int64(rem / bps)
			etaStr = fmt.Sprintf("%02d:%02d", etaSec/60, etaSec%60)
		}
	}

	onProgress(ProgressEvent{
		Type:           "progress",
		Stage:          stage,
		Percent:        pct,
		Lines:          lines,
		ProcessedBytes: processed,
		TotalBytes:     total,
		ETASec:         etaSec,
		ETAStr:         etaStr,
		SpeedMbS:       math.Round(speedMB*10) / 10,
		Message:        fmt.Sprintf("Przetwarzanie (ETA: ~%s, %.1f MB/s)...", etaStr, speedMB),
	})
}


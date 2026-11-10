package parser

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// ParseCSVStream strumieniowo parsuje pliki CSV z automatycznym wykrywaniem kolumn
func ParseCSVStream(r io.Reader, profileID string, totalBytes int64, onBatch func([]*Epoch) error, onProgress func(ProgressEvent)) error {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	if !scanner.Scan() {
		return fmt.Errorf("pusty plik CSV")
	}

	headerLine := scanner.Text()
	delim := ","
	if strings.Contains(headerLine, ";") && strings.Count(headerLine, ";") > strings.Count(headerLine, ",") {
		delim = ";"
	}

	rawHeaders := strings.Split(headerLine, delim)
	latIdx, lonIdx, timeIdx := -1, -1, -1
	gxIdx, gyIdx, gzIdx := -1, -1, -1

	for i, h := range rawHeaders {
		norm := strings.ToLower(strings.Trim(strings.TrimSpace(h), `"'`))
		norm = strings.ReplaceAll(norm, "-", "_")
		norm = strings.ReplaceAll(norm, " ", "_")

		switch norm {
		case "lat", "latitude", "szerokosc", "szerokość", "lat_y", "y":
			latIdx = i
		case "lon", "lng", "longitude", "dlugosc", "długość", "lon_x", "x":
			lonIdx = i
		case "time", "timestamp", "datetime", "czas", "data", "date_time":
			timeIdx = i
		case "gx", "g_x", "accel_x", "acc_x", "ax", "przeciazenie_x", "przeciążenie_x", "gforce_x":
			gxIdx = i
		case "gy", "g_y", "accel_y", "acc_y", "ay", "przeciazenie_y", "przeciążenie_y", "gforce_y":
			gyIdx = i
		case "gz", "g_z", "accel_z", "acc_z", "az", "przeciazenie_z", "przeciążenie_z", "gforce_z":
			gzIdx = i
		}
	}

	if latIdx == -1 || lonIdx == -1 {
		return fmt.Errorf("brak kolumn lat i lon w pliku CSV")
	}

	var batch []*Epoch
	batchSize := 4000
	var lines int64
	var processedBytes int64 = int64(len(headerLine) + 1)
	startTime := time.Now()
	lastYield := time.Now()

	for scanner.Scan() {
		lines++
		lineBytes := scanner.Bytes()
		processedBytes += int64(len(lineBytes) + 1)

		lineStr := string(lineBytes)
		if len(strings.TrimSpace(lineStr)) == 0 {
			continue
		}

		parts := strings.Split(lineStr, delim)
		if len(parts) <= latIdx || len(parts) <= lonIdx {
			continue
		}

		latStr := strings.Replace(strings.Trim(parts[latIdx], `"' `), ",", ".", 1)
		lonStr := strings.Replace(strings.Trim(parts[lonIdx], `"' `), ",", ".", 1)
		lat, errLat := strconv.ParseFloat(latStr, 64)
		lon, errLon := strconv.ParseFloat(lonStr, 64)
		if errLat != nil || errLon != nil {
			continue
		}

		var ts *time.Time
		if timeIdx >= 0 && timeIdx < len(parts) {
			tStr := strings.Trim(parts[timeIdx], `"' `)
			if tStr != "" {
				clean := strings.Replace(tStr, "Z", "+00:00", 1)
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
		}

		var gx, gy, gz *float64
		if gxIdx >= 0 && gxIdx < len(parts) {
			if v, err := strconv.ParseFloat(strings.Trim(parts[gxIdx], `"' `), 64); err == nil {
				gx = &v
			}
		}
		if gyIdx >= 0 && gyIdx < len(parts) {
			if v, err := strconv.ParseFloat(strings.Trim(parts[gyIdx], `"' `), 64); err == nil {
				gy = &v
			}
		}
		if gzIdx >= 0 && gzIdx < len(parts) {
			if v, err := strconv.ParseFloat(strings.Trim(parts[gzIdx], `"' `), 64); err == nil {
				gz = &v
			}
		}

		p := Point{Lon: lon, Lat: lat}
		ep := &Epoch{
			ID:        NewUUID(),
			ProfileID: profileID,
			Timestamp: ts,
			Lat:       lat,
			Lon:       lon,
			GeomWKT:   p.WKT(),
			GX:        gx,
			GY:        gy,
			GZ:        gz,
		}
		batch = append(batch, ep)

		if len(batch) >= batchSize {
			if err := onBatch(batch); err != nil {
				return err
			}
			batch = nil

			if time.Since(lastYield) > 800*time.Millisecond {
				lastYield = time.Now()
				reportGenericProgress(onProgress, startTime, processedBytes, totalBytes, lines, "matching")
			}
		}
	}

	if len(batch) > 0 {
		if err := onBatch(batch); err != nil {
			return err
		}
	}

	reportGenericProgress(onProgress, startTime, totalBytes, totalBytes, lines, "done")
	return scanner.Err()
}


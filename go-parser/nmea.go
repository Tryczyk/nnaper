package main

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

// DDMToDD konwertuje format stopni i minut dziesiętnych NMEA (np. 5421.1234, N) na stopnie dziesiętne
func DDMToDD(ddmStr, dir string) (float64, bool) {
	ddmStr = strings.TrimSpace(ddmStr)
	if len(ddmStr) < 4 {
		return 0, false
	}

	val, err := strconv.ParseFloat(ddmStr, 64)
	if err != nil {
		return 0, false
	}

	deg := math.Floor(val / 100.0)
	mins := val - (deg * 100.0)
	dd := deg + (mins / 60.0)

	dir = strings.ToUpper(strings.TrimSpace(dir))
	if dir == "S" || dir == "W" {
		dd = -dd
	}
	return dd, true
}

// ParseNMEATime parsuje ciąg godziny NMEA np. "123456.789"
func ParseNMEATime(tStr string) (int, int, int, int, bool) {
	tStr = strings.TrimSpace(tStr)
	if len(tStr) < 6 {
		return 0, 0, 0, 0, false
	}

	h, err1 := strconv.Atoi(tStr[0:2])
	m, err2 := strconv.Atoi(tStr[2:4])
	s, err3 := strconv.Atoi(tStr[4:6])
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, 0, 0, false
	}

	nanos := 0
	if len(tStr) > 7 && tStr[6] == '.' {
		fracStr := tStr[7:]
		if len(fracStr) > 9 {
			fracStr = fracStr[:9]
		}
		for len(fracStr) < 9 {
			fracStr += "0"
		}
		if n, err := strconv.Atoi(fracStr); err == nil {
			nanos = n
		}
	}
	return h, m, s, nanos, true
}

// ParseNMEADate parsuje ciąg daty NMEA np. "141026" (dmy)
func ParseNMEADate(dStr string) (int, int, int, bool) {
	dStr = strings.TrimSpace(dStr)
	if len(dStr) != 6 {
		return 0, 0, 0, false
	}

	d, err1 := strconv.Atoi(dStr[0:2])
	m, err2 := strconv.Atoi(dStr[2:4])
	y, err3 := strconv.Atoi(dStr[4:6])
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, 0, false
	}
	// Rok: stulecie 2000
	year := 2000 + y
	if y > 80 {
		year = 1900 + y
	}
	return year, m, d, true
}

// NMEAParser odpowiada za strumieniowe parsowanie plików NMEA / LOG
type NMEAParser struct {
	profileID      string
	lastPoint      *Point
	lastTime       *time.Time
	lastKnownDate  *time.Time
	maxSpeedKmh    float64
	totalBytes     int64
	processedBytes int64
	totalLines     int64
	startTime      time.Time
	lastYieldTime  time.Time
}

func NewNMEAParser(profileID string, lastTs *time.Time, lastLat, lastLon float64, totalBytes int64) *NMEAParser {
	var p *Point
	if lastLat != 0 || lastLon != 0 {
		p = &Point{Lat: lastLat, Lon: lastLon}
	}
	return &NMEAParser{
		profileID:     profileID,
		lastPoint:     p,
		lastTime:      lastTs,
		lastKnownDate: lastTs,
		maxSpeedKmh:   1000.0,
		totalBytes:    totalBytes,
		startTime:     time.Now(),
		lastYieldTime: time.Now(),
	}
}

// ParseStream czyta plik NMEA linijka po linijce ze znikomym zużyciem pamięci RAM
func (np *NMEAParser) ParseStream(r io.Reader, onBatch func(epochs []*Epoch) error, onProgress func(ProgressEvent)) error {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	var currentEpoch *Epoch
	var batch []*Epoch
	batchSize := 4000

	flushCurrentEpoch := func() {
		if currentEpoch != nil && (currentEpoch.Lat != 0 || currentEpoch.Lon != 0) {
			batch = append(batch, currentEpoch)
			currentEpoch = nil
		}
	}

	for scanner.Scan() {
		np.totalLines++
		rawBytes := scanner.Bytes()
		np.processedBytes += int64(len(rawBytes) + 1)

		rawLine := strings.TrimSpace(string(rawBytes))
		if len(rawLine) == 0 {
			continue
		}

		// Obsługa prefiksów czasowych przed znakiem $
		dollarIdx := strings.Index(rawLine, "$G")
		if dollarIdx >= 0 {
			rawLine = rawLine[dollarIdx:]
		} else if !strings.HasPrefix(rawLine, "$") {
			continue
		}

		// Usunięcie sumy kontrolnej *XX
		if starIdx := strings.Index(rawLine, "*"); starIdx >= 0 {
			rawLine = rawLine[:starIdx]
		}

		parts := strings.Split(rawLine, ",")
		if len(parts) == 0 {
			continue
		}
		tag := strings.ToUpper(parts[0])

		if strings.HasSuffix(tag, "SENSORD") || tag == "$GSENSORD" {
			if len(parts) >= 4 {
				flushCurrentEpoch()
				gx, _ := strconv.ParseFloat(parts[1], 64)
				gy, _ := strconv.ParseFloat(parts[2], 64)
				gz, _ := strconv.ParseFloat(parts[3], 64)
				currentEpoch = &Epoch{
					ProfileID: np.profileID,
					GX:        &gx,
					GY:        &gy,
					GZ:        &gz,
				}
			}

		} else if strings.HasSuffix(tag, "RMC") {
			if len(parts) >= 10 {
				flushCurrentEpoch()

				var epTimestamp *time.Time
				var chosenDate *time.Time

				// Data i czas
				if len(parts[9]) == 6 && len(parts[1]) >= 6 {
					y, m, d, okDate := ParseNMEADate(parts[9])
					h, mi, s, ns, okTime := ParseNMEATime(parts[1])
					if okDate && okTime {
						dt := time.Date(y, time.Month(m), d, h, mi, s, ns, time.UTC)
						epTimestamp = &dt
						dateOnly := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
						chosenDate = &dateOnly
						np.lastKnownDate = chosenDate
					}
				}

				if epTimestamp == nil && np.lastKnownDate != nil && len(parts[1]) >= 6 {
					h, mi, s, ns, okTime := ParseNMEATime(parts[1])
					if okTime {
						dt := time.Date(np.lastKnownDate.Year(), np.lastKnownDate.Month(), np.lastKnownDate.Day(), h, mi, s, ns, time.UTC)
						epTimestamp = &dt
					}
				}

				lat, okLat := DDMToDD(parts[3], parts[4])
				lon, okLon := DDMToDD(parts[5], parts[6])
				if okLat && okLon {
					speedKmh := 0.0
					if np.lastPoint != nil && np.lastTime != nil && epTimestamp != nil {
						dtSec := epTimestamp.Sub(*np.lastTime).Seconds()
						if dtSec > 0 {
							distM := HaversineMeters(np.lastPoint.Lat, np.lastPoint.Lon, lat, lon)
							speedKmh = (distM / dtSec) * 3.6
						}
					}
					if speedKmh <= np.maxSpeedKmh {
						pt := Point{Lon: lon, Lat: lat}
						currentEpoch = &Epoch{
							ID:        fmt.Sprintf("%d-%d", time.Now().UnixNano(), np.totalLines),
							ProfileID: np.profileID,
							Timestamp: epTimestamp,
							Lat:       lat,
							Lon:       lon,
							GeomWKT:   pt.WKT(),
							SpeedKmh:  math.Round(speedKmh*100) / 100,
						}
						np.lastPoint = &pt
						if epTimestamp != nil {
							np.lastTime = epTimestamp
						}
					}
				}
			}

		} else if strings.HasSuffix(tag, "GGA") {
			if len(parts) >= 6 && currentEpoch == nil {
				lat, okLat := DDMToDD(parts[2], parts[3])
				lon, okLon := DDMToDD(parts[4], parts[5])
				if okLat && okLon {
					var epTimestamp *time.Time
					if np.lastKnownDate != nil && len(parts[1]) >= 6 {
						h, mi, s, ns, okTime := ParseNMEATime(parts[1])
						if okTime {
							dt := time.Date(np.lastKnownDate.Year(), np.lastKnownDate.Month(), np.lastKnownDate.Day(), h, mi, s, ns, time.UTC)
							epTimestamp = &dt
						}
					}
					pt := Point{Lon: lon, Lat: lat}
					currentEpoch = &Epoch{
						ID:        fmt.Sprintf("%d-%d", time.Now().UnixNano(), np.totalLines),
						ProfileID: np.profileID,
						Timestamp: epTimestamp,
						Lat:       lat,
						Lon:       lon,
						GeomWKT:   pt.WKT(),
					}
				}
			}

		} else if strings.HasSuffix(tag, "GSV") {
			if currentEpoch != nil && len(parts) >= 8 {
				for sIdx := 4; sIdx+3 < len(parts); sIdx += 4 {
					prn, _ := strconv.Atoi(parts[sIdx])
					elev, _ := strconv.Atoi(parts[sIdx+1])
					azim, _ := strconv.Atoi(parts[sIdx+2])
					if prn > 0 {
						currentEpoch.Satellites = append(currentEpoch.Satellites, SatelliteData{
							PRN:       int16(prn),
							Elevation: int16(elev),
							Azimuth:   int16(azim),
						})
					}
				}
			}
		}

		// Okresowy flush partii
		if len(batch) >= batchSize {
			if err := onBatch(batch); err != nil {
				return err
			}
			batch = nil

			if time.Since(np.lastYieldTime) > 800*time.Millisecond {
				np.reportProgress(onProgress, "matching")
			}
		}
	}

	flushCurrentEpoch()
	if len(batch) > 0 {
		if err := onBatch(batch); err != nil {
			return err
		}
	}

	np.reportProgress(onProgress, "done")
	return scanner.Err()
}

func (np *NMEAParser) reportProgress(onProgress func(ProgressEvent), stage string) {
	if onProgress == nil {
		return
	}
	np.lastYieldTime = time.Now()
	elapsed := time.Since(np.startTime).Seconds()
	var speedMB float64
	var etaSec int64
	var etaStr = "--:--"
	pct := 5

	if np.totalBytes > 0 {
		pct = int((float64(np.processedBytes) / float64(np.totalBytes)) * 100)
		if pct > 98 && stage != "done" {
			pct = 98
		}
	}
	if stage == "done" {
		pct = 100
	}

	if elapsed > 0.05 {
		bytesPerSec := float64(np.processedBytes) / elapsed
		speedMB = bytesPerSec / (1024 * 1024)
		if bytesPerSec > 0 && np.totalBytes > np.processedBytes {
			rem := float64(np.totalBytes - np.processedBytes)
			etaSec = int64(rem / bytesPerSec)
			etaStr = fmt.Sprintf("%02d:%02d", etaSec/60, etaSec%60)
		}
	}

	onProgress(ProgressEvent{
		Type:           "progress",
		Stage:          stage,
		Percent:        pct,
		Lines:          np.totalLines,
		ProcessedBytes: np.processedBytes,
		TotalBytes:     np.totalBytes,
		ETASec:         etaSec,
		ETAStr:         etaStr,
		SpeedMbS:       math.Round(speedMB*10) / 10,
		Message:        fmt.Sprintf("Przetwarzanie (ETA: ~%s, %.1f MB/s)...", etaStr, speedMB),
	})
}


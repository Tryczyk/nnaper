package parser

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

	type rawEpochBuilder struct {
		hasSensord  bool
		gx, gy, gz  float64
		hasRMC      bool
		rmcTime     string
		rmcDate     string
		rmcLat      float64
		rmcLon      float64
		rmcSpeedKmh float64
		rmcValid    bool
		hasGGA      bool
		ggaTime     string
		ggaLat      float64
		ggaLon      float64
		ggaValid    bool
		satellites  []SatelliteData
	}

	curBuilder := &rawEpochBuilder{}
	var batch []*Epoch
	batchSize := 2000

	// Natychmiastowy początkowy sygnał rozpoczęcia parsowania
	np.reportProgress(onProgress, "parsing")

	flushBuilder := func() {
		var epTimestamp *time.Time
		var lat, lon float64
		hasCoord := false
		speedKmh := 0.0

		if curBuilder.rmcValid {
			lat = curBuilder.rmcLat
			lon = curBuilder.rmcLon
			hasCoord = true

			if len(curBuilder.rmcDate) == 6 && len(curBuilder.rmcTime) >= 6 {
				y, m, d, okDate := ParseNMEADate(curBuilder.rmcDate)
				h, mi, s, ns, okTime := ParseNMEATime(curBuilder.rmcTime)
				if okDate && okTime {
					dt := time.Date(y, time.Month(m), d, h, mi, s, ns, time.UTC)
					epTimestamp = &dt
					dateOnly := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC)
					np.lastKnownDate = &dateOnly
				}
			}
			if epTimestamp == nil && np.lastKnownDate != nil && len(curBuilder.rmcTime) >= 6 {
				h, mi, s, ns, okTime := ParseNMEATime(curBuilder.rmcTime)
				if okTime {
					dt := time.Date(np.lastKnownDate.Year(), np.lastKnownDate.Month(), np.lastKnownDate.Day(), h, mi, s, ns, time.UTC)
					epTimestamp = &dt
				}
			}
			speedKmh = curBuilder.rmcSpeedKmh
		} else if curBuilder.ggaValid {
			lat = curBuilder.ggaLat
			lon = curBuilder.ggaLon
			hasCoord = true

			if np.lastKnownDate != nil && len(curBuilder.ggaTime) >= 6 {
				h, mi, s, ns, okTime := ParseNMEATime(curBuilder.ggaTime)
				if okTime {
					dt := time.Date(np.lastKnownDate.Year(), np.lastKnownDate.Month(), np.lastKnownDate.Day(), h, mi, s, ns, time.UTC)
					epTimestamp = &dt
				}
			}
		}

		if !hasCoord || (lat == 0 && lon == 0) {
			curBuilder = &rawEpochBuilder{}
			return
		}

		if speedKmh == 0.0 && np.lastPoint != nil && np.lastTime != nil && epTimestamp != nil {
			dtSec := epTimestamp.Sub(*np.lastTime).Seconds()
			if dtSec > 0 {
				distM := HaversineMeters(np.lastPoint.Lat, np.lastPoint.Lon, lat, lon)
				speedKmh = (distM / dtSec) * 3.6
			}
		}

		if speedKmh <= np.maxSpeedKmh {
			pt := Point{Lon: lon, Lat: lat}
			ep := &Epoch{
				ID:         NewUUID(),
				ProfileID:  np.profileID,
				Timestamp:  epTimestamp,
				Lat:        lat,
				Lon:        lon,
				GeomWKT:    pt.WKT(),
				SpeedKmh:   math.Round(speedKmh*100) / 100,
				Satellites: curBuilder.satellites,
			}
			if curBuilder.hasSensord {
				gx := curBuilder.gx
				gy := curBuilder.gy
				gz := curBuilder.gz
				ep.GX = &gx
				ep.GY = &gy
				ep.GZ = &gz
			}
			np.lastPoint = &pt
			if epTimestamp != nil {
				np.lastTime = epTimestamp
			}
			batch = append(batch, ep)
		}

		curBuilder = &rawEpochBuilder{}
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
				if curBuilder.hasSensord {
					flushBuilder()
				}
				gx, _ := strconv.ParseFloat(parts[1], 64)
				gy, _ := strconv.ParseFloat(parts[2], 64)
				gz, _ := strconv.ParseFloat(parts[3], 64)
				curBuilder.hasSensord = true
				curBuilder.gx = gx
				curBuilder.gy = gy
				curBuilder.gz = gz
			}

		} else if strings.HasSuffix(tag, "RMC") {
			if len(parts) >= 10 {
				if curBuilder.hasRMC {
					flushBuilder()
				}
				curBuilder.hasRMC = true
				curBuilder.rmcTime = parts[1]
				curBuilder.rmcDate = parts[9]
				if lat, okLat := DDMToDD(parts[3], parts[4]); okLat {
					if lon, okLon := DDMToDD(parts[5], parts[6]); okLon {
						curBuilder.rmcLat = lat
						curBuilder.rmcLon = lon
						curBuilder.rmcValid = true
						if len(parts) > 7 {
							if spdKnots, err := strconv.ParseFloat(parts[7], 64); err == nil && spdKnots > 0 {
								curBuilder.rmcSpeedKmh = spdKnots * 1.852
							}
						}
					}
				}
			}

		} else if strings.HasSuffix(tag, "GGA") {
			if len(parts) >= 6 {
				if curBuilder.hasGGA {
					flushBuilder()
				}
				curBuilder.hasGGA = true
				curBuilder.ggaTime = parts[1]
				if lat, okLat := DDMToDD(parts[2], parts[3]); okLat {
					if lon, okLon := DDMToDD(parts[4], parts[5]); okLon {
						curBuilder.ggaLat = lat
						curBuilder.ggaLon = lon
						curBuilder.ggaValid = true
					}
				}
			}

		} else if strings.HasSuffix(tag, "GSV") {
			if len(parts) >= 4 {
				totMsg, _ := strconv.Atoi(parts[1])
				msgNum, _ := strconv.Atoi(parts[2])
				if totMsg > 0 && msgNum == 1 && len(curBuilder.satellites) > 0 {
					flushBuilder()
				}
				// Próbkowanie satelitów co 5 cykli, aby nie zalewać bazy 15 milionami rekordów
				if np.totalLines%5 == 0 && len(parts) >= 8 {
					for sIdx := 4; sIdx+3 < len(parts); sIdx += 4 {
						prn, _ := strconv.Atoi(parts[sIdx])
						elev, _ := strconv.Atoi(parts[sIdx+1])
						azim, _ := strconv.Atoi(parts[sIdx+2])
						if prn > 0 {
							curBuilder.satellites = append(curBuilder.satellites, SatelliteData{
								PRN:       int16(prn),
								Elevation: int16(elev),
								Azimuth:   int16(azim),
							})
						}
					}
				}
			}
		}

		// Ciągłe raportowanie postępu co ~800ms
		if time.Since(np.lastYieldTime) > 800*time.Millisecond {
			np.reportProgress(onProgress, "parsing")
		}

		// Okresowy flush partii do OSRM i bazy
		if len(batch) >= batchSize {
			np.reportProgress(onProgress, "matching")
			if err := onBatch(batch); err != nil {
				return err
			}
			batch = nil
			np.reportProgress(onProgress, "parsing")
		}
	}

	flushBuilder()
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
	pct := 1

	if np.totalBytes > 0 {
		pct = int((float64(np.processedBytes) / float64(np.totalBytes)) * 100)
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
		bytesPerSec := float64(np.processedBytes) / elapsed
		speedMB = bytesPerSec / (1024 * 1024)
		if bytesPerSec > 0 && np.totalBytes > np.processedBytes {
			rem := float64(np.totalBytes - np.processedBytes)
			etaSec = int64(rem / bytesPerSec)
			etaH := etaSec / 3600
			etaM := (etaSec % 3600) / 60
			etaS := etaSec % 60
			if etaH > 0 {
				etaStr = fmt.Sprintf("%02d:%02d:%02d", etaH, etaM, etaS)
			} else {
				etaStr = fmt.Sprintf("%02d:%02d", etaM, etaS)
			}
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


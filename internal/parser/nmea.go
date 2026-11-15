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
	filters        NMEAFilterOptions
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

func NewNMEAParserWithFilters(profileID string, filters NMEAFilterOptions, lastTs *time.Time, lastLat, lastLon float64, totalBytes int64) *NMEAParser {
	var p *Point
	if lastLat != 0 || lastLon != 0 {
		p = &Point{Lat: lastLat, Lon: lastLon}
	}
	maxSpd := filters.MaxSpeedKmh
	if maxSpd <= 0 {
		maxSpd = 1000.0
	}
	return &NMEAParser{
		profileID:     profileID,
		filters:       filters,
		lastPoint:     p,
		lastTime:      lastTs,
		lastKnownDate: lastTs,
		maxSpeedKmh:   maxSpd,
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
		hasSensord    bool
		gx, gy, gz    float64
		hasRMC        bool
		rmcTime       string
		rmcDate       string
		rmcLat        float64
		rmcLon        float64
		rmcSpeedKmh   float64
		rmcValid      bool
		hasGGA        bool
		ggaTime       string
		ggaLat        float64
		ggaLon        float64
		ggaValid      bool
		ggaFixQuality int
		ggaNumSats    int
		ggaHDOP       float64
		ggaAlt        float64
		hasAlt        bool
		hasGSA        bool
		gsaPDOP       float64
		gsaHDOP       float64
		gsaVDOP       float64
		satellites    []SatelliteData
	}

	curBuilder := &rawEpochBuilder{}
	var lastCompleteSatellites []SatelliteData
	var gsvAccumulator []SatelliteData
	var batch []*Epoch
	batchSize := 2000

	// Natychmiastowy początkowy sygnał rozpoczęcia parsowania
	np.reportProgress(onProgress, "parsing")

	flushBuilder := func() {
		var epTimestamp *time.Time
		var lat, lon float64
		hasCoord := false
		speedKmh := 0.0

		// Filtrowanie RMC: czy wymagać statusu Valid 'A'
		if np.filters.RequireValidRMC && curBuilder.hasRMC && !curBuilder.rmcValid {
			curBuilder = &rawEpochBuilder{}
			return
		}

		// Filtrowanie jakości Fix i błędów z GGA
		if curBuilder.hasGGA {
			if np.filters.EnableFixQuality && np.filters.MinFixQuality > 0 && curBuilder.ggaFixQuality < np.filters.MinFixQuality {
				curBuilder = &rawEpochBuilder{}
				return
			}
			if np.filters.EnableSatellites && np.filters.MinSatellites > 0 && curBuilder.ggaNumSats < np.filters.MinSatellites {
				curBuilder = &rawEpochBuilder{}
				return
			}
			if np.filters.EnableHDOP && np.filters.MaxHDOP > 0 && curBuilder.ggaHDOP > 0 && curBuilder.ggaHDOP > np.filters.MaxHDOP {
				curBuilder = &rawEpochBuilder{}
				return
			}
			if np.filters.EnableAltitude && curBuilder.hasAlt {
				if curBuilder.ggaAlt < np.filters.MinAltitude || curBuilder.ggaAlt > np.filters.MaxAltitude {
					curBuilder = &rawEpochBuilder{}
					return
				}
			}
		}

		// Filtrowanie błędu przestrzennego PDOP / HDOP z GSA
		if curBuilder.hasGSA {
			if np.filters.EnablePDOP && np.filters.MaxPDOP > 0 && curBuilder.gsaPDOP > 0 && curBuilder.gsaPDOP > np.filters.MaxPDOP {
				curBuilder = &rawEpochBuilder{}
				return
			}
			if np.filters.EnableHDOP && np.filters.MaxHDOP > 0 && curBuilder.gsaHDOP > 0 && curBuilder.gsaHDOP > np.filters.MaxHDOP {
				curBuilder = &rawEpochBuilder{}
				return
			}
		}

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

		// Prędkość ZAWSZE liczymy wyłącznie ze skoku geometrycznego (Haversine / dt), NIGDY z danych wejściowych
		speedKmh = 0.0
		if np.lastPoint != nil && np.lastTime != nil && epTimestamp != nil {
			dtSec := epTimestamp.Sub(*np.lastTime).Seconds()
			distM := HaversineMeters(np.lastPoint.Lat, np.lastPoint.Lon, lat, lon)
			if dtSec > 0 {
				speedKmh = (distM / dtSec) * 3.6
			} else if dtSec == 0 {
				if distM > 0.01 {
					// Natychmiastowy skok pozycji w zerowym czasie = prędkość nieskończona
					speedKmh = math.MaxFloat64
				} else {
					speedKmh = 0.0
				}
			} else {
				// Czas się cofnął przy zmianie współrzędnych
				speedKmh = math.MaxFloat64
			}
		}

		maxSpd := np.filters.MaxSpeedKmh
		if !np.filters.EnableMaxSpeed || maxSpd <= 0 {
			maxSpd = np.maxSpeedKmh
		}
		if maxSpd <= 0 {
			maxSpd = 1000.0
		}

		if speedKmh <= maxSpd {
			pt := Point{Lon: lon, Lat: lat}
			sats := curBuilder.satellites
			if len(sats) == 0 && len(lastCompleteSatellites) > 0 {
				sats = lastCompleteSatellites
			}
			ep := &Epoch{
				ID:         NewUUID(),
				ProfileID:  np.profileID,
				Timestamp:  epTimestamp,
				Lat:        lat,
				Lon:        lon,
				GeomWKT:    pt.WKT(),
				SpeedKmh:   math.Round(speedKmh*100) / 100,
				Satellites: sats,
			}
			if curBuilder.hasAlt {
				alt := math.Round(curBuilder.ggaAlt*100) / 100
				ep.AltitudeM = &alt
			}
			if curBuilder.hasGGA && curBuilder.ggaHDOP > 0 {
				hdop := math.Round(curBuilder.ggaHDOP*100) / 100
				ep.HDOP = &hdop
			} else if curBuilder.hasGSA && curBuilder.gsaHDOP > 0 {
				hdop := math.Round(curBuilder.gsaHDOP*100) / 100
				ep.HDOP = &hdop
			}
			if curBuilder.hasGGA && curBuilder.ggaNumSats > 0 {
				sats := int16(curBuilder.ggaNumSats)
				ep.NumSatellites = &sats
			}
			if curBuilder.hasGGA && curBuilder.ggaFixQuality > 0 {
				fq := int16(curBuilder.ggaFixQuality)
				ep.FixQuality = &fq
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
				status := strings.ToUpper(strings.TrimSpace(parts[2]))
				if status == "A" {
					if lat, okLat := DDMToDD(parts[3], parts[4]); okLat {
						if lon, okLon := DDMToDD(parts[5], parts[6]); okLon {
							curBuilder.rmcLat = lat
							curBuilder.rmcLon = lon
							curBuilder.rmcValid = true
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
						if len(parts) > 6 && parts[6] != "" {
							if fq, err := strconv.Atoi(parts[6]); err == nil {
								curBuilder.ggaFixQuality = fq
							}
						}
						if len(parts) > 7 && parts[7] != "" {
							if ns, err := strconv.Atoi(parts[7]); err == nil {
								curBuilder.ggaNumSats = ns
							}
						}
						if len(parts) > 8 && parts[8] != "" {
							if hd, err := strconv.ParseFloat(parts[8], 64); err == nil {
								curBuilder.ggaHDOP = hd
							}
						}
						if len(parts) > 9 && parts[9] != "" {
							if alt, err := strconv.ParseFloat(parts[9], 64); err == nil {
								curBuilder.ggaAlt = alt
								curBuilder.hasAlt = true
							}
						}
					}
				}
			}

		} else if strings.HasSuffix(tag, "GSA") {
			if len(parts) >= 16 {
				curBuilder.hasGSA = true
				if len(parts) > 15 && parts[15] != "" {
					if pd, err := strconv.ParseFloat(parts[15], 64); err == nil {
						curBuilder.gsaPDOP = pd
					}
				}
				if len(parts) > 16 && parts[16] != "" {
					if hd, err := strconv.ParseFloat(parts[16], 64); err == nil {
						curBuilder.gsaHDOP = hd
					}
				}
				if len(parts) > 17 && parts[17] != "" {
					if vd, err := strconv.ParseFloat(parts[17], 64); err == nil {
						curBuilder.gsaVDOP = vd
					}
				}
			}

		} else if strings.HasSuffix(tag, "GSV") {
			if len(parts) >= 4 {
				totMsg, _ := strconv.Atoi(parts[1])
				msgNum, _ := strconv.Atoi(parts[2])
				if msgNum == 1 {
					gsvAccumulator = nil
				}
				if len(parts) >= 8 {
					for sIdx := 4; sIdx+3 < len(parts); sIdx += 4 {
						prn, _ := strconv.Atoi(parts[sIdx])
						elev, _ := strconv.Atoi(parts[sIdx+1])
						azim, _ := strconv.Atoi(parts[sIdx+2])
						if prn > 0 {
							gsvAccumulator = append(gsvAccumulator, SatelliteData{
								PRN:       int16(prn),
								Elevation: int16(elev),
								Azimuth:   int16(azim),
							})
						}
					}
				}
				if totMsg > 0 && msgNum >= totMsg && len(gsvAccumulator) > 0 {
					lastCompleteSatellites = make([]SatelliteData, len(gsvAccumulator))
					copy(lastCompleteSatellites, gsvAccumulator)
					curBuilder.satellites = lastCompleteSatellites
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


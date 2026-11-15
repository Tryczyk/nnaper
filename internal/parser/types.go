package parser

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

// NewUUID generuje unikalny identyfikator UUID v4 zgodny z RFC 4122
func NewUUID() string {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		binary.BigEndian.PutUint64(b[0:8], uint64(time.Now().UnixNano()))
		binary.BigEndian.PutUint64(b[8:16], uint64(time.Now().UnixNano()^0x55aa55aa))
	}
	b[6] = (b[6] & 0x0f) | 0x40 // Version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Point reprezentuje współrzędne geograficzne WGS84
type Point struct {
	Lon float64
	Lat float64
}

func (p Point) WKT() string {
	return fmt.Sprintf("SRID=4326;POINT(%.6f %.6f)", p.Lon, p.Lat)
}

func (p Point) CacheKey() [2]int64 {
	return [2]int64{
		int64(math.Round(p.Lon * 100000)),
		int64(math.Round(p.Lat * 100000)),
	}
}

// RouteKey identyfikuje parę punktów w cache tras
type RouteKey struct {
	P1 [2]int64
	P2 [2]int64
}

func MakeRouteKey(p1, p2 Point) RouteKey {
	return RouteKey{
		P1: p1.CacheKey(),
		P2: p2.CacheKey(),
	}
}

// SatelliteData reprezentuje dane pojedynczego satelity
type SatelliteData struct {
	PRN       int16 `json:"prn"`
	Elevation int16 `json:"elevation"`
	Azimuth   int16 `json:"azimuth"`
}

// NMEAFilterOptions definiuje parametry filtrowania danych NMEA / GPS
type NMEAFilterOptions struct {
	EnableFixQuality bool    `json:"enable_fix_quality"` // czy aktywny wybierak jakości Fix
	MinFixQuality    int     `json:"min_fix_quality"`    // 0 = dowolny, 1 = GPS SPS (zalecane), 2 = DGPS, 4 = RTK
	EnableSatellites bool    `json:"enable_satellites"`  // czy aktywny wybierak liczby satelitów
	MinSatellites    int     `json:"min_satellites"`     // min liczba satelitow (zalecane: 4)
	EnableHDOP       bool    `json:"enable_hdop"`        // czy aktywny wybierak błędu HDOP
	MaxHDOP          float64 `json:"max_hdop"`           // maks dopuszczalny blad HDOP (zalecane: 5.0)
	EnablePDOP       bool    `json:"enable_pdop"`        // czy aktywny wybierak błędu PDOP
	MaxPDOP          float64 `json:"max_pdop"`           // maks dopuszczalny blad PDOP (zalecane: 6.0)
	EnableAltitude   bool    `json:"enable_altitude"`    // czy aktywny wybierak pułapu wysokości
	MinAltitude      float64 `json:"min_altitude"`       // min wysokosc n.p.m. w metrach (zalecane: -50.0)
	MaxAltitude      float64 `json:"max_altitude"`       // maks wysokosc n.p.m. w metrach (zalecane: 5000.0)
	EnableMaxSpeed   bool    `json:"enable_max_speed"`   // czy aktywny wybierak prędkości maksymalnej
	MaxSpeedKmh      float64 `json:"max_speed_kmh"`      // maks predkosc km/h do odciecia teleportacji (zalecane: 250.0)
	RequireValidRMC  bool    `json:"require_valid_rmc"`  // czy wymagac statusu 'A' (Valid) z RMC (zalecane: true)
}

// DefaultNMEAFilterOptions zwraca standardowe, zalecane parametry filtracji
func DefaultNMEAFilterOptions() NMEAFilterOptions {
	return NMEAFilterOptions{
		EnableFixQuality: true,
		MinFixQuality:    1,
		EnableSatellites: true,
		MinSatellites:    4,
		EnableHDOP:       true,
		MaxHDOP:          5.0,
		EnablePDOP:       true,
		MaxPDOP:          6.0,
		EnableAltitude:   true,
		MinAltitude:      -50.0,
		MaxAltitude:      5000.0,
		EnableMaxSpeed:   true,
		MaxSpeedKmh:      250.0,
		RequireValidRMC:  true,
	}
}

// Epoch reprezentuje epokę telemetryczną GPS
type Epoch struct {
	ID            string
	ProfileID     string
	Timestamp     *time.Time
	Lat           float64
	Lon           float64
	GeomWKT       string
	GeomSnapped   string
	GeomLine      string
	SpeedKmh      float64
	AltitudeM     *float64
	HDOP          *float64
	NumSatellites *int16
	FixQuality    *int16
	GX            *float64
	GY            *float64
	GZ            *float64
	Satellites    []SatelliteData
}

// ProgressEvent reprezentuje zdarzenie raportowania postępu kompatybilne z frontendem NNAPER
type ProgressEvent struct {
	Type           string  `json:"type"`
	Stage          string  `json:"stage"`
	Percent        int     `json:"percent"`
	Lines          int64   `json:"lines"`
	Epochs         int64   `json:"epochs"`
	Satellites     int64   `json:"satellites"`
	ProcessedBytes int64   `json:"processed_bytes"`
	TotalBytes     int64   `json:"total_bytes"`
	ETASec         int64   `json:"eta_seconds"`
	ETAStr         string  `json:"eta_str"`
	SpeedMbS       float64 `json:"speed_mb_s"`
	Message        string  `json:"message"`
	Filename       string  `json:"filename"`
	Error          string  `json:"error,omitempty"`
}

// HaversineMeters oblicza odległość ortodromiczną w metrach między dwoma punktami
func HaversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371000.0 // promień Ziemi w metrach
	dLat := (lat2 - lat1) * (math.Pi / 180.0)
	dLon := (lon2 - lon1) * (math.Pi / 180.0)
	lat1Rad := lat1 * (math.Pi / 180.0)
	lat2Rad := lat2 * (math.Pi / 180.0)

	a := math.Sin(dLat/2.0)*math.Sin(dLat/2.0) +
		math.Cos(lat1Rad)*math.Cos(lat2Rad)*math.Sin(dLon/2.0)*math.Sin(dLon/2.0)
	c := 2.0 * math.Atan2(math.Sqrt(a), math.Sqrt(math.Max(0.0, 1.0-a)))
	return r * c
}

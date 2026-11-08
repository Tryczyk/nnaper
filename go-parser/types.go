package main

import (
	"fmt"
	"math"
	"time"
)

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
	PRN       int16
	Elevation int16
	Azimuth   int16
}

// Epoch reprezentuje epokę telemetryczną GPS
type Epoch struct {
	ID          string
	ProfileID   string
	Timestamp   *time.Time
	Lat         float64
	Lon         float64
	GeomWKT     string
	GeomSnapped string
	GeomLine    string
	SpeedKmh    float64
	GX          *float64
	GY          *float64
	GZ          *float64
	Satellites  []SatelliteData
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


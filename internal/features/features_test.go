package features

import (
	"math"
	"testing"
)

func TestFogOfWarDeterministicTriangleParcel(t *testing.T) {
	key, coords, areaM2 := ComputeDeterministicSquareTriangle(54.3500, 18.6400)
	if len(coords) < 3 {
		t.Fatalf("expected triangle ring, got %d points", len(coords))
	}
	if key == "" {
		t.Fatalf("expected non-empty key")
	}
	if areaM2 <= 0 {
		t.Fatalf("expected positive area, got %f", areaM2)
	}
}

func TestHeatmapGradientColor(t *testing.T) {
	// 0 punktów = przezroczysty
	c0 := heatmapColorForCount(0, 100)
	if c0.A != 0 {
		t.Fatalf("expected 0 points to be fully transparent (A=0), got %+v", c0)
	}

	// 1 punkt = zielony
	c1 := heatmapColorForCount(1, 100)
	if c1.G <= c1.R || c1.A == 0 {
		t.Fatalf("expected 1 point to be green (G > R, A > 0), got %+v", c1)
	}

	// max punktów = czerwony
	cMax := heatmapColorForCount(100, 100)
	if cMax.R <= cMax.G || cMax.A == 0 {
		t.Fatalf("expected max points to be red (R > G, A > 0), got %+v", cMax)
	}
}

func TestComputeDrawingMetrics(t *testing.T) {
	// Kwadrat o boku ~100m
	dLat := 100.0 / 111320.0
	dLon := 100.0 / (111320.0 * math.Cos(54.35*math.Pi/180.0))
	coords := [][2]float64{
		{18.64, 54.35},
		{18.64 + dLon, 54.35},
		{18.64 + dLon, 54.35 + dLat},
		{18.64, 54.35 + dLat},
	}

	areaM2, perimM, _ := ComputeDrawingMetrics("polygon", coords)
	if math.Abs(areaM2-10000) > 250 {
		t.Fatalf("expected polygon area ~10000 m2, got %f", areaM2)
	}
	if math.Abs(perimM-400) > 10 {
		t.Fatalf("expected polygon perimeter ~400 m, got %f", perimM)
	}
}

package features

import (
	"math"
	"testing"
)

func TestFogOfWarDeterministicTriangleParcel(t *testing.T) {
	// Kwadrat 1km x 1km podzielony na 4 trójkąty równoramienne prostokątne ma pole 250000 m² (0.25 km²) każdy
	tri, sideM, areaM2 := ComputeDeterministicSquareTriangle(18.6400, 54.3500, 0)
	if len(tri) != 4 {
		t.Fatalf("expected closed triangle ring with 4 vertices, got %d", len(tri))
	}
	if math.Abs(areaM2-250000.0) > 1.0 {
		t.Fatalf("expected 1/4 of 1km x 1km square (250000 m2), got %f", areaM2)
	}
	if math.Abs(sideM-707.10678) > 1.0 {
		t.Fatalf("expected isosceles leg ~707.1m, got %f", sideM)
	}
}

func TestHeatmapGradientColor(t *testing.T) {
	// 0 punktów = przezroczysty
	c0 := HeatmapColorForCount(0, 100)
	if c0.A != 0 {
		t.Fatalf("expected 0 points to be fully transparent (A=0), got %+v", c0)
	}

	// 1 punkt = zielony
	c1 := HeatmapColorForCount(1, 100)
	if c1.G <= c1.R || c1.A == 0 {
		t.Fatalf("expected 1 point to be green (G > R, A > 0), got %+v", c1)
	}

	// max punktów = czerwony
	cMax := HeatmapColorForCount(100, 100)
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

	areaM2, perimM := ComputePolygonAreaAndPerimeter(coords)
	if math.Abs(areaM2-10000) > 250 {
		t.Fatalf("expected polygon area ~10000 m2, got %f", areaM2)
	}
	if math.Abs(perimM-400) > 10 {
		t.Fatalf("expected polygon perimeter ~400 m, got %f", perimM)
	}
}

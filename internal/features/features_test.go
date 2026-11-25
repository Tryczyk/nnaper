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

func TestTriangulateBlockParcelOctagon(t *testing.T) {
	// Działka / kwartał o 8 bokach (otoczony 8 ulicami)
	// Powinna zostać podzielona na dokładnie 8 trójkątów, każdy ze wspólnym wierzchołkiem w środku
	var oct [][2]float64
	for i := 0; i < 8; i++ {
		angle := float64(i) * (2 * math.Pi / 8.0)
		oct = append(oct, [2]float64{
			18.64 + 0.002*math.Cos(angle),
			54.35 + 0.001*math.Sin(angle),
		})
	}
	// Zamknięcie pierścienia
	oct = append(oct, oct[0])

	triangles := TriangulateBlockParcel(oct)
	if len(triangles) != 8 {
		t.Fatalf("oczekiwano 8 trójkątów dla 8 ulic wokół działki, otrzymano %d", len(triangles))
	}

	for i, tri := range triangles {
		if len(tri.Triangle) != 4 {
			t.Fatalf("trójkąt %d powinien mieć 4 punkty (zamknięty trójkąt), ma %d", i+1, len(tri.Triangle))
		}
		if tri.AreaM2 <= 0 {
			t.Fatalf("trójkąt %d powinien mieć dodatnie pole, ma %f", i+1, tri.AreaM2)
		}
	}
}

func TestTriangulateBlockParcelUShaped(t *testing.T) {
	// Działka w kształcie litery U (otoczona 8 odcinkami ulic):
	// (0,0) -> (3,0) -> (3,3) -> (2,3) -> (2,1) -> (1,1) -> (1,3) -> (0,3) -> (0,0)
	// Trójkąty nie mogą wychodzić poza obręb litery U do pustej przestrzeni wcięcia (1<x<2, y>1).
	uPoly := [][2]float64{
		{18.640, 54.350},
		{18.643, 54.350},
		{18.643, 54.353},
		{18.642, 54.353},
		{18.642, 54.351},
		{18.641, 54.351},
		{18.641, 54.353},
		{18.640, 54.353},
		{18.640, 54.350},
	}

	triangles := TriangulateBlockParcel(uPoly)
	if len(triangles) != 8 {
		t.Fatalf("oczekiwano 8 trójkątów dla 8 ulic działki U-kształtnej, otrzymano %d", len(triangles))
	}

	// Każdy wyznaczony wierzchołek trójkąta (apex) musi leżeć ściśle wewnątrz wielokąta U
	cleanUPoly := uPoly[:8]
	for i, tri := range triangles {
		apex := tri.Triangle[2]
		if !isPointInPolygon(apex, cleanUPoly) {
			t.Fatalf("wierzchołek trójkąta %d (%f, %f) wyszedł poza obrys działki U-kształtnej!", i+1, apex[0], apex[1])
		}
		if tri.AreaM2 <= 0 {
			t.Fatalf("trójkąt %d działki U-kształtnej ma nieprawidłowe pole %f", i+1, tri.AreaM2)
		}
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

package routing

import (
	"math"
	"testing"
)

func buildTestGraph() *Graph {
	g := NewGraph()

	// Droga bezpośrednia 1 -> 2 -> 3 (z progiem zwalniającym na 1->2)
	g.AddEdge(GraphEdge{
		EdgeID: 101, SourceNode: 1, TargetNode: 2,
		LengthM: 550, SpeedKMH: 50, DurationS: 39.6, SpeedBumps: 2, Crossings: 1,
		Traversed: true,
		Coords:    [][2]float64{{18.6400, 54.3500}, {18.6400, 54.3550}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 102, SourceNode: 2, TargetNode: 3,
		LengthM: 550, SpeedKMH: 50, DurationS: 39.6, TrafficSignals: 1,
		Coords: [][2]float64{{18.6400, 54.3550}, {18.6400, 54.3600}},
	})
	// Alternatywny objazd 1 -> 4 -> 3 (bez progów i bez skrzyżowania w węźle 2)
	g.AddEdge(GraphEdge{
		EdgeID: 103, SourceNode: 1, TargetNode: 4,
		LengthM: 750, SpeedKMH: 60, DurationS: 45.0,
		Coords: [][2]float64{{18.6400, 54.3500}, {18.6500, 54.3550}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 104, SourceNode: 4, TargetNode: 3,
		LengthM: 750, SpeedKMH: 60, DurationS: 45.0,
		Coords: [][2]float64{{18.6500, 54.3550}, {18.6400, 54.3600}},
	})

	return g
}

func TestAStarAvoidanceAndAversions(t *testing.T) {
	g := buildTestGraph()

	// 1. Standardowa najkrótsza trasa (1 -> 2 -> 3)
	_, dist1, _, _, _, ok1 := g.FindShortestPath(18.6400, 54.3500, 18.6400, 54.3600, nil, "high_cost", RoutePreferences{})
	if !ok1 || math.Abs(dist1-1100) > 1 {
		t.Fatalf("expected direct route 1->2->3 (1100m), got ok=%v dist=%f", ok1, dist1)
	}

	// 2. Punkt unikania w węźle 2 (tryb exclude) wymusza objazd przez węzeł 4 (1 -> 4 -> 3)
	avoid := []AvoidPoint{{Lat: 54.3550, Lon: 18.6400, RadiusM: 200}}
	_, dist2, _, _, _, ok2 := g.FindShortestPath(18.6400, 54.3500, 18.6400, 54.3600, avoid, "exclude", RoutePreferences{})
	if !ok2 || math.Abs(dist2-1500) > 1 {
		t.Fatalf("expected detour route 1->4->3 (1500m) when avoiding node 2, got ok=%v dist=%f", ok2, dist2)
	}

	// 3. Wysoka niechęć do progów zwalniających (AversionSpeedBumps: 10) wybiera trasę bez progów (1 -> 4 -> 3)
	_, dist3, _, _, _, ok3 := g.FindShortestPath(18.6400, 54.3500, 18.6400, 54.3600, nil, "high_cost", RoutePreferences{AversionSpeedBumps: 10})
	if !ok3 || math.Abs(dist3-1500) > 1 {
		t.Fatalf("expected aversion to speed bumps to pick route via node 4 (1500m), got dist=%f", dist3)
	}

	// 4. Unikanie przebytych już dróg (krawędź 101 oznaczona jako przebyta)
	_, dist4, _, _, _, ok4 := g.FindShortestPath(18.6400, 54.3500, 18.6400, 54.3600, nil, "high_cost", RoutePreferences{AvoidTraversed: true})
	if !ok4 || math.Abs(dist4-1500) > 1 {
		t.Fatalf("expected AvoidTraversed to avoid edge 101 and pick node 4 (1500m), got dist=%f", dist4)
	}
}

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
	g.ResetUsedEdges()
	_, dist4, _, _, _, ok4 := g.FindShortestPath(18.6400, 54.3500, 18.6400, 54.3600, nil, "high_cost", RoutePreferences{AvoidTraversed: true})
	if !ok4 || math.Abs(dist4-1500) > 1 {
		t.Fatalf("expected AvoidTraversed to avoid edge 101 and pick node 4 (1500m), got dist=%f", dist4)
	}
}

func TestEdgeBecomesTraversedWhenAddedToRoute(t *testing.T) {
	g := NewGraph()

	// Trasa główna 1 -> 2 (500m, nieprzejechana w bazie)
	g.AddEdge(GraphEdge{
		EdgeID: 201, SourceNode: 1, TargetNode: 2,
		LengthM: 500, SpeedKMH: 50, DurationS: 36.0,
		Traversed: false,
		Coords:    [][2]float64{{18.6400, 54.3500}, {18.6400, 54.3550}},
	})
	// Objazd 1 -> 4 -> 2 (700m, nieprzejechany w bazie)
	g.AddEdge(GraphEdge{
		EdgeID: 202, SourceNode: 1, TargetNode: 4,
		LengthM: 350, SpeedKMH: 50, DurationS: 25.0,
		Traversed: false,
		Coords:    [][2]float64{{18.6400, 54.3500}, {18.6450, 54.3525}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 203, SourceNode: 4, TargetNode: 2,
		LengthM: 350, SpeedKMH: 50, DurationS: 25.0,
		Traversed: false,
		Coords:    [][2]float64{{18.6450, 54.3525}, {18.6400, 54.3550}},
	})

	// 1. Pierwszy przejazd 1 -> 2 (krawędź 201 nie była przebyta, więc router jedzie bezpośrednio 500m)
	prefs := RoutePreferences{AversionTraversed: 7, AutoExploratory: true}
	steps, _, _, ok1 := g.findShortestPathSteps(18.6400, 54.3500, 18.6400, 54.3550, nil, "high_cost", prefs)
	if !ok1 || len(steps) != 1 || steps[0].edgeIdx != 0 {
		t.Fatalf("krok 1: oczekiwano bezpośredniej krawędzi 201, got ok=%v len=%d", ok1, len(steps))
	}

	// 2. Dodajemy krawędź do trasy (markUsed = true) -> krawędź 201 musi stać się Traversed = true i UsedCount = 1
	g.materializeSteps(steps, true)
	if !g.Edges[0].Traversed {
		t.Fatalf("krok 2: oczekiwano że po dodaniu do trasy krawędź 201 otrzyma Traversed=true")
	}
	if g.Edges[0].UsedCount != 1 {
		t.Fatalf("krok 2: oczekiwano UsedCount=1, got %d", g.Edges[0].UsedCount)
	}

	// 3. Kolejny przejazd na tym samym podgrafie (np. kolejny odcinek pętli)
	// Ponieważ krawędź 201 stała się przebyta i użyta, wysoka niechęć AversionTraversed: 7 musi wymusić objazd 1 -> 4 -> 2 (700m)
	steps2, _, _, ok2 := g.findShortestPathSteps(18.6400, 54.3500, 18.6400, 54.3550, nil, "high_cost", prefs)
	if !ok2 || len(steps2) != 2 {
		t.Fatalf("krok 3: oczekiwano ominięcia przebytej krawędzi 201 i wyboru objazdu 1->4->2, got len=%d", len(steps2))
	}

	// 4. Po wyczyszczeniu trasy (ResetUsedEdges), krawędź wraca do stanu początkowego (InitiallyTraversed=false)
	g.ResetUsedEdges()
	if g.Edges[0].Traversed {
		t.Fatalf("krok 4: oczekiwano Traversed=false po ResetUsedEdges()")
	}
	steps3, _, _, ok3 := g.findShortestPathSteps(18.6400, 54.3500, 18.6400, 54.3550, nil, "high_cost", prefs)
	if !ok3 || len(steps3) != 1 {
		t.Fatalf("krok 4: po resetowaniu router powinien znowu wybrać bezpośrednią krawędź 201, got len=%d", len(steps3))
	}
}

func TestCulDeSacSpurAvoidance(t *testing.T) {
	g := NewGraph()

	// Trasa przelotowa: 1 -> 2 -> 3
	g.AddEdge(GraphEdge{
		EdgeID: 301, SourceNode: 1, TargetNode: 2,
		LengthM: 500, SpeedKMH: 50, DurationS: 36.0,
		Coords: [][2]float64{{18.6400, 54.3500}, {18.6400, 54.3550}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 302, SourceNode: 2, TargetNode: 3,
		LengthM: 500, SpeedKMH: 50, DurationS: 36.0,
		Coords: [][2]float64{{18.6400, 54.3550}, {18.6400, 54.3600}},
	})
	// Ślepa uliczka (cul-de-sac / antena): 2 -> 5 (węzeł 5 ma stopień 1)
	g.AddEdge(GraphEdge{
		EdgeID: 303, SourceNode: 2, TargetNode: 5,
		LengthM: 100, SpeedKMH: 30, DurationS: 12.0,
		Coords: [][2]float64{{18.6400, 54.3550}, {18.6450, 54.3550}},
	})

	prefs := RoutePreferences{AutoExploratory: true, AversionTraversed: 7}
	steps, pathNodes, _, ok := g.findShortestPathSteps(18.6400, 54.3500, 18.6400, 54.3600, nil, "high_cost", prefs)
	if !ok {
		t.Fatalf("oczekiwano znalezienia trasy 1->2->3")
	}

	for _, nid := range pathNodes {
		if nid == 5 {
			t.Fatalf("błąd: trasa wjechała w ślepą uliczkę (węzeł 5)! Ślepe odnogi powinny być ignorowane!")
		}
	}
	if len(steps) != 2 {
		t.Fatalf("oczekiwano 2 kroków (1->2 i 2->3), got %d", len(steps))
	}
}

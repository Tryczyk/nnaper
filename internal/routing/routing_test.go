package routing

import (
	"context"
	"math"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
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

func TestPruneAntennaSteps(t *testing.T) {
	// 1 -> 2 -> 3 -> 4 -> 3 -> 2 -> 5
	// Krok 3->4 (edge 103) i zaraz powrót 4->3 (edge 103 rev) to ślepa odnoga (antena), która powinna zniknąć.
	steps := []prevStep{
		{fromNode: 1, edgeIdx: 101, reverse: false},
		{fromNode: 2, edgeIdx: 102, reverse: false},
		{fromNode: 3, edgeIdx: 103, reverse: false},
		{fromNode: 4, edgeIdx: 103, reverse: true},
		{fromNode: 3, edgeIdx: 105, reverse: false},
	}
	pruned := pruneAntennaSteps(steps)
	if len(pruned) != 3 {
		t.Fatalf("oczekiwano 3 kroków po usunięciu anteny 103, got %d", len(pruned))
	}
	if pruned[0].edgeIdx != 101 || pruned[1].edgeIdx != 102 || pruned[2].edgeIdx != 105 {
		t.Fatalf("nieprawidłowa sekwencja po usunięciu anteny: %+v", pruned)
	}
}

func TestDeadEndAvoidanceWithOneWay(t *testing.T) {
	g := NewGraph()

	// Ulica jednokierunkowa 1 -> 2 -> 3 (oneway = 1)
	g.AddEdge(GraphEdge{
		EdgeID: 401, SourceNode: 1, TargetNode: 2, Oneway: 1,
		LengthM: 300, SpeedKMH: 50, DurationS: 21.6,
		Coords: [][2]float64{{18.6400, 54.3500}, {18.6400, 54.3530}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 402, SourceNode: 2, TargetNode: 3, Oneway: 1,
		LengthM: 300, SpeedKMH: 50, DurationS: 21.6,
		Coords: [][2]float64{{18.6400, 54.3530}, {18.6400, 54.3560}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 404, SourceNode: 3, TargetNode: 4, Oneway: 1,
		LengthM: 300, SpeedKMH: 50, DurationS: 21.6,
		Coords: [][2]float64{{18.6400, 54.3560}, {18.6400, 54.3590}},
	})
	// Ślepa uliczka dwukierunkowa od węzła 2: 2 <-> 5 (węzeł 5 ma wyjście tylko do 2)
	g.AddEdge(GraphEdge{
		EdgeID: 403, SourceNode: 2, TargetNode: 5, Oneway: 0,
		LengthM: 100, SpeedKMH: 30, DurationS: 12.0,
		Coords: [][2]float64{{18.6400, 54.3530}, {18.6450, 54.3530}},
	})

	// Węzeł 2 leży na ulicy jednokierunkowej, więc jego out-degree wynosi 2 (do 3 i do 5),
	// ale węzeł 5 jest prawdziwym ślepym zaułkiem.
	edgeIdx403 := 3
	edgeIdx401 := 0
	if !g.isDeadEnd(5, edgeIdx403) {
		t.Fatalf("węzeł 5 powinien zostać zidentyfikowany jako dead end dla krawędzi 403")
	}
	if g.isDeadEnd(2, edgeIdx401) {
		t.Fatalf("węzeł 2 nie jest dead endem dla krawędzi 401")
	}

	sN, _ := g.FindNearestNode(18.6400, 54.3500)
	eN, _ := g.FindNearestNode(18.6400, 54.3560)
	t.Logf("FindNearestNode: start=%d, end=%d", sN, eN)
	steps, pathNodes, _, ok := g.findShortestPathSteps(18.6400, 54.3500, 18.6400, 54.3560, nil, "high_cost", RoutePreferences{})
	if !ok {
		t.Fatalf("oczekiwano wyznaczenia trasy po ulicy jednokierunkowej 1->2->3")
	}
	t.Logf("Steps count: %d, steps: %+v, pathNodes: %+v", len(steps), steps, pathNodes)
	for _, nid := range pathNodes {
		if nid == 5 {
			t.Fatalf("trasa nie może wjeżdżać w ślepy zaułek 5")
		}
	}
	if len(steps) != 2 {
		t.Fatalf("oczekiwano 2 kroków (401 i 402), got %d", len(steps))
	}
}

func TestNieborowskaAutoRouteLive(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, "postgresql://nnaper:nnaper@localhost:5432/nnaper_db")
	if err != nil {
		t.Skip("Brak bazy PostgreSQL")
	}
	defer pool.Close()

	svc := NewService(pool, "http://localhost:5000")
	pts := [][2]float64{{18.610483, 54.331540}} // ul. Nieborowska 28
	targetKM := 84.0
	envRadiusKM := math.Max(10.0, math.Min(150.0, targetKM*0.65))
	cosLat := math.Max(0.2, math.Cos(pts[0][1]*math.Pi/180.0))
	dLat := envRadiusKM / 111.32
	dLon := envRadiusKM / (111.32 * cosLat)
	bboxPts := [][2]float64{
		{pts[0][0] - dLon, pts[0][1] - dLat},
		{pts[0][0] + dLon, pts[0][1] + dLat},
	}
	g, err := svc.loadSubgraphFromDB(ctx, "", "", bboxPts)
	if err != nil {
		t.Fatalf("loadSubgraph err: %v", err)
	}

	req := RoutePlanRequest{
		Points:        pts,
		AutoGenerate:  true,
		TargetKM:      targetKM,
		ReturnToStart: true,
		Preferences: RoutePreferences{
			AversionTraversed:      7,
			AvoidTraversed:          true,
			AversionHighways:       3,
			AversionSpeedBumps:     6,
			AversionTrafficSignals: 5,
			AversionIntersections:  4,
			AversionCrossings:      1,
			AversionRoundabouts:    2,
			AutoExploratory:        true,
		},
	}
	startNode, okStart := g.FindNearestNode(pts[0][0], pts[0][1])
	t.Logf("FindNearestNode: node=%d, ok=%v, coords=%v, adjs=%d", startNode, okStart, g.NodeCoords[startNode], len(g.Adj[startNode]))
	for _, a := range g.Adj[startNode] {
		e := g.Edges[a.edgeIdx]
		t.Logf("  Adj edge: id=%d, hw=%s, toNode=%d", e.EdgeID, e.Highway, a.toNode)
	}

	resp, ok := g.buildIntelligentAutoRoute(req, targetKM)
	if !ok {
		t.Fatalf("buildIntelligentAutoRoute powinno zwrócić trasę dla ul. Nieborowskiej")
	}
	distKM := resp.DistanceM / 1000.0
	t.Logf("Wyznaczona trasa dla Nieborowskiej 84km: %.1f km (oczekiwano ~84km)", distKM)
	if distKM < 65.0 || distKM > 105.0 {
		t.Fatalf("Dystans trasy %.1f km zbyt mocno odbiega od zadanego 84km", distKM)
	}
}

func TestNoServiceRoadsOrLivingStreetsInTransit(t *testing.T) {
	g := NewGraph()

	// Trasa tranzytowa 1 -> 2 (primary, 1000m, przebyta)
	// oraz 2 -> 3 (primary, 1000m, przebyta)
	g.AddEdge(GraphEdge{
		EdgeID: 501, SourceNode: 1, TargetNode: 2,
		LengthM: 1000, SpeedKMH: 70, DurationS: 51.0,
		Highway: "primary", Traversed: true,
		Coords: [][2]float64{{18.6000, 54.3400}, {18.6100, 54.3400}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 502, SourceNode: 2, TargetNode: 3,
		LengthM: 1000, SpeedKMH: 70, DurationS: 51.0,
		Highway: "primary", Traversed: true,
		Coords: [][2]float64{{18.6100, 54.3400}, {18.6200, 54.3400}},
	})

	// Skrót przez parking / drogę service: 2 -> 4 -> 3 (service, 400m, nieprzebyta!)
	g.AddEdge(GraphEdge{
		EdgeID: 503, SourceNode: 2, TargetNode: 4,
		LengthM: 200, SpeedKMH: 20, DurationS: 36.0,
		Highway: "service", Traversed: false,
		Coords: [][2]float64{{18.6100, 54.3400}, {18.6150, 54.3420}},
	})
	g.AddEdge(GraphEdge{
		EdgeID: 504, SourceNode: 4, TargetNode: 3,
		LengthM: 200, SpeedKMH: 20, DurationS: 36.0,
		Highway: "service", Traversed: false,
		Coords: [][2]float64{{18.6150, 54.3420}, {18.6200, 54.3400}},
	})

	prefs := RoutePreferences{
		AutoExploratory:   true,
		AversionTraversed: 7,
		AvoidTraversed:    true,
	}

	steps, _, _, ok := g.findShortestPathSteps(18.6000, 54.3400, 18.6200, 54.3400, nil, "high_cost", prefs)
	if !ok {
		t.Fatalf("nie znaleziono trasy 1 -> 3")
	}

	for _, st := range steps {
		e := g.Edges[st.edgeIdx]
		if e.Highway == "service" || e.Highway == "living_street" {
			t.Fatalf("trasa tranzytowa nie powinna zjeżdżać na parking/service (krawędź %d, highway=%s)", e.EdgeID, e.Highway)
		}
	}
	if len(steps) != 2 {
		t.Fatalf("oczekiwano 2 kroków po drodze primary (501 i 502), otrzymano %d", len(steps))
	}
}

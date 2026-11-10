package routing

import (
	"container/heap"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type Service struct {
	pool           *pgxpool.Pool
	osrmURL        string
	mu             sync.RWMutex
	cachedEdges    []GraphEdge
	cachedAt       time.Time
	traversedMu    sync.RWMutex
	traversedCache map[string]traversedGridEntry
}

type traversedGridEntry struct {
	grid      map[int64]bool
	fetchedAt time.Time
}

func NewService(pool *pgxpool.Pool, osrmURL string) *Service {
	return &Service{
		pool:           pool,
		osrmURL:        strings.TrimRight(osrmURL, "/"),
		traversedCache: make(map[string]traversedGridEntry),
	}
}

type AvoidPoint struct {
	Lon     float64 `json:"lon"`
	Lat     float64 `json:"lat"`
	RadiusM float64 `json:"radius_m"`
}

type RoutePreferences struct {
	AversionSpeedBumps     float64 `json:"aversion_speed_bumps"`
	AversionIntersections  float64 `json:"aversion_intersections"`
	AversionCrossings      float64 `json:"aversion_crossings"`
	AversionRoundabouts    float64 `json:"aversion_roundabouts"`
	AversionTrafficSignals float64 `json:"aversion_traffic_signals"`
	AvoidTraversed         bool    `json:"avoid_traversed"`
	AvoidHighways          bool    `json:"avoid_highways"`
	AutoExploratory        bool    `json:"auto_exploratory"`
}

type RoutePlanRequest struct {
	Points        [][2]float64     `json:"points"` // [lon, lat]
	AvoidPoints   []AvoidPoint     `json:"avoid_points"`
	AvoidMode     string           `json:"avoid_mode"` // "high_cost" | "exclude"
	Preferences   RoutePreferences `json:"preferences"`
	AutoGenerate  bool             `json:"auto_generate"`
	TargetKM      float64          `json:"target_km"`
	TargetMinutes float64          `json:"target_minutes"`
	ReturnToStart bool             `json:"return_to_start"`
	ProfileID     string           `json:"profile_id"`
}

type RouteObstacleSummary struct {
	SpeedBumps      int     `json:"speed_bumps"`
	Crossings       int     `json:"crossings"`
	TrafficSignals  int     `json:"traffic_signals"`
	Roundabouts     int     `json:"roundabouts"`
	Intersections   int     `json:"intersections"`
	TraversedEdges  int     `json:"traversed_edges"`
	NewRoadsPercent float64 `json:"new_roads_percent"`
}

type RoutePlanResponse struct {
	Status       string               `json:"status"`
	DistanceM    float64              `json:"distance_m"`
	DurationS    float64              `json:"duration_s"`
	Coordinates  [][2]float64         `json:"coordinates"`
	Waypoints    [][2]float64         `json:"waypoints"`
	Legs         []RouteLegSummary    `json:"legs"`
	Obstacles    RouteObstacleSummary `json:"obstacles"`
	AvoidedCount int                  `json:"avoided_count"`
}

type RouteLegSummary struct {
	DistanceM   float64      `json:"distance_m"`
	DurationS   float64      `json:"duration_s"`
	Coordinates [][2]float64 `json:"coordinates"`
}

type GraphEdge struct {
	EdgeID         int64
	SourceNode     int64
	TargetNode     int64
	Oneway         int16
	Highway        string
	Name           string
	LengthM        float64
	SpeedKMH       float64
	DurationS      float64
	IsRoundabout   bool
	SpeedBumps     int
	Crossings      int
	TrafficSignals int
	IsIntersection bool
	Traversed      bool
	UsedCount      int
	Coords         [][2]float64 // [lon, lat]
}

type adjEdge struct {
	toNode  int64
	edgeIdx int
	reverse bool
}

type Graph struct {
	NodeCoords map[int64][2]float64 // nodeID -> [lon, lat]
	Edges      []GraphEdge
	Adj        map[int64][]adjEdge
}

func NewGraph() *Graph {
	return &Graph{
		NodeCoords: make(map[int64][2]float64),
		Adj:        make(map[int64][]adjEdge),
	}
}

func (g *Graph) AddEdge(e GraphEdge) {
	if len(e.Coords) < 2 {
		return
	}
	idx := len(g.Edges)
	g.Edges = append(g.Edges, e)
	g.NodeCoords[e.SourceNode] = e.Coords[0]
	g.NodeCoords[e.TargetNode] = e.Coords[len(e.Coords)-1]

	g.Adj[e.SourceNode] = append(g.Adj[e.SourceNode], adjEdge{
		toNode:  e.TargetNode,
		edgeIdx: idx,
		reverse: false,
	})
	if e.Oneway == 0 {
		g.Adj[e.TargetNode] = append(g.Adj[e.TargetNode], adjEdge{
			toNode:  e.SourceNode,
			edgeIdx: idx,
			reverse: true,
		})
	}
}

// minDistPolylineToPointM oblicza minimalną odległość w metrach od punktu (lat, lon) do łamanej coords ([lon, lat]).
func minDistPolylineToPointM(coords [][2]float64, lat, lon float64) float64 {
	if len(coords) == 0 {
		return math.MaxFloat64
	}
	cosLat := math.Max(0.2, math.Cos(lat*math.Pi/180.0))
	best := math.MaxFloat64
	for i := 0; i < len(coords); i++ {
		d := haversineM(lat, lon, coords[i][1], coords[i][0])
		if d < best {
			best = d
		}
		if i+1 < len(coords) {
			ax := (coords[i][0] - lon) * 111320.0 * cosLat
			ay := (coords[i][1] - lat) * 111320.0
			bx := (coords[i+1][0] - lon) * 111320.0 * cosLat
			by := (coords[i+1][1] - lat) * 111320.0
			dx := bx - ax
			dy := by - ay
			lenSq := dx*dx + dy*dy
			if lenSq > 1e-6 {
				t := -(ax*dx + ay*dy) / lenSq
				if t > 0 && t < 1 {
					px := ax + t*dx
					py := ay + t*dy
					segD := math.Hypot(px, py)
					if segD < best {
						best = segD
					}
				}
			}
		}
	}
	return best
}

func isHighwayClass(hw string) bool {
	switch hw {
	case "motorway", "motorway_link", "trunk", "trunk_link":
		return true
	default:
		return false
	}
}

// ComputeEdgeCost wylicza ważony koszt przejazdu przez krawędź z uwzględnieniem punktów unikania,
// unikania autostrad, suwaków niechęci do przeszkód (w tym trybu MAX=11 "Unikaj zupełnie / Minimum totalne"),
// unikania przebytych już dróg oraz zakazu powtarzania tej samej drogi.
// Zwraca (cost, excluded, hitAvoidPoint).
func ComputeEdgeCost(e GraphEdge, avoidPoints []AvoidPoint, avoidMode string, prefs RoutePreferences) (float64, bool, bool) {
	cost := math.Max(e.DurationS, 0.5)
	if prefs.AutoExploratory {
		cost = math.Max(e.LengthM/12.5, 0.5)
		switch e.Highway {
		case "motorway", "motorway_link", "trunk", "trunk_link":
			cost = cost*35.0 + 3500.0
		case "primary", "primary_link":
			cost = cost * 1.35
		case "secondary", "tertiary", "unclassified":
			cost = cost * 0.88
		}
	}
	hitAvoid := false

	// 0. Unikanie autostrad i dróg ekspresowych
	if prefs.AvoidHighways && isHighwayClass(e.Highway) {
		cost = cost*5000.0 + 2500000.0
	}

	// 1. Sprawdzenie punktów unikania (dokładna odległość od każdego segmentu krawędzi do strefy unikania)
	if len(avoidPoints) > 0 && len(e.Coords) >= 2 {
		for _, ap := range avoidPoints {
			rad := ap.RadiusM
			if rad <= 0 {
				rad = 250.0
			}
			minD := minDistPolylineToPointM(e.Coords, ap.Lat, ap.Lon)
			if minD <= rad {
				hitAvoid = true
				if avoidMode == "exclude" {
					return math.Inf(1), true, true
				}
				// Ekstremalnie wysoki koszt dla trybu "high_cost", gwarantujący objazd zawsze gdy istnieje alternatywa
				cost = cost*10000.0 + 5000000.0
			}
		}
	}

	// 2. Kary wynikające z poziomu niechęci (0..10 lub 11 = MAX / Minimum totalne) do przeszkód drogowych
	if prefs.AversionSpeedBumps > 0 && e.SpeedBumps > 0 {
		if prefs.AversionSpeedBumps >= 10.5 {
			cost += float64(e.SpeedBumps) * 2500000.0
		} else {
			cost += float64(e.SpeedBumps) * prefs.AversionSpeedBumps * 85.0
		}
	}
	if prefs.AversionCrossings > 0 && e.Crossings > 0 {
		if prefs.AversionCrossings >= 10.5 {
			cost += float64(e.Crossings) * 2500000.0
		} else {
			cost += float64(e.Crossings) * prefs.AversionCrossings * 45.0
		}
	}
	if prefs.AversionTrafficSignals > 0 && e.TrafficSignals > 0 {
		if prefs.AversionTrafficSignals >= 10.5 {
			cost += float64(e.TrafficSignals) * 2500000.0
		} else {
			cost += float64(e.TrafficSignals) * prefs.AversionTrafficSignals * 65.0
		}
	}
	if prefs.AversionRoundabouts > 0 && e.IsRoundabout {
		if prefs.AversionRoundabouts >= 10.5 {
			cost += 2500000.0
		} else {
			cost += prefs.AversionRoundabouts * 95.0
		}
	}
	if prefs.AversionIntersections > 0 && e.IsIntersection {
		if prefs.AversionIntersections >= 10.5 {
			cost += 2500000.0
		} else {
			cost += prefs.AversionIntersections * 30.0
		}
	}

	// 3. Unikanie przebytych już dróg (bardzo silna kara za wjazd na drogę ze śladem GPS)
	if prefs.AvoidTraversed && e.Traversed {
		cost = cost*280.0 + 18000.0
	} else if prefs.AutoExploratory && !e.Traversed {
		// W trybie auto-eksploracji premiujemy nowe nieodwiedzone ulice
		cost *= 0.45
	}

	// 4. Unikanie jechania 2 razy tą samą drogą w ramach wyznaczanej trasy
	if e.UsedCount > 0 {
		cost = cost*350.0*float64(e.UsedCount) + 25000.0*float64(e.UsedCount)
	}

	return cost, false, hitAvoid
}

func (g *Graph) ResetUsedEdges() {
	for i := range g.Edges {
		g.Edges[i].UsedCount = 0
	}
}

type pqItem struct {
	node int64
	prio float64
	idx  int
}

type priorityQueue []*pqItem

func (pq priorityQueue) Len() int           { return len(pq) }
func (pq priorityQueue) Less(i, j int) bool { return pq[i].prio < pq[j].prio }
func (pq priorityQueue) Swap(i, j int) {
	pq[i], pq[j] = pq[j], pq[i]
	pq[i].idx = i
	pq[j].idx = j
}
func (pq *priorityQueue) Push(x interface{}) {
	n := len(*pq)
	item := x.(*pqItem)
	item.idx = n
	*pq = append(*pq, item)
}
func (pq *priorityQueue) Pop() interface{} {
	old := *pq
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	item.idx = -1
	*pq = old[0 : n-1]
	return item
}

func (g *Graph) FindNearestNode(lon, lat float64) (int64, bool) {
	var bestID int64
	bestDist := math.MaxFloat64
	found := false
	for nid, c := range g.NodeCoords {
		if len(g.Adj[nid]) == 0 {
			continue
		}
		d := haversineM(lat, lon, c[1], c[0])
		if d < bestDist {
			bestDist = d
			bestID = nid
			found = true
		}
	}
	return bestID, found
}

type prevStep struct {
	fromNode int64
	edgeIdx  int
	reverse  bool
}

// FindShortestPath uruchamia algorytm Dijkstry / A* na grafie g z uwzględnieniem punktów unikania i preferencji użytkownika.
func (g *Graph) FindShortestPath(
	startLon, startLat, endLon, endLat float64,
	avoidPoints []AvoidPoint,
	avoidMode string,
	prefs RoutePreferences,
) (coords [][2]float64, distM, durS float64, obs RouteObstacleSummary, avoidedHits int, ok bool) {
	steps, _, avoidedHits, ok := g.findShortestPathSteps(startLon, startLat, endLon, endLat, avoidPoints, avoidMode, prefs)
	if !ok {
		return nil, 0, 0, obs, avoidedHits, false
	}
	if len(steps) == 0 {
		startNode, _ := g.FindNearestNode(startLon, startLat)
		c := g.NodeCoords[startNode]
		return [][2]float64{c, {endLon, endLat}}, 0, 0, obs, 0, true
	}
	coords, distM, durS, obs = g.materializeSteps(steps, true)
	return coords, distM, durS, obs, avoidedHits, len(coords) >= 2
}

func (g *Graph) findShortestPathSteps(
	startLon, startLat, endLon, endLat float64,
	avoidPoints []AvoidPoint,
	avoidMode string,
	prefs RoutePreferences,
) (steps []prevStep, pathNodes []int64, avoidedHits int, ok bool) {
	startNode, ok1 := g.FindNearestNode(startLon, startLat)
	endNode, ok2 := g.FindNearestNode(endLon, endLat)
	if !ok1 || !ok2 {
		return nil, nil, 0, false
	}
	if startNode == endNode {
		return nil, []int64{startNode}, 0, true
	}

	hasCustomWeights := len(avoidPoints) > 0 ||
		prefs.AvoidTraversed ||
		prefs.AvoidHighways ||
		prefs.AutoExploratory ||
		prefs.AversionSpeedBumps > 0 ||
		prefs.AversionCrossings > 0 ||
		prefs.AversionTrafficSignals > 0 ||
		prefs.AversionRoundabouts > 0 ||
		prefs.AversionIntersections > 0

	endCoord := g.NodeCoords[endNode]
	distScore := map[int64]float64{startNode: 0}
	cameFrom := make(map[int64]prevStep)
	visited := make(map[int64]bool)

	pq := &priorityQueue{}
	heap.Init(pq)
	heap.Push(pq, &pqItem{node: startNode, prio: 0})

	for pq.Len() > 0 {
		curr := heap.Pop(pq).(*pqItem)
		u := curr.node
		if u == endNode {
			break
		}
		if visited[u] {
			continue
		}
		visited[u] = true
		gU := distScore[u]
		prevSt, hasPrev := cameFrom[u]

		for _, adj := range g.Adj[u] {
			// Zakaz natychmiastowego zawracania tą samą krawędzią, jeśli węzeł nie jest ślepą uliczką
			if hasPrev && adj.edgeIdx == prevSt.edgeIdx && len(g.Adj[u]) > 1 {
				continue
			}

			e := g.Edges[adj.edgeIdx]
			edgeCost, excluded, hitAvoid := ComputeEdgeCost(e, avoidPoints, avoidMode, prefs)
			if hitAvoid {
				avoidedHits++
			}
			if excluded {
				continue
			}

			tentativeG := gU + edgeCost
			oldG, exists := distScore[adj.toNode]
			if !exists || tentativeG < oldG {
				distScore[adj.toNode] = tentativeG
				cameFrom[adj.toNode] = prevStep{
					fromNode: u,
					edgeIdx:  adj.edgeIdx,
					reverse:  adj.reverse,
				}
				h := 0.0
				if !hasCustomWeights {
					toCoord := g.NodeCoords[adj.toNode]
					h = haversineM(toCoord[1], toCoord[0], endCoord[1], endCoord[0]) / 33.3
				}
				heap.Push(pq, &pqItem{
					node: adj.toNode,
					prio: tentativeG + h,
				})
			}
		}
	}

	if _, reached := cameFrom[endNode]; !reached {
		return nil, nil, avoidedHits, false
	}

	var revSteps []prevStep
	var revNodes []int64
	cur := endNode
	for cur != startNode {
		revNodes = append(revNodes, cur)
		st, exists := cameFrom[cur]
		if !exists {
			break
		}
		revSteps = append(revSteps, st)
		cur = st.fromNode
	}
	revNodes = append(revNodes, startNode)

	steps = make([]prevStep, len(revSteps))
	for i := range revSteps {
		steps[i] = revSteps[len(revSteps)-1-i]
	}
	pathNodes = make([]int64, len(revNodes))
	for i := range revNodes {
		pathNodes[i] = revNodes[len(revNodes)-1-i]
	}
	return steps, pathNodes, avoidedHits, true
}

func (g *Graph) materializeSteps(steps []prevStep, markUsed bool) (coords [][2]float64, distM, durS float64, obs RouteObstacleSummary) {
	var totalLenM, newLenM float64
	for _, st := range steps {
		if markUsed {
			g.Edges[st.edgeIdx].UsedCount++
			e := g.Edges[st.edgeIdx]
			for _, adj := range g.Adj[e.SourceNode] {
				if adj.toNode == e.TargetNode && adj.edgeIdx != st.edgeIdx {
					g.Edges[adj.edgeIdx].UsedCount++
				}
			}
			for _, adj := range g.Adj[e.TargetNode] {
				if adj.toNode == e.SourceNode && adj.edgeIdx != st.edgeIdx {
					g.Edges[adj.edgeIdx].UsedCount++
				}
			}
		}

		e := g.Edges[st.edgeIdx]
		distM += e.LengthM
		durS += e.DurationS
		totalLenM += e.LengthM
		if e.Traversed {
			obs.TraversedEdges++
		} else {
			newLenM += e.LengthM
		}
		obs.SpeedBumps += e.SpeedBumps
		obs.Crossings += e.Crossings
		obs.TrafficSignals += e.TrafficSignals
		if e.IsRoundabout {
			obs.Roundabouts++
		}
		if e.IsIntersection {
			obs.Intersections++
		}

		if !st.reverse {
			for k, pt := range e.Coords {
				if len(coords) > 0 && k == 0 {
					continue
				}
				coords = append(coords, pt)
			}
		} else {
			for k := len(e.Coords) - 1; k >= 0; k-- {
				if len(coords) > 0 && k == len(e.Coords)-1 {
					continue
				}
				coords = append(coords, e.Coords[k])
			}
		}
	}

	if totalLenM > 0 {
		obs.NewRoadsPercent = math.Round((newLenM/totalLenM)*1000) / 10.0
	} else {
		obs.NewRoadsPercent = 100.0
	}
	return coords, distM, durS, obs
}

func (g *Graph) routeAllLegs(points [][2]float64, avoidPoints []AvoidPoint, avoidMode string, prefs RoutePreferences) (RoutePlanResponse, bool) {
	g.ResetUsedEdges()
	var allCoords [][2]float64
	var legs []RouteLegSummary
	var totalDist, totalDur float64
	var totalObs RouteObstacleSummary
	var totalAvoided int
	var totalLen, newLen float64

	for i := 0; i < len(points)-1; i++ {
		p1 := points[i]
		p2 := points[i+1]
		legCoords, legDist, legDur, legObs, avoidedHits, ok := g.FindShortestPath(
			p1[0], p1[1], p2[0], p2[1],
			avoidPoints, avoidMode, prefs,
		)
		if !ok && avoidMode == "exclude" {
			legCoords, legDist, legDur, legObs, avoidedHits, ok = g.FindShortestPath(
				p1[0], p1[1], p2[0], p2[1],
				avoidPoints, "high_cost", prefs,
			)
		}
		if !ok || len(legCoords) < 2 {
			return RoutePlanResponse{}, false
		}

		for k, c := range legCoords {
			if len(allCoords) > 0 && k == 0 {
				continue
			}
			allCoords = append(allCoords, c)
		}
		legs = append(legs, RouteLegSummary{
			DistanceM:   math.Round(legDist*10) / 10,
			DurationS:   math.Round(legDur*10) / 10,
			Coordinates: legCoords,
		})
		totalDist += legDist
		totalDur += legDur
		totalAvoided += avoidedHits
		totalObs.SpeedBumps += legObs.SpeedBumps
		totalObs.Crossings += legObs.Crossings
		totalObs.TrafficSignals += legObs.TrafficSignals
		totalObs.Roundabouts += legObs.Roundabouts
		totalObs.Intersections += legObs.Intersections
		totalObs.TraversedEdges += legObs.TraversedEdges
		totalLen += legDist
		newLen += legDist * (legObs.NewRoadsPercent / 100.0)
	}

	if len(allCoords) < 2 {
		return RoutePlanResponse{}, false
	}
	if totalLen > 0 {
		totalObs.NewRoadsPercent = math.Round((newLen/totalLen)*1000) / 10.0
	} else {
		totalObs.NewRoadsPercent = 100.0
	}

	return RoutePlanResponse{
		Status:       "ok",
		DistanceM:    math.Round(totalDist*10) / 10,
		DurationS:    math.Round(totalDur*10) / 10,
		Coordinates:  allCoords,
		Waypoints:    points,
		Legs:         legs,
		Obstacles:    totalObs,
		AvoidedCount: totalAvoided,
	}, true
}

// extractOptimal10Waypoints realizuje algorytm rozmieszczania do 10 znaczników wzdłuż wyznaczonej trasy:
// idzie po wyznaczonej trasie (steps / pathNodes) i stawia kolejny znacznik TAK DALEKO, JAK SIĘ DA,
// dopóki standardowy router (jadący najszybszą trasą bez naszych preferencji) jedzie zgodnie z naszą trasą.
// Gdy standardowy router wybrałby inną drogę, stawiany jest znacznik wymuszający nasz przebieg.
// Jeśli trasa jest bardzo długa, znaczniki są rozkładane proporcjonalnie, aby starczyło 10 znaczników na całą długość trasy.
func (g *Graph) extractOptimal10Waypoints(steps []prevStep, pathNodes []int64, startPt, endPt [2]float64) ([][2]float64, []RouteLegSummary) {
	const maxWaypoints = 10 // Start + do 8 pośrednich + Koniec
	if len(steps) == 0 || len(pathNodes) < 2 {
		return [][2]float64{startPt, endPt}, nil
	}

	nNodes := len(pathNodes)
	cumDist := make([]float64, nNodes)
	cumDur := make([]float64, nNodes)
	for i, st := range steps {
		e := g.Edges[st.edgeIdx]
		cumDist[i+1] = cumDist[i] + e.LengthM
		cumDur[i+1] = cumDur[i] + math.Max(e.DurationS, 0.5)
	}
	totalDistM := cumDist[nNodes-1]
	if totalDistM < 50.0 {
		c0 := g.NodeCoords[pathNodes[0]]
		c1 := g.NodeCoords[pathNodes[nNodes-1]]
		return [][2]float64{c0, c1}, nil
	}

	selectedIndices := []int{0}
	curIdx := 0
	maxIntermediate := maxWaypoints - 2 // 8

	for rem := maxIntermediate; rem >= 1 && curIdx < nNodes-1; rem-- {
		remDistM := totalDistM - cumDist[curIdx]
		if remDistM < 180.0 {
			break
		}
		// Minimalny krok dystansu, aby 10 znaczników wystarczyło na całą długą trasę
		minStepDistM := (remDistM / float64(rem+1)) * 0.72
		maxStepDistM := (remDistM / float64(rem+1)) * 1.45

		// Jedno przebiegnięcie szybkiego Dijkstry wg standardowego czasu przejazdu (DurationS)
		// z bieżącego znacznika, aby sprawdzić jak daleko standardowa nawigacja pokrywa się z naszą trasą.
		startNode := pathNodes[curIdx]
		stdDur := map[int64]float64{startNode: 0}
		visited := make(map[int64]bool)
		pq := &priorityQueue{}
		heap.Init(pq)
		heap.Push(pq, &pqItem{node: startNode, prio: 0})

		maxDurBudget := (maxStepDistM / 8.0) + 120.0
		for pq.Len() > 0 {
			it := heap.Pop(pq).(*pqItem)
			u := it.node
			if visited[u] {
				continue
			}
			visited[u] = true
			dU := stdDur[u]
			if dU > maxDurBudget {
				break
			}
			for _, adj := range g.Adj[u] {
				e := g.Edges[adj.edgeIdx]
				w := math.Max(e.DurationS, 0.5)
				if nd := dU + w; !visited[adj.toNode] {
					if old, ok := stdDur[adj.toNode]; !ok || nd < old {
						stdDur[adj.toNode] = nd
						heap.Push(pq, &pqItem{node: adj.toNode, prio: nd})
					}
				}
			}
		}

		// Szukamy najdalszego punktu na naszej trasie (w granicach [minStepDistM, maxStepDistM]),
		// do którego nasza trasa pokrywa się ze standardową najkrótszą czasowo trasą.
		chosenIdx := -1
		lastCompliantIdx := -1
		minIdx := curIdx + 1

		for k := curIdx + 1; k < nNodes-1; k++ {
			stepDist := cumDist[k] - cumDist[curIdx]
			if stepDist < minStepDistM {
				minIdx = k
			}
			if stepDist > maxStepDistM {
				break
			}
			plannedTime := cumDur[k] - cumDur[curIdx]
			fastestTime, ok := stdDur[pathNodes[k]]
			// Dopóki czas po naszej trasie nie odbiega od najszybszej trasy o więcej niż 7% + 10s,
			// zwykła nawigacja pojedzie dokładnie naszą trasą bez dodatkowego znacznika.
			if ok && plannedTime <= fastestTime*1.07+10.0 {
				lastCompliantIdx = k
			} else if stepDist >= minStepDistM && lastCompliantIdx >= minIdx {
				// Właśnie w tym miejscu nasza trasa skręca inaczej niż domyślny router -> stawiamy znacznik!
				chosenIdx = lastCompliantIdx
				break
			}
		}

		if chosenIdx == -1 {
			if lastCompliantIdx >= minIdx {
				chosenIdx = lastCompliantIdx
			} else {
				// Jeśli trasa jest bardzo długa i musimy poświęcić trochę dokładności, stawiamy znacznik na idealnym podziale dystansu
				targetCum := cumDist[curIdx] + (remDistM / float64(rem+1))
				chosenIdx = minIdx
				for k := curIdx + 1; k < nNodes-1; k++ {
					if cumDist[k] >= targetCum {
						chosenIdx = k
						break
					}
				}
			}
		}

		if chosenIdx <= curIdx {
			chosenIdx = curIdx + 1
		}
		if chosenIdx >= nNodes-1 {
			break
		}
		selectedIndices = append(selectedIndices, chosenIdx)
		curIdx = chosenIdx
	}

	selectedIndices = append(selectedIndices, nNodes-1)

	waypoints := make([][2]float64, 0, len(selectedIndices))
	var legs []RouteLegSummary
	for i, idx := range selectedIndices {
		c := g.NodeCoords[pathNodes[idx]]
		wp := [2]float64{
			math.Round(c[0]*1e6) / 1e6,
			math.Round(c[1]*1e6) / 1e6,
		}
		waypoints = append(waypoints, wp)
		if i > 0 {
			prevIdx := selectedIndices[i-1]
			subSteps := steps[prevIdx:idx]
			legCoords, legDist, legDur, _ := g.materializeSteps(subSteps, false)
			legs = append(legs, RouteLegSummary{
				DistanceM:   math.Round(legDist*10) / 10,
				DurationS:   math.Round(legDur*10) / 10,
				Coordinates: legCoords,
			})
		}
	}
	return waypoints, legs
}

// buildIntelligentAutoRoute buduje spójną, sensowną trasę o zadanej długości targetKM bezpośrednio po grafie drogowym g,
// wybierając osiągalne węzły korytarzy drogowych (nigdy w morzu, nigdy w ślepych uliczkach), maksymalizując udział
// nowych dróg (!e.Traversed) i minimalizując przeszkody, a następnie rozmieszcza wzdłuż wyznaczonej trasy do 10 znaczników.
func (g *Graph) buildIntelligentAutoRoute(req RoutePlanRequest, targetKM float64) (RoutePlanResponse, bool) {
	if len(req.Points) == 0 || len(g.Edges) == 0 {
		return RoutePlanResponse{}, false
	}

	startPt := req.Points[0]
	startNode, ok := g.FindNearestNode(startPt[0], startPt[1])
	if !ok {
		return RoutePlanResponse{}, false
	}
	startCoord := g.NodeCoords[startNode]

	// 1. Obliczamy rzeczywiste odległości drogowe z punktu startowego (Dijkstra po długości dróg z wykluczeniem stref unikania i autostrad)
	roadDist := map[int64]float64{startNode: 0}
	visited := make(map[int64]bool)
	pq := &priorityQueue{}
	heap.Init(pq)
	heap.Push(pq, &pqItem{node: startNode, prio: 0})

	maxExploreM := math.Max(4000.0, targetKM*1000.0*0.85)
	for pq.Len() > 0 {
		it := heap.Pop(pq).(*pqItem)
		u := it.node
		if visited[u] {
			continue
		}
		visited[u] = true
		dU := roadDist[u]
		if dU > maxExploreM {
			break
		}
		for _, adj := range g.Adj[u] {
			e := g.Edges[adj.edgeIdx]
			if isHighwayClass(e.Highway) {
				continue
			}
			_, excluded, hitAvoid := ComputeEdgeCost(e, req.AvoidPoints, req.AvoidMode, req.Preferences)
			if excluded || hitAvoid {
				continue
			}
			nd := dU + e.LengthM
			if old, exists := roadDist[adj.toNode]; !exists || nd < old {
				roadDist[adj.toNode] = nd
				heap.Push(pq, &pqItem{node: adj.toNode, prio: nd})
			}
		}
	}

	// Zbieramy węzły skrzyżowań osiągalne z punktu startowego
	type candidateHub struct {
		nodeID     int64
		coord      [2]float64
		roadDistM  float64
		angleRad   float64
		newRoadBonus float64
	}
	cosLat := math.Max(0.2, math.Cos(startCoord[1]*math.Pi/180.0))
	var hubs []candidateHub

	for nid, rDist := range roadDist {
		if rDist < 250.0 {
			continue
		}
		adjs := g.Adj[nid]
		if len(adjs) < 2 {
			continue
		}
		isBad := false
		untraversedLen := 0.0
		obstaclePenalty := 0.0
		for _, a := range adjs {
			e := g.Edges[a.edgeIdx]
			if isHighwayClass(e.Highway) {
				isBad = true
				break
			}
			if !e.Traversed {
				untraversedLen += e.LengthM
			}
			obstaclePenalty += float64(e.SpeedBumps*30 + e.Crossings*10 + e.TrafficSignals*20)
		}
		if isBad {
			continue
		}
		c := g.NodeCoords[nid]
		dx := (c[0] - startCoord[0]) * 111320.0 * cosLat
		dy := (c[1] - startCoord[1]) * 111320.0
		ang := math.Atan2(dx, dy) // azymut od północy
		hubs = append(hubs, candidateHub{
			nodeID:       nid,
			coord:        c,
			roadDistM:    rDist,
			angleRad:     ang,
			newRoadBonus: untraversedLen - obstaclePenalty,
		})
	}

	if len(hubs) < 4 {
		return RoutePlanResponse{}, false
	}

	isLoop := req.ReturnToStart || len(req.Points) == 1
	endCoord := startCoord
	if !isLoop && len(req.Points) >= 2 {
		if endNID, okEnd := g.FindNearestNode(req.Points[len(req.Points)-1][0], req.Points[len(req.Points)-1][1]); okEnd {
			endCoord = g.NodeCoords[endNID]
		}
	}

	// Wybieramy najlepszy azymut główny (sektor o największym udziale nowych dróg)
	bestBaseAngle := 0.0
	bestSectorScore := -1e18
	for aDeg := 0.0; aDeg < 360.0; aDeg += 30.0 {
		aRad := (aDeg - 180.0) * math.Pi / 180.0
		secScore := 0.0
		for _, h := range hubs {
			diff := math.Abs( math.Remainder(h.angleRad-aRad, 2.0*math.Pi) )
			if diff <= math.Pi/2.2 && h.roadDistM <= targetKM*1000.0*0.48 {
				secScore += h.newRoadBonus + 80.0
			}
		}
		if secScore > bestSectorScore {
			bestSectorScore = secScore
			bestBaseAngle = aRad
		}
	}

	// Próbujemy 3 skale promienia korytarza, aby idealnie trafić w zadany dystans targetKM
	scales := []float64{0.82, 1.0, 1.24}
	var bestResp RoutePlanResponse
	bestDiffKM := math.MaxFloat64
	foundAny := false

	for _, sc := range scales {
		var anchorPts [][2]float64
		anchorPts = append(anchorPts, startCoord)

		if isLoop {
			// Budujemy płynną pętlę przez 4 dobrze odseparowane węzły korytarzowe na sieci dróg (tworzące szeroki wielokąt bez zawracania)
			targetLegRoadDist := math.Max(400.0, (targetKM*1000.0*0.30)*sc)
			sectorOffsets := []float64{-0.75, -0.25, 0.30, 0.80}
			usedHubs := make(map[int64]bool)

			for _, off := range sectorOffsets {
				desiredAng := bestBaseAngle + off
				var bestH *candidateHub
				bestHScore := -1e18

				for i := range hubs {
					h := &hubs[i]
					if usedHubs[h.nodeID] {
						continue
					}
					angDiff := math.Abs(math.Remainder(h.angleRad-desiredAng, 2.0*math.Pi))
					if angDiff > 0.75 {
						continue
					}
					distRatio := math.Abs(h.roadDistM-targetLegRoadDist) / math.Max(targetLegRoadDist, 500.0)
					if distRatio > 0.65 {
						continue
					}
					minPrevDist := math.MaxFloat64
					for _, prev := range anchorPts {
						dPrev := haversineM(prev[1], prev[0], h.coord[1], h.coord[0])
						if dPrev < minPrevDist {
							minPrevDist = dPrev
						}
					}
					if minPrevDist < math.Max(200.0, targetLegRoadDist*0.28) {
						continue
					}
					score := -distRatio*1000.0 - angDiff*400.0 + h.newRoadBonus*1.5
					if score > bestHScore {
						bestHScore = score
						bestH = h
					}
				}
				if bestH != nil {
					usedHubs[bestH.nodeID] = true
					anchorPts = append(anchorPts, bestH.coord)
				}
			}
			anchorPts = append(anchorPts, startCoord)
		} else {
			// Trasa Start -> Meta z eksploracją nowych dróg do zadanej długości targetKM
			directM := haversineM(startCoord[1], startCoord[0], endCoord[1], endCoord[0])
			targetRadiusM := math.Max(500.0, ((targetKM*1000.0 - directM*0.5)*0.34)*sc)
			usedHubs := make(map[int64]bool)

			for step := 1; step <= 3; step++ {
				frac := float64(step) / 4.0
				midLon := startCoord[0] + (endCoord[0]-startCoord[0])*frac
				midLat := startCoord[1] + (endCoord[1]-startCoord[1])*frac
				var bestH *candidateHub
				bestHScore := -1e18

				for i := range hubs {
					h := &hubs[i]
					if usedHubs[h.nodeID] {
						continue
					}
					dMid := haversineM(midLat, midLon, h.coord[1], h.coord[0])
					distDiff := math.Abs(dMid - targetRadiusM)
					if distDiff > targetRadiusM*0.85 {
						continue
					}
					score := -distDiff + h.newRoadBonus*2.0
					if score > bestHScore {
						bestHScore = score
						bestH = h
					}
				}
				if bestH != nil {
					usedHubs[bestH.nodeID] = true
					anchorPts = append(anchorPts, bestH.coord)
				}
			}
			anchorPts = append(anchorPts, endCoord)
		}

		if len(anchorPts) < 3 {
			continue
		}

		// Wyznaczamy ciągłą ścieżkę przez węzły korytarzowe bez powtarzania tych samych ulic
		g.ResetUsedEdges()
		var allSteps []prevStep
		var allNodes []int64
		totalAvoided := 0
		valid := true

		for i := 0; i < len(anchorPts)-1; i++ {
			p1 := anchorPts[i]
			p2 := anchorPts[i+1]
			legSteps, legNodes, avHits, okLeg := g.findShortestPathSteps(p1[0], p1[1], p2[0], p2[1], req.AvoidPoints, req.AvoidMode, req.Preferences)
			if !okLeg || len(legSteps) == 0 {
				valid = false
				break
			}
			// Oznaczamy użyte krawędzie, aby kolejne odcinki nie wracały po tych samych ulicach
			_, _, _, _ = g.materializeSteps(legSteps, true)
			totalAvoided += avHits
			allSteps = append(allSteps, legSteps...)
			if len(allNodes) == 0 {
				allNodes = append(allNodes, legNodes...)
			} else if len(legNodes) > 1 {
				allNodes = append(allNodes, legNodes[1:]...)
			}
		}

		if !valid || len(allSteps) == 0 {
			continue
		}

		fullCoords, distM, durS, obs := g.materializeSteps(allSteps, false)
		waypoints10, legs10 := g.extractOptimal10Waypoints(allSteps, allNodes, anchorPts[0], anchorPts[len(anchorPts)-1])

		candResp := RoutePlanResponse{
			Status:       "ok",
			DistanceM:    math.Round(distM*10) / 10,
			DurationS:    math.Round(durS*10) / 10,
			Coordinates:  fullCoords,
			Waypoints:    waypoints10,
			Legs:         legs10,
			Obstacles:    obs,
			AvoidedCount: totalAvoided,
		}

		diffKM := math.Abs((distM / 1000.0) - targetKM)
		if !foundAny || diffKM < bestDiffKM {
			bestDiffKM = diffKM
			bestResp = candResp
			foundAny = true
		}
	}

	return bestResp, foundAny
}

// HandlePlanRoute obsługuje wyznaczanie tras (zarówno klasycznych z punktami unikania, jak i automatycznych na km / minuty).
func (s *Service) HandlePlanRoute(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	var req RoutePlanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"detail":"Nieprawidłowy format JSON"}`, http.StatusBadRequest)
		return
	}

	if req.AvoidMode == "" {
		req.AvoidMode = "high_cost"
	}

	if req.AutoGenerate && len(req.Points) >= 1 {
		req.Preferences.AutoExploratory = true
		targetKM := req.TargetKM
		if targetKM <= 0 && req.TargetMinutes > 0 {
			targetKM = req.TargetMinutes * 0.72
		}
		if targetKM <= 0.5 {
			targetKM = 15.0
		}

		startPt := req.Points[0]
		cosLat := math.Max(0.2, math.Cos(startPt[1]*math.Pi/180.0))
		envRadiusKM := math.Max(6.0, math.Min(45.0, targetKM*0.45))
		dLat := envRadiusKM / 111.32
		dLon := envRadiusKM / (111.32 * cosLat)
		bboxPts := [][2]float64{
			{startPt[0] - dLon, startPt[1] - dLat},
			{startPt[0] + dLon, startPt[1] + dLat},
		}
		if len(req.Points) >= 2 && !req.ReturnToStart {
			bboxPts = append(bboxPts, req.Points[len(req.Points)-1])
		}

		g, err := s.loadSubgraphFromDB(ctx, userID, req.ProfileID, bboxPts)
		if err == nil && len(g.Edges) > 0 {
			if resp, ok := g.buildIntelligentAutoRoute(req, targetKM); ok {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				_ = json.NewEncoder(w).Encode(resp)
				return
			}
		}
		req.Points = s.generateAutoWaypointsFallback(req)
	}

	if len(req.Points) < 2 {
		http.Error(w, `{"detail":"Wymagane co najmniej 2 punkty trasy (lub 1 punkt w trybie automatycznym)"}`, http.StatusBadRequest)
		return
	}

	// Wczytanie podgrafu z pamięci podręcznej / PostGIS dla obszaru obejmującego punkty trasy oraz punkty unikania
	bboxPts := make([][2]float64, 0, len(req.Points)+len(req.AvoidPoints))
	bboxPts = append(bboxPts, req.Points...)
	for _, ap := range req.AvoidPoints {
		bboxPts = append(bboxPts, [2]float64{ap.Lon, ap.Lat})
	}

	g, err := s.loadSubgraphFromDB(ctx, userID, req.ProfileID, bboxPts)
	if err == nil && len(g.Edges) > 0 {
		if resp, ok := g.routeAllLegs(req.Points, req.AvoidPoints, req.AvoidMode, req.Preferences); ok {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
	}

	// Fallback: OSRM + geometryczne ominięcie punktów unikania
	resp := s.planWithFallback(ctx, req)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Service) generateAutoWaypointsFallback(req RoutePlanRequest) [][2]float64 {
	start := [2]float64{
		math.Round(req.Points[0][0]*1e6) / 1e6,
		math.Round(req.Points[0][1]*1e6) / 1e6,
	}
	targetKM := req.TargetKM
	if targetKM <= 0 && req.TargetMinutes > 0 {
		targetKM = req.TargetMinutes * 0.72
	}
	if targetKM <= 0.5 {
		targetKM = 10.0
	}
	cosLat := math.Max(0.2, math.Cos(start[1]*math.Pi/180.0))
	stepLat := (targetKM * 0.18) / 111.32
	stepLon := (targetKM * 0.18) / (111.32 * cosLat)
	return [][2]float64{
		start,
		{math.Round((start[0]-stepLon)*1e6) / 1e6, math.Round((start[1]+stepLat*0.5)*1e6) / 1e6},
		{math.Round((start[0]-stepLon*0.5)*1e6) / 1e6, math.Round((start[1]+stepLat)*1e6) / 1e6},
		start,
	}
}

func gridCellKey(lon, lat float64) int64 {
	gx := int64(math.Floor(lon * 2500.0))
	gy := int64(math.Floor(lat * 2500.0))
	return (gx << 32) | (gy & 0xffffffff)
}

func (s *Service) getTraversedGrid(ctx context.Context, userID, profileID string) map[int64]bool {
	cacheKey := userID + "|" + profileID
	s.traversedMu.RLock()
	if entry, ok := s.traversedCache[cacheKey]; ok && time.Since(entry.fetchedAt) < 2*time.Minute {
		s.traversedMu.RUnlock()
		return entry.grid
	}
	s.traversedMu.RUnlock()

	grid := make(map[int64]bool)
	if s.pool == nil {
		return grid
	}

	var rowsQuery string
	var args []interface{}
	if userID != "" && profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		rowsQuery = `
			SELECT DISTINCT
				floor(ST_X(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint,
				floor(ST_Y(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint
			FROM epochs ep
			WHERE ep.profile_id = $1::uuid
			  AND ep.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)
		`
		args = []interface{}{profileID, userID}
	} else if userID != "" {
		rowsQuery = `
			SELECT DISTINCT
				floor(ST_X(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint,
				floor(ST_Y(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint
			FROM epochs ep
			WHERE ep.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $1::uuid)
		`
		args = []interface{}{userID}
	} else {
		rowsQuery = `
			SELECT DISTINCT
				floor(ST_X(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint,
				floor(ST_Y(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint
			FROM epochs ep
		`
	}

	rows, err := s.pool.Query(ctx, rowsQuery, args...)
	if err == nil {
		for rows.Next() {
			var gx, gy int64
			if rows.Scan(&gx, &gy) == nil {
				for dx := int64(-1); dx <= 1; dx++ {
					for dy := int64(-1); dy <= 1; dy++ {
						k := ((gx + dx) << 32) | ((gy + dy) & 0xffffffff)
						grid[k] = true
					}
				}
			}
		}
		rows.Close()
	}

	// Jeśli użytkownik nie ma jeszcze własnych śladów na tym koncie, wczytajmy ogólną siatkę z bazy
	if len(grid) == 0 && len(args) > 0 {
		rows2, err2 := s.pool.Query(ctx, `
			SELECT DISTINCT
				floor(ST_X(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint,
				floor(ST_Y(COALESCE(ep.geom_snapped, ep.geom)) * 2500.0)::bigint
			FROM epochs ep
		`)
		if err2 == nil {
			for rows2.Next() {
				var gx, gy int64
				if rows2.Scan(&gx, &gy) == nil {
					for dx := int64(-1); dx <= 1; dx++ {
						for dy := int64(-1); dy <= 1; dy++ {
							k := ((gx + dx) << 32) | ((gy + dy) & 0xffffffff)
							grid[k] = true
						}
					}
				}
			}
			rows2.Close()
		}
	}

	s.traversedMu.Lock()
	s.traversedCache[cacheKey] = traversedGridEntry{
		grid:      grid,
		fetchedAt: time.Now(),
	}
	s.traversedMu.Unlock()
	return grid
}

func (s *Service) ensureCachedEdges(ctx context.Context) ([]GraphEdge, error) {
	s.mu.RLock()
	if len(s.cachedEdges) > 0 && time.Since(s.cachedAt) < 15*time.Minute {
		edges := s.cachedEdges
		s.mu.RUnlock()
		return edges, nil
	}
	s.mu.RUnlock()

	if s.pool == nil {
		return nil, fmt.Errorf("brak połączenia z bazą")
	}

	rows, err := s.pool.Query(ctx, `
		SELECT
			r.edge_id,
			r.source_node,
			r.target_node,
			r.oneway,
			r.highway,
			COALESCE(r.name, ''),
			r.length_m,
			r.speed_kmh,
			r.duration_s,
			r.is_roundabout,
			r.speed_bumps,
			r.crossings,
			r.traffic_signals,
			r.is_intersection,
			ST_AsGeoJSON(r.geom)::text
		FROM osm_road_edges r
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type geoLine struct {
		Coordinates [][2]float64 `json:"coordinates"`
	}

	var allEdges []GraphEdge
	for rows.Next() {
		var e GraphEdge
		var geoStr string
		if err := rows.Scan(
			&e.EdgeID, &e.SourceNode, &e.TargetNode, &e.Oneway, &e.Highway, &e.Name,
			&e.LengthM, &e.SpeedKMH, &e.DurationS, &e.IsRoundabout,
			&e.SpeedBumps, &e.Crossings, &e.TrafficSignals, &e.IsIntersection,
			&geoStr,
		); err == nil {
			var gl geoLine
			if json.Unmarshal([]byte(geoStr), &gl) == nil && len(gl.Coordinates) >= 2 {
				e.Coords = gl.Coordinates
				allEdges = append(allEdges, e)
			}
		}
	}

	s.mu.Lock()
	s.cachedEdges = allEdges
	s.cachedAt = time.Now()
	s.mu.Unlock()

	return allEdges, nil
}

func (s *Service) loadSubgraphFromDB(
	ctx context.Context,
	userID, profileID string,
	points [][2]float64,
) (*Graph, error) {
	allEdges, err := s.ensureCachedEdges(ctx)
	if err != nil || len(allEdges) == 0 {
		return nil, fmt.Errorf("brak krawędzi drogowych w bazie")
	}

	minLon, maxLon := points[0][0], points[0][0]
	minLat, maxLat := points[0][1], points[0][1]
	for _, p := range points {
		if p[0] < minLon {
			minLon = p[0]
		}
		if p[0] > maxLon {
			maxLon = p[0]
		}
		if p[1] < minLat {
			minLat = p[1]
		}
		if p[1] > maxLat {
			maxLat = p[1]
		}
	}

	padLon := math.Max(0.10, (maxLon-minLon)*0.40)
	padLat := math.Max(0.07, (maxLat-minLat)*0.40)
	minLon -= padLon
	maxLon += padLon
	minLat -= padLat
	maxLat += padLat

	travGrid := s.getTraversedGrid(ctx, userID, profileID)

	g := NewGraph()
	for _, e := range allEdges {
		c0 := e.Coords[0]
		c1 := e.Coords[len(e.Coords)-1]
		if (c0[0] < minLon && c1[0] < minLon) ||
			(c0[0] > maxLon && c1[0] > maxLon) ||
			(c0[1] < minLat && c1[1] < minLat) ||
			(c0[1] > maxLat && c1[1] > maxLat) {
			continue
		}

		mid := e.Coords[len(e.Coords)/2]
		e.Traversed = travGrid[gridCellKey(c0[0], c0[1])] ||
			travGrid[gridCellKey(mid[0], mid[1])] ||
			travGrid[gridCellKey(c1[0], c1[1])]
		g.AddEdge(e)
	}
	return g, nil
}

func countRouteAvoidViolations(coords [][2]float64, avoid []AvoidPoint) (int, *AvoidPoint) {
	violations := 0
	var firstHit *AvoidPoint
	for i := range avoid {
		ap := avoid[i]
		rad := ap.RadiusM
		if rad <= 0 {
			rad = 300.0
		}
		if minDistPolylineToPointM(coords, ap.Lat, ap.Lon) <= rad {
			violations++
			if firstHit == nil {
				firstHit = &avoid[i]
			}
		}
	}
	return violations, firstHit
}

func (s *Service) planWithFallback(ctx context.Context, req RoutePlanRequest) RoutePlanResponse {
	if s.osrmURL != "" && len(req.Points) >= 2 {
		if resp, ok := s.queryOSRM(ctx, req.Points); ok {
			if len(req.AvoidPoints) > 0 {
				violations, hitAP := countRouteAvoidViolations(resp.Coordinates, req.AvoidPoints)
				if violations > 0 && hitAP != nil {
					bestResp := resp
					bestViolations := violations
					bestDist := math.MaxFloat64

					pStart := req.Points[0]
					pEnd := req.Points[len(req.Points)-1]
					cosLat := math.Max(0.2, math.Cos(hitAP.Lat*math.Pi/180.0))
					dx := (pEnd[0] - pStart[0]) * cosLat
					dy := pEnd[1] - pStart[1]
					norm := math.Hypot(dx, dy)
					nx, ny := 1.0, 0.0
					if norm > 1e-6 {
						nx = -dy / norm
						ny = dx / norm
					}
					rad := hitAP.RadiusM
					if rad <= 0 {
						rad = 300.0
					}

					multipliers := []float64{1.8, 2.8, 4.2}
					signs := []float64{1.0, -1.0}
					for _, mult := range multipliers {
						for _, sg := range signs {
							offsetM := rad * mult * sg
							detourLon := hitAP.Lon + (nx*offsetM)/(111320.0*cosLat)
							detourLat := hitAP.Lat + (ny*offsetM)/111320.0
							candPts := make([][2]float64, 0, len(req.Points)+1)
							candPts = append(candPts, req.Points[0])
							candPts = append(candPts, [2]float64{detourLon, detourLat})
							candPts = append(candPts, req.Points[1:]...)
							if candResp, okCand := s.queryOSRM(ctx, candPts); okCand {
								vCnt, _ := countRouteAvoidViolations(candResp.Coordinates, req.AvoidPoints)
								if vCnt < bestViolations || (vCnt == bestViolations && candResp.DistanceM < bestDist) {
									bestViolations = vCnt
									bestDist = candResp.DistanceM
									bestResp = candResp
								}
							}
						}
						if bestViolations == 0 {
							break
						}
					}
					resp = bestResp
				}
			}
			resp.Waypoints = req.Points
			resp.AvoidedCount = len(req.AvoidPoints)
			resp.Obstacles.NewRoadsPercent = 100.0
			return resp
		}
	}

	adjustedPoints := adjustWaypointsAroundAvoidPoints(req.Points, req.AvoidPoints)

	var allCoords [][2]float64
	var legs []RouteLegSummary
	var totalDist, totalDur float64

	for i := 0; i < len(adjustedPoints)-1; i++ {
		p1 := adjustedPoints[i]
		p2 := adjustedPoints[i+1]
		d := haversineM(p1[1], p1[0], p2[1], p2[0]) * 1.18
		dur := (d / 1000.0) / 45.0 * 3600.0
		legCoords := [][2]float64{p1, p2}
		if i == 0 {
			allCoords = append(allCoords, p1)
		}
		allCoords = append(allCoords, p2)
		legs = append(legs, RouteLegSummary{
			DistanceM:   math.Round(d*10) / 10,
			DurationS:   math.Round(dur*10) / 10,
			Coordinates: legCoords,
		})
		totalDist += d
		totalDur += dur
	}

	return RoutePlanResponse{
		Status:       "ok",
		DistanceM:    math.Round(totalDist*10) / 10,
		DurationS:    math.Round(totalDur*10) / 10,
		Coordinates:  allCoords,
		Waypoints:    req.Points,
		Legs:         legs,
		Obstacles:    RouteObstacleSummary{NewRoadsPercent: 100.0},
		AvoidedCount: len(req.AvoidPoints),
	}
}

func adjustWaypointsAroundAvoidPoints(points [][2]float64, avoid []AvoidPoint) [][2]float64 {
	if len(avoid) == 0 || len(points) < 2 {
		return points
	}
	var out [][2]float64
	out = append(out, points[0])

	for i := 0; i < len(points)-1; i++ {
		p1 := points[i]
		p2 := points[i+1]
		segCoords := [][2]float64{p1, p2}
		for _, ap := range avoid {
			rad := ap.RadiusM
			if rad <= 0 {
				rad = 300.0
			}
			d := minDistPolylineToPointM(segCoords, ap.Lat, ap.Lon)
			if d <= rad*1.8 {
				cosLat := math.Max(0.2, math.Cos(ap.Lat*math.Pi/180.0))
				dx := (p2[0] - p1[0]) * cosLat
				dy := p2[1] - p1[1]
				norm := math.Hypot(dx, dy)
				if norm > 1e-6 {
					nx := -dy / norm
					ny := dx / norm
					offsetM := rad * 2.2
					detourLon := ap.Lon + (nx*offsetM)/(111320.0*cosLat)
					detourLat := ap.Lat + (ny*offsetM)/111320.0
					out = append(out, [2]float64{detourLon, detourLat})
				}
			}
		}
		out = append(out, p2)
	}
	return out
}

func (s *Service) queryOSRM(ctx context.Context, pts [][2]float64) (RoutePlanResponse, bool) {
	if len(pts) < 2 {
		return RoutePlanResponse{}, false
	}
	var coordStrs []string
	for _, p := range pts {
		coordStrs = append(coordStrs, fmt.Sprintf("%.6f,%.6f", p[0], p[1]))
	}
	url := fmt.Sprintf("%s/route/v1/driving/%s?overview=full&geometries=geojson&steps=true", s.osrmURL, strings.Join(coordStrs, ";"))

	reqCtx, cancel := context.WithTimeout(ctx, 3500*time.Millisecond)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return RoutePlanResponse{}, false
	}
	res, err := http.DefaultClient.Do(httpReq)
	if err != nil || res.StatusCode != http.StatusOK {
		if res != nil {
			_ = res.Body.Close()
		}
		return RoutePlanResponse{}, false
	}
	defer res.Body.Close()

	var osrmData struct {
		Code   string `json:"code"`
		Routes []struct {
			Distance float64 `json:"distance"`
			Duration float64 `json:"duration"`
			Geometry struct {
				Coordinates [][2]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"routes"`
	}
	if err := json.NewDecoder(res.Body).Decode(&osrmData); err != nil || osrmData.Code != "Ok" || len(osrmData.Routes) == 0 {
		return RoutePlanResponse{}, false
	}
	r0 := osrmData.Routes[0]
	return RoutePlanResponse{
		Status:      "ok",
		DistanceM:   math.Round(r0.Distance*10) / 10,
		DurationS:   math.Round(r0.Duration*10) / 10,
		Coordinates: r0.Geometry.Coordinates,
		Legs: []RouteLegSummary{
			{
				DistanceM:   math.Round(r0.Distance*10) / 10,
				DurationS:   math.Round(r0.Duration*10) / 10,
				Coordinates: r0.Geometry.Coordinates,
			},
		},
	}, true
}

func haversineM(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000.0
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLon := (lon2 - lon1) * math.Pi / 180.0
	la1 := lat1 * math.Pi / 180.0
	la2 := lat2 * math.Pi / 180.0
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * R * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

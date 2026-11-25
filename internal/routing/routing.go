package routing

import (
	"container/heap"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
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
	sfGroup        singleflight.Group
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
	AversionHighways       float64 `json:"aversion_highways"`
	AversionTraversed      float64 `json:"aversion_traversed"`
	AversionBelowSpeed     float64 `json:"aversion_below_speed"`
	AvoidBelowSpeedKMH     float64 `json:"avoid_below_speed_kmh"`
	AvoidBelowSpeed        bool    `json:"avoid_below_speed"`
	AversionAboveSpeed     float64 `json:"aversion_above_speed"`
	AvoidAboveSpeedKMH     float64 `json:"avoid_above_speed_kmh"`
	AvoidAboveSpeed        bool    `json:"avoid_above_speed"`
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
	InitiallyTraversed bool
	UsedCount      int
	Coords         [][2]float64 // [lon, lat]
}

type adjEdge struct {
	toNode  int64
	edgeIdx int
	reverse bool
}

type Graph struct {
	NodeCoords  map[int64][2]float64 // nodeID -> [lon, lat]
	Edges       []GraphEdge
	Adj         map[int64][]adjEdge
	spatialGrid map[int64][]int64
}

func spatialNodeGridKey(gx, gy int64) int64 {
	return (gx << 32) | (gy & 0xffffffff)
}

func nodeToGridCell(lon, lat float64) (int64, int64) {
	return int64(math.Floor(lon * 100.0)), int64(math.Floor(lat * 100.0))
}

func NewGraph() *Graph {
	return &Graph{
		NodeCoords:  make(map[int64][2]float64),
		Adj:         make(map[int64][]adjEdge),
		spatialGrid: make(map[int64][]int64),
	}
}

func (g *Graph) addNodeToSpatialGrid(nid int64, coord [2]float64) {
	if g.spatialGrid == nil {
		g.spatialGrid = make(map[int64][]int64)
	}
	gx, gy := nodeToGridCell(coord[0], coord[1])
	key := spatialNodeGridKey(gx, gy)
	g.spatialGrid[key] = append(g.spatialGrid[key], nid)
}

func (g *Graph) AddEdge(e GraphEdge) {
	if len(e.Coords) < 2 {
		return
	}
	if !e.InitiallyTraversed && e.Traversed {
		e.InitiallyTraversed = true
	}
	idx := len(g.Edges)
	g.Edges = append(g.Edges, e)

	if _, exists := g.NodeCoords[e.SourceNode]; !exists {
		g.NodeCoords[e.SourceNode] = e.Coords[0]
		g.addNodeToSpatialGrid(e.SourceNode, e.Coords[0])
	}
	if _, exists := g.NodeCoords[e.TargetNode]; !exists {
		g.NodeCoords[e.TargetNode] = e.Coords[len(e.Coords)-1]
		g.addNodeToSpatialGrid(e.TargetNode, e.Coords[len(e.Coords)-1])
	}

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

func highwayRank(hw string) int {
	switch hw {
	case "motorway", "motorway_link", "trunk", "trunk_link":
		return 5
	case "primary", "primary_link":
		return 4
	case "secondary", "secondary_link":
		return 3
	case "tertiary", "tertiary_link":
		return 2
	case "unclassified", "residential":
		return 1
	default:
		return 0
	}
}

// ComputeEdgeCost wylicza ważony koszt przejazdu przez krawędź z uwzględnieniem punktów unikania,
// unikania autostrad, suwaków niechęci do przeszkód (w tym trybu MAX=11 "Unikaj zupełnie / Minimum totalne"),
// unikania przebytych już dróg oraz zakazu powtarzania tej samej drogi.
// Zwraca (cost, excluded, hitAvoidPoint).
func ComputeEdgeCost(e GraphEdge, avoidPoints []AvoidPoint, avoidMode string, prefs RoutePreferences) (float64, bool, bool) {
	// Krawędź uznajemy za przebytą, jeśli pochodzi z bazy GPS (Traversed) LUB została już wcześniej włączona do wyznaczanej trasy (UsedCount > 0)
	isTraversed := e.Traversed || e.UsedCount > 0

	cost := math.Max(e.DurationS, 0.5)
	if prefs.AutoExploratory {
		cost = math.Max(e.LengthM/12.5, 0.5)
		rank := highwayRank(e.Highway)
		if prefs.AvoidHighways && isHighwayClass(e.Highway) {
			cost = cost*5000.0 + 2500000.0
		} else {
			// Hierarchia klas dróg - wyższe klasy są naturalnie faworyzowane w trasach rekreacyjnych
			switch rank {
			case 5: // motorway, trunk
				cost *= 0.90
			case 4: // primary
				cost *= 1.00
			case 3: // secondary
				cost *= 1.06
			case 2: // tertiary
				cost *= 1.15
			case 1:
				if e.Highway == "residential" {
					cost *= 2.80 // ulice osiedlowe są znacząco wolniejsze i nie powinny być tranzytem
				} else {
					cost *= 1.30 // unclassified (drogi gminne/lokalne)
				}
			default:
				// service, living_street, track - parkingi, rampy, strefy zamieszkania
				cost = cost*30.0 + 5000.0
			}

			// Premia dla nowych, nieprzebytych dróg tranzytowych
			if !isTraversed {
				cost *= 0.50
			}
		}
	}
	hitAvoid := false

	// 0. Unikanie autostrad i dróg ekspresowych
	if (prefs.AvoidHighways || prefs.AversionHighways > 0) && isHighwayClass(e.Highway) {
		if prefs.AversionHighways > 0 {
			cost += (cost*500.0 + 350000.0) * prefs.AversionHighways
		} else {
			cost = cost*5000.0 + 2500000.0
		}
	}

	// 0b. Unikanie dróg z dopuszczalną prędkością poniżej zadanego progu (< X km/h)
	if prefs.AvoidBelowSpeedKMH > 0 && (prefs.AvoidBelowSpeed || prefs.AversionBelowSpeed > 0) {
		speed := e.SpeedKMH
		if speed <= 0 {
			speed = 30.0
		}
		if speed < prefs.AvoidBelowSpeedKMH {
			ratio := (prefs.AvoidBelowSpeedKMH - speed) / prefs.AvoidBelowSpeedKMH
			if ratio < 0 {
				ratio = 0
			}
			penaltyFactor := 1.0 + ratio*2.0
			if prefs.AversionBelowSpeed >= 10.5 {
				cost += 2500000.0 * penaltyFactor
			} else if prefs.AversionBelowSpeed > 0 {
				cost += (cost*150.0 + 35000.0) * prefs.AversionBelowSpeed * penaltyFactor
			} else {
				cost += (cost*1000.0 + 250000.0) * penaltyFactor
			}
		}
	}

	// 0c. Unikanie dróg z dopuszczalną prędkością powyżej zadanego progu (> X km/h)
	if prefs.AvoidAboveSpeedKMH > 0 && (prefs.AvoidAboveSpeed || prefs.AversionAboveSpeed > 0) {
		speed := e.SpeedKMH
		if speed <= 0 {
			speed = 30.0
		}
		if speed > prefs.AvoidAboveSpeedKMH {
			ratio := (speed - prefs.AvoidAboveSpeedKMH) / prefs.AvoidAboveSpeedKMH
			if ratio < 0 {
				ratio = 0
			}
			penaltyFactor := 1.0 + ratio*2.0
			if prefs.AversionAboveSpeed >= 10.5 {
				cost += 2500000.0 * penaltyFactor
			} else if prefs.AversionAboveSpeed > 0 {
				cost += (cost*150.0 + 35000.0) * prefs.AversionAboveSpeed * penaltyFactor
			} else {
				cost += (cost*1000.0 + 250000.0) * penaltyFactor
			}
		}
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

	// 2. Kary wynikające z priorytetu niechęci (skala 1..5: 1000..5000 kary, 11 = MAX / Minimum totalne) do przeszkód drogowych
	if prefs.AversionSpeedBumps > 0 && e.SpeedBumps > 0 {
		if prefs.AversionSpeedBumps >= 10.5 {
			cost += float64(e.SpeedBumps) * 2500000.0
		} else {
			cost += float64(e.SpeedBumps) * prefs.AversionSpeedBumps * 1000.0
		}
	}
	if prefs.AversionCrossings > 0 && e.Crossings > 0 {
		if prefs.AversionCrossings >= 10.5 {
			cost += float64(e.Crossings) * 2500000.0
		} else {
			cost += float64(e.Crossings) * prefs.AversionCrossings * 1000.0
		}
	}
	if prefs.AversionTrafficSignals > 0 && e.TrafficSignals > 0 {
		if prefs.AversionTrafficSignals >= 10.5 {
			cost += float64(e.TrafficSignals) * 2500000.0
		} else {
			cost += float64(e.TrafficSignals) * prefs.AversionTrafficSignals * 1000.0
		}
	}
	if prefs.AversionRoundabouts > 0 && e.IsRoundabout {
		if prefs.AversionRoundabouts >= 10.5 {
			cost += 2500000.0
		} else {
			cost += prefs.AversionRoundabouts * 1000.0
		}
	}
	if prefs.AversionIntersections > 0 && e.IsIntersection {
		if prefs.AversionIntersections >= 10.5 {
			cost += 2500000.0
		} else {
			cost += prefs.AversionIntersections * 1000.0
		}
	}

	// 3. Unikanie przebytych już dróg (kara za wjazd na drogę ze śladem GPS LUB już użytą w bieżącej trasie)
	if (prefs.AvoidTraversed || prefs.AversionTraversed > 0) && isTraversed {
		if prefs.AversionTraversed > 0 {
			cost += (cost*2.5 + 35.0) * prefs.AversionTraversed
		} else {
			cost = cost*16.0 + 200.0
		}
	}

	// 4. Unikanie jechania 2 razy tą samą drogą w ramach wyznaczanej trasy
	if e.UsedCount > 0 {
		cost += (cost*15.0 + 800.0) * float64(e.UsedCount)
	}

	return cost, false, hitAvoid
}

func (g *Graph) ResetUsedEdges() {
	for i := range g.Edges {
		g.Edges[i].UsedCount = 0
		g.Edges[i].Traversed = g.Edges[i].InitiallyTraversed
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
	return g.FindNearestNodeWithMinDegree(lon, lat, 1)
}

func (g *Graph) FindNearestNodeWithMinDegree(lon, lat float64, minDegree int) (int64, bool) {
	if len(g.NodeCoords) == 0 {
		return 0, false
	}
	if minDegree < 1 {
		minDegree = 1
	}

	var bestID int64
	bestDist := math.MaxFloat64
	found := false

	// 1. Szybkie wyszukiwanie przestrzenne po pierścieniach siatki (komórki ~1.1km)
	if len(g.spatialGrid) > 0 {
		centerGx, centerGy := nodeToGridCell(lon, lat)
		maxRadius := int64(25) // do ok. 25 km
		for r := int64(0); r <= maxRadius; r++ {
			for dx := -r; dx <= r; dx++ {
				for dy := -r; dy <= r; dy++ {
					if r > 0 && dx > -r && dx < r && dy > -r && dy < r {
						continue // komórka sprawdzona we wcześniejszym pierścieniu
					}
					cellKey := spatialNodeGridKey(centerGx+dx, centerGy+dy)
					nodes := g.spatialGrid[cellKey]
					for _, nid := range nodes {
						if len(g.Adj[nid]) < minDegree {
							continue
						}
						c := g.NodeCoords[nid]
						d := haversineM(lat, lon, c[1], c[0])
						if d < bestDist {
							bestDist = d
							bestID = nid
							found = true
						}
					}
				}
			}

			// Jeśli znaleziono węzeł, a odległość do kolejnego pierścienia jest większa niż bestDist,
			// żaden dalszy węzeł nie może być bliżej - kończymy natychmiast.
			if found {
				approxDistToNextRingM := float64(r) * 600.0
				if bestDist < approxDistToNextRingM {
					return bestID, true
				}
			}
		}

		if found {
			return bestID, true
		}
	}

	// 2. Bezpieczny fallback globalny (np. punkt daleko na morzu lub poza siatką dróg)
	for nid, c := range g.NodeCoords {
		if len(g.Adj[nid]) < minDegree {
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

func isTransitHighway(hw string) bool {
	switch hw {
	case "motorway", "motorway_link", "trunk", "trunk_link",
		"primary", "primary_link", "secondary", "secondary_link",
		"tertiary", "tertiary_link":
		return true
	default:
		return false
	}
}

// isDeadEnd sprawdza czy węzeł nodeID nie posiada żadnego innego wyjścia poza natychmiastowym
// zawróceniem krawędzią incomingEdgeIdx.
func (g *Graph) isDeadEnd(nodeID int64, incomingEdgeIdx int) bool {
	for _, adj := range g.Adj[nodeID] {
		if adj.edgeIdx != incomingEdgeIdx {
			return false
		}
	}
	return true
}

func (g *Graph) isTransitNode(nodeID int64) bool {
	adjs := g.Adj[nodeID]
	if len(adjs) < 2 {
		return false
	}
	hasTransitEdge := false
	distinctOutNodes := make(map[int64]bool)
	for _, a := range adjs {
		e := g.Edges[a.edgeIdx]
		if isTransitHighway(e.Highway) {
			hasTransitEdge = true
		}
		distinctOutNodes[a.toNode] = true
	}
	return hasTransitEdge && len(distinctOutNodes) >= 2
}

func (g *Graph) FindNearestTransitNode(lon, lat float64) (int64, bool) {
	if len(g.NodeCoords) == 0 {
		return 0, false
	}

	var bestID int64
	bestDist := math.MaxFloat64
	found := false

	if len(g.spatialGrid) > 0 {
		centerGx, centerGy := nodeToGridCell(lon, lat)
		maxRadius := int64(25) // do ok. 25 km
		for r := int64(0); r <= maxRadius; r++ {
			for dx := -r; dx <= r; dx++ {
				for dy := -r; dy <= r; dy++ {
					if r > 0 && dx > -r && dx < r && dy > -r && dy < r {
						continue
					}
					cellKey := spatialNodeGridKey(centerGx+dx, centerGy+dy)
					nodes := g.spatialGrid[cellKey]
					for _, nid := range nodes {
						if !g.isTransitNode(nid) {
							continue
						}
						c := g.NodeCoords[nid]
						d := haversineM(lat, lon, c[1], c[0])
						if d < bestDist {
							bestDist = d
							bestID = nid
							found = true
						}
					}
				}
			}

			if found {
				approxDistToNextRingM := float64(r) * 600.0
				if bestDist < approxDistToNextRingM {
					return bestID, true
				}
			}
		}

		if found {
			return bestID, true
		}
	}

	for nid, c := range g.NodeCoords {
		if !g.isTransitNode(nid) {
			continue
		}
		d := haversineM(lat, lon, c[1], c[0])
		if d < bestDist {
			bestDist = d
			bestID = nid
			found = true
		}
	}
	if found {
		return bestID, true
	}
	return g.FindNearestNodeWithMinDegree(lon, lat, 2)
}

func pruneAntennaSteps(steps []prevStep) []prevStep {
	if len(steps) < 2 {
		return steps
	}
	for {
		pruned := false
		var out []prevStep
		for i := 0; i < len(steps); i++ {
			if i+1 < len(steps) && steps[i].edgeIdx == steps[i+1].edgeIdx && steps[i].reverse != steps[i+1].reverse {
				i++
				pruned = true
			} else {
				out = append(out, steps[i])
			}
		}
		steps = out
		if !pruned {
			break
		}
	}
	return steps
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
		prefs.AversionTraversed > 0 ||
		prefs.AversionHighways > 0 ||
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
			// Zakaz natychmiastowego zawracania tą samą krawędzią
			if hasPrev && adj.edgeIdx == prevSt.edgeIdx {
				continue
			}

			// Zakaz wjeżdżania w ślepe zaułki (węzły bez żadnego innego wyjazdu niż natychmiastowe zawrócenie)
			if adj.toNode != endNode && g.isDeadEnd(adj.toNode, adj.edgeIdx) {
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

			// W trybie AutoExploratory nakładamy karę za zjazd z arterii tranzytowej na drogę osiedlową (residential)
			if prefs.AutoExploratory && hasPrev {
				prevE := g.Edges[prevSt.edgeIdx]
				if isTransitHighway(prevE.Highway) && e.Highway == "residential" && adj.toNode != endNode {
					edgeCost += 600.0
				}
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
			g.Edges[st.edgeIdx].Traversed = true
			e := g.Edges[st.edgeIdx]
			for _, adj := range g.Adj[e.SourceNode] {
				if adj.toNode == e.TargetNode && adj.edgeIdx != st.edgeIdx {
					g.Edges[adj.edgeIdx].UsedCount++
					g.Edges[adj.edgeIdx].Traversed = true
				}
			}
			for _, adj := range g.Adj[e.TargetNode] {
				if adj.toNode == e.SourceNode && adj.edgeIdx != st.edgeIdx {
					g.Edges[adj.edgeIdx].UsedCount++
					g.Edges[adj.edgeIdx].Traversed = true
				}
			}
		}

		e := g.Edges[st.edgeIdx]
		distM += e.LengthM
		durS += e.DurationS
		totalLenM += e.LengthM
		if e.InitiallyTraversed {
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

// scoreAutoRouteCandidate ocenia dopasowanie trasy kandydata zgodnie z kryteriami użytkownika:
// 1. Jeśli jest tylko czas: szukamy trasy najbliższej temu czasowi (|durMin - targetMinutes|).
// 2. Jeśli jest tylko dystans: szukamy trasy najbliższej temu dystansowi (|distKM - targetKM|), a przy zbliżonym dystansie najszybszej.
// 3. Jeśli podano oba: szukamy trasy najbliższej obu wartościom naraz (minimalizacja sumy względnych odchyleń).
func scoreAutoRouteCandidate(req RoutePlanRequest, targetKM float64, distM float64, durationS float64) (score float64, isOptimal bool) {
	distKM := distM / 1000.0
	durMin := durationS / 60.0

	// 1. Tylko czas podany
	if req.TargetMinutes > 0 && req.TargetKM <= 0 {
		diffMin := math.Abs(durMin - req.TargetMinutes)
		score = diffMin
		isOptimal = diffMin <= math.Max(1.0, req.TargetMinutes*0.06)
		return
	}

	// 2. Tylko dystans podany (i najszybsza)
	if req.TargetKM > 0 && req.TargetMinutes <= 0 {
		diffKM := math.Abs(distKM - req.TargetKM)
		// Dystans jest priorytetem, a czas trwania w godzinach jest łagodnym bonusem szybkości
		score = diffKM + (durationS/3600.0)*0.04
		isOptimal = diffKM <= math.Max(0.5, req.TargetKM*0.06)
		return
	}

	// 3. Oba parametry podane: najbliżej do obu wartości
	if req.TargetKM > 0 && req.TargetMinutes > 0 {
		relDist := math.Abs(distKM-req.TargetKM) / req.TargetKM
		relTime := math.Abs(durMin-req.TargetMinutes) / req.TargetMinutes
		score = relDist + relTime
		isOptimal = relDist <= 0.08 && relTime <= 0.08
		return
	}

	// Domyślnie wg targetKM:
	diffKM := math.Abs(distKM - targetKM)
	score = diffKM
	isOptimal = diffKM <= targetKM*0.10
	return
}

// buildCircularLoopRoute buduje idealną, spójną pętlę („kółko”) o zadanej długości targetKM wokół
// wyznaczonego centrum geometrycznego. Trasa układa się w gładki obieg wielokąta foremnego
// bez żadnych nawrotów o 180 stopni, ani ponownego przejeżdżania przez te same odcinki.
func (g *Graph) buildCircularLoopRoute(req RoutePlanRequest, startNode int64, startCoord [2]float64, targetKM float64) (RoutePlanResponse, bool) {
	cosLat := math.Max(0.2, math.Cos(startCoord[1]*math.Pi/180.0))

	// Rzeczywisty dystans drogowy 6-wierzchołkowej pętli to około 13.8 * R (w siatce drogowej z uwzględnieniem krętości i unikania nawrotów)
	baseR := math.Max(400.0, (targetKM*1000.0)/13.8)

	type loopCandidate struct {
		anchorCoords [][2]float64
		score        float64
		bearingDeg   float64
		clockwise    bool
	}

	buildAnchorsForR := func(R float64) []loopCandidate {
		var cands []loopCandidate
		for bDeg := 0.0; bDeg < 360.0; bDeg += 30.0 {
			bRad := bDeg * math.Pi / 180.0
			centerLon := startCoord[0] + (R*math.Sin(bRad))/(111320.0*cosLat)
			centerLat := startCoord[1] + (R*math.Cos(bRad))/111320.0
			startAngle := bRad + math.Pi

			for _, clockwise := range []bool{true, false} {
				dirSign := 1.0
				if !clockwise {
					dirSign = -1.0
				}

				var legCoords [][2]float64
				legCoords = append(legCoords, startCoord)
				valid := true
				loopScore := 0.0

				for step := 1; step <= 5; step++ {
					stepAng := startAngle + dirSign*float64(step)*(2.0*math.Pi/6.0)
					targetLon := centerLon + (R*math.Sin(stepAng))/(111320.0*cosLat)
					targetLat := centerLat + (R*math.Cos(stepAng))/111320.0

					nodeID, okNode := g.FindNearestTransitNode(targetLon, targetLat)
					if !okNode {
						valid = false
						break
					}
					nodeCoord := g.NodeCoords[nodeID]
					dFromTarget := haversineM(targetLat, targetLon, nodeCoord[1], nodeCoord[0])
					if dFromTarget > math.Max(4000.0, R*0.75) {
						valid = false
						break
					}

					prev := legCoords[len(legCoords)-1]
					dFromPrev := haversineM(prev[1], prev[0], nodeCoord[1], nodeCoord[0])
					if dFromPrev < math.Max(120.0, R*0.18) {
						valid = false
						break
					}

					if step >= 2 && step <= 4 {
						dFromStart := haversineM(startCoord[1], startCoord[0], nodeCoord[1], nodeCoord[0])
						if dFromStart < math.Max(200.0, R*0.30) {
							valid = false
							break
						}
					}

					hitAvoid := false
					for _, ap := range req.AvoidPoints {
						rad := ap.RadiusM
						if rad <= 0 {
							rad = 300
						}
						if haversineM(ap.Lat, ap.Lon, nodeCoord[1], nodeCoord[0]) <= rad {
							hitAvoid = true
							break
						}
					}
					if hitAvoid {
						valid = false
						break
					}

					adjs := g.Adj[nodeID]
					if len(adjs) < 2 {
						valid = false
						break
					}
					for _, a := range adjs {
						e := g.Edges[a.edgeIdx]
						if (req.Preferences.AvoidHighways || req.Preferences.AversionHighways > 0) && isHighwayClass(e.Highway) {
							loopScore -= 5000.0
						}
						if req.Preferences.AvoidBelowSpeedKMH > 0 && (req.Preferences.AvoidBelowSpeed || req.Preferences.AversionBelowSpeed > 0) {
							spd := e.SpeedKMH
							if spd <= 0 {
								spd = 30.0
							}
							if spd < req.Preferences.AvoidBelowSpeedKMH {
								loopScore -= 2500.0 * math.Max(1.0, req.Preferences.AversionBelowSpeed)
							}
						}
						if req.Preferences.AvoidAboveSpeedKMH > 0 && (req.Preferences.AvoidAboveSpeed || req.Preferences.AversionAboveSpeed > 0) {
							spd := e.SpeedKMH
							if spd <= 0 {
								spd = 30.0
							}
							if spd > req.Preferences.AvoidAboveSpeedKMH {
								loopScore -= 2500.0 * math.Max(1.0, req.Preferences.AversionAboveSpeed)
							}
						}
						if !e.Traversed && e.UsedCount == 0 {
							loopScore += e.LengthM * 1.2
						} else {
							loopScore -= 2000.0 * math.Max(1.0, req.Preferences.AversionTraversed)
						}
						loopScore -= float64(e.SpeedBumps*25 + e.Crossings*10 + e.TrafficSignals*15)
					}
					loopScore -= dFromTarget * 1.5

					legCoords = append(legCoords, nodeCoord)
				}

				if !valid || len(legCoords) != 6 {
					continue
				}

				legCoords = append(legCoords, startCoord)
				cands = append(cands, loopCandidate{
					anchorCoords: legCoords,
					score:        loopScore,
					bearingDeg:   bDeg,
					clockwise:    clockwise,
				})
			}
		}
		sort.Slice(cands, func(i, j int) bool {
			return cands[i].score > cands[j].score
		})
		return cands
	}

	routeAnchors := func(anchors [][2]float64) (RoutePlanResponse, float64, bool) {
		g.ResetUsedEdges()
		var allSteps []prevStep
		var allNodes []int64
		totalAvoided := 0

		for i := 0; i < len(anchors)-1; i++ {
			p1 := anchors[i]
			p2 := anchors[i+1]
			if i == len(anchors)-2 {
				// Przed ostatnim odcinkiem domykającym do startu:
				// Zwalniamy krawędzie wyjazdowe ze startu w promieniu 2.5 km, aby Dijkstra mógł bezpośrednio wrócić
				for eIdx := range g.Edges {
					if g.Edges[eIdx].UsedCount > 0 {
						c := g.Edges[eIdx].Coords[0]
						if haversineM(startCoord[1], startCoord[0], c[1], c[0]) <= 2500.0 {
							g.Edges[eIdx].UsedCount = 0
						}
					}
				}
			}
			legSteps, legNodes, avHits, okLeg := g.findShortestPathSteps(p1[0], p1[1], p2[0], p2[1], req.AvoidPoints, req.AvoidMode, req.Preferences)
			if !okLeg || len(legSteps) == 0 {
				return RoutePlanResponse{}, 0, false
			}
			_, _, _, _ = g.materializeSteps(legSteps, true)
			totalAvoided += avHits
			allSteps = append(allSteps, legSteps...)
			if len(allNodes) == 0 {
				allNodes = append(allNodes, legNodes...)
			} else if len(legNodes) > 1 {
				allNodes = append(allNodes, legNodes[1:]...)
			}
		}

		if len(allSteps) == 0 {
			return RoutePlanResponse{}, 0, false
		}

		allSteps = pruneAntennaSteps(allSteps)
		allSteps = pruneAntennaSteps(allSteps)
		fullCoords, distM, durS, obs := g.materializeSteps(allSteps, false)
		resp := RoutePlanResponse{
			Status:       "ok",
			DistanceM:    math.Round(distM*10) / 10,
			DurationS:    math.Round(durS*10) / 10,
			Coordinates:  fullCoords,
			Waypoints:    [][2]float64{anchors[0], anchors[len(anchors)-1]},
			Legs: []RouteLegSummary{
				{
					DistanceM:   math.Round(distM*10) / 10,
					DurationS:   math.Round(durS*10) / 10,
					Coordinates: fullCoords,
				},
			},
			Obstacles:    obs,
			AvoidedCount: totalAvoided,
		}
		return resp, distM, true
	}

	candidates := buildAnchorsForR(baseR)
	if len(candidates) == 0 {
		return RoutePlanResponse{}, false
	}

	var bestResp RoutePlanResponse
	bestScore := math.MaxFloat64
	foundAny := false
	var bestCandidate *loopCandidate

	// Testujemy do 8 najlepszych kandydatów przy bazowym promieniu
	maxInitial := 8
	if len(candidates) < maxInitial {
		maxInitial = len(candidates)
	}

	for i := 0; i < maxInitial; i++ {
		cand := candidates[i]
		resp, distM, ok := routeAnchors(cand.anchorCoords)
		if !ok {
			continue
		}
		score, isOpt := scoreAutoRouteCandidate(req, targetKM, distM, resp.DurationS)
		if !foundAny || score < bestScore {
			bestScore = score
			bestResp = resp
			foundAny = true
			candCopy := cand
			bestCandidate = &candCopy
		}
		if isOpt {
			g.ResetUsedEdges()
			return bestResp, true
		}
	}

	// Jeśli trasa nie osiągnęła jeszcze stanu optymalnego, wykonujemy precyzyjną kalibrację promienia R na zwycięskim azymucie
	calibNeeded := false
	if foundAny && bestCandidate != nil && bestResp.DistanceM > 0 {
		if req.TargetMinutes > 0 && req.TargetKM <= 0 {
			calibNeeded = math.Abs((bestResp.DurationS/60.0)-req.TargetMinutes) > req.TargetMinutes*0.08
		} else if req.TargetKM > 0 && req.TargetMinutes <= 0 {
			calibNeeded = math.Abs((bestResp.DistanceM/1000.0)-req.TargetKM) > req.TargetKM*0.08
		} else if req.TargetKM > 0 && req.TargetMinutes > 0 {
			relDist := math.Abs((bestResp.DistanceM/1000.0)-req.TargetKM) / req.TargetKM
			relTime := math.Abs((bestResp.DurationS/60.0)-req.TargetMinutes) / req.TargetMinutes
			calibNeeded = (relDist + relTime) > 0.16
		} else {
			calibNeeded = bestScore > targetKM*0.12
		}
	}

	if calibNeeded {
		var calibRatio float64
		if req.TargetMinutes > 0 && req.TargetKM <= 0 && bestResp.DurationS > 0 {
			calibRatio = (req.TargetMinutes * 60.0) / bestResp.DurationS
		} else if req.TargetKM > 0 && req.TargetMinutes <= 0 && bestResp.DistanceM > 0 {
			calibRatio = (req.TargetKM * 1000.0) / bestResp.DistanceM
		} else if req.TargetKM > 0 && req.TargetMinutes > 0 && bestResp.DistanceM > 0 && bestResp.DurationS > 0 {
			rDist := (req.TargetKM * 1000.0) / bestResp.DistanceM
			rTime := (req.TargetMinutes * 60.0) / bestResp.DurationS
			calibRatio = (rDist + rTime) / 2.0
		} else {
			calibRatio = (targetKM * 1000.0) / bestResp.DistanceM
		}
		calibRatio = math.Max(0.2, math.Min(2.5, calibRatio))
		calibR := baseR * calibRatio
		calibCands := buildAnchorsForR(calibR)
		for _, cc := range calibCands {
			if cc.bearingDeg == bestCandidate.bearingDeg && cc.clockwise == bestCandidate.clockwise {
				if calibResp, calibDistM, okCalib := routeAnchors(cc.anchorCoords); okCalib {
					sc, _ := scoreAutoRouteCandidate(req, targetKM, calibDistM, calibResp.DurationS)
					if sc < bestScore {
						bestScore = sc
						bestResp = calibResp
					}
				}
				break
			}
		}
	}

	g.ResetUsedEdges()
	return bestResp, foundAny
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

	// Jeśli użytkownik zażądał pętli (kółka z powrotem do startu), uruchamiamy dedykowany generator
	// gładkich pętli bez zawracania i dublowania dróg
	if req.ReturnToStart || len(req.Points) == 1 {
		if loopResp, okLoop := g.buildCircularLoopRoute(req, startNode, startCoord, targetKM); okLoop {
			return loopResp, true
		}
	}

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
		rankBonus := 0.0
		for _, a := range adjs {
			e := g.Edges[a.edgeIdx]
			if (req.Preferences.AvoidHighways || req.Preferences.AversionHighways > 0) && isHighwayClass(e.Highway) {
				isBad = true
				break
			}
			if !e.Traversed {
				untraversedLen += e.LengthM
				switch highwayRank(e.Highway) {
				case 5:
					if !req.Preferences.AvoidHighways && req.Preferences.AversionHighways == 0 {
						rankBonus += 15000.0
					}
				case 4:
					rankBonus += 12000.0
				case 3:
					rankBonus += 6000.0
				case 2:
					rankBonus += 2500.0
				case 1:
					rankBonus += 600.0
				}
			}
			obstaclePenalty += float64(e.SpeedBumps*30 + e.Crossings*10 + e.TrafficSignals*20)
			if req.Preferences.AvoidBelowSpeedKMH > 0 && (req.Preferences.AvoidBelowSpeed || req.Preferences.AversionBelowSpeed > 0) {
				spd := e.SpeedKMH
				if spd <= 0 {
					spd = 30.0
				}
				if spd < req.Preferences.AvoidBelowSpeedKMH {
					obstaclePenalty += 400.0 * math.Max(1.0, req.Preferences.AversionBelowSpeed)
				}
			}
			if req.Preferences.AvoidAboveSpeedKMH > 0 && (req.Preferences.AvoidAboveSpeed || req.Preferences.AversionAboveSpeed > 0) {
				spd := e.SpeedKMH
				if spd <= 0 {
					spd = 30.0
				}
				if spd > req.Preferences.AvoidAboveSpeedKMH {
					obstaclePenalty += 400.0 * math.Max(1.0, req.Preferences.AversionAboveSpeed)
				}
			}
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
			newRoadBonus: untraversedLen*2.0 + rankBonus - obstaclePenalty,
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
	bestScore := math.MaxFloat64
	foundAny := false

	for _, sc := range scales {
		var anchorPts [][2]float64
		anchorPts = append(anchorPts, startCoord)

		if isLoop {
			// Budujemy płynną pętlę przez 4 dobrze odseparowane węzły korytarzowe na sieci dróg (tworzące szeroki wielokąt bez zawracania)
			targetLegRoadDist := math.Max(400.0, (targetKM*1000.0/4.2)*sc)
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
			if isLoop && i == len(anchorPts)-2 {
				for eIdx := range g.Edges {
					if g.Edges[eIdx].UsedCount > 0 {
						c := g.Edges[eIdx].Coords[0]
						if haversineM(startCoord[1], startCoord[0], c[1], c[0]) <= 2500.0 {
							g.Edges[eIdx].UsedCount = 0
						}
					}
				}
			}
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

		allSteps = pruneAntennaSteps(allSteps)
		fullCoords, distM, durS, obs := g.materializeSteps(allSteps, false)
		candResp := RoutePlanResponse{
			Status:       "ok",
			DistanceM:    math.Round(distM*10) / 10,
			DurationS:    math.Round(durS*10) / 10,
			Coordinates:  fullCoords,
			Waypoints:    [][2]float64{anchorPts[0], anchorPts[len(anchorPts)-1]},
			Legs: []RouteLegSummary{
				{
					DistanceM:   math.Round(distM*10) / 10,
					DurationS:   math.Round(durS*10) / 10,
					Coordinates: fullCoords,
				},
			},
			Obstacles:    obs,
			AvoidedCount: totalAvoided,
		}

		score, _ := scoreAutoRouteCandidate(req, targetKM, distM, durS)
		if !foundAny || score < bestScore {
			bestScore = score
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
		req.AvoidMode = "exclude"
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
		envRadiusKM := math.Max(10.0, math.Min(150.0, targetKM*0.65))
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

	res, err, _ := s.sfGroup.Do("ensureCachedEdges", func() (interface{}, error) {
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
	})

	if err != nil {
		return nil, err
	}
	return res.([]GraphEdge), nil
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
		e.InitiallyTraversed = e.Traversed
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

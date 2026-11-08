package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// OSRMClient zarządza wielowątkowymi zapytaniami HTTP do silnika OSRM
type OSRMClient struct {
	baseURL    string
	httpClient *http.Client
	snapCache  sync.Map // [2]int64 -> string (WKT)
	routeCache sync.Map // RouteKey -> string (WKT)
}

func NewOSRMClient(baseURL string, maxConns int) *OSRMClient {
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        maxConns * 2,
		MaxIdleConnsPerHost: maxConns,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression: false,
	}

	return &OSRMClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   8 * time.Second,
		},
	}
}

// OSRMMatchResponse struktura odpowiedzi OSRM /match
type OSRMMatchResponse struct {
	Code        string `json:"code"`
	Tracepoints []struct {
		Location       []float64 `json:"location"`
		MatchingsIndex *int      `json:"matchings_index"`
		WaypointIndex  *int      `json:"waypoint_index"`
	} `json:"tracepoints"`
	Matchings []struct {
		Legs []struct {
			Steps []struct {
				Geometry struct {
					Coordinates [][]float64 `json:"coordinates"`
				} `json:"geometry"`
			} `json:"steps"`
		} `json:"legs"`
	} `json:"matchings"`
}

// OSRMNearestResponse struktura odpowiedzi OSRM /nearest
type OSRMNearestResponse struct {
	Code      string `json:"code"`
	Waypoints []struct {
		Distance float64   `json:"distance"`
		Location []float64 `json:"location"`
	} `json:"waypoints"`
}

// OSRMRouteResponse struktura odpowiedzi OSRM /route
type OSRMRouteResponse struct {
	Code   string `json:"code"`
	Routes []struct {
		Distance float64 `json:"distance"`
		Geometry struct {
			Coordinates [][]float64 `json:"coordinates"`
		} `json:"geometry"`
	} `json:"routes"`
}

// Match wykonuje zapytanie OSRM /match dla partii współrzędnych
func (c *OSRMClient) Match(coords []Point) (*OSRMMatchResponse, error) {
	if len(coords) < 2 {
		return nil, nil
	}

	var sb strings.Builder
	sb.WriteString(c.baseURL)
	sb.WriteString("/match/v1/driving/")

	for i, pt := range coords {
		if i > 0 {
			sb.WriteByte(';')
		}
		sb.WriteString(fmt.Sprintf("%.6f,%.6f", pt.Lon, pt.Lat))
	}

	sb.WriteString("?overview=full&geometries=geojson&steps=true&gaps=ignore&tidy=true&radiuses=")
	for i := range coords {
		if i > 0 {
			sb.WriteByte(';')
		}
		sb.WriteString("30")
	}

	resp, err := c.httpClient.Get(sb.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("OSRM status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var res OSRMMatchResponse
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, err
	}

	return &res, nil
}

// Nearest pobiera najbliższy punkt na drodze przez OSRM /nearest
func (c *OSRMClient) Nearest(lon, lat float64) (string, error) {
	url := fmt.Sprintf("%s/nearest/v1/driving/%.6f,%.6f?number=1", c.baseURL, lon, lat)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}

	var res OSRMNearestResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}

	if res.Code == "Ok" && len(res.Waypoints) > 0 && len(res.Waypoints[0].Location) == 2 {
		loc := res.Waypoints[0].Location
		return fmt.Sprintf("SRID=4326;POINT(%.6f %.6f)", loc[0], loc[1]), nil
	}
	return "", nil
}

// RouteGeom wyznacza geometrię drogi między dwoma punktami
func (c *OSRMClient) RouteGeom(p1, p2 Point) (string, error) {
	url := fmt.Sprintf("%s/route/v1/driving/%.6f,%.6f;%%20%.6f,%.6f?overview=full&geometries=geojson",
		c.baseURL, p1.Lon, p1.Lat, p2.Lon, p2.Lat)
	url = strings.Replace(url, "%%20", "", 1)

	resp, err := c.httpClient.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}

	var res OSRMRouteResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}

	if res.Code == "Ok" && len(res.Routes) > 0 && len(res.Routes[0].Geometry.Coordinates) >= 2 {
		coords := res.Routes[0].Geometry.Coordinates
		var sb strings.Builder
		sb.WriteString("SRID=4326;LINESTRING(")
		for i, c := range coords {
			if i > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(fmt.Sprintf("%.6f %.6f", c[0], c[1]))
		}
		sb.WriteString(")")
		return sb.String(), nil
	}
	return "", nil
}

// SnapBatch przetwarza całą partię epok równolegle w mikro-wątkach (goroutines)
func (c *OSRMClient) SnapBatch(epochs []*Epoch, chunkSize int, concurrency int) {
	if len(epochs) == 0 {
		return
	}

	// 1. Sprawdzenie Spatial Cache w pamięci RAM
	for _, ep := range epochs {
		pt := Point{Lon: ep.Lon, Lat: ep.Lat}
		if val, ok := c.snapCache.Load(pt.CacheKey()); ok {
			ep.GeomSnapped = val.(string)
		}
	}

	// 2. Propagacja punktów postojowych (<3m i <2 km/h)
	for i := 1; i < len(epochs); i++ {
		curr := epochs[i]
		if curr.GeomSnapped != "" {
			continue
		}
		prev := epochs[i-1]
		dist := HaversineMeters(prev.Lat, prev.Lon, curr.Lat, curr.Lon)
		if dist < 3.0 && (curr.SpeedKmh < 2.0 || prev.SpeedKmh < 2.0) {
			if prev.GeomSnapped != "" {
				curr.GeomSnapped = prev.GeomSnapped
				c.snapCache.Store(Point{Lon: curr.Lon, Lat: curr.Lat}.CacheKey(), prev.GeomSnapped)
			}
		}
	}

	// 3. Podział na spójne segmenty czasowe (luka > 15s to nowy segment)
	var segments [][]*Epoch
	currentSeg := []*Epoch{epochs[0]}

	for i := 1; i < len(epochs); i++ {
		curr := epochs[i]
		prev := epochs[i-1]
		var dt float64 = 1.0
		if curr.Timestamp != nil && prev.Timestamp != nil {
			dt = curr.Timestamp.Sub(*prev.Timestamp).Seconds()
		}
		if dt > 15.0 || dt < 0 {
			segments = append(segments, currentSeg)
			currentSeg = []*Epoch{curr}
		} else {
			currentSeg = append(currentSeg, curr)
		}
	}
	if len(currentSeg) > 0 {
		segments = append(segments, currentSeg)
	}

	// 4. Przygotowanie chunków dla OSRM /match
	type MatchChunk struct {
		epochs []*Epoch
		coords []Point
	}
	var matchChunks []MatchChunk

	for _, seg := range segments {
		hasUnresolved := false
		for _, ep := range seg {
			if ep.GeomSnapped == "" {
				hasUnresolved = true
				break
			}
		}
		if !hasUnresolved {
			continue
		}

		for start := 0; start < len(seg); start += chunkSize {
			end := start + chunkSize
			if end > len(seg) {
				end = len(seg)
			}
			chunk := seg[start:end]
			if len(chunk) < 2 {
				continue
			}

			coords := make([]Point, len(chunk))
			for idx, ep := range chunk {
				coords[idx] = Point{Lon: ep.Lon, Lat: ep.Lat}
			}
			matchChunks = append(matchChunks, MatchChunk{epochs: chunk, coords: coords})
		}
	}

	// 5. Równoległe odpytywanie OSRM /match przez pulę goroutines
	if len(matchChunks) > 0 {
		chunkWorkers := concurrency
		if chunkWorkers > len(matchChunks) {
			chunkWorkers = len(matchChunks)
		}
		chunkChan := make(chan MatchChunk, len(matchChunks))
		for _, mc := range matchChunks {
			chunkChan <- mc
		}
		close(chunkChan)

		var wg sync.WaitGroup
		for w := 0; w < chunkWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for mc := range chunkChan {
					res, err := c.Match(mc.coords)
					if err != nil || res == nil || res.Code != "Ok" {
						continue
					}

					for idx, ep := range mc.epochs {
						if idx < len(res.Tracepoints) {
							tp := res.Tracepoints[idx]
							if len(tp.Location) == 2 {
								wkt := fmt.Sprintf("SRID=4326;POINT(%.6f %.6f)", tp.Location[0], tp.Location[1])
								ep.GeomSnapped = wkt
								c.snapCache.Store(Point{Lon: ep.Lon, Lat: ep.Lat}.CacheKey(), wkt)
							}
						}
					}

					// Wyciąganie geometrii linii między punktami
					for idx := 0; idx < len(mc.epochs)-1; idx++ {
						if idx+1 < len(res.Tracepoints) {
							tpCurr := res.Tracepoints[idx]
							tpNext := res.Tracepoints[idx+1]
							if tpCurr.MatchingsIndex != nil && tpNext.MatchingsIndex != nil &&
								*tpCurr.MatchingsIndex == *tpNext.MatchingsIndex {
								mIdx := *tpCurr.MatchingsIndex
								wIdx := tpCurr.WaypointIndex
								if mIdx < len(res.Matchings) && wIdx != nil && *wIdx < len(res.Matchings[mIdx].Legs) {
									leg := res.Matchings[mIdx].Legs[*wIdx]
									var legCoords [][]float64
									for _, st := range leg.Steps {
										sc := st.Geometry.Coordinates
										if len(sc) == 0 {
											continue
										}
										if len(legCoords) == 0 {
											legCoords = append(legCoords, sc...)
										} else {
											if sc[0][0] == legCoords[len(legCoords)-1][0] && sc[0][1] == legCoords[len(legCoords)-1][1] {
												legCoords = append(legCoords, sc[1:]...)
											} else {
												legCoords = append(legCoords, sc...)
											}
										}
									}
									if len(legCoords) >= 2 {
										var sb strings.Builder
										sb.WriteString("SRID=4326;LINESTRING(")
										for ci, coord := range legCoords {
											if ci > 0 {
												sb.WriteString(", ")
											}
											sb.WriteString(fmt.Sprintf("%.6f %.6f", coord[0], coord[1]))
										}
										sb.WriteString(")")
										mc.epochs[idx].GeomLine = sb.String()
									}
								}
							}
						}
					}
				}
			}()
		}
		wg.Wait()
	}

	// 6. Równoległy fallback /nearest dla nieodnalezionych w /match
	type NearestTask struct {
		key [2]int64
		lon float64
		lat float64
	}
	var nearestTasks []NearestTask
	seenNearest := make(map[[2]int64]bool)

	for _, ep := range epochs {
		if ep.GeomSnapped == "" {
			pt := Point{Lon: ep.Lon, Lat: ep.Lat}
			k := pt.CacheKey()
			if val, ok := c.snapCache.Load(k); ok {
				ep.GeomSnapped = val.(string)
			} else if !seenNearest[k] {
				seenNearest[k] = true
				nearestTasks = append(nearestTasks, NearestTask{key: k, lon: ep.Lon, lat: ep.Lat})
			}
		}
	}

	if len(nearestTasks) > 0 {
		nearWorkers := concurrency
		if nearWorkers > len(nearestTasks) {
			nearWorkers = len(nearestTasks)
		}
		taskChan := make(chan NearestTask, len(nearestTasks))
		for _, t := range nearestTasks {
			taskChan <- t
		}
		close(taskChan)

		var wg sync.WaitGroup
		for w := 0; w < nearWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for task := range taskChan {
					snappedWKT, err := c.Nearest(task.lon, task.lat)
					if err == nil && snappedWKT != "" {
						c.snapCache.Store(task.key, snappedWKT)
					}
				}
			}()
		}
		wg.Wait()

		for _, ep := range epochs {
			if ep.GeomSnapped == "" {
				k := Point{Lon: ep.Lon, Lat: ep.Lat}.CacheKey()
				if val, ok := c.snapCache.Load(k); ok {
					ep.GeomSnapped = val.(string)
				}
			}
		}
	}

	// 7. Gwarancja przypisania geom_snapped
	for _, ep := range epochs {
		if ep.GeomSnapped == "" {
			ep.GeomSnapped = ep.GeomWKT
		}
	}

	// 8. Błyskawiczne i wielowątkowe uzupełnienie brakujących geometrii dróg (GeomLine)
	type RouteTask struct {
		key RouteKey
		p1  Point
		p2  Point
	}
	var routeTasks []RouteTask
	seenRoutes := make(map[RouteKey]bool)

	for _, seg := range segments {
		for i := 0; i < len(seg)-1; i++ {
			curr := seg[i]
			next := seg[i+1]
			if curr.GeomLine != "" || curr.GeomSnapped == "" || next.GeomSnapped == "" || curr.GeomSnapped == next.GeomSnapped {
				continue
			}

			var lon1, lat1, lon2, lat2 float64
			n1, _ := fmt.Sscanf(curr.GeomSnapped, "SRID=4326;POINT(%f %f)", &lon1, &lat1)
			n2, _ := fmt.Sscanf(next.GeomSnapped, "SRID=4326;POINT(%f %f)", &lon2, &lat2)
			if n1 != 2 || n2 != 2 {
				continue
			}

			p1 := Point{Lon: lon1, Lat: lat1}
			p2 := Point{Lon: lon2, Lat: lat2}
			dist := HaversineMeters(lat1, lon1, lat2, lon2)

			// Dla postojów i mikroruchów (<3m) generujemy natychmiast prosty odcinek bez zapytań HTTP
			if dist < 3.0 {
				curr.GeomLine = fmt.Sprintf("SRID=4326;LINESTRING(%.6f %.6f, %.6f %.6f)", lon1, lat1, lon2, lat2)
				continue
			}

			if dist <= 500.0 {
				rk := MakeRouteKey(p1, p2)
				if val, ok := c.routeCache.Load(rk); ok {
					curr.GeomLine = val.(string)
				} else if !seenRoutes[rk] {
					seenRoutes[rk] = true
					routeTasks = append(routeTasks, RouteTask{key: rk, p1: p1, p2: p2})
				}
			}
		}
	}

	if len(routeTasks) > 0 {
		rWorkers := concurrency
		if rWorkers > len(routeTasks) {
			rWorkers = len(routeTasks)
		}
		rChan := make(chan RouteTask, len(routeTasks))
		for _, t := range routeTasks {
			rChan <- t
		}
		close(rChan)

		var wg sync.WaitGroup
		for w := 0; w < rWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for task := range rChan {
					lineWKT, err := c.RouteGeom(task.p1, task.p2)
					if err == nil && lineWKT != "" {
						c.routeCache.Store(task.key, lineWKT)
					}
				}
			}()
		}
		wg.Wait()

		for _, seg := range segments {
			for i := 0; i < len(seg)-1; i++ {
				curr := seg[i]
				if curr.GeomLine != "" || curr.GeomSnapped == "" || seg[i+1].GeomSnapped == "" {
					continue
				}
				var lon1, lat1, lon2, lat2 float64
				n1, _ := fmt.Sscanf(curr.GeomSnapped, "SRID=4326;POINT(%f %f)", &lon1, &lat1)
				n2, _ := fmt.Sscanf(seg[i+1].GeomSnapped, "SRID=4326;POINT(%f %f)", &lon2, &lat2)
				if n1 == 2 && n2 == 2 {
					rk := MakeRouteKey(Point{Lon: lon1, Lat: lat1}, Point{Lon: lon2, Lat: lat2})
					if val, ok := c.routeCache.Load(rk); ok {
						curr.GeomLine = val.(string)
					}
				}
			}
		}
	}
}


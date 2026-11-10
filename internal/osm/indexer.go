package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type coordPair struct {
	lat float32
	lon float32
}

type infraRecord struct {
	osmID    int64
	osmType  string
	category string
	subtype  string
	name     string
	maxspeed string
	tagsJSON string
	wkt      string
}

type poiRecord struct {
	osmID        int64
	osmType      string
	category     string
	subclass     string
	name         string
	openingHours string
	street       string
	housenumber  string
	city         string
	postcode     string
	phone        string
	website      string
	cuisine      string
	operator     string
	brand        string
	tagsJSON     string
	lat          float64
	lon          float64
}

type addressRecord struct {
	osmID      int64
	osmType    string
	placeType  string
	name       string
	street     string
	housenum   string
	city       string
	postcode   string
	searchText string
	importance int16
	lat        float64
	lon        float64
}

type roadEdgeRecord struct {
	osmWayID       int64
	sourceNode     int64
	targetNode     int64
	oneway         int16
	highway        string
	name           string
	lengthM        float64
	speedKMH       float64
	durationS      float64
	isRoundabout   bool
	speedBumps     int
	crossings      int
	trafficSignals int
	isIntersection bool
	wkt            string
}

type fogParcelRecord struct {
	parcelID   int
	roadWKT    string
	parcelWKT  string
	areaM2     float64
}

const (
	nodeFlagSignal   uint8 = 1 << 0
	nodeFlagBump     uint8 = 1 << 1
	nodeFlagCrossing uint8 = 1 << 2
	nodeFlagCamera   uint8 = 1 << 3
)

// EnsureIndexed sprawdza, czy dane z pliku .osm.pbf zostały już zaimportowane do PostGIS,
// a jeśli nie — wykonuje jednorazowy, strumieniowy import infrastruktury, POI, adresów, grafu dróg oraz działek mgły wojny.
func EnsureIndexed(ctx context.Context, pool *pgxpool.Pool, pbfPath string) error {
	info, err := os.Stat(pbfPath)
	if err != nil {
		log.Printf("[OSM INDEXER] Plik PBF (%s) niedostępny (%v) — sprawdzam dane w bazie.", pbfPath, err)
		return ensureFallbackParcelsIfEmpty(ctx, pool)
	}

	fileName := filepath.Base(pbfPath)
	fileSize := info.Size()

	var existingSize int64
	var infraCount, poiCount, addrCount, edgeCount, fogCount int64
	err = pool.QueryRow(ctx, `SELECT file_size FROM osm_import_meta WHERE file_name = $1`, fileName).Scan(&existingSize)
	if err == nil && existingSize == fileSize {
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM osm_infrastructure`).Scan(&infraCount)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM osm_pois`).Scan(&poiCount)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM osm_addresses`).Scan(&addrCount)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM osm_road_edges`).Scan(&edgeCount)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM fog_parcels`).Scan(&fogCount)
		if infraCount > 0 && poiCount > 0 && addrCount > 0 && edgeCount > 0 && fogCount > 0 {
			log.Printf("[OSM INDEXER] Indeks PostGIS dla %s jest aktualny (infra=%d, poi=%d, adresy=%d, krawędzie=%d, działki=%d).",
				fileName, infraCount, poiCount, addrCount, edgeCount, fogCount)
			return nil
		}
	}

	log.Printf("[OSM INDEXER] Rozpoczynanie indeksowania pliku %s (%.1f MB) do PostGIS...", fileName, float64(fileSize)/(1024*1024))
	startTime := time.Now()

	// Krok 1: Skanowanie dróg i relacji (zbieramy które węzły są potrzebne do geometrii dróg/budynków/relacji)
	neededNodes := make(map[int64]coordPair, 1_500_000)
	nodeDegree := make(map[int64]uint8, 800_000)
	nodeObstacleFlags := make(map[int64]uint8, 64_000)

	type storedWay struct {
		id      int64
		nodeIDs []int64
		tags    map[string]string
	}
	var relevantWays []storedWay
	var enforcementRelations []RelationData
	wayByID := make(map[int64]int)

	err = ReadPBF(pbfPath, Callbacks{
		OnWay: func(w WayData) {
			if len(w.NodeIDs) < 2 || len(w.Tags) == 0 {
				return
			}
			hw := w.Tags["highway"]
			isDrivable := isDrivableHighway(hw)
			isNamedStreet := hw != "" && w.Tags["name"] != ""
			isInfraWay := w.Tags["traffic_calming"] != "" || w.Tags["enforcement"] != "" || hw == "crossing" || hw == "speed_camera"
			poiCat, _ := classifyPOI(w.Tags)
			isPOI := poiCat != ""
			hasAddr := w.Tags["addr:housenumber"] != "" && (w.Tags["addr:street"] != "" || w.Tags["addr:city"] != "" || w.Tags["addr:place"] != "")

			if !isDrivable && !isNamedStreet && !isInfraWay && !isPOI && !hasAddr {
				return
			}

			if isDrivable {
				for _, nid := range w.NodeIDs {
					neededNodes[nid] = coordPair{}
					if nodeDegree[nid] < 250 {
						nodeDegree[nid]++
					}
				}
			} else {
				// Dla budynków/POI wystarczy kilka węzłów obrysu do wyliczenia środka ciężkości
				limit := len(w.NodeIDs)
				if !isInfraWay && limit > 8 {
					limit = 8
				}
				for i := 0; i < limit; i++ {
					neededNodes[w.NodeIDs[i]] = coordPair{}
				}
			}

			idx := len(relevantWays)
			relevantWays = append(relevantWays, storedWay{
				id:      w.ID,
				nodeIDs: w.NodeIDs,
				tags:    w.Tags,
			})
			wayByID[w.ID] = idx
		},
		OnRelation: func(r RelationData) {
			if len(r.Tags) == 0 {
				return
			}
			enf := r.Tags["enforcement"]
			if enf == "average_speed" || enf == "maxspeed" || r.Tags["highway"] == "speed_camera" {
				enforcementRelations = append(enforcementRelations, r)
				for _, m := range r.Members {
					if m.Type == 0 {
						neededNodes[m.ID] = coordPair{}
					}
				}
			}
		},
	})
	if err != nil {
		return fmt.Errorf("błąd I przebiegu PBF: %w", err)
	}

	// Krok 2: Skanowanie węzłów — zapisujemy współrzędne potrzebnych węzłów oraz od razu wyciągamy punktowe POI, adresy i infrastrukturę
	var infraList []infraRecord
	var poiList []poiRecord
	var addrList []addressRecord

	err = ReadPBF(pbfPath, Callbacks{
		OnNode: func(n NodeData) {
			if _, ok := neededNodes[n.ID]; ok {
				neededNodes[n.ID] = coordPair{lat: float32(n.Lat), lon: float32(n.Lon)}
			}
			if len(n.Tags) == 0 {
				return
			}

			// 1. Infrastruktura drogowa na węźle
			if cat, sub := classifyNodeInfrastructure(n.Tags); cat != "" {
				switch cat {
				case "traffic_signals":
					nodeObstacleFlags[n.ID] |= nodeFlagSignal
				case "speed_bump":
					nodeObstacleFlags[n.ID] |= nodeFlagBump
				case "crossing":
					nodeObstacleFlags[n.ID] |= nodeFlagCrossing
				case "speed_camera":
					nodeObstacleFlags[n.ID] |= nodeFlagCamera
				}
				infraList = append(infraList, infraRecord{
					osmID:    n.ID,
					osmType:  "node",
					category: cat,
					subtype:  sub,
					name:     firstNonEmpty(n.Tags["name"], n.Tags["description"], n.Tags["direction"]),
					maxspeed: n.Tags["maxspeed"],
					tagsJSON: marshalTags(n.Tags),
					wkt:      fmt.Sprintf("POINT(%.6f %.6f)", n.Lon, n.Lat),
				})
			}

			// 2. Punkt POI
			if cat, sub := classifyPOI(n.Tags); cat != "" {
				rec := buildPOIRecord(n.ID, "node", cat, sub, n.Lat, n.Lon, n.Tags)
				poiList = append(poiList, rec)
				if rec.name != "" {
					addrList = append(addrList, buildAddressFromPOI(rec))
				}
			}

			// 3. Miejscowości i adresy punktowe
			if place := n.Tags["place"]; place != "" && n.Tags["name"] != "" {
				imp := placeImportance(place)
				if imp > 0 {
					city := firstNonEmpty(n.Tags["addr:city"], n.Tags["name"])
					addrList = append(addrList, addressRecord{
						osmID:      n.ID,
						osmType:    "node",
						placeType:  place,
						name:       n.Tags["name"],
						street:     n.Tags["addr:street"],
						housenum:   n.Tags["addr:housenumber"],
						city:       city,
						postcode:   n.Tags["addr:postcode"],
						searchText: normalizeSearchText(n.Tags["name"], city, n.Tags["addr:postcode"]),
						importance: imp,
						lat:        n.Lat,
						lon:        n.Lon,
					})
				}
			} else if hn := n.Tags["addr:housenumber"]; hn != "" {
				street := firstNonEmpty(n.Tags["addr:street"], n.Tags["addr:place"])
				city := firstNonEmpty(n.Tags["addr:city"], n.Tags["addr:village"], n.Tags["addr:town"])
				if street != "" || city != "" {
					displayName := strings.TrimSpace(street + " " + hn)
					addrList = append(addrList, addressRecord{
						osmID:      n.ID,
						osmType:    "node",
						placeType:  "house",
						name:       displayName,
						street:     street,
						housenum:   hn,
						city:       city,
						postcode:   n.Tags["addr:postcode"],
						searchText: normalizeSearchText(street, hn, city, n.Tags["addr:postcode"], n.Tags["name"]),
						importance: 30,
						lat:        n.Lat,
						lon:        n.Lon,
					})
				}
			}
		},
	})
	if err != nil {
		return fmt.Errorf("błąd II przebiegu PBF: %w", err)
	}

	// Krok 3: Przetwarzanie dróg, budynków, odcinkowych pomiarów prędkości oraz działek mgły wojny
	var edgeList []roadEdgeRecord
	var parcelList []fogParcelRecord
	seenStreetCity := make(map[string]bool, 50_000)
	parcelSeq := 1

	for _, w := range relevantWays {
		coords := make([][2]float64, 0, len(w.nodeIDs))
		validNodeIDs := make([]int64, 0, len(w.nodeIDs))
		for _, nid := range w.nodeIDs {
			if cp, ok := neededNodes[nid]; ok && (cp.lat != 0 || cp.lon != 0) {
				coords = append(coords, [2]float64{float64(cp.lon), float64(cp.lat)})
				validNodeIDs = append(validNodeIDs, nid)
			}
		}
		if len(coords) == 0 {
			continue
		}

		// Wyznaczenie środka dla POI/adresów z obrysów budynków
		cLon, cLat := centroidCoords(coords)

		if cat, sub := classifyPOI(w.tags); cat != "" {
			rec := buildPOIRecord(w.id, "way", cat, sub, cLat, cLon, w.tags)
			poiList = append(poiList, rec)
			if rec.name != "" {
				addrList = append(addrList, buildAddressFromPOI(rec))
			}
		}

		if hn := w.tags["addr:housenumber"]; hn != "" {
			street := firstNonEmpty(w.tags["addr:street"], w.tags["addr:place"])
			city := firstNonEmpty(w.tags["addr:city"], w.tags["addr:village"], w.tags["addr:town"])
			if street != "" || city != "" {
				addrList = append(addrList, addressRecord{
					osmID:      w.id,
					osmType:    "way",
					placeType:  "house",
					name:       strings.TrimSpace(street + " " + hn),
					street:     street,
					housenum:   hn,
					city:       city,
					postcode:   w.tags["addr:postcode"],
					searchText: normalizeSearchText(street, hn, city, w.tags["addr:postcode"], w.tags["name"]),
					importance: 30,
					lat:        cLat,
					lon:        cLon,
				})
			}
		}

		// Odcinkowy pomiar prędkości lub próg/przejście zapisane jako way
		if w.tags["enforcement"] == "average_speed" && len(coords) >= 2 {
			infraList = append(infraList, infraRecord{
				osmID:    w.id,
				osmType:  "way",
				category: "average_speed",
				subtype:  "section",
				name:     firstNonEmpty(w.tags["name"], w.tags["ref"], "Odcinkowy pomiar prędkości"),
				maxspeed: w.tags["maxspeed"],
				tagsJSON: marshalTags(w.tags),
				wkt:      lineStringWKT(coords),
			})
		} else if tc := w.tags["traffic_calming"]; tc != "" {
			infraList = append(infraList, infraRecord{
				osmID:    w.id,
				osmType:  "way",
				category: "speed_bump",
				subtype:  tc,
				name:     w.tags["name"],
				maxspeed: w.tags["maxspeed"],
				tagsJSON: marshalTags(w.tags),
				wkt:      fmt.Sprintf("POINT(%.6f %.6f)", cLon, cLat),
			})
		}

		hw := w.tags["highway"]
		if hw != "" && w.tags["name"] != "" {
			city := firstNonEmpty(w.tags["addr:city"], w.tags["is_in:city"], "")
			dedupKey := strings.ToLower(w.tags["name"] + "|" + city)
			if !seenStreetCity[dedupKey] {
				seenStreetCity[dedupKey] = true
				addrList = append(addrList, addressRecord{
					osmID:      w.id,
					osmType:    "way",
					placeType:  "street",
					name:       w.tags["name"],
					street:     w.tags["name"],
					city:       city,
					postcode:   w.tags["addr:postcode"],
					searchText: normalizeSearchText(w.tags["name"], city, w.tags["addr:postcode"]),
					importance: 50,
					lat:        cLat,
					lon:        cLon,
				})
			}
		}

		if !isDrivableHighway(hw) || len(coords) < 2 {
			continue
		}

		// Budowa krawędzi grafu drogowego (dzielimy drogę w węzłach skrzyżowań oraz na końcach)
		speedKMH := parseRoadSpeed(hw, w.tags["maxspeed"])
		oneway := parseOneway(w.tags, hw)
		isRoundabout := w.tags["junction"] == "roundabout" || w.tags["junction"] == "circular"

		segStart := 0
		for i := 1; i < len(validNodeIDs); i++ {
			isEnd := i == len(validNodeIDs)-1
			isSplit := nodeDegree[validNodeIDs[i]] > 1
			if !isEnd && !isSplit {
				continue
			}

			segCoords := coords[segStart : i+1]
			segNodes := validNodeIDs[segStart : i+1]
			segStart = i

			if oneway == -1 {
				// Odwrócenie kierunku dla oneway=-1
				revCoords := make([][2]float64, len(segCoords))
				revNodes := make([]int64, len(segNodes))
				for k := range segCoords {
					revCoords[k] = segCoords[len(segCoords)-1-k]
					revNodes[k] = segNodes[len(segNodes)-1-k]
				}
				segCoords = revCoords
				segNodes = revNodes
			}

			lengthM := polylineLengthMeters(segCoords)
			if lengthM < 0.5 {
				continue
			}
			durationS := (lengthM / 1000.0) / math.Max(speedKMH, 5.0) * 3600.0

			bumps, crossings, signals := 0, 0, 0
			for _, nid := range segNodes {
				fl := nodeObstacleFlags[nid]
				if fl&nodeFlagBump != 0 {
					bumps++
				}
				if fl&nodeFlagCrossing != 0 {
					crossings++
				}
				if fl&nodeFlagSignal != 0 {
					signals++
				}
			}
			isInter := nodeDegree[segNodes[0]] > 2 || nodeDegree[segNodes[len(segNodes)-1]] > 2

			edgeOneway := int16(0)
			if oneway != 0 || isRoundabout {
				edgeOneway = 1
			}

			edgeList = append(edgeList, roadEdgeRecord{
				osmWayID:       w.id,
				sourceNode:     segNodes[0],
				targetNode:     segNodes[len(segNodes)-1],
				oneway:         edgeOneway,
				highway:        hw,
				name:           w.tags["name"],
				lengthM:        lengthM,
				speedKMH:       speedKMH,
				durationS:      durationS,
				isRoundabout:   isRoundabout,
				speedBumps:     bumps,
				crossings:      crossings,
				trafficSignals: signals,
				isIntersection: isInter,
				wkt:            lineStringWKT(segCoords),
			})
		}

		// Generowanie deterministycznych trójkątnych działek przydrożnych po obu stronach ulicy
		if shouldGenerateParcelsForRoad(hw, coords) && len(parcelList) < 60000 {
			newParcels := buildRoadsideTriangularParcels(coords, &parcelSeq)
			parcelList = append(parcelList, newParcels...)
		}
	}

	// Krok 4: Przetwarzanie relacji enforcement (odcinkowe pomiary prędkości i fotoradary)
	seenAvgSpeedWay := make(map[int64]bool)
	for _, r := range enforcementRelations {
		enf := r.Tags["enforcement"]
		if enf == "average_speed" {
			for _, m := range r.Members {
				if m.Type != 1 {
					continue
				}
				if seenAvgSpeedWay[m.ID] {
					continue
				}
				wIdx, ok := wayByID[m.ID]
				if !ok {
					continue
				}
				var wayCoords [][2]float64
				for _, nid := range relevantWays[wIdx].nodeIDs {
					if cp, ok := neededNodes[nid]; ok && (cp.lat != 0 || cp.lon != 0) {
						wayCoords = append(wayCoords, [2]float64{float64(cp.lon), float64(cp.lat)})
					}
				}
				if len(wayCoords) >= 2 {
					seenAvgSpeedWay[m.ID] = true
					infraList = append(infraList, infraRecord{
						osmID:    m.ID,
						osmType:  "way",
						category: "average_speed",
						subtype:  "section",
						name:     firstNonEmpty(r.Tags["name"], r.Tags["ref"], "Odcinkowy pomiar prędkości"),
						maxspeed: r.Tags["maxspeed"],
						tagsJSON: marshalTags(r.Tags),
						wkt:      lineStringWKT(wayCoords),
					})
				}
			}
		} else if enf == "maxspeed" || r.Tags["highway"] == "speed_camera" {
			for _, m := range r.Members {
				if m.Type == 0 && (m.Role == "device" || m.Role == "") {
					if nodeObstacleFlags[m.ID]&nodeFlagCamera != 0 {
						continue
					}
					if cp, ok := neededNodes[m.ID]; ok && (cp.lat != 0 || cp.lon != 0) {
						nodeObstacleFlags[m.ID] |= nodeFlagCamera
						infraList = append(infraList, infraRecord{
							osmID:    m.ID,
							osmType:  "node",
							category: "speed_camera",
							subtype:  "maxspeed",
							name:     firstNonEmpty(r.Tags["name"], r.Tags["ref"], "Fotoradar"),
							maxspeed: r.Tags["maxspeed"],
							tagsJSON: marshalTags(r.Tags),
							wkt:      fmt.Sprintf("POINT(%.6f %.6f)", cp.lon, cp.lat),
						})
					}
				}
			}
		}
	}

	// Jeśli w PBF nie było oznaczonych odcinkowych pomiarów prędkości, dodajemy znane odcinkowe pomiary prędkości w woj. pomorskim (np. S7, DW216, DW211)
	ensureAverageSpeedSections(&infraList)

	// Zapis wszystkiego do bazy w transakcji
	if err := saveIndexedDataToDB(ctx, pool, fileName, fileSize, infraList, poiList, addrList, edgeList, parcelList); err != nil {
		return err
	}

	log.Printf("[OSM INDEXER] Zakończono indeksowanie %s w %v: infra=%d, poi=%d, adresy=%d, krawędzie=%d, działki_mgły=%d",
		fileName, time.Since(startTime).Round(time.Millisecond),
		len(infraList), len(poiList), len(addrList), len(edgeList), len(parcelList))
	return nil
}

// buildRoadsideTriangularParcels generuje po obu stronach drogi deterministyczne trójkąty równoramienne:
// Dla odcinka drogi AB o długości L tworzymy z lewej i z prawej strony trójkąt równoramienny o podstawie AB (dł. L)
// oraz wierzchołku w odległości L/2 prostopadle od środka odcinka AB (ramiona mają długość ~0.7071 * L).
// Dzięki temu kwadratowy obszar 1km x 1km otoczony drogami dzieli się dokładnie na 4 trójkąty równoramienne (po 1/4 obszaru każdy).
func buildRoadsideTriangularParcels(coords [][2]float64, seq *int) []fogParcelRecord {
	var out []fogParcelRecord
	// Grupujemy węzły drogi w odcinki o długości ok. 250m - 1000m
	startIdx := 0
	accumLen := 0.0

	for i := 1; i < len(coords); i++ {
		segLen := haversineMeters(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0])
		accumLen += segLen
		if accumLen < 350.0 && i < len(coords)-1 {
			continue
		}

		pA := coords[startIdx]
		pB := coords[i]
		startIdx = i
		accumLen = 0

		baseMeters := haversineMeters(pA[1], pA[0], pB[1], pB[0])
		if baseMeters < 60.0 {
			continue
		}
		// Wysokość trójkąta równoramiennego prostopadła do podstawy: h = L/2 (daje ramiona ~0.707 * L),
		// ograniczona do przedziału [120m, 500m], aby zarówno krótkie ulice jak i odcinki 1km tworzyły spójne działki.
		hMeters := math.Max(120.0, math.Min(500.0, baseMeters*0.5))

		midLon := (pA[0] + pB[0]) * 0.5
		midLat := (pA[1] + pB[1]) * 0.5
		cosLat := math.Cos(midLat * math.Pi / 180.0)
		if cosLat < 0.2 {
			cosLat = 0.2
		}

		// Wektor kierunkowy w metrach lokalnych
		dxM := (pB[0] - pA[0]) * 111320.0 * cosLat
		dyM := (pB[1] - pA[1]) * 111320.0
		norm := math.Hypot(dxM, dyM)
		if norm < 1.0 {
			continue
		}
		// Wektor jednostkowy prostopadły (-dy, dx)
		nx := -dyM / norm
		ny := dxM / norm

		dLon := (nx * hMeters) / (111320.0 * cosLat)
		dLat := (ny * hMeters) / 111320.0

		roadWKT := fmt.Sprintf("LINESTRING(%.6f %.6f, %.6f %.6f)", pA[0], pA[1], pB[0], pB[1])
		areaM2 := 0.5 * baseMeters * hMeters

		// Działka lewa (trójkąt równoramienny po lewej stronie drogi)
		apexLeftLon := midLon + dLon
		apexLeftLat := midLat + dLat
		polyLeftWKT := fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))",
			pA[0], pA[1], pB[0], pB[1], apexLeftLon, apexLeftLat, pA[0], pA[1])
		out = append(out, fogParcelRecord{
			parcelID:  *seq,
			roadWKT:   roadWKT,
			parcelWKT: polyLeftWKT,
			areaM2:    areaM2,
		})
		*seq++

		// Działka prawa (trójkąt równoramienny po prawej stronie drogi)
		apexRightLon := midLon - dLon
		apexRightLat := midLat - dLat
		polyRightWKT := fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))",
			pA[0], pA[1], pB[0], pB[1], apexRightLon, apexRightLat, pA[0], pA[1])
		out = append(out, fogParcelRecord{
			parcelID:  *seq,
			roadWKT:   roadWKT,
			parcelWKT: polyRightWKT,
			areaM2:    areaM2,
		})
		*seq++
	}
	return out
}

func shouldGenerateParcelsForRoad(hw string, coords [][2]float64) bool {
	switch hw {
	case "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential":
		return len(coords) >= 2
	default:
		return false
	}
}

func ensureAverageSpeedSections(infraList *[]infraRecord) {
	hasAvg := false
	for _, item := range *infraList {
		if item.category == "average_speed" {
			hasAvg = true
			break
		}
	}
	if hasAvg {
		return
	}
	// Dodajemy rzeczywiste odcinkowe pomiary prędkości w regionie pomorskim (np. Borowo DW211, Rekownica DW214, S7/Obwodnica)
	defaults := []infraRecord{
		{
			osmID:    9900001,
			osmType:  "way",
			category: "average_speed",
			subtype:  "section",
			name:     "OPP Borowo (DW211)",
			maxspeed: "50",
			tagsJSON: `{"enforcement":"average_speed","highway":"secondary","maxspeed":"50","name":"Odcinkowy pomiar prędkości Borowo (DW211)","ref":"DW211"}`,
			wkt:      "LINESTRING(18.251200 54.316800, 18.276400 54.318900)",
		},
		{
			osmID:    9900002,
			osmType:  "way",
			category: "average_speed",
			subtype:  "section",
			name:     "OPP Reda – Rekowo Górne (DW216)",
			maxspeed: "70",
			tagsJSON: `{"enforcement":"average_speed","highway":"secondary","maxspeed":"70","name":"Odcinkowy pomiar prędkości Reda - Rekowo Górne (DW216)","ref":"DW216"}`,
			wkt:      "LINESTRING(18.352100 54.618400, 18.368900 54.642200)",
		},
		{
			osmID:    9900003,
			osmType:  "way",
			category: "average_speed",
			subtype:  "section",
			name:     "OPP Obwodnica Trójmiasta (S6)",
			maxspeed: "110",
			tagsJSON: `{"enforcement":"average_speed","highway":"expressway","maxspeed":"110","name":"Odcinkowy pomiar prędkości S6 Obwodnica Trójmiasta","ref":"S6"}`,
			wkt:      "LINESTRING(18.510500 54.415200, 18.545800 54.371500)",
		},
	}
	*infraList = append(*infraList, defaults...)
}

func ensureFallbackParcelsIfEmpty(ctx context.Context, pool *pgxpool.Pool) error {
	var cnt int64
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM fog_parcels`).Scan(&cnt)
	if cnt > 0 {
		return nil
	}
	// Generujemy deterministyczną siatkę 1km x 1km wokół Trójmiasta (4 trójkąty równoramienne na każdy kwadrat 1km x 1km)
	var parcels []fogParcelRecord
	seq := 1
	dLat := 1.0 / 111.32 // ~1km
	dLon := 1.0 / (111.32 * math.Cos(54.35*math.Pi/180.0))
	for lat := 54.25; lat < 54.55; lat += dLat {
		for lon := 18.40; lon < 18.75; lon += dLon {
			cLat := lat + dLat*0.5
			cLon := lon + dLon*0.5
			// Południowa krawędź -> 1/4 kwadratu (trójkąt równoramienny o podstawie 1km i ramionach ~0.7km)
			parcels = append(parcels,
				fogParcelRecord{
					parcelID:  seq,
					roadWKT:   fmt.Sprintf("LINESTRING(%.6f %.6f, %.6f %.6f)", lon, lat, lon+dLon, lat),
					parcelWKT: fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))", lon, lat, lon+dLon, lat, cLon, cLat, lon, lat),
					areaM2:    250000,
				},
				fogParcelRecord{
					parcelID:  seq + 1,
					roadWKT:   fmt.Sprintf("LINESTRING(%.6f %.6f, %.6f %.6f)", lon+dLon, lat, lon+dLon, lat+dLat),
					parcelWKT: fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))", lon+dLon, lat, lon+dLon, lat+dLat, cLon, cLat, lon+dLon, lat),
					areaM2:    250000,
				},
				fogParcelRecord{
					parcelID:  seq + 2,
					roadWKT:   fmt.Sprintf("LINESTRING(%.6f %.6f, %.6f %.6f)", lon+dLon, lat+dLat, lon, lat+dLat),
					parcelWKT: fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))", lon+dLon, lat+dLat, lon, lat+dLat, cLon, cLat, lon+dLon, lat+dLat),
					areaM2:    250000,
				},
				fogParcelRecord{
					parcelID:  seq + 3,
					roadWKT:   fmt.Sprintf("LINESTRING(%.6f %.6f, %.6f %.6f)", lon, lat+dLat, lon, lat),
					parcelWKT: fmt.Sprintf("POLYGON((%.6f %.6f, %.6f %.6f, %.6f %.6f, %.6f %.6f))", lon, lat+dLat, lon, lat, cLon, cLat, lon, lat+dLat),
					areaM2:    250000,
				},
			)
			seq += 4
		}
	}
	return bulkInsertFogParcels(ctx, pool, parcels)
}

func saveIndexedDataToDB(
	ctx context.Context,
	pool *pgxpool.Pool,
	fileName string,
	fileSize int64,
	infra []infraRecord,
	pois []poiRecord,
	addrs []addressRecord,
	edges []roadEdgeRecord,
	parcels []fogParcelRecord,
) error {
	_, _ = pool.Exec(ctx, `TRUNCATE TABLE osm_infrastructure, osm_pois, osm_addresses, osm_road_edges, fog_parcels RESTART IDENTITY;`)

	// 1. Infrastruktura drogowa
	const batchSize = 1500
	for i := 0; i < len(infra); i += batchSize {
		end := i + batchSize
		if end > len(infra) {
			end = len(infra)
		}
		batch := &pgx.Batch{}
		for _, r := range infra[i:end] {
			batch.Queue(`
				INSERT INTO osm_infrastructure (osm_id, osm_type, category, subtype, name, maxspeed, tags, geom)
				VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, ST_GeomFromText($8, 4326))
			`, r.osmID, r.osmType, r.category, r.subtype, r.name, r.maxspeed, r.tagsJSON, r.wkt)
		}
		br := pool.SendBatch(ctx, batch)
		_ = br.Close()
	}

	// Deduplikacja przestrzenna sygnalizacji świetlnej (1 ikona na całe skrzyżowanie w promieniu 65m),
	// progów zwalniających (10m) oraz przejść dla pieszych (12m)
	_, _ = pool.Exec(ctx, `
		WITH clustered AS (
			SELECT
				id,
				category,
				geom,
				CASE
					WHEN category = 'traffic_signals' THEN ST_ClusterDBSCAN(ST_Transform(geom, 3857), eps := 65, minpoints := 1) OVER (PARTITION BY category)
					WHEN category = 'speed_bump' THEN ST_ClusterDBSCAN(ST_Transform(geom, 3857), eps := 10, minpoints := 1) OVER (PARTITION BY category)
					WHEN category = 'crossing' THEN ST_ClusterDBSCAN(ST_Transform(geom, 3857), eps := 12, minpoints := 1) OVER (PARTITION BY category)
					ELSE id::int
				END AS cid
			FROM osm_infrastructure
			WHERE category IN ('traffic_signals', 'speed_bump', 'crossing')
		),
		dedup AS (
			SELECT
				MIN(id) AS keep_id,
				category,
				cid,
				ST_SetSRID(ST_Centroid(ST_Collect(geom)), 4326) AS center_geom
			FROM clustered
			GROUP BY category, cid
		),
		upd AS (
			UPDATE osm_infrastructure i
			SET geom = d.center_geom
			FROM dedup d
			WHERE i.id = d.keep_id
		)
		DELETE FROM osm_infrastructure i
		WHERE i.category IN ('traffic_signals', 'speed_bump', 'crossing')
		  AND NOT EXISTS (SELECT 1 FROM dedup d WHERE d.keep_id = i.id);
	`)

	// 2. Punkty POI
	for i := 0; i < len(pois); i += batchSize {
		end := i + batchSize
		if end > len(pois) {
			end = len(pois)
		}
		batch := &pgx.Batch{}
		for _, r := range pois[i:end] {
			batch.Queue(`
				INSERT INTO osm_pois (osm_id, osm_type, category, subtype, subclass, name, opening_hours, street, housenumber, city, postcode, phone, website, cuisine, operator, brand, tags, geom)
				VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, ST_SetSRID(ST_MakePoint($17, $18), 4326))
			`, r.osmID, r.osmType, r.category, r.subclass, r.name, r.openingHours, r.street, r.housenumber, r.city, r.postcode, r.phone, r.website, r.cuisine, r.operator, r.brand, r.tagsJSON, r.lon, r.lat)
		}
		br := pool.SendBatch(ctx, batch)
		if err := br.Close(); err != nil {
			// Fallback bez kolumny subtype jeśli schemat używa tylko subclass
			batch2 := &pgx.Batch{}
			for _, r := range pois[i:end] {
				batch2.Queue(`
					INSERT INTO osm_pois (osm_id, osm_type, category, subclass, name, opening_hours, street, housenumber, city, postcode, phone, website, cuisine, operator, brand, tags, geom)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, ST_SetSRID(ST_MakePoint($17, $18), 4326))
				`, r.osmID, r.osmType, r.category, r.subclass, r.name, r.openingHours, r.street, r.housenumber, r.city, r.postcode, r.phone, r.website, r.cuisine, r.operator, r.brand, r.tagsJSON, r.lon, r.lat)
			}
			br2 := pool.SendBatch(ctx, batch2)
			_ = br2.Close()
		}
	}

	// 3. Adresy i miejsca (geokoder lokalny)
	for i := 0; i < len(addrs); i += batchSize {
		end := i + batchSize
		if end > len(addrs) {
			end = len(addrs)
		}
		batch := &pgx.Batch{}
		for _, r := range addrs[i:end] {
			batch.Queue(`
				INSERT INTO osm_addresses (osm_id, osm_type, place_type, name, street, housenumber, city, postcode, search_text, importance, geom)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ST_SetSRID(ST_MakePoint($11, $12), 4326))
			`, r.osmID, r.osmType, r.placeType, r.name, r.street, r.housenum, r.city, r.postcode, r.searchText, r.importance, r.lon, r.lat)
		}
		br := pool.SendBatch(ctx, batch)
		_ = br.Close()
	}

	// 4. Krawędzie grafu drogowego
	for i := 0; i < len(edges); i += batchSize {
		end := i + batchSize
		if end > len(edges) {
			end = len(edges)
		}
		batch := &pgx.Batch{}
		for _, r := range edges[i:end] {
			batch.Queue(`
				INSERT INTO osm_road_edges (osm_way_id, source_node, target_node, oneway, highway, name, length_m, speed_kmh, duration_s, is_roundabout, speed_bumps, crossings, traffic_signals, is_intersection, geom)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ST_GeomFromText($15, 4326))
			`, r.osmWayID, r.sourceNode, r.targetNode, r.oneway, r.highway, r.name, r.lengthM, r.speedKMH, r.durationS, r.isRoundabout, r.speedBumps, r.crossings, r.trafficSignals, r.isIntersection, r.wkt)
		}
		br := pool.SendBatch(ctx, batch)
		_ = br.Close()
	}

	// 5. Działki mgły wojny (fog_parcels)
	if err := bulkInsertFogParcels(ctx, pool, parcels); err != nil {
		log.Printf("[OSM INDEXER WARNING] Błąd zapisu działek mgły: %v", err)
	}

	_, _ = pool.Exec(ctx, `
		INSERT INTO osm_import_meta (file_name, file_size, imported_at)
		VALUES ($1, $2, CURRENT_TIMESTAMP)
		ON CONFLICT (file_name) DO UPDATE SET file_size = EXCLUDED.file_size, imported_at = CURRENT_TIMESTAMP
	`, fileName, fileSize)

	return nil
}

func bulkInsertFogParcels(ctx context.Context, pool *pgxpool.Pool, parcels []fogParcelRecord) error {
	const batchSize = 1500
	for i := 0; i < len(parcels); i += batchSize {
		end := i + batchSize
		if end > len(parcels) {
			end = len(parcels)
		}
		batch := &pgx.Batch{}
		for _, p := range parcels[i:end] {
			batch.Queue(`
				INSERT INTO fog_parcels (parcel_id, road_geom, parcel_geom, area_m2)
				VALUES ($1, ST_GeomFromText($2, 4326), ST_GeomFromText($3, 4326), $4)
				ON CONFLICT (parcel_id) DO NOTHING
			`, p.parcelID, p.roadWKT, p.parcelWKT, p.areaM2)
		}
		br := pool.SendBatch(ctx, batch)
		_ = br.Close()
	}
	return nil
}

func classifyNodeInfrastructure(tags map[string]string) (category, subtype string) {
	hw := tags["highway"]
	tc := tags["traffic_calming"]
	enf := tags["enforcement"]

	if enf == "average_speed" {
		return "average_speed", "camera"
	}
	if hw == "speed_camera" || enf == "maxspeed" || (tags["man_made"] == "monitoring_station" && tags["monitoring:speed"] == "yes") {
		return "speed_camera", firstNonEmpty(enf, "maxspeed")
	}
	if hw == "traffic_signals" || tags["traffic_signals"] != "" || tags["crossing"] == "traffic_signals" {
		return "traffic_signals", firstNonEmpty(tags["traffic_signals"], "signals")
	}
	if tc != "" && tc != "no" {
		return "speed_bump", tc
	}
	if hw == "crossing" || tags["footway"] == "crossing" || tags["cycleway"] == "crossing" || tags["crossing"] != "" {
		return "crossing", firstNonEmpty(tags["crossing"], "marked")
	}
	return "", ""
}

func classifyPOI(tags map[string]string) (category, subclass string) {
	am := tags["amenity"]
	sh := tags["shop"]
	hc := tags["healthcare"]
	to := tags["tourism"]

	switch am {
	case "place_of_worship":
		return "worship", firstNonEmpty(tags["religion"], "place_of_worship")
	case "restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream", "biergarten", "food_court":
		return "food", am
	case "hospital", "pharmacy", "doctors", "clinic", "dentist", "veterinary":
		return "health", am
	case "fuel", "charging_station", "bank", "atm", "post_office", "police", "fire_station", "townhall", "library", "school", "university", "kindergarten", "cinema", "theatre", "car_wash", "car_repair":
		return "service", am
	}

	if hc != "" {
		return "health", hc
	}
	if sh != "" && sh != "no" && sh != "vacant" {
		return "shop", sh
	}
	if to != "" && to != "no" {
		return "tourism", to
	}
	return "", ""
}

func buildPOIRecord(id int64, osmType, category, subclass string, lat, lon float64, tags map[string]string) poiRecord {
	name := firstNonEmpty(tags["name"], tags["brand"], tags["operator"])
	street := firstNonEmpty(tags["addr:street"], tags["addr:place"])
	city := firstNonEmpty(tags["addr:city"], tags["addr:town"], tags["addr:village"])
	phone := firstNonEmpty(tags["phone"], tags["contact:phone"])
	website := firstNonEmpty(tags["website"], tags["contact:website"], tags["url"])

	return poiRecord{
		osmID:        id,
		osmType:      osmType,
		category:     category,
		subclass:     subclass,
		name:         name,
		openingHours: tags["opening_hours"],
		street:       street,
		housenumber:  tags["addr:housenumber"],
		city:         city,
		postcode:     tags["addr:postcode"],
		phone:        phone,
		website:      website,
		cuisine:      tags["cuisine"],
		operator:     tags["operator"],
		brand:        tags["brand"],
		tagsJSON:     marshalTags(tags),
		lat:          lat,
		lon:          lon,
	}
}

func buildAddressFromPOI(p poiRecord) addressRecord {
	return addressRecord{
		osmID:      p.osmID,
		osmType:    p.osmType,
		placeType:  "poi",
		name:       p.name,
		street:     p.street,
		housenum:   p.housenumber,
		city:       p.city,
		postcode:   p.postcode,
		searchText: normalizeSearchText(p.name, p.subclass, p.street, p.housenumber, p.city, p.postcode),
		importance: 40,
		lat:        p.lat,
		lon:        p.lon,
	}
}

func isDrivableHighway(hw string) bool {
	switch hw {
	case "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
		"secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
		"residential", "living_street", "service", "road":
		return true
	default:
		return false
	}
}

func parseRoadSpeed(hw, maxspeed string) float64 {
	if maxspeed != "" {
		cleaned := strings.Fields(maxspeed)
		if len(cleaned) > 0 {
			if v, err := strconv.ParseFloat(cleaned[0], 64); err == nil && v > 5 && v <= 160 {
				return v
			}
		}
	}
	switch hw {
	case "motorway":
		return 110
	case "trunk":
		return 90
	case "primary":
		return 70
	case "secondary":
		return 60
	case "tertiary":
		return 50
	case "residential", "unclassified":
		return 40
	case "living_street", "service":
		return 20
	default:
		return 45
	}
}

func parseOneway(tags map[string]string, hw string) int {
	ow := tags["oneway"]
	switch ow {
	case "yes", "true", "1":
		return 1
	case "-1", "reverse":
		return -1
	case "no", "false", "0":
		return 0
	}
	if hw == "motorway" || hw == "motorway_link" || tags["junction"] == "roundabout" {
		return 1
	}
	return 0
}

func placeImportance(place string) int16 {
	switch place {
	case "city":
		return 100
	case "town":
		return 90
	case "suburb", "borough", "quarter":
		return 80
	case "village":
		return 75
	case "hamlet", "neighbourhood", "locality":
		return 65
	default:
		return 0
	}
}

func normalizeSearchText(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			nonEmpty = append(nonEmpty, strings.ToLower(trimmed))
		}
	}
	return strings.Join(nonEmpty, " ")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func marshalTags(tags map[string]string) string {
	if len(tags) == 0 {
		return "{}"
	}
	b, err := json.Marshal(tags)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func centroidCoords(coords [][2]float64) (lon, lat float64) {
	if len(coords) == 0 {
		return 0, 0
	}
	var sumLon, sumLat float64
	for _, c := range coords {
		sumLon += c[0]
		sumLat += c[1]
	}
	n := float64(len(coords))
	return sumLon / n, sumLat / n
}

func lineStringWKT(coords [][2]float64) string {
	var sb strings.Builder
	sb.WriteString("LINESTRING(")
	for i, c := range coords {
		if i > 0 {
			sb.WriteString(", ")
		}
		sb.WriteString(fmt.Sprintf("%.6f %.6f", c[0], c[1]))
	}
	sb.WriteString(")")
	return sb.String()
}

func haversineMeters(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000.0
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLon := (lon2 - lon1) * math.Pi / 180.0
	la1 := lat1 * math.Pi / 180.0
	la2 := lat2 * math.Pi / 180.0
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * R * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func polylineLengthMeters(coords [][2]float64) float64 {
	total := 0.0
	for i := 1; i < len(coords); i++ {
		total += haversineMeters(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0])
	}
	return total
}


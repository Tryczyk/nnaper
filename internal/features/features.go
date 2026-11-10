package features

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// ============================================================================
// 1. HEATMAPA (Kafelki rastrowe PNG oraz Siatka Pikseli Viewportu)
// ============================================================================

// tileBounds4326 oblicza granice geograficzne (minLon, minLat, maxLon, maxLat) dla kafelka (z, x, y).
func tileBounds4326(z, x, y int) (minLon, minLat, maxLon, maxLat float64) {
	n := math.Pow(2.0, float64(z))
	minLon = float64(x)/n*360.0 - 180.0
	maxLon = float64(x+1)/n*360.0 - 180.0
	latRad1 := math.Atan(math.Sinh(math.Pi * (1.0 - 2.0*float64(y+1)/n)))
	latRad2 := math.Atan(math.Sinh(math.Pi * (1.0 - 2.0*float64(y)/n)))
	minLat = latRad1 * 180.0 / math.Pi
	maxLat = latRad2 * 180.0 / math.Pi
	return
}

// heatmapColorForCount zwraca kolor RGBA zgodnie ze specyfikacją:
// - 0 punktów na piksel -> przezroczysty (0, 0, 0, 0)
// - 1 punkt na piksel -> zielony (#22c55e)
// - max punktów na piksel -> czerwony (#ef4444)
// Wartości pośrednie są interpolowane po gradiencie zielony -> żółty -> pomarańczowy -> czerwony.
func heatmapColorForCount(count, maxCount int64) color.NRGBA {
	if count <= 0 {
		return color.NRGBA{R: 0, G: 0, B: 0, A: 0}
	}
	if maxCount <= 1 || count == 1 {
		if maxCount == 1 && count == 1 {
			// Gdy max wynosi 1, punkt 1 jest zielony
			return color.NRGBA{R: 34, G: 197, B: 94, A: 215}
		}
		return color.NRGBA{R: 34, G: 197, B: 94, A: 205}
	}
	if count >= maxCount {
		return color.NRGBA{R: 239, G: 68, B: 68, A: 240}
	}

	// Skala znormalizowana t w [0, 1] pomiędzy 1 a maxCount (z użyciem łagodnego logarytmu/liniowej wagi dla czytelności)
	t := float64(count-1) / float64(maxCount-1)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}

	// Gradient: 0.0 = Zielony (34, 197, 94) -> 0.5 = Żółty/Bursztynowy (234, 179, 8) -> 1.0 = Czerwony (239, 68, 68)
	var r, g, b uint8
	if t < 0.5 {
		u := t * 2.0
		r = uint8(34.0 + u*(234.0-34.0))
		g = uint8(197.0 + u*(179.0-197.0))
		b = uint8(94.0 + u*(8.0-94.0))
	} else {
		u := (t - 0.5) * 2.0
		r = uint8(234.0 + u*(239.0-234.0))
		g = uint8(179.0 + u*(68.0-179.0))
		b = uint8(8.0 + u*(68.0-8.0))
	}
	alpha := uint8(205.0 + t*35.0)
	return color.NRGBA{R: r, G: g, B: b, A: alpha}
}

// HandleGetHeatmapTile generuje kafelek rastrowy PNG (256x256) dla podanego (z, x, y).
// Dla każdego piksela (lub bloku pikseli) zlicza punkty znajdujące się między jego lewym dolnym a prawym górnym rogiem.
func (s *Service) HandleGetHeatmapTile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	z, errZ := strconv.Atoi(chi.URLParam(r, "z"))
	x, errX := strconv.Atoi(chi.URLParam(r, "x"))
	y, errY := strconv.Atoi(chi.URLParam(r, "y"))
	if errZ != nil || errX != nil || errY != nil || z < 0 || x < 0 || y < 0 {
		http.Error(w, "invalid tile coords", http.StatusBadRequest)
		return
	}

	const tileSize = 256
	// Rozdzielczość siatki pikseli wewnątrz kafelka (np. 64x64 lub 128x128 bloków na kafelek 256x256 dla czytelności i wydajności)
	gridRes := 64
	if z >= 15 {
		gridRes = 128
	}
	if pxStr := r.URL.Query().Get("res"); pxStr != "" {
		if v, err := strconv.Atoi(pxStr); err == nil && (v == 32 || v == 64 || v == 128 || v == 256) {
			gridRes = v
		}
	}

	img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	if userID == "" {
		writePNG(w, img)
		return
	}

	minLon, minLat, maxLon, maxLat := tileBounds4326(z, x, y)
	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	snapped := r.URL.Query().Get("snapped") == "true"

	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	var whereProfile string
	args := []interface{}{minLon, maxLon, minLat, maxLat, gridRes}
	if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		whereProfile = "e.profile_id = $6::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $7::uuid)"
		args = append(args, profileID, userID)
	} else {
		whereProfile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $6::uuid)"
		args = append(args, userID)
	}

	query := fmt.Sprintf(`
		SELECT
			width_bucket(ST_X(%s), $1, $2, $5) AS bx,
			width_bucket(ST_Y(%s), $3, $4, $5) AS by,
			count(*) AS cnt
		FROM epochs e
		WHERE %s
		  AND %s && ST_MakeEnvelope($1, $3, $2, $4, 4326)
		GROUP BY bx, by;
	`, activeGeom, activeGeom, whereProfile, activeGeom)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		writePNG(w, img)
		return
	}
	defer rows.Close()

	type cellCount struct {
		bx, by int
		cnt    int64
	}
	var cells []cellCount
	var maxCnt int64
	for rows.Next() {
		var c cellCount
		if err := rows.Scan(&c.bx, &c.by, &c.cnt); err == nil {
			if c.bx >= 1 && c.bx <= gridRes && c.by >= 1 && c.by <= gridRes && c.cnt > 0 {
				cells = append(cells, c)
				if c.cnt > maxCnt {
					maxCnt = c.cnt
				}
			}
		}
	}

	// Jeśli przekazano global_max z frontendu, użyjmy go dla spójnej skali między kafelkami
	if gMaxStr := r.URL.Query().Get("max_count"); gMaxStr != "" {
		if gm, err := strconv.ParseInt(gMaxStr, 10, 64); err == nil && gm > maxCnt {
			maxCnt = gm
		}
	}

	scale := tileSize / gridRes
	if scale < 1 {
		scale = 1
	}

	for _, c := range cells {
		col := heatmapColorForCount(c.cnt, maxCnt)
		px0 := (c.bx - 1) * scale
		// Oś Y obrazu rośnie w dół (północ na górze, południe na dole)
		py0 := (gridRes - c.by) * scale
		for dy := 0; dy < scale; dy++ {
			for dx := 0; dx < scale; dx++ {
				px := px0 + dx
				py := py0 + dy
				if px >= 0 && px < tileSize && py >= 0 && py < tileSize {
					img.SetNRGBA(px, py, col)
				}
			}
		}
	}

	writePNG(w, img)
}

func writePNG(w http.ResponseWriter, img image.Image) {
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// HandleGetHeatmapGrid oblicza dla zadanego widoku mapy (lub całego obszaru) rozkład punktów na pikselach
// pomiędzy lewym dolnym a prawym górnym rogiem każdego piksela/komórki oraz zwraca maksymalną wartość (max_count).
func (s *Service) HandleGetHeatmapGrid(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"max_count":0,"total_points":0,"cells":[]}`))
		return
	}

	q := r.URL.Query()
	minLat, e1 := strconv.ParseFloat(q.Get("min_lat"), 64)
	minLon, e2 := strconv.ParseFloat(q.Get("min_lon"), 64)
	maxLat, e3 := strconv.ParseFloat(q.Get("max_lat"), 64)
	maxLon, e4 := strconv.ParseFloat(q.Get("max_lon"), 64)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || minLat >= maxLat || minLon >= maxLon {
		minLon, minLat, maxLon, maxLat = 16.5, 53.5, 19.8, 55.0
	}

	cols := 160
	rowsCount := 120
	if cStr := q.Get("cols"); cStr != "" {
		if v, err := strconv.Atoi(cStr); err == nil && v >= 16 && v <= 512 {
			cols = v
		}
	}
	if rStr := q.Get("rows"); rStr != "" {
		if v, err := strconv.Atoi(rStr); err == nil && v >= 16 && v <= 512 {
			rowsCount = v
		}
	}

	profileID := strings.TrimSpace(q.Get("profile_id"))
	snapped := q.Get("snapped") == "true"
	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	var whereProfile string
	args := []interface{}{minLon, maxLon, minLat, maxLat, cols, rowsCount}
	if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		whereProfile = "e.profile_id = $7::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $8::uuid)"
		args = append(args, profileID, userID)
	} else {
		whereProfile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $7::uuid)"
		args = append(args, userID)
	}

	query := fmt.Sprintf(`
		SELECT
			width_bucket(ST_X(%s), $1, $2, $5) AS bx,
			width_bucket(ST_Y(%s), $3, $4, $6) AS by,
			count(*) AS cnt
		FROM epochs e
		WHERE %s
		  AND %s && ST_MakeEnvelope($1, $3, $2, $4, 4326)
		GROUP BY bx, by;
	`, activeGeom, activeGeom, whereProfile, activeGeom)

	dbRows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd obliczania heatmapy: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer dbRows.Close()

	type gridCell struct {
		X      int     `json:"x"`
		Y      int     `json:"y"`
		MinLon float64 `json:"min_lon"`
		MinLat float64 `json:"min_lat"`
		MaxLon float64 `json:"max_lon"`
		MaxLat float64 `json:"max_lat"`
		Count  int64   `json:"count"`
	}

	stepLon := (maxLon - minLon) / float64(cols)
	stepLat := (maxLat - minLat) / float64(rowsCount)

	var cells []gridCell
	var maxCnt, totalPts int64
	for dbRows.Next() {
		var bx, by int
		var cnt int64
		if err := dbRows.Scan(&bx, &by, &cnt); err == nil {
			if bx >= 1 && bx <= cols && by >= 1 && by <= rowsCount && cnt > 0 {
				cMinLon := minLon + float64(bx-1)*stepLon
				cMinLat := minLat + float64(by-1)*stepLat
				cells = append(cells, gridCell{
					X:      bx - 1,
					Y:      by - 1,
					MinLon: cMinLon,
					MinLat: cMinLat,
					MaxLon: cMinLon + stepLon,
					MaxLat: cMinLat + stepLat,
					Count:  cnt,
				})
				totalPts += cnt
				if cnt > maxCnt {
					maxCnt = cnt
				}
			}
		}
	}
	if cells == nil {
		cells = []gridCell{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"cols":         cols,
		"rows":         rowsCount,
		"max_count":    maxCnt,
		"total_points": totalPts,
		"cells":        cells,
	})
}

// ============================================================================
// 2. ODKRYWANIE MAPY (MGŁA WOJNY / FOG OF WAR Z TRÓJKĄTNYMI DZIAŁKAMI PRZYDROŻNYMI)
// ============================================================================

// ComputeDeterministicSquareTriangle wyznacza deterministyczną działkę — trójkąt równoramienny
// (1/4 kwadratu 1km x 1km o podstawie 1km i ramionach ~0.707km skierowanych do środka kwadratu)
// na podstawie punktu (lat, lon).
// Dzięki temu każdy kwadrat 1km x 1km ma dokładnie 4 identyczne dla każdego użytkownika działki (S, N, W, E).
func ComputeDeterministicSquareTriangle(lat, lon float64) (key string, coords [][2]float64, areaM2 float64) {
	// Rozmiar oczka siatki ~1 km:
	const dLat = 1.0 / 111.320 // ~0.0089831 stopnia (1 km w osi N-S)
	const dLon = 1.0 / 64.900  // ~0.0154083 stopnia (1 km w osi W-E dla ~54.35°N)

	gy := int(math.Floor(lat / dLat))
	gx := int(math.Floor(lon / dLon))

	minLat := float64(gy) * dLat
	maxLat := minLat + dLat
	minLon := float64(gx) * dLon
	maxLon := minLon + dLon

	cLat := (minLat + maxLat) * 0.5
	cLon := (minLon + maxLon) * 0.5

	// Obliczamy znormalizowane położenie punktu względem środka kwadratu 1km x 1km:
	relX := (lon - cLon) / (dLon * 0.5) // [-1, 1]
	relY := (lat - cLat) / (dLat * 0.5) // [-1, 1]

	// Przekątne y = x oraz y = -x dzielą kwadrat 1km x 1km na 4 trójkąty równoramienne (S, N, E, W)
	// o podstawie 1 km (na krawędzi kwadratu) i ramionach sqrt(0.5^2 + 0.5^2) ≈ 0.7071 km!
	var sector string
	if math.Abs(relY) >= math.Abs(relX) {
		if relY <= 0 {
			// Południowa ćwiartka (podstawa na południowej krawędzi, wierzchołek w środku kwadratu)
			sector = "S"
			coords = [][2]float64{
				{minLon, minLat},
				{maxLon, minLat},
				{cLon, cLat},
				{minLon, minLat},
			}
		} else {
			// Północna ćwiartka
			sector = "N"
			coords = [][2]float64{
				{maxLon, maxLat},
				{minLon, maxLat},
				{cLon, cLat},
				{maxLon, maxLat},
			}
		}
	} else {
		if relX <= 0 {
			// Zachodnia ćwiartka
			sector = "W"
			coords = [][2]float64{
				{minLon, maxLat},
				{minLon, minLat},
				{cLon, cLat},
				{minLon, maxLat},
			}
		} else {
			// Wschodnia ćwiartka
			sector = "E"
			coords = [][2]float64{
				{maxLon, minLat},
				{maxLon, maxLat},
				{cLon, cLat},
				{maxLon, minLat},
			}
		}
	}

	key = fmt.Sprintf("grid_%d_%d_%s", gx, gy, sector)
	// Pole 1/4 kwadratu 1km x 1km = 0.25 km² = 250 000 m²
	areaM2 = 250000.0
	return key, coords, areaM2
}

// HandleGetFogOfWar zwraca odkryte przez użytkownika działki (zarówno z tabeli fog_parcels przypisanej do ulic,
// jak i deterministyczne trójkątne działki 1/4 kwadratu 1km x 1km po obu stronach przejechanych dróg).
func (s *Service) HandleGetFogOfWar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"discovered_count":0,"discovered_area_km2":0,"parcels":[]}`))
		return
	}

	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	var whereProfile string
	var args []interface{}
	if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		whereProfile = "e.profile_id = $1::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $2::uuid)"
		args = []interface{}{profileID, userID}
	} else {
		whereProfile = "e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $1::uuid)"
		args = []interface{}{userID}
	}

	var features []map[string]interface{}
	seenKeys := make(map[string]bool)
	totalAreaM2 := 0.0

	// 1. Pobieramy odkryte działki bezpośrednio z tabeli fog_parcels (przypisane do ulic po obu stronach drogi)
	parcelQuery := fmt.Sprintf(`
		SELECT DISTINCT
			fp.parcel_id,
			ST_AsGeoJSON(fp.parcel_geom)::text,
			fp.area_m2
		FROM fog_parcels fp
		WHERE EXISTS (
			SELECT 1 FROM epochs e
			WHERE %s
			  AND ST_DWithin(fp.road_geom, COALESCE(e.geom_snapped, e.geom), 0.00045)
		)
		LIMIT 15000;
	`, whereProfile)

	pRows, err := s.pool.Query(ctx, parcelQuery, args...)
	if err == nil {
		for pRows.Next() {
			var pid int
			var geoStr string
			var area float64
			if err := pRows.Scan(&pid, &geoStr, &area); err == nil {
				var geomObj map[string]interface{}
				if json.Unmarshal([]byte(geoStr), &geomObj) == nil {
					key := fmt.Sprintf("db_%d", pid)
					seenKeys[key] = true
					totalAreaM2 += area
					features = append(features, map[string]interface{}{
						"type":     "Feature",
						"geometry": geomObj,
						"properties": map[string]interface{}{
							"parcel_id": key,
							"area_m2":   math.Round(area),
						},
					})
				}
			}
		}
		pRows.Close()
	}

	// 2. Uzupełniamy deterministycznymi trójkątami równoramiennymi (1/4 kwadratu 1km x 1km o podstawie 1km i ramionach ~0.7km)
	// wyznaczanymi z obu stron przejechanych dróg (próbkowanie punktów na siatce ~100m)
	ptsQuery := fmt.Sprintf(`
		SELECT DISTINCT
			round(ST_Y(COALESCE(e.geom_snapped, e.geom))::numeric, 3) AS lat,
			round(ST_X(COALESCE(e.geom_snapped, e.geom))::numeric, 3) AS lon
		FROM epochs e
		WHERE %s
		LIMIT 25000;
	`, whereProfile)

	ptRows, err := s.pool.Query(ctx, ptsQuery, args...)
	if err == nil {
		// Offsety ~60m w 4 kierunkach zapewniają, że przejazd po drodze stanowiącej granicę dwóch kwadratów 1km x 1km
		// odkrywa trójkątne działki przypisane z obu stron tej drogi!
		offsets := [][2]float64{
			{0, 0},
			{0.0005, 0},
			{-0.0005, 0},
			{0, 0.0008},
			{0, -0.0008},
		}
		for ptRows.Next() {
			var lat, lon float64
			if err := ptRows.Scan(&lat, &lon); err == nil {
				for _, off := range offsets {
					k, polyCoords, area := ComputeDeterministicSquareTriangle(lat+off[0], lon+off[1])
					if !seenKeys[k] {
						seenKeys[k] = true
						totalAreaM2 += area
						features = append(features, map[string]interface{}{
							"type": "Feature",
							"geometry": map[string]interface{}{
								"type":        "Polygon",
								"coordinates": [][][2]float64{polyCoords},
							},
							"properties": map[string]interface{}{
								"parcel_id": k,
								"area_m2":   area,
							},
						})
					}
				}
			}
		}
		ptRows.Close()
	}

	if features == nil {
		features = []map[string]interface{}{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"discovered_count":    len(features),
		"discovered_area_km2": math.Round((totalAreaM2/1_000_000.0)*100) / 100.0,
		"parcels":             features,
	})
}

// ============================================================================
// 3. RYSOWANIE PO MAPIE (Wielokąty i Ścieżki z zapisem w PostGIS dla zalogowanych)
// ============================================================================

type MapDrawing struct {
	DrawingID   string       `json:"drawing_id"`
	Name        string       `json:"name"`
	DrawingType string       `json:"drawing_type"` // "polygon" | "polyline"
	Color       string       `json:"color"`
	ShowMetrics bool         `json:"show_metrics"`
	AreaM2      float64      `json:"area_m2"`
	PerimeterM  float64      `json:"perimeter_m"`
	LengthM     float64      `json:"length_m"`
	Coordinates [][2]float64 `json:"coordinates"`
	CreatedAt   string       `json:"created_at"`
}

// ComputeDrawingMetrics wylicza pole powierzchni (m²), obwód (m) oraz długość (m) dla ciągu współrzędnych [lon, lat].
func ComputeDrawingMetrics(drawingType string, coords [][2]float64) (areaM2, perimeterM, lengthM float64) {
	if len(coords) < 2 {
		return 0, 0, 0
	}
	for i := 1; i < len(coords); i++ {
		lengthM += haversineDistM(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0])
	}
	if drawingType == "polygon" && len(coords) >= 3 {
		closing := haversineDistM(coords[len(coords)-1][1], coords[len(coords)-1][0], coords[0][1], coords[0][0])
		perimeterM = lengthM + closing

		// Formuła Gaussa (Shoelace) w lokalnym rzucie metrycznym względem środka wielokąta
		var refLat, refLon float64
		for _, c := range coords {
			refLon += c[0]
			refLat += c[1]
		}
		refLon /= float64(len(coords))
		refLat /= float64(len(coords))
		cosLat := math.Cos(refLat * math.Pi / 180.0)

		var sum float64
		for i := 0; i < len(coords); i++ {
			j := (i + 1) % len(coords)
			xi := (coords[i][0] - refLon) * 111320.0 * cosLat
			yi := (coords[i][1] - refLat) * 111320.0
			xj := (coords[j][0] - refLon) * 111320.0 * cosLat
			yj := (coords[j][1] - refLat) * 111320.0
			sum += (xi * yj) - (xj * yi)
		}
		areaM2 = math.Abs(sum) * 0.5
	}
	return areaM2, perimeterM, lengthM
}

func haversineDistM(lat1, lon1, lat2, lon2 float64) float64 {
	const R = 6371000.0
	dLat := (lat2 - lat1) * math.Pi / 180.0
	dLon := (lon2 - lon1) * math.Pi / 180.0
	la1 := lat1 * math.Pi / 180.0
	la2 := lat2 * math.Pi / 180.0
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * R * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func (s *Service) HandleListDrawings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"drawings":[]}`))
		return
	}

	rows, err := s.pool.Query(ctx, `
		SELECT
			drawing_id::text,
			name,
			drawing_type,
			color,
			show_metrics,
			area_m2,
			perimeter_m,
			length_m,
			coordinates,
			to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM map_drawings
		WHERE user_id = $1::uuid
		ORDER BY created_at ASC
	`, userID)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"drawings":[]}`))
		return
	}
	defer rows.Close()

	var list []MapDrawing
	for rows.Next() {
		var d MapDrawing
		var coordsRaw []byte
		if err := rows.Scan(&d.DrawingID, &d.Name, &d.DrawingType, &d.Color, &d.ShowMetrics, &d.AreaM2, &d.PerimeterM, &d.LengthM, &coordsRaw, &d.CreatedAt); err == nil {
			_ = json.Unmarshal(coordsRaw, &d.Coordinates)
			list = append(list, d)
		}
	}
	if list == nil {
		list = []MapDrawing{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"drawings": list,
	})
}

func (s *Service) HandleSaveDrawing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Wymagane logowanie do zapisu na serwerze."}`, http.StatusUnauthorized)
		return
	}

	var req MapDrawing
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
		return
	}

	if len(req.Coordinates) < 2 {
		http.Error(w, `{"detail":"Rysunek musi zawierać co najmniej 2 punkty"}`, http.StatusBadRequest)
		return
	}
	if req.DrawingType != "polygon" && req.DrawingType != "polyline" {
		req.DrawingType = "polyline"
	}
	if strings.TrimSpace(req.Name) == "" {
		if req.DrawingType == "polygon" {
			req.Name = "Wielokąt"
		} else {
			req.Name = "Ścieżka"
		}
	}
	if strings.TrimSpace(req.Color) == "" {
		req.Color = "#38bdf8"
	}

	areaM2, perimeterM, lengthM := ComputeDrawingMetrics(req.DrawingType, req.Coordinates)
	req.AreaM2 = math.Round(areaM2*100) / 100
	req.PerimeterM = math.Round(perimeterM*100) / 100
	req.LengthM = math.Round(lengthM*100) / 100

	coordsBytes, _ := json.Marshal(req.Coordinates)

	err := s.pool.QueryRow(ctx, `
		INSERT INTO map_drawings (user_id, name, drawing_type, color, show_metrics, area_m2, perimeter_m, length_m, coordinates)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
		RETURNING drawing_id::text, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
	`, userID, req.Name, req.DrawingType, req.Color, req.ShowMetrics, req.AreaM2, req.PerimeterM, req.LengthM, string(coordsBytes)).Scan(&req.DrawingID, &req.CreatedAt)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd zapisu rysunku: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"drawing": req,
	})
}

func (s *Service) HandleUpdateDrawing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
		return
	}

	drawingID := chi.URLParam(r, "drawing_id")
	var req MapDrawing
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"detail":"Nieprawidłowy JSON"}`, http.StatusBadRequest)
		return
	}

	if len(req.Coordinates) >= 2 {
		areaM2, perimeterM, lengthM := ComputeDrawingMetrics(req.DrawingType, req.Coordinates)
		req.AreaM2 = math.Round(areaM2*100) / 100
		req.PerimeterM = math.Round(perimeterM*100) / 100
		req.LengthM = math.Round(lengthM*100) / 100
	}
	coordsBytes, _ := json.Marshal(req.Coordinates)

	_, err := s.pool.Exec(ctx, `
		UPDATE map_drawings
		SET name = COALESCE(NULLIF($1, ''), name),
		    color = COALESCE(NULLIF($2, ''), color),
		    show_metrics = $3,
		    coordinates = CASE WHEN $4 != 'null' AND $4 != '[]' THEN $4::jsonb ELSE coordinates END,
		    area_m2 = CASE WHEN $5 > 0 THEN $5 ELSE area_m2 END,
		    perimeter_m = CASE WHEN $6 > 0 THEN $6 ELSE perimeter_m END,
		    length_m = CASE WHEN $7 > 0 THEN $7 ELSE length_m END
		WHERE drawing_id = $8::uuid AND user_id = $9::uuid
	`, req.Name, req.Color, req.ShowMetrics, string(coordsBytes), req.AreaM2, req.PerimeterM, req.LengthM, drawingID, userID)
	if err != nil {
		http.Error(w, `{"detail":"Błąd aktualizacji rysunku"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *Service) HandleDeleteDrawing(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Wymagane logowanie."}`, http.StatusUnauthorized)
		return
	}

	drawingID := chi.URLParam(r, "drawing_id")
	_, err := s.pool.Exec(ctx, `DELETE FROM map_drawings WHERE drawing_id = $1::uuid AND user_id = $2::uuid`, drawingID, userID)
	if err != nil {
		http.Error(w, `{"detail":"Błąd usuwania rysunku"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}


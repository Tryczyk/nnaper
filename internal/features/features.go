package features

import (
	"bytes"
	"container/list"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type lruEntry struct {
	key   string
	value []byte
}

type LRUCache struct {
	capacity int
	items    map[string]*list.Element
	evict    *list.List
	mu       sync.RWMutex
}

func NewLRUCache(capacity int) *LRUCache {
	if capacity <= 0 {
		capacity = 4096
	}
	return &LRUCache{
		capacity: capacity,
		items:    make(map[string]*list.Element),
		evict:    list.New(),
	}
}

func (c *LRUCache) Get(key string) ([]byte, bool) {
	c.mu.RLock()
	elem, ok := c.items[key]
	if !ok {
		c.mu.RUnlock()
		return nil, false
	}
	val := elem.Value.(*lruEntry).value
	c.mu.RUnlock()

	c.mu.Lock()
	if elem, ok := c.items[key]; ok {
		c.evict.MoveToFront(elem)
	}
	c.mu.Unlock()

	return val, true
}

func (c *LRUCache) Set(key string, value []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		c.evict.MoveToFront(elem)
		elem.Value.(*lruEntry).value = value
		return
	}

	elem := c.evict.PushFront(&lruEntry{key: key, value: value})
	c.items[key] = elem

	if c.evict.Len() > c.capacity {
		oldest := c.evict.Back()
		if oldest != nil {
			c.evict.Remove(oldest)
			delete(c.items, oldest.Value.(*lruEntry).key)
		}
	}
}

type Service struct {
	pool  *pgxpool.Pool
	cache *LRUCache
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{
		pool:  pool,
		cache: NewLRUCache(4096),
	}
}

// ============================================================================
// 1. HEATMAPA (Kafelki wektorowe MVT WebGL, Kafelki rastrowe PNG oraz Siatka Grid)
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
// Wartości pośrednie są interpolowane po skali logarytmicznej: zielony -> żółty -> pomarańczowy -> czerwony.
func heatmapColorForCount(count, maxCount int64) color.NRGBA {
	if count <= 0 {
		return color.NRGBA{R: 0, G: 0, B: 0, A: 0}
	}
	if maxCount <= 1 || count == 1 {
		if maxCount == 1 && count == 1 {
			return color.NRGBA{R: 34, G: 197, B: 94, A: 215}
		}
		return color.NRGBA{R: 34, G: 197, B: 94, A: 205}
	}
	if count >= maxCount {
		return color.NRGBA{R: 239, G: 68, B: 68, A: 240}
	}

	// Skala logarytmiczna t w [0, 1] pomiędzy 1 a maxCount dla naturalnego, nieprzekłamanego rozkładu
	t := math.Log(float64(count)) / math.Log(float64(maxCount))
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

// heatmapColorForDensity zwraca wygładzony kolor RGBA dla ciągłych wartości zagęszczenia (float64)
// Oparty o naturalną, spójną skalę termiczną:
// 1 przejazd -> subtelny, chłodny szafir / szmaragd (nie zlewający się z cyjanem śladu)
// 2-4 przejazdy -> soczysta zieleń
// 6-10 przejazdów -> ciepły bursztyn / żółć
// 12-18 przejazdów -> pomarańcz
// 20+ przejazdów -> nasycona, głęboka czerwień (główne arterie i codzienne trasy)
func heatmapColorForDensity(val, maxVal float64) color.NRGBA {
	if val <= 0.04 {
		return color.NRGBA{R: 0, G: 0, B: 0, A: 0}
	}
	if maxVal <= 1.0 {
		return color.NRGBA{R: 16, G: 185, B: 129, A: 160}
	}
	if val >= maxVal {
		return color.NRGBA{R: 239, G: 68, B: 68, A: 240}
	}

	t := math.Log(1.0+val) / math.Log(1.0+maxVal)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}

	var r, g, b uint8
	if t < 0.22 {
		// 0.00 - 0.22: Subtelny chłodny błękit/szmaragd (30, 144, 255 -> 16, 185, 129)
		u := t / 0.22
		r = uint8(30.0 + u*(16.0-30.0))
		g = uint8(144.0 + u*(185.0-144.0))
		b = uint8(255.0 + u*(129.0-255.0))
	} else if t < 0.55 {
		// 0.22 - 0.55: Soczysta zieleń (16, 185, 129) -> Złocisty bursztyn (234, 179, 8)
		u := (t - 0.22) / 0.33
		r = uint8(16.0 + u*(234.0-16.0))
		g = uint8(185.0 + u*(179.0-185.0))
		b = uint8(129.0 + u*(8.0-129.0))
	} else if t < 0.82 {
		// 0.55 - 0.82: Bursztyn (234, 179, 8) -> Gorący pomarańcz (249, 115, 22)
		u := (t - 0.55) / 0.27
		r = uint8(234.0 + u*(249.0-234.0))
		g = uint8(179.0 + u*(115.0-179.0))
		b = uint8(8.0 + u*(22.0-8.0))
	} else {
		// 0.82 - 1.00: Pomarańcz (249, 115, 22) -> Intensywna czerwień (239, 68, 68)
		u := (t - 0.82) / 0.18
		r = uint8(249.0 + u*(239.0-249.0))
		g = uint8(115.0 + u*(68.0-115.0))
		b = uint8(22.0 + u*(68.0-22.0))
	}

	alpha := uint8(math.Min(240.0, 90.0+t*150.0))
	return color.NRGBA{R: r, G: g, B: b, A: alpha}
}

// buildHeatmapQueryConditions buduje warunki WHERE dla zapytań heatmapy (profile_id, days, filter_stops)
func (s *Service) buildHeatmapQueryConditions(r *http.Request, userID string, startArg int) (whereSQL string, args []interface{}) {
	var whereClauses []string
	q := r.URL.Query()
	profileID := strings.TrimSpace(q.Get("profile_id"))
	days := strings.TrimSpace(q.Get("days"))
	filterStops := q.Get("filter_stops") != "false" && q.Get("mode") != "dwell" // Domyślnie filtrujemy postoje (brak przekłamań)

	nextArg := startArg
	if profileID != "" && profileID != "all" && profileID != "__all__" && len(profileID) == 36 {
		whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1))
		args = append(args, profileID, userID)
		nextArg += 2
	} else {
		whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg))
		args = append(args, userID)
		nextArg++
	}

	// Filtracja postojów: postoje generują setki punktów w jednym miejscu fałszując natężenie
	if filterStops {
		whereClauses = append(whereClauses, "(e.speed_kmh IS NULL OR e.speed_kmh >= 2.0)")
	}

	// Dla heatmapy: pobieramy całą historię użytkownika, chyba że jawnie podano konkretne daty.
	// Nigdy nie odrzucamy danych z powodu wyłączonej warstwy śladów ("__none__"), aby heatmapa była w 100% niezależna!
	if days != "" && days != "all" && days != "0" && days != "all-history" && days != "__all__" && days != "__none__" && days != "none" && days != "empty" && days != "false" {
		var dayList []string
		for _, d := range strings.Split(days, ",") {
			d = strings.TrimSpace(d)
			if d != "" && d != "none" && d != "__none__" {
				dayList = append(dayList, d)
			}
		}
		if len(dayList) > 0 {
			var validDates []string
			var yearList []string
			var monthList []string
			hasNullDate := false
			for _, d := range dayList {
				if d == "None" || d == "null" {
					hasNullDate = true
				} else if len(d) == 4 {
					yearList = append(yearList, d)
				} else if len(d) == 7 {
					monthList = append(monthList, d)
				} else if len(d) == 10 {
					validDates = append(validDates, d)
				}
			}
			var dateConds []string
			if len(validDates) > 0 {
				dateConds = append(dateConds, fmt.Sprintf("(e.timestamp::date = ANY($%d::date[]))", nextArg))
				args = append(args, validDates)
				nextArg++
			}
			for _, y := range yearList {
				dateConds = append(dateConds, fmt.Sprintf("(e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 year'))", nextArg, nextArg))
				args = append(args, y+"-01-01")
				nextArg++
			}
			for _, m := range monthList {
				dateConds = append(dateConds, fmt.Sprintf("(e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 month'))", nextArg, nextArg))
				args = append(args, m+"-01")
				nextArg++
			}
			if hasNullDate {
				dateConds = append(dateConds, "(e.timestamp IS NULL)")
			}
			if len(dateConds) > 0 {
				whereClauses = append(whereClauses, fmt.Sprintf("(%s)", strings.Join(dateConds, " OR ")))
			}
		}
	}

	whereSQL = strings.Join(whereClauses, " AND ")
	return
}

// HandleGetHeatmapVectorTile serwuje kafelki wektorowe MVT dla natywnej warstwy WebGL Heatmap w MapLibre GL.
// Punkty zawierają precyzyjne wagi 'weight' oraz 'count', zapewniając sprzętowy rendering 60 FPS w natywnej rozdzielczości 4K/Retina.
func (s *Service) HandleGetHeatmapVectorTile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		return
	}

	z, errZ := strconv.Atoi(chi.URLParam(r, "z"))
	x, errX := strconv.Atoi(chi.URLParam(r, "x"))
	y, errY := strconv.Atoi(chi.URLParam(r, "y"))
	if errZ != nil || errX != nil || errY != nil || z < 0 || x < 0 || y < 0 {
		http.Error(w, "invalid tile coords", http.StatusBadRequest)
		return
	}

	snapped := r.URL.Query().Get("snapped") == "true"
	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	days := strings.TrimSpace(r.URL.Query().Get("days"))
	filterStops := r.URL.Query().Get("filter_stops") != "false" && r.URL.Query().Get("mode") != "dwell"
	cacheKey := fmt.Sprintf("heat_mvt:%s:%s:%d:%d:%d:%s:%t", userID, profileID, z, x, y, days, filterStops)

	if cached, ok := s.cache.Get(cacheKey); ok {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "private, max-age=600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(cached)
		return
	}

	whereSQL, queryArgs := s.buildHeatmapQueryConditions(r, userID, 4)
	args := append([]interface{}{z, x, y}, queryArgs...)

	var sqlQuery string
	gridDiv := 64.0
	if z >= 14 {
		gridDiv = 128.0
	}

	sqlQuery = fmt.Sprintf(`
		WITH bounds AS (
			SELECT ST_TileEnvelope($1, $2, $3) AS geom
		),
		grid AS (
			SELECT (ST_XMax(bounds.geom) - ST_XMin(bounds.geom)) / %f AS sz
			FROM bounds
		),
		agg AS (
			SELECT
				ST_Centroid(ST_Collect(ST_Transform(%s, 3857))) AS geom_pt,
				COUNT(*)::int AS cnt,
				COUNT(DISTINCT date_trunc('hour', COALESCE(e.timestamp, '2000-01-01'::timestamptz)))::int AS weight
			FROM epochs e, bounds, grid
			WHERE %s
			  AND %s && ST_Transform(bounds.geom, 4326)
			GROUP BY ST_SnapToGrid(ST_Transform(%s, 3857), grid.sz)
		),
		tile_features AS (
			SELECT
				cnt AS count,
				weight,
				ST_AsMVTGeom(geom_pt, bounds.geom, 4096, 256, TRUE) AS geom
			FROM agg, bounds
			WHERE geom_pt IS NOT NULL
		)
		SELECT COALESCE(ST_AsMVT(tile_features, 'heatmap', 4096, 'geom'), ''::bytea)
		FROM tile_features
		WHERE geom IS NOT NULL;
	`, gridDiv, activeGeom, whereSQL, activeGeom, activeGeom)

	var tileBytes []byte
	err := s.pool.QueryRow(ctx, sqlQuery, args...).Scan(&tileBytes)
	if err != nil {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		return
	}

	s.cache.Set(cacheKey, tileBytes)
	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	w.Header().Set("Cache-Control", "private, max-age=600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(tileBytes)
}

// HandleGetHeatmapTile generuje kafelek rastrowy PNG (256x256) dla podanego (z, x, y).
// Zawiera wygładzanie jądrowe (KDE) i znormalizowaną skalę barwną, eliminując pikselozę i fałszywe hotspoty.
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
	const gridRes = 128

	img := image.NewNRGBA(image.Rect(0, 0, tileSize, tileSize))
	if userID == "" {
		writePNG(w, img)
		return
	}

	profileID := strings.TrimSpace(r.URL.Query().Get("profile_id"))
	days := strings.TrimSpace(r.URL.Query().Get("days"))
	filterStops := r.URL.Query().Get("filter_stops") != "false" && r.URL.Query().Get("mode") != "dwell"
	cacheKey := fmt.Sprintf("heat_png:%s:%s:%d:%d:%d:%s:%t", userID, profileID, z, x, y, days, filterStops)

	if cached, ok := s.cache.Get(cacheKey); ok {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "private, max-age=600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(cached)
		return
	}

	minLon, minLat, maxLon, maxLat := tileBounds4326(z, x, y)
	snapped := r.URL.Query().Get("snapped") == "true"
	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	whereSQL, queryArgs := s.buildHeatmapQueryConditions(r, userID, 6)
	args := append([]interface{}{minLon, maxLon, minLat, maxLat, gridRes}, queryArgs...)

	query := fmt.Sprintf(`
		SELECT
			width_bucket(ST_X(%s), $1, $2, $5) AS bx,
			width_bucket(ST_Y(%s), $3, $4, $5) AS by,
			COUNT(DISTINCT date_trunc('hour', COALESCE(e.timestamp, '2000-01-01'::timestamptz)))::int AS cnt
		FROM epochs e
		WHERE %s
		  AND %s && ST_MakeEnvelope($1, $3, $2, $4, 4326)
		GROUP BY bx, by;
	`, activeGeom, activeGeom, whereSQL, activeGeom)

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		writePNG(w, img)
		return
	}
	defer rows.Close()

	var grid [gridRes][gridRes]float64
	var maxCnt int64
	for rows.Next() {
		var bx, by int
		var cnt int64
		if err := rows.Scan(&bx, &by, &cnt); err == nil {
			if bx >= 1 && bx <= gridRes && by >= 1 && by <= gridRes && cnt > 0 {
				grid[by-1][bx-1] = float64(cnt)
				if cnt > maxCnt {
					maxCnt = cnt
				}
			}
		}
	}

	// Stała, stabilna skala absolutna dla spójności i wyeliminowania skakania barw między kafelkami:
	// 1 przejazd: subtelny chłodny błękit/szmaragd
	// 2-4 przejazdy: soczysta zieleń
	// 6-10 przejazdów: ciepły bursztyn/żółć
	// 12-18 przejazdów: pomarańcz
	// 20+ przejazdów: nasycona czerwień (główne trasy i autostrady)
	effectiveMax := 20.0
	if gMaxStr := r.URL.Query().Get("max_count"); gMaxStr != "" {
		if gm, err := strconv.ParseFloat(gMaxStr, 64); err == nil && gm > 0 {
			effectiveMax = gm
		}
	}

	// Filtr splotowy wygładzania jądrowego (Gaussian 3x3) eliminujący schodkową pikselozę
	var smoothed [gridRes][gridRes]float64
	for gy := 0; gy < gridRes; gy++ {
		for gx := 0; gx < gridRes; gx++ {
			c := grid[gy][gx]
			if c == 0 {
				// Sprawdzamy sąsiadów
				var sum float64
				var weightSum float64
				for dy := -1; dy <= 1; dy++ {
					ny := gy + dy
					if ny < 0 || ny >= gridRes {
						continue
					}
					for dx := -1; dx <= 1; dx++ {
						nx := gx + dx
						if nx < 0 || nx >= gridRes {
							continue
						}
						w := 1.0
						if dx == 0 || dy == 0 {
							w = 2.0
						}
						sum += grid[ny][nx] * w
						weightSum += w
					}
				}
				if sum > 0 {
					smoothed[gy][gx] = sum / weightSum
				}
			} else {
				// Waga centralna 4.0, krzyż 2.0, przekątne 1.0
				var sum float64
				var weightSum float64
				for dy := -1; dy <= 1; dy++ {
					ny := gy + dy
					if ny < 0 || ny >= gridRes {
						continue
					}
					for dx := -1; dx <= 1; dx++ {
						nx := gx + dx
						if nx < 0 || nx >= gridRes {
							continue
						}
						w := 1.0
						if dx == 0 && dy == 0 {
							w = 4.0
						} else if dx == 0 || dy == 0 {
							w = 2.0
						}
						sum += grid[ny][nx] * w
						weightSum += w
					}
				}
				smoothed[gy][gx] = sum / weightSum
			}
		}
	}

	// Renderowanie rastra 256x256 z interpolacją dwuliniową
	ratio := float64(gridRes) / float64(tileSize)
	for py := 0; py < tileSize; py++ {
		gyFloat := float64(tileSize-1-py) * ratio
		gy0 := int(gyFloat)
		gy1 := gy0 + 1
		if gy1 >= gridRes {
			gy1 = gridRes - 1
		}
		fy := gyFloat - float64(gy0)

		for px := 0; px < tileSize; px++ {
			gxFloat := float64(px) * ratio
			gx0 := int(gxFloat)
			gx1 := gx0 + 1
			if gx1 >= gridRes {
				gx1 = gridRes - 1
			}
			fx := gxFloat - float64(gx0)

			// Interpolacja dwuliniowa wartości zagęszczenia
			val00 := smoothed[gy0][gx0]
			val10 := smoothed[gy0][gx1]
			val01 := smoothed[gy1][gx0]
			val11 := smoothed[gy1][gx1]
			val := (1-fx)*(1-fy)*val00 + fx*(1-fy)*val10 + (1-fx)*fy*val01 + fx*fy*val11

			if val > 0.02 {
				col := heatmapColorForDensity(val, effectiveMax)
				if col.A > 0 {
					img.SetNRGBA(px, py, col)
				}
			}
		}
	}

	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	bytesData := buf.Bytes()
	s.cache.Set(cacheKey, bytesData)

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "private, max-age=600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bytesData)
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

	snapped := q.Get("snapped") == "true"
	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	whereSQL, queryArgs := s.buildHeatmapQueryConditions(r, userID, 7)
	args := append([]interface{}{minLon, maxLon, minLat, maxLat, cols, rowsCount}, queryArgs...)

	query := fmt.Sprintf(`
		SELECT
			width_bucket(ST_X(%s), $1, $2, $5) AS bx,
			width_bucket(ST_Y(%s), $3, $4, $6) AS by,
			count(*) AS cnt
		FROM epochs e
		WHERE %s
		  AND %s && ST_MakeEnvelope($1, $3, $2, $4, 4326)
		GROUP BY bx, by;
	`, activeGeom, activeGeom, whereSQL, activeGeom)

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

// BlockTriangle reprezentuje trójkątną działkę przypisaną do otaczającej ulicy.
type BlockTriangle struct {
	Index       int          `json:"index"`
	RoadSegment [][2]float64 `json:"road_segment"` // Odcinek otaczającej ulicy: [pA, pB]
	Triangle    [][2]float64 `json:"triangle"`     // Zamknięty wielokąt trójkąta: [pA, pB, Apex, pA]
	AreaM2      float64      `json:"area_m2"`
}

// TriangulateBlockParcel dzieli dowolny kwartał otoczony ulicami (w tym wielokąty 4-, 8-boczne
// oraz działki wklęsłe / w kształcie litery U) na trójkąty przypisane do poszczególnych ulic.
// Każda otaczająca ulica otrzymuje dokładnie 1 trójkąt parceli skierowany do wnętrza działki.
// Dla działek w kształcie litery U stosowany jest wierzchołek wewnętrzny wyznaczony wzdłuż normalnej
// do wnętrza ramienia kwartału, co gwarantuje, że trójkąt nigdy nie wychodzi poza obrys działki
// ani nie przecina wcięcia litery U.
func TriangulateBlockParcel(ring [][2]float64) []BlockTriangle {
	if len(ring) < 3 {
		return nil
	}
	// Usunięcie domykającego punktu, jeśli występuje
	pts := make([][2]float64, 0, len(ring))
	for i, p := range ring {
		if i == len(ring)-1 && len(ring) > 3 && math.Abs(p[0]-ring[0][0]) < 1e-9 && math.Abs(p[1]-ring[0][1]) < 1e-9 {
			continue
		}
		pts = append(pts, p)
	}
	n := len(pts)
	if n < 3 {
		return nil
	}

	// Wyznaczenie pola ze znakiem (Shoelace) i ewentualne odwrócenie do orientacji CCW (przeciwnie do ruchu wskazówek zegara)
	var signedArea float64
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		signedArea += (pts[i][0] * pts[j][1]) - (pts[j][0] * pts[i][1])
	}
	if signedArea < 0 {
		// Odwracamy do CCW
		for i, j := 0, n-1; i < j; i, j = i+1, j-1 {
			pts[i], pts[j] = pts[j], pts[i]
		}
	}

	// Środek ciężkości (centroid)
	var cx, cy float64
	for _, p := range pts {
		cx += p[0]
		cy += p[1]
	}
	cx /= float64(n)
	cy /= float64(n)
	centroid := [2]float64{cx, cy}

	centroidInside := isPointInPolygon(centroid, pts)

	var result []BlockTriangle
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		pA := pts[i]
		pB := pts[j]

		edgeVecX := pB[0] - pA[0]
		edgeVecY := pB[1] - pA[1]
		edgeLen := math.Hypot(edgeVecX, edgeVecY)
		if edgeLen < 1e-9 {
			continue
		}

		// Dla orientacji CCW wektor normalny skierowany do wnętrza wielokąta: (-dy, dx)
		nx := -edgeVecY / edgeLen
		ny := edgeVecX / edgeLen

		midX := (pA[0] + pB[0]) * 0.5
		midY := (pA[1] + pB[1]) * 0.5
		mid := [2]float64{midX, midY}

		// Sprawdzamy czy centroid jest widoczny i czy trójkąt do centroidu leży wewnątrz
		useCentroid := centroidInside
		if useCentroid {
			testMidToC := [2]float64{(midX + cx) * 0.5, (midY + cy) * 0.5}
			if !isPointInPolygon(testMidToC, pts) {
				useCentroid = false
			}
		}

		var apex [2]float64
		if useCentroid {
			apex = centroid
		} else {
			// Obsługa działek wklęsłych / w kształcie litery U:
			// Wystrzeliwujemy promień z mid w kierunku normalnej wewnętrznej (nx, ny)
			// i znajdujemy pierwsze przecięcie z przeciwległą krawędzią wielokąta
			minDist := 1e9
			for k := 0; k < n; k++ {
				if k == i {
					continue
				}
				l := (k + 1) % n
				qA := pts[k]
				qB := pts[l]
				if hit, dist := raySegmentIntersection(mid, [2]float64{nx, ny}, qA, qB); hit && dist > 1e-6 && dist < minDist {
					minDist = dist
				}
			}
			if minDist > 1e8 {
				minDist = edgeLen * 0.5
			}
			// Wierzchołek w połowie odległości do przeciwległej ściany ramienia litery U
			h := minDist * 0.5
			apex = [2]float64{midX + nx*h, midY + ny*h}
		}

		triCoords := [][2]float64{pA, pB, apex, pA}
		areaM2, _, _ := ComputeDrawingMetrics("polygon", [][2]float64{pA, pB, apex})

		result = append(result, BlockTriangle{
			Index:       i + 1,
			RoadSegment: [][2]float64{pA, pB},
			Triangle:    triCoords,
			AreaM2:      areaM2,
		})
	}

	return result
}

func isPointInPolygon(pt [2]float64, poly [][2]float64) bool {
	n := len(poly)
	inside := false
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		xi, yi := poly[i][0], poly[i][1]
		xj, yj := poly[j][0], poly[j][1]
		intersect := ((yi > pt[1]) != (yj > pt[1])) &&
			(pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi)
		if intersect {
			inside = !inside
		}
	}
	return inside
}

func raySegmentIntersection(rayOrigin, rayDir, segA, segB [2]float64) (bool, float64) {
	v1x := rayOrigin[0] - segA[0]
	v1y := rayOrigin[1] - segA[1]
	v2x := segB[0] - segA[0]
	v2y := segB[1] - segA[1]
	v3x := -rayDir[1]
	v3y := rayDir[0]

	dot := v2x*v3x + v2y*v3y
	if math.Abs(dot) < 1e-9 {
		return false, 0
	}

	t1 := (v2x*v1y - v2y*v1x) / dot
	t2 := (v1x*v3x + v1y*v3y) / dot

	if t1 >= 0 && t2 >= 0 && t2 <= 1 {
		return true, t1
	}
	return false, 0
}

// HandleGetFogOfWar zwraca stan odkrywania mapy (zasłaniające trójkąty mgły na nieodkrytych działkach,
// znikające po przejechaniu przyległej drogi) wraz ze statystykami odkrytego obszaru.
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

	bboxStr := strings.TrimSpace(r.URL.Query().Get("bbox"))
	var minLon, minLat, maxLon, maxLat float64
	hasBbox := false
	if bboxStr != "" {
		parts := strings.Split(bboxStr, ",")
		if len(parts) == 4 {
			p0, e0 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
			p1, e1 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
			p2, e2 := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
			p3, e3 := strconv.ParseFloat(strings.TrimSpace(parts[3]), 64)
			if e0 == nil && e1 == nil && e2 == nil && e3 == nil {
				minLon, minLat, maxLon, maxLat = p0, p1, p2, p3
				// Jeśli bbox jest zbyt duży (np. całe województwo przy dużym oddaleniu mapy),
				// nie wysyłamy tysięcy mikroskopijnych działek, które dławią WebGL w przeglądarce.
				if (maxLon-minLon) <= 0.35 && (maxLat-minLat) <= 0.25 {
					hasBbox = true
				}
			}
		}
	}

	var fogMaskObj interface{}
	var discoveredFeatures []map[string]interface{}

	if hasBbox {
		// 1. Wyznaczamy maskę białej chmury (cały kadr z wyciętymi otworami na odkryte działki)
		qArgs := append([]interface{}{minLon, minLat, maxLon, maxLat}, args...)
		shiftedWhere := strings.ReplaceAll(whereProfile, "$1", "$5")
		shiftedWhere = strings.ReplaceAll(shiftedWhere, "$2", "$6")

		maskQuery := fmt.Sprintf(`
			WITH disc AS (
			  SELECT fp.parcel_geom
			  FROM fog_parcels fp
			  WHERE fp.parcel_geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
			    AND EXISTS (
			      SELECT 1 FROM epochs e
			      WHERE %s
			        AND e.geom && fp.road_geom
			        AND ST_DWithin(fp.road_geom, e.geom, 0.00045)
			    )
			),
			env AS (
			  SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS b
			)
			SELECT ST_AsGeoJSON(ST_Difference(env.b, COALESCE(ST_Union(disc.parcel_geom), ST_SetSRID('GEOMETRYCOLLECTION EMPTY'::geometry, 4326))))::text
			FROM env LEFT JOIN disc ON true
			GROUP BY env.b;
		`, shiftedWhere)

		var maskGeoJSONStr string
		if err := s.pool.QueryRow(ctx, maskQuery, qArgs...).Scan(&maskGeoJSONStr); err == nil && maskGeoJSONStr != "" {
			_ = json.Unmarshal([]byte(maskGeoJSONStr), &fogMaskObj)
		}

		// 2. Pobieramy odkryte działki (do wyrysowania przezroczystych obszarów z wyraźnymi granicami działek)
		discQuery := fmt.Sprintf(`
			SELECT fp.parcel_id, ST_AsGeoJSON(fp.parcel_geom)::text, fp.area_m2
			FROM fog_parcels fp
			WHERE fp.parcel_geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
			  AND EXISTS (
			    SELECT 1 FROM epochs e
			    WHERE %s
			      AND e.geom && fp.road_geom
			      AND ST_DWithin(fp.road_geom, e.geom, 0.00045)
			  )
			LIMIT 3500;
		`, shiftedWhere)

		pRows, err := s.pool.Query(ctx, discQuery, qArgs...)
		if err == nil {
			defer pRows.Close()
			for pRows.Next() {
				var pid int
				var geoStr string
				var area float64
				if err := pRows.Scan(&pid, &geoStr, &area); err == nil {
					var geomObj map[string]interface{}
					if json.Unmarshal([]byte(geoStr), &geomObj) == nil {
						discoveredFeatures = append(discoveredFeatures, map[string]interface{}{
							"type":     "Feature",
							"geometry": geomObj,
							"properties": map[string]interface{}{
								"parcel_id": fmt.Sprintf("fog_%d", pid),
								"area_m2":   math.Round(area),
							},
						})
					}
				}
			}
		}
	}

	var discCount int
	var discAreaKM2 float64
	statQuery := fmt.Sprintf(`
		SELECT count(*), COALESCE(round((sum(fp.area_m2) / 1000000.0)::numeric, 2), 0)::float8
		FROM fog_parcels fp
		WHERE EXISTS (
		  SELECT 1 FROM epochs e
		  WHERE %s
		    AND e.geom && fp.road_geom
		    AND ST_DWithin(fp.road_geom, e.geom, 0.00045)
		);
	`, whereProfile)
	_ = s.pool.QueryRow(ctx, statQuery, args...).Scan(&discCount, &discAreaKM2)

	if discoveredFeatures == nil {
		discoveredFeatures = []map[string]interface{}{}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"discovered_count":    discCount,
		"discovered_area_km2": discAreaKM2,
		"fog_mask":            fogMaskObj,
		"discovered_parcels":  discoveredFeatures,
		"parcels":             discoveredFeatures,
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


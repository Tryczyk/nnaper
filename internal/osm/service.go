package osm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

// HandleGetInfrastructureTile generuje kafelek wektorowy MVT z warstwą 'osm-infrastructure'
// zawierającą: sygnalizację drogową, progi zwalniające, przejścia dla pieszych, fotoradary i odcinkowe pomiary prędkości.
func (s *Service) HandleGetInfrastructureTile(w http.ResponseWriter, r *http.Request) {
	z, errZ := strconv.Atoi(chi.URLParam(r, "z"))
	x, errX := strconv.Atoi(chi.URLParam(r, "x"))
	y, errY := strconv.Atoi(chi.URLParam(r, "y"))

	if errZ != nil || errX != nil || errY != nil || z < 0 || x < 0 || y < 0 || (z < 31 && (x >= (1<<z) || y >= (1<<z))) {
		http.Error(w, `{"detail":"Nieprawidłowe współrzędne kafelka"}`, http.StatusBadRequest)
		return
	}

	// Dla niskich zoomów pokazujemy fotoradary i odcinkowe pomiary prędkości, a od zoom >= 12 również światła, progi i przejścia
	catFilter := "1=1"
	if z < 11 {
		catFilter = "i.category IN ('speed_camera', 'average_speed')"
	} else if z < 13 {
		catFilter = "i.category IN ('speed_camera', 'average_speed', 'traffic_signals', 'speed_bump')"
	}

	sqlQuery := fmt.Sprintf(`
		WITH bounds AS (
			SELECT ST_TileEnvelope($1, $2, $3) AS geom,
			       ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS geom4326
		),
		raw_features AS (
			SELECT
				i.id::bigint AS id,
				i.osm_id,
				i.osm_type,
				i.category,
				COALESCE(i.subtype, '') AS subtype,
				COALESCE(i.name, '') AS name,
				COALESCE(i.maxspeed, '') AS maxspeed,
				i.geom
			FROM osm_infrastructure i
			CROSS JOIN bounds
			WHERE i.geom && bounds.geom4326
			  AND %s
			UNION ALL
			SELECT
				i.id::bigint * 100000 + 1 AS id,
				i.osm_id,
				'node' AS osm_type,
				'average_speed_point' AS category,
				'start' AS subtype,
				COALESCE(i.name, 'Początek odcinkowego pomiaru prędkości') AS name,
				COALESCE(i.maxspeed, '') AS maxspeed,
				ST_StartPoint(i.geom) AS geom
			FROM osm_infrastructure i
			CROSS JOIN bounds
			WHERE i.category = 'average_speed'
			  AND ST_GeometryType(i.geom) = 'ST_LineString'
			  AND ST_StartPoint(i.geom) && bounds.geom4326
			UNION ALL
			SELECT
				i.id::bigint * 100000 + 2 AS id,
				i.osm_id,
				'node' AS osm_type,
				'average_speed_point' AS category,
				'end' AS subtype,
				COALESCE(i.name, 'Koniec odcinkowego pomiaru prędkości') AS name,
				COALESCE(i.maxspeed, '') AS maxspeed,
				ST_EndPoint(i.geom) AS geom
			FROM osm_infrastructure i
			CROSS JOIN bounds
			WHERE i.category = 'average_speed'
			  AND ST_GeometryType(i.geom) = 'ST_LineString'
			  AND ST_EndPoint(i.geom) && bounds.geom4326
		),
		tile_features AS (
			SELECT
				rf.id,
				rf.osm_id,
				rf.osm_type,
				rf.category,
				rf.subtype,
				rf.name,
				rf.maxspeed,
				ST_AsMVTGeom(
					ST_Transform(rf.geom, 3857),
					bounds.geom,
					4096,
					256,
					TRUE
				) AS geom
			FROM raw_features rf
			CROSS JOIN bounds
		)
		SELECT COALESCE(ST_AsMVT(tile_features, 'osm-infrastructure', 4096, 'geom'), ''::bytea)
		FROM tile_features
		WHERE geom IS NOT NULL;
	`, catFilter)

	var tileBytes []byte
	err := s.pool.QueryRow(r.Context(), sqlQuery, z, x, y).Scan(&tileBytes)
	if err != nil || tileBytes == nil {
		tileBytes = []byte{}
	}

	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(tileBytes)
}

// HandleGetPOITile generuje kafelek wektorowy MVT z warstwą 'osm-pois' (wzbogacone punkty POI z .osm.pbf, w tym sklepy).
func (s *Service) HandleGetPOITile(w http.ResponseWriter, r *http.Request) {
	z, errZ := strconv.Atoi(chi.URLParam(r, "z"))
	x, errX := strconv.Atoi(chi.URLParam(r, "x"))
	y, errY := strconv.Atoi(chi.URLParam(r, "y"))

	if errZ != nil || errX != nil || errY != nil || z < 0 || x < 0 || y < 0 || (z < 31 && (x >= (1<<z) || y >= (1<<z))) {
		http.Error(w, `{"detail":"Nieprawidłowe współrzędne kafelka"}`, http.StatusBadRequest)
		return
	}

	if z < 11 {
		w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
		w.WriteHeader(http.StatusOK)
		return
	}

	sqlQuery := `
		WITH bounds AS (
			SELECT ST_TileEnvelope($1, $2, $3) AS geom,
			       ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS geom4326
		),
		tile_features AS (
			SELECT
				p.id,
				p.osm_id,
				p.osm_type,
				p.category,
				COALESCE(p.subclass, '') AS subclass,
				COALESCE(p.name, '') AS name,
				COALESCE(p.opening_hours, '') AS opening_hours,
				ST_AsMVTGeom(
					ST_Transform(p.geom, 3857),
					bounds.geom,
					4096,
					256,
					TRUE
				) AS geom
			FROM osm_pois p
			CROSS JOIN bounds
			WHERE p.geom && bounds.geom4326
		)
		SELECT COALESCE(ST_AsMVT(tile_features, 'osm-pois', 4096, 'geom'), ''::bytea)
		FROM tile_features
		WHERE geom IS NOT NULL;
	`

	var tileBytes []byte
	err := s.pool.QueryRow(r.Context(), sqlQuery, z, x, y).Scan(&tileBytes)
	if err != nil || tileBytes == nil {
		tileBytes = []byte{}
	}

	w.Header().Set("Content-Type", "application/vnd.mapbox-vector-tile")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(tileBytes)
}

// HandleGetPOIDetails zwraca szczegółowe informacje o punkcie POI lub elemencie infrastruktury z pliku .osm.pbf
// po kliknięciu lub najechaniu na mapie.
func (s *Service) HandleGetPOIDetails(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lat, errLat := strconv.ParseFloat(q.Get("lat"), 64)
	lon, errLon := strconv.ParseFloat(q.Get("lon"), 64)
	osmID, _ := strconv.ParseInt(q.Get("osm_id"), 10, 64)
	hintSub := strings.TrimSpace(q.Get("subclass"))
	hintName := strings.TrimSpace(q.Get("name"))

	if errLat != nil || errLon != nil {
		http.Error(w, `{"detail":"Wymagane parametry lat oraz lon"}`, http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	type poiDetailResp struct {
		Found        bool              `json:"found"`
		OSMID        int64             `json:"osm_id"`
		OSMType      string            `json:"osm_type"`
		Category     string            `json:"category"`
		CategoryPL   string            `json:"category_pl"`
		Subclass     string            `json:"subclass"`
		SubclassPL   string            `json:"subclass_pl"`
		Name         string            `json:"name"`
		OpeningHours string            `json:"opening_hours"`
		Address      string            `json:"address"`
		Street       string            `json:"street"`
		Housenumber  string            `json:"housenumber"`
		City         string            `json:"city"`
		Postcode     string            `json:"postcode"`
		Phone        string            `json:"phone"`
		Website      string            `json:"website"`
		Cuisine      string            `json:"cuisine"`
		Operator     string            `json:"operator"`
		Brand        string            `json:"brand"`
		Lat          float64           `json:"lat"`
		Lon          float64           `json:"lon"`
		Tags         map[string]string `json:"tags"`
	}

	var resp poiDetailResp
	var tagsRaw []byte

	// Szukamy w osm_pois po osm_id lub najbliższego w promieniu ~120m (~0.0015 stopnia)
	query := `
		SELECT
			p.osm_id,
			p.osm_type,
			p.category,
			COALESCE(p.subclass, ''),
			COALESCE(p.name, ''),
			COALESCE(p.opening_hours, ''),
			COALESCE(p.street, ''),
			COALESCE(p.housenumber, ''),
			COALESCE(p.city, ''),
			COALESCE(p.postcode, ''),
			COALESCE(p.phone, ''),
			COALESCE(p.website, ''),
			COALESCE(p.cuisine, ''),
			COALESCE(p.operator, ''),
			COALESCE(p.brand, ''),
			ST_Y(p.geom) AS lat,
			ST_X(p.geom) AS lon,
			COALESCE(p.tags, '{}'::jsonb)
		FROM osm_pois p
		WHERE ($1::bigint > 0 AND p.osm_id = $1::bigint)
		   OR ST_DWithin(p.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326), 0.0018)
		ORDER BY
			CASE WHEN $1::bigint > 0 AND p.osm_id = $1::bigint THEN 0 ELSE 1 END,
			CASE WHEN $4 != '' AND LOWER(p.subclass) = LOWER($4) THEN 0 ELSE 1 END,
			p.geom <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)
		LIMIT 1
	`

	err := s.pool.QueryRow(ctx, query, osmID, lon, lat, hintSub).Scan(
		&resp.OSMID,
		&resp.OSMType,
		&resp.Category,
		&resp.Subclass,
		&resp.Name,
		&resp.OpeningHours,
		&resp.Street,
		&resp.Housenumber,
		&resp.City,
		&resp.Postcode,
		&resp.Phone,
		&resp.Website,
		&resp.Cuisine,
		&resp.Operator,
		&resp.Brand,
		&resp.Lat,
		&resp.Lon,
		&tagsRaw,
	)

	if err == nil {
		resp.Found = true
		_ = json.Unmarshal(tagsRaw, &resp.Tags)
	} else {
		// Sprawdzenie w osm_infrastructure (np. kliknięcie w fotoradar, światła, próg, przejście)
		var maxspeed string
		errInfra := s.pool.QueryRow(ctx, `
			SELECT
				i.osm_id,
				i.osm_type,
				i.category,
				COALESCE(i.subtype, ''),
				COALESCE(i.name, ''),
				COALESCE(i.maxspeed, ''),
				ST_Y(ST_Centroid(i.geom)) AS lat,
				ST_X(ST_Centroid(i.geom)) AS lon,
				COALESCE(i.tags, '{}'::jsonb)
			FROM osm_infrastructure i
			WHERE ST_DWithin(i.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0012)
			ORDER BY i.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
			LIMIT 1
		`, lon, lat).Scan(
			&resp.OSMID,
			&resp.OSMType,
			&resp.Category,
			&resp.Subclass,
			&resp.Name,
			&maxspeed,
			&resp.Lat,
			&resp.Lon,
			&tagsRaw,
		)
		if errInfra == nil {
			resp.Found = true
			_ = json.Unmarshal(tagsRaw, &resp.Tags)
			if maxspeed != "" && resp.Tags != nil {
				resp.Tags["maxspeed"] = maxspeed
			}
		} else {
			// Fallback z przekazanych właściwości kafelka PMTiles + reverse geocoding adresu
			resp.Found = true
			resp.Lat = lat
			resp.Lon = lon
			resp.Subclass = hintSub
			resp.Name = hintName
			resp.Category = inferCategoryFromSubclass(hintSub)
			resp.Tags = map[string]string{}
			if hintSub != "" {
				resp.Tags["subclass"] = hintSub
			}
		}
	}

	// Jeśli brakuje ulicy/miasta w samym POI, dociągamy najbliższy adres z osm_addresses
	if resp.Street == "" && resp.City == "" {
		_ = s.pool.QueryRow(ctx, `
			SELECT COALESCE(street, ''), COALESCE(housenumber, ''), COALESCE(city, ''), COALESCE(postcode, '')
			FROM osm_addresses
			WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0025)
			  AND (street != '' OR city != '')
			ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
			LIMIT 1
		`, lon, lat).Scan(&resp.Street, &resp.Housenumber, &resp.City, &resp.Postcode)
	}

	resp.CategoryPL = translateCategoryPL(resp.Category)
	resp.SubclassPL = translateSubclassPL(resp.Subclass, resp.CategoryPL)
	if strings.TrimSpace(resp.Name) == "" {
		if resp.Brand != "" {
			resp.Name = resp.Brand
		} else if resp.Operator != "" {
			resp.Name = resp.Operator
		} else if resp.SubclassPL != "" {
			resp.Name = resp.SubclassPL
		} else {
			resp.Name = "Punkt użyteczności publicznej (POI)"
		}
	}

	var addrParts []string
	if resp.Street != "" {
		if resp.Housenumber != "" {
			addrParts = append(addrParts, resp.Street+" "+resp.Housenumber)
		} else {
			addrParts = append(addrParts, resp.Street)
		}
	}
	if resp.Postcode != "" || resp.City != "" {
		addrParts = append(addrParts, strings.TrimSpace(resp.Postcode+" "+resp.City))
	}
	resp.Address = strings.Join(addrParts, ", ")

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resp)
}

// HandleGeocodeSearch obsługuje lokalne wyszukiwanie adresów, ulic, miast i miejsc (/api/geocode/api/ i /api/geocode/search)
// w formacie w 100% zgodnym z Photon (GeoJSON FeatureCollection).
func (s *Service) HandleGeocodeSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 20
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.Atoi(lStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	if q == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"type":"FeatureCollection","features":[]}`))
		return
	}

	tokens := strings.Fields(strings.ToLower(q))
	var conds []string
	var args []interface{}
	nextArg := 1

	for _, tok := range tokens {
		conds = append(conds, fmt.Sprintf("a.search_text LIKE $%d", nextArg))
		args = append(args, "%"+tok+"%")
		nextArg++
	}

	// Obsługa opcjonalnego bbox=minLon,minLat,maxLon,maxLat
	if bboxStr := r.URL.Query().Get("bbox"); bboxStr != "" {
		parts := strings.Split(bboxStr, ",")
		if len(parts) == 4 {
			minLon, e1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
			minLat, e2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
			maxLon, e3 := strconv.ParseFloat(strings.TrimSpace(parts[2]), 64)
			maxLat, e4 := strconv.ParseFloat(strings.TrimSpace(parts[3]), 64)
			if e1 == nil && e2 == nil && e3 == nil && e4 == nil {
				conds = append(conds, fmt.Sprintf("a.geom && ST_MakeEnvelope($%d, $%d, $%d, $%d, 4326)", nextArg, nextArg+1, nextArg+2, nextArg+3))
				args = append(args, minLon, minLat, maxLon, maxLat)
				nextArg += 4
			}
		}
	}

	prefixArg := nextArg
	args = append(args, strings.ToLower(tokens[0])+"%")
	nextArg++

	limitArg := nextArg
	args = append(args, limit)

	sqlQuery := fmt.Sprintf(`
		SELECT
			a.osm_id,
			a.osm_type,
			a.place_type,
			COALESCE(a.name, ''),
			COALESCE(a.street, ''),
			COALESCE(a.housenumber, ''),
			COALESCE(a.city, ''),
			COALESCE(a.postcode, ''),
			COALESCE(a.state, 'Pomorskie'),
			COALESCE(a.country, 'Polska'),
			COALESCE(a.country_code, 'PL'),
			ST_X(a.geom) AS lon,
			ST_Y(a.geom) AS lat
		FROM osm_addresses a
		WHERE %s
		ORDER BY
			CASE WHEN LOWER(COALESCE(a.name, a.street, '')) LIKE $%d THEN 0 ELSE 1 END,
			a.importance DESC,
			LENGTH(a.search_text) ASC
		LIMIT $%d
	`, strings.Join(conds, " AND "), prefixArg, limitArg)

	features := s.queryAddressFeatures(r.Context(), sqlQuery, args...)

	// Jeśli baza jest w trakcie indeksowania lub brak wyników, sprawdźmy wbudowany słownik najważniejszych miejsc Pomorza
	if len(features) == 0 {
		features = fallbackSearchFeatures(tokens, limit)
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"type":     "FeatureCollection",
		"features": features,
	})
}

// HandleGeocodeReverse obsługuje lokalne odwrotne geokodowanie (/api/geocode/reverse?lat=...&lon=...)
func (s *Service) HandleGeocodeReverse(w http.ResponseWriter, r *http.Request) {
	lat, errLat := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lon, errLon := strconv.ParseFloat(r.URL.Query().Get("lon"), 64)
	if errLat != nil || errLon != nil {
		http.Error(w, `{"detail":"Wymagane parametry lat oraz lon"}`, http.StatusBadRequest)
		return
	}

	sqlQuery := `
		SELECT
			a.osm_id,
			a.osm_type,
			a.place_type,
			COALESCE(a.name, ''),
			COALESCE(a.street, ''),
			COALESCE(a.housenumber, ''),
			COALESCE(a.city, ''),
			COALESCE(a.postcode, ''),
			COALESCE(a.state, 'Pomorskie'),
			COALESCE(a.country, 'Polska'),
			COALESCE(a.country_code, 'PL'),
			ST_X(a.geom) AS lon,
			ST_Y(a.geom) AS lat
		FROM osm_addresses a
		WHERE ST_DWithin(a.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.02)
		ORDER BY a.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
		LIMIT 1
	`

	features := s.queryAddressFeatures(r.Context(), sqlQuery, lon, lat)
	if len(features) == 0 {
		features = []map[string]interface{}{
			{
				"type": "Feature",
				"geometry": map[string]interface{}{
					"type":        "Point",
					"coordinates": []float64{lon, lat},
				},
				"properties": map[string]interface{}{
					"name":        fmt.Sprintf("%.5f, %.5f", lat, lon),
					"state":       "Pomorskie",
					"country":     "Polska",
					"countrycode": "PL",
				},
			},
		}
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"type":     "FeatureCollection",
		"features": features,
	})
}

func (s *Service) queryAddressFeatures(ctx context.Context, sqlQuery string, args ...interface{}) []map[string]interface{} {
	rows, err := s.pool.Query(ctx, sqlQuery, args...)
	if err != nil {
		return []map[string]interface{}{}
	}
	defer rows.Close()

	features := make([]map[string]interface{}, 0)
	for rows.Next() {
		var osmID int64
		var osmType, placeType, name, street, housenumber, city, postcode, state, country, countryCode string
		var lon, lat float64
		if err := rows.Scan(&osmID, &osmType, &placeType, &name, &street, &housenumber, &city, &postcode, &state, &country, &countryCode, &lon, &lat); err != nil {
			continue
		}
		osmShortType := "N"
		if osmType == "way" {
			osmShortType = "W"
		} else if osmType == "relation" {
			osmShortType = "R"
		}
		features = append(features, map[string]interface{}{
			"type": "Feature",
			"geometry": map[string]interface{}{
				"type":        "Point",
				"coordinates": []float64{lon, lat},
			},
			"properties": map[string]interface{}{
				"osm_id":      osmID,
				"osm_type":    osmShortType,
				"osm_value":   placeType,
				"type":        placeType,
				"name":        name,
				"street":      street,
				"housenumber": housenumber,
				"city":        city,
				"postcode":    postcode,
				"state":       state,
				"country":     country,
				"countrycode": countryCode,
			},
		})
	}
	return features
}

func fallbackSearchFeatures(tokens []string, limit int) []map[string]interface{} {
	type seedPlace struct {
		name   string
		street string
		city   string
		ptype  string
		lat    float64
		lon    float64
	}
	seeds := []seedPlace{
		{name: "Gdańsk", city: "Gdańsk", ptype: "city", lat: 54.352025, lon: 18.646638},
		{name: "Gdynia", city: "Gdynia", ptype: "city", lat: 54.518890, lon: 18.530540},
		{name: "Sopot", city: "Sopot", ptype: "city", lat: 54.441581, lon: 18.560096},
		{name: "Słupsk", city: "Słupsk", ptype: "city", lat: 54.464148, lon: 17.028482},
		{name: "Tczew", city: "Tczew", ptype: "town", lat: 54.092420, lon: 18.777870},
		{name: "Wejherowo", city: "Wejherowo", ptype: "town", lat: 54.605680, lon: 18.235550},
		{name: "Rumia", city: "Rumia", ptype: "town", lat: 54.570720, lon: 18.387680},
		{name: "Reda", city: "Reda", ptype: "town", lat: 54.605280, lon: 18.347220},
		{name: "Pruszcz Gdański", city: "Pruszcz Gdański", ptype: "town", lat: 54.262220, lon: 18.636390},
		{name: "Kartuzy", city: "Kartuzy", ptype: "town", lat: 54.334170, lon: 18.201390},
		{name: "Kościerzyna", city: "Kościerzyna", ptype: "town", lat: 54.121940, lon: 17.981110},
		{name: "Starogard Gdański", city: "Starogard Gdański", ptype: "town", lat: 53.963060, lon: 18.525830},
		{name: "Malbork", city: "Malbork", ptype: "town", lat: 54.035830, lon: 19.026670},
		{name: "Chojnice", city: "Chojnice", ptype: "town", lat: 53.695560, lon: 17.556940},
		{name: "Puck", city: "Puck", ptype: "town", lat: 54.717780, lon: 18.408330},
		{name: "Władysławowo", city: "Władysławowo", ptype: "town", lat: 54.790830, lon: 18.403610},
		{name: "Hel", city: "Hel", ptype: "town", lat: 54.608060, lon: 18.801390},
		{name: "Łeba", city: "Łeba", ptype: "town", lat: 54.760830, lon: 17.555000},
		{name: "Ustka", city: "Ustka", ptype: "town", lat: 54.580560, lon: 16.861940},
		{name: "Bytów", city: "Bytów", ptype: "town", lat: 54.171110, lon: 17.490830},
		{name: "Lębork", city: "Lębork", ptype: "town", lat: 54.539170, lon: 17.750000},
		{name: "Kwidzyn", city: "Kwidzyn", ptype: "town", lat: 53.725830, lon: 18.931110},
		{name: "Aleja Grunwaldzka", street: "Aleja Grunwaldzka", city: "Gdańsk", ptype: "street", lat: 54.389500, lon: 18.589200},
		{name: "Ulica Długa", street: "Długa", city: "Gdańsk", ptype: "street", lat: 54.348500, lon: 18.651000},
		{name: "Ulica Świętojańska", street: "Świętojańska", city: "Gdynia", ptype: "street", lat: 54.515200, lon: 18.539800},
		{name: "Bohaterów Monte Cassino", street: "Bohaterów Monte Cassino", city: "Sopot", ptype: "street", lat: 54.444200, lon: 18.566500},
	}

	out := make([]map[string]interface{}, 0)
	for idx, s := range seeds {
		hay := strings.ToLower(s.name + " " + s.street + " " + s.city + " pomorskie polska")
		matched := true
		for _, t := range tokens {
			if !strings.Contains(hay, t) {
				matched = false
				break
			}
		}
		if matched {
			out = append(out, map[string]interface{}{
				"type": "Feature",
				"geometry": map[string]interface{}{
					"type":        "Point",
					"coordinates": []float64{s.lon, s.lat},
				},
				"properties": map[string]interface{}{
					"osm_id":      int64(1000 + idx),
					"osm_type":    "N",
					"osm_value":   s.ptype,
					"type":        s.ptype,
					"name":        s.name,
					"street":      s.street,
					"city":        s.city,
					"state":       "Pomorskie",
					"country":     "Polska",
					"countrycode": "PL",
				},
			})
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func inferCategoryFromSubclass(sub string) string {
	switch strings.ToLower(sub) {
	case "place_of_worship", "christian", "catholic":
		return "worship"
	case "restaurant", "cafe", "fast_food", "bar", "pub", "ice_cream", "bakery":
		return "food"
	case "hospital", "pharmacy", "doctors", "clinic", "dentist":
		return "health"
	case "supermarket", "convenience", "clothes", "mall", "shop", "kiosk", "doityourself":
		return "shop"
	default:
		return "service"
	}
}

func translateCategoryPL(cat string) string {
	switch cat {
	case "worship":
		return "Miejsce kultu"
	case "food":
		return "Gastronomia"
	case "health":
		return "Opieka zdrowotna"
	case "shop":
		return "Sklep / Handel"
	case "service":
		return "Usługi i instytucje"
	case "tourism":
		return "Turystyka i kultura"
	case "traffic_signals":
		return "Sygnalizacja świetlna"
	case "speed_bump":
		return "Próg zwalniający"
	case "crossing":
		return "Przejście dla pieszych"
	case "speed_camera":
		return "Fotoradar"
	case "average_speed":
		return "Odcinkowy pomiar prędkości"
	default:
		return "Punkt POI"
	}
}

func translateSubclassPL(sub, fallback string) string {
	switch strings.ToLower(sub) {
	case "place_of_worship", "christian", "catholic":
		return "Świątynia / Kościół"
	case "restaurant":
		return "Restauracja"
	case "cafe":
		return "Kawiarnia"
	case "fast_food":
		return "Fast food / Bar szybkiej obsługi"
	case "bar":
		return "Bar"
	case "pub":
		return "Pub"
	case "ice_cream":
		return "Lodziarnia"
	case "hospital":
		return "Szpital"
	case "pharmacy":
		return "Apteka"
	case "doctors", "clinic":
		return "Przychodnia lekarska"
	case "dentist":
		return "Gabinet stomatologiczny"
	case "supermarket":
		return "Supermarket"
	case "convenience":
		return "Sklep spożywczy"
	case "bakery":
		return "Piekarnia"
	case "clothes":
		return "Sklep odzieżowy"
	case "fuel":
		return "Stacja paliw"
	case "charging_station":
		return "Stacja ładowania pojazdów"
	case "bank":
		return "Bank"
	case "atm":
		return "Bankomat"
	case "post_office":
		return "Urząd pocztowy"
	case "school":
		return "Szkoła"
	case "university":
		return "Uczelnia wyższa"
	case "kindergarten":
		return "Przedszkole"
	case "hotel":
		return "Hotel"
	case "museum":
		return "Muzeum"
	case "bump", "hump", "table", "cushion":
		return "Próg zwalniający (" + sub + ")"
	case "zebra", "marked", "uncontrolled":
		return "Przejście dla pieszych"
	case "traffic_signals", "signals":
		return "Sygnalizacja świetlna"
	case "maxspeed":
		return "Fotoradar kontroli prędkości"
	case "section":
		return "Odcinek pomiaru średniej prędkości"
	default:
		if sub != "" {
			return sub
		}
		return fallback
	}
}


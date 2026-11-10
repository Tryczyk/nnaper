package export

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"nnaper/internal/auth"
)

type Service struct {
	pool *pgxpool.Pool
}

func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool}
}

type scopeFilter struct {
	whereClauses []string
	params       []interface{}
	scopeName    string
}

func buildScopeFilter(
	scope, day string,
	year, month int,
	days string,
	userID, profileID string,
) scopeFilter {
	var whereClauses []string
	var params []interface{}
	scopeName := "trasa"
	nextArg := 1

	if userID != "" {
		if profileID != "" && profileID != "all" && profileID != "__all__" {
			whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id = $%d::uuid AND e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg, nextArg+1))
			params = append(params, profileID, userID)
			nextArg += 2
		} else {
			whereClauses = append(whereClauses, fmt.Sprintf("e.profile_id IN (SELECT profile_id FROM profiles WHERE user_id = $%d::uuid)", nextArg))
			params = append(params, userID)
			nextArg++
		}
	} else {
		whereClauses = append(whereClauses, "FALSE")
	}

	switch scope {
	case "day":
		if day != "" {
			dayStr := strings.TrimSpace(day)
			if dayStr == "None" || dayStr == "null" {
				whereClauses = append(whereClauses, "e.timestamp IS NULL")
				scopeName = "dzien_None"
			} else {
				whereClauses = append(whereClauses, fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 day')", nextArg, nextArg))
				params = append(params, dayStr)
				nextArg++
				scopeName = fmt.Sprintf("dzien_%s", dayStr)
			}
		}
	case "month":
		if year > 0 && month > 0 {
			startDate := fmt.Sprintf("%04d-%02d-01", year, month)
			whereClauses = append(whereClauses, fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 month')", nextArg, nextArg))
			params = append(params, startDate)
			nextArg++
			scopeName = fmt.Sprintf("miesiac_%04d_%02d", year, month)
		}
	case "year":
		if year > 0 {
			startDate := fmt.Sprintf("%04d-01-01", year)
			whereClauses = append(whereClauses, fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 year')", nextArg, nextArg))
			params = append(params, startDate)
			nextArg++
			scopeName = fmt.Sprintf("rok_%04d", year)
		}
	case "days", "custom", "active":
		if days != "" {
			var dayList []string
			for _, d := range strings.Split(days, ",") {
				if trimmed := strings.TrimSpace(d); trimmed != "" {
					dayList = append(dayList, trimmed)
				}
			}
			if len(dayList) > 0 {
				var validDates []string
				hasNull := false
				for _, d := range dayList {
					if d == "None" || d == "null" {
						hasNull = true
					} else {
						validDates = append(validDates, d)
					}
				}
				var conds []string
				if len(validDates) > 0 {
					conds = append(conds, fmt.Sprintf("e.timestamp::date = ANY($%d::date[])", nextArg))
					params = append(params, validDates)
					nextArg++
				}
				if hasNull {
					conds = append(conds, "e.timestamp IS NULL")
				}
				if len(conds) > 0 {
					whereClauses = append(whereClauses, fmt.Sprintf("(%s)", strings.Join(conds, " OR ")))
				}
				scopeName = fmt.Sprintf("wybrane_%d_dni", len(dayList))
			}
		}
	case "all":
		scopeName = "wszystko"
	default:
		if day != "" {
			dayStr := strings.TrimSpace(day)
			if dayStr == "None" || dayStr == "null" {
				whereClauses = append(whereClauses, "e.timestamp IS NULL")
				scopeName = "dzien_None"
			} else {
				whereClauses = append(whereClauses, fmt.Sprintf("e.timestamp >= $%d::date AND e.timestamp < ($%d::date + INTERVAL '1 day')", nextArg, nextArg))
				params = append(params, dayStr)
				nextArg++
				scopeName = fmt.Sprintf("dzien_%s", dayStr)
			}
		} else {
			scopeName = "wszystko"
		}
	}

	return scopeFilter{
		whereClauses: whereClauses,
		params:       params,
		scopeName:    scopeName,
	}
}

func (s *Service) HandleExportData(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte("[]"))
		return
	}

	query := r.URL.Query()
	scope := query.Get("scope")
	if scope == "" {
		scope = "day"
	}
	day := query.Get("day")
	year, _ := strconv.Atoi(query.Get("year"))
	month, _ := strconv.Atoi(query.Get("month"))
	days := query.Get("days")
	downsample, _ := strconv.Atoi(query.Get("downsample"))
	snapped := query.Get("snapped") == "true"
	profileID := query.Get("profile_id")

	sf := buildScopeFilter(scope, day, year, month, days, userID, profileID)
	whereSQL := ""
	if len(sf.whereClauses) > 0 {
		whereSQL = "WHERE " + strings.Join(sf.whereClauses, " AND ")
	}

	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	var sqlQuery string
	if downsample > 1 {
		sqlQuery = fmt.Sprintf(`
			WITH numbered AS (
				SELECT 
					e.epoch_id,
					to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
					round(ST_Y(%s)::numeric, 6) AS lat,
					round(ST_X(%s)::numeric, 6) AS lon,
					NULL::numeric AS altitude,
					LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
					e.g_x,
					e.g_y,
					e.g_z,
					ROW_NUMBER() OVER (ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC) AS rn
				FROM epochs e
				%s
			)
			SELECT COALESCE(json_agg(
				json_build_object(
					'epoch_id', n.epoch_id,
					'timestamp', n.timestamp,
					'lat', n.lat,
					'lon', n.lon,
					'altitude', n.altitude,
					'speed_kmh', n.speed_kmh,
					'g_x', n.g_x,
					'g_y', n.g_y,
					'g_z', n.g_z
				) ORDER BY n.rn ASC
			)::text, '[]')
			FROM numbered n
			WHERE (n.rn - 1) %% %d = 0;
		`, activeGeom, activeGeom, whereSQL, downsample)
	} else {
		sqlQuery = fmt.Sprintf(`
			SELECT COALESCE(json_agg(
				json_build_object(
					'epoch_id', e.epoch_id,
					'timestamp', to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
					'lat', round(ST_Y(%s)::numeric, 6),
					'lon', round(ST_X(%s)::numeric, 6),
					'altitude', NULL,
					'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 220.0),
					'g_x', e.g_x,
					'g_y', e.g_y,
					'g_z', e.g_z
				) ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC
			)::text, '[]')
			FROM epochs e
			%s;
		`, activeGeom, activeGeom, whereSQL)
	}

	var rawJSON string
	err := s.pool.QueryRow(ctx, sqlQuery, sf.params...).Scan(&rawJSON)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd pobierania danych trasy: %v"}`, err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(rawJSON))
}

type exportPoint struct {
	Timestamp *string  `json:"timestamp"`
	Lat       float64  `json:"lat"`
	Lon       float64  `json:"lon"`
	Altitude  *float64 `json:"altitude"`
	SpeedKmh  *float64 `json:"speed_kmh"`
	GX        *float64 `json:"g_x"`
	GY        *float64 `json:"g_y"`
	GZ        *float64 `json:"g_z"`
}

func (s *Service) HandleExportDownload(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := r.URL.Query().Get("token")
	authHeader := r.Header.Get("Authorization")
	userID := auth.GetAuthUserID(ctx, s.pool, token, authHeader)

	if userID == "" {
		http.Error(w, `{"detail":"Brak autoryzacji"}`, http.StatusUnauthorized)
		return
	}

	query := r.URL.Query()
	format := strings.ToLower(strings.TrimSpace(query.Get("format")))
	if format == "" {
		format = "gpx"
	}
	scope := query.Get("scope")
	if scope == "" {
		scope = "day"
	}
	day := query.Get("day")
	year, _ := strconv.Atoi(query.Get("year"))
	month, _ := strconv.Atoi(query.Get("month"))
	days := query.Get("days")
	snapped := query.Get("snapped") == "true"
	profileID := query.Get("profile_id")

	sf := buildScopeFilter(scope, day, year, month, days, userID, profileID)
	whereSQL := ""
	if len(sf.whereClauses) > 0 {
		whereSQL = "WHERE " + strings.Join(sf.whereClauses, " AND ")
	}

	activeGeom := "e.geom"
	if snapped {
		activeGeom = "COALESCE(e.geom_snapped, e.geom)"
	}

	sqlQuery := fmt.Sprintf(`
		SELECT 
			to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
			round(ST_Y(%s)::numeric, 6) AS lat,
			round(ST_X(%s)::numeric, 6) AS lon,
			NULL::numeric AS altitude,
			LEAST(COALESCE(e.speed_kmh, 0), 220.0) AS speed_kmh,
			e.g_x,
			e.g_y,
			e.g_z
		FROM epochs e
		%s
		ORDER BY e.timestamp ASC NULLS LAST, e.epoch_id ASC;
	`, activeGeom, activeGeom, whereSQL)

	rows, err := s.pool.Query(ctx, sqlQuery, sf.params...)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"detail":"Błąd bazy danych: %v"}`, err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var points []exportPoint
	for rows.Next() {
		var p exportPoint
		if err := rows.Scan(&p.Timestamp, &p.Lat, &p.Lon, &p.Altitude, &p.SpeedKmh, &p.GX, &p.GY, &p.GZ); err == nil {
			points = append(points, p)
		}
	}

	filenameBase := fmt.Sprintf("trasa_%s", sf.scopeName)

	switch format {
	case "csv":
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.csv"`, filenameBase))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("\ufefftimestamp,latitude,longitude,altitude_m,speed_kmh,g_x,g_y,g_z\n"))
		for _, p := range points {
			ts := ""
			if p.Timestamp != nil {
				ts = *p.Timestamp
			}
			alt := ""
			if p.Altitude != nil {
				alt = fmt.Sprintf("%.2f", *p.Altitude)
			}
			spd := 0.0
			if p.SpeedKmh != nil {
				spd = *p.SpeedKmh
			}
			gx, gy, gz := "", "", ""
			if p.GX != nil {
				gx = fmt.Sprintf("%.4f", *p.GX)
			}
			if p.GY != nil {
				gy = fmt.Sprintf("%.4f", *p.GY)
			}
			if p.GZ != nil {
				gz = fmt.Sprintf("%.4f", *p.GZ)
			}
			line := fmt.Sprintf("%s,%.6f,%.6f,%s,%.2f,%s,%s,%s\n", ts, p.Lat, p.Lon, alt, spd, gx, gy, gz)
			_, _ = w.Write([]byte(line))
		}

	case "gpx":
		w.Header().Set("Content-Type", "application/gpx+xml; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.gpx"`, filenameBase))
		w.WriteHeader(http.StatusOK)

		var sb strings.Builder
		sb.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
		sb.WriteString("<gpx version=\"1.1\" creator=\"NNAPER\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n")
		sb.WriteString(fmt.Sprintf("  <metadata><name>Trasa %s</name></metadata>\n", sf.scopeName))
		sb.WriteString("  <trk>\n")
		sb.WriteString(fmt.Sprintf("    <name>Trasa NNAPER - %s</name>\n", sf.scopeName))
		sb.WriteString("    <trkseg>\n")

		for _, p := range points {
			sb.WriteString(fmt.Sprintf("      <trkpt lat=\"%.6f\" lon=\"%.6f\">\n", p.Lat, p.Lon))
			if p.Altitude != nil {
				sb.WriteString(fmt.Sprintf("        <ele>%.2f</ele>\n", *p.Altitude))
			}
			if p.Timestamp != nil && *p.Timestamp != "" {
				sb.WriteString(fmt.Sprintf("        <time>%s</time>\n", *p.Timestamp))
			}
			if p.SpeedKmh != nil {
				speedMS := *p.SpeedKmh / 3.6
				sb.WriteString(fmt.Sprintf("        <speed>%.2f</speed>\n", speedMS))
			}
			sb.WriteString("      </trkpt>\n")
		}

		sb.WriteString("    </trkseg>\n")
		sb.WriteString("  </trk>\n")
		sb.WriteString("</gpx>\n")
		_, _ = w.Write([]byte(sb.String()))

	case "kml":
		w.Header().Set("Content-Type", "application/vnd.google-earth.kml+xml; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.kml"`, filenameBase))
		w.WriteHeader(http.StatusOK)

		var coords []string
		for _, p := range points {
			alt := 0.0
			if p.Altitude != nil {
				alt = *p.Altitude
			}
			coords = append(coords, fmt.Sprintf("%.6f,%.6f,%.1f", p.Lon, p.Lat, alt))
		}
		coordsStr := strings.Join(coords, " ")

		kml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trasa NNAPER - %s</name>
    <Style id="routeStyle">
      <LineStyle>
        <color>ff00d406</color>
        <width>4</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>%s</name>
      <styleUrl>#routeStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>%s</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`, sf.scopeName, sf.scopeName, coordsStr)
		_, _ = w.Write([]byte(kml))

	case "geojson":
		w.Header().Set("Content-Type", "application/geo+json; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.geojson"`, filenameBase))
		w.WriteHeader(http.StatusOK)

		var coords [][]float64
		for _, p := range points {
			alt := 0.0
			if p.Altitude != nil {
				alt = *p.Altitude
			}
			coords = append(coords, []float64{p.Lon, p.Lat, alt})
		}

		feature := map[string]interface{}{
			"type": "Feature",
			"geometry": map[string]interface{}{
				"type":        "LineString",
				"coordinates": coords,
			},
			"properties": map[string]interface{}{
				"name":         fmt.Sprintf("Trasa %s", sf.scopeName),
				"points_count": len(points),
			},
		}

		geoJSON := map[string]interface{}{
			"type":     "FeatureCollection",
			"features": []interface{}{feature},
		}

		_ = json.NewEncoder(w).Encode(geoJSON)

	default:
		http.Error(w, fmt.Sprintf(`{"detail":"Nieobsługiwany format: %s"}`, format), http.StatusBadRequest)
	}
}


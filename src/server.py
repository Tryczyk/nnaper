from datetime import datetime
import json
from typing import Optional
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
import psycopg
from psycopg.rows import dict_row

from constants import DB_URL

app = FastAPI(title="nnaper API")

@app.on_event("startup")
def ensure_db_indices():
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute("CREATE INDEX IF NOT EXISTS idx_epochs_timestamp ON epochs (timestamp ASC);")
    except Exception as e:
        pass

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/dates-tree")
def get_dates_tree():
    query = """
        SELECT DISTINCT 
            EXTRACT(YEAR FROM timestamp)::int AS y,
            EXTRACT(MONTH FROM timestamp)::int AS m,
            EXTRACT(DAY FROM timestamp)::int AS d
        FROM epochs
        ORDER BY y DESC, m DESC, d DESC;
    """
    tree = {}
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(query)
            for y, m, d in cur.fetchall():
                y_str = str(y)
                m_str = str(m).zfill(2)
                d_str = str(d).zfill(2)
                tree.setdefault(y_str, {}).setdefault(m_str, []).append(d_str)
    return tree

@app.get("/api/track")
def get_track(days: str = Query(None)):
    where_clauses = []
    params = []
    if days:
        if days == "none":
            where_clauses.append("1 = 0")
        else:
            day_list = [d.strip() for d in days.split(",") if d.strip()]
            where_clauses.append("timestamp::date = ANY(%s::date[])")
            params.append(day_list)

    query = f"""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(
                json_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(geom)::json,
                    'properties', json_build_object(
                        'epoch_id', epoch_id,
                        'day', timestamp::date,
                        'timestamp', timestamp,
                        'latitude', round(ST_Y(geom)::numeric, 6),
                        'longitude', round(ST_X(geom)::numeric, 6),
                        'altitude', altitude,
                        'speed_kmh', speed_kmh
                    )
                )
            ), '[]'::json)
        ) AS geojson
        FROM epochs
        {"WHERE " + " AND ".join(where_clauses) if where_clauses else ""};
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, params)
            row = cur.fetchone()
            return row["geojson"]


@app.get("/api/track/{z}/{x}/{y}.pbf")
def get_track_tile(z: int, x: int, y: int, days: str = Query(None)):
    """Zwraca dynamiczny kafelek Mapbox Vector Tile dla śladu GPS."""
    if z < 0 or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        raise HTTPException(status_code=400, detail="Nieprawidłowe współrzędne kafelka")

    day_list = None
    if days and days != "none":
        day_list = [day.strip() for day in days.split(",") if day.strip()]
        if not day_list:
            day_list = None

    where_clauses = [
        "e.geom && ST_Transform(ST_TileEnvelope(%s, %s, %s), 4326)",
    ]
    params = [z, x, y]
    if days == "none":
        where_clauses.append("FALSE")
    elif day_list:
        where_clauses.append("e.timestamp::date = ANY(%s::date[])")
        where_clauses.extend([
            "e.timestamp >= %s::date",
            "e.timestamp < (%s::date + INTERVAL '1 day')",
        ])
        params.extend([day_list, min(day_list), max(day_list)])

    query = f"""
        WITH bounds AS (
            SELECT ST_TileEnvelope(%s, %s, %s) AS geom
        ),
        tile_features AS (
            SELECT
                e.epoch_id::text AS epoch_id,
                e.timestamp::date::text AS day,
                to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp,
                round(ST_Y(e.geom)::numeric, 6) AS latitude,
                round(ST_X(e.geom)::numeric, 6) AS longitude,
                ST_AsMVTGeom(
                    ST_Transform(e.geom, 3857),
                    bounds.geom,
                    4096,
                    64,
                    TRUE
                ) AS geom
            FROM epochs e
            CROSS JOIN bounds
            WHERE {' AND '.join(where_clauses)}
        )
        SELECT ST_AsMVT(tile_features, 'gps-track', 4096, 'geom')
        FROM tile_features
        WHERE geom IS NOT NULL;
    """
    # ST_TileEnvelope is used once for the CTE and once for the index-friendly
    # bounding-box predicate, so both sets of placeholders are intentional.
    params = [z, x, y] + params
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL max_parallel_workers_per_gather = 0")
            cur.execute(query, params)
            tile = cur.fetchone()[0] or b""

    return Response(
        content=bytes(tile),
        media_type="application/vnd.mapbox-vector-tile",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/epoch/{epoch_id}")
def get_epoch_details(epoch_id: str):
    query = """
    SELECT json_build_object(
        'epoch_id', e.epoch_id,
        'profile_id', e.profile_id,
        'timestamp', e.timestamp,
        'latitude', round(ST_Y(e.geom)::numeric, 6),
        'longitude', round(ST_X(e.geom)::numeric, 6),
        'altitude', e.altitude,
        'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 180.0),
        'g_x', e.g_x,
        'g_y', e.g_y,
        'g_z', e.g_z,
        'satellites', COALESCE(
            (SELECT json_agg(json_build_object(
                'prn', sat.prn,
                'elevation', sat.elevation,
                'azimuth', sat.azimuth
            ) ORDER BY sat.prn)
             FROM satellite sat
             WHERE sat.epoch_id = e.epoch_id),
            '[]'::json
        )
    ) AS epoch
    FROM epochs e
    WHERE e.epoch_id = %(eid)s;
    """
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(query, {"eid": epoch_id})
            row = cur.fetchone()
            if not row or not row["epoch"]:
                return {"error": "Epoch not found"}
            return row["epoch"]


@app.get("/api/playback-day")
def get_playback_day(day: str = Query(...)):
    """Pobiera uporządkowaną listę epok telemetrycznych dla wybranego dnia z satelitami (zoptymalizowana wersja JSON)."""
    day_str = day.strip()
    try:
        datetime.strptime(day_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Nieprawidłowy format daty. Oczekiwano YYYY-MM-DD.")

    query = """
    WITH day_epochs AS (
        SELECT 
            e.epoch_id,
            to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
            round(ST_Y(e.geom)::numeric, 6) AS lat,
            round(ST_X(e.geom)::numeric, 6) AS lon,
            e.altitude,
            LEAST(COALESCE(e.speed_kmh, 0), 260.0) AS speed_kmh,
            e.g_x,
            e.g_y,
            e.g_z
        FROM epochs e
        WHERE e.timestamp >= %s::date
          AND e.timestamp < (%s::date + INTERVAL '1 day')
        ORDER BY e.timestamp ASC
    ),
    day_satellites AS (
        SELECT 
            s.epoch_id,
            json_agg(json_build_object(
                'prn', s.prn,
                'elevation', s.elevation,
                'azimuth', s.azimuth
            ) ORDER BY s.prn) AS sats
        FROM satellite s
        JOIN day_epochs de ON s.epoch_id = de.epoch_id
        GROUP BY s.epoch_id
    )
    SELECT COALESCE(json_agg(
        json_build_object(
            'epoch_id', de.epoch_id,
            'timestamp', de.timestamp,
            'lat', de.lat,
            'lon', de.lon,
            'altitude', de.altitude,
            'speed_kmh', de.speed_kmh,
            'g_x', de.g_x,
            'g_y', de.g_y,
            'g_z', de.g_z,
            'satellites', COALESCE(ds.sats, '[]'::json)
        ) ORDER BY de.timestamp ASC
    )::text, '[]')
    FROM day_epochs de
    LEFT JOIN day_satellites ds ON de.epoch_id = ds.epoch_id;
    """
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(query, (day_str, day_str))
                row = cur.fetchone()
                raw_json = row[0] if (row and row[0]) else "[]"
                return Response(
                    content=raw_json,
                    media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600"},
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd bazy danych: {str(e)}")


def build_scope_filter(scope: str, day: Optional[str] = None, year: Optional[int] = None, month: Optional[int] = None, days: Optional[str] = None):
    where_clauses = []
    params = []
    scope_name = "trasa"

    if scope == "day" and day:
        day_str = day.strip()
        where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')")
        params.extend([day_str, day_str])
        scope_name = f"dzien_{day_str}"
    elif scope == "month" and year and month:
        start_date = f"{int(year):04d}-{int(month):02d}-01"
        where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 month')")
        params.extend([start_date, start_date])
        scope_name = f"miesiac_{int(year):04d}_{int(month):02d}"
    elif scope == "year" and year:
        start_date = f"{int(year):04d}-01-01"
        where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 year')")
        params.extend([start_date, start_date])
        scope_name = f"rok_{int(year):04d}"
    elif (scope in ("days", "custom", "active")) and days:
        day_list = [d.strip() for d in days.split(",") if d.strip()]
        if day_list:
            where_clauses.append("e.timestamp::date = ANY(%s::date[])")
            params.append(day_list)
            scope_name = f"wybrane_{len(day_list)}_dni"
    elif scope == "all":
        scope_name = "wszystko"
    else:
        if day:
            day_str = day.strip()
            where_clauses.append("e.timestamp >= %s::date AND e.timestamp < (%s::date + INTERVAL '1 day')")
            params.extend([day_str, day_str])
            scope_name = f"dzien_{day_str}"
        else:
            scope_name = "wszystko"

    return where_clauses, params, scope_name


@app.get("/api/export-data")
def get_export_data(
    scope: str = Query("day"),
    day: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    days: Optional[str] = Query(None),
    downsample: Optional[int] = Query(None),
):
    """Pobiera dane telemetryczne trasy dla zadanego zakresu (dzień, miesiąc, rok, wybrane dni, wszystko)."""
    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    step = int(downsample) if downsample and downsample > 1 else 1

    if step > 1:
        query = f"""
        WITH numbered AS (
            SELECT 
                e.epoch_id,
                to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
                round(ST_Y(e.geom)::numeric, 6) AS lat,
                round(ST_X(e.geom)::numeric, 6) AS lon,
                e.altitude,
                LEAST(COALESCE(e.speed_kmh, 0), 260.0) AS speed_kmh,
                e.g_x,
                e.g_y,
                e.g_z,
                ROW_NUMBER() OVER (ORDER BY e.timestamp ASC) AS rn
            FROM epochs e
            {where_sql}
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
        WHERE (n.rn - 1) % {step} = 0;
        """
    else:
        query = f"""
        SELECT COALESCE(json_agg(
            json_build_object(
                'epoch_id', e.epoch_id,
                'timestamp', to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                'lat', round(ST_Y(e.geom)::numeric, 6),
                'lon', round(ST_X(e.geom)::numeric, 6),
                'altitude', e.altitude,
                'speed_kmh', LEAST(COALESCE(e.speed_kmh, 0), 260.0),
                'g_x', e.g_x,
                'g_y', e.g_y,
                'g_z', e.g_z
            ) ORDER BY e.timestamp ASC
        )::text, '[]')
        FROM epochs e
        {where_sql};
        """

    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor() as cur:
                cur.execute(query, params)
                row = cur.fetchone()
                raw_json = row[0] if (row and row[0]) else "[]"
                return Response(
                    content=raw_json,
                    media_type="application/json",
                    headers={"Cache-Control": "public, max-age=600"},
                )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd pobierania danych trasy: {str(e)}")


@app.get("/api/export/download")
def download_export_file(
    format: str = Query("gpx"),
    scope: str = Query("day"),
    day: Optional[str] = Query(None),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    days: Optional[str] = Query(None),
):
    """Generuje i zwraca bezpośrednio plik eksportu (GPX, CSV, GeoJSON, KML)."""
    where_clauses, params, scope_name = build_scope_filter(scope, day, year, month, days)
    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    query = f"""
        SELECT 
            to_char(e.timestamp, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp,
            round(ST_Y(e.geom)::numeric, 6) AS lat,
            round(ST_X(e.geom)::numeric, 6) AS lon,
            e.altitude,
            LEAST(COALESCE(e.speed_kmh, 0), 260.0) AS speed_kmh,
            e.g_x,
            e.g_y,
            e.g_z
        FROM epochs e
        {where_sql}
        ORDER BY e.timestamp ASC;
    """
    try:
        with psycopg.connect(DB_URL) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(query, params)
                rows = cur.fetchall()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Błąd bazy danych: {str(e)}")

    fmt = format.lower().strip()
    filename_base = f"trasa_{scope_name}"

    if fmt == "csv":
        output = ["timestamp,latitude,longitude,altitude_m,speed_kmh,g_x,g_y,g_z"]
        for r in rows:
            alt = r["altitude"] if r["altitude"] is not None else ""
            spd = r["speed_kmh"] if r["speed_kmh"] is not None else 0
            gx = r["g_x"] if r["g_x"] is not None else ""
            gy = r["g_y"] if r["g_y"] is not None else ""
            gz = r["g_z"] if r["g_z"] is not None else ""
            output.append(f'{r["timestamp"]},{r["lat"]},{r["lon"]},{alt},{spd},{gx},{gy},{gz}')
        content = "\ufeff" + "\n".join(output)
        return Response(
            content=content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.csv"'}
        )

    elif fmt == "gpx":
        lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<gpx version="1.1" creator="NNAPER" xmlns="http://www.topografix.com/GPX/1/1">',
            f'  <metadata><name>Trasa {scope_name}</name></metadata>',
            '  <trk>',
            f'    <name>Trasa NNAPER - {scope_name}</name>',
            '    <trkseg>'
        ]
        for r in rows:
            lines.append(f'      <trkpt lat="{r["lat"]}" lon="{r["lon"]}">')
            if r["altitude"] is not None:
                lines.append(f'        <ele>{r["altitude"]}</ele>')
            if r["timestamp"]:
                lines.append(f'        <time>{r["timestamp"]}</time>')
            if r["speed_kmh"] is not None:
                speed_ms = round(float(r["speed_kmh"]) / 3.6, 2)
                lines.append(f'        <speed>{speed_ms}</speed>')
            lines.append('      </trkpt>')
        lines.append('    </trkseg>')
        lines.append('  </trk>')
        lines.append('</gpx>')
        return Response(
            content="\n".join(lines),
            media_type="application/gpx+xml; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.gpx"'}
        )

    elif fmt == "kml":
        coords_str = " ".join([f'{r["lon"]},{r["lat"]},{r["altitude"] or 0}' for r in rows])
        kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Trasa NNAPER - {scope_name}</name>
    <Style id="routeStyle">
      <LineStyle>
        <color>ff00d406</color>
        <width>4</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>{scope_name}</name>
      <styleUrl>#routeStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>{coords_str}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""
        return Response(
            content=kml,
            media_type="application/vnd.google-earth.kml+xml; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.kml"'}
        )

    elif fmt == "geojson":
        features = [
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[r["lon"], r["lat"], r["altitude"] or 0] for r in rows]
                },
                "properties": {
                    "name": f"Trasa {scope_name}",
                    "points_count": len(rows)
                }
            }
        ]
        geojson_data = {
            "type": "FeatureCollection",
            "features": features
        }
        return Response(
            content=json.dumps(geojson_data, ensure_ascii=False),
            media_type="application/geo+json; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.geojson"'}
        )

    else:
        raise HTTPException(status_code=400, detail=f"Nieobsługiwany format: {fmt}")
